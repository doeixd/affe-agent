/**
 * The workbench's product protocol (plan-workbench.md W1, W12).
 *
 * Product records only: conversations and agents. Prompting, events,
 * interruption and approvals stay on `AgentHttp` and the framework's own
 * schemas, so nothing here duplicates `AgentProtocol`.
 */
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { AgentRevision, AgentSpec, RevisionInput } from "../domain/AgentRevision.js"
import * as Conversation from "../domain/Conversation.js"
import { AgentId, AgentRevisionId, ConversationId, UserId } from "../domain/WorkbenchIds.js"
import { AgentNotFoundError, Created, NewAgent } from "../store/AgentRegistry.js"
import { ConversationExistsError, ConversationNotFoundError } from "../store/ConversationStore.js"
import { WorkbenchStorageError } from "../store/WorkbenchStorageError.js"

export class ConversationsGroup extends HttpApiGroup.make("conversations").add(
  HttpApiEndpoint.get("list", "/conversations", {
    query: { ownerId: UserId, includeArchived: Schema.optional(Schema.Boolean) },
    success: Schema.Array(Conversation.Record),
    error: WorkbenchStorageError
  }),
  HttpApiEndpoint.get("get", "/conversations/:id", {
    params: { id: ConversationId },
    success: Schema.Option(Conversation.Record),
    error: WorkbenchStorageError
  }),
  HttpApiEndpoint.post("create", "/conversations", {
    payload: Conversation.New,
    success: Conversation.Record,
    error: [ConversationExistsError, WorkbenchStorageError]
  }),
  HttpApiEndpoint.patch("update", "/conversations/:id", {
    params: { id: ConversationId },
    payload: Conversation.Patch,
    success: Conversation.Record,
    error: [ConversationNotFoundError, WorkbenchStorageError]
  }),
  HttpApiEndpoint.delete("remove", "/conversations/:id", {
    params: { id: ConversationId },
    error: WorkbenchStorageError
  })
) {}

export class AgentsGroup extends HttpApiGroup.make("agents").add(
  HttpApiEndpoint.get("list", "/agents", {
    query: { ownerId: UserId },
    success: Schema.Array(AgentSpec),
    error: WorkbenchStorageError
  }),
  HttpApiEndpoint.get("get", "/agents/:id", {
    params: { id: AgentId },
    success: Schema.Option(AgentSpec),
    error: WorkbenchStorageError
  }),
  HttpApiEndpoint.get("revisions", "/agents/:id/revisions", {
    params: { id: AgentId },
    success: Schema.Array(AgentRevision),
    error: WorkbenchStorageError
  }),
  HttpApiEndpoint.get("revision", "/revisions/:id", {
    params: { id: AgentRevisionId },
    success: Schema.Option(AgentRevision),
    error: WorkbenchStorageError
  }),
  HttpApiEndpoint.post("create", "/agents", {
    payload: NewAgent,
    success: Created,
    error: WorkbenchStorageError
  }),
  HttpApiEndpoint.post("revise", "/agents/:id/revisions", {
    params: { id: AgentId },
    payload: Schema.Struct({ input: RevisionInput, by: UserId }),
    success: AgentRevision,
    error: [AgentNotFoundError, WorkbenchStorageError]
  }),
  HttpApiEndpoint.post("archive", "/agents/:id/archive", {
    params: { id: AgentId },
    error: [AgentNotFoundError, WorkbenchStorageError]
  })
) {}

export class WorkbenchApi extends HttpApi.make("workbench").add(ConversationsGroup).add(AgentsGroup) {}
