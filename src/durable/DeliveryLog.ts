import { Duration, Effect, Option, PubSub, Ref, Schema, Scope, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import * as AgentEvent from "../AgentEvent.js"
import { isStorageError, StorageError } from "../Errors.js"
import { detailOf } from "../internal/detail.js"

/**
 * Client-facing event delivery, kept apart from the Workflow journal.
 *
 * The journal is computation durability; canonical history is semantic state;
 * this log is the third thing people conflate with either: what a *client*
 * observes. It is what lets a browser that disconnected at event 137 and a
 * Slack bot that never saw event 1 both catch up on the same session from a
 * process that did not run any of it.
 *
 * Two numbers matter, and they are different:
 *
 *   - the **key** is the event's identity. A replay re-runs emission logic, so
 *     the same event can be offered twice — possibly from a different process
 *     — and must land once. The key is derived from semantic coordinates by
 *     the recorder (`DurableSubmission`), not from a local counter, because a
 *     counter is not stable under replay when tools run in parallel.
 *   - the **sequence** is the session-wide delivery offset, assigned here on
 *     acceptance. It is what `read({ after })` and reconnecting clients use;
 *     the envelope's own per-process `sequence` is replaced by it on the way in.
 *
 * A duplicate key with an identical payload is the replay it looks like and is
 * dropped silently. A duplicate key with a *different* payload is a recorder
 * bug — two executions disagreeing about what one event was — and is reported
 * as `Conflict` rather than hidden behind `INSERT OR IGNORE`.
 *
 * Token deltas are never journalled by the workflow; they may be recorded here.
 */

/** How `append` disposed of an envelope. */
export type AppendOutcome =
  | { readonly _tag: "Appended"; readonly sequence: number }
  | { readonly _tag: "Duplicate" }
  | { readonly _tag: "Conflict" }

export interface DeliveryLog {
  /**
   * Record one envelope under an idempotency key.
   *
   * The stored and published envelope carries the log's session-wide
   * `sequence`, not the one the envelope arrived with, and is the wire
   * projection (`AgentEvent.toWire`) of what was offered.
   */
  readonly append: (
    sessionId: string,
    key: string,
    envelope: AgentEvent.AgentEventEnvelope
  ) => Effect.Effect<AppendOutcome, StorageError>

  /** Events accepted after this subscription begins. Never ends. */
  readonly live: (
    sessionId: string
  ) => Stream.Stream<AgentEvent.AgentEventEnvelope, StorageError>

  /**
   * As `live`, but **established before this effect returns**.
   *
   * The distinction is the whole of resumption. `live` is a stream, and a
   * stream subscribes when it is first pulled -- which, if it has been handed
   * to a queue or a fibre, is at some later moment nobody controls. A caller
   * that reads history and then starts pulling has a window between the two
   * where an appended event lands in neither, and that window is invisible:
   * the caller sees a shorter stream and no error.
   *
   * Ordering it the other way is what closes it. This effect does not return
   * until the log is *already* holding events for this subscriber, so a read
   * issued afterwards cannot miss one. What it can do is repeat one -- an
   * event arriving during the read is in both halves -- and the caller cuts
   * that overlap by sequence. Duplicates are removable; gaps are not.
   *
   * Scoped, because a subscription is a resource: it accumulates events until
   * something consumes them and is released with the scope that took it.
   */
  readonly subscribe: (
    sessionId: string
  ) => Effect.Effect<
    Stream.Stream<AgentEvent.AgentEventEnvelope, StorageError>,
    StorageError,
    Scope.Scope
  >

  /** Everything recorded for the session above `after`, in sequence order. */
  readonly read: (
    sessionId: string,
    options?: { readonly after?: number | undefined }
  ) => Effect.Effect<ReadonlyArray<AgentEvent.AgentEventEnvelope>, StorageError>
}

// -- Encoding ----------------------------------------------------------------------

/**
 * Envelopes cross storage as JSON of the *wire* projection; an unencodable
 * envelope is a bug in the recorder, not a case a caller handles.
 */
// The JSON codec, not the in-memory declaration: `Option` fields need their
// explicit JSON form to survive text storage, as the SSE adapter also found.
const EnvelopeJson = Schema.toCodecJson(AgentEvent.AgentEventEnvelope)

/**
 * Encoding stays a defect: the envelope was built by this process, so a schema
 * that cannot encode it is a bug in the recorder. See `StorageError`.
 */
export const encodeEnvelope = (
  envelope: AgentEvent.AgentEventEnvelope
): Effect.Effect<string> =>
  Schema.encodeEffect(EnvelopeJson)(AgentEvent.toWire(envelope)).pipe(
    Effect.map((encoded) => JSON.stringify(encoded)),
    Effect.orDie
  )

/**
 * Decoding is a different claim, and this one matters more here than anywhere.
 *
 * D5 says a consumer reconnecting from its saved offset sees every event it
 * had not seen, with no gap. A row it cannot decode -- truncated, written by an
 * older schema, corrupted -- is exactly the gap D5 forbids, and `orDie` made it
 * arrive as a dead fibre rather than as something the consumer could report or
 * retry. It is now in the error channel, where a reconnect strategy can see it.
 */
export const decodeEnvelope = (
  encoded: string,
  sessionId?: string
): Effect.Effect<AgentEvent.AgentEventEnvelope, StorageError> =>
  Effect.try(() => JSON.parse(encoded) as unknown).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(EnvelopeJson)),
    Effect.mapError(
      (cause) =>
        new StorageError({
          operation: "decodeEnvelope",
          ...(sessionId === undefined ? {} : { sessionId }),
          detail: detailOf(cause)
        })
    )
  )

/**
 * Payload equality for conflict detection ignores the per-process `sequence`
 * the envelope arrived with: two replays legitimately number the same event
 * differently, and the offset the log assigned is what clients see.
 */
const samePayload = (left: string, right: string): boolean =>
  stripSequence(left) === stripSequence(right)

const stripSequence = (encoded: string): string =>
  encoded.replace(/"sequence":\d+/, "")

// -- Live fan-out --------------------------------------------------------------------

/** One PubSub per session, created on first use; shared by both stores. */
const makeBuses = Effect.map(
  Ref.make(new Map<string, PubSub.PubSub<AgentEvent.AgentEventEnvelope>>()),
  (buses) => (sessionId: string) =>
    Effect.flatMap(Ref.get(buses), (all) =>
      Option.fromNullishOr(all.get(sessionId)).pipe(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            Effect.flatMap(
              PubSub.unbounded<AgentEvent.AgentEventEnvelope>(),
              (bus) =>
                // Another fibre may have raced to create one; the first
                // registered wins, so every subscriber shares a bus.
                Ref.modify(buses, (current) => {
                  const existing = current.get(sessionId)
                  return existing === undefined
                    ? [bus, new Map(current).set(sessionId, bus)]
                    : [existing, current]
                })
            )
        })
      )
    )
)

type Staged =
  | AppendOutcome
  | {
      readonly _tag: "Pending"
      readonly stored: AgentEvent.AgentEventEnvelope
      readonly sequence: number
    }

// -- Memory implementation ---------------------------------------------------------

interface Entry {
  readonly key: string
  /** The form the recorder offered, for conflict comparison. */
  readonly offered: string
  readonly envelope: AgentEvent.AgentEventEnvelope
}

/**
 * An in-process delivery log.
 *
 * The same semantics as the SQL log — keyed dedupe, conflict detection, a
 * session-wide offset — over a `Ref`. It dies with the process, which suits
 * tests and single-node development; `live` only reaches subscribers in this
 * process either way.
 */
export const memoryLog: Effect.Effect<DeliveryLog> =
  Effect.gen(function* () {
    const sessions = yield* Ref.make(new Map<string, ReadonlyArray<Entry>>())
    const busFor = yield* makeBuses

    /**
     * `PubSub.subscribe` is the establishing step: it registers the subscriber
     * before returning, so every later publication is held for it. Compare
     * `Stream.fromPubSub`, which registers on the first pull.
     */
    const subscribe = (sessionId: string) =>
      Effect.map(
        Effect.flatMap(busFor(sessionId), PubSub.subscribe),
        (subscription): Stream.Stream<AgentEvent.AgentEventEnvelope, StorageError> =>
          Stream.fromSubscription(subscription)
      )

    return {
      append: (sessionId, key, envelope) =>
        Effect.gen(function* () {
          const offered = yield* encodeEnvelope(envelope)
          const outcome = yield* Ref.modify(
            sessions,
            (all): [Staged, Map<string, ReadonlyArray<Entry>>] => {
              const entries = all.get(sessionId) ?? []
              const existing = entries.find((entry) => entry.key === key)
              if (existing !== undefined) {
                return [
                  samePayload(existing.offered, offered)
                    ? { _tag: "Duplicate" }
                    : { _tag: "Conflict" },
                  all
                ]
              }
              const sequence = entries.length + 1
              const stored = AgentEvent.toWire({ ...envelope, sequence })
              return [
                { _tag: "Pending", stored, sequence },
                new Map(all).set(sessionId, [
                  ...entries,
                  { key, offered, envelope: stored }
                ])
              ]
            }
          )
          if (outcome._tag !== "Pending") return outcome
          const bus = yield* busFor(sessionId)
          yield* PubSub.publish(bus, outcome.stored)
          return { _tag: "Appended", sequence: outcome.sequence } as const
        }).pipe(
          /**
           * Committing and publishing are one step, or neither.
           *
           * The commit happens inside `Ref.modify` and the publication after
           * it. An interruption in that gap left `read` holding the event
           * while every existing `live` subscriber never saw it -- and
           * retrying returns `Duplicate` without republishing, so the gap was
           * permanent for this implementation. (The SQL one polls, which
           * happens to heal it; that is luck rather than design, and it is
           * made uninterruptible too.)
           *
           * Uninterruptible rather than restructured around a cursor: the
           * span is a `Ref` update and a publish to an unbounded PubSub,
           * neither of which blocks, so atomicity costs nothing here and gives
           * up no cancellation a caller could notice.
           */
          Effect.uninterruptible
        ),

      live: (sessionId) => Stream.unwrap(subscribe(sessionId)),

      subscribe,

      read: (sessionId, options) =>
        Effect.map(Ref.get(sessions), (all) => {
          const after = options?.after ?? 0
          return (all.get(sessionId) ?? [])
            .map((entry) => entry.envelope)
            .filter((envelope) => envelope.sequence > after)
        })
    }
  })

/**
 * Every log operation's failure, named.
 *
 * The same shape `DurableSessionStore` uses: a driver error or an already-typed
 * `StorageError` becomes one `StorageError` carrying the operation and session,
 * with an existing one passed through so the innermost description survives.
 */
const storage =
  (operation: string, sessionId?: string) =>
  <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, StorageError> =>
    Effect.mapError(effect, (cause): StorageError =>
      isStorageError(cause)
        ? cause
        : new StorageError({
            operation,
            ...(sessionId === undefined ? {} : { sessionId }),
            detail: detailOf(cause)
          })
    )

// -- SQL implementation --------------------------------------------------------------

export const sqlLogTable = "effect_agent_delivery"

const escapeIdentifier = (name: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    // Table names reach `sql.literal`, which does not parameterise.
    throw new Error(`Invalid table name: ${name}`)
  }
  return name
}

/**
 * A delivery log backed by SQL.
 *
 * The table needs `session_id`, a per-session `sequence`, an `event_key`
 * unique within the session, and the encoded `payload`; see
 * `sqlLogWithTable` for the exact shape. Appends run in one transaction so the
 * offset is allocated and the row inserted as a unit, and the uniqueness
 * constraint on `(session_id, event_key)` is what makes a lost race between
 * two recorders a duplicate rather than a second row.
 *
 * `live` fans out only within this process: a subscriber on another node sees
 * the row, not the publish. Cross-node live delivery is a transport's concern
 * and sits above this log — `read({ after })` is the cursor it resumes from.
 */
export const sqlLog = (
  options?: {
    readonly table?: string | undefined
    readonly pollInterval?: Duration.Duration | undefined
  }
): Effect.Effect<DeliveryLog, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = sql.literal(escapeIdentifier(options?.table ?? sqlLogTable))
    const busFor = yield* makeBuses
    const pollInterval = options?.pollInterval ?? Duration.millis(250)

    /**
     * Establishing a subscription here is capturing the cursor.
     *
     * There is no live channel to register with -- delivery is a poll -- so
     * what has to happen before this returns is fixing the point the poll
     * starts from. Reading `MAX(sequence)` now means every later row is above
     * it and will be delivered, so a caller that reads history afterwards
     * cannot fall into a gap: rows at or below the cursor are in the history,
     * rows above it come from the poll, and rows written in between appear in
     * both. The wake channel carries no data for exactly this reason.
     */
    const subscribe = (sessionId: string) =>
      Effect.gen(function* () {
        const bus = yield* busFor(sessionId)
        const start = yield* sql<{ readonly max: number | null }>`SELECT MAX(sequence) AS max FROM ${table} WHERE session_id = ${sessionId}`.pipe(
          storage("live", sessionId),
          Effect.map((rows) => Number(rows[0]?.max ?? 0))
        )
        // Neither wake signal carries data: every delivery comes from the
        // poll, so nothing is duplicated and nothing depends on the local
        // publish arriving. The publish just makes the next poll immediate.
        const wake = Stream.merge(
          Stream.fromPubSub(bus).pipe(Stream.map(() => undefined)),
          Stream.tick(pollInterval)
        )
        return wake.pipe(
          Stream.mapAccumEffect(
            () => start,
            (cursor: number) =>
              sql<{ readonly payload: string }>`SELECT payload FROM ${table} WHERE session_id = ${sessionId} AND sequence > ${cursor} ORDER BY sequence`.pipe(
                storage("live", sessionId),
                Effect.flatMap((rows) =>
                  Effect.forEach(rows, (row) =>
                    decodeEnvelope(row.payload, sessionId)
                  )
                ),
                Effect.map((events): readonly [number, ReadonlyArray<AgentEvent.AgentEventEnvelope>] => [
                  events.length > 0 ? events[events.length - 1]!.sequence : cursor,
                  events
                ])
              )
          )
        )
      })

    return {
      append: (sessionId, key, envelope) =>
        Effect.gen(function* () {
          const offered = yield* encodeEnvelope(envelope)
          const outcome = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const existing = yield* sql<{
                  readonly offered: string
                }>`SELECT offered FROM ${table} WHERE session_id = ${sessionId} AND event_key = ${key}`
                if (existing.length > 0) {
                  return samePayload(existing[0]!.offered, offered)
                    ? ({ _tag: "Duplicate" } as const)
                    : ({ _tag: "Conflict" } as const)
                }
                const last = yield* sql<{
                  readonly max: number | null
                }>`SELECT MAX(sequence) AS max FROM ${table} WHERE session_id = ${sessionId}`
                const sequence = Number(last[0]?.max ?? 0) + 1
                const stored = AgentEvent.toWire({ ...envelope, sequence })
                const payload = yield* encodeEnvelope(stored)
                yield* sql`INSERT INTO ${table} ${sql.insert({
                  session_id: sessionId,
                  sequence,
                  event_key: key,
                  offered,
                  payload
                })}`
                return { _tag: "Pending", stored, sequence } as const
              })
            )
            .pipe(storage("append", sessionId))
          if (outcome._tag !== "Pending") return outcome
          const bus = yield* busFor(sessionId)
          yield* PubSub.publish(bus, outcome.stored)
          return { _tag: "Appended", sequence: outcome.sequence } as const
        }).pipe(
          // The same commit-and-publish atomicity as the memory log above.
          // Polling readers recover from a missed publication here, but a
          // `live` subscriber attached before the append does not, and
          // "another mechanism happens to cover it" is not the guarantee to
          // rely on.
          Effect.uninterruptible
        ),

      live: (sessionId) => Stream.unwrap(subscribe(sessionId)),

      subscribe,

      read: (sessionId, options) =>
        sql<{
          readonly payload: string
        }>`SELECT payload FROM ${table} WHERE session_id = ${sessionId} AND sequence > ${options?.after ?? 0} ORDER BY sequence`.pipe(
          storage("read", sessionId),
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) => decodeEnvelope(row.payload, sessionId))
          )
        )
    }
  })

/** As `sqlLog`, but creates the table first if it is not there. */
export const sqlLogWithTable = (
  options?: {
    readonly table?: string | undefined
    readonly pollInterval?: Duration.Duration | undefined
  }
): Effect.Effect<DeliveryLog, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = sql.literal(escapeIdentifier(options?.table ?? sqlLogTable))
    yield* sql`CREATE TABLE IF NOT EXISTS ${table} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_key TEXT NOT NULL,
      offered TEXT NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE (session_id, event_key),
      UNIQUE (session_id, sequence)
    )`.pipe(Effect.orDie)
    return yield* sqlLog(options)
  })
