import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Ref, Result } from "effect"
import { CodeDiagnostic } from "../src/code/internal/diagnostics.js"
import { interpret, ProgramThrow, type Invoke } from "../src/code/internal/interpret.js"
import { parse } from "../src/code/internal/parse.js"

/**
 * The owned interpreter (`plan-code-mode-engine.md` step 4): the §5.4
 * subset runs, everything outside it is an UnsupportedSyntax naming the
 * fix, the prototype escape is closed, and the two failure channels stay
 * apart -- a program can catch its own throws and never the host's
 * refusals.
 */

const noTools: Invoke = (path) =>
  Effect.fail(new ProgramThrow({ value: { message: `no tool at ${path.join(".")}` } }))

const run = (code: string, invoke: Invoke = noTools) => {
  const parsed = parse(code)
  if (Result.isFailure(parsed)) {
    return Effect.fail<CodeDiagnostic | ProgramThrow>(parsed.failure)
  }
  return interpret(parsed.success, { invoke })
}

const returned = (code: string, invoke?: Invoke) =>
  Effect.map(run(code, invoke), (out) => Option.getOrThrow(out.result))

describe("interpret", () => {
  it.effect("expressions, template strings, destructuring and closures", () =>
    Effect.gen(function*() {
      assert.strictEqual(yield* returned("return 40 + 2"), 42)
      assert.strictEqual(
        yield* returned("const who = \"world\"\nreturn `hello ${who}!`"),
        "hello world!"
      )
      assert.deepStrictEqual(
        yield* returned(
          "const { a, b: renamed, ...rest } = { a: 1, b: 2, c: 3, d: 4 }\nconst [first, ...more] = [10, 20, 30]\nreturn { a, renamed, rest, first, more }"
        ),
        { a: 1, renamed: 2, rest: { c: 3, d: 4 }, first: 10, more: [20, 30] }
      )
      assert.strictEqual(
        yield* returned(
          "const add = (a, b = 10) => a + b\nconst make = (n) => (m) => n * m\nreturn add(2) + make(4)(5)"
        ),
        32
      )
    })
  )

  it.effect("control flow: if, for...of, while, break/continue, and array HOFs", () =>
    Effect.gen(function*() {
      assert.strictEqual(
        yield* returned(
          "let total = 0\nfor (const n of [1, 2, 3, 4, 5]) {\n  if (n === 4) continue\n  if (n === 5) break\n  total = total + n\n}\nreturn total"
        ),
        6
      )
      assert.strictEqual(
        yield* returned("let n = 0\nwhile (n < 5) { n = n + 1 }\nreturn n"),
        5
      )
      assert.deepStrictEqual(
        yield* returned(
          "const items = [1, 2, 3, 4]\nreturn items.filter((n) => n % 2 === 0).map((n) => n * 10)"
        ),
        [20, 40]
      )
      assert.strictEqual(
        yield* returned("return [1, 2, 3].reduce((sum, n) => sum + n, 0)"),
        6
      )
      // Native methods without callbacks work directly.
      assert.strictEqual(yield* returned("return \"a,b,c\".split(\",\").join(\"-\")"), "a-b-c")
    })
  )

  it.effect("tool calls await, Promise.all runs them, and console.log is collected", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make<ReadonlyArray<string>>([])
      const invoke: Invoke = (path, input) =>
        Ref.update(calls, (all) => [...all, path.join(".")]).pipe(
          Effect.as({ echoed: input, at: path.join(".") })
        )
      const out = yield* run(
        "const one = await tools.github.list_issues({ owner: \"a\" })\nconsole.log(\"got\", one.at)\nconst [x, y] = await Promise.all([tools.net.ping({}), tools.net.ping({})])\nreturn { one: one.at, x: x.at, y: y.at }",
        invoke
      )
      assert.deepStrictEqual(Option.getOrThrow(out.result), {
        one: "github.list_issues",
        x: "net.ping",
        y: "net.ping"
      })
      assert.deepStrictEqual(out.logs, [["got", "github.list_issues"]])
      assert.deepStrictEqual(yield* Ref.get(calls), [
        "github.list_issues",
        "net.ping",
        "net.ping"
      ])
    })
  )

  it.effect("the program catches its own throws, and a tool's failure, but never a diagnostic", () =>
    Effect.gen(function*() {
      assert.strictEqual(
        yield* returned(
          "try {\n  throw { message: \"mine\" }\n} catch (error) {\n  return `caught ${error.message}`\n}"
        ),
        "caught mine"
      )
      // A failing tool call surfaces as a catchable program error.
      assert.strictEqual(
        yield* returned(
          "try {\n  await tools.missing.thing({})\n  return \"unreachable\"\n} catch (error) {\n  return error.message\n}"
        ),
        "no tool at missing.thing"
      )
      // A diagnostic sails through the catch: the host's refusal is not
      // the program's to swallow.
      const diagnostic = yield* Effect.flip(
        run("try {\n  class X {}\n} catch (error) {\n  return \"swallowed\"\n}")
      )
      assert.instanceOf(diagnostic, CodeDiagnostic)
      // finally runs, and an uncaught throw still propagates.
      const thrown = yield* Effect.flip(run("try {\n  throw \"boom\"\n} finally {\n  console.log(\"cleanup\")\n}"))
      assert.instanceOf(thrown, ProgramThrow)
    })
  )

  it.effect("the prototype escape is closed on every route", () =>
    Effect.gen(function*() {
      for (const program of [
        "return \"\".constructor",
        "return [].constructor",
        "return ({}).constructor",
        "const o = {}\nreturn o[\"cons\" + \"tructor\"]",
        "return (() => 1).prototype",
        "const o = { safe: 1 }\no.__proto__ = { polluted: true }\nreturn o"
      ]) {
        const refused = yield* Effect.flip(run(program))
        assert.instanceOf(refused, CodeDiagnostic, program)
        if (refused instanceof CodeDiagnostic) {
          assert.strictEqual(refused.reason, "blocked-member", program)
        }
      }
    })
  )

  it.effect("everything outside the subset is refused naming the fix", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<readonly [string, string]> = [
        ["class X {}", "plain objects"],
        ["for (let i = 0; i < 3; i++) {}", "for...of"],
        ["function f() { return 1 }", "=>"],
        ["var x = 1", "const or let"],
        ["return /abc/.test(\"abc\")", "string methods"],
        ["return a?.b", "optional chaining"],
        ["return 1 == 1", "==="]
      ]
      for (const [program, fixMention] of cases) {
        const refused = yield* Effect.flip(run(program))
        assert.instanceOf(refused, CodeDiagnostic, program)
        if (refused instanceof CodeDiagnostic) {
          assert.include(refused.fix, fixMention, program)
        }
      }
      // TypeScript gets the dedicated message.
      const typed = yield* Effect.flip(run("const n: number = 1\nreturn n"))
      assert.instanceOf(typed, CodeDiagnostic)
      if (typed instanceof CodeDiagnostic) {
        assert.include(typed.fix, "plain JavaScript")
      }
    })
  )

  it.effect("runaway recursion is a call-depth diagnostic, not a stack overflow", () =>
    Effect.gen(function*() {
      const refused = yield* Effect.flip(
        run("const loop = (n) => loop(n + 1)\nreturn loop(0)")
      )
      assert.instanceOf(refused, CodeDiagnostic)
      if (refused instanceof CodeDiagnostic) {
        assert.strictEqual(refused.reason, "call-depth")
        assert.include(refused.fix, "iteration")
      }
    })
  )

  it.effect("running off the end is None, not undefined-as-a-result", () =>
    Effect.gen(function*() {
      const out = yield* run("const x = 1")
      assert.isTrue(Option.isNone(out.result))
    })
  )
})
