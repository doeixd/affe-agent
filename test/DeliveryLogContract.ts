import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Option, Stream } from "effect"
import type { Duration, Scope } from "effect"
import type { AgentEventEnvelope } from "../src/AgentEvent.js"
import type * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as Ids from "../src/internal/ids.js"

/**
 * The delivery log is what a client observes, and the two things it must get
 * right are the two numbers it keeps apart: the key (identity, for replay)
 * and the sequence (the session-wide offset, for reconnection). Every
 * implementation runs this contract.
 */

/** An envelope as the recorder would offer it: its own per-process sequence. */
export const envelope = (
  sequence: number,
  event: AgentEventEnvelope["event"]
): AgentEventEnvelope => ({
  sessionId: Ids.sessionId("s"),
  submissionId: Option.some(Ids.submissionId("s:submission-1")),
  runId: Option.some(Ids.runId("run-1")),
  turn: Option.some(1),
  sequence,
  event
})

/**
 * `settle` is how long a `live` subscription needs to be established before
 * appends are expected to reach it. The in-process logs subscribe on the
 * first yield; a remote one has a round trip to make first.
 */
export const contract = (
  name: string,
  makeLog: Effect.Effect<DeliveryLog.DeliveryLog, never, Scope.Scope>,
  options: { readonly settle?: Duration.Input } = {}
) =>
  describe(`DeliveryLog (${name})`, () => {
    it.live("assigns a session-wide offset and reads back from one", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const log = yield* makeLog

          const first = yield* log.append("s", "k1", envelope(1, { _tag: "SubmissionStarted" }))
          const second = yield* log.append("s", "k2", envelope(2, { _tag: "RunStarted" }))
          // Another submission's recorder starts its own count at 1 again; the
          // log's offset does not.
          const third = yield* log.append("s", "k3", envelope(1, { _tag: "TurnStarted" }))
          assert.deepStrictEqual(first, { _tag: "Appended", sequence: 1 })
          assert.deepStrictEqual(second, { _tag: "Appended", sequence: 2 })
          assert.deepStrictEqual(third, { _tag: "Appended", sequence: 3 })

          const all = yield* log.read("s")
          assert.deepStrictEqual(all.map((e) => e.sequence), [1, 2, 3])
          assert.deepStrictEqual(
            (yield* log.read("s", { after: 2 })).map((e) => e.event._tag),
            ["TurnStarted"]
          )
          // Sessions do not share an offset space.
          assert.deepStrictEqual(
            yield* log.append("other", "k1", envelope(7, { _tag: "RunStarted" })),
            { _tag: "Appended", sequence: 1 }
          )
          assert.deepStrictEqual(yield* log.read("missing"), [])
        })
      )
    )

    it.live("a replayed event is a duplicate; a disagreeing one is a conflict", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const log = yield* makeLog
          yield* log.append("s", "k1", envelope(1, { _tag: "RunStarted" }))

          // Same key, same payload, different local sequence: the replay it is.
          assert.deepStrictEqual(
            yield* log.append("s", "k1", envelope(9, { _tag: "RunStarted" })),
            { _tag: "Duplicate" }
          )
          // Same key, different payload: not hidden.
          assert.deepStrictEqual(
            yield* log.append("s", "k1", envelope(1, { _tag: "TurnStarted" })),
            { _tag: "Conflict" }
          )
          // Neither changed what is recorded.
          const all = yield* log.read("s")
          assert.deepStrictEqual(all.map((e) => [e.sequence, e.event._tag]), [
            [1, "RunStarted"]
          ])
        })
      )
    )

    it.live("stores the wire projection of tool results", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const log = yield* makeLog
          const when = new Date("2026-01-01T00:00:00Z")
          yield* log.append(
            "s",
            "tool",
            envelope(1, {
              _tag: "ToolCallSucceeded",
              id: "c1",
              name: "clock",
              result: when,
              encodedResult: when.toISOString()
            })
          )
          const [stored] = yield* log.read("s")
          assert.isDefined(stored)
          if (stored?.event._tag === "ToolCallSucceeded") {
            // A `Date` cannot cross; the encoded form is what both fields hold.
            assert.strictEqual(stored.event.result, when.toISOString())
            assert.strictEqual(stored.event.encodedResult, when.toISOString())
          } else {
            assert.fail("expected the tool event back")
          }
        })
      )
    )

    it.live("live carries only what is appended after subscribing", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const log = yield* makeLog
          yield* log.append("s", "before", envelope(1, { _tag: "SubmissionStarted" }))

          const collected = yield* Effect.forkChild(
            Stream.runCollect(Stream.take(log.live("s"), 2))
          )
          yield* options.settle === undefined ? Effect.yieldNow : Effect.sleep(options.settle)
          yield* log.append("s", "a", envelope(2, { _tag: "RunStarted" }))
          // Duplicates are not republished either.
          yield* log.append("s", "a", envelope(2, { _tag: "RunStarted" }))
          yield* log.append("s", "b", envelope(3, { _tag: "TurnStarted" }))

          const seen = yield* Fiber.join(collected)
          assert.deepStrictEqual(
            seen.map((e) => [e.sequence, e.event._tag]),
            [
              [2, "RunStarted"],
              [3, "TurnStarted"]
            ]
          )
        })
      )
    )
  })


/**
 * The property only a cross-process log has: a live subscription on one
 * instance sees an append another instance made over the same storage.
 * `twoLogs` yields two independent logs sharing one backing store. The
 * memory log is exempt -- its store is per-instance -- and does not run this.
 */
export const crossProcessLive = (
  name: string,
  twoLogs: Effect.Effect<
    readonly [DeliveryLog.DeliveryLog, DeliveryLog.DeliveryLog],
    never,
    Scope.Scope
  >,
  options: { readonly settle: Duration.Input }
) =>
  describe(`DeliveryLog (${name}) cross-process live`, () => {
    it.live("a subscriber on one instance sees an append from another", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const [writer, reader] = yield* twoLogs
          // The reader has never touched the session; it learns the tail from
          // storage and tails from there.
          yield* writer.append("s", "k1", envelope(1, { _tag: "SubmissionStarted" }))
          const collected = yield* Effect.forkChild(
            Stream.runCollect(Stream.take(reader.live("s"), 2))
          )
          yield* Effect.sleep(options.settle)
          yield* writer.append("s", "k2", envelope(2, { _tag: "RunStarted" }))
          yield* writer.append("s", "k3", envelope(3, { _tag: "TurnStarted" }))
          const seen = yield* Fiber.join(collected)
          // Contiguous session offsets, from the other instance, deduped:
          // a re-append of k2 does not surface a second time.
          yield* writer.append("s", "k2", envelope(2, { _tag: "RunStarted" }))
          assert.deepStrictEqual(
            seen.map((e) => [e.sequence, e.event._tag]),
            [[2, "RunStarted"], [3, "TurnStarted"]]
          )
        })
      )
    )
  })
