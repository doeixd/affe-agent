import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentSession from "../src/AgentSession.js"
import { CodeTool } from "../src/code/index.js"
import { withSession } from "./helpers.js"

/**
 * The model-facing half of code mode (`plan-code-mode-engine.md` step 5):
 * one tool whose description carries the budgeted catalog, whose program
 * calls the real toolkits, and whose nested calls surface as ordinary
 * `ToolCallProgress` events -- the existing seam, no kernel change.
 */

const Lookup = Tool.make("lookup", {
  description: "Look a key up",
  parameters: Schema.Struct({ key: Schema.String }),
  success: Schema.Struct({ found: Schema.String })
})

const Count = Tool.make("count", {
  description: "Count the items",
  parameters: Schema.Struct({}),
  success: Schema.Number
})

const groups = Effect.gen(function*() {
  const data = yield* Agent.toolkit([Lookup, Count], {
    lookup: ({ key }) => Effect.succeed({ found: `value-of-${key}` }),
    count: () => Effect.succeed(3)
  })
  return { data }
})

const program = [
  "const total = await tools.data.count({})",
  "const keys = [\"a\", \"b\"]",
  "const found = []",
  "for (const key of keys) {",
  "  const one = await tools.data.lookup({ key })",
  "  found.push(one.value.found)",
  "}",
  "console.log(\"looked up\", found.length)",
  "return { total: total.value, found }"
].join("\n")

const turns = (source: string) => [
  { toolCalls: [{ id: "c1", name: "execute", params: { program: source } }] },
  { text: "done" }
]

describe("CodeTool", () => {
  it.effect("the description carries the catalog the model needs to write a program", () =>
    Effect.gen(function*() {
      const bound = yield* CodeTool.tool({ tools: yield* groups })
      const description = bound.tool.description ?? ""
      assert.include(description, "plain JavaScript")
      assert.include(description, "## data (2 tools)")
      assert.include(description, "tools.data.lookup(input: {")
      assert.include(description, "COMPLETE list")
      // The subset is stated, so a refusal is never the model's first
      // news of what it may write.
      assert.include(description, "for...of")
    })
  )

  it.effect("a program runs against the real toolkits and its answer reaches the model", () =>
    Effect.gen(function*() {
      const bound = yield* CodeTool.tool({ tools: yield* groups })
      const { events } = yield* withSession(
        turns(program),
        Agent.make({ tools: [bound] }),
        ({ session }) => AgentSession.prompt(session, "do it")
      )

      const succeeded = events.filter(AgentEvent.is("ToolCallSucceeded"))
      assert.strictEqual(succeeded.length, 1)
      assert.deepStrictEqual(succeeded[0]!.event.result, {
        outcome: "returned",
        value: { total: 3, found: ["value-of-a", "value-of-b"] },
        logs: ["looked up 2"],
        calls: [
          { path: "data.count", outcome: "succeeded" },
          { path: "data.lookup", outcome: "succeeded" },
          { path: "data.lookup", outcome: "succeeded" }
        ]
      })
    })
  )

  it.effect("each nested call is a ToolCallProgress event while the program is still running", () =>
    Effect.gen(function*() {
      const bound = yield* CodeTool.tool({ tools: yield* groups })
      const { events } = yield* withSession(
        turns(program),
        Agent.make({ tools: [bound] }),
        ({ session }) => AgentSession.prompt(session, "do it")
      )

      const progress = events.filter(AgentEvent.is("ToolCallProgress"))
      // One per nested call, each carrying the calls settled so far --
      // a program that runs for a minute is visible while it runs.
      assert.strictEqual(progress.length, 3)
      const paths = progress.map((entry) => {
        const result = entry.event.result
        assert.isObject(result)
        return (result as { readonly calls: ReadonlyArray<{ readonly path: string }> }).calls
          .map((call) => call.path)
      })
      assert.deepStrictEqual(paths, [
        ["data.count"],
        ["data.count", "data.lookup"],
        ["data.count", "data.lookup", "data.lookup"]
      ])
      // Progress is observational: `running` is never the committed result.
      for (const entry of progress) {
        assert.strictEqual(
          (entry.event.result as { readonly outcome: string }).outcome,
          "running"
        )
      }
    })
  )

  it.effect("a refusal reaches the model as a fix, not an error", () =>
    Effect.gen(function*() {
      const bound = yield* CodeTool.tool({ tools: yield* groups })
      const { events } = yield* withSession(
        turns("for (let i = 0; i < 3; i++) {}\nreturn 1"),
        Agent.make({ tools: [bound] }),
        ({ session }) => AgentSession.prompt(session, "do it")
      )
      const succeeded = events.filter(AgentEvent.is("ToolCallSucceeded"))
      assert.strictEqual(succeeded.length, 1)
      const result = succeeded[0]!.event.result as {
        readonly outcome: string
        readonly fix: string
      }
      assert.strictEqual(result.outcome, "refused")
      assert.include(result.fix, "for...of")
    })
  )
})
