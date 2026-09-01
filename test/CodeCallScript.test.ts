import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as Permission from "../src/Permission.js"
import * as CallScript from "../src/code/callscript.js"
import { CodeMode } from "../src/code/index.js"

/**
 * CallScript behind `CodeExecutor`
 * (`docs/plan-code-mode-executors.md` step 4).
 *
 * This is the acceptance test for steps 1 and 3, not a test of CallScript.
 * A seam is only shown to be a seam by a second implementation, and the
 * claims worth checking are the ones that hold *across* the two: the same
 * toolkit, the same permission policy, the same limits, the same
 * `CodeTool` above them -- and a suspension that the interpreter cannot
 * produce, reaching the host through the variant step 1 added for it.
 */

const Lookup = Tool.make("lookup", {
  description: "Look a key up",
  parameters: Schema.Struct({ key: Schema.String }),
  success: Schema.Struct({ found: Schema.String })
})

const Write = Tool.make("write", {
  description: "Write a value",
  parameters: Schema.Struct({ key: Schema.String }),
  success: Schema.String
})

const fixture = Effect.gen(function*() {
  const seen: Array<string> = []
  const data = yield* Agent.toolkit([Lookup, Write], {
    lookup: ({ key }) =>
      Effect.sync(() => {
        seen.push(`lookup:${key}`)
        return { found: `value-of-${key}` }
      }),
    write: ({ key }) =>
      Effect.sync(() => {
        seen.push(`write:${key}`)
        return "written"
      })
  })
  return { data, seen }
})

/**
 * The gate is consulted synchronously by the engine, inside the promise
 * `executeScript` returns, so it reads a plain box rather than a `Ref`:
 * there is no fibre there to run an `Effect` on. A real host reads its own
 * store the same way -- the predicate is the host's, not the harness's.
 */
const unsafeApproved = { current: false }

describe("CallScript as a CodeExecutor", () => {
  it.effect("a program runs against the real toolkit through the same seam", () =>
    Effect.gen(function*() {
      const { data, seen } = yield* fixture
      const runtime = CodeMode.make({
        tools: { data },
        executor: CallScript.executor()
      })

      const out = yield* runtime.execute([
        "const one = await data.lookup({ key: \"a\" })",
        "return one.value.found"
      ].join("\n"))

      assert.deepStrictEqual(out.outcome, {
        _tag: "Returned",
        value: "value-of-a"
      })
      // The call really went through the host's `invoke`, which is the
      // whole design: the engine mounts nothing of its own.
      assert.deepStrictEqual(seen, ["lookup:a"])
      assert.deepStrictEqual(out.calls, [
        { path: ["data", "lookup"], input: { key: "a" }, outcome: "succeeded" }
      ])
    })
  )

  it.effect("an unknown tool is a compile failure naming every offender", () =>
    Effect.gen(function*() {
      // The half of pre-flight the interpreter cannot do: the whole plan
      // is checked before a call runs, and every problem arrives together
      // rather than one per turn.
      const { data, seen } = yield* fixture
      const runtime = CodeMode.make({
        tools: { data },
        executor: CallScript.executor()
      })

      const out = yield* runtime.execute([
        "const a = await data.nope({ key: \"a\" })",
        "const b = await data.alsoNope({ key: \"b\" })",
        "return [a, b]"
      ].join("\n"))

      assert.strictEqual(out.outcome._tag, "Refused")
      if (out.outcome._tag === "Refused") {
        assert.strictEqual(out.outcome.reason, "plan-invalid")
      }
      assert.deepStrictEqual(seen, [])
    })
  )

  it.effect("a host refusal is not swallowed by the plan's own error policy", () =>
    Effect.gen(function*() {
      // The real difference between the engines, and the one that would
      // not show up in a happy-path test. CallScript hands a rejected
      // call to the step's `onError`, so a `CodeDiagnostic` -- the *host*
      // refusing, which the interpreter deliberately makes uncatchable --
      // could be skipped past. `maxToolCalls` is the case that matters:
      // if a plan could skip it, code mode's budget would be advisory.
      const { data, seen } = yield* fixture
      const runtime = CodeMode.make({
        tools: { data },
        executor: CallScript.executor(),
        limits: { maxToolCalls: 1 }
      })

      const out = yield* runtime.execute([
        "const a = await data.lookup({ key: \"a\" })",
        "const b = await data.lookup({ key: \"b\" })",
        "return [a.value.found, b.value.found]"
      ].join("\n"))

      assert.strictEqual(out.outcome._tag, "Refused")
      if (out.outcome._tag === "Refused") {
        assert.strictEqual(out.outcome.reason, "tool-limit")
      }
      // The budget bit: one call happened, the second was refused.
      assert.deepStrictEqual(seen, ["lookup:a"])
    })
  )

  it.effect("the same program, both executors, the same observed calls", () =>
    Effect.gen(function*() {
      // The property the seam claims. Where the two genuinely differ, the
      // difference is enumerated in a test rather than discovered by a
      // user; this is the part that must not differ.
      const program = [
        "const one = await data.lookup({ key: \"a\" })",
        "return one.value.found"
      ].join("\n")

      const first = yield* fixture
      const interpreted = yield* CodeMode.make({ tools: { data: first.data } })
        .execute(program.replace(/\bdata\./g, "tools.data."))

      const second = yield* fixture
      const planned = yield* CodeMode.make({
        tools: { data: second.data },
        executor: CallScript.executor()
      }).execute(program)

      assert.deepStrictEqual(interpreted.outcome, planned.outcome)
      assert.deepStrictEqual(first.seen, second.seen)
      assert.deepStrictEqual(interpreted.calls, planned.calls)
    })
  )


  it.effect("the same permission policy governs it, and a denial is not bypassable", () =>
    Effect.gen(function*() {
      // Invariant 2, and the reason the adapter shims every tool onto
      // `invoke` rather than calling `fromMCP`/`fromAISDKTools`: code mode
      // must never be a cheaper path to a tool. Mounting the engine's own
      // adapters would have compiled, run, and quietly skipped this.
      const { data, seen } = yield* fixture
      const runtime = CodeMode.make({
        tools: { data },
        executor: CallScript.executor(),
        permission: Permission.make((request) =>
          Effect.succeed(
            request.resource === "write" ? Permission.deny("read-only here") : Permission.allow
          )
        )
      })

      const out = yield* runtime.execute("return await data.write({ key: \"a\" })")

      // A policy refusal throws into the program, exactly as it does under
      // the interpreter -- and the handler never ran.
      assert.strictEqual(out.outcome._tag, "Threw")
      assert.notInclude(seen, "write:a")
      assert.deepStrictEqual(out.calls, [
        { path: ["data", "write"], input: { key: "a" }, outcome: "refused" }
      ])
    })
  )

  it.effect("a gated plan suspends to the host and resumes from its state", () =>
    Effect.gen(function*() {
      // The claim this executor exists for, and the one the interpreter
      // cannot make: a run that pauses, hands the host a serialisable
      // state, and continues later -- across a process boundary, though
      // this test only crosses two `execute` calls.
      const { data, seen } = yield* fixture
      const approved = yield* Ref.make(false)
      const held = yield* Ref.make<unknown>(undefined)

      const runtime = CodeMode.make({
        tools: { data },
        executor: CallScript.executor({
          // The host's gate: unapproved writes park the run.
          suspendOn: (step: { readonly stepId: string; readonly tool: string }) =>
            step.tool === "data.write" && !unsafeApproved.current
        })
      })

      const program = [
        "const one = await data.lookup({ key: \"a\" })",
        "const done = await data.write({ key: one.value.found })",
        "return done.value"
      ].join("\n")

      const first = yield* runtime.execute(program, {
        onSuspend: ({ state }) => Ref.set(held, state)
      })

      assert.strictEqual(first.outcome._tag, "Suspended")
      // The lookup settled before the gate; the write did not run.
      assert.deepStrictEqual(seen, ["lookup:a"])

      // The human answers. The gate opens, and the run continues from the
      // state rather than starting again.
      unsafeApproved.current = true
      yield* Ref.set(approved, true)
      const state = yield* Ref.get(held)
      const second = yield* runtime.execute(program, { resumeFrom: state })

      assert.deepStrictEqual(second.outcome, { _tag: "Returned", value: "written" })
      // `lookup` was NOT called a second time: settled steps are reused,
      // which is the difference between a resume and a retry.
      assert.deepStrictEqual(seen, ["lookup:a", "write:value-of-a"])
    })
  )
})
