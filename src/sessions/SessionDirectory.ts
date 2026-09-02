import { Clock, Effect, Option, Ref, Schema, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { AgentEventEnvelope } from "../AgentEvent.js"
import { SessionId, SubmissionId } from "../AgentEvent.js"
import type * as AgentProtocol from "../client/AgentProtocol.js"
import { isStorageError, StorageError } from "../Errors.js"
import { detailOf } from "../internal/detail.js"
import * as SessionProjection from "./SessionProjection.js"

/**
 * The management/query model over sessions.
 *
 * `docs/effect-plan-2.txt` §26: `AgentClient` does the work, a directory
 * discovers and manages it. `get` / `list` / `active` / `stats` / `rename` /
 * `move` / `annotate`, paginated from day one, over a backing store.
 *
 * What this is **not**, and the plan is emphatic on all three:
 *
 * - not `DurableSessionStore`, which holds the minimal state execution needs
 *   to be *correct*. Nothing here is read by a running conversation, so a
 *   dashboard query can never stall one, and losing the directory loses a
 *   listing, never a session.
 * - not `/tree`, which is a conversation DAG.
 * - not `AgentSessionHost.size`, a live count in one process.
 *
 * The record it keeps per session is {@link Entry}: a name, a namespace,
 * free-form attributes, and {@link Stats} -- the countable core of
 * `SessionProjection`, folded from the session's events. The fold is
 * {@link follow}, over the host-wide stream (§29) rather than threaded
 * through every host mutation: the host does not know the directory exists.
 *
 * Two implementations share the interface: {@link memory} for one process,
 * {@link sql} for a deployment. `SessionDirectoryConformance` in `/testing`
 * is what both pass and what a third is held to.
 */

// -- Records ---------------------------------------------------------------------------

const Lifecycle = Schema.Struct({
  started: Schema.Number,
  completed: Schema.Number,
  failed: Schema.Number,
  interrupted: Schema.Number
})

const ToolCalls = Schema.Struct({
  started: Schema.Number,
  succeeded: Schema.Number,
  failed: Schema.Number,
  interrupted: Schema.Number,
  returnedToModel: Schema.Number
})

const Usage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  totalTokens: Schema.Number
})

/**
 * What a directory answers `stats` with: `SessionProjection`'s counts, minus
 * the transient lists (active tool calls, pending elicitations) and the
 * repair bookkeeping, which belong to the fold that produced them.
 *
 * A `Schema` where the projection is a plain interface, because this one
 * *is* persisted: the plan's line is that the projection is derived and a
 * directory that stores it makes the wire decision. This is that decision.
 */
export const Stats = Schema.Struct({
  /** The highest sequence folded, `None` before any event. */
  lastSequence: Schema.Option(Schema.Number),
  started: Schema.Boolean,
  closed: Schema.Boolean,
  activeSubmission: Schema.Option(SubmissionId),
  submissions: Lifecycle,
  runs: Lifecycle,
  turns: Schema.Number,
  modelCalls: Schema.Number,
  usage: Usage,
  messages: Schema.Number,
  tools: ToolCalls,
  /** Discontinuities the fold saw. Non-zero means the counts are a floor. */
  gaps: Schema.Number
})
export type Stats = typeof Stats.Type

/** Stats for a session no event has been folded for yet. */
export const emptyStats: Stats = statsOf(SessionProjection.empty(SessionId.make("")))

/** The persisted core of a projection. Pure. */
export function statsOf(projection: SessionProjection.Projection): Stats {
  return {
    lastSequence: projection.lastSequence,
    started: projection.started,
    closed: projection.closed,
    activeSubmission: projection.activeSubmission,
    submissions: projection.submissions,
    runs: projection.runs,
    turns: projection.turns,
    modelCalls: projection.modelCalls,
    usage: projection.usage,
    messages: projection.messages,
    tools: projection.tools,
    gaps: projection.gaps
  }
}

/**
 * Whether the stats say the session is running work now. The same rule as
 * `SessionProjection.isActive`, on the persisted shape.
 */
export const isActive = (stats: Stats): boolean =>
  !stats.closed && Option.isSome(stats.activeSubmission)

/** Attribute values are strings: a directory is an index, not a document store. */
export const Attributes = Schema.Record(Schema.String, Schema.String)
export type Attributes = typeof Attributes.Type

export const Entry = Schema.Struct({
  sessionId: SessionId,
  /** A human's label. Sessions are born without one. */
  name: Schema.Option(Schema.String),
  /** A grouping key. `""` is the default namespace, so every session is in one. */
  namespace: Schema.String,
  attributes: Attributes,
  stats: Stats,
  /** Epoch milliseconds, from the directory's clock. */
  createdAt: Schema.Number,
  updatedAt: Schema.Number
})
export type Entry = typeof Entry.Type

export const defaultNamespace = ""

// -- Queries ---------------------------------------------------------------------------

export interface Query {
  /** Only this namespace. Omit for every namespace. */
  readonly namespace?: string | undefined
  /** Entries whose `sessionId` sorts after this one. The previous page's `next`. */
  readonly after?: SessionId | undefined
  /** Page size. Default {@link defaultLimit}; never more than {@link maxLimit}. */
  readonly limit?: number | undefined
}

export const defaultLimit = 50
export const maxLimit = 500

export interface Page {
  readonly entries: ReadonlyArray<Entry>
  /** Pass as `after` for the next page; `None` when this was the last. */
  readonly next: Option.Option<SessionId>
}

/** The bounded page size a query asked for. */
export const limitOf = (query: Query | undefined): number => {
  const asked = query?.limit ?? defaultLimit
  if (!Number.isFinite(asked) || asked < 1) return 1
  return Math.min(Math.floor(asked), maxLimit)
}

// -- Errors ----------------------------------------------------------------------------

/**
 * A management operation named a session the directory has no entry for.
 *
 * Distinct from `StorageError`: the store answered, and the answer was "no
 * such row". A caller renaming a session that has not been observed yet is
 * the ordinary way to hit it -- observe it first, or wait for `follow` to.
 */
export class SessionNotIndexed extends Schema.TaggedError<SessionNotIndexed>()(
  "SessionNotIndexed",
  { sessionId: SessionId, operation: Schema.String }
) {
  override get message() {
    return `session ${this.sessionId} is not in the directory (${this.operation})`
  }
}

// -- The interface ---------------------------------------------------------------------

export interface SessionDirectory {
  readonly get: (sessionId: SessionId) => Effect.Effect<Option.Option<Entry>, StorageError>
  /** Every entry, by `sessionId`, one page at a time. */
  readonly list: (query?: Query) => Effect.Effect<Page, StorageError>
  /** As `list`, only the entries whose stats say they are running work now. */
  readonly active: (query?: Query) => Effect.Effect<Page, StorageError>
  readonly stats: (sessionId: SessionId) => Effect.Effect<Option.Option<Stats>, StorageError>

  readonly rename: (
    sessionId: SessionId,
    name: Option.Option<string>
  ) => Effect.Effect<Entry, SessionNotIndexed | StorageError>
  readonly move: (
    sessionId: SessionId,
    namespace: string
  ) => Effect.Effect<Entry, SessionNotIndexed | StorageError>
  /**
   * Merge attributes into the entry's. A `None` value removes the key; the
   * keys not mentioned are untouched.
   */
  readonly annotate: (
    sessionId: SessionId,
    attributes: Record<string, Option.Option<string>>
  ) => Effect.Effect<Entry, SessionNotIndexed | StorageError>

  /**
   * Make sure the session has an entry. Idempotent: an existing entry is
   * returned untouched, so a second observation cannot reset a name.
   */
  readonly observe: (sessionId: SessionId) => Effect.Effect<Entry, StorageError>
  /**
   * Replace the entry's stats, creating the entry if it is missing -- an
   * event for a session is an observation of it.
   */
  readonly record: (sessionId: SessionId, stats: Stats) => Effect.Effect<Entry, StorageError>
}

// -- Shared pure steps -----------------------------------------------------------------

const mergeAttributes = (
  current: Attributes,
  changes: Record<string, Option.Option<string>>
): Attributes => {
  const next: Record<string, string> = { ...current }
  for (const [key, value] of Object.entries(changes)) {
    if (Option.isSome(value)) next[key] = value.value
    else delete next[key]
  }
  return next
}

const fresh = (sessionId: SessionId, now: number): Entry => ({
  sessionId,
  name: Option.none(),
  namespace: defaultNamespace,
  attributes: {},
  stats: emptyStats,
  createdAt: now,
  updatedAt: now
})

/** Keyset pagination over an already-sorted, already-filtered array. */
const page = (sorted: ReadonlyArray<Entry>, query: Query | undefined): Page => {
  const limit = limitOf(query)
  const after = query?.after
  const from = after === undefined ? sorted : sorted.filter((entry) => entry.sessionId > after)
  const entries = from.slice(0, limit)
  const last = entries[entries.length - 1]
  return {
    entries,
    next: from.length > limit && last !== undefined ? Option.some(last.sessionId) : Option.none()
  }
}

const matches = (entry: Entry, query: Query | undefined, onlyActive: boolean): boolean =>
  (query?.namespace === undefined || entry.namespace === query.namespace) &&
  (!onlyActive || isActive(entry.stats))

// -- Memory ----------------------------------------------------------------------------

/**
 * A directory in one process. Every mutation is one `Ref.modify`, so two
 * writers serialise on the reference rather than on discipline.
 */
export const memory: Effect.Effect<SessionDirectory> = Effect.gen(function* () {
  const state = yield* Ref.make<ReadonlyMap<SessionId, Entry>>(new Map())

  const modify = (
    operation: string,
    sessionId: SessionId,
    change: (entry: Entry, now: number) => Entry
  ): Effect.Effect<Entry, SessionNotIndexed> =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.flatMap(
        Ref.modify(state, (all): [Option.Option<Entry>, ReadonlyMap<SessionId, Entry>] => {
          const found = all.get(sessionId)
          if (found === undefined) return [Option.none(), all]
          const next = change(found, now)
          return [Option.some(next), new Map(all).set(sessionId, next)]
        }),
        Option.match({
          onNone: () => Effect.fail(new SessionNotIndexed({ sessionId, operation })),
          onSome: Effect.succeed
        })
      ))

  const upsert = (
    sessionId: SessionId,
    change: (entry: Entry, now: number) => Entry
  ): Effect.Effect<Entry> =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Ref.modify(state, (all): [Entry, ReadonlyMap<SessionId, Entry>] => {
        const found = all.get(sessionId)
        if (found !== undefined) {
          const next = change(found, now)
          return [next, next === found ? all : new Map(all).set(sessionId, next)]
        }
        const created = change(fresh(sessionId, now), now)
        return [created, new Map(all).set(sessionId, created)]
      }))

  const listing = (query: Query | undefined, onlyActive: boolean) =>
    Effect.map(Ref.get(state), (all) =>
      page(
        [...all.values()]
          .filter((entry) => matches(entry, query, onlyActive))
          .sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)),
        query
      ))

  return {
    get: (sessionId) => Effect.map(Ref.get(state), (all) => Option.fromNullishOr(all.get(sessionId))),
    list: (query) => listing(query, false),
    active: (query) => listing(query, true),
    stats: (sessionId) =>
      Effect.map(Ref.get(state), (all) => Option.map(Option.fromNullishOr(all.get(sessionId)), (e) => e.stats)),
    rename: (sessionId, name) => modify("rename", sessionId, (e, now) => ({ ...e, name, updatedAt: now })),
    move: (sessionId, namespace) =>
      modify("move", sessionId, (e, now) => ({ ...e, namespace, updatedAt: now })),
    annotate: (sessionId, attributes) =>
      modify("annotate", sessionId, (e, now) => ({
        ...e,
        attributes: mergeAttributes(e.attributes, attributes),
        updatedAt: now
      })),
    observe: (sessionId) => upsert(sessionId, (e) => e),
    record: (sessionId, stats) => upsert(sessionId, (e, now) => ({ ...e, stats, updatedAt: now }))
  }
})

// -- SQL -------------------------------------------------------------------------------

export const sqlTable = "effect_agent_session_directory"

const escapeIdentifier = (name: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid SQL identifier: ${JSON.stringify(name)}`)
  }
  return `"${name}"`
}

interface Row {
  readonly session_id: string
  readonly name: string | null
  readonly namespace: string
  readonly attributes: string
  readonly stats: string
  readonly active: number | bigint
  readonly created_at: number | bigint
  readonly updated_at: number | bigint
}

const StatsJson = Schema.toCodecJson(Stats)
const AttributesJson = Schema.toCodecJson(Attributes)

/** Encoding is a defect: the value was built by this module. */
const encodeStats = (stats: Stats): Effect.Effect<string> =>
  Schema.encodeEffect(StatsJson)(stats).pipe(Effect.map((encoded) => JSON.stringify(encoded)), Effect.orDie)
const encodeAttributes = (attributes: Attributes): Effect.Effect<string> =>
  Schema.encodeEffect(AttributesJson)(attributes).pipe(Effect.map((encoded) => JSON.stringify(encoded)), Effect.orDie)

/**
 * A row's JSON columns were written by this module, so a decode failure is
 * corruption or a schema change, and named as `StorageError`, as the
 * durable store does for its history column.
 */
const parseJson = (operation: string, sessionId: string) => (text: string): Effect.Effect<unknown, StorageError> =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => new StorageError({ operation, sessionId, detail: detailOf(cause) })
  })

const decodeStats = (sessionId: string) => (text: string): Effect.Effect<Stats, StorageError> =>
  parseJson("decodeStats", sessionId)(text).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(StatsJson)(json).pipe(
        Effect.mapError((cause) => new StorageError({ operation: "decodeStats", sessionId, detail: detailOf(cause) }))
      ))
  )

const decodeAttributes = (sessionId: string) => (text: string): Effect.Effect<Attributes, StorageError> =>
  parseJson("decodeAttributes", sessionId)(text).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(AttributesJson)(json).pipe(
        Effect.mapError((cause) =>
          new StorageError({ operation: "decodeAttributes", sessionId, detail: detailOf(cause) }))
      ))
  )

const rowToEntry = (row: Row): Effect.Effect<Entry, StorageError> =>
  Effect.all({
    stats: decodeStats(row.session_id)(row.stats),
    attributes: decodeAttributes(row.session_id)(row.attributes)
  }).pipe(
    Effect.map(({ attributes, stats }): Entry => ({
      sessionId: SessionId.make(row.session_id),
      name: Option.fromNullishOr(row.name),
      namespace: row.namespace,
      attributes,
      stats,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    }))
  )

/**
 * A directory backed by SQL, over an existing table (`sqlWithTable` creates
 * it). Any deployment already has a `SqlClient`.
 *
 * Pagination is keyset on `session_id`, so a page is stable under inserts
 * elsewhere in the listing. `active` is an indexed integer column written
 * with the stats, not derived at query time from the JSON, so the listing a
 * dashboard polls does not parse every row.
 */
export const sql = (
  options?: { readonly table?: string | undefined }
): Effect.Effect<SessionDirectory, never, SqlClient.SqlClient> =>
  Effect.map(SqlClient.SqlClient, (sql) => {
    const table = sql.literal(escapeIdentifier(options?.table ?? sqlTable))

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
              }))

    const readRow = (sessionId: string) =>
      sql<Row>`SELECT * FROM ${table} WHERE session_id = ${sessionId}`.pipe(
        Effect.map((rows) => Option.fromNullishOr(rows[0]))
      )

    const readEntry = (sessionId: string) =>
      readRow(sessionId).pipe(
        Effect.flatMap(Option.match({
          onNone: () => Effect.succeed(Option.none<Entry>()),
          onSome: (row) => Effect.map(rowToEntry(row), Option.some)
        }))
      )

    const entryOrMissing = (operation: string, sessionId: SessionId) =>
      readEntry(sessionId).pipe(
        Effect.flatMap(Option.match({
          onNone: () => Effect.fail(new SessionNotIndexed({ sessionId, operation })),
          onSome: Effect.succeed
        }))
      )

    /**
     * Create the row if absent, in the statement rather than after a read
     * (`INSERT … SELECT … WHERE NOT EXISTS`), for the reason the durable
     * store gives at length: under read-committed isolation a read-then-
     * insert races into a uniqueness violation.
     */
    const ensure = (sessionId: string, now: number) =>
      Effect.flatMap(Effect.all([encodeStats(emptyStats), encodeAttributes({})]), ([stats, attributes]) =>
        sql`INSERT INTO ${table} (session_id, name, namespace, attributes, stats, active, created_at, updated_at) SELECT ${sessionId}, NULL, ${defaultNamespace}, ${attributes}, ${stats}, 0, ${now}, ${now} WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE session_id = ${sessionId})`)

    const update = (
      operation: string,
      sessionId: SessionId,
      change: (entry: Entry, now: number) => Entry
    ): Effect.Effect<Entry, SessionNotIndexed | StorageError> =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* entryOrMissing(operation, sessionId)
            const next = change(current, now)
            const [stats, attributes] = yield* Effect.all([encodeStats(next.stats), encodeAttributes(next.attributes)])
            yield* sql`UPDATE ${table} SET name = ${Option.getOrNull(next.name)}, namespace = ${next.namespace}, attributes = ${attributes}, stats = ${stats}, active = ${isActive(next.stats) ? 1 : 0}, updated_at = ${next.updatedAt} WHERE session_id = ${sessionId}`
            return next
          })
        ).pipe(storageKeeping(operation, sessionId)))

    /** As `storage`, but lets the directory's own typed error through. */
    function storageKeeping(operation: string, sessionId: string) {
      return <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, SessionNotIndexed | StorageError> =>
        Effect.mapError(effect, (cause): SessionNotIndexed | StorageError =>
          cause instanceof SessionNotIndexed || isStorageError(cause)
            ? cause
            : new StorageError({ operation, sessionId, detail: detailOf(cause) }))
    }

    const listing = (query: Query | undefined, onlyActive: boolean) =>
      Effect.gen(function* () {
        const limit = limitOf(query)
        const after = query?.after ?? ""
        const namespace = query?.namespace
        // One more than asked, so `next` is known without a count query.
        const rows = yield* (namespace === undefined
          ? (onlyActive
            ? sql<Row>`SELECT * FROM ${table} WHERE session_id > ${after} AND active = 1 ORDER BY session_id LIMIT ${limit + 1}`
            : sql<Row>`SELECT * FROM ${table} WHERE session_id > ${after} ORDER BY session_id LIMIT ${limit + 1}`)
          : (onlyActive
            ? sql<Row>`SELECT * FROM ${table} WHERE session_id > ${after} AND namespace = ${namespace} AND active = 1 ORDER BY session_id LIMIT ${limit + 1}`
            : sql<Row>`SELECT * FROM ${table} WHERE session_id > ${after} AND namespace = ${namespace} ORDER BY session_id LIMIT ${limit + 1}`))
        const entries = yield* Effect.forEach(rows.slice(0, limit), rowToEntry)
        const last = entries[entries.length - 1]
        return {
          entries,
          next: rows.length > limit && last !== undefined ? Option.some(last.sessionId) : Option.none()
        } satisfies Page
      }).pipe(storage(onlyActive ? "active" : "list"))

    return {
      get: (sessionId) => readEntry(sessionId).pipe(storage("get", sessionId)),
      list: (query) => listing(query, false),
      active: (query) => listing(query, true),
      stats: (sessionId) =>
        readEntry(sessionId).pipe(Effect.map(Option.map((e) => e.stats)), storage("stats", sessionId)),
      rename: (sessionId, name) => update("rename", sessionId, (e, now) => ({ ...e, name, updatedAt: now })),
      move: (sessionId, namespace) =>
        update("move", sessionId, (e, now) => ({ ...e, namespace, updatedAt: now })),
      annotate: (sessionId, attributes) =>
        update("annotate", sessionId, (e, now) => ({
          ...e,
          attributes: mergeAttributes(e.attributes, attributes),
          updatedAt: now
        })),
      observe: (sessionId) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          ensure(sessionId, now).pipe(
            Effect.andThen(entryOrMissing("observe", sessionId)),
            storage("observe", sessionId)
          )),
      record: (sessionId, stats) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Effect.flatMap(encodeStats(stats), (encoded) =>
            sql.withTransaction(
              ensure(sessionId, now).pipe(
                Effect.andThen(
                  sql`UPDATE ${table} SET stats = ${encoded}, active = ${isActive(stats) ? 1 : 0}, updated_at = ${now} WHERE session_id = ${sessionId}`
                ),
                Effect.andThen(entryOrMissing("record", sessionId))
              )
            )
          ).pipe(storage("record", sessionId)))
    }
  })

/** As `sql`, but creates the table and its listing index first if absent. */
export const sqlWithTable = (
  options?: { readonly table?: string | undefined }
): Effect.Effect<SessionDirectory, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const client = yield* SqlClient.SqlClient
    const name = options?.table ?? sqlTable
    const table = client.literal(escapeIdentifier(name))
    const index = client.literal(escapeIdentifier(`${name}_listing`))
    yield* client`CREATE TABLE IF NOT EXISTS ${table} (
      session_id TEXT PRIMARY KEY,
      name TEXT,
      namespace TEXT NOT NULL,
      attributes TEXT NOT NULL,
      stats TEXT NOT NULL,
      active INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`.pipe(Effect.orDie)
    yield* client`CREATE INDEX IF NOT EXISTS ${index} ON ${table} (namespace, active, session_id)`.pipe(Effect.orDie)
    return yield* sql(options)
  })

// -- Keeping it current ----------------------------------------------------------------

/**
 * Keep a directory current from a host-wide event stream.
 *
 * `HostAttached` and `SessionHosted` observe sessions; every `SessionEvent`
 * is folded into that session's `SessionProjection` and the stats written
 * through; `SessionUnhosted` drops the in-memory projection (the stats stay
 * -- the session left this host, not the directory). Seeded with
 * `SessionProjection.empty`, never `since(id, 0)`, for the reason on
 * `AgentProtocol.HostEvent`: sequence 1 is emitted before any host can
 * subscribe, so expecting it reports a gap that was never a loss.
 *
 * Runs until the stream ends, which for `hostEvents` is never; fork it into
 * the scope that owns the directory. One write per event: the directory is
 * an index, and an index that lags by a debounce window answers "is this
 * session active" wrongly for exactly that window.
 */
export const follow = (
  directory: SessionDirectory,
  events: Stream.Stream<AgentProtocol.HostEvent, never>
): Effect.Effect<void, StorageError> =>
  Effect.gen(function* () {
    const projections = yield* Ref.make<ReadonlyMap<SessionId, SessionProjection.Projection>>(new Map())

    const fold = (envelope: AgentEventEnvelope) =>
      Effect.flatMap(
        Ref.modify(projections, (all): [SessionProjection.Projection, ReadonlyMap<SessionId, SessionProjection.Projection>] => {
          const current = all.get(envelope.sessionId) ?? SessionProjection.empty(envelope.sessionId)
          const next = SessionProjection.reduce(current, envelope)
          return [next, new Map(all).set(envelope.sessionId, next)]
        }),
        (projection) => directory.record(projection.sessionId, statsOf(projection))
      )

    yield* Stream.runForEach(events, (event): Effect.Effect<unknown, StorageError> => {
      switch (event._tag) {
        case "HostAttached":
          return Effect.forEach(event.sessionIds, directory.observe, { discard: true })
        case "SessionHosted":
          return directory.observe(event.sessionId)
        case "SessionEvent":
          return fold(event.envelope)
        case "SessionUnhosted":
          return Ref.update(projections, (all) => {
            if (!all.has(event.sessionId)) return all
            const next = new Map(all)
            next.delete(event.sessionId)
            return next
          })
      }
    })
  })
