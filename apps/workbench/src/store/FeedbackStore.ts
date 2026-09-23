/**
 * Feedback on a reply (plan-workbench.md W2, `FeedbackStore`): a person's
 * thumbs up or down, and an optional note, on one assistant message of one
 * of their conversations.
 *
 * A reply is named by its position among the conversation's messages as
 * history holds them -- the only stable name a message has, since history
 * is canonical and the page reads it back after every run. One rating per
 * person per message; rating again replaces it, and `clear` withdraws it.
 */
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ConversationId, UserId } from "../domain/WorkbenchIds.js"
import { failedAs } from "./WorkbenchStorageError.js"
import type { WorkbenchStorageError } from "./WorkbenchStorageError.js"

export const Rating = Schema.Literals(["up", "down"])
export type Rating = typeof Rating.Type

export const Entry = Schema.Struct({
  conversationId: ConversationId,
  /** The message's index in the conversation's messages, as history holds them. */
  messageIndex: Schema.Int,
  by: UserId,
  rating: Rating,
  note: Schema.Option(Schema.String),
  /** Epoch milliseconds. */
  at: Schema.Number
})
export type Entry = typeof Entry.Type

export interface Service {
  readonly set: (entry: Entry) => Effect.Effect<void, WorkbenchStorageError>
  readonly clear: (conversationId: ConversationId, messageIndex: number, by: UserId) => Effect.Effect<void, WorkbenchStorageError>
  /** This person's feedback on the conversation, by message index. */
  readonly list: (conversationId: ConversationId, by: UserId) => Effect.Effect<ReadonlyArray<Entry>, WorkbenchStorageError>
}

export class FeedbackStore extends Context.Service<FeedbackStore, Service>()("workbench/FeedbackStore") {}

const keyOf = (conversationId: string, messageIndex: number, by: string) => `${conversationId}\u0000${messageIndex}\u0000${by}`
const byIndex = (a: Entry, b: Entry) => a.messageIndex - b.messageIndex

export const memory: Layer.Layer<FeedbackStore> = Layer.effect(
  FeedbackStore,
  Effect.map(Ref.make<ReadonlyMap<string, Entry>>(new Map()), (state) =>
    FeedbackStore.of({
      set: (entry) => Ref.update(state, (all) => new Map(all).set(keyOf(entry.conversationId, entry.messageIndex, entry.by), entry)),
      clear: (conversationId, messageIndex, by) =>
        Ref.update(state, (all) => {
          const next = new Map(all)
          next.delete(keyOf(conversationId, messageIndex, by))
          return next
        }),
      list: (conversationId, by) =>
        Effect.map(Ref.get(state), (all) =>
          [...all.values()].filter((entry) => entry.conversationId === conversationId && entry.by === by).sort(byIndex))
    }))
)

const EntryJson = Schema.toCodecJson(Entry)
const encode = (entry: Entry) =>
  Effect.orDie(Effect.map(Schema.encodeEffect(EntryJson)(entry), (encoded) => JSON.stringify(encoded)))
const decode = (text: string) =>
  Effect.flatMap(
    Effect.try({ try: (): unknown => JSON.parse(text), catch: failedAs("FeedbackStore.decode") }),
    (json) => Effect.mapError(Schema.decodeUnknownEffect(EntryJson)(json), failedAs("FeedbackStore.decode"))
  )

export const sql: Effect.Effect<Service, never, SqlClient.SqlClient> = Effect.gen(function*() {
  const client = yield* SqlClient.SqlClient
  return FeedbackStore.of({
    set: (entry) =>
      Effect.flatMap(encode(entry), (body) =>
        client`INSERT INTO workbench_feedback (conversation_id, message_index, by_user, body) VALUES (${entry.conversationId}, ${entry.messageIndex}, ${entry.by}, ${body})
          ON CONFLICT (conversation_id, message_index, by_user) DO UPDATE SET body = excluded.body`)
        .pipe(Effect.asVoid, Effect.mapError(failedAs("FeedbackStore.set"))),
    clear: (conversationId, messageIndex, by) =>
      client`DELETE FROM workbench_feedback WHERE conversation_id = ${conversationId} AND message_index = ${messageIndex} AND by_user = ${by}`
        .pipe(Effect.asVoid, Effect.mapError(failedAs("FeedbackStore.clear"))),
    list: (conversationId, by) =>
      client<{ readonly body: string }>`SELECT body FROM workbench_feedback WHERE conversation_id = ${conversationId} AND by_user = ${by} ORDER BY message_index`
        .pipe(
          Effect.mapError(failedAs("FeedbackStore.list")),
          Effect.flatMap((rows) => Effect.forEach(rows, (row) => decode(row.body)))
        )
  })
})

export const sqlWithTables: Effect.Effect<Service, never, SqlClient.SqlClient> = Effect.gen(function*() {
  const client = yield* SqlClient.SqlClient
  yield* client`CREATE TABLE IF NOT EXISTS workbench_feedback (
    conversation_id TEXT NOT NULL,
    message_index INTEGER NOT NULL,
    by_user TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (conversation_id, message_index, by_user)
  )`.pipe(Effect.orDie)
  return yield* sql
})

export const layerSql: Layer.Layer<FeedbackStore, never, SqlClient.SqlClient> = Layer.effect(FeedbackStore, sqlWithTables)

/** The rating on one message, if this person gave one. */
export const ratingAt = (entries: ReadonlyArray<Entry>, messageIndex: number): Option.Option<Rating> =>
  Option.map(Option.fromNullishOr(entries.find((entry) => entry.messageIndex === messageIndex)), (entry) => entry.rating)
