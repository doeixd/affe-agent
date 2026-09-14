/**
 * Conversation metadata persistence (plan-workbench.md §2).
 *
 * Title, owner, archive state and the stable session id. Not message history,
 * which the session owns, and not execution, which `AgentClient` owns.
 */
import { Context, DateTime, Effect, Layer, Option, Ref, Schema } from "effect"
import * as Conversation from "../domain/Conversation.js"
import { ConversationId } from "../domain/WorkbenchIds.js"

export class ConversationNotFoundError extends Schema.TaggedError<ConversationNotFoundError>()(
  "ConversationNotFoundError",
  { conversationId: ConversationId }
) {}

export class ConversationExistsError extends Schema.TaggedError<ConversationExistsError>()(
  "ConversationExistsError",
  { conversationId: ConversationId }
) {}

export interface Service {
  readonly create: (record: Conversation.New) => Effect.Effect<Conversation.Record, ConversationExistsError>
  readonly get: (id: ConversationId) => Effect.Effect<Option.Option<Conversation.Record>>
  readonly list: (query: Conversation.Query) => Effect.Effect<ReadonlyArray<Conversation.Record>>
  readonly update: (
    id: ConversationId,
    patch: Conversation.Patch
  ) => Effect.Effect<Conversation.Record, ConversationNotFoundError>
  readonly remove: (id: ConversationId) => Effect.Effect<void>
}

export class ConversationStore extends Context.Service<ConversationStore, Service>()(
  "workbench/ConversationStore"
) {}

/** Newest first, as a conversation list is read. */
const byUpdatedDesc = (a: Conversation.Record, b: Conversation.Record) =>
  DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt)

export const memory: Layer.Layer<ConversationStore> = Layer.effect(
  ConversationStore,
  Effect.gen(function*() {
    const records = yield* Ref.make(new Map<ConversationId, Conversation.Record>())

    const create = Effect.fn("ConversationStore.create")(function*(input: Conversation.New) {
      const now = yield* DateTime.now
      const record: Conversation.Record = { ...input, archived: false, createdAt: now, updatedAt: now }
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
        const next: Conversation.Record = {
          ...current,
          title: patch.title ?? current.title,
          archived: patch.archived ?? current.archived,
          updatedAt: now
        }
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
