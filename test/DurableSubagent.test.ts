import { assert, it } from "@effect/vitest"
import { Effect, Exit, Layer, Schema } from "effect"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import { Subagent } from "../src/subagent/index.js"
import * as FakeModel from "./FakeModel.js"

/**
 * `Subagent.durable`: a durable parent delegating to a child agent that runs
 * as its own workflow, through the `DurableToolkit.delegate` seam. The child's
 * text reaches the parent as the tool's result, and the parent completes.
 *
 * One `LanguageModel` serves both workflows (they share the engine's
 * context), so the script is written in call order: the parent's delegating
 * turn, the child's answer, then the parent's closing turn.
 */
const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

it.live("a durable parent delegates to a child workflow and reads its result", () =>
  Effect.scoped(Effect.gen(function* () {
    const { layer: model, recorder } = yield* FakeModel.script([
      { toolCalls: [{ id: "p1", name: "research", params: { prompt: "why is the sky blue" } }] },
      { text: "child findings" },
      { text: "parent done" }
    ])

    const store = yield* DurableChannels.memoryStore

    const childWorkflow = DurableAgent.workflow("DurableSubagentChild", Agent.make({ instructions: "child" }), {
      store
    })
    const research = Subagent.durable("research", childWorkflow, {
      description: "Research a question and return a short findings summary."
    })

    const parentWorkflow = DurableAgent.workflow(
      "DurableSubagentParent",
      Agent.make({ instructions: "Delegate research.", tools: [research], loop: AgentLoop.bounded(3) }),
      { store }
    )

    const layers = Layer.merge(parentWorkflow.layer, childWorkflow.layer).pipe(
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
