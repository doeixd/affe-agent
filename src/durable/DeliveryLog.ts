import { Effect, Option, PubSub, Ref, Schema, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import * as AgentEvent from "../AgentEvent.js"

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
  ) => Effect.Effect<AppendOutcome>

  /** Events accepted after this subscription begins. Never ends. */
  readonly live: (
    sessionId: string
  ) => Stream.Stream<AgentEvent.AgentEventEnvelope>

  /** Everything recorded for the session above `after`, in sequence order. */
  readonly read: (
    sessionId: string,
    options?: { readonly after?: number | undefined }
  ) => Effect.Effect<ReadonlyArray<AgentEvent.AgentEventEnvelope>>
}

// -- Encoding ----------------------------------------------------------------------

/**
 * Envelopes cross storage as JSON of the *wire* projection; an unencodable
 * envelope is a bug in the recorder, not a case a caller handles.
 */
// The JSON codec, not the in-memory declaration: `Option` fields need their
// explicit JSON form to survive text storage, as the SSE adapter also found.
const EnvelopeJson = Schema.toCodecJson(AgentEvent.AgentEventEnvelope)

export const encodeEnvelope = (
  envelope: AgentEvent.AgentEventEnvelope
): Effect.Effect<string> =>
  Schema.encodeEffect(EnvelopeJson)(AgentEvent.toWire(envelope)).pipe(
    Effect.map((encoded) => JSON.stringify(encoded)),
    Effect.orDie
  )

export const decodeEnvelope = (
  encoded: string
): Effect.Effect<AgentEvent.AgentEventEnvelope> =>
  Effect.try(() => JSON.parse(encoded) as unknown).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(EnvelopeJson)),
    Effect.orDie
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
          return { _tag: "Appended", sequence: outcome.sequence }
        }),

      live: (sessionId) =>
        Stream.unwrap(Effect.map(busFor(sessionId), Stream.fromPubSub)),

      read: (sessionId, options) =>
        Effect.map(Ref.get(sessions), (all) => {
          const after = options?.after ?? 0
          return (all.get(sessionId) ?? [])
            .map((entry) => entry.envelope)
            .filter((envelope) => envelope.sequence > after)
        })
    }
  })

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
  options?: { readonly table?: string | undefined }
): Effect.Effect<DeliveryLog, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = sql.literal(escapeIdentifier(options?.table ?? sqlLogTable))
    const busFor = yield* makeBuses

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
            .pipe(Effect.orDie)
          if (outcome._tag !== "Pending") return outcome
          const bus = yield* busFor(sessionId)
          yield* PubSub.publish(bus, outcome.stored)
          return { _tag: "Appended", sequence: outcome.sequence }
        }),

      live: (sessionId) =>
        Stream.unwrap(Effect.map(busFor(sessionId), Stream.fromPubSub)),

      read: (sessionId, options) =>
        sql<{
          readonly payload: string
        }>`SELECT payload FROM ${table} WHERE session_id = ${sessionId} AND sequence > ${options?.after ?? 0} ORDER BY sequence`.pipe(
          Effect.orDie,
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) => decodeEnvelope(row.payload))
          )
        )
    }
  })

/** As `sqlLog`, but creates the table first if it is not there. */
export const sqlLogWithTable = (
  options?: { readonly table?: string | undefined }
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
