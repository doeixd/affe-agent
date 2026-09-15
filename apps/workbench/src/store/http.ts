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
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import type { UserId } from "../domain/WorkbenchIds.js"
import { bearer } from "../protocol/Authentication.js"
import { WorkbenchApi } from "../protocol/WorkbenchApi.js"
import { AgentRegistry } from "./AgentRegistry.js"
import { ConversationStore } from "./ConversationStore.js"
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

type Kept = "ConversationExistsError" | "ConversationNotFoundError" | "AgentNotFoundError" | "WorkbenchStorageError"

const kept: ReadonlySet<string> = new Set<Kept>([
  "ConversationExistsError",
  "ConversationNotFoundError",
  "AgentNotFoundError",
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

/** Who the server says the token belongs to. */
export const currentUser = (options: Options): Effect.Effect<UserId, WorkbenchStorageError, HttpClient.HttpClient> =>
  Effect.flatMap(client(options), (api) => api.me.get()).pipe(transport("currentUser"))

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
        list: () => api.agents.list().pipe(transport("AgentRegistry.list")),
        get: (id) => api.agents.get({ params: { id } }).pipe(transport("AgentRegistry.get")),
        revisions: (id) => api.agents.revisions({ params: { id } }).pipe(transport("AgentRegistry.revisions")),
        revision: (id) => api.agents.revision({ params: { id } }).pipe(transport("AgentRegistry.revision")),
        create: (input) => api.agents.create({ payload: input }).pipe(transport("AgentRegistry.create")),
        // The server records the caller as the author, whoever `by` names.
        revise: (id, input) => api.agents.revise({ params: { id }, payload: input }).pipe(transport("AgentRegistry.revise")),
        archive: (id) => api.agents.archive({ params: { id } }).pipe(transport("AgentRegistry.archive"))
      }))
  )
