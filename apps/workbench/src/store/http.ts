/**
 * `ConversationStore` and `AgentRegistry` over `WorkbenchApi`: the same
 * services, with the product database behind a server. A browser composes
 * `ConversationSessions` from these exactly as a server composes it from the
 * SQL ones (W8).
 *
 * Requests carry the person's bearer token, and the server answers as that
 * person: `list`'s `ownerId` is the caller's own whatever is passed, because
 * the server never lets a request choose whose records it reads.
 *
 * The typed refusals cross as themselves. Anything else -- the network, a
 * response that does not decode, a token the server does not know -- is the
 * store being unreachable, and is named as `WorkbenchStorageError`.
 */
import { Effect, Layer, Redacted } from "effect"
import { Option } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import type { ConversationId, UserId } from "../domain/WorkbenchIds.js"
import type { InvalidCredentialsError, Issued, UserExistsError } from "../protocol/Authentication.js"
import { bearer } from "../protocol/Authentication.js"
import { WorkbenchApi } from "../protocol/WorkbenchApi.js"
import { Catalog } from "../runtime/Catalog.js"
import { AgentRegistry } from "./AgentRegistry.js"
import { ConversationStore } from "./ConversationStore.js"
import { OrganizationStore } from "./OrganizationStore.js"
import type * as SessionIndex from "./SessionIndex.js"
import { failedAs } from "./WorkbenchStorageError.js"
import type { WorkbenchStorageError } from "./WorkbenchStorageError.js"

export interface Options {
  readonly baseUrl: string
  readonly token: string
}

const client = (options: Options) =>
  HttpApiClient.make(WorkbenchApi, {
    transformClient: HttpClient.mapRequest(HttpClientRequest.prependUrl(options.baseUrl))
  }).pipe(Effect.provide(bearer(options.token)))

type Kept =
  | "InvalidCredentialsError"
  | "UserExistsError"
  | "ConversationExistsError"
  | "ConversationNotFoundError"
  | "AgentNotFoundError"
  | "OrganizationNotFoundError"
  | "LastOwnerError"
  | "WorkbenchStorageError"

const kept: ReadonlySet<string> = new Set<Kept>([
  "InvalidCredentialsError",
  "UserExistsError",
  "ConversationExistsError",
  "ConversationNotFoundError",
  "AgentNotFoundError",
  "OrganizationNotFoundError",
  "LastOwnerError",
  "WorkbenchStorageError"
])

/** Keep the store's own errors; anything else is the store being unreachable. */
const transport = (operation: string) =>
<A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchIf(
    effect,
    (error): error is Exclude<E, { readonly _tag: Kept }> => !kept.has(error._tag),
    (error) => Effect.fail(failedAs(operation)(error))
  )

/** Prove a password, and get the token every other request carries. The one call made without one. */
export const login = (
  server: { readonly baseUrl: string },
  userId: UserId,
  password: string
): Effect.Effect<Issued, InvalidCredentialsError | WorkbenchStorageError, HttpClient.HttpClient> =>
  Effect.flatMap(client({ baseUrl: server.baseUrl, token: "" }), (api) =>
    api.login.login({ payload: { userId, password: Redacted.make(password) } })).pipe(transport("login"))

/** End this token. */
export const logout = (options: Options): Effect.Effect<void, WorkbenchStorageError, HttpClient.HttpClient> =>
  Effect.flatMap(client(options), (api) => api.account.logout({ payload: { token: options.token } })).pipe(transport("logout"))

/** Make an account, as a signed-in person. */
export const register = (
  options: Options,
  userId: UserId,
  password: string
): Effect.Effect<void, UserExistsError | WorkbenchStorageError, HttpClient.HttpClient> =>
  Effect.flatMap(client(options), (api) => api.account.register({ payload: { userId, password: Redacted.make(password) } }))
    .pipe(transport("register"))

/** Change the caller's own password; every token it had is ended. */
export const setPassword = (options: Options, password: string): Effect.Effect<void, WorkbenchStorageError, HttpClient.HttpClient> =>
  Effect.flatMap(client(options), (api) => api.account.setPassword({ payload: { password: Redacted.make(password) } }))
    .pipe(transport("setPassword"))

/** The deployment's catalog, read once per page load. */
export const catalog = (options: Options): Layer.Layer<Catalog, never, HttpClient.HttpClient> =>
  Layer.effect(
    Catalog,
    Effect.map(client(options), (api) => api.catalog.get().pipe(transport("catalog")))
  )

/** Who the server says the token belongs to. */
export const currentUser = (options: Options): Effect.Effect<UserId, WorkbenchStorageError, HttpClient.HttpClient> =>
  Effect.flatMap(client(options), (api) => api.me.get()).pipe(transport("currentUser"))

/** The index's view of one conversation's session: `None` until it is indexed, or when it is not the caller's. */
export const sessionSummary = (
  options: Options,
  id: ConversationId
): Effect.Effect<Option.Option<SessionIndex.Summary>, WorkbenchStorageError, HttpClient.HttpClient> =>
  Effect.flatMap(client(options), (api) => api.sessions.summary({ params: { id } })).pipe(transport("sessionSummary"))

/** Every session of the caller's that is running work now. */
export const activeSessions = (
  options: Options
): Effect.Effect<ReadonlyArray<SessionIndex.Summary>, WorkbenchStorageError, HttpClient.HttpClient> =>
  Effect.flatMap(client(options), (api) => api.sessions.active()).pipe(transport("activeSessions"))

export const conversationStore = (options: Options): Layer.Layer<ConversationStore, never, HttpClient.HttpClient> =>
  Layer.effect(
    ConversationStore,
    Effect.map(client(options), (api) =>
      ConversationStore.of({
        list: (query) =>
          api.conversations.list({
            query: query.includeArchived === undefined ? {} : { includeArchived: query.includeArchived }
          }).pipe(transport("ConversationStore.list")),
        get: (id) => api.conversations.get({ params: { id } }).pipe(transport("ConversationStore.get")),
        // The server refuses a conversation on an agent the caller does not
        // own as AgentNotFoundError, which a store has no way to say; callers
        // going through ConversationSessions meet that refusal earlier, when
        // it looks the agent up.
        create: (record) =>
          api.conversations.create({ payload: record }).pipe(
            Effect.catchTag("AgentNotFoundError", (error) => Effect.fail(failedAs("ConversationStore.create")(error))),
            transport("ConversationStore.create")
          ),
        update: (id, patch) =>
          api.conversations.update({ params: { id }, payload: patch }).pipe(transport("ConversationStore.update")),
        remove: (id) => api.conversations.remove({ params: { id } }).pipe(transport("ConversationStore.remove"))
      }))
  )

export const agentRegistry = (options: Options): Layer.Layer<AgentRegistry, never, HttpClient.HttpClient> =>
  Layer.effect(
    AgentRegistry,
    Effect.map(client(options), (api) =>
      AgentRegistry.of({
        // The server lists everything the caller may use: their own and their organizations'.
        list: () => api.agents.list().pipe(transport("AgentRegistry.list")),
        listShared: (organizations) =>
          api.agents.list().pipe(
            Effect.map((agents) =>
              agents.filter((agent) =>
                Option.isSome(agent.organizationId) && organizations.includes(agent.organizationId.value))),
            transport("AgentRegistry.listShared")
          ),
        get: (id) => api.agents.get({ params: { id } }).pipe(transport("AgentRegistry.get")),
        revisions: (id) => api.agents.revisions({ params: { id } }).pipe(transport("AgentRegistry.revisions")),
        revision: (id) => api.agents.revision({ params: { id } }).pipe(transport("AgentRegistry.revision")),
        // An organization the caller may not create in answers as missing, which a registry cannot say.
        create: (input) =>
          api.agents.create({ payload: input }).pipe(
            Effect.catchTag("OrganizationNotFoundError", (error) => Effect.fail(failedAs("AgentRegistry.create")(error))),
            transport("AgentRegistry.create")
          ),
        // The server records the caller as the author, whoever `by` names.
        revise: (id, input) => api.agents.revise({ params: { id }, payload: input }).pipe(transport("AgentRegistry.revise")),
        archive: (id) => api.agents.archive({ params: { id } }).pipe(transport("AgentRegistry.archive"))
      }))
  )

export const organizationStore = (options: Options): Layer.Layer<OrganizationStore, never, HttpClient.HttpClient> =>
  Layer.effect(
    OrganizationStore,
    Effect.map(client(options), (api) =>
      OrganizationStore.of({
        // The caller is the owner, whoever `by` names.
        create: (name) => api.organizations.create({ payload: { name } }).pipe(transport("OrganizationStore.create")),
        get: (id) =>
          api.organizations.list().pipe(
            Effect.map((joined) =>
              Option.map(Option.fromNullishOr(joined.find((j) => j.organization.id === id)), (j) => j.organization)),
            transport("OrganizationStore.get")
          ),
        listFor: () => api.organizations.list().pipe(transport("OrganizationStore.listFor")),
        members: (id) =>
          api.organizations.members({ params: { id } }).pipe(
            Effect.catchTag("OrganizationNotFoundError", () => Effect.succeed([])),
            transport("OrganizationStore.members")
          ),
        role: (id, user) =>
          api.organizations.members({ params: { id } }).pipe(
            Effect.map((members) => Option.map(Option.fromNullishOr(members.find((m) => m.userId === user)), (m) => m.role)),
            Effect.catchTag("OrganizationNotFoundError", () => Effect.succeed(Option.none())),
            transport("OrganizationStore.role")
          ),
        // A role the caller may not grant is refused by the server; a store has no word for it.
        setMember: (id, user, role) =>
          api.organizations.setMember({ params: { id, userId: user }, payload: { role } }).pipe(
            Effect.catchTag("InsufficientRoleError", (error) => Effect.fail(failedAs("OrganizationStore.setMember")(error))),
            transport("OrganizationStore.setMember")
          ),
        removeMember: (id, user) =>
          api.organizations.removeMember({ params: { id, userId: user } }).pipe(
            Effect.catchTag("InsufficientRoleError", (error) => Effect.fail(failedAs("OrganizationStore.removeMember")(error))),
            transport("OrganizationStore.removeMember")
          )
      }))
  )
