import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Stream } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Bounded remote observation (`plan-streaming-followups.md` §4, item 75).
 *
 * The bus never waits on a subscriber, so an observer that stops reading
 * used to retain every envelope until its connection died. The client now
 * bounds what an observer of `events` or `stream` may have outstanding, by
 * envelopes and by wire bytes, and ends a lagging observation with
 * `AgentObservationLagError` naming the last sequence it delivered; a host
 * passes that through to HTTP and RPC. The
 * rows hold what the plan promised: execution and the host's own record are
 * untouched, the failed observer can resume from the host's tail, and the
 * default bound does not bite an ordinary consumer. Observers are
 * independent by construction -- each `events` call is its own seam -- and
 * a bound small enough to trip on an in-process burst trips any consumer
 * for a moment, so "another observer untouched" is not a row a tiny bound
 * can hold; the defaults row is where a consumer that keeps up is shown.
 */
const Host = AgentSessionHost.Tag<string>("test/ObservationBound/host")
const principal = "observer"

const chunk = "x".repeat(1024)
const streamedTurn = { text: chunk.repeat(64), chunks: Array.from({ length: 64 }, () => chunk) }

const hostWith = (lag: { readonly envelopes?: number; readonly bytes?: number } | undefined) =>
  Effect.gen(function* () {
    const { layer: model } = yield* TestLanguageModel.script([streamedTurn, TestLanguageModel.text("after")])
    const agent = Agent.make({ loop: AgentLoop.bounded(2) })
    return AgentSessionHost.layer(Host, {
      authorization: { authorize: () => Effect.void },
      principal: { resolve: () => Effect.succeed(principal) },
      maxSessions: 4,
      maxRequestsPerSession: 16
    }).pipe(
      Layer.provide(AgentClient.layer(agent, lag === undefined ? {} : { maxObservationLag: lag })),
      Layer.provideMerge(model)
    )
  })

const requestId = (name: string) => AgentProtocol.RequestId.make(name)
const sessionId = AgentProtocol.SessionId.make("observed")

/** An observer that takes `keep` envelopes, then blocks until released; `handed` is the last sequence it was given. */
const stalledObserver = (
  host: AgentSessionHost.Service<string>,
  release: Deferred.Deferred<void>,
  keep: number,
  handed: Ref.Ref<number>
) =>
  Effect.gen(function* () {
    const stream = yield* host.events(principal, { sessionId })
    let taken = 0
    return yield* Stream.runForEach(stream, (envelope) => {
      taken += 1
      return Effect.andThen(Ref.set(handed, envelope.sequence), taken <= keep ? Effect.void : Deferred.await(release))
    })
  })

describe("bounded remote observation", () => {
  it.effect("an observer past the envelope bound is ended with the lag error; the run and the record are untouched", () =>
    Effect.gen(function* () {
      const layer = yield* hostWith({ envelopes: 8 })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* Host
          yield* host.createSession(principal, { requestId: requestId("create"), sessionId })
          const release = yield* Deferred.make<void>()
          const handed = yield* Ref.make(0)
          const stalled = yield* Effect.forkChild(stalledObserver(host, release, 1, handed))
          yield* Effect.yieldNow

          // Execution is unaffected by an observer that stopped reading.
          const result = yield* host.prompt(principal, {
            requestId: requestId("prompt"),
            sessionId,
            input: AgentProtocol.input("go"),
            options: { stream: true }
          })
          assert.strictEqual(result.result.status, "completed")

          // The stalled one, once it looks again, finds its observation ended
          // with the bound it broke and the last sequence it was handed.
          yield* Deferred.succeed(release, void 0)
          const exit = yield* Fiber.await(stalled)
          assert.isTrue(Exit.isFailure(exit), "the stalled observation should have ended")
          const error = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
          assert.strictEqual(error?._tag, "AgentObservationLagError")
          if (error?._tag !== "AgentObservationLagError") return
          assert.strictEqual(error.maxEnvelopes, 8)
          assert.strictEqual(error.retainedEnvelopes, 9, "ended by the publish that took it past the bound")
          // Handed out in chunks, so more than the one it took may have been
          // delivered; the cursor is exactly the last it was given, built at
          // delivery rather than when the publisher recorded the kill.
          assert.strictEqual(error.lastDelivered, yield* Ref.get(handed))

          // And the host's record resumes right after the last sequence the
          // observer was handed. The record is an observer of the same
          // client too, so a bound this small stops it mid-burst as well;
          // the defaults row is where it is shown holding the whole run.
          const log = yield* host.eventLog(principal, { sessionId, after: error.lastDelivered })
          assert.strictEqual(log.events[0]?.sequence, error.lastDelivered + 1)
        }).pipe(Effect.provide(layer))
      )
    })
  )

  it.effect("the byte bound counts wire JSON, so large deltas end an observation before the envelope bound would", () =>
    Effect.gen(function* () {
      const layer = yield* hostWith({ envelopes: 1000, bytes: 8 * 1024 })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* Host
          yield* host.createSession(principal, { requestId: requestId("create"), sessionId })
          const release = yield* Deferred.make<void>()
          const stalled = yield* Effect.forkChild(stalledObserver(host, release, 1, yield* Ref.make(0)))
          yield* Effect.yieldNow
          yield* host.prompt(principal, { requestId: requestId("prompt"), sessionId, input: AgentProtocol.input("go"), options: { stream: true } })
          yield* Deferred.succeed(release, void 0)
          const exit = yield* Fiber.await(stalled)
          const error = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
          assert.strictEqual(error?._tag, "AgentObservationLagError")
          if (error?._tag !== "AgentObservationLagError") return
          assert.isBelow(error.retainedEnvelopes, 1000, "the envelope bound was not what ended it")
          assert.isAtMost(error.retainedBytes, 8 * 1024 + 2048, "at most one envelope past the byte bound")
          assert.isAbove(error.retainedBytes, 4 * 1024, "a few kilobyte deltas were retained before it ended")
        }).pipe(Effect.provide(layer))
      )
    })
  )

  it.effect("the default bound does not end an observer that keeps up", () =>
    Effect.gen(function* () {
      const layer = yield* hostWith(undefined)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* Host
          yield* host.createSession(principal, { requestId: requestId("create"), sessionId })
          const collected = yield* Effect.forkChild(
            Effect.flatMap(host.events(principal, { sessionId }), (stream) =>
              Stream.runCollect(Stream.takeUntil(stream, (e) => e.event._tag === "SubmissionCompleted")))
          )
          yield* Effect.yieldNow
          yield* host.prompt(principal, { requestId: requestId("prompt"), sessionId, input: AgentProtocol.input("go"), options: { stream: true } })
          const seen = yield* Fiber.join(collected)
          assert.strictEqual(seen[seen.length - 1]!.event._tag, "SubmissionCompleted")
          const sequences = seen.map((e) => e.sequence)
          assert.deepStrictEqual(sequences, sequences.map((_, i) => sequences[0]! + i), "contiguous: nothing was dropped")
          // The host's record, an observer under the same default, holds the run.
          const log = yield* host.eventLog(principal, { sessionId })
          assert.isTrue(log.events.some((e) => e.event._tag === "SubmissionCompleted"))
        }).pipe(Effect.provide(layer))
      )
    })
  )
})
