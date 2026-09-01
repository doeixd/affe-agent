import { Effect, Fiber, Option, Schema, Stream } from "effect"
import type { Duration, Scope } from "effect"
import type { AgentEventEnvelope } from "../AgentEvent.js"
import type * as DeliveryLog from "../durable/DeliveryLog.js"
import type { StorageError } from "../Errors.js"
import * as Ids from "../internal/ids.js"
import { checks, report, type Report } from "./internal/conformance.js"

/**
 * The conformance suite every `DeliveryLog` must pass.
 *
 * The delivery log is what a client observes, and the two things it must
 * get right are the two numbers it keeps apart: the **key** (an event's
 * identity under replay -- a key's first occurrence is the event, later
 * ones are duplicates, a disagreeing one is a conflict) and the
 * **sequence** (the session-wide offset a client resumes from). The memory
 * and SQL logs and the Durable Streams log all run this; a log over your own
 * backing is held to the same rows.
 *
 * Framework-agnostic, as `SandboxConformance` is. The cases run on the live
 * clock: `live` subscriptions on a remote backing need real time to settle.
 */

export class Failure extends Schema.TaggedError<Failure>()(
  "DeliveryLogConformanceFailure",
  { case: Schema.String, detail: Schema.String }
) {
  override get message() {
    return `delivery log conformance: ${this.case}: ${this.detail}`
  }
}

export interface Case<E> {
  readonly name: string
  readonly run: Effect.Effect<void, Failure | StorageError | E>
}

export interface Options<E> {
  /** A fresh log, per case. Scoped, so a log over a connection can close it. */
  readonly log: Effect.Effect<DeliveryLog.DeliveryLog, E, Scope.Scope>
  /**
   * How long a `live` subscription needs to be established before appends
   * are expected to reach it. The in-process logs subscribe on the first
   * yield; a remote one has a round trip to make first.
   */
  readonly settle?: Duration.Input | undefined
}

const { equal, that } = checks((name, detail) => new Failure({ case: name, detail }))

/** An envelope as a recorder would offer it: its own per-process sequence. */
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

const settled = (settle: Duration.Input | undefined) =>
  settle === undefined ? Effect.yieldNow : Effect.sleep(settle)

export const cases = <E>(options: Options<E>): ReadonlyArray<Case<E>> => {
  const make = (
    name: string,
    body: (log: DeliveryLog.DeliveryLog) => Effect.Effect<void, Failure | StorageError | E>
  ): Case<E> => ({ name, run: Effect.scoped(Effect.flatMap(options.log, body)) })
  return [
    make("assigns a session-wide offset and reads back from one", (log) =>
      Effect.gen(function* () {
        const name = "assigns a session-wide offset and reads back from one"
        const first = yield* log.append("s", "k1", envelope(1, { _tag: "SubmissionStarted" }))
        const second = yield* log.append("s", "k2", envelope(2, { _tag: "RunStarted" }))
        // Another submission's recorder starts its own count at 1 again;
        // the log's offset does not.
        const third = yield* log.append("s", "k3", envelope(1, { _tag: "TurnStarted" }))
        yield* equal(name)(first, { _tag: "Appended", sequence: 1 }, "first append")
        yield* equal(name)(second, { _tag: "Appended", sequence: 2 }, "second append")
        yield* equal(name)(third, { _tag: "Appended", sequence: 3 }, "third append")

        const all = yield* log.read("s")
        yield* equal(name)(all.map((e) => e.sequence), [1, 2, 3], "read back")
        yield* equal(name)(
          (yield* log.read("s", { after: 2 })).map((e) => e.event._tag),
          ["TurnStarted"],
          "read after 2"
        )
        // Sessions do not share an offset space.
        yield* equal(name)(
          yield* log.append("other", "k1", envelope(7, { _tag: "RunStarted" })),
          { _tag: "Appended", sequence: 1 },
          "another session's first append"
        )
        yield* equal(name)(yield* log.read("missing"), [], "an unknown session")
      })),

    make("a replayed event is a duplicate; a disagreeing one is a conflict", (log) =>
      Effect.gen(function* () {
        const name = "a replayed event is a duplicate; a disagreeing one is a conflict"
        yield* log.append("s", "k1", envelope(1, { _tag: "RunStarted" }))
        // Same key, same payload, different local sequence: the replay it is.
        yield* equal(name)(
          yield* log.append("s", "k1", envelope(9, { _tag: "RunStarted" })),
          { _tag: "Duplicate" },
          "a replay"
        )
        // Same key, different payload: not hidden.
        yield* equal(name)(
          yield* log.append("s", "k1", envelope(1, { _tag: "TurnStarted" })),
          { _tag: "Conflict" },
          "a disagreeing replay"
        )
        // Neither changed what is recorded.
        yield* equal(name)(
          (yield* log.read("s")).map((e) => [e.sequence, e.event._tag]),
          [[1, "RunStarted"]],
          "what is recorded"
        )
      })),

    make("stores the wire projection of tool results", (log) =>
      Effect.gen(function* () {
        const name = "stores the wire projection of tool results"
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
        yield* that(name)(stored?.event._tag === "ToolCallSucceeded", "expected the tool event back")
        if (stored?.event._tag === "ToolCallSucceeded") {
          // A `Date` cannot cross; the encoded form is what both fields hold.
          yield* equal(name)(stored.event.result, when.toISOString(), "result")
          yield* equal(name)(stored.event.encodedResult, when.toISOString(), "encodedResult")
        }
      })),

    make("live carries only what is appended after subscribing", (log) =>
      Effect.gen(function* () {
        const name = "live carries only what is appended after subscribing"
        yield* log.append("s", "before", envelope(1, { _tag: "SubmissionStarted" }))
        const collected = yield* Effect.forkChild(Stream.runCollect(Stream.take(log.live("s"), 2)))
        yield* settled(options.settle)
        yield* log.append("s", "a", envelope(2, { _tag: "RunStarted" }))
        // Duplicates are not republished either.
        yield* log.append("s", "a", envelope(2, { _tag: "RunStarted" }))
        yield* log.append("s", "b", envelope(3, { _tag: "TurnStarted" }))
        const seen = yield* Fiber.join(collected)
        yield* equal(name)(
          seen.map((e) => [e.sequence, e.event._tag]),
          [[2, "RunStarted"], [3, "TurnStarted"]],
          "what live delivered"
        )
      }))
  ]
}

/**
 * The property only a cross-process log has: a live subscription on one
 * instance sees an append another instance made over the same storage.
 * `twoLogs` yields two independent logs sharing one backing store. The
 * memory log is exempt -- its store is per-instance -- and does not run
 * this.
 */
export const crossProcessCases = <E>(options: {
  readonly twoLogs: Effect.Effect<
    readonly [DeliveryLog.DeliveryLog, DeliveryLog.DeliveryLog],
    E,
    Scope.Scope
  >
  readonly settle: Duration.Input
}): ReadonlyArray<Case<E>> => [
  {
    name: "a subscriber on one instance sees an append from another",
    run: Effect.scoped(
      Effect.gen(function* () {
        const name = "a subscriber on one instance sees an append from another"
        const [writer, reader] = yield* options.twoLogs
        // The reader has never touched the session; it learns the tail from
        // storage and tails from there.
        yield* writer.append("s", "k1", envelope(1, { _tag: "SubmissionStarted" }))
        const collected = yield* Effect.forkChild(Stream.runCollect(Stream.take(reader.live("s"), 2)))
        yield* Effect.sleep(options.settle)
        yield* writer.append("s", "k2", envelope(2, { _tag: "RunStarted" }))
        yield* writer.append("s", "k3", envelope(3, { _tag: "TurnStarted" }))
        const seen = yield* Fiber.join(collected)
        // Contiguous session offsets, from the other instance, deduped: a
        // re-append of k2 does not surface a second time.
        yield* writer.append("s", "k2", envelope(2, { _tag: "RunStarted" }))
        yield* equal(name)(
          seen.map((e) => [e.sequence, e.event._tag]),
          [[2, "RunStarted"], [3, "TurnStarted"]],
          "what the other instance's subscriber saw"
        )
      })
    )
  }
]

/** Every case, reported. Never fails. */
export const run = <E>(options: Options<E>): Effect.Effect<Report> => report(cases(options))
