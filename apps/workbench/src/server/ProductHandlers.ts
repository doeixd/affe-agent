/**
 * `WorkbenchApi` over the store services, as the person asking.
 *
 * The stores are shared by everyone; ownership is enforced here. Another
 * owner's records answer exactly as missing ones do, so a guessed id learns
 * nothing about whether it exists.
 */
import { Effect, Layer, Option } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { AgentId, UserId } from "../domain/WorkbenchIds.js"
import { CurrentUser, ForeignOwnerError } from "../protocol/Authentication.js"
import { WorkbenchApi } from "../protocol/WorkbenchApi.js"
import { AgentNotFoundError, AgentRegistry } from "../store/AgentRegistry.js"
import { ConversationNotFoundError, ConversationStore } from "../store/ConversationStore.js"
import * as SessionIndex from "../store/SessionIndex.js"

const ownedBy = <A extends { readonly ownerId: UserId }>(found: Option.Option<A>, user: UserId): Option.Option<A> =>
  Option.filter(found, (record) => record.ownerId === user)

const me = HttpApiBuilder.group(WorkbenchApi, "me", (handlers) => handlers.handle("get", () => CurrentUser))

const conversations = HttpApiBuilder.group(
  WorkbenchApi,
  "conversations",
  Effect.fn(function*(handlers) {
    const store = yield* ConversationStore
    const registry = yield* AgentRegistry
    const index = yield* SessionIndex.SessionIndex

    const ownConversation = Effect.fn("conversations.own")(function*(id: Parameters<typeof store.get>[0]) {
      const user = yield* CurrentUser
      return ownedBy(yield* store.get(id), user)
    })

    return handlers.handleAll({
      list: Effect.fn(function*({ query }) {
        const user = yield* CurrentUser
        return yield* store.list({ ownerId: user, includeArchived: query.includeArchived })
      }),
      get: ({ params }) => ownConversation(params.id),
      create: Effect.fn(function*({ payload }) {
        const user = yield* CurrentUser
        if (payload.ownerId !== user) {
          return yield* new ForeignOwnerError({ ownerId: payload.ownerId })
        }
        // The conversation must run one of this person's agents, on a revision of that agent.
        const agent = ownedBy(yield* registry.get(payload.agentId), user)
        const revision = yield* registry.revision(payload.agentRevisionId)
        if (Option.isNone(agent) || Option.isNone(revision) || revision.value.agentId !== payload.agentId) {
          return yield* new AgentNotFoundError({ agentId: payload.agentId })
        }
        const created = yield* store.create(payload)
        // Indexed under its owner from the start, so it is listed before its
        // first event and its agent is known without a join.
        yield* SessionIndex.index(index, created)
        return created
      }),
      update: Effect.fn(function*({ params, payload }) {
        if (Option.isNone(yield* ownConversation(params.id))) {
          return yield* new ConversationNotFoundError({ conversationId: params.id })
        }
        return yield* store.update(params.id, payload)
      }),
      remove: Effect.fn(function*({ params }) {
        if (Option.isSome(yield* ownConversation(params.id))) {
          yield* store.remove(params.id)
        }
      })
    })
  })
)

const agents = HttpApiBuilder.group(
  WorkbenchApi,
  "agents",
  Effect.fn(function*(handlers) {
    const registry = yield* AgentRegistry

    const ownAgent = Effect.fn("agents.own")(function*(id: AgentId) {
      const user = yield* CurrentUser
      return ownedBy(yield* registry.get(id), user)
    })

    const requireOwnAgent = Effect.fn("agents.requireOwn")(function*(id: AgentId) {
      if (Option.isNone(yield* ownAgent(id))) {
        return yield* new AgentNotFoundError({ agentId: id })
      }
    })

    return handlers.handleAll({
      list: Effect.fn(function*() {
        return yield* registry.list(yield* CurrentUser)
      }),
      get: ({ params }) => ownAgent(params.id),
      revisions: Effect.fn(function*({ params }) {
        return Option.isSome(yield* ownAgent(params.id)) ? yield* registry.revisions(params.id) : []
      }),
      revision: Effect.fn(function*({ params }) {
        const revision = yield* registry.revision(params.id)
        if (Option.isNone(revision)) return revision
        return Option.isSome(yield* ownAgent(revision.value.agentId)) ? revision : Option.none()
      }),
      create: Effect.fn(function*({ payload }) {
        const user = yield* CurrentUser
        if (payload.ownerId !== user) {
          return yield* new ForeignOwnerError({ ownerId: payload.ownerId })
        }
        return yield* registry.create(payload)
      }),
      revise: Effect.fn(function*({ params, payload }) {
        yield* requireOwnAgent(params.id)
        return yield* registry.revise(params.id, payload, yield* CurrentUser)
      }),
      archive: Effect.fn(function*({ params }) {
        yield* requireOwnAgent(params.id)
        yield* registry.archive(params.id)
      })
    })
  })
)

const sessions = HttpApiBuilder.group(
  WorkbenchApi,
  "sessions",
  Effect.fn(function*(handlers) {
    const store = yield* ConversationStore
    const index = yield* SessionIndex.SessionIndex

    return handlers.handleAll({
      summary: Effect.fn(function*({ params }) {
        const user = yield* CurrentUser
        const conversation = ownedBy(yield* store.get(params.id), user)
        return Option.isNone(conversation) ? Option.none() : yield* SessionIndex.summary(index, conversation.value)
      }),
      active: Effect.fn(function*() {
        return yield* SessionIndex.active(index, yield* CurrentUser)
      })
    })
  })
)

export const routes = HttpApiBuilder.layer(WorkbenchApi).pipe(Layer.provide([me, conversations, agents, sessions]))
