import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Layer, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { DurableDeferred, Workflow } from "effect/unstable/workflow"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as ContextTransform from "../src/ContextTransform.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableToolkit from "../src/durable/DurableToolkit.js"
import * as FakeModel from "./FakeModel.js"

/**
 * Item 113's seam: a tool marked `DurableDelegation` runs its call in the
 * **workflow body** instead of an `Activity`, so it can start a child workflow
 * and await it. This is the first end-to-end piece of durable delegation:
 * a durable parent whose tool is a child workflow, with the child's own
 * journal as the durability.
 */
const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

const Params = Schema.Struct({ question: Schema.String })

it.live("a marked delegation runs the child workflow and the parent completes", () =>
  Effect.gen(function* () {
    const runs = yield* Ref.make(0)

    const child = Workflow.make("delegation-child", {
      payload: { question: Schema.String },
      idempotencyKey: ({ question }) => `delegation-child-${question}`,
      success: Schema.String
    })
    const childLayer = child.toLayer(({ question }) =>
      Effect.andThen(
        Ref.update(runs, (n) => n + 1),
        Effect.succeed(`child answered ${question}`)
      ))

    const ToChild = DurableToolkit.delegate(
      Tool.make("to_child", {
        parameters: Params,
        success: Schema.String,
        failure: Schema.String
      }),
      (params) => child.execute(Schema.decodeUnknownSync(Params)(params))
    )

    // The handler is a placeholder: under durability the seam never calls it.
    const toChild = Agent.tool(ToChild, () => Effect.die("a delegation handler must never run"))

    const { layer: model } = yield* FakeModel.script([
      { toolCalls: [{ id: "d1", name: "to_child", params: { question: "weather" } }] },
      { text: "parent done" }
    ])

    const store = yield* DurableChannels.memoryStore
    const durable = DurableAgent.workflow(
      "DelegationSeam",
      Agent.make({ tools: [toChild], loop: AgentLoop.bounded(3) }),
      { store }
    )

    const exit = yield* Effect.gen(function* () {
      const executionId = yield* DurableAgent.submit(durable, store, "w", "delegate please")
      return yield* DurableAgent.result(durable, executionId)
    }).pipe(
      Effect.provide(
        Layer.merge(durable.layer, childLayer).pipe(
          Layer.provideMerge(Engine),
          Layer.provideMerge(model)
        )
      ),
      Effect.timeout("20 seconds"),
      Effect.exit
    )

    assert.isTrue(Exit.isSuccess(exit), Exit.isFailure(exit) ? String(exit.cause) : "")
    assert.strictEqual(yield* Ref.get(runs), 1, "the child ran more or fewer than once")
  }), 30_000)

it.live("a suspension after the delegation replays it from the child's journal, not a second run", () =>
  Effect.scoped(Effect.gen(function* () {
    const runs = yield* Ref.make(0)
    const delegated = yield* Ref.make(false)

    const child = Workflow.make("delegation-replay-child", {
      payload: { question: Schema.String },
      idempotencyKey: ({ question }) => `delegation-replay-child-${question}`,
      success: Schema.String
    })
    const childLayer = child.toLayer(({ question }) =>
      Effect.andThen(
        Ref.update(runs, (n) => n + 1),
        Effect.andThen(Ref.set(delegated, true), Effect.succeed(`child answered ${question}`))
      ))

    const ToChild = DurableToolkit.delegate(
      Tool.make("to_child_replay", {
        parameters: Params,
        success: Schema.String,
        failure: Schema.String
      }),
      (params) => child.execute(Schema.decodeUnknownSync(Params)(params))
    )
    const toChild = Agent.tool(ToChild, () => Effect.die("a delegation handler must never run"))

    const { layer: model } = yield* FakeModel.script([
      { toolCalls: [{ id: "d1", name: "to_child_replay", params: { question: "weather" } }] },
      { text: "parent done" }
    ])

    // Suspend once, *after* the delegation, so the resume must replay the turn
    // -- and must not run the child again.
    const Gate = DurableDeferred.make("DelegationSeamGate", { success: Schema.String })
    const gateReady = yield* Deferred.make<DurableDeferred.Token>()
    const suspendOnce = yield* Ref.make(true)
    const gating = ContextTransform.make((context) =>
      Effect.gen(function* () {
        if ((yield* Ref.get(delegated)) && (yield* Ref.getAndSet(suspendOnce, false))) {
          const token = yield* DurableDeferred.token(Gate)
          yield* Deferred.succeed(gateReady, token)
          yield* DurableDeferred.await(Gate)
        }
        return context.canonicalPrompt
      }))

    const store = yield* DurableChannels.memoryStore
    const durable = DurableAgent.workflow(
      "DelegationSeamReplay",
      Agent.make({ tools: [toChild], loop: AgentLoop.bounded(3), contextTransform: gating }),
      { store }
    )

    const layers = Layer.merge(durable.layer, childLayer).pipe(
      Layer.provideMerge(Engine),
      Layer.provideMerge(model)
    )
    const context = yield* Layer.build(layers)

    yield* Effect.gen(function* () {
      // `submit` returns at admission, so the workflow runs while the test
      // waits on the gate; no fork is needed.
      const executionId = yield* DurableAgent.submit(durable, store, "w", "delegate please")
      const token = yield* Deferred.await(gateReady)
      yield* DurableDeferred.succeed(Gate, { token, value: "go" })
      const exit = yield* DurableAgent.result(durable, executionId).pipe(
        Effect.timeout("20 seconds"),
        Effect.exit
      )
      assert.isTrue(Exit.isSuccess(exit), Exit.isFailure(exit) ? String(exit.cause) : "")
      assert.strictEqual(yield* Ref.get(runs), 1, "the child ran again across the resume")
    }).pipe(Effect.provide(context))
  })), 30_000)

it.live("a parent's suspension interrupt reaches the delegation runner", () =>
  Effect.scoped(Effect.gen(function* () {
    const parked = yield* Deferred.make<DurableDeferred.Token>()
    const Gate = DurableDeferred.make("DelegationCancelGate", { success: Schema.String })
    const observed = yield* Ref.make(false)

    const child = Workflow.make("delegation-cancel-child", {
      payload: { n: Schema.Number },
      idempotencyKey: ({ n }) => `delegation-cancel-child-${n}`,
      success: Schema.String
    })
    const childLayer = child.toLayer(() =>
      Effect.gen(function* () {
        const token = yield* DurableDeferred.token(Gate)
        yield* Deferred.succeed(parked, token)
        yield* DurableDeferred.await(Gate)
        return "child done"
      })
    )

    const ParamsN = Schema.Struct({ n: Schema.Number })
    const ToChild = DurableToolkit.delegate(
      Tool.make("to_child_cancel", { parameters: ParamsN, success: Schema.String, failure: Schema.String }),
      (params) =>
        child.execute(Schema.decodeUnknownSync(ParamsN)(params)).pipe(
          // The question: does this fire while the *parent* is suspended, when
          // the runner sits inside `DurableToolkit.handle` and `ToolExecution`?
          Effect.onInterrupt(() => Ref.set(observed, true))
        )
    )
    const toChild = Agent.tool(ToChild, () => Effect.die("a delegation handler must never run"))

    const { layer: model } = yield* FakeModel.script([
      { toolCalls: [{ id: "p1", name: "to_child_cancel", params: { n: 1 } }] },
      { text: "parent done" }
    ])
    const store = yield* DurableChannels.memoryStore
    const durable = DurableAgent.workflow(
      "DelegationCancelParent",
      Agent.make({ tools: [toChild], loop: AgentLoop.bounded(3) }),
      { store }
    )
    const layers = Layer.merge(durable.layer, childLayer).pipe(
      Layer.provideMerge(Engine),
      Layer.provideMerge(model)
    )
    const context = yield* Layer.build(layers)

    yield* Effect.gen(function* () {
      const executionId = yield* DurableAgent.submit(durable, store, "w", "go")
      const token = yield* Deferred.await(parked)
      // Let the parent's await settle into whatever the engine does with it.
      yield* Effect.sleep("50 millis")
      const seen = yield* Ref.get(observed)
      yield* DurableDeferred.succeed(Gate, { token, value: "go" })
      const exit = yield* DurableAgent.result(durable, executionId).pipe(
        Effect.timeout("20 seconds"),
        Effect.exit
      )
      assert.isTrue(Exit.isSuccess(exit), Exit.isFailure(exit) ? String(exit.cause) : "")
      // The finding, pinned: a parent's suspension interrupt does reach the
      // delegation runner through `DurableToolkit.handle` and `ToolExecution`.
      assert.isTrue(seen, "the parent's suspension interrupt did not reach the runner")
    }).pipe(Effect.provide(context))
  })), 30_000)
