# Plan: persistent agent product control plane

Written 2026-09-03.

**Status: specified, not implemented.**

This plan turns `@doeixd/effect-agent` into the execution substrate of a
persistent AI-worker product in the product class of Grok Bot, Squad,
Perplexity Computer and similar systems.

It is a companion to [plan-workbench.md](./plan-workbench.md), not a replacement
for it. `plan-workbench.md` specifies the general web application shell and
UI-neutral client architecture. This document goes one level further and
specifies the product concepts required for **named persistent agents that own
work, computers, connections, automations, artifacts and inbox state**.

The central conclusion is simple:

> **Do not build another agent runtime. Build a control plane that compiles
> persistent product records into the `effect-agent` runtime that already
> exists.**

The execution kernel is already unusually complete. The missing work is
primarily product identity, persistence, orchestration, browser/computer
capabilities, and the web experience around them.

---

## 1. What already exists — do not rebuild it

The starting point matters. This plan assumes the current repository, not a
generic chat SDK.

`effect-agent` already owns:

- `AgentDefinition` as executable behaviour;
- sessions, submissions, runs and atomic turns;
- canonical conversation history;
- steering, follow-ups and interruption;
- typed `AgentEvent` lifecycle streams;
- `AgentSessionHost`, `AgentClient` and remote sessions;
- HTTP, RPC, AG-UI, A2A, MCP and OpenAI-compatible frontends;
- `Permission` and `Elicitation`;
- local and durable execution;
- cluster entities and reconnectable delivery streams;
- `Sandbox`, `WorkspaceManager`, coding and shell toolkits;
- `Subagent` and A2A delegation;
- Claude Code and OpenCode bridges;
- `Skills`, `Memory`, `AgentState`, compaction and session trees;
- `ToolSource` over MCP/OpenAPI/GraphQL;
- per-principal credential bindings and refreshing credentials;
- `Scheduling.AgentDispatcher`, queue-backed dispatch and recurrence;
- execution plans/model fallback;
- model metadata and token/cost information;
- token/money budgets;
- `BlobStore` / `BlobWire`;
- `AgentData` typed UI channels;
- web search/fetch;
- observability, hooks, evals, redaction and export;
- a real Cloudflare Durable Object session host;
- TUI and CLI reference applications.

Therefore none of these product features should introduce a second:

- run model;
- session model;
- approval mechanism;
- scheduler runtime;
- memory execution mechanism;
- delegation protocol;
- sandbox abstraction;
- credential value path;
- transcript format.

If a feature can be expressed as composition over those seams, it must be.

---

## 2. The missing layer

The repository currently describes an agent principally as an executable value:

```ts
const Researcher = Agent.make({
  instructions: "Research carefully.",
  toolkit,
  loop
})
```

A persistent agent product needs a second concept:

```text
AgentSpec
  id
  name
  avatar
  instructions
  model policy
  skill references
  capability references
  memory policy
  permission policy
  computer profile
  revision
  ownership
```

The relationship is:

```text
persistent product data
        |
        v
     AgentSpec
        |
     resolve
        |
        v
 AgentDefinition
        |
        v
 effect-agent execution
```

This compile/resolve boundary is the most important new architectural seam.

### Rule

**`AgentDefinition` remains code. `AgentSpec` is data.**

Do not make `AgentDefinition` serializable. Do not put arbitrary closures,
Layers or handlers into a database. Persist references to registries and resolve
those references into executable values at runtime.

---

## 3. Product architecture

```text
+---------------------------------------------------------------------+
|                         Web / mobile UI                              |
|                                                                     |
| Inbox | Agents | Tasks | Projects | Artifacts | Automations         |
| Connections | Computers | Skills | Search | Usage | Settings        |
+-------------------------------+-------------------------------------+
                                |
                    product protocol / clients
                                |
+-------------------------------v-------------------------------------+
|                         CONTROL PLANE                               |
|                                                                     |
| Identity / tenancy                                                  |
| AgentSpec / revisions / registry                                    |
| Projects / tasks / queues                                           |
| Session directory / projections                                     |
| Inbox / notifications                                               |
| Connections / OAuth                                                 |
| Skills / automations                                                 |
| Artifacts / knowledge / provenance                                  |
| Computer allocation                                                 |
| Search / billing / administration                                   |
+-------------------------------+-------------------------------------+
                                |
                    resolve / dispatch / observe
                                |
+-------------------------------v-------------------------------------+
|                  @doeixd/effect-agent                              |
|                                                                     |
| AgentDefinition | AgentSession | AgentClient | AgentEvent           |
| Permission | Elicitation | Scheduling | Memory | Skills             |
| Sandbox | ToolSource | Credentials | Subagent | A2A | Blob          |
| Durable | Cluster | Data | Budget | Observability                   |
+-------------+-----------------------+-------------------------------+
              |                       |
              v                       v
       LanguageModel              execution providers
                                  sandbox / browser / computer
```

The control plane owns product records. The kernel owns execution authority.

---

## 4. Where this code should live

Do not force all product concepts into the published kernel package.

Recommended repository shape:

```text
apps/
  web/
  api/
  worker/

packages/
  product-domain/
  product-store/
  product-runtime/
  product-protocol/
  product-client/
  product-ui-core/
  browser/
  computer/
  artifacts/
  knowledge/
  integrations/
```

This can initially live in the same monorepo while the product shape is still
moving.

### Dependency direction

```text
apps/web
   |
product-ui-core / product-client
   |
product-protocol / product-runtime
   |
product-domain / product-store
   |
effect-agent public APIs
```

The product may depend on `effect-agent`. The kernel must not depend on the
product.

Some future pieces such as a portable `Browser` capability may prove generally
useful enough to publish from `effect-agent`; they should earn that promotion
by having at least two independent consumers, per `AGENTS.md`.

---

# Part I — persistent product domain

## 5. Identity and tenancy

`Principal.CurrentPrincipal` solves **who is acting on the execution fibre**.
It does not model a SaaS account.

Add product identities:

```ts
UserId
OrganizationId
MembershipId
AgentId
AgentRevisionId
ProjectId
TaskId
ArtifactId
ArtifactVersionId
AutomationId
ConnectionId
ComputerId
BrowserProfileId
KnowledgeSourceId
NotificationId
```

Use branded `Schema` ids. Domain records use `Option` for absence.

### Organization

Prefer `Organization` for the SaaS/product concept so it cannot be confused
with `Sandbox.Workspace` or `WorkspaceManager`.

```ts
interface Organization {
  id: OrganizationId
  name: string
  createdAt: DateTime
}
```

### Membership

```ts
interface Membership {
  organizationId: OrganizationId
  userId: UserId
  role: "owner" | "admin" | "member"
}
```

RBAC and resource ownership live here. They eventually compile into
`AgentSessionHost.Authorization`, permission policy and product-store filters.

---

## 6. AgentSpec, AgentRevision and AgentRegistry

### AgentSpec

```ts
interface AgentSpec {
  id: AgentId
  organizationId: OrganizationId

  name: string
  description: Option<string>
  avatar: Option<BlobRef>

  activeRevisionId: AgentRevisionId

  createdBy: UserId
  createdAt: DateTime
  archivedAt: Option<DateTime>
}
```

### AgentRevision

Treat edits as revisions. A running task must be able to say exactly which
configuration it used.

```ts
interface AgentRevision {
  id: AgentRevisionId
  agentId: AgentId
  revision: number

  instructions: string

  modelPolicy: ModelPolicyRef
  capabilities: ReadonlyArray<CapabilityRef>
  skills: ReadonlyArray<SkillRef>
  memoryPolicy: MemoryPolicy
  permissionPolicy: PermissionPolicyRef
  budgetPolicy: Option<BudgetPolicyRef>
  computerProfile: Option<ComputerProfileRef>

  createdBy: UserId
  createdAt: DateTime
}
```

### AgentRegistry

```ts
interface AgentRegistry {
  get(id: AgentId): Effect<Option<AgentSpec>, AgentRegistryError>
  revision(id: AgentRevisionId): Effect<Option<AgentRevision>, AgentRegistryError>
  list(query: AgentQuery): Effect<Page<AgentSummary>, AgentRegistryError>
  create(input: NewAgent): Effect<AgentSpec, AgentRegistryError>
  revise(id: AgentId, patch: AgentRevisionInput): Effect<AgentRevision, AgentRegistryError>
  archive(id: AgentId): Effect<void, AgentRegistryError>
}
```

### AgentResolver

This is the key runtime service:

```ts
interface AgentResolver {
  resolve(
    revision: AgentRevisionId
  ): Effect<ResolvedAgent, AgentResolutionError, Scope.Scope>
}

interface ResolvedAgent {
  readonly definition: AgentDefinition<...>
  readonly revision: AgentRevision
}
```

Resolution:

```text
AgentRevision
  -> ModelPolicy resolver
  -> Tool/capability registry
  -> Skills registry
  -> Memory scope/policy
  -> Permission policy
  -> Budget policy
  -> Computer/Sandbox binding
  -> AgentDefinition
```

At dynamic remote boundaries, erase only to the already-existing
`AgentClient.Service`; do not spread `AgentDefinition<any,...>` through the
control plane.

### Acceptance criterion

A user can create an agent entirely through data, restart the product server,
and open a new session using the same agent revision without any application
code being generated.

---

## 7. Projects

A project is long-lived shared context between organization-wide and
conversation-local state.

```ts
interface Project {
  id: ProjectId
  organizationId: OrganizationId

  name: string
  description: Option<string>

  agentIds: ReadonlyArray<AgentId>
  knowledgeSourceIds: ReadonlyArray<KnowledgeSourceId>

  instructions: Option<string>

  createdBy: UserId
  createdAt: DateTime
}
```

Projects may scope:

- knowledge;
- files/artifacts;
- tasks;
- agent membership;
- project instructions;
- memory.

They do **not** own execution semantics.

---

## 8. Tasks / Missions

A `Task` is a product work item. It is not a kernel `Submission`.

```text
Task
   |
 attempted by
   v
Submission
   |
   v
Runs
```

### Task record

```ts
interface Task {
  id: TaskId
  organizationId: OrganizationId
  projectId: Option<ProjectId>

  title: string
  description: string

  createdBy: UserId
  owner: Option<AgentId>

  status:
    | "backlog"
    | "ready"
    | "running"
    | "waiting"
    | "blocked"
    | "failed"
    | "completed"
    | "canceled"

  priority: number

  parent: Option<TaskId>
  dependencies: ReadonlyArray<TaskId>

  dueAt: Option<DateTime>

  createdAt: DateTime
  updatedAt: DateTime
}
```

### TaskAttempt

Link tasks to exact execution.

```ts
interface TaskAttempt {
  taskId: TaskId
  agentRevisionId: AgentRevisionId
  sessionId: AgentProtocol.SessionId
  submissionId: AgentProtocol.SubmissionId
  attempt: number
  startedAt: DateTime
  finishedAt: Option<DateTime>
}
```

This preserves the distinction between "the work" and "one attempt to perform
the work".

### Task board

The product can expose:

```text
BACKLOG | READY | RUNNING | NEEDS YOU | DONE
```

without encoding those statuses into `AgentSession`.

---

## 9. Work queue

`/scheduling` already has the correct execution seam:
`AgentDispatcher`, `JobStore`, `queued`, `worker`, `recurring`.

The product needs a durable operational queue behind that seam with richer
metadata:

```ts
interface WorkItem {
  id: WorkItemId
  taskId: TaskId
  agentRevisionId: AgentRevisionId

  priority: number
  attempt: number

  availableAt: DateTime
  leaseOwner: Option<string>
  leaseUntil: Option<DateTime>

  idempotencyKey: string
  retryPolicy: RetryPolicy
}
```

Target semantics for persistent employee-style work should usually be
at-least-once with leases plus idempotent external writes, not the in-memory
store's intentionally simple at-most-once behaviour.

Do this behind the existing dispatcher abstraction.

---

# Part II — global operational views

## 10. SessionDirectory

`SessionProjection` answers "what is true now for one session".

Add a product read model that answers:

- which sessions exist;
- which agent owns each;
- which project/task they belong to;
- which are active;
- which are blocked on elicitation;
- which failed;
- accumulated usage;
- last activity time.

```ts
interface SessionSummary {
  sessionId: AgentProtocol.SessionId
  organizationId: OrganizationId
  agentId: AgentId
  agentRevisionId: AgentRevisionId
  projectId: Option<ProjectId>
  taskId: Option<TaskId>

  projection: SessionProjection.Projection
  updatedAt: DateTime
}

interface SessionDirectory {
  get(id: SessionId): Effect<Option<SessionSummary>, DirectoryError>
  list(query: SessionQuery): Effect<Page<SessionSummary>, DirectoryError>
  observe(query: SessionQuery): Stream<SessionDirectoryEvent, DirectoryError>
}
```

Build it from:

```text
AgentSessionHost.hostEvents
        +
DeliveryLog
        +
SessionProjection.reduce
```

It is a read model, never an execution authority.

---

## 11. Needs You inbox

Do not invent an approval queue separate from `Elicitation`.

An inbox item is a durable projection/reference to an unresolved elicitation.

```ts
interface InboxItem {
  id: InboxItemId
  organizationId: OrganizationId
  sessionId: SessionId
  agentId: AgentId
  taskId: Option<TaskId>

  elicitationId: Elicitation.Id
  kind: string

  createdAt: DateTime
}
```

Projection:

```text
ElicitationRequested -> InboxItem appears
ElicitationResolved  -> InboxItem disappears / settles
Submission settles   -> stale item settles
```

The UI can show approvals, questions, expired credentials and computer takeover
requests in one place while execution still resumes through
`RemoteSession.respond`.

---

## 12. Product event bus and projections

Keep two event vocabularies distinct.

### Kernel execution events

`AgentEvent`:

- model/tool/session/run/turn lifecycle;
- steering/follow-up;
- elicitation;
- usage.

### Product events

Add a separate ADT:

```text
AgentCreated
AgentRevised
TaskCreated
TaskAssigned
TaskStatusChanged
ProjectCreated
ArtifactCreated
ArtifactVersionCreated
AutomationEnabled
ConnectionChanged
ComputerAllocated
NotificationCreated
```

Do not stuff these into `AgentEvent`.

At the application boundary a shared envelope may carry either kind, but each
domain retains its own exhaustive ADT.

Candidate projections:

```text
AgentProjection
TaskProjection
InboxProjection
ComputerProjection
AutomationProjection
UsageProjection
```

---

# Part III — browser and computer

## 13. Browser is the largest missing execution capability

`Sandbox` plus `WebSearch` / `WebFetch` does not equal a browser.

A browser has persistent state, tabs, navigation and interaction.

Proposed portable capability:

```ts
interface BrowserService {
  navigate(url: Url): Effect<PageState, BrowserError>
  tabs: Effect<ReadonlyArray<Tab>, BrowserError>
  activate(tab: TabId): Effect<void, BrowserError>
  screenshot(options?: ScreenshotOptions): Effect<BlobRef, BrowserError>
  click(target: BrowserTarget): Effect<void, BrowserError>
  type(target: BrowserTarget, text: string): Effect<void, BrowserError>
  evaluate(script: string): Effect<unknown, BrowserError>
  events: Stream<BrowserEvent, BrowserError>
}

class Browser extends Context.Service<Browser, BrowserService>()(...)
```

Potential providers:

```text
browser/playwright
browser/cdp
browser/browserbase
browser/steel
```

The portable surface must not mention Playwright types.

### Target model-facing tools

Build ordinary Effect AI tools over `Browser`:

- navigate;
- inspect;
- click;
- type;
- screenshot;
- tabs;
- evaluate when policy allows it.

Permission projections should map browser writes/navigation into the existing
`Permission` vocabulary rather than inventing browser-specific approvals.

---

## 14. BrowserProfile

Separate execution from browser identity/session lifetime.

```ts
interface BrowserProfile {
  id: BrowserProfileId
  organizationId: OrganizationId
  owner: BrowserProfileOwner
  providerRef: string
  persistent: boolean
}
```

A profile owns durable:

- cookies;
- local/session storage;
- logged-in app sessions;
- browser preferences.

This enables either:

```text
one profile per user
one profile per named agent
shared organization profile
```

without changing the browser capability.

---

## 15. Computer abstraction

A Grok-style "computer" is a product/runtime composition:

```text
Computer
  |- Sandbox
  |- Browser
  |- Files
  |- optional desktop stream
  |- resource lifecycle
```

Do not replace `Sandbox`.

```ts
interface ComputerService {
  id: ComputerId
  sandbox: Sandbox.Sandbox
  browser: BrowserService

  suspend: Effect<void, ComputerError>
  resume: Effect<void, ComputerError>
  destroy: Effect<void, ComputerError>

  events: Stream<ComputerEvent, ComputerError>
}
```

### ComputerProvider / ComputerManager

```ts
interface ComputerProvider {
  allocate(spec: ComputerSpec): Effect<ComputerLease, ComputerError, Scope.Scope>
  resume(id: ComputerId): Effect<ComputerLease, ComputerError, Scope.Scope>
  destroy(id: ComputerId): Effect<void, ComputerError>
}
```

Providers might compose remote sandbox/browser vendors rather than require one
vendor to supply both.

---

## 16. Remote Sandbox provider

The current `Sandbox.fromExec` / `fromOperations` seam means this is now an
adapter problem.

For the product, this is higher priority than coding-agent polish such as LSP.

Implement at least one real provider:

```text
E2B
Daytona
or equivalent
```

Acceptance:

- allocate;
- execute;
- stream stdout/stderr;
- filesystem round-trip;
- interruption;
- workspace persistence for the declared lifetime;
- cleanup after lease expiry;
- conformance suite passes.

---

## 17. Live computer view

The user-facing computer needs an observation stream distinct from agent tool
events.

```ts
type ComputerEvent =
  | Frame
  | CursorMoved
  | NavigationChanged
  | TabChanged
  | InputPerformed
  | ControlChanged
  | ComputerSuspended
  | ComputerResumed
```

UI capabilities:

- live viewport;
- current URL;
- tab list;
- cursor;
- action captions;
- pause/stop;
- fullscreen;
- file upload;
- clipboard;
- takeover/release.

---

## 18. User takeover

Reuse `Elicitation`.

Flow:

```text
agent reaches login / CAPTCHA / 2FA / payment confirmation
        |
ElicitationRequested(kind = "computer-takeover")
        |
user takes control
        |
agent waits
        |
user completes action
        |
respond / release control
        |
agent resumes
```

There should be no special "2FA execution engine".

Policy determines when the agent is allowed to ask for takeover and whether the
computer may resume automatically.

---

# Part IV — connections and external identity

## 19. Connection is the product face of Credentials

The kernel already has:

```text
Credentials.Method
Credentials.Binding
Credentials.Provider
Credentials.Bindings
Credentials.resolveFor
refreshing credentials
reauth elicitation
```

Add a non-secret product record:

```ts
interface Connection {
  id: ConnectionId
  organizationId: OrganizationId

  integration: string
  owner: ConnectionOwner

  status:
    | "connected"
    | "needs_reauth"
    | "expired"
    | "revoked"

  scopes: ReadonlyArray<string>

  binding: Credentials.Binding
  providerKey: string

  createdAt: DateTime
  refreshedAt: Option<DateTime>
}
```

The control plane never stores resolved plaintext values.

---

## 20. OAuth control plane

OAuth flows belong in the product server, behind the existing credential seam.

Required pieces:

- provider discovery/config;
- state + PKCE;
- authorization URL;
- callback;
- code exchange;
- encrypted/vault-backed token persistence;
- refresh;
- revocation;
- reconnect;
- requested/granted scope display.

Execution remains:

```text
Connection
   -> Credentials.Binding
   -> Credentials.Provider
   -> Redacted token
   -> tool invocation
```

---

## 21. Rich connector event model

The current `Connectors.Delivery` intentionally models a text message in a
conversation. Keep that simple surface for simple channels.

Add an advanced decoder/event surface when at least two channel adapters require
it:

```ts
type ChannelEvent =
  | MessageReceived
  | MessageEdited
  | ReactionAdded
  | FileReceived
  | InteractiveAction
  | ThreadReply
```

Messages should be able to carry `Prompt.Prompt` / `PromptWire` content and
`BlobRef` attachments.

Do not smuggle sender identity from model-visible text; continue deriving trusted
principal data from verified provider metadata.

---

## 22. Agent external identity / mailbox

There are two kinds of delegation:

1. ephemeral subagent call — already solved by `Subagent.tool`;
2. message/work routed to an already-existing persistent named agent.

Add a product `AgentMailbox` or, preferably, define mailbox behaviour as
routing into tasks/conversations owned by the destination agent.

```ts
interface AgentMailbox {
  send(to: AgentId, message: AgentMessage): Effect<MessageId, MailboxError>
}
```

Implementation should use the same task/session/dispatcher infrastructure.
Remote agents use A2A as transport where appropriate.

Later external identities can include:

- dedicated email inbox;
- Slack/Teams identity;
- Discord/Telegram bot;
- SMS/phone.

Email is the best first identity beyond Slack because inbound mail naturally
maps to a trigger and thread.

---

# Part V — skills and automation

## 23. Persistent skill catalog

`/skills` already has the right execution-facing `SkillRegistry`.

Add persistent records:

```ts
SkillRecord
  id
  organization
  name
  description
  activeRevision

SkillRevision
  body
  resources
  version
  provenance
  createdBy
```

Possible provenance:

```text
manual
agent-generated
demonstration-generated
plugin-import
```

The persistent store should implement the existing `SkillRegistry` interface
rather than creating a parallel loading mechanism.

---

## 24. Teach by demonstration

Once browser observation exists:

```text
record
  -> browser/computer event trace
  -> agent summarizes invariant workflow
  -> parameter extraction
  -> skill draft
  -> test run
  -> human review
  -> publish revision
```

A demonstration is **training data for a Skill**, not a new runtime workflow
format.

Store the original trace/provenance so a skill can be regenerated or audited.

---

## 25. Automation entity

`Scheduling` provides execution. Add persisted product configuration:

```ts
interface Automation {
  id: AutomationId
  organizationId: OrganizationId

  name: string
  agentId: AgentId
  pinnedRevision: Option<AgentRevisionId>

  input: PromptTemplateRef
  trigger: TriggerSpec

  enabled: boolean

  lastRunAt: Option<DateTime>
  nextRunAt: Option<DateTime>
}
```

Pinned revision vs latest revision must be explicit. Silent automatic upgrades
make recurring work irreproducible.

### TriggerSpec

```ts
type TriggerSpec =
  | ManualTrigger
  | CronTrigger
  | IntervalTrigger
  | WebhookTrigger
  | ConnectorEventTrigger
  | ConditionTrigger
```

Compilation targets existing machinery:

```text
Cron / interval
  -> Scheduling / Schedule

Webhook / connector
  -> Connectors / product events

Condition
  -> recurring dispatch + predicate

execution
  -> AgentDispatcher
```

### Heartbeat

A heartbeat is product sugar:

```text
IntervalTrigger(30m)
+
"Inspect your assigned tasks and act on actionable work."
```

Do not build a heartbeat runtime.

---

# Part VI — artifacts, knowledge and provenance

## 26. Artifact is not Blob

`BlobStore` owns bytes. An Artifact is a user-visible semantic object.

```ts
interface Artifact {
  id: ArtifactId
  organizationId: OrganizationId
  projectId: Option<ProjectId>
  taskId: Option<TaskId>

  type:
    | "file"
    | "document"
    | "spreadsheet"
    | "presentation"
    | "code"
    | "website"
    | "dataset"
    | "image"

  title: string
  currentVersionId: ArtifactVersionId

  createdBy: ActorRef
  createdAt: DateTime
}
```

```ts
interface ArtifactVersion {
  id: ArtifactVersionId
  artifactId: ArtifactId
  blob: BlobRef
  mediaType: string

  provenance: Provenance

  createdBy: ActorRef
  createdAt: DateTime
}
```

Use `BlobStore` as the storage authority.

Use `AgentData` for live typed cards/panels; promote durable outputs to
Artifacts when they need a product identity.

---

## 27. Artifact editors

Do not block the initial product on building Google Docs.

Start with renderers:

- markdown/document;
- code + diff;
- CSV/table;
- image;
- HTML/website preview;
- PDF/file preview.

Then add editing surfaces:

- document;
- spreadsheet;
- slides;
- code;
- website.

Editors write new `ArtifactVersion` records rather than mutating opaque files
without provenance.

---

## 28. Knowledge is not Memory

Keep the current `Memory` contract for cross-session remembered facts and
preferences.

Add a separate product knowledge system for authoritative/retrievable sources.

```ts
interface KnowledgeSource {
  id: KnowledgeSourceId
  organizationId: OrganizationId
  projectId: Option<ProjectId>

  kind:
    | "upload"
    | "website"
    | "git"
    | "drive"
    | "notion"
    | "slack"
    | "database"

  status: KnowledgeSourceStatus
}
```

Suggested runtime seams:

```ts
interface KnowledgeIngestor {
  ingest(source: KnowledgeSource): Effect<IngestReport, KnowledgeError>
}

interface KnowledgeSearch {
  search(scope: KnowledgeScope, query: string): Effect<ReadonlyArray<KnowledgeHit>, KnowledgeError>
}
```

Pipeline:

```text
source
 -> fetch
 -> parse
 -> chunk
 -> metadata
 -> index
 -> ACL filter
 -> retrieve
```

The first implementation may use plain text/FTS before embeddings. Preserve the
seam so ranking/index storage can change later.

---

## 29. Provenance and citations

Research/product trust needs first-class source references.

```ts
interface Provenance {
  sessionId: Option<SessionId>
  submissionId: Option<SubmissionId>
  runId: Option<RunId>

  sources: ReadonlyArray<SourceRef>
}

type SourceRef =
  | WebSource
  | ArtifactSource
  | KnowledgeSourceRef
  | ToolResultSource
  | MessageSource
```

A citation includes a locator when possible:

```ts
interface Citation {
  source: SourceRef
  locator: Option<SourceLocator>
}
```

Artifacts should be able to answer "where did this come from?" without parsing
a prose transcript.

---

# Part VII — notification, search and economics

## 30. Notifications

Events are not notifications.

```ts
interface NotificationService {
  send(notification: Notification): Effect<void, NotificationError>
}
```

Provider adapters:

```text
in-app
email
push
Slack
SMS
```

Notification policy examples:

```text
approval required  -> push
task failed         -> push + email
automation success -> silent
weekly digest       -> email
```

The source of truth remains execution/product events.

---

## 31. Universal search

Add product-wide search over:

- agents;
- conversations;
- messages;
- tasks;
- projects;
- artifacts;
- skills;
- automations;
- knowledge sources;
- files.

Target UX: one `Cmd+K` / command palette.

Keep search storage behind a service:

```ts
interface ProductSearch {
  search(query: SearchQuery): Effect<Page<SearchResult>, SearchError>
}
```

Start with SQL FTS where sufficient; move to a dedicated index only when
measured need justifies it.

---

## 32. Usage, quotas and billing

The kernel already emits model usage and has model pricing metadata/budgets.

Add durable product records:

```text
UsageRecord
Quota
Entitlement
BillingAccount
Plan
```

Dimensions:

```text
organization
user
agent
task
run
model
computer
search
storage
```

Important separation:

- `/budget` is execution-time enforcement;
- product quota controls admission;
- billing records economic usage;
- Stripe or another vendor is an application adapter, never a kernel concept.

---

## 33. ModelPolicy

Persist user-facing model selection without making `Agent` provider-specific.

```ts
type ModelPolicy =
  | FixedModel
  | FallbackChain
  | CostOptimized
  | QualityOptimized
```

Compile this into existing provider Layers / `ExecutionPlan`.

Potential fields:

- allowed providers/models;
- reasoning level;
- latency preference;
- max model spend per task/run;
- fallback chain;
- capability requirements.

A running TaskAttempt records the resolved model policy/revision for
reproducibility.

---

# Part VIII — frontend

## 34. Top-level information architecture

Initial navigation:

```text
Home / Inbox
Agents
Tasks
Projects
Conversations
Artifacts
Automations
Connections
Computers
Skills
Search
Usage
Settings
```

The key UX rule:

> **Chat is a view of an Agent. The Agent is not a chat thread.**

---

## 35. Agent page

```text
Researcher                                      working

Chat | Tasks | Activity | Memory | Skills | Files | Computer | Settings
```

Settings expose the persisted `AgentRevision`:

- instructions;
- model;
- capabilities/tools;
- skills;
- memory;
- permissions;
- budget;
- computer/browser profile.

Editing creates a revision.

---

## 36. Chat / activity surface

Drive it from the existing typed event model.

Render at least:

- user/agent messages;
- reasoning/status;
- tool calls;
- tool progress;
- tool results;
- failures;
- delegation/handoffs;
- files/artifacts;
- structured `AgentData`;
- elicitations/approvals;
- run status;
- token/cost usage.

Do not reduce the backend to `user | assistant` messages just because a UI
component library expects that shape. UI-library adapters are projections.

Use the architecture in [plan-workbench.md](./plan-workbench.md):
`ConversationProjection` + `ConversationPresenter` + thin framework adapter.

---

## 37. Tasks page

Views:

- board;
- list;
- assigned agent;
- dependencies;
- attempts;
- outputs;
- due date;
- activity.

Task detail should show both product history and linked kernel runs without
pretending they are the same object.

---

## 38. Inbox

One place for:

- approvals;
- questions;
- credential reconnects;
- takeover requests;
- blocked tasks.

Every item deep-links to the relevant session/task and resolves through the
original `Elicitation`.

---

## 39. Computer page

Required controls:

- streamed viewport;
- tab list;
- current URL;
- action timeline;
- pause;
- stop;
- take control;
- release control;
- upload/download;
- clipboard;
- fullscreen.

A user should be able to leave the page while the run continues.

---

## 40. Connections page

Each card shows:

- integration;
- connected identity;
- ownership (user/org);
- scopes;
- health;
- last refresh;
- agents allowed to use it;
- reconnect/disconnect.

Plaintext credentials are never rendered back to the browser.

---

## 41. Automation editor

Fields:

- name;
- agent;
- pinned/latest revision;
- input/template;
- trigger;
- timezone;
- enabled;
- notification policy;
- retry policy;
- budget.

Show last runs and next run.

---

# Part IX — backend/API shape

## 42. Product stores

Prefer narrow `Context.Service` interfaces with in-memory + SQL providers.

Likely services:

```text
OrganizationStore
MembershipStore
AgentRegistry
ProjectStore
TaskStore
TaskAttemptStore
SessionDirectoryStore
SkillStore
AutomationStore
ConnectionStore
ArtifactStore
KnowledgeSourceStore
NotificationStore
UsageStore
```

Do not start with one giant repository interface.

---

## 43. Product runtime services

Likely orchestration services:

```text
AgentResolver
AgentDirectory
TaskRunner
TaskScheduler
SessionDirectory
InboxProjection
ComputerManager
ConnectionRuntime
AutomationEngine
ArtifactService
KnowledgeIngestor
KnowledgeSearch
NotificationService
ProductSearch
UsageMeter
```

Each must say which existing `effect-agent` seam it composes.

---

## 44. Product protocol

Define Schema-owned APIs only for product concepts.

Reuse `AgentProtocol` for:

- prompt;
- submit/await;
- steer;
- follow-up;
- interrupt;
- respond;
- pending;
- history;
- status;
- events.

Do not create `ProductPromptRequest` with identical fields.

Possible product routes:

```text
/organizations
/agents
/projects
/tasks
/conversations
/inbox
/skills
/automations
/connections
/artifacts
/knowledge
/computers
/search
/usage
```

Execution routes delegate to existing clients/hosts.

---

## 45. Authorization

Authorization occurs at multiple independent boundaries:

```text
product resource access
        +
AgentSessionHost operation authorization
        +
Permission tool policy
        +
physical sandbox/browser boundary
        +
credential ownership/scope
```

These should be composable and redundant, not collapsed into a single
"canAgentDoEverything" boolean.

Examples:

- user may read a Task but not modify the Agent;
- Agent may read GitHub but writes ask;
- browser may be restricted to allowed domains;
- sandbox may have no network;
- connection may be user-owned and therefore unavailable to another principal.

---

## 46. Idempotency and external writes

Persistent workers make duplicate execution a product problem.

For every external mutation:

- stable idempotency key when provider supports it;
- product-side action journal when it does not;
- retries classified by error;
- compensation/undo where realistic;
- never retry an ambiguous external write blindly.

Task/work queue retries must not mean "send the customer email twice."

---

# Part X — implementation sequence

## 47. Phase 0 — prove the boundary

**Goal:** prove persisted data can compile into the current execution kernel.

Build:

1. `AgentId`, `AgentRevisionId`, `AgentSpec`, `AgentRevision`;
2. in-memory `AgentRegistry`;
3. `AgentResolver`;
4. one persisted-style model policy;
5. one capability reference;
6. one skill reference;
7. one permission policy reference;
8. reference example using public `effect-agent` APIs only.

Acceptance:

- no casts in consumer code;
- no kernel modification unless the example proves a real missing seam;
- two revisions of one Agent can both still be resolved;
- running revision N is unaffected by creating N+1.

This is the first thing to build.

---

## 48. Phase 1 — product shell and persistent named agents

Build:

- organization/user/membership;
- SQL stores;
- Agent CRUD + revisions;
- conversations linked to AgentId/SessionId;
- SessionDirectory;
- web app shell;
- agent list/detail;
- conversation list/chat/activity;
- basic auth.

Acceptance:

A user can create "Researcher", restart the server, reopen it, start several
conversations, and see currently running/blocked sessions.

---

## 49. Phase 2 — tasks and Inbox

Build:

- Task/TaskAttempt;
- board/list;
- assignment;
- TaskRunner over AgentResolver + AgentClient;
- operational queue behind `AgentDispatcher`;
- InboxProjection over elicitations;
- approval/question UI.

Acceptance:

A Task assigned to an Agent can run, pause for approval, appear in Needs You,
resume after the answer, complete, and attach the exact submission/run attempt
to the Task.

---

## 50. Phase 3 — remote computer

Build:

- one real remote Sandbox provider;
- `Browser` capability;
- one browser provider;
- BrowserProfile;
- Computer/ComputerProvider;
- live viewport;
- takeover via Elicitation.

Acceptance:

A named agent can keep a logged-in browser profile, navigate and manipulate a
site, pause for human takeover, survive the user leaving the page, then resume.

This is the point where the product becomes a credible Grok Bot competitor
rather than primarily a sophisticated chat/agent workbench.

---

## 51. Phase 4 — connections and integrations

Build:

- Connection store;
- OAuth control plane;
- GitHub/Google/Slack first-class setup;
- health + reconnect;
- richer channel events when two adapters justify the seam;
- agent mailbox routing;
- email identity/inbox.

Acceptance:

A user can connect an account once, grant it to selected agents, revoke it
without changing agent definitions, and reauthorize through the same
Elicitation/credential path.

---

## 52. Phase 5 — automations and skills

Build:

- persistent Skill revisions;
- Automation records;
- cron/interval triggers;
- connector/webhook triggers;
- heartbeat presets;
- run history;
- demonstration recording -> skill draft.

Acceptance:

A demonstrated browser workflow can become a reviewed skill and run every week
through a persistent agent without hardcoded application code.

---

## 53. Phase 6 — artifacts and projects

Build:

- Projects;
- Artifact/ArtifactVersion;
- artifact renderer registry;
- document/table/code/site renderers;
- task outputs;
- provenance;
- basic editors.

Acceptance:

A task can create a durable named artifact, another agent can consume it, a
human can edit it into a new version, and the provenance chain remains intact.

---

## 54. Phase 7 — knowledge and research UX

Build:

- KnowledgeSource;
- ingestion;
- retrieval;
- access filtering;
- citations;
- project knowledge;
- source viewer.

Acceptance:

A research agent can answer from uploaded/connected project knowledge with
machine-readable provenance, while Memory remains a separate mechanism.

---

## 55. Phase 8 — product economics and polish

Build:

- notifications;
- universal search;
- usage ledger;
- organization quotas;
- billing/entitlements;
- admin controls;
- templates/marketplace;
- mobile/push;
- enterprise RBAC/SSO later.

---

# Part XI — what should go into effect-agent itself?

## 56. Likely kernel/library additions

Only a few items in this plan are plausibly general-purpose library batteries.

### Strong candidate: Browser

If the browser capability is useful from:

1. the product, and
2. a standalone agent/reference app,

then a portable `/browser` seam belongs beside `/sandbox` and `/web`.

### Strong candidate: richer connector envelope

Only after at least two adapters require threading/attachments/interactions.

### Possible candidate: SessionDirectory fold helpers

If several hosts/products independently need the same fold over
`hostEvents + SessionProjection`.

### Not kernel concepts

These should remain product-level:

- Organization;
- AgentSpec/AgentRevision persistence;
- Project;
- Task/Mission;
- Inbox item;
- Artifact identity/editor;
- Automation record;
- Connection UI record;
- billing;
- notification preference;
- global search;
- SaaS RBAC.

The fact that they compose with the kernel does not make them kernel
primitives.

---

# Part XII — hard architectural invariants

## 57. Invariants

1. **One execution model.** Product Tasks dispatch kernel Sessions/Submissions;
   they do not run themselves.

2. **AgentSpec is data; AgentDefinition is executable behaviour.** Resolution is
   explicit and versioned.

3. **A Task is not a Submission.** One is desired work; one is an execution
   attempt.

4. **An Artifact is not a Blob.** Blob owns bytes; Artifact owns user-visible
   identity/version/provenance.

5. **Knowledge is not Memory.** Knowledge has authoritative sources and
   provenance; Memory is learned cross-session context.

6. **A Connection never contains plaintext credentials.** It references
   `Credentials.Binding`/provider handles.

7. **Inbox does not invent HITL.** It projects unresolved `Elicitation`.

8. **Automation does not invent scheduling.** It compiles TriggerSpec to
   existing scheduling/connector/dispatcher mechanisms.

9. **Computer does not replace Sandbox.** It composes Sandbox + Browser +
   lifecycle/observation.

10. **Product events do not become AgentEvents.** Keep execution and product
    vocabularies distinct.

11. **Frontend state derives from typed events/projections.** React/assistant-ui
    types never become persistence or execution contracts.

12. **Every external write is retry-aware and idempotency-aware.**

13. **Revision identity is captured at execution.** A long-running Task does not
    silently change behaviour because the user edited its Agent halfway through.

14. **No product feature reaches into `src/internal`.** A missing public seam is
    a framework finding, not permission to bypass the package boundary.

15. **End-user code still needs no casts.** Product reference examples count as
    user code under the repository rule.

---

# Part XIII — reference implementation / falsification strategy

## 58. Add a product reference slice before building everything

Create a miniature reference application that uses only published
`effect-agent` imports plus the new product packages.

Suggested scenario:

```text
Organization: Acme

Agent: Researcher v1
  web search
  memory
  one skill
  ask-before-write policy

Project: Competitors

Task:
  "Research three competitors and create a report."

TaskRunner
  -> resolves Researcher v1
  -> creates/opens session
  -> submits task
  -> records attempt
  -> agent requests approval
  -> InboxProjection exposes it
  -> test responds
  -> run completes
  -> Artifact record points at output blob
```

Assertions:

- Agent revision resolution survives persistence round-trip;
- Task and Submission ids stay distinct;
- unresolved elicitation appears in Inbox;
- resolving it removes it;
- Artifact provenance points to the actual attempt;
- a new Agent revision does not alter the running attempt;
- unauthorized principal cannot resolve another org's Agent/Task/Connection;
- no credential value appears in events, exports or product records;
- retrying a completed TaskAttempt does not duplicate a mocked external write;
- no casts in the reference consumer.

Break each important assertion once before considering the slice proven.

---

# Part XIV — immediate next work

## 59. Recommended next five commits

The current library is not blocked on more abstraction before this product can
start.

I would do these in order:

### Commit 1 — product-domain skeleton

Add branded ids and Schemas for:

- Organization;
- AgentSpec;
- AgentRevision;
- Project;
- Task;
- TaskAttempt.

No database, no UI.

### Commit 2 — AgentRegistry + AgentResolver

In-memory registry first. Resolve a data-defined agent to a real
`AgentDefinition` using public seams.

This is the architectural proof.

### Commit 3 — product reference scenario

Run the scenario in §58 in CI. Let it expose missing seams instead of guessing.

### Commit 4 — SQL stores + SessionDirectory

Persist named agents/tasks and build the cross-session read model from host
events/projections.

### Commit 5 — first web vertical slice

Ship:

```text
Agents -> create Researcher
        -> open chat
        -> run task
        -> see activity
        -> answer approval in Inbox
```

Only then begin remote computer/browser work.

---

## 60. Relationship to existing plans

- [plan-workbench.md](./plan-workbench.md) specifies the UI-neutral web
  workbench architecture. Reuse its `ConversationStore`, `AgentDirectory`,
  `ConversationPresenter`, protocol and UI adapter direction. This plan adds
  persistent-worker concepts around it.
- [plan-primitives.md](./plan-primitives.md) remains correct for the kernel:
  capabilities are largely present; the remaining distance is higher-level
  product assembly.
- [plan-deployment.md](./plan-deployment.md) owns host/deployment adapters. The
  remote computer work should use its existing provider/layer philosophy.
- [plan-tool-credentials.md](./plan-tool-credentials.md) owns execution-time
  credential semantics. The Connection/OAuth product layer sits above it.
- [plan-integrations.md](./plan-integrations.md) owns adapter/conformance
  strategy. Browser/computer/channel providers should follow the same pattern.
- [effect-plan-2.txt](./effect-plan-2.txt) and
  [opencode-completion-plan.md](./opencode-completion-plan.md) contain the
  existing SessionInbox/ProcessManager direction. Reuse what survives this
  product model rather than creating duplicate notions of process/session
  state.

---

## 61. Success condition for the whole plan

The product is architecturally complete when a user can:

1. create a persistent named agent without writing code;
2. give it model/tool/skill/memory/permission/computer policies;
3. assign it durable work;
4. leave while it works;
5. watch or take over its computer;
6. receive one global queue of questions/approvals;
7. let it delegate to other persistent agents;
8. connect user/org accounts without exposing credentials;
9. schedule or event-trigger recurring work;
10. produce durable versioned artifacts with provenance;
11. search project knowledge separately from learned memory;
12. inspect exact runs, costs, failures and sources;
13. edit the agent into a new revision without changing old/running work;
14. use the same underlying `effect-agent` execution contracts from web, CLI,
    TUI, A2A or another client.

At that point the repository has not become a second Grok-specific runtime. It
has become something more reusable:

> **an Effect-native execution kernel plus a persistent control plane for
> composable AI workers.**

That is the product architecture to optimize for.
