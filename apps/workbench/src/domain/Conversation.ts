/**
 * Product metadata about a conversation and the agent revision it talks to.
 *
 * Deliberately not the conversation itself: canonical history belongs to the
 * session, reached through `AgentClient`. A record joins product identity to
 * that session by its stable id and nothing more.
 */
import { Effect, Option, Schema } from "effect"
import { AgentId, AgentRevisionId, ConversationId, UserId, WorkspaceId } from "./WorkbenchIds.js"

export const Record = Schema.Struct({
  id: ConversationId,
  ownerId: UserId,
  agentId: AgentId,
  /**
   * The revision the conversation was created on, and keeps running on.
   * Editing the agent changes what *new* conversations get; an existing one
   * reopens exactly as it was configured (decisions-2026-09-11.md, D6).
   */
  agentRevisionId: AgentRevisionId,
  /**
   * The model profile the conversation chose, in place of its revision's --
   * pinned like the revision, so a conversation never changes model under
   * itself; another model is a branch. `None` runs the revision's own, and
   * is what a record written before this field decodes as.
   */
  modelProfile: Schema.Option(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(Option.none()))),
  /** The kernel session this conversation is. Stable, so opening it again reaches the same one. */
  sessionId: Schema.String,
  workspaceId: Schema.Option(WorkspaceId),
  title: Schema.String,
  archived: Schema.Boolean,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
})
export type Record = typeof Record.Type

/** What a caller supplies; the store stamps the rest. */
export const New = Schema.Struct({
  id: ConversationId,
  ownerId: UserId,
  agentId: AgentId,
  agentRevisionId: AgentRevisionId,
  /** Omit for the revision's own model. */
  modelProfile: Schema.optional(Schema.String),
  sessionId: Schema.String,
  workspaceId: Schema.Option(WorkspaceId),
  title: Schema.String
})
export type New = typeof New.Type

export const Patch = Schema.Struct({
  title: Schema.optional(Schema.String),
  archived: Schema.optional(Schema.Boolean)
})
export type Patch = typeof Patch.Type

export interface Query {
  readonly ownerId: UserId
  readonly includeArchived?: boolean | undefined
}
