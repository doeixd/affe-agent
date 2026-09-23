/**
 * The Needs You inbox (plan-agent-product-control-plane.md §11): every
 * question an agent has asked a person and not yet had answered, across
 * all their conversations.
 *
 * Not an approval queue of its own -- the plan is explicit -- but a durable
 * reference to an unresolved `Elicitation`, kept current by
 * `InboxProjection` from the host's events. Answering happens where it
 * always did, on the session; the item then settles because the session
 * says so. A read model: losing it loses a list, and nothing waits on it.
 */
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ConversationId, UserId } from "../domain/WorkbenchIds.js"
import { failedAs } from "./WorkbenchStorageError.js"
import type { WorkbenchStorageError } from "./WorkbenchStorageError.js"

export const Item = Schema.Struct({
  /** The elicitation's id: what the session's `respond` takes. */
  id: Schema.String,
  sessionId: Schema.String,
  conversationId: ConversationId,
  /** Whose to answer: the conversation's owner. */
  ownerId: UserId,
  /** `"tool-approval"`, or whatever the application defined. */
  kind: Schema.String,
  /** Described by the kind; opaque here, as it is in the kernel. */
  detail: Schema.Unknown,
  /** Epoch milliseconds, from the projection's clock. */
  createdAt: Schema.Number
})
export type Item = typeof Item.Type

export interface Service {
  /** Idempotent on `(sessionId, id)`: a replayed request is the same item. */
  readonly put: (item: Item) => Effect.Effect<void, WorkbenchStorageError>
  readonly remove: (sessionId: string, id: string) => Effect.Effect<void, WorkbenchStorageError>
  /** Everything a session had open: what a settled submission ends. */
  readonly clearSession: (sessionId: string) => Effect.Effect<void, WorkbenchStorageError>
  /** Oldest first: the longest-waiting question comes first. */
  readonly listFor: (owner: UserId) => Effect.Effect<ReadonlyArray<Item>, WorkbenchStorageError>
}

export class InboxStore extends Context.Service<InboxStore, Service>()("workbench/InboxStore") {}

const keyOf = (sessionId: string, id: string) => `${sessionId}\u0000${id}`
const oldestFirst = (a: Item, b: Item) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)

// -- Memory -----------------------------------------------------------------------------

export const memory: Layer.Layer<InboxStore> = Layer.effect(
  InboxStore,
  Effect.gen(function*() {
    const state = yield* Ref.make<ReadonlyMap<string, Item>>(new Map())
    return InboxStore.of({
      put: (item) =>
        Ref.update(state, (items) => {
          const key = keyOf(item.sessionId, item.id)
          return items.has(key) ? items : new Map(items).set(key, item)
        }),
      remove: (sessionId, id) =>
        Ref.update(state, (items) => {
          const next = new Map(items)
          next.delete(keyOf(sessionId, id))
          return next
        }),
      clearSession: (sessionId) =>
        Ref.update(state, (items) => new Map([...items].filter(([, item]) => item.sessionId !== sessionId))),
      listFor: (owner) =>
        Effect.map(Ref.get(state), (items) => [...items.values()].filter((item) => item.ownerId === owner).sort(oldestFirst))
    })
  })
)

// -- SQL --------------------------------------------------------------------------------

const ItemJson = Schema.toCodecJson(Item)

const encode = (item: Item) =>
  Effect.orDie(Effect.map(Schema.encodeEffect(ItemJson)(item), (encoded) => JSON.stringify(encoded)))

const decode = (text: string) =>
  Effect.flatMap(
    Effect.try({ try: (): unknown => JSON.parse(text), catch: failedAs("InboxStore.decode") }),
    (json) => Effect.mapError(Schema.decodeUnknownEffect(ItemJson)(json), failedAs("InboxStore.decode"))
  )

interface BodyRow {
  readonly body: string
}

export const sql: Effect.Effect<Service, never, SqlClient.SqlClient> = Effect.gen(function*() {
  const client = yield* SqlClient.SqlClient
  return InboxStore.of({
    put: (item) =>
      Effect.flatMap(encode(item), (body) =>
        client`INSERT INTO workbench_inbox (session_id, elicitation_id, owner_id, created_at, body) VALUES (${item.sessionId}, ${item.id}, ${item.ownerId}, ${item.createdAt}, ${body}) ON CONFLICT (session_id, elicitation_id) DO NOTHING`)
        .pipe(Effect.asVoid, Effect.mapError(failedAs("InboxStore.put"))),
    remove: (sessionId, id) =>
      client`DELETE FROM workbench_inbox WHERE session_id = ${sessionId} AND elicitation_id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(failedAs("InboxStore.remove"))
      ),
    clearSession: (sessionId) =>
      client`DELETE FROM workbench_inbox WHERE session_id = ${sessionId}`.pipe(
        Effect.asVoid,
        Effect.mapError(failedAs("InboxStore.clearSession"))
      ),
    listFor: (owner) =>
      client<BodyRow>`SELECT body FROM workbench_inbox WHERE owner_id = ${owner} ORDER BY created_at, elicitation_id`.pipe(
        Effect.mapError(failedAs("InboxStore.listFor")),
        Effect.flatMap((rows) => Effect.forEach(rows, (row) => decode(row.body)))
      )
  })
})

export const sqlWithTables: Effect.Effect<Service, never, SqlClient.SqlClient> = Effect.gen(function*() {
  const client = yield* SqlClient.SqlClient
  yield* client`CREATE TABLE IF NOT EXISTS workbench_inbox (
    session_id TEXT NOT NULL,
    elicitation_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (session_id, elicitation_id)
  )`.pipe(Effect.orDie)
  yield* client`CREATE INDEX IF NOT EXISTS workbench_inbox_by_owner ON workbench_inbox (owner_id, created_at)`.pipe(Effect.orDie)
  return yield* sql
})

export const layerSql: Layer.Layer<InboxStore, never, SqlClient.SqlClient> = Layer.effect(InboxStore, sqlWithTables)
