import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Option, PubSub, Ref, Stream } from "effect"
import * as AgentEvent from "../src/AgentEvent.js"
import { AgentClient } from "../src/client/index.js"
import { AgentExecutionError, AgentTransportError } from "../src/client/AgentClient.js"
import * as Observation from "../src/internal/observation.js"

/**
 * The second reviewer's code findings on the streaming series, each as a
 * row (`plan-streaming-followups.md`, "Code review"). The pumped bound is
 * driven directly with a subscription whose release is observable; the
 * remote tail with a hand-built session.
 */
const sessionId = AgentEvent.SessionId.make("s")
const envelope = (sequence: number, delta = "x"): AgentEvent.AgentEventEnvelope => ({
  sessionId,
  submissionId: Option.some(AgentEvent.SubmissionId.make("s:submission-1")),
  runId: Option.none(),
  turn: Option.none(),
  sequence,
  event: { _tag: "MessageDelta", kind: "text", delta }
})

describe("the pumped bound, over a subscription whose release is observable", () => {
  it.effect("past the bound the subscription is released while the consumer's scope lives, nothing buffered is delivered after, and the cursor is what was handed out", () =>
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<AgentEvent.AgentEventEnvelope>()
      const released = yield* Ref.make(false)
      // Established on return, as a delivery log's `subscribe` is, with a
      // finalizer that records the release.
      const subscribe = Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(pubsub)
        yield* Effect.addFinalizer(() => Ref.set(released, true))
        return Stream.fromSubscription(subscription)
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const bounded = yield* Observation.bounded(subscribe, { sessionId: "s", maxEnvelopes: 2, maxBytes: 1e9 })
          const stall = yield* Deferred.make<void>()
          const delivered: Array<number> = []
          const consumer = yield* Effect.forkChild(
            Stream.runForEach(bounded, (e) => {
              delivered.push(e.sequence)
              return delivered.length === 1 ? Deferred.await(stall) : Effect.void
            })
          )
          yield* Effect.yieldNow
          // One in hand, two buffered, the third is past the bound.
          for (const n of [1, 2, 3, 4]) {
            yield* PubSub.publish(pubsub, envelope(n))
            yield* Effect.yieldNow
          }
          assert.isTrue(yield* Ref.get(released), "the subscription was not released when the bound was broken")
          yield* Deferred.succeed(stall, void 0)
          const exit = yield* Fiber.await(consumer)
          assert.isTrue(Exit.isFailure(exit))
          const error = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
          assert.strictEqual(error?._tag, "AgentObservationLagError")
          if (error?._tag !== "AgentObservationLagError") return
          assert.deepStrictEqual(delivered, [1], "buffered envelopes were delivered after the observation ended")
          assert.strictEqual(error.lastDelivered, 1, "the cursor names what was handed out, not what was recorded earlier")
        })
      )
    })
  )

  it("counts wire bytes in UTF-8, not UTF-16 units", () => {
    assert.strictEqual(Observation.utf8Length("abc"), 3)
    assert.strictEqual(Observation.utf8Length("€"), 3)
    assert.strictEqual(Observation.utf8Length("😀"), 4)
    assert.strictEqual(Observation.utf8Length("é"), 2)
    const euro = envelope(1, "€".repeat(100))
    const asString = JSON.stringify(AgentEvent.toWire(euro)).length
    assert.isAbove(Observation.wireSize(euro), asString + 150, "the byte size must exceed the code-unit count for non-ASCII text")
  })

  it.effect("the byte bound ends an observation whose UTF-16 length would have fit", () =>
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<AgentEvent.AgentEventEnvelope>()
      const euro = envelope(1, "€".repeat(100))
      const asString = JSON.stringify(AgentEvent.toWire(euro)).length
      // Between the code-unit count and the byte count: a bound in UTF-16
      // units would let this envelope through.
      const maxBytes = asString + 100
      const subscribe = Effect.map(PubSub.subscribe(pubsub), Stream.fromSubscription)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const bounded = yield* Observation.bounded(subscribe, { sessionId: "s", maxEnvelopes: 1000, maxBytes })
          const consumer = yield* Effect.forkChild(Stream.runCollect(bounded))
          yield* Effect.yieldNow
          yield* PubSub.publish(pubsub, euro)
          yield* Effect.yieldNow
          const exit = yield* Fiber.await(consumer)
          const error = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
          assert.strictEqual(error?._tag, "AgentObservationLagError", "an envelope past the byte bound in UTF-8 was retained")
        })
      )
    })
  )
})

describe("the remote stream's tail", () => {
  const session = (awaited: Effect.Effect<AgentClient.RemoteResult, AgentClient.RemoteError>): Pick<AgentClient.RemoteSession, "submit" | "awaitSubmission"> => ({
    submit: () => Effect.succeed({ submissionId: AgentEvent.SubmissionId.make("s:submission-1") }),
    awaitSubmission: () => awaited
  })
  const subscribed = Stream.fromIterable([
    { ...envelope(1), event: { _tag: "SubmissionStarted" as const } },
    { ...envelope(2), event: { _tag: "SubmissionCompleted" as const, runs: 1 } }
  ])

  it.effect("suppresses only the run's own failure, which the terminal carried", () =>
    Effect.gen(function* () {
      const collected = yield* Stream.runCollect(
        AgentClient.streamFrom(
          session(Effect.fail(new AgentExecutionError({ sessionId: "s", tag: "Boom", detail: "the run failed", isDefect: false }))),
          subscribed,
          "go",
          undefined
        )
      )
      assert.deepStrictEqual(collected.map((e) => e.event._tag), ["SubmissionStarted", "SubmissionCompleted"])
    })
  )

  it.effect("a transport failure in the wait is not represented by anything delivered, and propagates", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(Stream.runCollect(
        AgentClient.streamFrom(
          session(Effect.fail(new AgentTransportError({ sessionId: "s", detail: "the store went away" }))),
          subscribed,
          "go",
          undefined
        )
      ))
      const error = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
      assert.strictEqual(error?._tag, "AgentTransportError")
    })
  )
})
