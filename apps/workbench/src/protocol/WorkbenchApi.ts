/**
 * The workbench's product protocol (plan-workbench.md W1, W12).
 *
 * Product records only: conversations and agents. Prompting, events,
 * interruption and approvals stay on `AgentHttp` and the framework's own
 * schemas, so nothing here duplicates `AgentProtocol`.
 *
 * Every route is authenticated, and acts as the person asking: no request
 * chooses whose records it reads.
 */
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { AgentRevision, AgentSpec, RevisionInput } from "../domain/AgentRevision.js"
import * as Conversation from "../domain/Conversation.js"
import * as Organization from "../domain/Organization.js"
import { AgentId, AgentRevisionId, ConversationId, OrganizationId, UserId } from "../domain/WorkbenchIds.js"
import { AgentNotFoundError, Created, NewAgent } from "../store/AgentRegistry.js"
import { ConversationExistsError, ConversationNotFoundError } from "../store/ConversationStore.js"
import { LastOwnerError, OrganizationNotFoundError } from "../store/OrganizationStore.js"
import * as SessionIndex from "../store/SessionIndex.js"
import { WorkbenchStorageError } from "../store/WorkbenchStorageError.js"
import { Authenticated, ForeignOwnerError, InsufficientRoleError } from "./Authentication.js"

export class MeGroup extends HttpApiGroup.make("me").add(
  HttpApiEndpoint.get("get", "/me", { success: UserId })
).middleware(Authenticated) {}

export class ConversationsGroup extends HttpApiGroup.make("conversations").add(
  HttpApiEndpoint.get("list", "/conversations", {
    query: { includeArchived: Schema.optional(Schema.Boolean) },
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
    error: [ConversationExistsError, AgentNotFoundError, ForeignOwnerError, WorkbenchStorageError]
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
).middleware(Authenticated) {}

export class AgentsGroup extends HttpApiGroup.make("agents").add(
  HttpApiEndpoint.get("list", "/agents", {
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
    error: [ForeignOwnerError, OrganizationNotFoundError, WorkbenchStorageError]
  }),
  HttpApiEndpoint.post("revise", "/agents/:id/revisions", {
    params: { id: AgentId },
    payload: RevisionInput,
    success: AgentRevision,
    error: [AgentNotFoundError, WorkbenchStorageError]
  }),
  HttpApiEndpoint.post("archive", "/agents/:id/archive", {
    params: { id: AgentId },
    error: [AgentNotFoundError, WorkbenchStorageError]
  })
).middleware(Authenticated) {}

/**
 * What the session index knows (control plane §10): one conversation's
 * session, or every session of the caller's that is running work now. Read
 * models only; the session itself is still reached over `AgentHttp`.
 */
export class SessionsGroup extends HttpApiGroup.make("sessions").add(
  HttpApiEndpoint.get("summary", "/conversations/:id/session", {
    params: { id: ConversationId },
    success: Schema.Option(SessionIndex.Summary),
    error: WorkbenchStorageError
  }),
  HttpApiEndpoint.get("active", "/sessions/active", {
    success: Schema.Array(SessionIndex.Summary),
    error: WorkbenchStorageError
  })
).middleware(Authenticated) {}

/**
 * Organizations and membership (control plane §5). An organization the
 * caller is not in answers as missing, like every other record.
 */
export class OrganizationsGroup extends HttpApiGroup.make("organizations").add(
  HttpApiEndpoint.get("list", "/organizations", {
    success: Schema.Array(Organization.Joined),
    error: WorkbenchStorageError
  }),
  HttpApiEndpoint.post("create", "/organizations", {
    payload: Organization.New,
    success: Organization.Organization,
    error: WorkbenchStorageError
  }),
  HttpApiEndpoint.get("members", "/organizations/:id/members", {
    params: { id: OrganizationId },
    success: Schema.Array(Organization.Membership),
    error: [OrganizationNotFoundError, WorkbenchStorageError]
  }),
  HttpApiEndpoint.put("setMember", "/organizations/:id/members/:userId", {
    params: { id: OrganizationId, userId: UserId },
    payload: Schema.Struct({ role: Organization.Role }),
    success: Organization.Membership,
    error: [OrganizationNotFoundError, InsufficientRoleError, LastOwnerError, WorkbenchStorageError]
  }),
  HttpApiEndpoint.delete("removeMember", "/organizations/:id/members/:userId", {
    params: { id: OrganizationId, userId: UserId },
    error: [OrganizationNotFoundError, InsufficientRoleError, LastOwnerError, WorkbenchStorageError]
  })
).middleware(Authenticated) {}

export class WorkbenchApi extends HttpApi.make("workbench")
  .add(MeGroup)
  .add(ConversationsGroup)
  .add(AgentsGroup)
  .add(SessionsGroup)
  .add(OrganizationsGroup)
{}
