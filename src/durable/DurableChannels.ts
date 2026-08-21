import { Effect, Ref, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { SqlClient } from "effect/unstable/sql"
import { Activity, WorkflowEngine } from "effect/unstable/workflow"
import type * as InputChannel from "../InputChannel.js"

/**
 * Steering and follow-up input, persisted per drain.
 *
 * This is the seam PLAN §16.2 exists for. A durable replay returns persisted
 * model and tool results, so a turn re-derives the prompt it derived the first
 * time — unless it drains a queue, which on replay is empty. The turn would
 * then derive a *different* prompt from the one whose model result is being
 * replayed, and canonical history would silently diverge from the journal.
 *
 * Making each drain an `Activity` fixes the batch a turn consumed, so replay
 * hands back the same one.
 */

/**
 * The offered-input side, which lives outside the workflow.
 *
 * Input arrives out-of-band — from an HTTP handler, a cluster message — and
 * must survive until the workflow drains it. The backing store is supplied by
 * the caller so that this module does not dictate one; `memoryStore` is enough
 * for a single process, and a cluster deployment substitutes a shared store.
 *
 * Values are JSON-encoded prompts rather than `Prompt` objects, so any
 * key-value store can back this without knowing anything about Effect AI.
 * Encoding happens in `factory` below.
 */
export interface Store {
  readonly offer: (key: string, input: string) => Effect.Effect<void>
  readonly takeAll: (key: string) => Effect.Effect<ReadonlyArray<string>>
  readonly size: (key: string) => Effect.Effect<number>
}

/**
 * An in-process store. Suitable for tests and single-node development.
 *
 * Note what is and is not durable here. Each *drain* is journalled as an
 * activity, so replay is consistent — a resumed turn sees the batch it
 * originally consumed. But input that was offered and not yet drained lives
 * only in this map, so it does not survive a restart. A deployment that must
 * not lose queued steering needs a shared, persistent `Store`.
 */
export const memoryStore: Effect.Effect<Store> = Effect.map(
  Ref.make(new Map<string, Array<string>>()),
  (ref): Store => ({
    offer: (key, input) =>
      Ref.update(ref, (map) => {
        const next = new Map(map)
        next.set(key, [...(next.get(key) ?? []), input])
        return next
      }),
    takeAll: (key) =>
      Ref.modify(ref, (map) => {
        const pending = map.get(key) ?? []
        if (pending.length === 0) return [pending, map]
        const next = new Map(map)
        next.set(key, [])
        return [pending, next]
      }),
    size: (key) => Ref.get(ref).pipe(Effect.map((m) => (m.get(key) ?? []).length))
  })
)

const inputs = Schema.Array(Schema.String)

/**
 * Where a session publishes whether it is accepting out-of-band input.
 *
 * Defined here rather than in `DurableAgent` because the channel factory is
 * what keeps it current: the session tells the factory when its gate moves.
 */
export const openKey = (sessionId: string): string => `${sessionId}:open`

/**
 * Offer input from outside the workflow.
 *
 * Out-of-band senders must use this rather than writing to the store directly,
 * so that what they write is encoded the same way the channel expects to read
 * it.
 */
export const offer = (
  store: Store,
  sessionId: string,
  name: "steering" | "followUps",
  input: Prompt.RawInput
): Effect.Effect<void> =>
  Effect.flatMap(encodePrompt(Prompt.make(input)), (encoded) =>
    store.offer(`${sessionId}:${name}`, encoded)
  )

/** Prompts cross the store as JSON; an unencodable prompt is a bug, not a case. */
const encodePrompt = (prompt: Prompt.Prompt): Effect.Effect<string> =>
  Schema.encodeEffect(Prompt.Prompt)(prompt).pipe(
    Effect.map((encoded) => JSON.stringify(encoded)),
    Effect.orDie
  )

const decodePrompt = (encoded: string): Effect.Effect<Prompt.Prompt> =>
  Effect.try(() => JSON.parse(encoded) as unknown).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Prompt.Prompt)),
    Effect.orDie
  )

/**
 * Build channels whose drains are activities.
 *
 * `drainIndex` makes each drain's activity name unique and replay-stable. The
 * channel is not told the current run and turn — it is constructed once per
 * session — so the ordinal of the drain is used instead. That is sound because
 * drains happen in a fixed order within a submission: one per turn boundary.
 */
export const factory = (
  store: Store
): Effect.Effect<
  InputChannel.Factory,
  never,
  WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function* () {
    const workflowContext = yield* Effect.context<
      WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
    >()

    return {
      // The published half of admission. The session drives this at the exact
      // moment its own gate moves, so an out-of-process `followUp` sees the
      // same answer an in-process one would.
      setAdmitting: (sessionId, admitting) =>
        admitting
          ? store.offer(openKey(sessionId), "open")
          : Effect.asVoid(store.takeAll(openKey(sessionId))),
      make: (sessionId, name) =>
        Effect.map(Ref.make(0), (drainIndex): InputChannel.InputChannel => {
          const key = `${sessionId}:${name}`
          return {
            offer: (input) =>
              Effect.flatMap(encodePrompt(input), (encoded) =>
                store.offer(key, encoded)
              ),
            size: store.size(key),
            drain: Effect.gen(function* () {
              const index = yield* Ref.getAndUpdate(drainIndex, (n) => n + 1)
              const encoded = yield* Activity.make({
                name: `${name}-drain-${index}`,
                success: inputs,
                execute: store.takeAll(key)
              }).pipe(Effect.provide(workflowContext))

              // Decoding after the activity keeps the journalled value in its
              // wire form, which is what makes the drain replayable.
              return yield* Effect.forEach(encoded, decodePrompt)
            })
          }
        })
    }
  })

/**
 * A store backed by SQL, for deployments with more than one node.
 *
 * `memoryStore` is a map in one process. Under the cluster that is silently
 * wrong rather than merely limited: `steer` is routed to whichever node the
 * caller reached, and the submission it is aimed at is running on the node that
 * owns the session's shard. The steering is written to one process's map and
 * drained from another's, so it is accepted and never seen. Nothing fails; the
 * input simply disappears.
 *
 * Any deployment already has a `SqlClient` — `ClusterWorkflowEngine` needs one
 * for its journal — so this adds no dependency beyond what is present.
 *
 * `make` creates the table if it is absent, which suits development. A
 * deployment that manages its own schema can create the table itself and use
 * `sqlStore` directly.
 */
export const sqlStoreTable = "effect_agent_channel_input"

const escapeIdentifier = (name: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    // Table names reach `sql.literal`, which does not parameterise. Anything
    // that is not a plain identifier is refused rather than quoted: a store
    // whose table name came from somewhere untrusted is a bug worth failing on.
    throw new Error(`Invalid table name: ${name}`)
  }
  return name
}

/**
 * Build a SQL-backed store over an existing table.
 *
 * The table needs an auto-incrementing `id`, a `channel_key` text column, and a
 * `value` text column. `id` is what preserves FIFO order, which callers depend
 * on: follow-ups run in the order they were queued.
 */
export const sqlStore = (
  options?: { readonly table?: string | undefined }
): Effect.Effect<Store, never, SqlClient.SqlClient> =>
  Effect.map(SqlClient.SqlClient, (sql) => {
    const table = sql.literal(escapeIdentifier(options?.table ?? sqlStoreTable))
    return {
      offer: (key, input) =>
        sql`INSERT INTO ${table} ${sql.insert({ channel_key: key, value: input })}`.pipe(
          Effect.asVoid,
          // A store failure is not a case a caller can act on: the alternative
          // is a typed error on every `offer` in the library.
          Effect.orDie
        ),
      takeAll: (key) =>
        // One transaction, because a drain that read rows and then deleted them
        // separately would lose anything offered in between — and losing
        // accepted input is exactly what this module exists to prevent.
        sql
          .withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql<{
                readonly id: number
                readonly value: string
              }>`SELECT id, value FROM ${table} WHERE channel_key = ${key} ORDER BY id`
              if (rows.length > 0) {
                yield* sql`DELETE FROM ${table} WHERE ${sql.in(
                  "id",
                  rows.map((row) => row.id)
                )}`
              }
              return rows.map((row) => row.value)
            })
          )
          .pipe(Effect.orDie),
      size: (key) =>
        sql<{
          readonly count: number
        }>`SELECT COUNT(*) AS count FROM ${table} WHERE channel_key = ${key}`.pipe(
          Effect.map((rows) => Number(rows[0]?.count ?? 0)),
          Effect.orDie
        )
    }
  })

/** As `sqlStore`, but creates the table first if it is not there. */
export const sqlStoreWithTable = (
  options?: { readonly table?: string | undefined }
): Effect.Effect<Store, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = sql.literal(escapeIdentifier(options?.table ?? sqlStoreTable))
    yield* sql`CREATE TABLE IF NOT EXISTS ${table} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_key TEXT NOT NULL,
      value TEXT NOT NULL
    )`.pipe(Effect.orDie)
    yield* sql`CREATE INDEX IF NOT EXISTS ${sql.literal(
      `${escapeIdentifier(options?.table ?? sqlStoreTable)}_key`
    )} ON ${table} (channel_key, id)`.pipe(Effect.orDie)
    return yield* sqlStore(options)
  })
