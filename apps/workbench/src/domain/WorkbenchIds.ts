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

/** A named agent, across all its revisions (control plane §6). */
export const AgentId = Schema.String.pipe(Schema.brand("workbench/AgentId"))
export type AgentId = typeof AgentId.Type

/** One immutable configuration of an agent. */
export const AgentRevisionId = Schema.String.pipe(Schema.brand("workbench/AgentRevisionId"))
export type AgentRevisionId = typeof AgentRevisionId.Type

/** The SaaS/product tenant (control plane §5). Not `Sandbox.Workspace`, and not `WorkspaceId`. */
export const OrganizationId = Schema.String.pipe(Schema.brand("workbench/OrganizationId"))
export type OrganizationId = typeof OrganizationId.Type

/** A product work item (control plane §8). Not a kernel submission. */
export const TaskId = Schema.String.pipe(Schema.brand("workbench/TaskId"))
export type TaskId = typeof TaskId.Type
