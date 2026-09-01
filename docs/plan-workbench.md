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

The recommended vertical slice is deliberately small:

```text
React
  |
assistant-ui
  |
AG-UI
  |
@doeixd/effect-agent/ag-ui
  |
AgentSessionHost
  |
@doeixd/effect-agent
  |
Effect / Effect AI
```

AG-UI is a projection of the kernel's event model, not the canonical internal
protocol.

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
|                     assistant-ui                                  |
+---------------------------|---------------------------------------+
                            |
                          AG-UI
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

## Repository shape

Keep the framework repository a framework repository. The preferred shape is a
separate application repository, for example `doeixd/effect-agent-workbench`.
That forces the workbench to consume the same public package a third party
would.

If development velocity initially requires a monorepo app, keep the boundary
identical and move it out once the first vertical slice is stable.

Recommended application structure:

```text
effect-agent-workbench/
  apps/
    web/
  packages/
    ui/
    server/
    db/
    auth/
    workspace/
    config/
```

The web package must never import `effect-agent` engine internals directly.

---

## Frontend choice

### Use assistant-ui as the chat behavior layer

Use `assistant-ui` for thread/composer/message behavior: streaming,
auto-scroll, message actions, retry/edit/regenerate, tool rendering,
attachments, reasoning, approvals, and accessible interaction primitives.

Do not make it the source of truth for persisted execution.

### Use AG-UI as the web-facing projection

The existing `@doeixd/effect-agent/ag-ui` adapter is the natural boundary.
The browser should consume it with the standard AG-UI client and
`assistant-ui`'s AG-UI runtime.

Conceptually:

```tsx
const agent = new HttpAgent({ url: "/api/agent" })
const runtime = useAgUiRuntime({ agent })

return (
  <AssistantRuntimeProvider runtime={runtime}>
    <App />
  </AssistantRuntimeProvider>
)
```

The exact integration should be pinned by a small contract test before UI work
grows around it.

### AI Elements is optional source material, not another runtime

Vercel AI Elements may be copied selectively for visual components such as
source cards, reasoning views, code blocks, attachments or artifact chrome.
Do not introduce Vercel AI SDK as an execution dependency merely to use those
components.

### Do not add CopilotKit initially

The application already has an AG-UI-speaking runtime. Adding CopilotKit would
create another orchestration layer unless a concrete product feature later
requires its specific app-state conventions.

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

---

## Milestones

### W0 — Integration spike

Goal: prove the vertical slice before product work.

Build a tiny React page using:

- `@assistant-ui/react`;
- `@assistant-ui/react-ag-ui`;
- `@ag-ui/client`;
- `@doeixd/effect-agent/ag-ui`.

Acceptance:

1. send a prompt;
2. stream assistant text;
3. stream/render reasoning if emitted;
4. render a tool call and progress;
5. stop/interruption works;
6. an elicitation can be answered;
7. no custom execution state machine exists in the frontend.

If this exposes an AG-UI conformance gap, fix the adapter first.

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

The first serious architectural test is whether the existing AG-UI/host/client
seams can support a polished persistent chat without private imports.

---

## What to borrow from existing projects

### assistant-ui

Borrow/use directly:

- thread and composer behavior;
- streaming UI;
- message actions;
- tool/reasoning rendering primitives;
- AG-UI runtime;
- accessibility behavior.

Do not adopt it as the canonical backend state model.

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

1. Create a separate workbench repository or a temporary isolated app package.
2. Pin assistant-ui, AG-UI client and `effect-agent` versions.
3. Implement the W0 page against the existing AG-UI adapter.
4. Add an integration test covering text, tool progress, interrupt and
   elicitation.
5. Record every adapter mismatch; fix those in `/ag-ui` with conformance tests.
6. Add the product database with `Conversation`, `AgentDefinition` and
   `ModelConfiguration` only.
7. Make browser reload/reconnect work before adding more UI.
8. Add attachments through `/blob` + `PromptWire`.
9. Add the workspace record and bind it to `Sandbox`.
10. Only after W1/W2 are solid, add file/artifact panes.

---

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
  on `@doeixd/effect-agent`.

The intended result is not merely "chat for effect-agent." It is a permissively
licensed, general-purpose **agent workbench** whose architecture demonstrates
that the framework's session/event/capability seams are sufficient for an
Open-WebUI/bb-class application without surrendering the execution model to
another framework.
