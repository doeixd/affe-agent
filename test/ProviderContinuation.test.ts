import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Ref, Schema } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { DurableDeferred } from "effect/unstable/workflow"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as ContextTransform from "../src/ContextTransform.js"
import * as PromptWire from "../src/PromptWire.js"
import { AgentClient } from "../src/client/index.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import * as FakeModel from "./FakeModel.js"

/**
 * Does provider continuation state survive Affe's own boundaries?
 *
 * `plan-effect-uai-compatibility-contract.md` §4.6 states the property, and
 * `plan-effect-uai-integration.md` ranks it P0 — "do regardless of direct
 * integration" — because it is not a question about effect-uai at all. The
 * chain is:
 *
 * ```text
 * provider response -> canonical history -> PromptWire
 *     -> snapshot / restore -> next request
 * ```
 *
 * The field that makes it urgent is the reasoning signature. Anthropic will not
 * continue a reasoning turn without one, so if it is dropped at any hop then
 * snapshot/restore and durable replay silently break reasoning continuation —
 * for the official provider, today, with no adapter involved. That is why these
 * tests use the ordinary scripted model rather than anything effect-uai.
 *
 * A signature is only ever *observed* at the far end: it leaves as response
 * metadata and must arrive as prompt-part options on the following request.
 * Asserting on history in between would test a representation rather than the
 * property, so every test here ends at a request the model actually received.
 */

/** The provider's own slot. A real one is opaque; a readable one localises failures. */
const SIGNATURE = "sig-9f2c"

/**
 * The shape Effect AI actually types for Anthropic reasoning, through module
 * augmentation: `options.anthropic.info` is a discriminated thinking block, and
 * the signature lives on it. Inventing a flatter shape here would have made the
 * audit pass against a field no provider writes.
 */
const metadata = { anthropic: { info: { type: "thinking", signature: SIGNATURE } } } as const

const Lookup = Tool.make("lookup", {
  description: "look something up",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String
})

/**
 * Every reasoning signature in a prompt, in order.
 *
 * Reads `options` rather than any Affe-side field: that is where Effect AI's
 * `fromResponseParts` merges a response part's metadata, so it is where a
 * provider adapter will look when it builds the next request.
 */
const signaturesIn = (prompt: Prompt.Prompt): Array<unknown> => {
  const found: Array<unknown> = []
  const walk = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return
    if ("signature" in value) {
      const signature = (value as { readonly signature: unknown }).signature
      if (typeof signature === "string") found.push(signature)
    }
    for (const nested of Object.values(value)) walk(nested)
  }
  for (const message of prompt.content) {
    if (message.role !== "assistant") continue
    for (const part of message.content) {
      if (part.type === "reasoning") walk(part.options)
    }
  }
  return found
}

/** A turn that reasons (carrying a signature) and then calls a tool, so a second turn follows. */
const reasonsThenCalls: FakeModel.Turn = {
  reasoning: { text: "I should look this up.", metadata },
  toolCalls: [{ id: "call-1", name: "lookup", params: { query: "effect" } }]
}

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

const agent = Agent.make({
  tools: [Agent.tool(Lookup, () => Effect.succeed("found it"))],
  loop: AgentLoop.bounded(2)
})

describe("provider continuation state across Affe's boundaries", () => {
  /**
   * The first hop, and the one that would make every later hop moot.
   *
   * Affe converts a response to canonical history with
   * `Prompt.fromResponseParts`. If that conversion dropped the reasoning
   * metadata, the signature would never reach history and nothing downstream
   * could carry it.
   */
  it.effect("a reasoning signature reaches the next request", () =>
    Effect.gen(function*() {
      const { layer, recorder } = yield* FakeModel.layer([
        reasonsThenCalls,
        { text: "here it is" }
      ])

      yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* AgentSession.make(agent)
          return yield* AgentSession.prompt(session, "go")
        }).pipe(Effect.provide(layer))
      )

      const prompts = yield* recorder.prompts
      assert.strictEqual(prompts.length, 2, "the tool call should have produced a second turn")
      const second = prompts[1]
      assert.isDefined(second)
      assert.deepStrictEqual(
        signaturesIn(second),
        [SIGNATURE],
        "the second request must carry the signature the first response reported"
      )
    }))

  /**
   * The wire hop. `PromptWire` is what crosses a process boundary and what a
   * snapshot stores, so a prompt that loses its options here loses them
   * everywhere at once.
   */
  it.effect("PromptWire round-trips a reasoning signature", () =>
    Effect.gen(function*() {
      const original = Prompt.make([
        Prompt.makeMessage("assistant", {
          content: [
            Prompt.makePart("reasoning", { text: "thinking", options: metadata }),
            Prompt.makePart("text", { text: "answer" })
          ]
        })
      ])

      const encoded = yield* Schema.encodeEffect(PromptWire.Prompt)(original)
      const decoded = yield* Schema.decodeUnknownEffect(PromptWire.Prompt)(encoded)

      assert.deepStrictEqual(signaturesIn(decoded), [SIGNATURE])
    }))

  /**
   * The hop the contract actually worries about.
   *
   * A snapshot is what survives a process; `restore` rebuilds a session from
   * it. If the signature is lost here, a conversation resumed in a new process
   * cannot continue its reasoning — which is the durable-replay failure mode,
   * reached by the shortest path that exhibits it.
   */
  it.effect("a signature survives snapshot and restore into the next request", () =>
    Effect.gen(function*() {
      const first = yield* FakeModel.layer([reasonsThenCalls, { text: "here it is" }])

      const snapshot = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* AgentSession.make(agent)
          yield* AgentSession.prompt(session, "go")
          return yield* AgentSession.snapshot(session)
        }).pipe(Effect.provide(first.layer))
      )

      // A second process: a fresh model, and a session rebuilt from the
      // snapshot alone.
      const second = yield* FakeModel.layer([{ text: "resumed" }])
      yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* AgentSession.restore(agent, snapshot)
          return yield* AgentSession.prompt(session, "and again")
        }).pipe(Effect.provide(second.layer))
      )

      const prompts = yield* second.recorder.prompts
      const resumed = prompts[0]
      assert.isDefined(resumed)
      assert.deepStrictEqual(
        signaturesIn(resumed),
        [SIGNATURE],
        "a restored session must still be able to continue the provider's reasoning"
      )
    }))

  /**
   * The hop `/durable` is built on, and the one with no existing coverage.
   *
   * `/durable` stores no canonical history: it rebuilds it from replayed
   * activity results. `DurableReplayHistory.test.ts` asserts that the rebuild
   * produces the same conversation, but it compares a *shape* that renders
   * every reasoning part as an empty detail — so a replay that dropped every
   * signature would pass it while handing the next turn a conversation the
   * provider will refuse to continue.
   *
   * Run straight through and run across a suspension, the signature must
   * survive both.
   */
  it.live("a signature survives durable replay", () =>
    Effect.gen(function*() {
      const historyOf = (suspend: boolean) =>
        Effect.gen(function*() {
          const toolkit = yield* Agent.toolkit([Lookup], {
            lookup: () => Effect.succeed("found it")
          })

          const gateReady = yield* Deferred.make<DurableDeferred.Token>()
          const Gate = DurableDeferred.make(`ContinuationGate/${suspend}`, { success: Schema.String })
          const suspendOnce = yield* Ref.make(suspend)
          const gating = ContextTransform.make((context) =>
            Effect.gen(function*() {
              if (yield* Ref.getAndSet(suspendOnce, false)) {
                const token = yield* DurableDeferred.token(Gate)
                yield* Deferred.succeed(gateReady, token)
                yield* DurableDeferred.await(Gate)
              }
              return context.canonicalPrompt
            })
          )

          const durableAgent = Agent.make({
            toolkit,
            loop: AgentLoop.bounded(4),
            contextTransform: gating
          })

          const store = yield* DurableChannels.memoryStore
          const sessionStore = yield* DurableSessionStore.memoryStore
          const delivery = yield* DeliveryLog.memoryLog
          const { layer: model } = yield* FakeModel.script([
            reasonsThenCalls,
            { text: "here it is" }
          ])
          const runtime = DurableAgentClient.layer("ContinuationAgent", durableAgent, {
            store,
            sessionStore,
            delivery
          }).pipe(Layer.provideMerge(Engine), Layer.provideMerge(model))

          return yield* Effect.gen(function*() {
            const client = yield* Effect.service(AgentClient.AgentClient)
            return yield* Effect.scoped(
              Effect.gen(function*() {
                const session = yield* client.createSession({ sessionId: `continuation-${suspend}` })
                const running = yield* Effect.forkChild(session.prompt("go"))
                if (suspend) {
                  const token = yield* Deferred.await(gateReady)
                  yield* DurableDeferred.succeed(Gate, { token, value: "go" })
                }
                yield* Fiber.join(running)
                return yield* session.history
              })
            )
          }).pipe(Effect.provide(runtime))
        })

      const straight = yield* historyOf(false)
      const replayed = yield* historyOf(true)

      assert.deepStrictEqual(
        signaturesIn(straight),
        [SIGNATURE],
        "the straight durable run lost the signature before the journal was even involved"
      )
      assert.deepStrictEqual(
        signaturesIn(replayed),
        [SIGNATURE],
        "a replayed submission rebuilt a conversation the provider would refuse to continue"
      )
    }))
})
