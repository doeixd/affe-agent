import { assert, describe, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Fiber, Layer, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
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
 * Run limits, pressed against a suspension.
 *
 * The budget finding suggested where to look: a loop combinator that keeps
 * count *outside* the run's own state is charged again on replay, while one
 * that reads the state is not. By that reading `maxTurns` and `maxToolCalls`
 * are safe -- they read `state.turnIndex` and `state.toolCallsTotal`, both
 * derived -- and `maxDuration` is the interesting one, because it reads a
 * clock.
 *
 * A durable run is *designed* to park: waiting for an approval, an
 * elicitation answer, a human who has gone home. If parked time counts
 * against a duration limit, then the one kind of run durability exists to
 * support is the one a duration limit kills.
 */

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

const ping = Agent.tool(
  Tool.make("ping", { parameters: Schema.Struct({}), success: Schema.String }),
  () => Effect.succeed("pong")
)

/** Two turns, with a suspension of `parked` between them. */
const runAcrossSuspension = (options: {
  readonly name: string
  readonly loop: AgentLoop.AgentLoop<never, never, any>
  readonly parked: Duration.Input
}) =>
  Effect.gen(function* () {
    const gateReady = yield* Deferred.make<DurableDeferred.Token>()
    const Gate = DurableDeferred.make(`${options.name}Gate`, { success: Schema.String })
    const suspendOnce = yield* Ref.make(true)
    const turns = yield* Ref.make(0)
    const gating = ContextTransform.make((context) =>
      Effect.gen(function* () {
        if ((yield* Ref.get(turns)) > 0 && (yield* Ref.getAndSet(suspendOnce, false))) {
          const token = yield* DurableDeferred.token(Gate)
          yield* Deferred.succeed(gateReady, token)
          yield* DurableDeferred.await(Gate)
        }
        yield* Ref.update(turns, (n) => n + 1)
        return context.canonicalPrompt
      })
    )

    const agent = Agent.make({
      instructions: "Ping, then answer.",
      tools: [ping],
      loop: options.loop,
      contextTransform: gating
    })
    const { layer: model } = yield* FakeModel.script([
      { toolCalls: [{ id: "p1", name: "ping", params: {} }] },
      { text: "done" }
    ])

    const store = yield* DurableChannels.memoryStore
    const sessionStore = yield* DurableSessionStore.memoryStore
    const delivery = yield* DeliveryLog.memoryLog
    const runtime = DurableAgentClient.layer(options.name, agent, {
      store,
      sessionStore,
      delivery
    }).pipe(Layer.provideMerge(Engine), Layer.provideMerge(model))

    return yield* Effect.gen(function* () {
      const client = yield* Effect.service(AgentClient.AgentClient)
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* client.createSession({ sessionId: options.name })
          const running = yield* Effect.forkChild(session.prompt("go"))
          const token = yield* Deferred.await(gateReady)
          // The run is parked for longer than the limit under test.
          yield* Effect.sleep(options.parked)
          yield* DurableDeferred.succeed(Gate, { token, value: "go" })
          return yield* Fiber.join(running)
        })
      )
    }).pipe(Effect.provide(runtime))
  })

describe("run limits across a suspension", () => {
  it.live("a turn limit counts turns, and a suspension is not one", () =>
    Effect.gen(function* () {
      const result = yield* runAcrossSuspension({
        name: "LimitTurns",
        loop: AgentLoop.limits({ maxTurns: 4 }),
        parked: "300 millis"
      })

      // Two turns happened; the limit is four, and parking is not a turn.
      assert.strictEqual(result.text, "done")
      assert.strictEqual(result.turns, 2)
    }),
    30_000
  )

  it.live("a duration limit does not count the time a run spent parked", () =>
    Effect.gen(function* () {
      /**
       * The one a durable deployment actually depends on.
       *
       * A limit of 200ms and a park of 600ms: if `state.elapsed` is wall time
       * since the run began, the resumed run is already three times over its
       * limit before it does anything, and stops with `max duration` having
       * spent almost none. That is not a limit doing its job -- the work took
       * no time at all -- and the runs it kills are exactly the ones
       * durability exists for: parked on an approval, an elicitation, a human
       * who went to lunch.
       */
      const result = yield* runAcrossSuspension({
        name: "LimitDuration",
        loop: AgentLoop.limits({ maxTurns: 4, maxDuration: "200 millis" }),
        parked: "600 millis"
      })

      assert.strictEqual(
        result.text,
        "done",
        "the run stopped on its duration limit after being parked: the clock ran while nothing did"
      )
      assert.strictEqual(result.turns, 2, "the second turn never happened")
    }),
    30_000
  )
})
