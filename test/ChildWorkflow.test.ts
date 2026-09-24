import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Ref, Schema } from "effect"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/unstable/workflow"

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

// ---------------------------------------------------------------------------
// The suspension probe: a child parks on a durable deferred and the parent
// resumes behind it. This is the part with a recorded failure nearby, and it
// is what decides whether approval routing is designable.

describe("probe: a child that parks, and a parent waiting on it", () => {
  it.live("the parent resumes behind the child and completes", () =>
    Effect.scoped(Effect.gen(function* () {
      const parked = yield* Deferred.make<DurableDeferred.Token>()
      const Gate = DurableDeferred.make("probe-suspend-gate", { success: Schema.String })

      const Child = Workflow.make("probe-suspend-child", {
        payload: { n: Schema.Number },
        idempotencyKey: ({ n }) => `probe-suspend-child-${n}`,
        success: Schema.String
      })
      const childLayer = Child.toLayer(() =>
        Effect.gen(function* () {
          // Park: hand the token out, then wait to be resumed.
          const token = yield* DurableDeferred.token(Gate)
          yield* Deferred.succeed(parked, token)
          yield* DurableDeferred.await(Gate)
          return "child resumed"
        })
      )

      const Parent = Workflow.make("probe-suspend-parent", {
        payload: { n: Schema.Number },
        idempotencyKey: ({ n }) => `probe-suspend-parent-${n}`,
        success: Schema.String
      })
      const parentLayer = Parent.toLayer(({ n }) =>
        Effect.gen(function* () {
          const child = yield* Child.execute({ n })
          return `parent(${child})`
        })
      )

      const wired = Layer.mergeAll(parentLayer, childLayer).pipe(Layer.provideMerge(Engine))
      const context = yield* Layer.build(wired)

      yield* Effect.gen(function* () {
        const running = yield* Effect.forkChild(Parent.execute({ n: 1 }))
        const token = yield* Deferred.await(parked)
        yield* DurableDeferred.succeed(Gate, { token, value: "go" })
        const result = yield* Fiber.join(running)
        assert.strictEqual(result, "parent(child resumed)")
      }).pipe(Effect.provide(context), Effect.timeout("10 seconds"))
    })), 30_000)
})

// ---------------------------------------------------------------------------
// The cancellation probe: while a parent awaits a child, does the engine
// interrupt its body (so `onInterrupt` fires), and what does the parent's
// `WorkflowInstance` say? That discriminates a cancellation design.

describe("probe: what a parent sees while it awaits a child", () => {
  it.live("a parent awaiting a child is suspended, and its body is interrupted", () =>
    Effect.scoped(Effect.gen(function* () {
      const parked = yield* Deferred.make<DurableDeferred.Token>()
      const Gate = DurableDeferred.make("probe-flag-gate", { success: Schema.String })
      const observed = yield* Ref.make<ReadonlyArray<string>>([])

      const Child = Workflow.make("probe-flag-child", {
        payload: { n: Schema.Number },
        idempotencyKey: ({ n }) => `probe-flag-child-${n}`,
        success: Schema.String
      })
      const childLayer = Child.toLayer(() =>
        Effect.gen(function* () {
          const token = yield* DurableDeferred.token(Gate)
          yield* Deferred.succeed(parked, token)
          yield* DurableDeferred.await(Gate)
          return "child done"
        })
      )

      const Parent = Workflow.make("probe-flag-parent", {
        payload: { n: Schema.Number },
        idempotencyKey: ({ n }) => `probe-flag-parent-${n}`,
        success: Schema.String
      })
      const parentLayer = Parent.toLayer(() =>
        Effect.gen(function* () {
          const child = yield* Child.execute({ n: 1 }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                const instance = yield* WorkflowEngine.WorkflowInstance
                yield* Ref.update(observed, (all) => [
                  ...all,
                  `suspended=${instance.suspended} interrupted=${instance.interrupted}`
                ])
              })
            )
          )
          return `parent(${child})`
        })
      )

      const wired = Layer.mergeAll(parentLayer, childLayer).pipe(Layer.provideMerge(Engine))
      const context = yield* Layer.build(wired)

      yield* Effect.gen(function* () {
        const running = yield* Effect.forkChild(Parent.execute({ n: 1 }))
        const token = yield* Deferred.await(parked)
        // Let the parent's await settle into whatever the engine does with it.
        yield* Effect.sleep("50 millis")
        const seen = yield* Ref.get(observed)
        yield* DurableDeferred.succeed(Gate, { token, value: "go" })
        const result = yield* Fiber.join(running)
        assert.strictEqual(result, "parent(child done)")
        // The finding, pinned: awaiting a child suspends the parent and
        // interrupts its body -- `suspended` is the discriminator a
        // cancellation hook would key on, so a suspension is not an abort.
        assert.deepStrictEqual(seen, ["suspended=true interrupted=false"])
      }).pipe(Effect.provide(context), Effect.timeout("10 seconds"))
    })), 30_000)
})
