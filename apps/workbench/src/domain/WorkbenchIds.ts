/**
 * Product identities, branded once (plan-workbench.md §1).
 *
 * Only the identities W0 uses. Kernel ids stay kernel ids: a conversation
 * records its `AgentProtocol` session id as the kernel names it.
 */
import { Schema } from "effect"

export const UserId = Schema.String.pipe(Schema.brand("workbench/UserId"))
export type UserId = typeof UserId.Type

export const ConversationId = Schema.String.pipe(Schema.brand("workbench/ConversationId"))
export type ConversationId = typeof ConversationId.Type

export const AgentProfileId = Schema.String.pipe(Schema.brand("workbench/AgentProfileId"))
export type AgentProfileId = typeof AgentProfileId.Type

export const WorkspaceId = Schema.String.pipe(Schema.brand("workbench/WorkspaceId"))
export type WorkspaceId = typeof WorkspaceId.Type
