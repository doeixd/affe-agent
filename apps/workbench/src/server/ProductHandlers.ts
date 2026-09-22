/**
 * `WorkbenchApi` over the store services, as the person asking.
 *
 * The stores are shared by everyone; access is decided here, by `Access`
 * for agents and by ownership for everything personal. A record the caller
 * may not see answers exactly as a missing one does, so a guessed id learns
 * nothing about whether it exists.
 */
import { Effect, Layer, Option } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Access from "../domain/Access.js"
import type { AgentSpec } from "../domain/AgentRevision.js"
import type { AgentId, OrganizationId, UserId } from "../domain/WorkbenchIds.js"
import { CurrentUser, ForeignOwnerError, InsufficientRoleError } from "../protocol/Authentication.js"
import { Catalog } from "../runtime/Catalog.js"
import { WorkbenchApi } from "../protocol/WorkbenchApi.js"
import { AgentNotFoundError, AgentRegistry } from "../store/AgentRegistry.js"
import { ConversationNotFoundError, ConversationStore } from "../store/ConversationStore.js"
import { OrganizationNotFoundError, OrganizationStore } from "../store/OrganizationStore.js"
import * as SessionIndex from "../store/SessionIndex.js"
import { Identity } from "./Identity.js"

const ownedBy = <A extends { readonly ownerId: UserId }>(found: Option.Option<A>, user: UserId): Option.Option<A> =>
  Option.filter(found, (record) => record.ownerId === user)

/** The caller's roles, by organization: what every agent decision is made against. */
const rolesOf = Effect.fn("rolesOf")(function*(organizations: OrganizationStore["Service"], user: UserId) {
  const joined = yield* organizations.listFor(user)
  return new Map(joined.map((entry) => [entry.organization.id, entry.role])) as Access.Roles
})

const me = HttpApiBuilder.group(WorkbenchApi, "me", (handlers) => handlers.handle("get", () => CurrentUser))

const conversations = HttpApiBuilder.group(
  WorkbenchApi,
  "conversations",
  Effect.fn(function*(handlers) {
    const store = yield* ConversationStore
    const registry = yield* AgentRegistry
    const organizations = yield* OrganizationStore
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
        // The conversation must run an agent this person may use, on a revision of that agent.
        const agent = yield* registry.get(payload.agentId)
        const revision = yield* registry.revision(payload.agentRevisionId)
        const roles = yield* rolesOf(organizations, user)
        if (
          Option.isNone(agent) || !Access.canUse(agent.value, user, roles) ||
          Option.isNone(revision) || revision.value.agentId !== payload.agentId
        ) {
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
    const organizations = yield* OrganizationStore

    /** The agent, if the caller may see and run it. */
    const usable = Effect.fn("agents.usable")(function*(id: AgentId) {
      const user = yield* CurrentUser
      const found = yield* registry.get(id)
      if (Option.isNone(found)) return found
      const roles = yield* rolesOf(organizations, user)
      return Option.filter(found, (agent) => Access.canUse(agent, user, roles))
    })

    /** The agent, if the caller may change it; otherwise as missing. */
    const manageable = Effect.fn("agents.manageable")(function*(id: AgentId) {
      const user = yield* CurrentUser
      const found = yield* registry.get(id)
      if (Option.isNone(found) || !Access.canManage(found.value, user, yield* rolesOf(organizations, user))) {
        return yield* new AgentNotFoundError({ agentId: id })
      }
      return found.value
    })

    return handlers.handleAll({
      list: Effect.fn(function*() {
        const user = yield* CurrentUser
        const roles = yield* rolesOf(organizations, user)
        const own = yield* registry.list(user)
        const shared = yield* registry.listShared([...roles.keys()])
        const seen = new Set(own.map((agent) => agent.id))
        return [...own, ...shared.filter((agent) => !seen.has(agent.id))].sort((a, b) => a.id.localeCompare(b.id))
      }),
      get: ({ params }) => usable(params.id),
      revisions: Effect.fn(function*({ params }) {
        return Option.isSome(yield* usable(params.id)) ? yield* registry.revisions(params.id) : []
      }),
      revision: Effect.fn(function*({ params }) {
        const revision = yield* registry.revision(params.id)
        if (Option.isNone(revision)) return revision
        return Option.isSome(yield* usable(revision.value.agentId)) ? revision : Option.none()
      }),
      create: Effect.fn(function*({ payload }) {
        const user = yield* CurrentUser
        if (payload.ownerId !== user) {
          return yield* new ForeignOwnerError({ ownerId: payload.ownerId })
        }
        if (payload.organizationId !== undefined) {
          const roles = yield* rolesOf(organizations, user)
          if (!Access.canCreateIn(payload.organizationId, roles)) {
            return yield* new OrganizationNotFoundError({ organizationId: payload.organizationId })
          }
        }
        return yield* registry.create(payload)
      }),
      revise: Effect.fn(function*({ params, payload }) {
        yield* manageable(params.id)
        return yield* registry.revise(params.id, payload, yield* CurrentUser)
      }),
      archive: Effect.fn(function*({ params }) {
        yield* manageable(params.id)
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

const organizationsGroup = HttpApiBuilder.group(
  WorkbenchApi,
  "organizations",
  Effect.fn(function*(handlers) {
    const organizations = yield* OrganizationStore

    /** The caller's role in the organization; not a member is not a member of anything by that id. */
    const myRole = Effect.fn("organizations.myRole")(function*(id: OrganizationId) {
      const role = yield* organizations.role(id, yield* CurrentUser)
      if (Option.isNone(role)) {
        return yield* new OrganizationNotFoundError({ organizationId: id })
      }
      return role
    })

    return handlers.handleAll({
      list: Effect.fn(function*() {
        return yield* organizations.listFor(yield* CurrentUser)
      }),
      create: Effect.fn(function*({ payload }) {
        return yield* organizations.create(payload.name, yield* CurrentUser)
      }),
      members: Effect.fn(function*({ params }) {
        yield* myRole(params.id)
        return yield* organizations.members(params.id)
      }),
      setMember: Effect.fn(function*({ params, payload }) {
        const actor = yield* myRole(params.id)
        const current = yield* organizations.role(params.id, params.userId)
        if (!Access.canSetRole(actor, current, payload.role)) {
          return yield* new InsufficientRoleError({
            organizationId: params.id,
            detail: `a ${actor} may not make ${params.userId} ${payload.role}`
          })
        }
        return yield* organizations.setMember(params.id, params.userId, payload.role)
      }),
      removeMember: Effect.fn(function*({ params }) {
        const actor = yield* myRole(params.id)
        const target = yield* organizations.role(params.id, params.userId)
        if (Option.isNone(target)) return
        if (!Access.canRemove(actor, target.value)) {
          return yield* new InsufficientRoleError({
            organizationId: params.id,
            detail: `a ${actor} may not remove ${params.userId}, ${target.value}`
          })
        }
        yield* organizations.removeMember(params.id, params.userId)
      })
    })
  })
)

const login = HttpApiBuilder.group(
  WorkbenchApi,
  "login",
  Effect.fn(function*(handlers) {
    const identity = yield* Identity
    return handlers.handle("login", ({ payload }) => identity.login(payload.userId, payload.password))
  })
)

const account = HttpApiBuilder.group(
  WorkbenchApi,
  "account",
  Effect.fn(function*(handlers) {
    const identity = yield* Identity
    return handlers.handleAll({
      register: ({ payload }) => identity.register(payload.userId, payload.password),
      setPassword: Effect.fn(function*({ payload }) {
        yield* identity.setPassword(yield* CurrentUser, payload.password)
      }),
      logout: ({ payload }) => identity.logout(payload.token)
    })
  })
)

const catalog = HttpApiBuilder.group(
  WorkbenchApi,
  "catalog",
  Effect.fn(function*(handlers) {
    const read = yield* Catalog
    return handlers.handle("get", () => read)
  })
)

export const routes = HttpApiBuilder.layer(WorkbenchApi).pipe(
  Layer.provide([me, conversations, agents, sessions, organizationsGroup, login, account, catalog])
)
