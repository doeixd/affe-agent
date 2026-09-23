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
import * as Task from "../domain/Task.js"
import { AgentId, AgentRevisionId, ConversationId, OrganizationId, TaskId, UserId } from "../domain/WorkbenchIds.js"
import * as Catalog from "../runtime/Catalog.js"
import { AgentNotFoundError, Created, NewAgent } from "../store/AgentRegistry.js"
import { ConversationExistsError, ConversationNotFoundError } from "../store/ConversationStore.js"
import * as InboxStore from "../store/InboxStore.js"
import { TaskNotFoundError } from "../store/TaskStore.js"
import { TaskNotStartableError } from "../runtime/TaskRunner.js"
import { LastOwnerError, OrganizationNotFoundError } from "../store/OrganizationStore.js"
import * as SessionIndex from "../store/SessionIndex.js"
import { WorkbenchStorageError } from "../store/WorkbenchStorageError.js"
import {
  Authenticated,
  ForeignOwnerError,
  InsufficientRoleError,
  InvalidCredentialsError,
  Issued,
  Login,
  Password,
  UserExistsError
} from "./Authentication.js"

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

/** The one route a stranger may call: proving a password earns a token. */
export class LoginGroup extends HttpApiGroup.make("login").add(
  HttpApiEndpoint.post("login", "/login", {
    payload: Login,
    success: Issued,
    error: [InvalidCredentialsError, WorkbenchStorageError]
  })
) {}

/**
 * Accounts. Registering takes a signed-in caller -- the configured local
 * token is how the first account is made; open sign-up is a deployment
 * decision this does not make. A password change ends every session it had
 * opened; logging out ends the one token named.
 */
export class AccountGroup extends HttpApiGroup.make("account").add(
  HttpApiEndpoint.post("register", "/users", {
    payload: Login,
    error: [UserExistsError, WorkbenchStorageError]
  }),
  HttpApiEndpoint.put("setPassword", "/me/password", {
    payload: Schema.Struct({ password: Password }),
    error: WorkbenchStorageError
  }),
  HttpApiEndpoint.post("logout", "/logout", {
    payload: Schema.Struct({ token: Schema.String }),
    error: WorkbenchStorageError
  })
).middleware(Authenticated) {}

/** What a revision may name on this deployment: the settings page's choices. */
export class CatalogGroup extends HttpApiGroup.make("catalog").add(
  HttpApiEndpoint.get("get", "/catalog", { success: Catalog.View, error: WorkbenchStorageError })
).middleware(Authenticated) {}

/** Needs You (control plane §11): every question waiting on the caller, oldest first. Answered on the session, not here. */
export class InboxGroup extends HttpApiGroup.make("inbox").add(
  HttpApiEndpoint.get("list", "/inbox", { success: Schema.Array(InboxStore.Item), error: WorkbenchStorageError })
).middleware(Authenticated) {}

/**
 * Tasks (control plane §8): the caller's work items, their attempts, and the
 * two things a person does to one -- start it, stop it. Status is read, never
 * set, here: the runner's projection sets it from the session.
 */
export class TasksGroup extends HttpApiGroup.make("tasks").add(
  HttpApiEndpoint.get("list", "/tasks", { success: Schema.Array(Task.Record), error: WorkbenchStorageError }),
  HttpApiEndpoint.get("get", "/tasks/:id", {
    params: { id: TaskId },
    success: Schema.Option(Schema.Struct({ task: Task.Record, attempts: Schema.Array(Task.Attempt) })),
    error: WorkbenchStorageError
  }),
  HttpApiEndpoint.post("create", "/tasks", {
    payload: Task.New,
    success: Task.Record,
    error: [ForeignOwnerError, AgentNotFoundError, WorkbenchStorageError]
  }),
  HttpApiEndpoint.post("start", "/tasks/:id/start", {
    params: { id: TaskId },
    success: Task.Attempt,
    error: [TaskNotFoundError, TaskNotStartableError, AgentNotFoundError, WorkbenchStorageError]
  }),
  HttpApiEndpoint.post("queue", "/tasks/:id/queue", {
    params: { id: TaskId },
    success: Task.Record,
    error: [TaskNotFoundError, TaskNotStartableError, WorkbenchStorageError]
  }),
  HttpApiEndpoint.post("cancel", "/tasks/:id/cancel", {
    params: { id: TaskId },
    error: [TaskNotFoundError, TaskNotStartableError, WorkbenchStorageError]
  })
).middleware(Authenticated) {}

export class WorkbenchApi extends HttpApi.make("workbench")
  .add(MeGroup)
  .add(ConversationsGroup)
  .add(AgentsGroup)
  .add(SessionsGroup)
  .add(OrganizationsGroup)
  .add(LoginGroup)
  .add(AccountGroup)
  .add(CatalogGroup)
  .add(InboxGroup)
  .add(TasksGroup)
{}
