import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Layer, Option, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { DurableDeferred } from "effect/unstable/workflow"
import * as Agent from "../src/Agent.js"
import * as AgentInput from "../src/AgentInput.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentOutput from "../src/AgentOutput.js"
import * as ContextTransform from "../src/ContextTransform.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import * as DurableSubmission from "../src/durable/DurableSubmission.js"
import { Subagent } from "../src/subagent/index.js"
import * as FakeModel from "./FakeModel.js"

/**
 * `Subagent.durable`: a durable parent delegating to a child agent that runs as
 * its own durable **session** (`DurableSubmission`), through the
 * `DurableToolkit.delegate` seam. The child's text — or its declared output's
 * value — reaches the parent as the tool's result, and the parent completes.
 *
 * One `LanguageModel` serves both workflows (they share the engine's
 * context), so the script is written in call order: the parent's delegating
 * turn, the child's answer, then the parent's closing turn.
 */
const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

const stores = Effect.gen(function* () {
  const store = yield* DurableChannels.memoryStore
  const sessionStore = yield* DurableSessionStore.memoryStore
  const delivery = yield* DeliveryLog.memoryLog
  return { store, sessionStore, delivery }
})

it.live("a durable parent delegates to a child session and reads its text", () =>
  Effect.scoped(Effect.gen(function* () {
    const { layer: model, recorder } = yield* FakeModel.script([
      { toolCalls: [{ id: "p1", name: "research", params: { prompt: "why is the sky blue" } }] },
      { text: "child findings" },
      { text: "parent done" }
    ])
    const { store, sessionStore, delivery } = yield* stores

    const research = Subagent.durable("research", Agent.make({ instructions: "child" }), {
      description: "Research a question and return a short findings summary.",
      workflowName: "DurableSubagentText",
      store,
      sessionStore,
      delivery
    })

    const parentWorkflow = DurableAgent.workflow(
      "DurableSubagentParent",
      Agent.make({ instructions: "Delegate research.", tools: [research.tool], loop: AgentLoop.bounded(3) }),
      { store }
    )

    const layers = Layer.merge(parentWorkflow.layer, research.workflow.layer).pipe(
      Layer.provideMerge(Engine),
      Layer.provideMerge(model)
    )
    const context = yield* Layer.build(layers)

    const exit = yield* Effect.gen(function* () {
      const executionId = yield* DurableAgent.submit(parentWorkflow, store, "p", "delegate please")
      return yield* DurableAgent.result(parentWorkflow, executionId)
    }).pipe(Effect.timeout("20 seconds"), Effect.exit, Effect.provide(context))

    assert.isTrue(Exit.isSuccess(exit), Exit.isFailure(exit) ? String(exit.cause) : "")
    // The child's answer reached the parent's model as the tool's result.
    assert.include(JSON.stringify(yield* recorder.prompts), "child findings")
  })), 30_000)

it.live("a typed child crosses: its output's value is the tool's result", () =>
  Effect.scoped(Effect.gen(function* () {
    const { layer: model, recorder } = yield* FakeModel.script([
      { toolCalls: [{ id: "p1", name: "lookup", params: { orderId: "o-1" } }] },
      { toolCalls: [{ id: "c1", name: "record_answer", params: { answer: "the order is late" } }] },
      { text: "parent done" }
    ])
    const { store, sessionStore, delivery } = yield* stores

    const Lookup = Schema.Struct({ orderId: Schema.String })
    const Answer = Schema.Struct({ answer: Schema.String })
    const typed = Subagent.durable(
      "lookup",
      Agent.make({
        instructions: "answer",
        input: AgentInput.make(Lookup, ({ orderId }) => `order ${orderId}`),
        output: AgentOutput.make(Answer, { name: "record_answer" })
      }),
      { description: "Look an order up.", workflowName: "DurableSubagentLookup", store, sessionStore, delivery }
    )

    const parentWorkflow = DurableAgent.workflow(
      "DurableSubagentTypedParent",
      Agent.make({ instructions: "Look it up.", tools: [typed.tool], loop: AgentLoop.bounded(3) }),
      { store }
    )

    const layers = Layer.merge(parentWorkflow.layer, typed.workflow.layer).pipe(
      Layer.provideMerge(Engine),
      Layer.provideMerge(model)
    )
    const context = yield* Layer.build(layers)

    const exit = yield* Effect.gen(function* () {
      const executionId = yield* DurableAgent.submit(parentWorkflow, store, "p", "look up o-1")
      return yield* DurableAgent.result(parentWorkflow, executionId)
    }).pipe(Effect.timeout("20 seconds"), Effect.exit, Effect.provide(context))

    assert.isTrue(Exit.isSuccess(exit), Exit.isFailure(exit) ? String(exit.cause) : "")
    // The typed value, not a remark: the parent's model was handed the JSON.
    assert.include(JSON.stringify(yield* recorder.prompts), "the order is late")
  })), 30_000)

it.live("a child cut short is a failure, not a partial read as an answer", () =>
  Effect.scoped(Effect.gen(function* () {
    const childStarted = yield* Deferred.make<void>()
    const { layer: model, recorder } = yield* FakeModel.script([
      { toolCalls: [{ id: "p1", name: "research", params: { prompt: "why" } }] },
      { hang: true, started: childStarted },
      { text: "parent done" }
    ])
    const { store, sessionStore, delivery } = yield* stores

    const research = Subagent.durable("research", Agent.make({ instructions: "child" }), {
      description: "Research a question.",
      workflowName: "DurableSubagentCut",
      store,
      sessionStore,
      delivery
    })
    const parentWorkflow = DurableAgent.workflow(
      "DurableSubagentCutParent",
      Agent.make({ instructions: "Delegate.", tools: [research.tool], loop: AgentLoop.bounded(3) }),
      { store }
    )

    const layers = Layer.merge(parentWorkflow.layer, research.workflow.layer).pipe(
      Layer.provideMerge(Engine),
      Layer.provideMerge(model)
    )
    const context = yield* Layer.build(layers)

    yield* Effect.gen(function* () {
      const executionId = yield* DurableAgent.submit(parentWorkflow, store, "p", "go")
      yield* Deferred.await(childStarted)
      // The child's session id is a pure function of the conversation and the
      // call, so the test can address it.
      const childSessionId = Subagent.childSessionId("p", "p1")
      yield* DurableSubmission.interrupt(store, childSessionId, childSessionId)

      const exit = yield* DurableAgent.result(parentWorkflow, executionId).pipe(
        Effect.timeout("20 seconds"),
        Effect.exit
      )
      assert.isTrue(Exit.isSuccess(exit), Exit.isFailure(exit) ? String(exit.cause) : "")
      // The parent's model read a cut-short failure, not the partial as a result.
      assert.include(JSON.stringify(yield* recorder.prompts), "did not finish")
    }).pipe(Effect.provide(context))
  })), 30_000)

/** A child that parks once on a durable deferred, so the parent awaits a suspended child. */
const parkingChild = (name: string) =>
  Effect.gen(function* () {
    const parked = yield* Deferred.make<DurableDeferred.Token>()
    const Gate = DurableDeferred.make(name, { success: Schema.String })
    const gating = ContextTransform.make((context) =>
      Effect.gen(function* () {
        const token = yield* DurableDeferred.token(Gate)
        yield* Deferred.succeed(parked, token)
        yield* DurableDeferred.await(Gate)
        return context.canonicalPrompt
      }))
    return { parked, Gate, gating }
  })

it.live("a parked child survives the parent's suspension, and its result arrives", () =>
  Effect.scoped(Effect.gen(function* () {
    const { parked, Gate, gating } = yield* parkingChild("DurableSubagentSuspendGate")
    const { layer: model, recorder } = yield* FakeModel.script([
      { toolCalls: [{ id: "p1", name: "research", params: { prompt: "why" } }] },
      { text: "child findings" },
      { text: "parent done" }
    ])
    const { store, sessionStore, delivery } = yield* stores

    const research = Subagent.durable(
      "research",
      Agent.make({ instructions: "child", contextTransform: gating }),
      { description: "Research.", workflowName: "DurableSubagentParked", store, sessionStore, delivery }
    )
    const parentWorkflow = DurableAgent.workflow(
      "DurableSubagentSuspendParent",
      Agent.make({ instructions: "Delegate.", tools: [research.tool], loop: AgentLoop.bounded(3) }),
      { store }
    )
    const layers = Layer.merge(parentWorkflow.layer, research.workflow.layer).pipe(
      Layer.provideMerge(Engine),
      Layer.provideMerge(model)
    )
    const context = yield* Layer.build(layers)

    yield* Effect.gen(function* () {
      const executionId = yield* DurableAgent.submit(parentWorkflow, store, "p", "go")
      const token = yield* Deferred.await(parked)
      // The parent is suspended awaiting the parked child. Resuming the child
      // must find it alive: a suspension is not an abort.
      yield* DurableDeferred.succeed(Gate, { token, value: "go" })
      const exit = yield* DurableAgent.result(parentWorkflow, executionId).pipe(
        Effect.timeout("20 seconds"),
        Effect.exit
      )
      assert.isTrue(Exit.isSuccess(exit), Exit.isFailure(exit) ? String(exit.cause) : "")
      assert.include(JSON.stringify(yield* recorder.prompts), "child findings")
    }).pipe(Effect.provide(context))
  })), 30_000)

it.live("the engine propagates a parent's abort to the child it awaits", () =>
  Effect.scoped(Effect.gen(function* () {
    const { parked, Gate, gating } = yield* parkingChild("DurableSubagentAbortGate")
    const { layer: model } = yield* FakeModel.script([
      { toolCalls: [{ id: "p1", name: "research", params: { prompt: "why" } }] },
      { text: "child findings" },
      { text: "parent done" }
    ])
    const { store, sessionStore, delivery } = yield* stores

    const research = Subagent.durable(
      "research",
      Agent.make({ instructions: "child", contextTransform: gating }),
      { description: "Research.", workflowName: "DurableSubagentParked", store, sessionStore, delivery }
    )
    const parentWorkflow = DurableAgent.workflow(
      "DurableSubagentAbortParent",
      Agent.make({ instructions: "Delegate.", tools: [research.tool], loop: AgentLoop.bounded(3) }),
      { store }
    )
    const layers = Layer.merge(parentWorkflow.layer, research.workflow.layer).pipe(
      Layer.provideMerge(Engine),
      Layer.provideMerge(model)
    )
    const context = yield* Layer.build(layers)

    yield* Effect.gen(function* () {
      const executionId = yield* DurableAgent.submit(parentWorkflow, store, "p", "go")
      const token = yield* Deferred.await(parked)
      const parentExecutionId = yield* DurableAgent.executionIdFor(parentWorkflow, "p")
      const childSessionId = Subagent.childSessionId("p", "p1")
      // The idempotency key is name + session + submission, so the prompt is
      // not part of the child's execution id.
      const childExecutionId = yield* research.workflow.definition.executionId({
        sessionId: childSessionId,
        submissionId: childSessionId,
        prompt: Prompt.empty,
        initialHistory: Prompt.empty,
        stream: false
      })

      // Terminally abort the parent at the engine (the intent path is not
      // consumed by a *suspended* body), then give the engine a moment.
      yield* parentWorkflow.definition.interrupt(parentExecutionId)
      yield* Effect.sleep("200 millis")

      const polled = yield* research.workflow.definition.poll(childExecutionId)
      // Left suspended, the child would still be `Suspended`; cancelled, it is
      // terminal. (Resume the gate either way so nothing leaks.)
      assert.isFalse(
        Option.isSome(polled) && polled.value._tag === "Suspended",
        `the child is still suspended: ${JSON.stringify(polled)}`
      )
      yield* DurableDeferred.succeed(Gate, { token, value: "go" }).pipe(Effect.ignore)
    }).pipe(Effect.provide(context))
  })), 30_000)
