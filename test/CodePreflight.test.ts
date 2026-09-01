import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentSession from "../src/AgentSession.js"
import { CodeMode, CodeTool } from "../src/code/index.js"
import { withSession } from "./helpers.js"

/**
 * Pre-flight (`docs/plan-code-mode-executors.md` step 3).
 *
 * The interpreter refuses the first problem it *reaches*. A program that
 * makes three expensive calls and then names a fourth tool that does not
 * exist pays for all three, returns one diagnostic, and spends the next
 * turn finding the next problem.
 */

const Echo = Tool.make("echo", {
  description: "Echo the text",
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.String
})

const fixture = Effect.gen(function*() {
  const calls: Array<string> = []
  const data = yield* Agent.toolkit([Echo], {
    echo: ({ text }) =>
      Effect.sync(() => {
        calls.push(text)
        return text
      })
  })
  return { data, calls }
})

const refusalOf = (outcome: CodeMode.Outcome) => {
  assert.strictEqual(outcome._tag, "Refused")
  if (outcome._tag !== "Refused") throw new Error("unreachable")
  return outcome
}

describe("code-mode pre-flight", () => {
  it.effect("reports every context-free problem at once, in source order", () =>
    Effect.gen(function*() {
      const { data } = yield* fixture
      const runtime = CodeMode.make({ tools: { data } })
      const out = yield* runtime.execute([
        "var a = 1",
        "class Nope {}",
        "for (let i = 0; i < 3; i = i + 1) {}",
        "if (a == 1) { }",
        "return a"
      ].join("\n"))

      const refused = refusalOf(out.outcome)
      // Four problems, one turn. Before this pass the model was told
      // about `var` and nothing else, then about the class, and so on.
      const all = [refused, ...refused.more]
      assert.deepStrictEqual(all.map((finding) => finding.line), [1, 2, 3, 4])
      assert.strictEqual(refused.reason, "unsupported-syntax")
      assert.include(all[1]!.fix, "classes")
      assert.include(all[2]!.fix, "classic for")
      assert.include(all[3]!.fix, "===")
    })
  )

  it.effect("an unknown tool is found before any call is made", () =>
    Effect.gen(function*() {
      // The check that pays for the whole pass. At runtime this arrives
      // only after every earlier call already happened -- the calls are
      // the cost, and they are not refundable.
      const { calls, data } = yield* fixture
      const runtime = CodeMode.make({ tools: { data } })
      const out = yield* runtime.execute([
        "await tools.data.echo({ text: \"expensive one\" })",
        "await tools.data.echo({ text: \"expensive two\" })",
        "return await tools.data.ecoh({ text: \"typo\" })"
      ].join("\n"))

      const refused = refusalOf(out.outcome)
      assert.strictEqual(refused.reason, "unknown-tool")
      assert.strictEqual(refused.line, 3)
      assert.include(refused.fix, "tools.data.ecoh")
      // Break once by removing the unknown-tool case from `validate`: it
      // is this assertion that fails, because the two calls happen first.
      assert.deepStrictEqual(calls, [])
      assert.deepStrictEqual(out.calls, [])
    })
  )

  it.effect("a computed tool path is not a finding", () =>
    Effect.gen(function*() {
      // Only a path written out in full is checkable. Guessing at a
      // computed one would refuse a working program, which costs far more
      // than the round trip it saves.
      const { data } = yield* fixture
      const runtime = CodeMode.make({ tools: { data } })
      const out = yield* runtime.execute([
        "const name = \"echo\"",
        "const fn = tools.data[name]",
        "return \"reached the interpreter\""
      ].join("\n"))
      assert.strictEqual(out.outcome._tag, "Returned")
    })
  )

  it.effect("a program that binds `tools` itself is not tool-checked", () =>
    Effect.gen(function*() {
      // `tools` is a name, not a keyword. A program that binds its own may
      // legitimately address anything through it, so the check stands down
      // rather than refusing on a false premise.
      const { data } = yield* fixture
      const runtime = CodeMode.make({ tools: { data } })
      const out = yield* runtime.execute([
        "const tools = { data: { anything: 1 } }",
        "return tools.data.anything"
      ].join("\n"))
      assert.deepStrictEqual(out.outcome, { _tag: "Returned", value: 1 })
    })
  )

  it.effect("the string \"tools\" in a value does not disable the tool check", () =>
    Effect.gen(function*() {
      // The shadowing check reads *binding identifiers*. Its first version
      // matched `JSON.stringify(subtree).includes("\"tools\"")`, a string
      // search standing in for a scope analysis -- so a default value that
      // merely contained the word switched the unknown-tool check off for
      // the whole program, silently, and pre-flight quietly stopped doing
      // the thing it exists for. Break once by matching on the JSON text
      // again and this returns rather than refusing.
      const { data } = yield* fixture
      const runtime = CodeMode.make({ tools: { data } })
      const out = yield* runtime.execute([
        "const [first = \"tools\"] = []",
        "return await tools.data.ecoh({ text: first })"
      ].join("\n"))
      const refused = refusalOf(out.outcome)
      assert.strictEqual(refused.reason, "unknown-tool")
    })
  )

  it.effect("a `tools` bound after the reference still stands the check down", () =>
    Effect.gen(function*() {
      // Source order is not binding order: the pass is single-walk, so
      // tool findings are held until the walk ends rather than decided
      // where they are met.
      const { data } = yield* fixture
      const runtime = CodeMode.make({ tools: { data } })
      const out = yield* runtime.execute([
        "const read = () => tools.data.nothing",
        "const tools = { data: { nothing: 7 } }",
        "return read()"
      ].join("\n"))
      // Not a pre-flight refusal: the program binds its own `tools`, so
      // the check stands down even though the reference is written first.
      assert.notStrictEqual(
        out.outcome._tag === "Refused" ? out.outcome.reason : undefined,
        "unknown-tool"
      )
    })
  )

  it.effect("a valid program is untouched by the pass", () =>
    Effect.gen(function*() {
      // Pre-flight is a diagnostic improvement, never a semantic one.
      const { calls, data } = yield* fixture
      const runtime = CodeMode.make({ tools: { data } })
      const out = yield* runtime.execute([
        "const found = []",
        "for (const key of [\"a\", \"b\"]) {",
        "  const one = await tools.data.echo({ text: key })",
        "  found.push(one.value)",
        "}",
        "return found"
      ].join("\n"))
      assert.deepStrictEqual(out.outcome, { _tag: "Returned", value: ["a", "b"] })
      assert.deepStrictEqual(calls, ["a", "b"])
    })
  )

  it.effect("everything pre-flight refuses, the interpreter refuses too", () =>
    Effect.gen(function*() {
      // The anti-drift guard, and the reason this pass does not share a
      // table with the interpreter: there is none to share. Its refusals
      // are inline and several are contextual, which is what makes their
      // fixes good.
      //
      // Containment is the property that matters -- pre-flight must be a
      // strict subset of what the interpreter would refuse anyway, or it
      // starts rejecting programs that would have worked. Tested as
      // behaviour rather than asserted as a shared constant: if the
      // interpreter ever *gains* support for one of these, this fails and
      // names it, which is exactly the notification wanted.
      const { data } = yield* fixture
      const runtime = CodeMode.make({ tools: { data } })
      const constructs = [
        "var x = 1\nreturn x",
        "function f() {}\nreturn 1",
        "class C {}\nreturn 1",
        "for (let i = 0; i < 1; i = i + 1) {}\nreturn 1",
        "for (const k in {}) {}\nreturn 1",
        "return 1 == 1",
        "return /x/.test(\"x\")",
        "const o = { a: 1 }\nreturn o?.a",
        "const o = { a: 1 }\nreturn o.constructor"
      ]
      for (const program of constructs) {
        const out = yield* runtime.execute(program)
        assert.strictEqual(out.outcome._tag, "Refused", `pre-flight let this run: ${program}`)
      }
    })
  )

  it.effect("the model reads every fix at once, numbered", () =>
    Effect.gen(function*() {
      const { data } = yield* fixture
      const bound = yield* CodeTool.tool({ tools: { data } })
      const { events } = yield* withSession(
        [
          {
            toolCalls: [{
              id: "c1",
              name: "execute",
              params: { program: "var a = 1\nclass B {}\nreturn a" }
            }]
          },
          { text: "done" }
        ],
        Agent.make({ tools: [bound] }),
        ({ session }) => AgentSession.prompt(session, "do it")
      )
      const result = events.filter(AgentEvent.is("ToolCallSucceeded"))[0]!.event
        .result as CodeTool.Result
      assert.strictEqual(result.outcome, "refused")
      // "found", not "all the problems there are": the finding cap is
      // silent, so the wording must not assert a completeness it cannot
      // promise.
      assert.include(result.fix ?? "", "2 problems found")
      assert.notInclude(result.fix ?? "", "all of which")
      assert.include(result.fix ?? "", "1. line 1:")
      assert.include(result.fix ?? "", "2. line 2:")
    })
  )

  it.effect("one problem still reads as one sentence", () =>
    Effect.gen(function*() {
      // A numbered list of one is noise, and the single-finding path is
      // the common one: a parse error is one error.
      const { data } = yield* fixture
      const bound = yield* CodeTool.tool({ tools: { data } })
      const { events } = yield* withSession(
        [
          {
            toolCalls: [{ id: "c1", name: "execute", params: { program: "var a = 1\nreturn a" } }]
          },
          { text: "done" }
        ],
        Agent.make({ tools: [bound] }),
        ({ session }) => AgentSession.prompt(session, "do it")
      )
      const result = events.filter(AgentEvent.is("ToolCallSucceeded"))[0]!.event
        .result as CodeTool.Result
      assert.strictEqual(result.fix, "var is not supported; use const or let")
      assert.notInclude(result.fix ?? "", "1.")
    })
  )
})
