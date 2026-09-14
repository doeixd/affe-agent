/**
 * Conversation metadata persistence (plan-workbench.md §2).
 *
 * Title, owner, archive state and the stable session id. Not message history,
 * which the session owns, and not execution, which `AgentClient` owns.
 */
import { Context, DateTime, Effect, Layer, Option, Ref, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import * as Conversation from "../domain/Conversation.js"
import { ConversationId } from "../domain/WorkbenchIds.js"
import { failedAs, WorkbenchStorageError } from "./WorkbenchStorageError.js"

export class ConversationNotFoundError extends Schema.TaggedError<ConversationNotFoundError>()(
  "ConversationNotFoundError",
  { conversationId: ConversationId }
) {}

export class ConversationExistsError extends Schema.TaggedError<ConversationExistsError>()(
  "ConversationExistsError",
  { conversationId: ConversationId }
) {}

export interface Service {
  readonly create: (
    record: Conversation.New
  ) => Effect.Effect<Conversation.Record, ConversationExistsError | WorkbenchStorageError>
  readonly get: (id: ConversationId) => Effect.Effect<Option.Option<Conversation.Record>, WorkbenchStorageError>
  /** Newest first, as a conversation list is read. */
  readonly list: (query: Conversation.Query) => Effect.Effect<ReadonlyArray<Conversation.Record>, WorkbenchStorageError>
  readonly update: (
    id: ConversationId,
    patch: Conversation.Patch
  ) => Effect.Effect<Conversation.Record, ConversationNotFoundError | WorkbenchStorageError>
  readonly remove: (id: ConversationId) => Effect.Effect<void, WorkbenchStorageError>
}

export class ConversationStore extends Context.Service<ConversationStore, Service>()(
  "workbench/ConversationStore"
) {}

const stamped = (input: Conversation.New, now: DateTime.Utc): Conversation.Record => ({
  ...input,
  archived: false,
  createdAt: now,
  updatedAt: now
})

const patched = (current: Conversation.Record, patch: Conversation.Patch, now: DateTime.Utc): Conversation.Record => ({
  ...current,
  title: patch.title ?? current.title,
  archived: patch.archived ?? current.archived,
  updatedAt: now
})

// -- Memory -----------------------------------------------------------------------------

const byUpdatedDesc = (a: Conversation.Record, b: Conversation.Record) =>
  DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt)

export const memory: Layer.Layer<ConversationStore> = Layer.effect(
  ConversationStore,
  Effect.gen(function*() {
    const records = yield* Ref.make(new Map<ConversationId, Conversation.Record>())

    const create = Effect.fn("ConversationStore.create")(function*(input: Conversation.New) {
      const record = stamped(input, yield* DateTime.now)
      const inserted = yield* Ref.modify(records, (map) =>
        map.has(input.id) ? [false, map] : [true, new Map(map).set(input.id, record)]
      )
      if (!inserted) {
        return yield* new ConversationExistsError({ conversationId: input.id })
      }
      return record
    })

    const update = Effect.fn("ConversationStore.update")(function*(id: ConversationId, patch: Conversation.Patch) {
      const now = yield* DateTime.now
      const updated = yield* Ref.modify(records, (map) => {
        const current = map.get(id)
        if (current === undefined) return [Option.none(), map]
        const next = patched(current, patch, now)
        return [Option.some(next), new Map(map).set(id, next)]
      })
      return yield* Option.match(updated, {
        onNone: () => Effect.fail(new ConversationNotFoundError({ conversationId: id })),
        onSome: Effect.succeed
      })
    })

    return ConversationStore.of({
      create,
      get: (id) => Effect.map(Ref.get(records), (map) => Option.fromNullishOr(map.get(id))),
      list: (query) =>
        Effect.map(Ref.get(records), (map) =>
          [...map.values()]
            .filter((record) =>
              record.ownerId === query.ownerId && (query.includeArchived === true || !record.archived)
            )
            .sort(byUpdatedDesc)),
      update,
      remove: (id) =>
        Ref.update(records, (map) => {
          const next = new Map(map)
          next.delete(id)
          return next
        })
    })
  })
)

// -- SQL --------------------------------------------------------------------------------

const RecordJson = Schema.toCodecJson(Conversation.Record)

const encodeRecord = (record: Conversation.Record) =>
  Effect.orDie(Effect.map(Schema.encodeEffect(RecordJson)(record), (encoded) => JSON.stringify(encoded)))

const decodeRecord = (text: string) =>
  Effect.try({ try: (): unknown => JSON.parse(text), catch: failedAs("decodeConversation") }).pipe(
    Effect.flatMap((json) => Effect.mapError(Schema.decodeUnknownEffect(RecordJson)(json), failedAs("decodeConversation")))
  )

interface BodyRow {
  readonly body: string
}

/**
 * A store over an existing table (`sqlWithTable` creates it). The body is the
 * record's JSON encoding; `owner_id`, `archived` and `updated_at` sit beside
 * it so a conversation list is one indexed query.
 */
export const sql: Effect.Effect<Service, never, SqlClient.SqlClient> = Effect.gen(function*() {
  const client = yield* SqlClient.SqlClient

  const get = (id: ConversationId) =>
    client<BodyRow>`SELECT body FROM workbench_conversations WHERE id = ${id}`.pipe(
      Effect.mapError(failedAs("ConversationStore.get")),
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(Option.none<Conversation.Record>())
          : Effect.map(decodeRecord(rows[0].body), Option.some)
      )
    )

  const create = Effect.fn("ConversationStore.create")(function*(input: Conversation.New) {
    const record = stamped(input, yield* DateTime.now)
    const body = yield* encodeRecord(record)
    // Insert-if-absent in the statement, then read back whose row it is: a
    // count-then-insert lets two concurrent creates both see nothing, and the
    // loser would fail on the primary key as storage rather than as
    // `ConversationExistsError`. A body identical to ours is ours -- or an
    // indistinguishable twin written in the same millisecond.
    const stored = yield* client`INSERT INTO workbench_conversations (id, owner_id, archived, updated_at, body) SELECT ${record.id}, ${record.ownerId}, 0, ${DateTime.toEpochMillis(record.updatedAt)}, ${body} WHERE NOT EXISTS (SELECT 1 FROM workbench_conversations WHERE id = ${record.id})`.pipe(
      Effect.andThen(client<BodyRow>`SELECT body FROM workbench_conversations WHERE id = ${record.id}`),
      Effect.mapError(failedAs("ConversationStore.create"))
    )
    if (stored[0]?.body !== body) {
      return yield* new ConversationExistsError({ conversationId: input.id })
    }
    return record
  })

  const update = Effect.fn("ConversationStore.update")(function*(id: ConversationId, patch: Conversation.Patch) {
    const now = yield* DateTime.now
    return yield* client.withTransaction(Effect.gen(function*() {
      const current = yield* get(id)
      if (Option.isNone(current)) {
        return yield* new ConversationNotFoundError({ conversationId: id })
      }
      const next = patched(current.value, patch, now)
      const body = yield* encodeRecord(next)
      yield* client`UPDATE workbench_conversations SET body = ${body}, archived = ${next.archived ? 1 : 0}, updated_at = ${DateTime.toEpochMillis(now)} WHERE id = ${id}`
      return next
    })).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(failedAs("ConversationStore.update")(cause))))
  })

  return ConversationStore.of({
    create,
    get,
    list: (query) =>
      (query.includeArchived === true
        ? client<BodyRow>`SELECT body FROM workbench_conversations WHERE owner_id = ${query.ownerId} ORDER BY updated_at DESC, id`
        : client<BodyRow>`SELECT body FROM workbench_conversations WHERE owner_id = ${query.ownerId} AND archived = 0 ORDER BY updated_at DESC, id`
      ).pipe(
        Effect.mapError(failedAs("ConversationStore.list")),
        Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeRecord(row.body)))
      ),
    update,
    remove: (id) =>
      client`DELETE FROM workbench_conversations WHERE id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(failedAs("ConversationStore.remove"))
      )
  })
})

/** As `sql`, creating the table and its listing index first if absent. */
export const sqlWithTable: Effect.Effect<Service, never, SqlClient.SqlClient> = Effect.gen(function*() {
  const client = yield* SqlClient.SqlClient
  yield* client`CREATE TABLE IF NOT EXISTS workbench_conversations (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    archived INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    body TEXT NOT NULL
  )`.pipe(Effect.orDie)
  yield* client`CREATE INDEX IF NOT EXISTS workbench_conversations_listing ON workbench_conversations (owner_id, archived, updated_at)`
    .pipe(Effect.orDie)
  return yield* sql
})

export const layerSql: Layer.Layer<ConversationStore, never, SqlClient.SqlClient> = Layer.effect(
  ConversationStore,
  sqlWithTable
)

// -- Key-value storage (a browser's localStorage) -----------------------------------------

export interface KeyValue {
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
}

const RecordsJson = Schema.toCodecJson(Schema.Array(Conversation.Record))

/**
 * A store over one key of a key-value storage, so a refreshed page still has
 * its conversations. Every operation reads and rewrites the whole list: fine
 * for one person's conversations in one tab. Two tabs writing at once can
 * lose one tab's change; that is what the SQL store behind a server is for.
 */
export const fromStorage = (
  storage: KeyValue,
  key: string = "workbench/conversations"
): Layer.Layer<ConversationStore> =>
  Layer.succeed(
    ConversationStore,
    ConversationStore.of((() => {
      const load = Effect.try({ try: () => storage.getItem(key), catch: failedAs("ConversationStore.load") }).pipe(
        Effect.flatMap((text) =>
          text === null
            ? Effect.succeed<ReadonlyArray<Conversation.Record>>([])
            : Effect.try({ try: (): unknown => JSON.parse(text), catch: failedAs("decodeConversations") }).pipe(
              Effect.flatMap((json) =>
                Effect.mapError(Schema.decodeUnknownEffect(RecordsJson)(json), failedAs("decodeConversations"))
              )
            )
        )
      )
      const save = (records: ReadonlyArray<Conversation.Record>) =>
        Effect.orDie(Schema.encodeEffect(RecordsJson)(records)).pipe(
          Effect.flatMap((encoded) =>
            Effect.try({
              try: () => storage.setItem(key, JSON.stringify(encoded)),
              catch: failedAs("ConversationStore.save")
            })
          )
        )

      const create = Effect.fn("ConversationStore.create")(function*(input: Conversation.New) {
        const records = yield* load
        if (records.some((record) => record.id === input.id)) {
          return yield* new ConversationExistsError({ conversationId: input.id })
        }
        const record = stamped(input, yield* DateTime.now)
        yield* save([...records, record])
        return record
      })

      const update = Effect.fn("ConversationStore.update")(function*(id: ConversationId, patch: Conversation.Patch) {
        const records = yield* load
        const current = records.find((record) => record.id === id)
        if (current === undefined) {
          return yield* new ConversationNotFoundError({ conversationId: id })
        }
        const next = patched(current, patch, yield* DateTime.now)
        yield* save(records.map((record) => (record.id === id ? next : record)))
        return next
      })

      return {
        create,
        get: (id: ConversationId) =>
          Effect.map(load, (records) => Option.fromNullishOr(records.find((record) => record.id === id))),
        list: (query: Conversation.Query) =>
          Effect.map(load, (records) =>
            records
              .filter((record) =>
                record.ownerId === query.ownerId && (query.includeArchived === true || !record.archived)
              )
              .sort(byUpdatedDesc)),
        update,
        remove: (id: ConversationId) =>
          Effect.flatMap(load, (records) => save(records.filter((record) => record.id !== id)))
      }
    })())
  )

export { WorkbenchStorageError }
