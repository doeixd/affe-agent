import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema } from "effect"
import { Activity, Workflow } from "effect/unstable/workflow"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"

/**
 * SPIKE — is the durable workflow engine testable without SQL?
 *
 * `spike/workflow.test.ts` could only use `WorkflowEngine.layerMemory`, which
 * cannot resume. If `ClusterWorkflowEngine` composes with `TestRunner`, the
 * crash-and-resume claim becomes testable in an ordinary unit test.
 */
const DurableEngine = ClusterWorkflowEngine.layer.pipe(
  Layer.provide(TestRunner.layer)
)

describe("spike: cluster workflow engine", () => {
  it.effect("runs a workflow on the cluster engine", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make<Array<string>>([])

      const W = Workflow.make("ClusterSpike", {
        payload: { input: Schema.String },
        idempotencyKey: (p) => p.input,
        success: Schema.String
      })

      const layer = W.toLayer((payload) =>
        Activity.make({
          name: "step-1",
          success: Schema.String,
          execute: Ref.update(ran, (all) => [...all, "step-1"]).pipe(
            Effect.as(`${payload.input}!`)
          )
        })
      )

      const out = yield* W.execute({ input: "hello" }).pipe(
        Effect.provide(layer.pipe(Layer.provideMerge(DurableEngine)))
      )

      assert.strictEqual(out, "hello!")
      assert.deepStrictEqual(yield* Ref.get(ran), ["step-1"])
    })
  )
})
