import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Ref, Schema } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { DurableDeferred } from "effect/unstable/workflow"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as ContextTransform from "../src/ContextTransform.js"
import { AgentClient } from "../src/client/index.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import * as FakeModel from "./FakeModel.js"

/**
 * The claim `/durable` actually rests on, finally asserted.
 *
 * `guide-durable.md` and `DurableAgent`'s own header say it plainly:
 * *"Canonical history is not stored: it is rebuilt from replayed activity
 * results."* That is the reason the package needs no history store, and it is
 * the load-bearing sentence of the whole design.
 *
 * Nothing was checking it. The replay tests count *side effects* -- the refund
 * happened once, the model was called twice -- and a rebuild that silently
 * dropped a tool result, or reordered a turn, or lost a steer, would pass every
 * one of them while handing the next turn a conversation that never happened.
 * The failure has no symptom at the point it occurs; it surfaces later as a
 * model that answers as though it had forgotten something.
 *
 * So this asserts the thing itself: the same script, run straight through and
 * run across a suspension, must produce the *same* canonical history.
 */

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

const Lookup = Tool.make("lookup", {
  parameters: Schema.Struct({ of: Schema.String }),
  success: Schema.String
})

/** A turn that calls a tool, then a turn that answers: two turns and a tool result to rebuild. */
const script: ReadonlyArray<FakeModel.Turn> = [
  { toolCalls: [{ id: "l1", name: "lookup", params: { of: "orders" } }] },
  { text: "three orders" }
]

/**
 * Run the same submission, optionally suspending once between the turns.
 *
 * The gate lives in a `ContextTransform`, which runs inside the workflow
 * before a model call -- the established way in this suite to stop a
 * submission mid-flight and let it be resumed by an external actor, which is
 * what a resumed process is from the journal's point of view.
 */
const historyOf = (suspend: boolean) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const toolkit = yield* Agent.toolkit([Lookup], {
      lookup: ({ of }) => Effect.as(Ref.update(calls, (n) => n + 1), `found ${of}`)
    })

    const gateReady = yield* Deferred.make<DurableDeferred.Token>()
    const Gate = DurableDeferred.make(`ReplayHistoryGate/${suspend}`, { success: Schema.String })
    const suspendOnce = yield* Ref.make(suspend)
    const gating = ContextTransform.make((context) =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(suspendOnce, false)) {
          const token = yield* DurableDeferred.token(Gate)
          yield* Deferred.succeed(gateReady, token)
          yield* DurableDeferred.await(Gate)
        }
        return context.canonicalPrompt
      })
    )

    const agent = Agent.make({
      instructions: "Answer from the tool.",
      toolkit,
      loop: AgentLoop.bounded(4),
      contextTransform: gating
    })

    const store = yield* DurableChannels.memoryStore
    const sessionStore = yield* DurableSessionStore.memoryStore
    const delivery = yield* DeliveryLog.memoryLog
    const { layer: model } = yield* FakeModel.script(script)
    const runtime = DurableAgentClient.layer("ReplayHistoryAgent", agent, {
      store,
      sessionStore,
      delivery
    }).pipe(Layer.provideMerge(Engine), Layer.provideMerge(model))

    return yield* Effect.gen(function* () {
      const client = yield* Effect.service(AgentClient.AgentClient)
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* client.createSession({ sessionId: `replay-${suspend}` })
          const running = yield* Effect.forkChild(session.prompt("how many orders"))
          if (suspend) {
            // Wake it the way an external actor would, which is what makes the
            // second half of the run a replay of the first.
            const token = yield* Deferred.await(gateReady)
            yield* DurableDeferred.succeed(Gate, { token, value: "go" })
          }
          const result = yield* Fiber.join(running)
          const history = yield* session.history
          return { history, result, toolCalls: yield* Ref.get(calls) }
        })
      )
    }).pipe(Effect.provide(runtime))
  })

/** Roles and content only: ids and timing are not what the claim is about. */
const partsOf = (content: Prompt.Message["content"]) =>
  typeof content === "string"
    ? [{ type: "text", detail: content }]
    : content.map((part) =>
      part.type === "text"
        ? { type: part.type, detail: part.text }
        : part.type === "tool-call"
        ? { type: part.type, detail: `${part.name}:${JSON.stringify(part.params)}` }
        : part.type === "tool-result"
        ? { type: part.type, detail: `${part.name}:${JSON.stringify(part.result)}` }
        : { type: part.type, detail: "" }
    )

const shape = (prompt: Prompt.Prompt) =>
  prompt.content.map((message) => ({ role: message.role, parts: partsOf(message.content) }))

describe("durable replay rebuilds the same history", () => {
  it.live("a submission that suspended has the canonical history of one that did not", () =>
    Effect.gen(function* () {
      const straight = yield* historyOf(false)
      const replayed = yield* historyOf(true)

      // The side-effect assertions the existing suite makes, kept because a
      // rebuild that got the history right by running the tool twice would be
      // no better.
      assert.strictEqual(straight.toolCalls, 1, "the straight run called the tool more than once")
      assert.strictEqual(replayed.toolCalls, 1, "the replayed run re-issued the tool call")
      assert.strictEqual(straight.result.text, replayed.result.text)

      // The claim itself.
      assert.deepStrictEqual(
        shape(replayed.history),
        shape(straight.history),
        "a resumed submission rebuilt a different conversation than the one it would have had"
      )
      // And it is not vacuously equal: the tool call and its result are both
      // in there, which is what a rebuild could most plausibly lose.
      const kinds = shape(straight.history).flatMap((message) => message.parts.map((part) => part.type))
      assert.include(kinds, "tool-call")
      assert.include(kinds, "tool-result")
    }),
    30_000
  )
})
