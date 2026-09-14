/**
 * Product identity joined to execution identity (plan-workbench.md §5).
 *
 * Returns the existing `RemoteSession` rather than wrapping it: after `create`
 * or `open`, a caller prompts, steers, interrupts and responds through the
 * session's own typed methods, so no parallel "workbench run API" can grow.
 */
import { Context, Effect, Layer, Option } from "effect"
import type { Scope } from "effect"
import type { AgentClient } from "affe-agent/client"
import type * as Conversation from "../domain/Conversation.js"
import { ConversationId } from "../domain/WorkbenchIds.js"
import type { AgentProfileId, UserId, WorkspaceId } from "../domain/WorkbenchIds.js"
import { ConversationNotFoundError, ConversationStore } from "../store/ConversationStore.js"
import type { ConversationExistsError } from "../store/ConversationStore.js"
import { AgentDirectory } from "./AgentDirectory.js"
import type { AgentResolutionError } from "./AgentDirectory.js"

export interface OpenConversation {
  readonly conversation: Conversation.Record
  readonly session: AgentClient.RemoteSession
}

export interface CreateInput {
  readonly ownerId: UserId
  readonly agentProfileId: AgentProfileId
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
  readonly create: (
    input: CreateInput
  ) => Effect.Effect<
    OpenConversation,
    AgentResolutionError | ConversationExistsError | AgentClient.RemoteError,
    Scope.Scope
  >
  readonly open: (
    id: ConversationId
  ) => Effect.Effect<
    OpenConversation,
    ConversationNotFoundError | AgentResolutionError | AgentClient.RemoteError,
    Scope.Scope
  >
}

export class ConversationSessions extends Context.Service<ConversationSessions, Service>()(
  "workbench/ConversationSessions"
) {}

/** One conversation is one session, so the session is named after it. */
export const sessionIdOf = (id: ConversationId): string => `conversation-${id}`

export const layer: Layer.Layer<ConversationSessions, never, ConversationStore | AgentDirectory> = Layer.effect(
  ConversationSessions,
  Effect.gen(function*() {
    const store = yield* ConversationStore
    const directory = yield* AgentDirectory

    // Session first, record second. The other order would publish a record
    // whose session may never exist; this order can leave a session no record
    // names, which a retry under the same `conversationId` reaches again.
    const create = Effect.fn("ConversationSessions.create")(function*(input: CreateInput) {
      const id = input.conversationId ?? ConversationId.make(globalThis.crypto.randomUUID())
      const existing = yield* store.get(id)
      if (Option.isSome(existing)) {
        const client = yield* directory.client(existing.value.agentProfileId)
        return { conversation: existing.value, session: yield* client.session(existing.value.sessionId) }
      }
      const client = yield* directory.client(input.agentProfileId)
      const session = yield* client.createSession({ sessionId: sessionIdOf(id) })
      const conversation = yield* store.create({
        id,
        ownerId: input.ownerId,
        agentProfileId: input.agentProfileId,
        sessionId: session.id,
        workspaceId: Option.fromNullishOr(input.workspaceId),
        title: input.title
      })
      return { conversation, session }
    })

    const open = Effect.fn("ConversationSessions.open")(function*(id: ConversationId) {
      const found = yield* store.get(id)
      if (Option.isNone(found)) {
        return yield* new ConversationNotFoundError({ conversationId: id })
      }
      const client = yield* directory.client(found.value.agentProfileId)
      const session = yield* client.session(found.value.sessionId)
      return { conversation: found.value, session }
    })

    return ConversationSessions.of({ create, open })
  })
)
