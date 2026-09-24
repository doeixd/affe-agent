import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { Workflow } from "effect/unstable/workflow"

/**
 * Item 113's probe: can a durable workflow start a **child workflow** from its
 * body and get the child's result?
 *
 * The design of record (decision D5) is durable delegation as a child
 * workflow. It cannot be the *handler*: `DurableToolkit` wraps every tool call
 * in an `Activity`, a handler's requirements are `never`, and a suspending
 * activity records `Unresolved`. So the scoping pass asked whether the
 * **workflow body** can — and it can: a body is given `WorkflowEngine`, and
 * `WorkflowEngine.execute`'s default form awaits the child. This file pins
 * that, because item 113 rests on it.
 */
const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

const Child = Workflow.make("probe-child-workflow", {
  payload: { n: Schema.Number },
  idempotencyKey: ({ n }) => `probe-child-${n}`,
  success: Schema.String
})

const childLayer = Child.toLayer(({ n }) => Effect.succeed(`child-${n}`))

const Parent = Workflow.make("probe-parent-workflow", {
  payload: { n: Schema.Number },
  idempotencyKey: ({ n }) => `probe-parent-${n}`,
  success: Schema.String
})

const parentLayer = Parent.toLayer(({ n }) =>
  Effect.gen(function* () {
    // The question. Both workflows are registered with the engine; the child
    // is started from the parent's body.
    const child = yield* Child.execute({ n })
    return `parent(${child})`
  })
)

const wired = Layer.mergeAll(parentLayer, childLayer).pipe(Layer.provideMerge(Engine))

describe("probe: a workflow body executing a child workflow", () => {
  it.live("completes with the child's result", () =>
    Parent.execute({ n: 1 }).pipe(
      Effect.timeout("10 seconds"),
      Effect.map((result) => {
        assert.strictEqual(result, "parent(child-1)")
      }),
      Effect.provide(wired)
    ), 30_000)
})
