/**
 * Product metadata about a conversation and the agent it talks to.
 *
 * Deliberately not the conversation itself: canonical history belongs to the
 * session, reached through `AgentClient`. A record joins product identity to
 * that session by its stable id and nothing more.
 */
import { Schema } from "effect"
import { AgentProfileId, ConversationId, UserId, WorkspaceId } from "./WorkbenchIds.js"

export const Record = Schema.Struct({
  id: ConversationId,
  ownerId: UserId,
  agentProfileId: AgentProfileId,
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
export type New = Pick<Record, "id" | "ownerId" | "agentProfileId" | "sessionId" | "workspaceId" | "title">

export interface Patch {
  readonly title?: string | undefined
  readonly archived?: boolean | undefined
}

export interface Query {
  readonly ownerId: UserId
  readonly includeArchived?: boolean | undefined
}

/**
 * A stored agent configuration: declarative data, never a serialized
 * `AgentDefinition`. W0 carries only what a directory needs to tell profiles
 * apart; models, tools and policies arrive with W4.
 */
export const AgentProfile = Schema.Struct({
  id: AgentProfileId,
  ownerId: UserId,
  name: Schema.String,
  instructions: Schema.String
})
export type AgentProfile = typeof AgentProfile.Type
