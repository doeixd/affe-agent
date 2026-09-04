# Plan: Effect Agent Workbench

Written 2026-09-01.

**Status: specified, not implemented.**

This plan defines a polished, fully open-source web application around
`affe-agent`: a general-purpose agent workbench in the product class
of Open WebUI and bb, but with `affe-agent` as the execution kernel rather
than a second agent framework hidden behind the UI.

The workbench is both a useful application and a reference implementation. It
should prove that the public seams in `affe-agent` are sufficient to build a
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
- reusable prompts and command discovery;
- projects/folders and inherited context;
- knowledge bases, ingestion and RAG;
- suggestions, mentions and feedback;
- themes, appearance and user preferences;
- speech/voice adapters;
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
        affe-agent
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

The workbench must consume `affe-agent` as an ordinary package. If
the application needs an internal module, that is evidence of a missing public
seam and should be fixed in the library rather than bypassed.

### G3 — Preserve one execution model

The workbench introduces no second notion of run, tool, permission, memory,
session, or event. Product records may refer to kernel concepts, but execution
authority stays in `affe-agent`.

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
|                  affe-agent                             |
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

1. **existing `affe-agent` seams** — consume them unchanged;
2. **workbench domain services** — new application-level Effect services;
3. **UI projections/adapters** — pure or scoped modules that may be replaced
   without changing either execution or persistence.

### Existing seams to use directly

| need | exact module | role in the workbench |
| --- | --- | --- |
| Execute / reconnect to an agent session | `affe-agent/client` → `AgentClient`, `RemoteSession` | **Primary execution seam.** UI-independent prompt, submit/await, steer, follow-up, interrupt, respond, pending, history, status and event stream. Do not wrap these into a second agent API. |
| Wire-safe session vocabulary | `affe-agent/client` → `AgentProtocol` | `Schema`-owned session ids, request ids, requests, responses and remote errors. Product transports reuse these types rather than defining "WorkbenchPromptRequest". |
| Server-side session registry / auth | `affe-agent/client` → `AgentSessionHost` | Shared registry, capacity, principal resolution, authorization and idempotent request authority. |
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
  knowledge/    # ingestion/index/retrieval capabilities
  react/        # optional React bindings
  assistant-ui/ # optional adapter
  server/       # HTTP/RPC composition and auth wiring
```

`domain`, `protocol`, `client`, `ui-core`, and the interfaces in
`knowledge` must compile without React. `domain`, `protocol` and ideally
`client` should be browser-safe and contain no Node imports.

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
export const ProjectId =
  Schema.String.pipe(Schema.brand("workbench/ProjectId"))
export const PromptTemplateId =
  Schema.String.pipe(Schema.brand("workbench/PromptTemplateId"))
export const CommandId =
  Schema.String.pipe(Schema.brand("workbench/CommandId"))
export const KnowledgeCollectionId =
  Schema.String.pipe(Schema.brand("workbench/KnowledgeCollectionId"))
export const KnowledgeDocumentId =
  Schema.String.pipe(Schema.brand("workbench/KnowledgeDocumentId"))
export const FeedbackId =
  Schema.String.pipe(Schema.brand("workbench/FeedbackId"))
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
  optional interoperability path using existing affe-agent/ag-ui
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

### 17. `PromptCatalog` — reusable typed prompt templates

**Package:** `store` + `domain`  
**Kind:** `Context.Service`

A saved prompt is data, not a slash command and not a React callback.

```ts
export const PromptTemplate = Schema.Struct({
  id: PromptTemplateId,
  ownerId: UserId,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  body: Schema.String,
  parameters: Schema.optional(Schema.Unknown),
  tags: Schema.Array(Schema.String),
  version: Schema.Natural
})

export interface PromptCatalogService {
  readonly get: (
    id: PromptTemplateId
  ) => Effect.Effect<Option.Option<PromptTemplate>, PromptCatalogError>

  readonly search: (
    query: string
  ) => Effect.Effect<ReadonlyArray<PromptTemplate>, PromptCatalogError>

  readonly put: (
    template: PromptTemplate
  ) => Effect.Effect<void, PromptCatalogError>
}
```

The `parameters` field should become a Schema-owned form description rather
than an arbitrary UI form model. The first implementation may support a small
portable subset (string/number/boolean/literals/optional) and reject schemas it
cannot render rather than silently degrading them.

Expansion produces a `Prompt.RawInput` / `PromptWire.Prompt`; it never calls
a model itself.

This supports Open-WebUI-style reusable prompts, variables, versioning and
sharing without coupling them to how a composer invokes them.

### 18. `CommandRegistry` — actions discoverable through slash, palette or TUI

**Package:** `runtime` + `domain`  
**Kind:** `Context.Service`

"Slash command" is a presentation. The domain concept is a discoverable command.

```ts
export const Command = Schema.Struct({
  id: CommandId,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  aliases: Schema.Array(Schema.String),
  action: Schema.Union([
    Schema.Struct({
      _tag: Schema.Literal("Prompt"),
      templateId: PromptTemplateId
    }),
    Schema.Struct({
      _tag: Schema.Literal("Session"),
      action: Schema.Literals("interrupt", "compact", "branch")
    }),
    Schema.Struct({
      _tag: Schema.Literal("Skill"),
      skillId: Schema.String
    }),
    Schema.Struct({
      _tag: Schema.Literal("Navigate"),
      target: Schema.String
    }),
    Schema.Struct({
      _tag: Schema.Literal("Client"),
      actionId: Schema.String
    })
  ])
})
```

`CommandRegistry.search(context, query)` returns what is available here.
Availability may depend on the current agent, project, conversation, model,
workspace and deployment capabilities.

Execution is separated from discovery:

- prompt commands resolve through `PromptCatalog` and then use
  `RemoteSession.prompt/followUp/steer`;
- session commands use existing session/tree/compaction seams;
- skill commands resolve through the configured skills capability;
- navigation/client commands are interpreted by the presentation adapter.

No command record contains a JavaScript callback. The same registry can be
rendered as `/research`, a command palette, toolbar actions, mobile menus or
`:research` in a TUI.

### 19. `MentionProvider` — typed `@` references without composer lock-in

**Package:** `client` / `ui-core`  
**Kind:** small `Context.Service`

Mentions are references the composer can discover and encode, not text parsing
owned by React.

```ts
export const Mention = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(
    "agent",
    "file",
    "artifact",
    "knowledge",
    "project",
    "user",
    "custom"
  ),
  label: Schema.String,
  detail: Schema.optional(Schema.String)
})

export interface MentionProviderService {
  readonly search: (
    context: MentionContext,
    query: string
  ) => Effect.Effect<ReadonlyArray<Mention>, MentionError>
}
```

The selected mention resolves to an application intent or prompt part through a
separate resolver. A visual `@` autocomplete, command palette, or TUI chooser
can all consume the same provider.

### 20. Knowledge / RAG — ingestion and retrieval are real capabilities

**Package:** `domain`, `store`, and a dedicated `knowledge` package  
**Kind:** several small services, not one vector-database god object

Files alone do not constitute RAG. Keep the pipeline explicit:

```text
KnowledgeCatalog
      |
DocumentLoader
      |
    Chunker
      |
   Embedding
      |
KnowledgeIndex
      |
   Reranker
      |
KnowledgeRetriever
```

#### `KnowledgeCatalog`

Owns collection/document metadata and stable references to original content
(usually `BlobStore.BlobRef`), not embeddings.

```ts
export const KnowledgeDocument = Schema.Struct({
  id: KnowledgeDocumentId,
  collectionId: KnowledgeCollectionId,
  name: Schema.String,
  source: BlobStore.BlobRef,
  mediaType: Schema.String,
  status: Schema.Literals("pending", "indexing", "ready", "failed")
})
```

#### `DocumentLoader`

```ts
export interface DocumentLoaderService {
  readonly load: (
    document: KnowledgeDocument
  ) => Stream.Stream<DocumentPart, DocumentLoadError>
}
```

Provider-specific PDF/HTML/Office/media extraction belongs behind this seam.

#### `Chunker`

A pure/effectful policy:

```ts
type Chunker = (
  parts: Stream.Stream<DocumentPart, DocumentLoadError>
) => Stream.Stream<KnowledgeChunk, ChunkError>
```

Different chunkers can be selected per document type or collection without
changing storage or retrieval.

#### `EmbeddingModel`

```ts
export interface EmbeddingModelService {
  readonly embed: (
    texts: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, EmbeddingError>
}
```

Do not make a particular vector database's embedding client the contract.

#### `KnowledgeIndex`

```ts
export interface KnowledgeIndexService {
  readonly upsert: (
    chunks: ReadonlyArray<IndexedChunk>
  ) => Effect.Effect<void, KnowledgeIndexError>

  readonly search: (
    query: IndexQuery
  ) => Effect.Effect<ReadonlyArray<IndexHit>, KnowledgeIndexError>

  readonly removeDocument: (
    id: KnowledgeDocumentId
  ) => Effect.Effect<void, KnowledgeIndexError>
}
```

Implementations may be SQLite/vector extensions, Postgres/pgvector, a remote
vector service, BM25-only, or hybrid. The caller sees the same typed service.

#### `Reranker`

Optional:

```ts
export interface RerankerService {
  readonly rerank: (
    query: string,
    hits: ReadonlyArray<RetrievedChunk>
  ) => Effect.Effect<ReadonlyArray<RetrievedChunk>, RerankError>
}
```

A no-op layer is valid.

#### `KnowledgeRetriever`

The high-level seam most agents and UI code consume:

```ts
export const RetrievedChunk = Schema.Struct({
  documentId: KnowledgeDocumentId,
  text: Schema.String,
  score: Schema.Number,
  locator: Schema.Struct({
    page: Schema.optional(Schema.Number),
    lineStart: Schema.optional(Schema.Number),
    lineEnd: Schema.optional(Schema.Number)
  })
})

export interface KnowledgeRetrieverService {
  readonly search: (
    query: KnowledgeQuery
  ) => Effect.Effect<ReadonlyArray<RetrievedChunk>, RetrievalError>
}
```

One retriever can be exposed through **two existing agent seams**:

```text
KnowledgeRetriever
     |
     +-- ContextTransform      # automatic/traditional RAG
     |
     +-- Toolkit tool         # agentic search/read
```

Those are two policies over one retrieval capability, not two knowledge
systems. A project/agent chooses which policy it wants.

Retrieved chunks should carry source locators so citation/source UI can be
derived without inventing citation strings in React.

### 21. Four different things may contain bytes; do not call all of them "File"

The product must keep these concepts distinct even when all four ultimately
reference `BlobStore.BlobRef` or `SandboxPath`:

```text
Attachment
  "this content was supplied with this conversation/message"

KnowledgeDocument
  "this content was ingested and is retrievable"

WorkspaceFile
  "this path exists in the agent's execution environment"

Artifact
  "this is an output the agent produced for the user"
```

Their ownership, deletion, indexing, authorization and presentation semantics
are different. Conversion between them is an explicit operation:

- attachment → knowledge document: "add to knowledge";
- artifact → knowledge document: "index this result";
- artifact → workspace file: "save to workspace";
- workspace file → attachment: "attach this file".

Never infer one role merely because the bytes are the same.

### 22. `ProjectStore` + `EffectiveConfiguration` — folders with inherited context

**Package:** `store` + `runtime`

Open-WebUI-style folders/projects should be real context boundaries rather than
a nullable `folderId`.

```ts
export const Project = Schema.Struct({
  id: ProjectId,
  ownerId: UserId,
  name: Schema.String,
  instructions: Schema.optional(Schema.String),
  defaultAgentProfileId: Schema.optional(AgentProfileId),
  defaultModelProfileId: Schema.optional(ModelProfileId),
  workspaceId: Schema.optional(WorkspaceId),
  knowledgeCollectionIds: Schema.Array(KnowledgeCollectionId),
  toolConnectionIds: Schema.Array(ConnectionId)
})
```

`Conversation` may reference a `ProjectId`.

Resolve configuration explicitly:

```text
Deployment defaults
       +
User preferences
       +
Project
       +
AgentProfile
       +
Conversation overrides
       |
       v
EffectiveConfiguration
```

`EffectiveConfiguration` should be a pure/schema-owned resolved value plus a
service that computes it. `AgentDirectory` consumes that result when building
agent layers.

This prevents `Conversation` from accumulating dozens of nullable columns and
makes inheritance testable.

### 23. `ModelCatalog` — model discovery is distinct from model capability facts

**Package:** `client` / `store`

`ModelCapabilities` answers facts about a model already selected. A product
also needs to know what models a principal may choose.

```ts
export interface ModelCatalogService {
  readonly list: (
    context: ModelCatalogContext
  ) => Effect.Effect<ReadonlyArray<ModelSummary>, ModelCatalogError>
}
```

`ModelSummary` carries stable provider/model ids, display metadata and
available `ModelCapabilities` when known. Product-level aliases/presets live
in `ModelProfileStore`, not in the provider package.

The model picker therefore depends on `ModelCatalog`, while context sizing and
input affordances depend on `ModelCapabilities`.

### 24. `SuggestionProvider` — composer suggestions are replaceable policy

**Package:** `client` / `ui-core`

```ts
export interface SuggestionProviderService {
  readonly suggestions: (
    context: SuggestionContext
  ) => Effect.Effect<ReadonlyArray<Suggestion>, SuggestionError>
}
```

Implementations may be:

- static examples;
- agent/profile-provided starters;
- project-specific prompts;
- model-generated follow-up suggestions;
- no suggestions.

The UI only renders the returned data. Suggestion generation is not a
`ConversationPresenter` responsibility.

### 25. `FeedbackStore` — thumbs, ratings and annotations

**Package:** `store`

```ts
export const Feedback = Schema.Struct({
  id: FeedbackId,
  conversationId: ConversationId,
  submissionId: Schema.optional(AgentProtocol.SubmissionId),
  messageKey: Schema.optional(Schema.String),
  rating: Schema.Literals("up", "down"),
  comment: Schema.optional(Schema.String)
})
```

Feedback is product/evaluation data; it does not mutate canonical history.
A later eval/export pipeline may consume it.

### 26. `PreferencesStore` + `ThemeRegistry` — themes stay presentation-only

**Package:** `client` / `ui-core`

```ts
export const AppearancePreferences = Schema.Struct({
  mode: Schema.Literals("system", "light", "dark"),
  themeId: Schema.String,
  density: Schema.Literals("compact", "comfortable"),
  fontScale: Schema.Number
})
```

`PreferencesStore` persists user-level settings.

`ThemeRegistry` is a pure presentation registry mapping `themeId` to design
tokens/CSS-variable values. Agent/runtime packages never require it.

A downstream fork can replace Tailwind, CSS variables, the entire design
system, or React itself without migrating product records beyond stable
appearance preferences.

### 27. Speech is a family of adapters, not conversation state

**Package:** edge/client capability packages

Keep three concerns distinct:

```ts
export interface SpeechRecognitionService {
  readonly transcribe: (
    audio: Stream.Stream<Uint8Array>
  ) => Effect.Effect<Transcript, SpeechRecognitionError>
}

export interface SpeechSynthesisService {
  readonly speak: (
    text: string
  ) => Stream.Stream<Uint8Array, SpeechSynthesisError>
}

export interface VoiceSessionService {
  readonly connect: (
    context: VoiceContext
  ) => Effect.Effect<VoiceSession, VoiceSessionError, Scope.Scope>
}
```

Dictation can simply produce composer text. TTS consumes assistant text.
Realtime duplex voice is a separate later capability with different lifecycle
and transport requirements.

Microphone state, browser permission prompts and audio-device selection belong
to the browser adapter, not `ConversationPresenter`.

### 28. `CapabilityResolver` — the UI asks "what can I do here?"

**Package:** `runtime` + `client`

Avoid hard-coded UI conditionals that mirror half the server configuration.

```ts
export const WorkbenchCapabilities = Schema.Struct({
  attachments: AttachmentCapabilities,
  branching: BranchingCapabilities,
  workspace: Schema.optional(WorkspaceCapabilities),
  knowledge: Schema.optional(KnowledgeCapabilities),
  speech: Schema.optional(SpeechCapabilities),
  feedback: Schema.Boolean,
  suggestions: Schema.Boolean,
  commands: Schema.Array(CommandSummary),
  mentions: Schema.Array(MentionKind),
  models: ModelSelectionCapabilities
})

export interface CapabilityResolverService {
  readonly resolve: (
    context: CapabilityContext
  ) => Effect.Effect<WorkbenchCapabilities, CapabilityError>
}
```

Resolution may combine:

```text
principal
+ deployment policy
+ project
+ agent profile
+ model capabilities
+ connections
+ workspace
+ browser/client capabilities
```

The presenter may expose the resolved snapshot beside conversation state, but
it does not compute it. React renders available affordances from this typed
value.

This is the seam that allows the same UI to adapt cleanly to a local install, a
hosted multi-user deployment, a text-only model, a vision model, a workspace
agent or a plain chat agent.

### 29. `ViewRegistry` — typed generative UI without model-generated React

**Package:** `ui-core` + presentation adapters

Use `AgentData` as the typed producer side. A renderer registry lives at the
presentation edge.

Conceptually:

```text
AgentData.Channel<A>
       |
       | Schema A
       v
    ViewRegistry
       |
       +-- React renderer<A>
       +-- Solid renderer<A>
       +-- TUI renderer<A>
```

The model/tool emits typed data. It does not emit a React component name and an
unvalidated bag of props.

`ui-core` can define renderer-neutral view descriptors keyed by channel/schema
identity; framework packages register actual components.

This supports assistant-ui-style generative UI while preserving Effect's type
boundary.

### 30. `ConversationSearch` — search is a rebuildable projection

**Package:** `store` / `client`

```ts
export interface ConversationSearchService {
  readonly search: (
    query: ConversationSearchQuery
  ) => Effect.Effect<ReadonlyArray<ConversationSearchHit>, SearchError>
}
```

It indexes product metadata and a projection of canonical history. Every hit
records the session/history position it came from when possible.

Search can be SQLite FTS, Postgres, a hosted search engine or disabled. Failure
to index/search must never prevent conversation execution or recovery.

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
                    affe-agent

server -> runtime -> store -> domain
   |        |          |
   |        +------> affe-agent Sandbox / Blob / Credentials
   +---------------> AgentSessionHost / AgentClient
```

Forbidden edges:

- `domain -> React`;
- `domain -> assistant-ui`;
- `store -> AG-UI`;
- `runtime -> React`;
- `affe-agent core -> workbench`;
- `ConversationStore -> canonical message history`;
- `ConversationPresenter -> model/tool execution logic`.

This is the composition boundary that gives the project freedom to replace the
entire UI stack without touching its agent or product semantics.

---

## Repository shape

Keep the framework repository a framework repository. The preferred shape is a
separate application repository, for example `doeixd/affe-agent-workbench`.
That forces the workbench to consume the same public package a third party
would.

If development velocity initially requires a monorepo app, keep the package
edges below identical and move it out once the first vertical slice is stable.

```text
affe-agent-workbench/
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

The workbench must never import `affe-agent` engine internals directly.

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

Keep `affe-agent/ag-ui` supported and contract-tested. It is useful
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
and `affe-agent`.

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
- command discovery from `CommandRegistry` (slash syntax is one rendering);
- mentions from `MentionProvider`;
- suggestions from `SuggestionProvider`.

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

### Cross-cutting UI affordances

The first-party UI may include all of the following without changing execution
semantics:

- slash commands / command palette;
- saved prompt templates and parameter forms;
- `@` mentions;
- starter and follow-up suggestions;
- thumbs up/down and comments;
- light/dark/custom themes;
- model and agent pickers;
- conversation folders/projects;
- knowledge/source panels;
- speech-to-text and text-to-speech;
- typed generative UI panels.

Every one of these consumes one of the seams above. None is a reason to add a
method to `AgentSession` or a field to `ConversationPresenter`.

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

The word "file" must not collapse four product roles:

| role | authority | meaning |
| --- | --- | --- |
| Attachment | `AttachmentCatalog + BlobStore` | supplied with a conversation/message |
| Knowledge document | `KnowledgeCatalog + BlobStore` | ingested and retrievable |
| Workspace file | `WorkspaceRuntime + Sandbox` | exists in the execution environment |
| Artifact | `ArtifactCatalog` + blob/workspace/data source | output produced for the user |

Transitions between those roles are explicit user/application operations.

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

## Knowledge and RAG

RAG is a product/runtime subsystem over `KnowledgeRetriever`, not a special
chat-message format.

A knowledge collection owns source documents and indexing policy. The workbench
may offer both:

- **automatic retrieval** — a `ContextTransform` searches selected collections
  and adds retrieved context before a model call;
- **agentic retrieval** — a toolkit exposes search/read tools backed by the same
  `KnowledgeRetriever`.

Projects and agent profiles select collections and retrieval policy through
`EffectiveConfiguration`.

The UI renders source locators from `RetrievedChunk` as citation/source cards.
It never parses ad-hoc citation syntax to recover source identity.

Ingestion is asynchronous from the user's perspective but not conceptually
hidden: document state is `pending | indexing | ready | failed`, and clients
can observe/poll it through the product protocol. A future scheduling/job
adapter may perform ingestion durably without changing the knowledge services.

---

## Projects and inherited context

A project groups conversations and may supply instructions, knowledge,
workspace, connections, and defaults. It is more than a visual folder.

The effective agent configuration is resolved from layered product data before
`AgentDirectory` builds the agent:

```text
deployment -> user -> project -> agent profile -> conversation override
```

The resolved value is inspectable, testable and Schema-owned. Do not bury
inheritance rules in UI conditionals.

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
resolution/execution to `affe-agent`.

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

Use `AgentState` as the authority and project typed state into `AgentData` or
other client-facing schemas where useful. An AG-UI adapter may additionally map
that projection into AG-UI state snapshots/deltas, but `ui-core` must not
depend on that representation.

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

Full-text message search is provided through `ConversationSearch` as a
projection from canonical history. It must be rebuildable and should record the
session/history position it indexed.

Do not make search/index availability a requirement for executing or reopening
a conversation.

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

The UI consumes the same product client services and `AgentClient` contract in
both cases. AG-UI remains an optional interoperability adapter in either
profile.

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
specific exporter into `affe-agent`.

---

## Invariants

**W1 — One execution model.** Every prompt, steer, follow-up, interrupt,
approval and tool run goes through existing `affe-agent` semantics.

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

**W13 — UI affordances are data or capabilities, not callbacks in domain
records.** Commands, prompts, mentions, suggestions and model choices cross
typed seams before a framework adapter renders them.

**W14 — File roles stay distinct.** Attachment, knowledge document, workspace
file and artifact are never one generic record merely because each can refer to
bytes.

**W15 — Retrieval is storage-independent.** Agents consume
`KnowledgeRetriever`; vector databases, lexical indexes, chunkers and embedding
providers remain replaceable layers behind it.

**W16 — Capability-driven UI.** The frontend renders what
`CapabilityResolver` says is available rather than mirroring server
configuration with ad-hoc conditionals.

**W17 — Appearance is presentation-only.** Themes, density, font scale and
browser media state cannot change agent execution semantics.

**W18 — Generative UI carries typed data, not executable UI definitions.**
`AgentData` and Schema values cross the boundary; framework components stay in
renderer registries at the edge.

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
- `PromptCatalog` and `CommandRegistry`;
- `MentionProvider` and `SuggestionProvider`;
- `FeedbackStore`;
- appearance preferences and theme registry;
- model/agent pickers driven by catalogs/capabilities;
- good error/retry states;
- mobile/responsive layout;
- keyboard and accessibility pass.

Acceptance: ordinary chat use no longer feels like a framework demo, and the
same command/prompt/suggestion fixtures render in the plain React and
assistant-ui adapters.

### W3 — Workspace

Add:

- workspace record;
- sandbox binding;
- file tree;
- file reader;
- diffs;
- shell/tool output panel;
- explicit attachment/artifact/workspace-file conversions.

Acceptance: a coding agent can modify a workspace and the user can inspect every
change without leaving the conversation.

### W4 — Artifacts and typed generative UI

Add:

- artifact registry/projection;
- HTML/SVG/image/code/JSON/file previews;
- `AgentData`-driven application panels;
- `ViewRegistry`;
- safe iframe isolation.

Acceptance: a non-coding agent can produce rich useful outputs without
pretending they are workspace source files, and the producer side contains no
React/component identifiers.

### W5 — Agent builder and capability resolution

Add configuration for:

- instructions;
- provider/model;
- tools/tool sources;
- permissions;
- skills;
- memory;
- budget/loop presets;
- workspace policy;
- retrieval policy;
- project defaults/overrides;
- `CapabilityResolver`.

Acceptance: create two materially different agents entirely from the web UI,
run them through the same session infrastructure, and have the UI automatically
show only valid affordances for each.

### W6 — Connections

Add:

- MCP/tool-source configuration;
- credentials;
- plugin packages;
- web/search providers;
- connection health/test;
- per-agent/project capability selection.

Acceptance: a user can connect a tool source without editing application code,
and product records retain credential handles/bindings rather than values.

### W7 — Knowledge and projects

Add:

- `KnowledgeCatalog`;
- document loaders;
- chunking;
- embedding provider seam;
- index implementation;
- optional reranking;
- `KnowledgeRetriever`;
- ingestion status/progress;
- automatic ContextTransform RAG;
- agentic knowledge tools;
- `ProjectStore`;
- `EffectiveConfiguration`;
- source/citation UI.

Acceptance: the same collection can be used in automatic and agentic retrieval,
switching the index/embedding implementation requires layer changes rather than
agent/UI changes, and a project can apply knowledge/instructions/defaults to all
of its conversations.

### W8 — Multi-agent and advanced session UX

Add:

- child-session/delegation visualization;
- branch/rewind UI over `/tree`;
- compaction controls/status;
- queued follow-ups and steering UX;
- background/durable run reconnection;
- conversation search.

Acceptance: long-running and delegated work remains understandable after page
reload and reconnect.

### W9 — Voice, administration and distribution

Add:

- speech recognition adapter;
- speech synthesis adapter;
- optional realtime `VoiceSession` adapter;
- user administration where applicable;
- usage/telemetry views;
- import/export;
- deployment documentation;
- Docker/local installation path;
- hosted reference deployment.

Acceptance: another developer can self-host the application from documented
steps without knowing repository internals, and replacing speech/theme/UI
providers does not touch execution or persistence contracts.

---

## Implementation order

Do the smallest slice that falsifies the architecture first:

```text
W0 Effect-native integration
  -> W1 conversation persistence
  -> W2 complete chat + interaction affordances
  -> W3 workspace
  -> W4 artifacts + typed generative UI
  -> W5 agent builder + capability resolution
  -> W6 connections
  -> W7 knowledge + projects
  -> W8 advanced/multi-agent
  -> W9 voice + distribution/admin
```

Do not start with an admin panel, marketplace, elaborate knowledge-management
interface or a full Open WebUI settings clone. The RAG seams are specified now
so W7 can compose cleanly, but indexing/retrieval implementation does not block
W0-W2.

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
is already filled by `affe-agent`.

### Open WebUI

Borrow product lessons:

- provider/model settings;
- chat organization/search;
- knowledge/RAG and source UX;
- reusable prompt/slash-command UX;
- projects/folders with inherited context;
- tool/MCP configuration;
- model presets and capability-driven controls;
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
14. Implement `PromptCatalog`, `CommandRegistry`,
    `CapabilityResolver`, preferences and suggestions as independent seams.
15. Add `ArtifactCatalog` + `ViewRegistry` and workspace/file panes.
16. Implement knowledge ingestion/retrieval only after the chat/product shell
    proves the core boundaries; expose `KnowledgeRetriever` through both a
    ContextTransform and a toolkit in its acceptance test.
17. Add projects/`EffectiveConfiguration`, then voice/admin/distribution
    adapters.

## Success conditions

The plan is successful when:

- a third party can install the workbench and point it at supported model
  providers without modifying framework internals;
- the web app uses `affe-agent` as its only agent execution kernel;
- a conversation survives refresh/restart and resumes the same session;
- streaming, tools, progress, interruption and elicitation all render correctly;
- an optional workspace survives across turns and can be inspected from the UI;
- the same frontend works against local and remote/durable agent backends;
- the application itself becomes the strongest public example of how to build
  on `affe-agent`;
- replacing assistant-ui with plain React, Solid, or another presentation
  adapter requires changes only at the UI edge;
- workbench product protocols never redefine `AgentProtocol` operations or
  `AgentEvent` envelopes;
- slash commands, prompts, mentions, suggestions, themes and speech can be
  replaced or disabled without changing session semantics;
- attachments, knowledge documents, workspace files and artifacts have
  separate lifecycle models;
- automatic and agentic RAG share one `KnowledgeRetriever` contract and can
  swap indexing/embedding implementations by layer wiring;
- the UI is driven by `WorkbenchCapabilities` rather than hard-coded knowledge
  of backend configuration;
- typed generative UI is carried through `AgentData`/Schema and renderer
  registries, never model-generated executable component definitions.

The intended result is not merely "chat for affe-agent." It is a permissively
licensed, general-purpose **agent workbench** whose architecture demonstrates
that the framework's session/event/capability seams are sufficient for an
Open-WebUI/bb-class application without surrendering the execution model to
another framework.
