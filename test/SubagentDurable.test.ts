import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Ref, Schema } from "effect"
import { LanguageModel } from "effect/unstable/ai"
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
import { Subagent } from "../src/subagent/index.js"
import * as FakeModel from "./FakeModel.js"

/**
 * A subagent under durability.
 *
 * Both halves are covered alone. `test/Subagent.test.ts` proves delegation
 * composes out of ordinary pieces, and the durable suites prove a tool call is
 * journalled and replayed rather than repeated. Nothing put them together, and
 * the composition is where the money is: a delegation is not a cheap tool. It
 * is a whole second agent, with its own model calls, and re-running one on
 * every resume is the "refund goes out twice" hazard with a bigger number
 * attached.
 *
 * What makes it non-obvious is that the child is *invisible* to the journal.
 * `Subagent.tool` is an ordinary tool whose handler happens to open another
 * session, so `DurableToolkit` wraps the delegation as one activity and the
 * child's own model calls are inside it, journalled as nothing in particular.
 * Whether that replays correctly is a question about the boundary, not about
 * either side of it.
 */

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

/** A model that counts what it was asked, so "ran once" is measurable. */
const counting = (calls: Ref.Ref<number>, inner: Layer.Layer<LanguageModel.LanguageModel>) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    Effect.map(LanguageModel.LanguageModel, (model) => ({
      ...model,
      generateText: ((options: Parameters<LanguageModel.Service["generateText"]>[0]) =>
        Effect.andThen(
          Ref.update(calls, (n) => n + 1),
          model.generateText(options)
        )) as LanguageModel.Service["generateText"]
    }))
  ).pipe(Layer.provide(inner))

describe("a subagent under durability", () => {
  it.live("a delegation is replayed from the journal, not run a second time", () =>
    Effect.gen(function* () {
      const childCalls = yield* Ref.make(0)
      const childModel = yield* FakeModel.layer([{ text: "the child's findings" }])

      const child = Agent.make({ instructions: "You are the child.", loop: AgentLoop.bounded(2) })
      const research = Subagent.tool("research", child, {
        description: "Delegate research.",
        provide: counting(childCalls, childModel.layer)
      })

      // The suspension lands *after* the delegation, so the resume has to
      // replay it rather than repeat it.
      const delegated = yield* Ref.make(false)
      const gateReady = yield* Deferred.make<DurableDeferred.Token>()
      const Gate = DurableDeferred.make("SubagentDurableGate", { success: Schema.String })
      const suspendOnce = yield* Ref.make(true)
      const gating = ContextTransform.make((context) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(delegated)) && (yield* Ref.getAndSet(suspendOnce, false))) {
            const token = yield* DurableDeferred.token(Gate)
            yield* Deferred.succeed(gateReady, token)
            yield* DurableDeferred.await(Gate)
          }
          return context.canonicalPrompt
        })
      )

      const parent = Agent.make({
        instructions: "Delegate, then answer.",
        tools: [research],
        loop: AgentLoop.bounded(4),
        contextTransform: gating
      })

      const { layer: parentModel } = yield* FakeModel.script([
        { toolCalls: [{ id: "r1", name: "research", params: { prompt: "what broke" } }] },
        { text: "the parent's answer" }
      ])

      const store = yield* DurableChannels.memoryStore
      const sessionStore = yield* DurableSessionStore.memoryStore
      const delivery = yield* DeliveryLog.memoryLog
      const runtime = DurableAgentClient.layer("SubagentDurable", parent, {
        store,
        sessionStore,
        delivery
      }).pipe(Layer.provideMerge(Engine), Layer.provideMerge(parentModel))

      yield* Effect.gen(function* () {
        const client = yield* Effect.service(AgentClient.AgentClient)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* client.createSession({ sessionId: "subagent-durable" })
            const running = yield* Effect.forkChild(session.prompt("what broke?"))

            // The delegation has happened once the child's model has been
            // asked; only then is a suspension interesting.
            yield* Effect.repeat(
              Effect.flatMap(Ref.get(childCalls), (n) =>
                n > 0 ? Ref.set(delegated, true) : Effect.fail("not yet" as const)),
              { times: 400, schedule: undefined }
            ).pipe(Effect.retry({ times: 400 }), Effect.ignore)

            const token = yield* Deferred.await(gateReady)
            yield* DurableDeferred.succeed(Gate, { token, value: "go" })

            const result = yield* Fiber.join(running)
            assert.strictEqual(result.text, "the parent's answer")

            // The whole point: a second agent, with its own model calls, must
            // not run again because the parent resumed.
            assert.strictEqual(
              yield* Ref.get(childCalls),
              1,
              "the subagent ran again across the resume: a delegation is a whole agent, not a cheap call"
            )
          })
        )
      }).pipe(Effect.provide(runtime))
    }),
    30_000
  )

  it.live("an interrupted child is reported as cut short, and the parent carries on", () =>
    Effect.gen(function* () {
      /**
       * What this actually found, after two wrong guesses about it.
       *
       * The first version interrupted the *session* and asserted the child ran
       * once. That passes whether or not 48a exists, because a user interrupt
       * tears down the fibre and upstream's retry only fires when the inner
       * effect was interrupted while the fibre carried on. The second made the
       * child interrupt *itself*, expecting to reach the retry path. It does
       * not, and the reason is the interesting part.
       *
       * **A child session absorbs interruption by design.** So an interrupted
       * child does not raise: `Agent.run` returns normally with whatever was
       * committed before the cut, and nothing interrupt-shaped ever reaches
       * `DurableToolkit`, which is why forcing the retry-safe branch changes
       * nothing here. What the parent is handed was decided on 2026-09-05
       * (`plan-two-decisions.md` §2, item 50): a `SubagentInterruptedError`
       * on the tool's failure channel, carrying the partial text, rather than
       * the partial text as a finished answer. It is an ordinary failure --
       * not an interruption-shaped cause -- so it is journalled and replays
       * as that failure, and a reissue is still not asked for. Matrix
       * footnote 12 says the same, narrowed. `test/Subagent.test.ts` holds
       * the failure's content and both `onError` modes; this row holds the
       * durable half: one child run, and a parent that carried on.
       */
      const childCalls = yield* Ref.make(0)
      const childModel = Layer.effect(
        LanguageModel.LanguageModel,
        Effect.map(LanguageModel.LanguageModel, (model): LanguageModel.Service => ({
          ...model,
          generateText: (() =>
            Effect.flatMap(
              Ref.update(childCalls, (n) => n + 1),
              () => Effect.interrupt
            )) as LanguageModel.Service["generateText"]
        }))
      ).pipe(Layer.provide((yield* FakeModel.layer([{ text: "unused" }])).layer))

      const child = Agent.make({ instructions: "You are the child.", loop: AgentLoop.bounded(2) })
      const research = Subagent.tool("research", child, {
        description: "Delegate research.",
        provide: childModel
      })

      const parent = Agent.make({
        instructions: "Delegate.",
        tools: [research],
        loop: AgentLoop.bounded(3)
      })
      const { layer: parentModel } = yield* FakeModel.script([
        { toolCalls: [{ id: "r1", name: "research", params: { prompt: "what broke" } }] },
        { text: "the parent carried on" }
      ])

      const store = yield* DurableChannels.memoryStore
      const sessionStore = yield* DurableSessionStore.memoryStore
      const delivery = yield* DeliveryLog.memoryLog
      const runtime = DurableAgentClient.layer("SubagentInterrupted", parent, {
        store,
        sessionStore,
        delivery
      }).pipe(Layer.provideMerge(Engine), Layer.provideMerge(parentModel))

      yield* Effect.gen(function* () {
        const client = yield* Effect.service(AgentClient.AgentClient)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* client.createSession({ sessionId: "subagent-interrupt" })
            const result = yield* session.prompt("what broke?")

            // The delegation was cut short and the parent went on regardless.
            assert.strictEqual(result.text, "the parent carried on")
            assert.strictEqual(
              yield* Ref.get(childCalls),
              1,
              "the child ran more than once, so the delegation was reissued after all"
            )
          })
        )
      }).pipe(Effect.provide(runtime))
    }),
    60_000
  )
})
