import { assert, it } from "@effect/vitest"
import { Cause, Duration, Effect, Exit, Layer, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient } from "../src/client/index.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import { Subagent } from "../src/subagent/index.js"
import * as FakeModel from "./FakeModel.js"

/**
 * Item 113: a durable delegation whose child forwards an approval to the
 * parent (`inherit: { approval: "parent" }`) used to starve the process --
 * the child's wait suspended the workflow from inside the parent's
 * delegation tool call, a running activity -- until the test worker died of
 * memory. It is refused now, by name and promptly, until what a suspension
 * should do to a call in flight is decided.
 */

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))
const Deploy = Tool.make("deploy", { parameters: Schema.Struct({}), success: Schema.String, needsApproval: true })

it.live("a durable delegation that forwards its child's approval fails by name instead of hanging", () =>
  Effect.gen(function*() {
    const childModel = yield* FakeModel.layer([{ toolCalls: [{ id: "c1", name: "deploy", params: {} }] }, { text: "child done" }])
    const ops = Subagent.tool(
      "ops",
      Agent.make({ tools: [Agent.tool(Deploy, () => Effect.succeed("deployed"))], loop: AgentLoop.bounded(3) }),
      { description: "Deploys.", provide: childModel.layer, inherit: { approval: "parent" } }
    )
    const { layer: parentModel } = yield* FakeModel.script([
      { toolCalls: [{ id: "p1", name: "ops", params: { prompt: "deploy" } }] },
      { text: "done" }
    ])
    const runtime = DurableAgentClient.layer("DelegationApproval", Agent.make({ tools: [ops], loop: AgentLoop.bounded(3) }), {
      store: yield* DurableChannels.memoryStore,
      sessionStore: yield* DurableSessionStore.memoryStore,
      delivery: yield* DeliveryLog.memoryLog
    }).pipe(Layer.provideMerge(Engine), Layer.provideMerge(parentModel))
    const exit = yield* Effect.gen(function*() {
      const client = yield* Effect.service(AgentClient.AgentClient)
      return yield* Effect.scoped(Effect.flatMap(client.createSession({ sessionId: "d" }), (session) =>
        session.prompt("deploy please")))
    }).pipe(Effect.provide(runtime), Effect.timeout(Duration.seconds(20)), Effect.exit)
    assert.isTrue(Exit.isFailure(exit), "the delegation completed, or the test timed out silently")
    if (Exit.isFailure(exit)) {
      const text = Cause.pretty(exit.cause)
      assert.notInclude(text, "TimeoutError", "it hung until the timeout instead of failing by name")
      // The tag is wrapped on the way out (a tool failure, then the session's);
      // the message is what reaches a caller, and it says what to do instead.
      assert.include(text, "cannot wait for an answer from inside a tool call")
    }
  }), 30_000)

it.live("the same through DurableAgent.workflow, whose elicitor is DurableElicitation's", () =>
  Effect.gen(function*() {
    // The workflow path has an elicitor of its own; the guard must hold there
    // too, or deleting it would pass the row above. Here the refusal reaches
    // the parent's model as the delegation's failure, and the parent answers:
    // the run ends, and the deploy never ran.
    let deploys = 0
    const childModel = yield* FakeModel.layer([{ toolCalls: [{ id: "c1", name: "deploy", params: {} }] }, { text: "child done" }])
    const ops = Subagent.tool(
      "ops",
      Agent.make({ tools: [Agent.tool(Deploy, () => Effect.sync(() => deploys++).pipe(Effect.as("deployed")))], loop: AgentLoop.bounded(3) }),
      { description: "Deploys.", provide: childModel.layer, inherit: { approval: "parent" } }
    )
    const { layer: parentModel } = yield* FakeModel.script([
      { toolCalls: [{ id: "p1", name: "ops", params: { prompt: "deploy" } }] },
      { text: "done" }
    ])
    const store = yield* DurableChannels.memoryStore
    const durable = DurableAgent.workflow("DelegationApprovalWorkflow", Agent.make({ tools: [ops], loop: AgentLoop.bounded(3) }), { store })
    const exit = yield* Effect.gen(function*() {
      const executionId = yield* DurableAgent.submit(durable, store, "w", "deploy please")
      return yield* DurableAgent.result(durable, executionId)
    }).pipe(
      Effect.provide(durable.layer.pipe(Layer.provideMerge(Engine), Layer.provideMerge(parentModel))),
      Effect.timeout(Duration.seconds(20)),
      Effect.exit
    )
    if (Exit.isFailure(exit)) {
      assert.notInclude(Cause.pretty(exit.cause), "TimeoutError", "it hung until the timeout instead of refusing")
    }
    assert.strictEqual(deploys, 0, "the child's deploy ran without an answer")
  }), 30_000)
