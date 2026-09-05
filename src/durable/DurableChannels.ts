import { Effect, Ref, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { SqlClient } from "effect/unstable/sql"
import { Activity, WorkflowEngine } from "effect/unstable/workflow"
import type * as InputChannel from "../InputChannel.js"
import { isStorageError, StorageError } from "../Errors.js"
import * as PromptWire from "../PromptWire.js"
import { detailOf } from "../internal/detail.js"
import { escapeIdentifier } from "../internal/sqlIdentifier.js"
import * as Namespace from "../internal/namespace.js"

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
  readonly offer: (key: string, input: string) => Effect.Effect<void, StorageError>
  readonly takeAll: (
    key: string
  ) => Effect.Effect<ReadonlyArray<string>, StorageError>
  readonly size: (key: string) => Effect.Effect<number, StorageError>
  /**
   * Offer input, but only if the gate key currently holds something.
   *
   * This is the durable counterpart of core's `Session.inputGate`. Admission
   * checked and the input written as two operations is exactly the race core
   * fixed: a sender that read an open marker could have its write land after
   * the submission's closing drain had already looked — accepted by the
   * caller, discarded on release. The check and the insert must be one step
   * the store cannot split, which is why this lives on `Store` rather than
   * being composed from `size` and `offer` here.
   *
   * Returns whether the input was admitted.
   */
  readonly offerIfOpen: (
    key: string,
    input: string,
    gateKey: string
  ) => Effect.Effect<boolean, StorageError>
}

/**
 * An in-process store. Suitable for tests and single-node development.
 *
 * Note what is and is not durable here. Each *drain* is journalled as an
 * activity, so replay is consistent — a resumed turn sees the batch it
 * originally consumed. But input that was offered and not yet drained lives
 * only in this map, so it does not survive a restart.
 *
 * Under the cluster it is worse than that, and silently so: `steer` is routed
 * to whichever node the caller reached, while the submission it targets runs on
 * the node owning the session's shard. The input is written to one process's
 * map and drained from another's, so it is accepted and never seen. Use
 * `sqlStore` for anything beyond a single process.
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
    size: (key) => Ref.get(ref).pipe(Effect.map((m) => (m.get(key) ?? []).length)),
    // Both keys live in one map behind one `Ref`, so the check and the insert
    // are a single `modify`: no other writer can observe or interleave with
    // the gap between them.
    offerIfOpen: (key, input, gateKey) =>
      Ref.modify(ref, (map) => {
        if ((map.get(gateKey) ?? []).length === 0) return [false, map]
        const next = new Map(map)
        next.set(key, [...(next.get(key) ?? []), input])
        return [true, next]
      })
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
export const steeringOpenKey = (sessionId: string): string =>
  `${sessionId}:steering:open`

/**
 * Where a submission that has been acknowledged but not yet dispatched waits.
 *
 * An outbox, in the ordinary sense. A caller that has been handed an execution
 * id believes work has started, and the entity cannot make that true
 * synchronously -- dispatch routes back through the runner that is executing
 * the handler, so awaiting it deadlocks. Writing the intent here *before*
 * replying is what makes the acknowledgement honest: whatever happens to the
 * process afterwards, the submission is recorded somewhere durable and a later
 * pass can carry it forward.
 *
 * Cleared once dispatch has landed. A row still here after that is a dispatch
 * that never happened, not one in flight -- see `AgentEntity.submit`.
 */
export const dispatchKey = (sessionId: string): string => `${sessionId}:dispatch`

/** Record a submission owed a dispatch. Durable before the caller is told. */
/**
 * What a recorded dispatch holds: the prompt, and a typed input's encoded
 * value when the agent declares one. Rows written before the value existed
 * are the encoded prompt alone, and still read.
 */
export interface PendingDispatch {
  readonly prompt: Prompt.Prompt
  readonly input?: unknown
}

const PendingDispatchRecord = Schema.TaggedStruct("PendingDispatch", {
  prompt: Schema.String,
  input: Schema.optional(Schema.Unknown)
})

export const recordPendingDispatch = (
  store: Store,
  sessionId: string,
  dispatch: PendingDispatch
): Effect.Effect<void, StorageError> =>
  Effect.flatMap(encodePrompt(dispatch.prompt), (prompt) =>
    store.offer(
      dispatchKey(sessionId),
      JSON.stringify({
        _tag: "PendingDispatch",
        prompt,
        ...(dispatch.input === undefined ? {} : { input: dispatch.input })
      })
    ))

const decodePendingDispatch = (encoded: string): Effect.Effect<PendingDispatch, StorageError> =>
  Effect.try(() => JSON.parse(encoded) as unknown).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PendingDispatchRecord)),
    Effect.matchEffect({
      // A row from before the record existed: the encoded prompt alone.
      onFailure: () => Effect.map(decodePrompt(encoded), (prompt): PendingDispatch => ({ prompt })),
      onSuccess: (record) =>
        Effect.map(decodePrompt(record.prompt), (prompt): PendingDispatch =>
          record.input === undefined ? { prompt } : { prompt, input: record.input })
    })
  )

/**
 * Take everything owed a dispatch, oldest first.
 *
 * Draining rather than peeking: whoever takes these owes the dispatch, and
 * leaving them in place would let two passes carry the same submission
 * forward. Dispatch is idempotent -- the execution id is derived from the
 * session, so the engine answers a repeat with the execution it already has --
 * so taking them and then failing costs at most a submission that a later
 * caller re-records, which is the direction to be wrong in.
 */
export const takePendingDispatches = (
  store: Store,
  sessionId: string
): Effect.Effect<ReadonlyArray<PendingDispatch>, StorageError> =>
  Effect.flatMap(store.takeAll(dispatchKey(sessionId)), (encoded) =>
    Effect.forEach(encoded, decodePendingDispatch))

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
): Effect.Effect<void, StorageError> =>
  Effect.flatMap(encodePrompt(Prompt.make(input)), (encoded) =>
    store.offer(`${sessionId}:${name}`, encoded)
  )

/**
 * Offer out-of-band input, admitted atomically against the session's marker.
 *
 * The whole admission contract lives in this one step: the marker is checked
 * and the input written as a single store operation, so a submission that is
 * closing its input either sees the write in its closing drain or the sender
 * is refused outright. There is no third outcome — which is what separates
 * this from reading `openKey` and then calling `offer`.
 */
export const offerIfAdmitting = (
  store: Store,
  sessionId: string,
  name: "steering" | "followUps",
  input: Prompt.RawInput,
  marker = openKey(sessionId)
): Effect.Effect<boolean, StorageError> =>
  Effect.flatMap(encodePrompt(Prompt.make(input)), (encoded) =>
    store.offerIfOpen(`${sessionId}:${name}`, encoded, marker)
  )

/**
 * Prompts cross the store through the JSON-safe `PromptWire` codec; an
 * unencodable prompt is a bug, not a case.
 *
 * Encoding stays a defect for the reason `StorageError` gives: the value was
 * built by this process, so a schema that cannot encode it is a bug here.
 */
const encodePrompt = (prompt: Prompt.Prompt): Effect.Effect<string> =>
  Schema.encodeEffect(PromptWire.Prompt)(prompt).pipe(
    Effect.map((encoded) => JSON.stringify(encoded)),
    Effect.orDie
  )

/**
 * Decoding is steering or follow-up input coming *back* out of the store, so it
 * can be a truncated write or a row from an older schema -- conditions, not
 * bugs. D1 makes this one matter more than it looks: input reported as accepted
 * must be executed or its failure reported, and a defect while draining is
 * neither.
 */
const decodePrompt = (
  encoded: string
): Effect.Effect<Prompt.Prompt, StorageError> =>
  Effect.try(() => JSON.parse(encoded) as unknown).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PromptWire.Prompt)),
    Effect.mapError(
      (cause) =>
        new StorageError({ operation: "decodePrompt", detail: detailOf(cause) })
    )
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
  store: Store,
  options?: { readonly prefix?: string | undefined }
): Effect.Effect<
  InputChannel.Factory,
  never,
  WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function* () {
    const workflowContext = yield* Effect.context<
      WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
    >()
    const instance = yield* WorkflowEngine.WorkflowInstance

    return {
      // The published half of admission. The session drives this at the exact
      // moment its own gate moves, so an out-of-process `followUp` sees the
      // same answer an in-process one would.
      //
      // `orDie` here is the third triage bucket, for the fourth time:
      // `InputChannel.Factory` is a *core* seam declaring `Effect<void>`, and
      // widening it so a durable channel can report a store failure would push
      // durability into the kernel. It is also the outcome we want. A stale
      // marker is precisely the failure this hook exists to prevent -- the
      // comment on `Factory.setAdmitting` describes it: input accepted for as
      // long as the published marker is wrong, then discarded on release. D1
      // says accepting and dropping is never allowed, so failing loudly beats
      // publishing a marker we could not write.
      setAdmitting: (sessionId, admitting) =>
        Effect.orDie(
          admitting
            ? store.offer(openKey(sessionId), "open")
            : Effect.asVoid(store.takeAll(openKey(sessionId)))
        ),
      setSteeringAdmitting: (sessionId, admitting) =>
        Effect.orDie(
          admitting
            ? store.offer(steeringOpenKey(sessionId), "open")
            : Effect.asVoid(store.takeAll(steeringOpenKey(sessionId)))
        ),
      make: (sessionId, name) =>
        Effect.map(Ref.make(0), (drainIndex): InputChannel.InputChannel => {
          const key = `${sessionId}:${name}`
          return {
            // Same seam, same reason: `InputChannel` declares no error.
            offer: (input) =>
              Effect.orDie(
                Effect.flatMap(encodePrompt(input), (encoded) =>
                  store.offer(key, encoded)
                )
              ),
            size: Effect.orDie(store.size(key)),
            // `InputChannel.drain` declares no error, so the seam constraint
            // applies here too. A drain that cannot read its own journalled
            // batch has lost accepted input, which D1 forbids silently: dying
            // is the loud version, and `isInfrastructure` classifies it.
            drain: Effect.suspend(() => instance.suspended
              // `AgentSession.release` drains queues as cleanup. A workflow
              // suspension also releases that process-local session, but its
              // queued input is still owed to the resumed session. Consuming
              // it here would acknowledge a steer or follow-up and then drop
              // it before the peer can rebuild canonical history.
              ? Effect.succeed([])
              : Effect.orDie(Effect.gen(function* () {
              const index = yield* Ref.getAndUpdate(drainIndex, (n) => n + 1)
              const encoded = yield* Activity.make({
                name: `${options?.prefix ?? ""}${name}-drain-${index}`,
                success: inputs,
                // A store failure here is declared, not a defect: the drain is
                // journalled, so it crosses as a value and a resumed run sees
                // what the original saw.
                error: StorageError,
                execute: store.takeAll(key)
              }).pipe(Effect.provide(workflowContext))

              // Decoding after the activity keeps the journalled value in its
              // wire form, which is what makes the drain replayable.
              return yield* Effect.forEach(encoded, decodePrompt)
            })))
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
export const sqlStoreTable = Namespace.table("channel_input")

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

    /** Every channel operation's failure, named. As `DurableSessionStore`. */
    const storage =
      (operation: string, key?: string) =>
      <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, StorageError> =>
        Effect.mapError(effect, (cause): StorageError =>
          isStorageError(cause)
            ? cause
            : new StorageError({
                operation,
                detail: key === undefined ? detailOf(cause) : `${key}: ${detailOf(cause)}`
              })
        )

    return {
      offer: (key, input) =>
        sql`INSERT INTO ${table} ${sql.insert({ channel_key: key, value: input })}`.pipe(
          Effect.asVoid,
          // A store failure is not a case a caller can act on: the alternative
          // is a typed error on every `offer` in the library.
          storage("offer", key)
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
          .pipe(storage("takeAll", key)),
      size: (key) =>
        sql<{
          readonly count: number
        }>`SELECT COUNT(*) AS count FROM ${table} WHERE channel_key = ${key}`.pipe(
          Effect.map((rows) => Number(rows[0]?.count ?? 0)),
          storage("size", key)
        ),
      offerIfOpen: (key, input, gateKey) =>
        // One transaction, for the same reason `takeAll` is: the check and the
        // insert must not be separable, or a marker cleared between them
        // accepts input the closing drain will never see.
        sql
          .withTransaction(
            Effect.gen(function* () {
              const open = yield* sql<{ readonly id: number }>`
                SELECT id FROM ${table} WHERE channel_key = ${gateKey} LIMIT 1
              `
              if (open.length === 0) return false
              yield* sql`INSERT INTO ${table} ${sql.insert(
                { channel_key: key, value: input }
              )}`
              return true
            })
          )
          .pipe(storage("offerIfOpen", key))
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
