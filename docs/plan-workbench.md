# Plan: Effect Agent Workbench

Written 2026-09-01.

**Status: specified, not implemented.**

This plan defines a polished, fully open-source web application around
`@doeixd/effect-agent`: a general-purpose agent workbench in the product class
of Open WebUI and bb, but with `effect-agent` as the execution kernel rather
than a second agent framework hidden behind the UI.

The workbench is both a useful application and a reference implementation. It
should prove that the public seams in `effect-agent` are sufficient to build a
real multi-session agent product without importing engine internals.

---

## The short answer

Do **not** fork Open WebUI, LibreChat, bb, CopilotKit, or Vercel Chatbot and then
replace their execution model.

The repository already owns the hard execution semantics:

- sessions, submissions, runs and turns;
- canonical history and context transforms;
- typed lifecycle events;
- streaming text and reasoning;
- tool calls, progress and failure policy;
- steering, follow-ups and interruption;
- elicitation and approval;
- HTTP/RPC/AG-UI/A2A/MCP transports;
- sandbox, coding and shell capabilities;
- memory, skills, state, subagents and scheduling;
- durability, clustering and durable streams;
- model/provider independence.

What is missing is mostly the **product shell**:

- React chat UI;
- conversation catalog and search;
- user/account configuration;
- agent and model configuration;
- attachments and blobs;
- workspace lifecycle and file browsing;
- artifact rendering;
- connection/tool configuration;
- settings, usage and administration.

The recommended vertical slice is deliberately **Effect-native and UI-framework
agnostic**:

```text
React / Solid / TUI / assistant-ui / anything
                    |
          thin UI-framework adapter
                    |
          ConversationPresenter
      (typed Effect state projection)
                    |
       +------------+-------------+
       |                          |
Workbench product services     AgentClient
(conversations, agents,        RemoteSession
 workspaces, artifacts)           |
       |                          |
       +------------+-------------+
                    |
        typed Effect transports
          HTTP / RPC / in-proc
                    |
        AgentSessionHost / kernel
                    |
        @doeixd/effect-agent
                    |
            Effect / Effect AI
```

**assistant-ui and AG-UI are optional adapters at the edge.** They are useful
for shipping a polished React client quickly and for interoperability, but no
workbench domain type, store, controller, or persistence record should mention
either one.

The stable execution seam is `AgentClient` / `RemoteSession`; the stable
observation seam is `AgentEvent`; product data is exposed through separate
Effect services. AG-UI remains a projection of the kernel's event model, not the
canonical internal protocol.

---

## Goals

### G1 — A real product shell

The result should feel like a first-class agent application, not an examples
directory with a chat box. A user can create and revisit conversations, attach
files, watch tools run, approve actions, inspect artifacts, and configure the
agent without knowing anything about Effect.

### G2 — A reference implementation for the public API

The workbench must consume `@doeixd/effect-agent` as an ordinary package. If
the application needs an internal module, that is evidence of a missing public
seam and should be fixed in the library rather than bypassed.

### G3 — Preserve one execution model

The workbench introduces no second notion of run, tool, permission, memory,
session, or event. Product records may refer to kernel concepts, but execution
authority stays in `effect-agent`.

### G4 — General-purpose, not coding-only

Coding is an important capability, but the app should also host research,
knowledge, automation and domain agents. Workspace features therefore sit
beside chat rather than defining the whole product.

### G5 — Fully open source

The application should use permissive dependencies and ship under MIT unless a
specific dependency requires otherwise. Avoid source-available components whose
branding or redistribution terms would constrain downstream forks.

---

## Non-goals

- Replacing `AgentSession`, `AgentSessionHost`, or `AgentClient`.
- Making AG-UI the canonical persistence format.
- Reimplementing model/tool loops in React or in a web-specific server.
- Building a second sandbox abstraction.
- Building a second auth/authorization policy inside the kernel.
- Hiding every backend capability behind a single giant `Chat` abstraction.
- Matching every Open WebUI feature before the first usable release.
- Coupling the workbench to one deployment target, model provider, or database.

---

## Product architecture

```text
+-------------------------------------------------------------------+
|                         Web application                           |
|                                                                   |
|  Sidebar             Conversation                  Right panel     |
|  --------            ------------                  -----------     |
|  conversations       messages                      files           |
|  agents              reasoning                     artifacts       |
|  search              tool activity                 diffs           |
|  settings            approvals                     state           |
|                      composer                                      |
|                           |                                       |
|              React adapter / ui-core                              |
+---------------------------|---------------------------------------+
                            |
                 typed Effect client seams
             (AG-UI adapter optional at edge)
                            |
+---------------------------v---------------------------------------+
|                      Product server                               |
|                                                                   |
| auth / users / conversations / agents / workspaces / blobs        |
| connections / model config / search / usage                       |
|                            |                                      |
|                     AgentSessionHost                              |
+----------------------------|--------------------------------------+
                             |
+----------------------------v--------------------------------------+
|                  @doeixd/effect-agent                             |
| sessions / runs / turns / events / tools / permissions            |
| memory / skills / subagents / state / scheduling / compaction     |
+---------------+----------------------+----------------------------+
                |                      |
         LanguageModel              Sandbox
         GPT/Claude/etc.            local/remote/container
```

The product server owns catalog/configuration data. The kernel owns execution.
Those boundaries should stay visible in the types.

---

## Exact Effect module seams

This section is the architectural contract for the workbench. The names below
are intentionally more precise than "chat backend" or "frontend state". Each
module owns one authority and composes through `Effect`, `Layer`, `Schema`,
`Stream`, `Scope`, and ordinary service requirements.

There are three classes of seams:

1. **existing `effect-agent` seams** — consume them unchanged;
2. **workbench domain services** — new application-level Effect services;
3. **UI projections/adapters** — pure or scoped modules that may be replaced
   without changing either execution or persistence.

### Existing seams to use directly

| need | exact module | role in the workbench |
| --- | --- | --- |
| Execute / reconnect to an agent session | `@doeixd/effect-agent/client` → `AgentClient`, `RemoteSession` | **Primary execution seam.** UI-independent prompt, submit/await, steer, follow-up, interrupt, respond, pending, history, status and event stream. Do not wrap these into a second agent API. |
| Wire-safe session vocabulary | `@doeixd/effect-agent/client` → `AgentProtocol` | `Schema`-owned session ids, request ids, requests, responses and remote errors. Product transports reuse these types rather than defining "WorkbenchPromptRequest". |
| Server-side session registry / auth | `@doeixd/effect-agent/client` → `AgentSessionHost` | Shared registry, capacity, principal resolution, authorization and idempotent request authority. |
| Canonical observation | root → `AgentEvent` | The source event vocabulary. UI timelines, telemetry and protocol projections derive from this stream. |
| Wire-safe prompt/history | root → `PromptWire` | Stable prompt/message encoding including files. Product persistence and custom transports use this, never UI-library message JSON. |
| Human input / approvals | root → `Elicitation` | The typed request/response contract for paused execution. |
| Agent tree / branches | `/tree` → `SessionTree` | Branch/rewind semantics. The UI never implements branches by cloning message arrays. |
| Workspace execution | `/sandbox` → `SandboxProvider`, `Sandbox.Current`, `Sandbox.acquire` | Portable filesystem/process authority. Workbench workspace ids resolve *to* this seam; they do not replace it. |
| Binary content | `/blob` → `BlobStore`, `BlobWire` | Bytes and stable content-addressed references for uploads/artifacts. |
| Structured UI data | `/data` → `AgentData` | Schema-first data channels from tools to clients. This is the preferred route for typed agent-native panels. |
| Typed session state | `/state` → `AgentState` | Agent/application state used by tools and context transforms. UI reads projections; it does not become the state authority. |
| Model metadata | `/model` → `ModelCapabilities` | Capability checks for image input, windows, limits and UI affordances when known. |
| Tool credentials | `/tool-source` → `Credentials.Provider`, `Credentials.Bindings` | Secret resolution and per-principal binding. Workbench connection records hold handles/bindings, never plaintext secrets. |
| Durable event resumption | `/durable-streams` / durable `AgentClient` | Reconnect from an event sequence without silent gaps. |
| Export/import | `/export` | Versioned execution/session export. Product metadata can wrap it but must not invent another transcript format. |

The workbench should depend on these public subpaths as a third-party consumer
would. If a required capability is only reachable through `src/internal`, fix
the framework seam first.

### Proposed workbench package boundaries

Use a small package graph rather than one `web/` package that knows everything:

```text
packages/
  domain/       # Schemas and pure values only
  store/        # server-side persistence services
  runtime/      # composition: product record <-> AgentClient/Sandbox
  protocol/     # Schema-owned product wire API
  client/       # transport-neutral Effect client services
  ui-core/      # pure/scoped projections; no React
  react/        # optional React bindings
  assistant-ui/ # optional adapter
  server/       # HTTP/RPC composition and auth wiring
```

The first six packages should compile without React. `domain`, `protocol`
and ideally `client` should be browser-safe and contain no Node imports.

### 1. `WorkbenchIds` — pure branded identity schemas

**Package:** `domain`

Define every product identity once with `Schema.brand`:

```ts
export const UserId = Schema.String.pipe(Schema.brand("workbench/UserId"))
export const ConversationId =
  Schema.String.pipe(Schema.brand("workbench/ConversationId"))
export const AgentProfileId =
  Schema.String.pipe(Schema.brand("workbench/AgentProfileId"))
export const WorkspaceId =
  Schema.String.pipe(Schema.brand("workbench/WorkspaceId"))
export const AttachmentId =
  Schema.String.pipe(Schema.brand("workbench/AttachmentId"))
export const ArtifactId =
  Schema.String.pipe(Schema.brand("workbench/ArtifactId"))
export const ConnectionId =
  Schema.String.pipe(Schema.brand("workbench/ConnectionId"))
export const ModelProfileId =
  Schema.String.pipe(Schema.brand("workbench/ModelProfileId"))
```

Do not use interchangeable naked strings in persistence or protocol schemas.
Kernel ids stay kernel ids: `AgentProtocol.SessionId`,
`AgentProtocol.SubmissionId`, `BlobStore.BlobId`,
`Sandbox.Workspace`, etc.

### 2. `ConversationStore` — product metadata persistence only

**Package:** `store`  
**Kind:** `Context.Service`

```ts
export interface ConversationStoreService {
  readonly create: (
    record: Conversation.New
  ) => Effect.Effect<Conversation.Record, ConversationStoreError>

  readonly get: (
    id: ConversationId
  ) => Effect.Effect<Option.Option<Conversation.Record>, ConversationStoreError>

  readonly list: (
    query: Conversation.Query
  ) => Effect.Effect<ReadonlyArray<Conversation.Summary>, ConversationStoreError>

  readonly update: (
    id: ConversationId,
    patch: Conversation.Patch
  ) => Effect.Effect<Conversation.Record, ConversationStoreError>

  readonly remove: (
    id: ConversationId
  ) => Effect.Effect<void, ConversationStoreError>
}

export class ConversationStore
  extends Context.Service<ConversationStore, ConversationStoreService>()(
    "workbench/ConversationStore"
  ) {}
```

Authority: title, owner, archive state, `agentProfileId`, stable
`AgentProtocol.SessionId`, optional `WorkspaceId`, timestamps.

It **does not** store canonical message history and it **does not** execute
session operations.

Provide layers such as:

- `ConversationStore.memory`;
- `ConversationStore.sqlite`;
- `ConversationStore.postgres`.

The rest of the application sees the service, not the database.

### 3. `AgentCatalog` — stored agent configuration

**Package:** `store`  
**Kind:** `Context.Service`

```ts
export interface AgentCatalogService {
  readonly get: (
    id: AgentProfileId
  ) => Effect.Effect<Option.Option<AgentProfile>, AgentCatalogError>

  readonly list: (
    owner: UserId
  ) => Effect.Effect<ReadonlyArray<AgentProfile.Summary>, AgentCatalogError>

  readonly put: (
    profile: AgentProfile
  ) => Effect.Effect<void, AgentCatalogError>

  readonly remove: (
    id: AgentProfileId
  ) => Effect.Effect<void, AgentCatalogError>
}

export class AgentCatalog
  extends Context.Service<AgentCatalog, AgentCatalogService>()(
    "workbench/AgentCatalog"
  ) {}
```

`AgentProfile` is declarative data: instructions, model profile, selected tool
sources, skill ids, memory policy, permission policy, budget preset and
workspace policy. It is **not** an `AgentDefinition<any,...>` serialized into
JSON.

### 4. `AgentDirectory` — dynamic agent id → existing `AgentClient`

**Package:** `runtime`  
**Kind:** `Context.Service`

This is the critical dynamic composition seam for an Open-WebUI-style product.
A user can create agent profiles at runtime, while every consumer still talks
to the existing `AgentClient` contract.

```ts
export interface AgentDirectoryService {
  readonly client: (
    id: AgentProfileId
  ) => Effect.Effect<
    AgentClient.Service,
    AgentResolutionError,
    Scope.Scope
  >
}

export class AgentDirectory
  extends Context.Service<AgentDirectory, AgentDirectoryService>()(
    "workbench/AgentDirectory"
  ) {}
```

Server implementation:

1. load `AgentProfile` from `AgentCatalog`;
2. resolve model/tool/skill/memory/permission layers;
3. construct the typed `AgentDefinition`;
4. erase only at the already-defined remote boundary by exposing an
   `AgentClient.Service`;
5. cache scoped per-agent wiring with Effect resource combinators
   (`LayerMap` is the first candidate) rather than a process-global
   `Map<id, any>`.

Browser implementation:

- resolve the profile id to a server endpoint;
- construct/cache an HTTP or RPC implementation of **the same**
  `AgentClient.Service`.

This is what lets React, a TUI, a remote desktop client and an automated test
share exactly one execution API.

### 5. `ConversationSessions` — join product identity to execution identity

**Package:** `runtime`  
**Kind:** `Context.Service`

This service coordinates creation/opening but deliberately returns the existing
`RemoteSession` instead of wrapping all its methods.

```ts
export interface OpenConversation {
  readonly conversation: Conversation.Record
  readonly session: AgentClient.RemoteSession
}

export interface ConversationSessionsService {
  readonly create: (input: {
    readonly ownerId: UserId
    readonly agentProfileId: AgentProfileId
    readonly workspaceId?: WorkspaceId
  }) => Effect.Effect<
    OpenConversation,
    ConversationSessionError,
    Scope.Scope
  >

  readonly open: (
    id: ConversationId
  ) => Effect.Effect<
    OpenConversation,
    ConversationSessionError,
    Scope.Scope
  >
}

export class ConversationSessions
  extends Context.Service<ConversationSessions, ConversationSessionsService>()(
    "workbench/ConversationSessions"
  ) {}
```

`create` is the one place allowed to coordinate:

```text
AgentDirectory.client(agentProfileId)
        |
AgentClient.createSession({ sessionId })
        |
ConversationStore.create({ same sessionId, ... })
```

`open` performs:

```text
ConversationStore.get(id)
        |
AgentDirectory.client(record.agentProfileId)
        |
AgentClient.session(record.sessionId)
```

After that, callers receive `RemoteSession` and use its typed methods
directly. This prevents a parallel "workbench run API" from appearing.

The implementation must define compensation if session creation succeeds and
metadata persistence fails. For durable backends, stable ids make the operation
retryable; do not solve it with an untyped distributed transaction abstraction.

### 6. `WorkspaceStore` — workspace metadata

**Package:** `store`  
**Kind:** `Context.Service`

A workbench workspace record maps product ownership/lifecycle to the existing
sandbox identity:

```ts
export const WorkspaceRecord = Schema.Struct({
  id: WorkspaceId,
  ownerId: UserId,
  sandboxWorkspace: Sandbox.Workspace,
  label: Schema.String,
  createdAt: Schema.DateTimeUtc
})
```

CRUD lives in `WorkspaceStore`. It does not expose read/write/exec.

### 7. `WorkspaceRuntime` — product workspace id → `Sandbox`

**Package:** `runtime`  
**Kind:** `Context.Service`

```ts
export interface WorkspaceRuntimeService {
  readonly acquire: (
    id: WorkspaceId
  ) => Effect.Effect<
    Sandbox.Sandbox,
    WorkspaceRuntimeError,
    Scope.Scope
  >
}

export class WorkspaceRuntime
  extends Context.Service<WorkspaceRuntime, WorkspaceRuntimeService>()(
    "workbench/WorkspaceRuntime"
  ) {}
```

Implementation loads `WorkspaceRecord.sandboxWorkspace` and delegates to
`Sandbox.acquire`. It adds product lookup/authorization and **no filesystem
semantics**.

The actual agent wiring still uses `Sandbox.currentLayer(workspace)` /
`Sandbox.Current` so tool code is identical whether invoked from the
workbench, CLI or TUI.

### 8. `AttachmentCatalog` + existing `BlobStore`

**Package:** `store` / `runtime`

Do not create another byte store. Use:

```text
AttachmentCatalog
  AttachmentId -> ConversationId + BlobStore.BlobRef + display metadata

BlobStore
  BlobRef -> bytes
```

Suggested service:

```ts
export interface AttachmentCatalogService {
  readonly add: (
    attachment: Attachment.Record
  ) => Effect.Effect<void, AttachmentStoreError>

  readonly list: (
    conversationId: ConversationId
  ) => Effect.Effect<ReadonlyArray<Attachment.Record>, AttachmentStoreError>

  readonly remove: (
    id: AttachmentId
  ) => Effect.Effect<Option.Option<Attachment.Record>, AttachmentStoreError>
}
```

A higher-level `Attachments` module may compose `AttachmentCatalog |
BlobStore.BlobStore` for upload/delete/GC, but `BlobStore` remains byte
authority and `BlobWire` remains the wire reference format.

### 9. `ArtifactCatalog` — references, not renderer components

**Package:** `domain` + `store`

Define a UI-neutral source union:

```ts
export const ArtifactSource = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Blob"),
    ref: BlobStore.BlobRef
  }),
  Schema.Struct({
    _tag: Schema.Literal("WorkspaceFile"),
    workspaceId: WorkspaceId,
    path: Sandbox.SandboxPath
  }),
  Schema.Struct({
    _tag: Schema.Literal("Inline"),
    mediaType: Schema.String,
    value: Schema.Unknown
  })
])
```

`Artifact.Record` adds id, conversation id, title, media type and source.
`ArtifactCatalog` stores/query these descriptors.

React renderers are a separate registry:

```ts
type ArtifactRenderer<A> = (artifact: A) => ReactNode
```

and therefore do not leak into `domain` or `store`.

Where the artifact is genuinely typed application output, prefer
`AgentData`; the catalog can retain a stable descriptor/reference to it.

### 10. `ConnectionStore` over existing credential seams

**Package:** `store`

Store:

- integration/provider name;
- owner/user association;
- non-secret configuration;
- `Credentials.Binding`;
- provider key / credential handles;
- connection health metadata.

Never store the resolved value. Runtime resolution is exactly:

```text
ConnectionStore
   -> Credentials.Binding / handle
   -> Credentials.Bindings
   -> Credentials.Provider
   -> Redacted value at invocation
```

If the web UI lets a user paste a secret, the write endpoint calls the selected
`Credentials.Provider.set` when it is writable and stores only the resulting
handle/binding.

### 11. `WorkbenchProtocol` — product schemas only

**Package:** `protocol`  
**Kind:** pure `Schema` module

This protocol covers only concepts `AgentProtocol` does not own:

- conversations;
- agent profiles;
- workspaces;
- attachments;
- artifacts;
- connections/settings.

It should **reuse kernel schemas by reference**:

```ts
export const Conversation = Schema.Struct({
  id: WorkbenchIds.ConversationId,
  sessionId: AgentProtocol.SessionId,
  agentProfileId: WorkbenchIds.AgentProfileId,
  workspaceId: Schema.optional(WorkbenchIds.WorkspaceId),
  ...
})
```

It must not define alternate schemas for prompt, steer, follow-up, interrupt,
pending, history, status or agent events. Those remain `AgentProtocol`.

### 12. Product client services — transport-neutral Effect APIs

**Package:** `client`

Prefer small services rather than one god-object. At minimum:

```text
ConversationClient
AgentCatalogClient
WorkspaceClient
AttachmentClient
ArtifactClient
ConnectionClient
```

Each returns `Effect` / `Stream` with `Schema.TaggedError` failures and
has in-process plus HTTP/RPC layers.

An optional convenience `WorkbenchClient` may aggregate them, but individual
Context tags remain available so a test can replace only `ArtifactClient`
without replacing conversations and workspaces too.

**Agent execution is intentionally absent from this list.** Frontends require
`AgentDirectory` / `AgentClient` separately.

### 13. `ConversationProjection` — pure `AgentEvent` → UI state

**Package:** `ui-core`  
**Kind:** pure module, not a service

This is the key to avoiding an assistant-ui-shaped domain model.

Define Schema-owned UI-neutral state:

```ts
export interface ConversationView {
  readonly messages: ReadonlyArray<MessageView>
  readonly activity: ReadonlyArray<ActivityView>
  readonly pending: ReadonlyArray<Elicitation.Request>
  readonly status: AgentProtocol.SessionStatus
  readonly lastSequence: Option.Option<number>
}

export const initial = (
  history: PromptWire.Prompt,
  pending: ReadonlyArray<Elicitation.Request>,
  status: AgentProtocol.SessionStatus
): ConversationView => ...

export const transition = (
  state: ConversationView,
  envelope: AgentEvent.AgentEventEnvelope
): readonly [ConversationView, ReadonlyArray<ViewPatch>] => ...
```

Properties:

- pure and deterministic;
- exhaustive matching over known `AgentEvent` tags where appropriate;
- unknown/future events can be retained as generic activity rather than
  crashing;
- no React nodes;
- no assistant-ui message objects;
- no AG-UI events;
- no persistence authority.

The same transition function can drive React, Solid, a TUI, tests, screenshots,
or an assistant-ui adapter.

### 14. `ConversationPresenter` — scoped Effect state for a frontend

**Package:** `ui-core`  
**Kind:** scoped constructor, optionally exposing a `Context.Service`

```ts
export interface ConversationPresenter {
  readonly conversation: Conversation.Record
  readonly session: AgentClient.RemoteSession
  readonly state: SubscriptionRef.SubscriptionRef<ConversationView>
}

export const make = (
  id: ConversationId
): Effect.Effect<
  ConversationPresenter,
  ConversationPresenterError,
  ConversationSessions | Scope.Scope
>
```

Construction:

1. `ConversationSessions.open(id)`;
2. read `session.history`, `session.pending`, `session.status`;
3. build `ConversationProjection.initial`;
4. subscribe to `session.events({ after })` when resumption is available;
5. reduce events into the `SubscriptionRef` in a scoped fiber.

Commands are **not copied onto the presenter**. The UI calls
`presenter.session.prompt/submit/steer/followUp/interrupt/respond` directly.
The presenter owns presentation state, not execution semantics.

A React hook is then tiny:

```text
useConversation(id)
   -> scoped ConversationPresenter
   -> subscribe to presenter.state
```

and a TUI can consume the same `SubscriptionRef.changes` stream.

### 15. UI framework adapters

**Package:** `react`, `assistant-ui`, future `solid`

These adapters may depend on UI libraries. Nothing below them may.

Examples:

```text
@workbench/react
  ConversationPresenter -> hooks/context/components

@workbench/assistant-ui
  ConversationView + RemoteSession -> assistant-ui runtime/messages

@workbench/ag-ui
  optional interoperability path using existing effect-agent/ag-ui
```

Deleting `@workbench/assistant-ui` must leave the domain, server, persistence,
transport, session lifecycle and tests intact.

### 16. HTTP/RPC adapters

**Package:** `server`

Use Effect HTTP/RPC the same way the framework already does:

- product routes are generated from `WorkbenchProtocol`;
- agent routes reuse `AgentProtocol`;
- `AgentDirectory` selects which `AgentClient` serves a dynamic
  `AgentProfileId`;
- principal/auth context is resolved once and supplied to both product policy
  and `AgentSessionHost`.

For dynamic user-created agents, do not require one statically registered
`HttpApi` group per profile. Build an application-level routing adapter keyed
by `AgentProfileId` that delegates to the resolved `AgentClient` while
reusing `AgentProtocol` schemas. That is routing, not a new protocol.

### Dependency rule

The dependency graph should point inward:

```text
React / assistant-ui
        |
        v
     ui-core
        |
        +-----------> client ----------> protocol ----> domain
        |                                  |
        +-----------> AgentClient <--------+
                          |
                          v
                    effect-agent

server -> runtime -> store -> domain
   |        |          |
   |        +------> effect-agent Sandbox / Blob / Credentials
   +---------------> AgentSessionHost / AgentClient
```

Forbidden edges:

- `domain -> React`;
- `domain -> assistant-ui`;
- `store -> AG-UI`;
- `runtime -> React`;
- `effect-agent core -> workbench`;
- `ConversationStore -> canonical message history`;
- `ConversationPresenter -> model/tool execution logic`.

This is the composition boundary that gives the project freedom to replace the
entire UI stack without touching its agent or product semantics.

---

## Repository shape

Keep the framework repository a framework repository. The preferred shape is a
separate application repository, for example `doeixd/effect-agent-workbench`.
That forces the workbench to consume the same public package a third party
would.

If development velocity initially requires a monorepo app, keep the package
edges below identical and move it out once the first vertical slice is stable.

```text
effect-agent-workbench/
  apps/
    web/
    server/
  packages/
    domain/
    store/
    runtime/
    protocol/
    client/
    ui-core/
    react/
    assistant-ui/   # optional
    server/
```

Only `react/` and `assistant-ui/` may depend on those UI libraries.
`domain/`, `protocol/`, `client/`, and `ui-core/` must remain usable by
another frontend.

The workbench must never import `effect-agent` engine internals directly.

---

## Frontend architecture

### The stable frontend API is Effect, not a component library

The frontend core should consume:

- product `*Client` services for workbench metadata;
- `AgentDirectory` / `AgentClient` for execution;
- `ConversationPresenter` for scoped projected state;
- `BlobWire`, `Elicitation`, and shared `Schema` values where needed.

A component library is downstream of that contract.

### First-party React binding

Build a thin `react/` package around `ConversationPresenter` and the product
clients. It should mostly contain:

- scoped runtime/provider wiring;
- hooks over `SubscriptionRef` / streams;
- render components for `ConversationView`;
- browser-only input concerns such as drag/drop and clipboard.

It should not contain session lifecycle or persistence logic.

### assistant-ui is an optional adapter

Use assistant-ui if it saves meaningful work on composer behavior, accessible
message interactions, branching controls, attachments, or polished tool views.

But implement it in `packages/assistant-ui` as:

```text
ConversationPresenter
   + ConversationView
   + RemoteSession
           |
           v
assistant-ui runtime adapter
```

No server module should know whether this package is installed.

### AG-UI is an interoperability adapter

Keep `@doeixd/effect-agent/ag-ui` supported and contract-tested. It is useful
for external AG-UI clients and may be the fastest way to bootstrap an
assistant-ui adapter.

It is **not required** for the first-party frontend if a browser-safe
`AgentClient` HTTP/RPC implementation can be used directly. W0 must test this.
If the existing generated HTTP client is not browser-appropriate, add a
browser-safe `AgentClient` transport implementation against
`AgentProtocol`; do not move AG-UI types into `ui-core`.

### AI Elements is optional visual source material

Vercel AI Elements may be copied selectively for visual components such as
source cards, reasoning views, code blocks, attachments or artifact chrome.
Do not introduce Vercel AI SDK as an execution dependency merely to use those
components.

### CopilotKit is not part of the core design

The workbench already has typed state, an execution seam and AG-UI
interoperability. Add CopilotKit only if a concrete later feature justifies an
adapter. It must sit at the same edge as assistant-ui, not between the workbench
and `effect-agent`.

---

## Canonical data model

The product database should distinguish **catalog records** from **execution
records**.

### Product records

```ts
type User = {
  id: string
  name: string
}

type AgentDefinition = {
  id: string
  ownerId: string
  name: string
  description?: string
  instructions: string
  modelConfigurationId: string
  toolConfigurationId?: string
  memoryConfigurationId?: string
  permissionConfigurationId?: string
  createdAt: Date
  updatedAt: Date
}

type Conversation = {
  id: string
  ownerId: string
  agentDefinitionId: string
  sessionId: string
  workspaceId?: string
  title: string
  archivedAt?: Date
  createdAt: Date
  updatedAt: Date
}

type Workspace = {
  id: string
  ownerId: string
  sandboxRef: string
  root?: string
  createdAt: Date
}

type Attachment = {
  id: string
  conversationId: string
  blobId: string
  name: string
  mediaType: string
  size: number
}

type Connection = {
  id: string
  ownerId: string
  provider: string
  credentialRef: string
}

type ModelConfiguration = {
  id: string
  provider: string
  model: string
  options: unknown
}
```

These are product concepts. They do not belong in core `Agent.make`.

### Execution records

Canonical conversation history, run state and lifecycle semantics remain owned
by the session/client/durability layer. The product database stores identifiers
and projections needed for browsing and search; it must not invent a parallel
transcript that can disagree with the kernel.

If a denormalized message index is required for search, it is a rebuildable
projection.

---

## Conversation and session lifecycle

A conversation is the product object the user sees. An `AgentSession` is the
execution object behind it.

```text
Conversation
    |
    +-- AgentDefinition
    |
    +-- AgentSession/sessionId
    |
    +-- optional Workspace
```

Rules:

1. Creating a conversation creates or reserves exactly one session id.
2. Reopening a conversation reconnects to that session/history; it does not
   silently create a new execution lineage.
3. Archiving a conversation is not automatically the same thing as destroying
   durable session history.
4. Deleting a conversation must define explicitly whether the execution record,
   workspace and blobs are deleted or merely detached.
5. Session branching should use `/tree` rather than a UI-only message copy.
6. Compaction should use `/compaction` and preserve canonical history
   semantics rather than rewriting product messages.

---

## Workspace model

The key idea to borrow from bb is the association between a visible thread and
an execution environment.

For this application:

```text
Conversation
      |
      +-- AgentSession
      |
      +-- Workspace
             |
             +-- Sandbox
```

The workbench should not create a second environment abstraction below
`Sandbox`. A workspace is product metadata that selects/configures a sandbox
and gives it a stable identity across visits.

A workspace may be:

- absent for ordinary chat;
- a local directory for a local single-user install;
- a container/VM for a hosted install;
- a remote sandbox provider through a future adapter.

The UI should only assume the portable workspace capabilities it actually needs:
list/read/write files, process execution where allowed, and file-change
observation if available.

---

## Event model and UI projection

`AgentEvent` remains the source event vocabulary.

The application should render a timeline from events such as:

```text
SubmissionStarted
RunStarted
TurnStarted
MessageStarted
MessageDelta
ToolCallStarted
ToolCallProgress
ToolCallSucceeded
ElicitationRequested
MessageCompleted
TurnCompleted
RunCompleted
SubmissionCompleted
```

AG-UI maps the relevant subset into browser-facing events.

Do not persist AG-UI events as the only durable event log. The direction is:

```text
AgentEvent
   |
   +-- observability / durable delivery / audit
   |
   +-- AG-UI projection
          |
          +-- React rendering
```

This preserves richer internal semantics and leaves other frontends free to
project the same session differently.

---

## UI surfaces

### Conversation shell

The first release should have:

- conversation sidebar;
- new conversation;
- rename/archive/delete;
- recent grouping and search;
- agent selector;
- model selector where the selected agent permits it;
- responsive single-column mobile layout.

### Timeline

Render:

- user messages;
- assistant markdown;
- streamed text;
- streamed reasoning where available and permitted;
- tool calls;
- tool progress;
- tool success/failure;
- elicitation/approval;
- interruption;
- attachments;
- source/citation cards when structured data is available;
- subagent activity as nested/linked work rather than flattened prose.

### Composer

Support:

- text;
- send/stop;
- attachments;
- drag/drop and paste;
- follow-up queueing when a run is active;
- steering as a distinct action from follow-up where the UX can make the
  distinction understandable;
- slash/skill discovery later.

The UI must not collapse `steer`, `followUp` and `interrupt` into one
ambiguous "send while running" behavior.

### Right-side work panel

Phase two adds:

- workspace file tree;
- file viewer;
- text diff viewer;
- shell/process output;
- generated artifact preview;
- structured application state inspector where useful.

Chat remains usable without this panel.

---

## Elicitation and permissions

The kernel already distinguishes pausing from interruption. Preserve that
distinction visually.

An `ElicitationRequested` event should produce an explicit pending card with
the requested schema/content and clear actions. Responding calls the existing
session/host response operation.

For tool approvals:

- display tool name and arguments;
- show risk-relevant context where available;
- approve or deny exactly the pending id;
- handle "answered too late" as a normal race, not a false success;
- never interpret closing a modal as approval.

Permission policy remains on the agent/host side. The frontend only gathers a
decision.

---

## Attachments and blobs

Use `/blob` and `PromptWire` rather than inventing a browser-only file
encoding.

Flow:

```text
browser upload
   |
product blob endpoint
   |
Blob store
   |
stable blob reference
   |
Prompt.RawInput / PromptWire
   |
AgentSession
```

Requirements:

- content type and size are validated server-side;
- previews do not require embedding the full payload in conversation records;
- deleting a conversation does not leak orphaned blobs indefinitely;
- remote transports preserve file/media semantics;
- model capability checks happen before dispatch when possible.

---

## Artifacts

Artifacts are a product projection, not a new model message type.

Start with deterministic renderers over ordinary outputs:

- Markdown/text;
- code;
- HTML in a sandboxed iframe;
- SVG;
- JSON;
- images;
- downloadable files;
- diffs.

An artifact may be emitted through structured `/data`, a tool result, a blob
reference, or a workspace file. The UI should normalize those into a common
preview surface without forcing the kernel to know about React artifact
components.

Do not allow arbitrary generated HTML/JS to execute in the application origin.

---

## Agent configuration

An agent editor should assemble an `AgentDefinition` from existing seams:

- instructions;
- language model/model configuration;
- toolkit/tool sources;
- skills;
- memory;
- context transform policy;
- loop/budget;
- permission policy;
- sandbox/workspace policy;
- subagent policy.

The editor is configuration over `Agent.make`; it should not require adding
"UI options" to `Agent.make`.

A simple initial version may expose only instructions, model, tools and
permissions.

---

## Connections and tools

Later releases should provide a connections screen for:

- MCP servers;
- tool sources;
- API credentials;
- plugin packages;
- web/search providers.

Credentials must flow through the existing credential/redaction model and
should never be stored as plain values in conversation or agent records.

The workbench should render tool catalogs and connection health but leave tool
resolution/execution to `effect-agent`.

---

## Memory, skills and state

These should appear in the product only after the basic conversation lifecycle
is solid.

### Memory

Expose:

- whether memory is enabled for an agent;
- inspect/delete user-owned memories if the implementation can do so safely;
- clear indication that recalled memory is derived context, not canonical
  conversation history.

### Skills

Expose skill discovery and load-on-demand status. The composer may eventually
offer slash-command-style skill selection, but the kernel remains authoritative
about what is advertised/loaded.

### State

Use AG-UI state snapshots/deltas where useful for shared application state.
This enables agent-native panels without turning every state update into a chat
message.

---

## Multi-agent UX

`/subagent` and the session tree should eventually surface delegation.

Do not flatten delegated work into opaque parent text if the event/session model
can identify the child.

Preferred UI:

```text
Parent run
  |
  +-- delegated: research pricing
  |     +-- child session
  |     +-- 3 tool calls
  |     +-- completed
  |
  +-- delegated: inspect repository
        +-- child session
        +-- running
```

Users should be able to inspect a child session without changing the semantics
of the parent's canonical history.

---

## Persistence and search

The product needs its own catalog database even when sessions are durable
elsewhere.

Minimum indexed fields:

- conversation id/title;
- agent id/name;
- timestamps;
- owner;
- archived flag;
- workspace reference.

Full-text message search should be a projection from canonical history. It must
be rebuildable and should record the session/history position it indexed.

Do not make search availability a requirement for executing or reopening a
conversation.

---

## Auth and tenancy

The product server authenticates a user and resolves that identity into the
principal supplied to `AgentSessionHost`.

The host remains authoritative for authorization on session operations.

The workbench adds product-level checks for objects that are not kernel objects:
conversation metadata, agent definitions, workspaces, connections and blobs.

In a single-user local deployment, the same interfaces should work with a
constant local principal rather than a separate code path.

---

## Deployment profiles

The application should support at least two profiles without changing its
frontend contract.

### Local

- one user;
- local database;
- local sandbox;
- local filesystem blobs;
- providers configured by environment/settings.

### Hosted

- authenticated users;
- durable database;
- object/blob storage;
- remote or isolated sandboxes;
- durable/clustered agent clients where required.

The UI speaks to the same product/AG-UI surface in both cases.

---

## Observability and usage

Build from existing event/observability seams.

Useful product views later:

- token usage;
- model/provider;
- run duration;
- tool duration/failure;
- active sessions;
- pending elicitations;
- sandbox/resource usage.

The workbench may aggregate and display telemetry, but it should not force a
specific exporter into `effect-agent`.

---

## Invariants

**W1 — One execution model.** Every prompt, steer, follow-up, interrupt,
approval and tool run goes through existing `effect-agent` semantics.

**W2 — Public API only.** The workbench can be built as an external consumer of
the package. An internal import is a bug in the framework boundary.

**W3 — AgentEvent is canonical.** AG-UI and React state are projections, not the
authoritative event log.

**W4 — Conversation identity is stable.** Reopening a conversation reconnects
to its execution lineage rather than silently creating another one.

**W5 — Workspace is product metadata over Sandbox.** No second filesystem or
process capability abstraction is introduced.

**W6 — Derived views are rebuildable.** Message search indexes, previews and UI
activity timelines may be discarded and regenerated from canonical sources.

**W7 — Human approval is explicit.** No UI dismissal, timeout or transport race
can turn into an implicit grant.

**W8 — Local and hosted share contracts.** Deployment changes layers and
services, not the application model.

**W9 — Chat works without Work.** A conversation with no workspace remains a
fully supported first-class case.

**W10 — Work works without coding lock-in.** A workspace is useful for files,
artifacts and state even when the agent is not a coding agent.

**W11 — The UI framework is disposable.** Removing assistant-ui, AG-UI, React,
or any other presentation adapter does not change domain schemas, stores,
runtime composition, session identity, or execution semantics.

**W12 — Product protocols do not duplicate AgentProtocol.** Workbench wire
schemas cover product concepts only; agent commands and event envelopes remain
the framework's schemas.

---

## Milestones

### W0 — Effect-native frontend seam spike

Goal: prove the UI-independent vertical slice before choosing presentation
libraries.

Build:

- `WorkbenchIds`;
- in-memory `ConversationStore` and `AgentCatalog`;
- a minimal `AgentDirectory` over one existing agent;
- `ConversationSessions`;
- `ConversationProjection`;
- `ConversationPresenter`;
- the browser transport needed to obtain the same `AgentClient.Service`;
- a deliberately plain React page over `ConversationPresenter`.

Acceptance:

1. create/open a conversation through the proposed services;
2. send a prompt through `RemoteSession`;
3. stream assistant text into `ConversationProjection`;
4. render reasoning, a tool call and tool progress from `AgentEvent`;
5. stop/interruption works through `RemoteSession.interrupt`;
6. an elicitation can be answered through `RemoteSession.respond`;
7. refresh/reconnect reconstructs from history plus resumable events where the
   backend supports them;
8. no React or assistant-ui type appears in `domain/store/runtime/protocol/client/ui-core`;
9. no custom execution state machine exists in the frontend.

Then, as a **separate adapter proof**, wire the same presenter/session into
assistant-ui. The assistant-ui demo passes if deleting that package leaves the
plain React client and all core tests green.

If W0 exposes a transport or event-projection gap, fix the corresponding
`AgentClient`, `AgentProtocol`, or adapter seam rather than coding around it
inside React.

### W1 — Conversation product shell

Add:

- product database;
- conversation create/list/open/rename/archive/delete;
- agent definition table;
- model configuration;
- stable mapping from conversation id to session id;
- sidebar and basic settings.

Acceptance: reload the browser and continue the exact same conversation.

### W2 — Chat completeness

Add:

- attachments;
- message actions supported by the underlying session/tree semantics;
- source/tool cards;
- pending approvals;
- good error/retry states;
- mobile/responsive layout;
- keyboard and accessibility pass.

Acceptance: ordinary chat use no longer feels like a framework demo.

### W3 — Workspace

Add:

- workspace record;
- sandbox binding;
- file tree;
- file reader;
- diffs;
- shell/tool output panel.

Acceptance: a coding agent can modify a workspace and the user can inspect every
change without leaving the conversation.

### W4 — Artifacts and data UI

Add:

- artifact registry/projection;
- HTML/SVG/image/code/JSON/file previews;
- `/data`-driven application panels;
- safe iframe isolation.

Acceptance: a non-coding agent can produce rich useful outputs without
pretending they are workspace source files.

### W5 — Agent builder

Add configuration for:

- instructions;
- provider/model;
- tools/tool sources;
- permissions;
- skills;
- memory;
- budget/loop presets;
- workspace policy.

Acceptance: create two materially different agents entirely from the web UI and
run them through the same session infrastructure.

### W6 — Connections

Add:

- MCP/tool-source configuration;
- credentials;
- plugin packages;
- connection health/test;
- per-agent capability selection.

Acceptance: a user can connect a tool source without editing application code.

### W7 — Multi-agent and advanced session UX

Add:

- child-session/delegation visualization;
- branch/rewind UI over `/tree`;
- compaction controls/status;
- queued follow-ups and steering UX;
- background/durable run reconnection.

Acceptance: long-running and delegated work remains understandable after page
reload and reconnect.

### W8 — Administration and distribution

Add:

- user administration where applicable;
- usage/telemetry views;
- import/export;
- deployment documentation;
- Docker/local installation path;
- hosted reference deployment.

Acceptance: another developer can self-host the application from documented
steps without knowing the repository internals.

---

## Implementation order

Do the smallest slice that falsifies the architecture first:

```text
W0 integration
  -> W1 conversation persistence
  -> W2 complete chat
  -> W3 workspace
  -> W4 artifacts
  -> W5 agent builder
  -> W6 connections
  -> W7 advanced/multi-agent
  -> W8 distribution/admin
```

Do not start with an admin panel, marketplace, elaborate RAG interface or a
full Open WebUI settings clone.

The first serious architectural test is whether `AgentClient`,
`AgentProtocol`, `AgentEvent` and the proposed product services can support
a polished persistent chat without private imports or UI-library types. AG-UI
and assistant-ui are then adapter conformance tests over that foundation.

---

## What to borrow from existing projects

### assistant-ui

Borrow/use at the adapter edge:

- thread and composer behavior;
- streaming presentation;
- message actions;
- tool/reasoning rendering primitives;
- accessibility behavior;
- its AG-UI runtime when that adapter path is useful.

Do not let assistant-ui own conversation identity, canonical messages,
execution commands, persistence, or the workbench's projected state model.
There must also be a non-assistant-ui frontend test over the same
`ConversationPresenter`.

### bb

Borrow concepts:

- thread + environment association;
- multi-pane inspection;
- visible tool/file activity;
- child/delegated work UX;
- reconnectable long-running work.

Do not copy its provider-runtime abstraction over Claude Code/Codex; that role
is already filled by `effect-agent`.

### Open WebUI

Borrow product lessons:

- provider/model settings;
- chat organization/search;
- knowledge/file UX;
- tool/MCP configuration;
- admin and multi-user ergonomics.

Do not inherit its source-available licensing or its execution model.

### Vercel AI Elements / Chatbot

Borrow source/components where useful:

- polished visual treatment;
- artifact/source/tool patterns;
- attachment UX.

Do not add Vercel AI SDK as a second runtime merely for UI convenience.

---

## Framework feedback loop

The workbench is an acceptance test for the library.

When the application encounters a missing capability, classify it before adding
anything to core:

1. **Product concern** — keep it in the workbench.
   Examples: conversation title, sidebar grouping, user avatar, theme.

2. **Projection concern** — add/fix an adapter.
   Examples: AG-UI cannot represent an existing event or resume correctly.

3. **Reusable capability over an existing seam** — add a battery.
   Examples: a portable workspace capability genuinely missing from
   `/sandbox`.

4. **Execution semantic required by every frontend** — only then consider core.

This prevents the reference app from turning the kernel into a web framework.

---

## First concrete task list

1. Create a separate workbench repository or temporary isolated workspace with
   the package boundaries in this plan.
2. Implement `domain/WorkbenchIds` and Schema-owned product records.
3. Implement in-memory `ConversationStore`, `AgentCatalog` and
   `WorkspaceStore` layers.
4. Implement `AgentDirectory` for one statically configured agent, returning
   the existing `AgentClient.Service`.
5. Implement `ConversationSessions.create/open` and pin stable
   conversation↔session identity with tests.
6. Implement pure `ConversationProjection.initial/transition` with exhaustive
   event fixtures.
7. Implement scoped `ConversationPresenter` using `SubscriptionRef` and a
   scoped event-consumer fiber.
8. Prove a browser-safe `AgentClient` transport. Prefer the existing HTTP/RPC
   client; add a browser adapter only if the existing one genuinely cannot run
   there.
9. Build a minimal plain React client over `ConversationPresenter` and
   `RemoteSession`.
10. Add integration coverage for text, reasoning, tool progress, interrupt,
    elicitation and reconnect.
11. Build assistant-ui as a **separate optional adapter** and verify the same
    tests/fixtures map cleanly.
12. Add attachments through `BlobStore` / `BlobWire` plus
    `AttachmentCatalog`.
13. Add `WorkspaceRuntime` as the product-id lookup over `Sandbox.acquire`.
14. Only after W1/W2 are solid, add artifact/file panes and richer settings.

## Success conditions

The plan is successful when:

- a third party can install the workbench and point it at supported model
  providers without modifying framework internals;
- the web app uses `effect-agent` as its only agent execution kernel;
- a conversation survives refresh/restart and resumes the same session;
- streaming, tools, progress, interruption and elicitation all render correctly;
- an optional workspace survives across turns and can be inspected from the UI;
- the same frontend works against local and remote/durable agent backends;
- the application itself becomes the strongest public example of how to build
  on `@doeixd/effect-agent`;
- replacing assistant-ui with plain React, Solid, or another presentation
  adapter requires changes only at the UI edge;
- workbench product protocols never redefine `AgentProtocol` operations or
  `AgentEvent` envelopes.

The intended result is not merely "chat for effect-agent." It is a permissively
licensed, general-purpose **agent workbench** whose architecture demonstrates
that the framework's session/event/capability seams are sufficient for an
Open-WebUI/bb-class application without surrendering the execution model to
another framework.
