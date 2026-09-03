import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema, Stream } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { Workflow } from "effect/unstable/workflow"
import * as DurableToolkit from "../src/durable/DurableToolkit.js"

/**
 * Retry safety for durable tool calls (`docs/plan-failure-paths.md` 48a).
 *
 * The hazard is upstream's, and it is invisible from our side: `Activity.make`
 * wraps its `execute` in a retry whose schedule fires *while the cause has
 * interrupts*, up to ten attempts. So an interrupted tool handler is reissued
 * nine more times, and a tool that charges a card charges it ten times. Nothing
 * in this library asked for that.
 *
 * These tests pin both halves of the fix: a tool nobody annotated is not
 * reissued, and a tool that declares itself idempotent still is, because for
 * that one the retry is the point.
 *
 * The handler interrupts *itself* rather than waiting to be interrupted by a
 * racing fiber. That is deliberate. A scheduler race would make the number of
 * attempts a matter of timing, and the number is the whole assertion; a handler
 * that interrupts on every attempt makes the retry policy the only variable.
 *
 * Written without a shared helper on purpose. Folding both cases into one
 * generic function needed a cast to keep the toolkit's handler record and the
 * tool's name related, and a cast in a test is a defect in the library's
 * signatures by this repository's rules. Two concrete setups need none.
 */

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

const parameters = Schema.Struct({ amount: Schema.String })

/** Unannotated: `Tool.Idempotent` defaults to `false`, so this must not be reissued. */
const Charge = Tool.make("charge", { parameters, success: Schema.String })

/** The opt-in. Repeating it changes nothing, so being reissued is safe and wanted. */
const Read = Tool.make("read", { parameters, success: Schema.String }).annotate(Tool.Idempotent, true)

/**
 * The call has to happen inside a real workflow, because that is the only
 * place an `Activity` can run. The count lives in a `Ref` created outside it,
 * because the point is to observe what the journal did not stop.
 */
const runInWorkflow = (name: string, body: Effect.Effect<string, never, DurableToolkit.WorkflowContext>) => {
  const definition = Workflow.make(name, {
    payload: Schema.Struct({}),
    success: Schema.String,
    idempotencyKey: () => name
  })
  return definition.execute({}).pipe(
    Effect.exit,
    Effect.provide(Layer.provideMerge(definition.toLayer(() => body), Engine))
  )
}

describe("durable tool retry safety", () => {
  it.live("a tool that is not idempotent is not reissued when its handler is interrupted", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const toolkit = Toolkit.make(Charge)
      const handled = yield* toolkit.pipe(
        Effect.provide(
          toolkit.toLayer({
            // Incremented first: the count is of handler *entries*, which is
            // exactly what a reissued side effect would repeat.
            charge: () => Effect.flatMap(Ref.update(calls, (n) => n + 1), () => Effect.interrupt)
          })
        )
      )

      const exit = yield* runInWorkflow(
        "ChargeOnce",
        Effect.gen(function* () {
          const wrapped = yield* DurableToolkit.wrap(handled)
          const outcome = yield* Effect.exit(
            Effect.flatMap(wrapped.handle("charge", { amount: "500" }, "call-1"), Stream.runDrain)
          )
          return outcome._tag
        })
      )

      assert.strictEqual(
        yield* Ref.get(calls),
        1,
        "an interrupted non-idempotent tool handler was run more than once"
      )
      // It did not silently succeed either. The activity journalled that the
      // outcome is unknown, so a replay reports that rather than running the
      // handler again, and the wrapper raised `DurableToolUnresolvedError`.
      assert.strictEqual(exit._tag, "Success")
      if (exit._tag === "Success") assert.strictEqual(exit.value, "Failure")
    }),
    20_000
  )

  it.live("a tool that declares itself idempotent is still reissued", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const toolkit = Toolkit.make(Read)
      const handled = yield* toolkit.pipe(
        Effect.provide(
          toolkit.toLayer({
            read: () => Effect.flatMap(Ref.update(calls, (n) => n + 1), () => Effect.interrupt)
          })
        )
      )

      yield* runInWorkflow(
        "ReadRetries",
        Effect.gen(function* () {
          const wrapped = yield* DurableToolkit.wrap(handled)
          const outcome = yield* Effect.exit(
            Effect.flatMap(wrapped.handle("read", { amount: "500" }, "call-1"), Stream.runDrain)
          )
          return outcome._tag
        })
      )

      assert.isAbove(
        yield* Ref.get(calls),
        1,
        "an idempotent tool lost the interrupt retry it is annotated to want"
      )
    }),
    60_000
  )

  it.effect("retry safety is read from the tool's own idempotency annotation", () =>
    Effect.sync(() => {
      assert.isFalse(DurableToolkit.isRetrySafe(Charge), "an unannotated tool must not be retry-safe")
      assert.isTrue(DurableToolkit.isRetrySafe(Read))
    })
  )
})
