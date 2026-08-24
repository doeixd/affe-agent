import { Context, Effect, Layer, Option, Ref, Schema, Semaphore, Stream, SubscriptionRef } from "effect"
import { SqlClient } from "effect/unstable/sql"
import * as ContextTransform from "../ContextTransform.js"
import { isStorageError, StorageError } from "../Errors.js"
import { detailOf } from "../internal/detail.js"

/**
 * Persistent, typed agent state (issue #4).
 *
 * The library keeps no first-class state slot on a session on purpose: "state
 * belongs in ordinary Effect services, so the harness never becomes a
 * competing state-management system" (`internal/state.ts`). This module is the
 * ergonomic form of exactly that -- a typed value a tool handler reads and
 * writes through the requirement channel, optionally surfaced into the prompt
 * by a `ContextTransform`, and optionally persisted through a small store so it
 * outlives the process. It adds nothing to the engine.
 *
 * It is *not* conversation history (that is canonical, owned by the run engine)
 * and it is *not* semantic memory (recall over past turns). It is structured
 * application state: a plan being filled in, a running total, a form, a
 * scratchpad -- the thing a session mutates as it works and wants back next
 * time.
 *
 * ```ts
 * interface Plan { readonly steps: ReadonlyArray<string>; readonly done: number }
 * const Plan = AgentState.Tag<Plan>("app/Plan")
 *
 * const record = Agent.tool(RecordStep, ({ step }) =>
 *   AgentState.update(Plan, (p) => ({ ...p, steps: [...p.steps, step] })).pipe(Effect.as("recorded")))
 *
 * const agent = Agent.make({
 *   tools: [record],
 *   // The model sees the plan each turn, derived, never mutating history.
 *   contextTransform: AgentState.transform(Plan, (p) => `Plan so far: ${p.steps.join("; ")}`)
 * })
 *
 * // Ephemeral: fresh each process.       Persistent: survives restarts, keyed per user.
 * AgentState.layer(Plan, { initial })     AgentState.layer(Plan, { initial, persistence: {
 *                                            schema: PlanSchema, store, key: `plan:${userId}` } })
 * ```
 */

// ---------------------------------------------------------------------------
// The typed state service
// ---------------------------------------------------------------------------

/**
 * A handle to one typed value, readable and writable from anywhere with the
 * service in context -- a tool handler, a context transform, a policy.
 *
 * Every mutation is atomic -- one `SubscriptionRef` step when the state is
 * ephemeral, and a serialized swap-and-persist when the layer has a store --
 * and, with persistence, written through to the store before it returns.
 * `changes` is the live stream for a UI that watches the state move.
 */
/**
 * State of type `A`.
 *
 * Mutations declare `StorageError` because a persisted state writes through to
 * a store on every one, and a store can be unreachable. Reads do not: the value
 * is already in memory.
 *
 * **Ephemeral state never raises it.** That is a deliberate overstatement, and
 * the alternative was worse. Making the error depend on whether `persistence`
 * was supplied means two different types, and then the same agent cannot be
 * run ephemerally in development and persisted in production -- which is
 * exactly what `examples/state.ts` demonstrates, and the property worth
 * keeping. A caller with no store can `Effect.orDie` and move on; a caller
 * with one now learns that its write failed instead of losing the fibre.
 */
export interface AgentState<A> {
  readonly get: Effect.Effect<A>
  readonly set: (value: A) => Effect.Effect<void, StorageError>
  readonly update: (f: (current: A) => A) => Effect.Effect<void, StorageError>
  readonly modify: <B>(
    f: (current: A) => readonly [B, A]
  ) => Effect.Effect<B, StorageError>
  readonly changes: Stream.Stream<A>
}

/**
 * A tag for state of type `A`.
 *
 * A shared `Context` service cannot be generic in `A`, so -- as `AgentSessionHost`
 * does for its principal -- the application makes a tag for its state type once
 * (the string is the runtime identity) and hands it to tools, transforms and
 * the layer alike.
 */
export type Tag<A> = Context.Service<AgentState<A>, AgentState<A>>

/** Make a state tag. Two tags with the same string are the same service. */
export const Tag = <A>(id: string): Tag<A> =>
  Context.Service<AgentState<A>, AgentState<A>>(id)

// ---------------------------------------------------------------------------
// Free accessors, so a tool handler need not yield the service first
// ---------------------------------------------------------------------------

/** Read the current value. */
export const get = <A>(tag: Tag<A>): Effect.Effect<A, never, AgentState<A>> =>
  Effect.flatMap(tag, (state) => state.get)

/** Replace the value. Persists through the store when the layer has one. */
export const set = <A>(
  tag: Tag<A>,
  value: A
): Effect.Effect<void, StorageError, AgentState<A>> =>
  Effect.flatMap(tag, (state) => state.set(value))

/** Update the value with a pure function. */
export const update = <A>(
  tag: Tag<A>,
  f: (current: A) => A
): Effect.Effect<void, StorageError, AgentState<A>> =>
  Effect.flatMap(tag, (state) => state.update(f))

/** Update the value and return something computed from the transition. */
export const modify = <A, B>(
  tag: Tag<A>,
  f: (current: A) => readonly [B, A]
): Effect.Effect<B, StorageError, AgentState<A>> =>
  Effect.flatMap(tag, (state) => state.modify(f))

/** The live stream of values, starting with the current one. */
export const changes = <A>(tag: Tag<A>): Stream.Stream<A, never, AgentState<A>> =>
  Stream.unwrap(Effect.map(tag, (state) => state.changes))

/**
 * A `ContextTransform` that renders the current state into a system message,
 * so the model sees it each turn. Derived only -- canonical history is never
 * touched, which is what makes it safe to recompute every turn.
 */
export const transform = <A>(
  tag: Tag<A>,
  render: (value: A) => string
): ContextTransform.ContextTransform<never, AgentState<A>> =>
  ContextTransform.appendSystem(() => Effect.map(get(tag), render))

// ---------------------------------------------------------------------------
// Persistence: a small key/value store of JSON strings
// ---------------------------------------------------------------------------

/**
 * Where persistent state lives between processes.
 *
 * Values are JSON strings, so any key/value store backs this without knowing
 * anything about the state's shape -- the same choice `DurableSessionStore`
 * makes for prompts. Two methods; implement it over Redis, a KV table or a
 * file in a handful of lines. `memoryStore` and `sqlStore` are provided.
 */
export interface Store {
  readonly load: (
    key: string
  ) => Effect.Effect<Option.Option<string>, StorageError>
  readonly save: (key: string, value: string) => Effect.Effect<void, StorageError>
}

/**
 * An in-process store. Suitable for tests and single-node development; the map
 * dies with the process, so use `sqlStore` (or your own `Store`) for anything
 * that must actually outlive a restart.
 */
export const memoryStore: Effect.Effect<Store> = Effect.map(
  Ref.make(new Map<string, string>()),
  (ref): Store => ({
    load: (key) => Effect.map(Ref.get(ref), (map) => Option.fromNullishOr(map.get(key))),
    save: (key, value) =>
      Ref.update(ref, (map) => new Map(map).set(key, value))
  })
)

export const sqlStoreTable = "effect_agent_state"

const escapeIdentifier = (name: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    // The table name reaches `sql.literal`, which does not parameterise. A name
    // that is not a plain identifier is refused rather than quoted.
    throw new Error(`Invalid table name: ${name}`)
  }
  return name
}

/**
 * A SQL-backed store over any `SqlClient` a deployment already has. One row per
 * key; `save` replaces it in a transaction so a concurrent reader never sees a
 * half-written value. A store failure is a defect, not a case a caller acts on.
 */
export const sqlStore = (
  options?: { readonly table?: string | undefined }
): Effect.Effect<Store, never, SqlClient.SqlClient> =>
  Effect.map(SqlClient.SqlClient, (sql) => {
    const table = sql.literal(escapeIdentifier(options?.table ?? sqlStoreTable))

    /** Every store operation's failure, named. As `DurableSessionStore`. */
    const storage =
      (operation: string, key: string) =>
      <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, StorageError> =>
        Effect.mapError(effect, (cause): StorageError =>
          isStorageError(cause)
            ? cause
            : new StorageError({ operation, detail: `${key}: ${detailOf(cause)}` })
        )

    return {
      load: (key) =>
        sql<{ readonly value: string }>`SELECT value FROM ${table} WHERE state_key = ${key} LIMIT 1`.pipe(
          Effect.map((rows) => Option.fromNullishOr(rows[0]?.value)),
          storage("load", key)
        ),
      save: (key, value) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM ${table} WHERE state_key = ${key}`
              yield* sql`INSERT INTO ${table} ${sql.insert({ state_key: key, value })}`
            })
          )
          .pipe(storage("save", key))
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
      state_key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`.pipe(Effect.orDie)
    return yield* sqlStore(options)
  })

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

/** How a persistent state's value crosses the store. */
export interface Persistence<A, I> {
  /** The codec that turns the value into JSON and back. An unencodable value is a bug. */
  readonly schema: Schema.Codec<A, I>
  readonly store: Store
  /**
   * The key this state lives under. Persistent state is usually per user or
   * per conversation, not per session -- derive it from a trusted id, e.g.
   * `plan:${userId}`, never from unvalidated model output.
   */
  readonly key: string
}

export interface Options<A, I> {
  /** The value a fresh state starts from, and the fallback when nothing is stored. */
  readonly initial: A
  /** Omit for ephemeral state; supply to persist through a store. */
  readonly persistence?: Persistence<A, I> | undefined
}

const encode = <A, I>(schema: Schema.Codec<A, I>, value: A): Effect.Effect<string> =>
  Schema.encodeEffect(schema)(value).pipe(Effect.map((encoded) => JSON.stringify(encoded)), Effect.orDie)

/**
 * Decoding is what the store gives back, so it is a condition, not a bug.
 *
 * The case that matters: persistent state is keyed per user or per conversation
 * and outlives deployments, so meeting a value written by an older schema is
 * ordinary. A caller that sees the failure can migrate or fall back to
 * `initial`; a defect gives it neither option.
 */
const decode = <A, I>(
  schema: Schema.Codec<A, I>,
  encoded: string
): Effect.Effect<A, StorageError> =>
  Effect.try(() => JSON.parse(encoded) as unknown).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(
      (cause) =>
        new StorageError({
          operation: "AgentState.decode",
          detail: detailOf(cause)
        })
    )
  )

/**
 * Build the state service for a tag.
 *
 * Ephemeral by default: `{ initial }` gives a fresh value each process. With
 * `persistence`, the stored value (if any) is loaded at build and every
 * mutation is written through before it returns -- so a later session built
 * with the same key reads back exactly what the last one left. Encoding or
 * decoding failures are defects: the schema must round-trip its own value.
 */
export const layer = <A, I>(
  tag: Tag<A>,
  options: Options<A, I>
// The build itself can fail: loading and decoding the stored value happens
// here, so a store that is unreachable at wiring time says so rather than
// dying. Ephemeral state supplies no store and the channel stays unused.
): Layer.Layer<AgentState<A>, StorageError> =>
  Layer.effect(
    tag,
    Effect.gen(function* () {
      const p = options.persistence
      const stored = p === undefined ? Option.none<string>() : yield* p.store.load(p.key)
      const start = p !== undefined && Option.isSome(stored)
        ? yield* decode(p.schema, stored.value)
        : options.initial

      const ref = yield* SubscriptionRef.make(start)

      const persist: (value: A) => Effect.Effect<void, StorageError> = p === undefined
        ? () => Effect.void
        : (value) => encode(p.schema, value).pipe(Effect.flatMap((json) => p.store.save(p.key, json)))

      // Persistence runs after the ref swap, so two concurrent mutations could
      // each swap the ref in order yet have their stores land out of order,
      // leaving the store holding the older value. When there is a store, a
      // permit serialises swap-and-persist into one critical section so the
      // ref and the store never diverge. Ephemeral state needs no lock: the
      // ref's own modify is already atomic and there is nothing to persist.
      //
      // This cannot become a transaction: STM commits by retrying, and the
      // critical section contains a store write. See
      // `docs/audit-effect-ecosystem.md` E7b.
      const lock = yield* Semaphore.make(1)
      const atomically: <T>(
        effect: Effect.Effect<T, StorageError>
      ) => Effect.Effect<T, StorageError> = p === undefined
        ? (effect) => effect
        : (effect) => lock.withPermits(1)(effect)

      return {
        get: SubscriptionRef.get(ref),
        set: (value) => atomically(Effect.flatMap(SubscriptionRef.set(ref, value), () => persist(value))),
        update: (f) =>
          atomically(
            SubscriptionRef.modify(ref, (current) => {
              const next = f(current)
              return [next, next]
            }).pipe(Effect.flatMap(persist))
          ),
        modify: (f) =>
          atomically(
            SubscriptionRef.modify(ref, (current) => {
              const [result, next] = f(current)
              return [[result, next] as const, next]
            }).pipe(Effect.flatMap(([result, next]) => Effect.as(persist(next), result)))
          ),
        changes: SubscriptionRef.changes(ref)
      } satisfies AgentState<A>
    })
  )
