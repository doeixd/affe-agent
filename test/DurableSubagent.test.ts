import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Layer, Schema } from "effect"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import * as Agent from "../src/Agent.js"
import * as AgentInput from "../src/AgentInput.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentOutput from "../src/AgentOutput.js"
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
      { description: "Look an order up.", store, sessionStore, delivery }
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
      // The child's session id is a pure function of the parent's execution id
      // and the tool call id, so the test can address it.
      const parentExecutionId = yield* DurableAgent.executionIdFor(parentWorkflow, "p")
      const childSessionId = `subagent:${parentExecutionId}:p1`
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
