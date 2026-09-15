/**
 * One `AgentClient` over every agent the product has (plan-workbench.md §16).
 *
 * `AgentSessionHost` serves a single client, while each conversation runs the
 * agent revision it was created on. This client routes: a session is a
 * conversation's (`conversationIdOf`), the conversation names its revision,
 * and `AgentDirectory` holds that revision's resolved client. It is routing,
 * not a new protocol -- every call is the resolved client's own.
 *
 * A session no conversation names does not exist here, and making one is
 * refused: without a record there is no agent to make it with.
 */
import { Effect, Layer, Option } from "effect"
import { AgentClient, AgentProtocol } from "affe-agent/client"
import { AgentDirectory } from "../runtime/AgentDirectory.js"
import { conversationIdOf } from "../runtime/ConversationSessions.js"
import { ConversationStore } from "../store/ConversationStore.js"

export const layer: Layer.Layer<AgentClient.AgentClient, never, ConversationStore | AgentDirectory> = Layer.effect(
  AgentClient.AgentClient,
  Effect.gen(function*() {
    const store = yield* ConversationStore
    const directory = yield* AgentDirectory

    /** The resolved client of the agent revision a session's conversation runs. */
    const clientFor = Effect.fn("RoutingClient.clientFor")(function*(sessionId: string) {
      const conversationId = conversationIdOf(sessionId)
      if (Option.isNone(conversationId)) {
        return yield* new AgentClient.AgentSessionNotFoundError({ sessionId })
      }
      // The product side could not answer: the session is unreachable for
      // now, which the protocol names as the transport.
      const conversation = yield* store.get(conversationId.value).pipe(
        Effect.mapError((error) => new AgentClient.AgentTransportError({ sessionId, detail: error.message }))
      )
      if (Option.isNone(conversation)) {
        return yield* new AgentClient.AgentSessionNotFoundError({ sessionId })
      }
      return yield* directory.client(conversation.value.agentRevisionId).pipe(
        Effect.mapError((error) =>
          new AgentClient.AgentTransportError({
            sessionId,
            detail: error._tag === "RevisionResolutionError"
              ? `agent revision ${error.revisionId} unavailable: ${error.reason}`
              : error.message
          })
        )
      )
    })

    return AgentClient.AgentClient.of({
      createSession: (options) =>
        options?.sessionId === undefined
          ? Effect.fail(
            new AgentProtocol.AgentInvalidRequestError({
              operation: "createSession",
              detail: "a session is made for a conversation; name it with the conversation's session id"
            })
          )
          : Effect.flatMap(clientFor(options.sessionId), (client) => client.createSession({ sessionId: options.sessionId })),
      session: (sessionId) => Effect.flatMap(clientFor(sessionId), (client) => client.session(sessionId))
    })
  })
)
