import { assert, describe, it } from "@effect/vitest"
import {
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema
} from "effect"
import { Activity, DurableDeferred, Workflow } from "effect/unstable/workflow"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

/**
 * SPIKE — suspension and resumption via `DurableDeferred`.
 *
 * Raw `Workflow.resume` did not re-dispatch a suspended execution under
 * `TestRunner`. `DurableDeferred` is the designed path: awaiting it suspends
 * the workflow, and completing it from outside wakes the execution. It is also
 * exactly what human-in-the-loop approval needs (plan Phase 7).
 */
const Approval = DurableDeferred.make("Approval", { success: Schema.String })

describe("spike: durable deferred", () => {
  it.live("a workflow suspends on await and resumes when completed", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make<Array<string>>([])
      const tokenReady = yield* Deferred.make<DurableDeferred.Token>()

      const W = Workflow.make("DeferredSpike", {
        payload: { input: Schema.String },
        idempotencyKey: (p) => p.input,
        success: Schema.String
      })

      const layer = W.toLayer(() =>
        Effect.gen(function* () {
          const before = yield* Activity.make({
            name: "before",
            success: Schema.String,
            execute: Ref.update(ran, (all) => [...all, "before"]).pipe(
              Effect.as("before")
            )
          })

          // Hand the token out, then suspend until someone completes it.
          const token = yield* DurableDeferred.token(Approval)
          yield* Deferred.succeed(tokenReady, token)
          const decision = yield* DurableDeferred.await(Approval)

          const after = yield* Activity.make({
            name: "after",
            success: Schema.String,
            execute: Ref.update(ran, (all) => [...all, "after"]).pipe(
              Effect.as("after")
            )
          })

          return `${before}:${decision}:${after}`
        })
      )

      const result = yield* Effect.gen(function* () {
        const executionId = yield* W.executionId({ input: "go" })
        yield* W.execute({ input: "go" }, { discard: true })

        const token = yield* Deferred.await(tokenReady)
        // The process could have died here; the token is all that is needed.
        yield* DurableDeferred.succeed(Approval, { token, value: "approved" })

        return yield* Effect.retry(
          Effect.flatMap(W.poll(executionId), (r) =>
            Option.isSome(r) && r.value._tag === "Complete"
              ? Effect.succeed(r.value)
              : Effect.fail("pending" as const)
          ),
          { times: 300, schedule: Schedule.spaced(Duration.millis(10)) }
        )
      }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(Engine))))

      // `before` ran once: the resumed execution replayed its persisted result
      // rather than re-executing it.
      assert.deepStrictEqual(yield* Ref.get(ran), ["before", "after"])
      assert.strictEqual(result._tag, "Complete")
    })
  )
})
