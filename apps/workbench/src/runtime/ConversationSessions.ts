/**
 * Product identity joined to execution identity (plan-workbench.md §5).
 *
 * Returns the existing `RemoteSession` rather than wrapping it: after `create`
 * or `open`, a caller prompts, steers, interrupts and responds through the
 * session's own typed methods, so no parallel "workbench run API" can grow.
 */
import { Context, Effect, Layer, Option, Schema, Scope } from "effect"
import type { AgentClient } from "affe-agent/client"
import type * as Conversation from "../domain/Conversation.js"
import { ConversationId } from "../domain/WorkbenchIds.js"
import type { AgentId, UserId, WorkspaceId } from "../domain/WorkbenchIds.js"
import { AgentNotFoundError, AgentRegistry } from "../store/AgentRegistry.js"
import { ConversationNotFoundError, ConversationStore } from "../store/ConversationStore.js"
import type { ConversationExistsError } from "../store/ConversationStore.js"
import type { WorkbenchStorageError } from "../store/WorkbenchStorageError.js"
import * as Branch from "../ui-core/Branch.js"
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
  /** A model profile in place of the revision's; pinned for the conversation's life. */
  readonly modelProfile?: string | undefined
  /**
   * Supply it to make a retry the same conversation. A retry after the record
   * was written opens that conversation rather than failing; one after only
   * the session was made asks for the same session id again, which a durable
   * client can answer.
   */
  readonly conversationId?: ConversationId | undefined
}

/** A branch asked for a point the source's history does not reach. */
export class BranchPointMissingError extends Schema.TaggedError<BranchPointMissingError>()("BranchPointMissingError", {
  conversationId: ConversationId,
  ordinal: Schema.Number
}) {}

export interface BranchInput {
  /** The conversation branched from. */
  readonly from: ConversationId
  /** Branch just before the person's `ordinal`-th message (from 0). */
  readonly ordinal: number
  readonly title?: string | undefined
  /** Another model for the branch; omit to keep the source's. */
  readonly modelProfile?: string | undefined
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
    | WorkbenchStorageError
    | AgentClient.RemoteError
  >
  /**
   * A new conversation holding the source's history up to, not including,
   * the person's `ordinal`-th message -- on the source's agent *revision*,
   * not its active one, so a branch runs what the original ran (D6). The
   * source is not touched.
   */
  readonly branch: (
    input: BranchInput
  ) => Effect.Effect<
    OpenConversation,
    | BranchPointMissingError
    | ConversationNotFoundError
    | ConversationExistsError
    | RevisionResolutionError
    | WorkbenchStorageError
    | AgentClient.RemoteError
  >
  /** On the revision the conversation was created on. */
  readonly open: (
    id: ConversationId
  ) => Effect.Effect<
    OpenConversation,
    ConversationNotFoundError | RevisionResolutionError | WorkbenchStorageError | AgentClient.RemoteError
  >
}

export class ConversationSessions extends Context.Service<ConversationSessions, Service>()(
  "workbench/ConversationSessions"
) {}

const sessionPrefix = "conversation-"

/** One conversation is one session, so the session is named after it. */
export const sessionIdOf = (id: ConversationId): string => `${sessionPrefix}${id}`

/** The conversation a session is, when it is one: how a host authorizes a session by its conversation's owner. */
export const conversationIdOf = (sessionId: string): Option.Option<ConversationId> =>
  sessionId.startsWith(sessionPrefix) && sessionId.length > sessionPrefix.length
    ? Option.some(ConversationId.make(sessionId.slice(sessionPrefix.length)))
    : Option.none()

export const layer: Layer.Layer<ConversationSessions, never, ConversationStore | AgentRegistry | AgentDirectory> =
  Layer.effect(
    ConversationSessions,
    Effect.gen(function*() {
      const store = yield* ConversationStore
      const registry = yield* AgentRegistry
      const directory = yield* AgentDirectory
      const lifetime = yield* Effect.scope

      /**
       * The conversation's session, made if it does not exist yet.
       *
       * A record can outlive the attempt that was to make its session -- the
       * session call failed, or the process stopped between the two -- so
       * reaching a conversation is also what finishes creating it. Two callers
       * racing to make it meet at the one that won. The session belongs to the
       * conversation, not to the call: it lives as long as this service.
       */
      const sessionOf = (conversation: Conversation.Record) =>
        Effect.flatMap(directory.client(conversation.agentRevisionId, conversation.modelProfile), (client) =>
          client.session(conversation.sessionId).pipe(
            Effect.catchTag("AgentSessionNotFoundError", () =>
              client.createSession({ sessionId: conversation.sessionId }).pipe(
                Scope.provide(lifetime),
                Effect.catchTag("AgentSessionAlreadyExistsError", () => client.session(conversation.sessionId))
              ))
          ))

      const open = Effect.fn("ConversationSessions.open")(function*(id: ConversationId) {
        const found = yield* store.get(id)
        if (Option.isNone(found)) {
          return yield* new ConversationNotFoundError({ conversationId: id })
        }
        return { conversation: found.value, session: yield* sessionOf(found.value) }
      })

      // Record first, session second. A server routing sessions to agents
      // finds a session's agent through its conversation, so the record must
      // exist when the session is made; a record whose session never got made
      // gets it on the next open, so neither order of failure strands anything.
      const create = Effect.fn("ConversationSessions.create")(function*(input: CreateInput) {
        const id = input.conversationId ?? ConversationId.make(globalThis.crypto.randomUUID())
        if (Option.isSome(yield* store.get(id))) {
          return yield* open(id)
        }
        const agent = yield* registry.get(input.agentId)
        if (Option.isNone(agent)) {
          return yield* new AgentNotFoundError({ agentId: input.agentId })
        }
        const conversation = yield* store.create({
          id,
          ownerId: input.ownerId,
          agentId: input.agentId,
          agentRevisionId: agent.value.activeRevisionId,
          sessionId: sessionIdOf(id),
          workspaceId: Option.fromNullishOr(input.workspaceId),
          ...(input.modelProfile === undefined ? {} : { modelProfile: input.modelProfile }),
          title: input.title
        })
        return { conversation, session: yield* sessionOf(conversation) }
      })

      const branch = Effect.fn("ConversationSessions.branch")(function*(input: BranchInput) {
        const source = yield* open(input.from)
        const seed = Branch.before(yield* source.session.history, input.ordinal)
        if (Option.isNone(seed)) {
          return yield* new BranchPointMissingError({ conversationId: input.from, ordinal: input.ordinal })
        }
        const id = ConversationId.make(globalThis.crypto.randomUUID())
        const conversation = yield* store.create({
          id,
          ownerId: source.conversation.ownerId,
          agentId: source.conversation.agentId,
          agentRevisionId: source.conversation.agentRevisionId,
          ...Option.match(Option.orElse(Option.fromNullishOr(input.modelProfile), () => source.conversation.modelProfile), {
            onNone: () => ({}),
            onSome: (modelProfile) => ({ modelProfile })
          }),
          sessionId: sessionIdOf(id),
          workspaceId: source.conversation.workspaceId,
          title: input.title ?? `${source.conversation.title} (edited)`
        })
        const client = yield* directory.client(conversation.agentRevisionId, conversation.modelProfile)
        const session = yield* client.createSession({ sessionId: conversation.sessionId, history: seed.value }).pipe(
          Scope.provide(lifetime),
          // A retry after the session was made reaches the one that exists; its seed is already in it.
          Effect.catchTag("AgentSessionAlreadyExistsError", () => client.session(conversation.sessionId))
        )
        return { conversation, session }
      })

      return ConversationSessions.of({ create, open, branch })
    })
  )
