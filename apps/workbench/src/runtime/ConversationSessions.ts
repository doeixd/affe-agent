/**
 * Product identity joined to execution identity (plan-workbench.md §5).
 *
 * Returns the existing `RemoteSession` rather than wrapping it: after `create`
 * or `open`, a caller prompts, steers, interrupts and responds through the
 * session's own typed methods, so no parallel "workbench run API" can grow.
 */
import { Context, Effect, Layer, Option, Scope } from "effect"
import type { AgentClient } from "affe-agent/client"
import type * as Conversation from "../domain/Conversation.js"
import { ConversationId } from "../domain/WorkbenchIds.js"
import type { AgentId, UserId, WorkspaceId } from "../domain/WorkbenchIds.js"
import { AgentNotFoundError, AgentRegistry } from "../store/AgentRegistry.js"
import { ConversationNotFoundError, ConversationStore } from "../store/ConversationStore.js"
import type { ConversationExistsError } from "../store/ConversationStore.js"
import { AgentDirectory } from "./AgentDirectory.js"
import type { RevisionResolutionError } from "./AgentResolver.js"

export interface OpenConversation {
  readonly conversation: Conversation.Record
  readonly session: AgentClient.RemoteSession
}

export interface CreateInput {
  readonly ownerId: UserId
  readonly agentId: AgentId
  readonly title: string
  readonly workspaceId?: WorkspaceId | undefined
  /**
   * Supply it to make a retry the same conversation. A retry after the record
   * was written opens that conversation rather than failing; one after only
   * the session was made asks for the same session id again, which a durable
   * client can answer.
   */
  readonly conversationId?: ConversationId | undefined
}

export interface Service {
  /** On the agent's active revision, which the conversation then keeps. */
  readonly create: (
    input: CreateInput
  ) => Effect.Effect<
    OpenConversation,
    | AgentNotFoundError
    | RevisionResolutionError
    | ConversationExistsError
    // A retry opens the existing record, which can be removed in between.
    | ConversationNotFoundError
    | AgentClient.RemoteError
  >
  /** On the revision the conversation was created on. */
  readonly open: (
    id: ConversationId
  ) => Effect.Effect<OpenConversation, ConversationNotFoundError | RevisionResolutionError | AgentClient.RemoteError>
}

export class ConversationSessions extends Context.Service<ConversationSessions, Service>()(
  "workbench/ConversationSessions"
) {}

/** One conversation is one session, so the session is named after it. */
export const sessionIdOf = (id: ConversationId): string => `conversation-${id}`

export const layer: Layer.Layer<ConversationSessions, never, ConversationStore | AgentRegistry | AgentDirectory> =
  Layer.effect(
    ConversationSessions,
    Effect.gen(function*() {
      const store = yield* ConversationStore
      const registry = yield* AgentRegistry
      const directory = yield* AgentDirectory
      const lifetime = yield* Effect.scope

      const open = Effect.fn("ConversationSessions.open")(function*(id: ConversationId) {
        const found = yield* store.get(id)
        if (Option.isNone(found)) {
          return yield* new ConversationNotFoundError({ conversationId: id })
        }
        const client = yield* directory.client(found.value.agentRevisionId)
        const session = yield* client.session(found.value.sessionId)
        return { conversation: found.value, session }
      })

      // Session first, record second. The other order would publish a record
      // whose session may never exist; this order can leave a session no record
      // names, which a retry under the same `conversationId` reaches again.
      const create = Effect.fn("ConversationSessions.create")(function*(input: CreateInput) {
        const id = input.conversationId ?? ConversationId.make(globalThis.crypto.randomUUID())
        if (Option.isSome(yield* store.get(id))) {
          return yield* open(id)
        }
        const agent = yield* registry.get(input.agentId)
        if (Option.isNone(agent)) {
          return yield* new AgentNotFoundError({ agentId: input.agentId })
        }
        const revisionId = agent.value.activeRevisionId
        const client = yield* directory.client(revisionId)
        // The session belongs to the conversation, not to this call: it lives
        // as long as this service, which is what lets `open` find it again.
        const session = yield* client.createSession({ sessionId: sessionIdOf(id) }).pipe(Scope.provide(lifetime))
        const conversation = yield* store.create({
          id,
          ownerId: input.ownerId,
          agentId: input.agentId,
          agentRevisionId: revisionId,
          sessionId: session.id,
          workspaceId: Option.fromNullishOr(input.workspaceId),
          title: input.title
        })
        return { conversation, session }
      })

      return ConversationSessions.of({ create, open })
    })
  )
