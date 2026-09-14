/**
 * `WorkbenchApi` served over the store services. The handlers add nothing:
 * whichever `ConversationStore` and `AgentRegistry` the server is given --
 * SQL in a deployment -- is what a remote caller reaches.
 */
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { WorkbenchApi } from "../protocol/WorkbenchApi.js"
import { AgentRegistry } from "../store/AgentRegistry.js"
import { ConversationStore } from "../store/ConversationStore.js"

const conversations = HttpApiBuilder.group(
  WorkbenchApi,
  "conversations",
  Effect.fn(function*(handlers) {
    const store = yield* ConversationStore
    return handlers.handleAll({
      list: ({ query }) => store.list(query),
      get: ({ params }) => store.get(params.id),
      create: ({ payload }) => store.create(payload),
      update: ({ params, payload }) => store.update(params.id, payload),
      remove: ({ params }) => store.remove(params.id)
    })
  })
)

const agents = HttpApiBuilder.group(
  WorkbenchApi,
  "agents",
  Effect.fn(function*(handlers) {
    const registry = yield* AgentRegistry
    return handlers.handleAll({
      list: ({ query }) => registry.list(query.ownerId),
      get: ({ params }) => registry.get(params.id),
      revisions: ({ params }) => registry.revisions(params.id),
      revision: ({ params }) => registry.revision(params.id),
      create: ({ payload }) => registry.create(payload),
      revise: ({ params, payload }) => registry.revise(params.id, payload.input, payload.by),
      archive: ({ params }) => registry.archive(params.id)
    })
  })
)

export const routes = HttpApiBuilder.layer(WorkbenchApi).pipe(Layer.provide([conversations, agents]))
