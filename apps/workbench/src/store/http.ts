/**
 * `ConversationStore` and `AgentRegistry` over `WorkbenchApi`: the same
 * services, with the product database behind a server. A browser composes
 * `ConversationSessions` from these exactly as a server composes it from the
 * SQL ones (W8).
 *
 * The typed refusals cross as themselves. Anything else the transport can
 * fail with -- the network, a response that does not decode -- is the store
 * being unreachable, and is named as `WorkbenchStorageError`.
 */
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { WorkbenchApi } from "../protocol/WorkbenchApi.js"
import { AgentRegistry } from "./AgentRegistry.js"
import { ConversationStore } from "./ConversationStore.js"
import { failedAs } from "./WorkbenchStorageError.js"

const client = (baseUrl: string) =>
  HttpApiClient.make(WorkbenchApi, {
    transformClient: HttpClient.mapRequest(HttpClientRequest.prependUrl(baseUrl))
  })

/** Keep the store's own errors; anything else is the store being unreachable. */
const transport = (operation: string) =>
<A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchIf(
    effect,
    (error): error is Exclude<E, { readonly _tag: "ConversationExistsError" | "ConversationNotFoundError" | "AgentNotFoundError" | "WorkbenchStorageError" }> =>
      error._tag !== "ConversationExistsError" &&
      error._tag !== "ConversationNotFoundError" &&
      error._tag !== "AgentNotFoundError" &&
      error._tag !== "WorkbenchStorageError",
    (error) => Effect.fail(failedAs(operation)(error))
  )

export const conversationStore = (options: {
  readonly baseUrl: string
}): Layer.Layer<ConversationStore, never, HttpClient.HttpClient> =>
  Layer.effect(
    ConversationStore,
    Effect.map(client(options.baseUrl), (api) =>
      ConversationStore.of({
        list: (query) => api.conversations.list({ query }).pipe(transport("ConversationStore.list")),
        get: (id) => api.conversations.get({ params: { id } }).pipe(transport("ConversationStore.get")),
        create: (record) => api.conversations.create({ payload: record }).pipe(transport("ConversationStore.create")),
        update: (id, patch) =>
          api.conversations.update({ params: { id }, payload: patch }).pipe(transport("ConversationStore.update")),
        remove: (id) => api.conversations.remove({ params: { id } }).pipe(transport("ConversationStore.remove"))
      }))
  )

export const agentRegistry = (options: {
  readonly baseUrl: string
}): Layer.Layer<AgentRegistry, never, HttpClient.HttpClient> =>
  Layer.effect(
    AgentRegistry,
    Effect.map(client(options.baseUrl), (api) =>
      AgentRegistry.of({
        list: (ownerId) => api.agents.list({ query: { ownerId } }).pipe(transport("AgentRegistry.list")),
        get: (id) => api.agents.get({ params: { id } }).pipe(transport("AgentRegistry.get")),
        revisions: (id) => api.agents.revisions({ params: { id } }).pipe(transport("AgentRegistry.revisions")),
        revision: (id) => api.agents.revision({ params: { id } }).pipe(transport("AgentRegistry.revision")),
        create: (input) => api.agents.create({ payload: input }).pipe(transport("AgentRegistry.create")),
        revise: (id, input, by) =>
          api.agents.revise({ params: { id }, payload: { input, by } }).pipe(transport("AgentRegistry.revise")),
        archive: (id) => api.agents.archive({ params: { id } }).pipe(transport("AgentRegistry.archive"))
      }))
  )
