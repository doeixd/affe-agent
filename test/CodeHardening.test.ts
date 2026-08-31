import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import { CodeMode } from "../src/code/index.js"

/**
 * Hardening pins: a model-written program is untrusted input, so no
 * program -- however hostile or malformed -- may fail the agent run, leak
 * a host cause, or reach past the tools it was given. Each case here is
 * one way that could happen.
 */

const Echo = Tool.make("echo", {
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.String
})

const Boom = Tool.make("boom", {
  parameters: Schema.Struct({}),
  success: Schema.String
})

const fixture = Effect.gen(function*() {
  const data = yield* Agent.toolkit([Echo, Boom], {
    echo: ({ text }) => Effect.succeed(text),
    // A handler that *defects* -- the tool author's bug, not the model's.
    boom: () => Effect.die(new Error("secret internal detail"))
  })
  return { data }
})

/**
 * A toolkit whose handler reports how many calls overlap it.
 *
 * The only honest way to test a concurrency bound: count what is in
 * flight, not what was configured.
 */
const observingFixture = Effect.gen(function*() {
  const inFlight = yield* Ref.make(0)
  const peak = yield* Ref.make(0)
  const data = yield* Agent.toolkit([Echo], {
    echo: ({ text }) =>
      Effect.acquireUseRelease(
        Ref.updateAndGet(inFlight, (n) => n + 1).pipe(
          Effect.tap((n) => Ref.update(peak, (high) => Math.max(high, n)))
        ),
        // Long enough that unbounded callers genuinely overlap.
        () => Effect.as(Effect.sleep(Duration.millis(30)), text),
        () => Ref.update(inFlight, (n) => n - 1)
      )
  })
  return { data, peak }
})

const parallelProgram = [
  "const results = await Promise.all([",
  "  tools.data.echo({ text: \"a\" }),",
  "  tools.data.echo({ text: \"b\" }),",
  "  tools.data.echo({ text: \"c\" })",
  "])",
  "return results.map((one) => one.value)"
].join("\n")

const run = (program: string) =>
  Effect.gen(function*() {
    const { data } = yield* fixture
    const runtime = CodeMode.make({ tools: { data } })
    return yield* runtime.execute(program)
  })

describe("code mode hardening", () => {
  it.effect("a throwing host builtin is catchable by the program, not a defect", () =>
    Effect.gen(function*() {
      // `JSON.parse` on malformed text throws. If that arrives as a
      // defect it fails the whole agent run for a mistake the model made
      // inside its own program -- and the program cannot even catch it.
      const out = yield* run(
        "try {\n  JSON.parse(\"{oops\")\n  return \"unreachable\"\n} catch (error) {\n  return \"caught\"\n}"
      )
      assert.deepStrictEqual(out.outcome, { _tag: "Returned", value: "caught" })
    })
  )

  it.effect("an uncaught builtin throw is a program outcome, never a run failure", () =>
    Effect.gen(function*() {
      const out = yield* run("return JSON.parse(\"{oops\")")
      assert.strictEqual(out.outcome._tag, "Threw")
    })
  )

  it.effect("runaway expression nesting is a parse refusal, not a stack overflow", () =>
    Effect.gen(function*() {
      // Deep enough to exhaust a recursive-descent parser. Acorn refuses
      // it first ("Not enough stack space to parse input"), which `parse`
      // turns into an ordinary diagnostic -- so the interpreter never
      // recurses on it at all. Pinned at the reason rather than merely
      // "not Returned", because *which* layer refuses is the fact worth
      // keeping: if a future parser accepts deeper input, this test
      // changing is the notification that the interpreter now has to.
      const deep = `return ${"(".repeat(4000)}1${")".repeat(4000)}`
      const out = yield* run(deep)
      assert.strictEqual(out.outcome._tag, "Refused")
      if (out.outcome._tag === "Refused") {
        assert.strictEqual(out.outcome.reason, "parse-error")
      }
    })
  )

  it.effect("a defecting tool handler never leaks its cause to the program", () =>
    Effect.gen(function*() {
      const out = yield* run(
        "try {\n  await tools.data.boom({})\n  return \"unreachable\"\n} catch (error) {\n  return error.message\n}"
      )
      // Whatever the program sees, it is not the host's message.
      assert.notInclude(JSON.stringify(out.outcome), "secret internal detail")
    })
  )

  it.live("Promise.all really is concurrent, and the host's bound really binds it", () =>
    Effect.gen(function*() {
      // Unbounded first, so the bound below is measured against a run
      // that demonstrably overlaps rather than against nothing.
      const open = yield* observingFixture
      const unbounded = CodeMode.make({ tools: { data: open.data } })
      const first = yield* unbounded.execute(parallelProgram)
      assert.deepStrictEqual(first.outcome, {
        _tag: "Returned",
        value: ["a", "b", "c"]
      })
      assert.isAbove(
        yield* Ref.get(open.peak),
        1,
        "Promise.all should run nested calls concurrently"
      )

      const closed = yield* observingFixture
      const bounded = CodeMode.make({
        tools: { data: closed.data },
        limits: { maxConcurrentCalls: 1 }
      })
      const second = yield* bounded.execute(parallelProgram)
      // Same answers, in order: the bound serialises calls, it does not
      // change what the program computes.
      assert.deepStrictEqual(second.outcome, {
        _tag: "Returned",
        value: ["a", "b", "c"]
      })
      assert.strictEqual(
        yield* Ref.get(closed.peak),
        1,
        "maxConcurrentCalls should hold the number of in-flight calls down"
      )
    })
  )

  it.effect("maxOutputBytes counts bytes, not UTF-16 units", () =>
    Effect.gen(function*() {
      const { data } = yield* fixture
      const runtime = CodeMode.make({
        tools: { data },
        // "€€€€" is 4 characters and 12 UTF-8 bytes; a limit of 10 must
        // refuse it, which a `.length` check would not.
        limits: { maxOutputBytes: 10 }
      })
      const out = yield* runtime.execute("return \"\\u20ac\\u20ac\\u20ac\\u20ac\"")
      assert.strictEqual(out.outcome._tag, "Refused")
      if (out.outcome._tag === "Refused") {
        assert.strictEqual(out.outcome.reason, "output-limit")
      }
    })
  )
})
