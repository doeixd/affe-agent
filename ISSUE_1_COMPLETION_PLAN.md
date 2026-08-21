# Issue 1 Completion Plan

This document is the implementation plan for finishing GitHub issue
[#1](https://github.com/doeixd/effect-agent/issues/1). `PLAN.md` remains the
design authority for the project. This plan narrows that design into a concrete
delivery sequence for the work that the issue's latest status comment still
identifies as missing.

Authoritative issue status:
[issue comment 5369477997](https://github.com/doeixd/effect-agent/issues/1#issuecomment-5369477997).

## Outcome

Finish the remaining v1 interoperability and execution-boundary work without
reopening capabilities that the issue already records as shipped.

The remaining deliverables are:

- complete MCP consumption, including real peers and scoped connection cleanup;
- A2A server and client interoperability against the official SDK;
- real Effect RPC and HTTP transports for the session API;
- an AG-UI projection over the HTTP/session transport;
- a sandbox package proving the intended Services + Scope + Toolkits model;
- reliable CI in a clean environment;
- public exports, documentation, examples, and conformance tests that make the
  completed surface usable without casts or hidden type annotations.

Items 1–6, 8, and 9 in the issue's implementation inventory are treated as
shipped unless the new transport work exposes a concrete defect in them.

## Scope boundaries

This work must not silently expand into the follow-up durability project.
Specifically, the following remain outside issue 1 unless `PLAN.md` and the
issue are explicitly revised:

- durable session persistence across process restarts;
- a durable delivery/event log with replay cursors;
- distributed leasing or multi-process session ownership;
- production coding tools as a first-party exported concept;
- full skills management or discovery;
- subagent convenience APIs beyond what the existing runtime already supports;
- push notifications or gRPC for A2A;
- a generic toolkit-to-MCP adapter when Effect's existing `McpServer.toolkit`
  already provides the required server-side bridge.

Those are candidates for issue 4 or later work. The adapters in this plan may
define extension seams for them, but must not invent incomplete defaults.

## Repository-wide invariants

Every phase must preserve these constraints.

### Public typing

- End-user code requires no type casts.
- Public callback parameters infer naturally; callers do not annotate values
  merely to rescue inference.
- Public Effect error channels name all expected failures and never collapse to
  `unknown`.
- Tool failure types remain represented in `PromptError<Tools>` through local
  and remote entry points.
- New inference assertions are deliberately broken once before restoration to
  prove that they actually detect widening to `any` or `unknown`.
- Any unavoidable assertion belongs at one documented erased/generic seam in
  `src/`, never in tests, examples, or callers.

### Effect semantics

- Resources are acquired and released with `Scope`.
- Cancellation uses fibers and interruption rather than cancellation-token
  abstractions.
- Cleanup that must survive caller interruption uses `Effect.ensuring` or an
  equivalent scoped finalizer.
- Shared state transitions use atomic Effect primitives.
- Services are wired with `Layer`; providers arrive through the environment.
- Events use `Stream`/`PubSub` rather than callbacks invented for one adapter.
- Operations use `Effect.fn("Module.operation")` as their definition and
  annotate the current span inside the function.
- Domain absence uses `Option`; only wire schemas may project absence to
  `null` when a protocol requires it.
- Domain errors are `Schema.TaggedError` values with computed `message`
  getters, not encoded message fields.
- IDs are schema-branded and namespaced.

### Tests and verification

- Tests synchronize with `Deferred`, latches, streams, or protocol events, not
  sleeps.
- Event tests assert exact ordered sequences.
- Cancellation tests wait for the operation that must truly have started.
- Transport tests exercise real network boundaries in addition to in-memory
  protocol tests.
- Trace tests verify the span hierarchy at the new boundaries.
- Every delivery slice passes:

  ```sh
  npm run typecheck
  npm run lint
  npm test
  ```

## Phase 0: Repair clean-environment CI

### Problem

Recent GitHub Actions runs fail with `TS2688` because `@types/node` is not a
direct development dependency. A developer machine can mask this through a
parent-level `node_modules`, so local success is not proof that the package is
self-contained.

### Work

1. Add the compatible `@types/node` release to `devDependencies`.
2. Refresh the lockfile through the repository's package manager.
3. Verify from a clean dependency installation, not the existing parent/module
   resolution state.
4. Inspect `tsconfig.json` and package scripts for any other dependencies that
   are currently satisfied accidentally from outside the repository.
5. Keep the current Effect language-service plugin configuration intact.

### Acceptance tests

- A clean checkout installs and typechecks without a parent `node_modules`.
- `npm run typecheck`, `npm run lint`, and `npm test` pass on the supported Node
  versions.
- CI runs at least Node 20 and Node 22, or documents a narrower supported range
  if the package metadata intentionally chooses one.
- Packing the package succeeds and the tarball contains the intended public
  entry points only.

## Phase 1: Define the canonical remote session contract

Build one wire-level contract first so RPC, HTTP, AG-UI, and A2A do not each
invent different session semantics.

### New shared protocol module

Add `src/client/AgentProtocol.ts` (or an equivalently scoped module) containing
schema-backed request, response, and error types for:

- `SessionId` and `RequestId`;
- create session;
- close session;
- prompt;
- steer;
- follow-up;
- interrupt;
- respond to elicitation;
- inspect pending elicitations;
- inspect history;
- inspect status;
- subscribe to events;
- remote prompt options;
- remote results;
- a tagged remote-error union;
- an `AgentEventEnvelope` with session identity and monotonically increasing
  per-session sequence metadata.

Raw prompt input must be normalized through the existing `Prompt.make` path so
local and remote callers share the same semantics.

### Shared session host

Introduce an internal server-side session host used by every transport:

- create each `AgentSession` in a child scope owned by the host;
- atomically publish a newly created session only after acquisition succeeds;
- close a session explicitly and release its child scope exactly once;
- close all child scopes during server shutdown;
- provide create/get/close operations with typed errors;
- define capacity and retention behavior explicitly;
- if eviction is supported, eviction must close the scope before removal;
- do not imply restart durability.

The host is an internal transport facility until two independent public use
cases justify exporting it.

### Idempotency and retries

All mutating remote operations carry a request ID. The host maintains bounded,
per-session in-flight/completed request records:

- the first request executes normally;
- an identical concurrent request joins the same result;
- a completed duplicate returns the recorded result;
- reusing a request ID with a different payload fails with a typed conflict;
- retention bounds and expiry policy are explicit and tested;
- cancellation of one waiting transport connection does not accidentally
  cancel the shared mutation when another duplicate is waiting.

### Authorization seam

Define a transport-neutral authorization service or hook whose input contains
the authenticated principal/context, operation, session identity, and relevant
request metadata. Authorization failures are typed and mapped by each adapter.
An allow-all implementation may exist for examples and tests, but it must be
installed explicitly rather than becoming an invisible production default.

### Acceptance tests

- Concurrent creation, lookup, close, and shutdown cannot leak scopes.
- A duplicate prompt creates one submission and returns one logical result.
- A request-ID/payload mismatch is rejected.
- Closing a session interrupts active work and releases all session resources.
- Authorization is evaluated on every protected operation.
- Public client helpers infer exact success, error, and requirement types.

## Phase 2: Effect RPC transport

Add a first-class `/rpc` entry point using Effect's RPC packages and the shared
session contract.

### Public surface

Provide a focused API such as:

- `AgentRpc.Protocol`;
- `AgentRpc.serverLayer`;
- `AgentRpc.clientLayer`;
- typed client operations for create, close, prompt, steer, follow-up,
  interrupt, respond, pending, history, status, and events.

Exact names should follow current Effect RPC conventions and avoid exporting a
new abstraction merely to hide the upstream API.

### Semantics

- RPC request and response schemas reuse the canonical protocol types.
- The event operation is a stream and preserves host sequence order.
- A client that creates and owns a session can acquire it as a scoped resource;
  its finalizer closes the remote session.
- Attaching to an existing session does not implicitly own or close it.
- Transport interruption and domain interruption remain distinguishable.
- Domain errors stay typed across encoding and decoding.
- Trace context propagates through RPC calls and stream subscriptions.

### Tests

1. In-memory `RpcTest` conformance tests for every method and error variant.
2. A real HTTP transport test covering encode/decode and shutdown.
3. A real WebSocket test covering bidirectional/event-stream behavior if the
   chosen Effect RPC transport exposes WebSockets.
4. Disconnect tests proving server-side cleanup and correct mutation behavior.
5. Exact event sequence and span-tree assertions.

## Phase 3: HTTP and SSE transport

Add a plain HTTP interface over the same host and schemas.

### Endpoint contract

The initial route set is:

```text
POST   /sessions
DELETE /sessions/:id
GET    /sessions/:id
POST   /sessions/:id/prompt
POST   /sessions/:id/steer
POST   /sessions/:id/follow-up
POST   /sessions/:id/interrupt
POST   /sessions/:id/respond
GET    /sessions/:id/pending
GET    /sessions/:id/history
GET    /sessions/:id/status
GET    /sessions/:id/events
```

`GET /events` uses server-sent events for live observation. It does not promise
durable replay or a resumable cursor. If a client reconnects, the contract must
state whether it receives only new events or a bounded in-memory snapshot
followed by new events.

### Error and status mapping

Document and test stable mappings for:

- invalid input/schema failures;
- unauthorized and forbidden requests;
- unknown or closed sessions;
- request-ID conflicts;
- invalid state transitions;
- prompt/tool/model failures;
- server capacity exhaustion;
- interruption;
- unexpected defects.

Tagged domain errors should have stable machine-readable response bodies.
Unexpected defects must not expose internal stack traces by default.

### Tests

- Effect-generated client tests cover every route.
- Plain `fetch` tests prove the API is usable without an Effect client.
- A real SSE parser test verifies event names, IDs, ordering, and disconnect
  cleanup.
- Concurrent prompt, steer, interrupt, and respond cases verify session state
  transitions through the network boundary.
- Shutdown closes open SSE connections and session scopes deterministically.

## Phase 4: AG-UI adapter

Implement AG-UI as a projection over the session host and HTTP transport, not
as a second agent runtime.

Reference implementation/specification:
[AG-UI repository](https://github.com/ag-ui-protocol/ag-ui).

### Outbound event mapper

Build a stateful mapper from harness events to official AG-UI events. Cover at
least:

- submission/run start and completion;
- turn start and completion;
- assistant message start, content deltas, and end;
- tool-call start, argument deltas, result, and end;
- elicitation/input-required transitions;
- errors and interruption;
- state snapshots or deltas only where the protocol meaning is unambiguous.

IDs must be stable and derived from existing run, submission, message, and tool
correlation identifiers. Do not generate unrelated IDs at projection time.

Batch and streaming model responses need different handling:

- a streamed response maps its native deltas without duplication;
- a batch `MessageCompleted` event synthesizes the minimum start/content/end
  sequence expected by AG-UI clients;
- a response must never be emitted both as streamed deltas and as a duplicate
  synthesized batch message.

### Inbound mapping

- Accept official `RunAgentInput` payloads.
- Resolve session or user identity through trusted server context, not an
  untrusted arbitrary client field.
- Convert supported messages/input into `Prompt.make` values.
- Start prompts in streaming mode when AG-UI semantics require live events.
- Map human-in-the-loop replies to the existing elicitation `respond`
  operation.
- Reject unsupported client capabilities explicitly with a typed protocol
  error.

### Tests

- Golden exact-sequence tests for batch text, streamed text, tool calls,
  failures, interruption, and elicitation.
- An official AG-UI client consumes a real server stream.
- A plain protocol client verifies wire compatibility independently of internal
  types.
- Disconnecting an observer does not cancel a run unless the explicit protocol
  operation requests cancellation.

## Phase 5: Complete MCP consumption

The existing `/mcp` package proves toolkit exposure. Complete the opposite
direction: connect to real MCP servers and expose their tools as a scoped
`Toolkit`.

Primary references:

- [MCP TypeScript SDK v1.x branch](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)
- [MCP TypeScript client README](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/README.md)
- [MCP v1-to-v2 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)
- [MCP client connection guide](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect)
- [MCP protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions)

### Compatibility target

Support both official TypeScript SDK generations without conflating SDK
compatibility with wire-protocol compatibility:

- **SDK v1.x** is the monolithic `@modelcontextprotocol/sdk` package.
- **SDK v2.x** is the split `@modelcontextprotocol/client`,
  `@modelcontextprotocol/server`, and `@modelcontextprotocol/core` package set.
- **Legacy wire era** covers protocol revisions `2024-10-07` through
  `2025-11-25` and uses the `initialize` handshake.
- **Modern wire era** starts at `2026-07-28` and uses `server/discover` plus the
  request `_meta` envelope.

SDK v1 and SDK v2 classes are not type-compatible even when they speak the same
wire revision. Their nominal classes and `instanceof` identities must never
cross adapters. Compatibility is established at the MCP wire boundary and then
normalized into Effect Harness-owned types.

The required connection matrix is:

| Harness adapter | Official peer | Expected wire era |
| --- | --- | --- |
| SDK v1 adapter | SDK v1 server | legacy |
| SDK v1 adapter | SDK v2 server with legacy enabled | legacy |
| SDK v2 adapter | SDK v1 server | legacy through automatic fallback |
| SDK v2 adapter | SDK v2 server | modern when auto-negotiation is enabled |

This matrix is bidirectional for server conformance as well: official v1 and v2
clients must both be able to call the Harness MCP server. Server metadata and
documentation must advertise protocol revisions rather than an SDK package
major, because peers observe the wire protocol, not the implementation package.

The pinned Effect `4.0.0-rc.111` server provides legacy adapters through
`2025-11-25`, but no `2026-07-28` server adapter. Server-side v2 conformance
therefore means automatic fallback to the exact latest legacy revision; modern
server support cannot be claimed or tested until Effect exposes that revision.

### Public surface

Keep the existing `McpToolkit.Connection` and tool binding types independent of
both SDK generations. Add version-specific, scoped integration entry points:

- `/mcp/v1`, backed only by `@modelcontextprotocol/sdk` v1 types;
- `/mcp/v2`, backed only by the split v2 package types;
- `/mcp`, containing the SDK-neutral connection/toolkit contract and the
  recommended v2-backed auto-negotiating constructors.

The constructors are equivalent to:

- `McpClient.streamableHttp(options)`;
- `McpClient.stdio(options)`;
- `McpClientV1.streamableHttp(options)`;
- `McpClientV1.stdio(options)`;
- `McpClientV1.fromSdkClient(client: V1Client)`;
- `McpClientV2.streamableHttp(options)`;
- `McpClientV2.stdio(options)`;
- `McpClientV2.fromSdkClient(client: V2Client)`.

Each constructor returns the existing `McpToolkit.Connection` shape or a
compatible refinement whose toolkit and close lifecycle are scope-bound. The
exact SDK client type is inferred by its versioned entry point; callers never
cast a v1 client to a v2 client, cast to a structural substitute, or annotate a
callback merely to recover inference.

The v2-backed constructors are the default because one v2 client can negotiate
both modern and legacy wire eras. The v1 entry point remains an explicit
compatibility surface for applications and plugins whose public types still use
`@modelcontextprotocol/sdk`.

### Implementation details

- Implement the v1 adapter only with official `@modelcontextprotocol/sdk` v1
  imports and the v2 adapter only with official split-package imports.
- Define one internal Harness-owned structural port containing only the MCP
  operations the toolkit needs: list tools, call tool, observe supported list
  changes, inspect negotiated capabilities/version, and close. Each SDK adapter
  implements that port inside its own module.
- Never accept `V1Client | V2Client` in one public function and never use a
  double assertion to bridge them. Do not leak either SDK's nominal classes,
  Zod schemas, or error classes through the SDK-neutral `/mcp` declarations.
- Keep any unavoidable type erasure at one documented internal conversion from
  dynamically discovered wire tools to the existing generic toolkit API. It
  must not weaken the input/output schema checks or create a caller-visible
  cast.
- Rely on v2 automatic protocol negotiation for the default client. It must use
  `mode: "auto"` when modern support is requested, negotiate `2026-07-28` with a
  v2 server, and fall back to the legacy `initialize` family against v1/2025
  servers.
- Let the explicit v1 adapter speak only revisions its installed v1 SDK
  supports; it must not claim the modern era.
- Audit the v1 release history before choosing the supported semver range.
  Declare and document the lowest supported v1 minor based on the APIs actually
  used, then test both that floor and the latest v1 release. Do not publish a
  broad `>=1` peer range if older releases lack a required transport or type.
- Keep v2 as the normal runtime dependency. Make v1 an opt-in compatibility
  dependency/subpath (and a development dependency for conformance tests) so a
  v2-only consumer does not need to import v1 types. Package metadata must give
  a clear installation error when `/mcp/v1` is used without its supported v1
  package; no dynamic `any` fallback is allowed.
- Account for the SDKs' different schema dependencies: v1 may resolve Zod 3 or
  4, while v2 uses its split core schema package and Zod 4. Normalize decoded
  wire values into Harness schemas rather than exposing either Zod instance.
- Wrap SDK promises with Effect interruption and `AbortSignal` support.
- Register transport/client shutdown as scope finalizers.
- Pass through supported OAuth configuration rather than inventing auth.
- Follow pagination for `tools/list`.
- Convert remote input schemas into precise harness tool schemas.
- Preserve each remote tool's failure channel with tagged connection,
  discovery, invocation, protocol, and decode errors.
- Prefer `structuredContent` when it matches the declared output schema.
- Fall back to compatible text/content decoding when structured content is not
  supplied.
- Do not silently discard images, resources, embedded resources, or other rich
  content. Either model them in a stable output type or return a typed
  unsupported-content error.
- Handle tool-list changes if the negotiated protocol/server advertises the
  capability; otherwise document discovery as a connection-time snapshot.

### Type-safety proof

Add compile-only consumer fixtures for v1 and v2, each with no casts and no
hand-annotated callback parameters. They must prove:

- the correct official SDK client type is accepted by its matching adapter;
- the v1 client is rejected by the v2 adapter and vice versa using
  `@ts-expect-error` assertions;
- tool input is inferred from the caller's Effect schema;
- tool success and declared remote/decode failures remain precise and are not
  `any` or `unknown`;
- the common `McpToolkit.Connection` can be consumed without importing SDK
  classes;
- importing only `/mcp` or `/mcp/v2` does not require v1 declarations;
- a packed-package fixture can install and typecheck each supported dependency
  combination independently.

Break each positive inference assertion once and restore it. Keep the negative
cross-major assertions in the suite so a future broad union or structural
widening cannot accidentally erase the boundary.

### Interoperability tests

Test both directions with real transports:

1. Official SDK v1 client -> Effect Harness MCP server over the legacy era.
2. Official SDK v2 client -> Effect Harness MCP server through automatic
   fallback to the latest Effect-supported legacy revision. Add the modern era
   when Effect provides a `2026-07-28` server adapter.
3. Effect Harness v1 adapter -> official SDK v1 server.
4. Effect Harness v1 adapter -> official SDK v2 server with legacy enabled.
5. Effect Harness v2 adapter -> official SDK v1 server through fallback.
6. Effect Harness v2 adapter -> official SDK v2 server through the modern era.
7. Streamable HTTP and stdio across the applicable matrix rows; legacy SSE is
   included only if the declared v1 support range promises it.
8. The lowest declared and latest available supported v1 minor, plus the pinned
   v2 version used by the package.
9. Tool discovery pagination and list-change behavior in each era.
10. Structured output, text fallback, remote failure, cancellation, malformed
    payload, rich content, and disconnect cleanup.
11. Exact negotiated revision/era assertions so a successful call cannot mask
    unintended fallback.

Current upstream limitation: Effect `4.0.0-rc.111` converts the numeric request
id in a legacy `notifications/cancelled` message to a string before looking up
the RPC request fiber. Its HTTP transport additionally gives the cancellation
POST a different request-scoped client id. Official SDK v1 and v2 cancellation
therefore cannot currently interrupt the Harness MCP server over either
transport. Client-side modern cancellation and deterministic server-scope
shutdown remain covered. Do not replace this gap with timing-based tests or a
non-official transport; retest it when the Effect MCP server is upgraded.

## Phase 6: A2A adapter

Add `/a2a` using the official `@a2a-js/sdk` v1 package and the published v1
protocol.

References:

- [A2A JavaScript SDK](https://github.com/a2aproject/a2a-js)
- [A2A v1 specification](https://a2a-protocol.org/v1.0.0/specification/)

### Supported initial capabilities

- Agent Card discovery;
- JSON-RPC transport;
- REST transport where the official SDK supports it cleanly;
- send message;
- stream message;
- get task;
- cancel task;
- continued input for input-required tasks;
- task status/history projection;
- artifact/result projection.

Push notifications and gRPC remain disabled and unadvertised until implemented
and tested.

### Implementation progress (2026-08-21)

The first native-v1 server slice is complete:

- `@doeixd/effect-agent/a2a` serves the v1 well-known Agent Card and a JSON-RPC
  endpoint through the official `@a2a-js/sdk` 1.0.1 server machinery;
- the card advertises JSON-RPC with streaming enabled and push notifications
  disabled;
- blocking `SendMessage` accepts text parts, creates a Harness prompt, stores
  the official Task, and returns a completed text artifact; `GetTask` reads the
  same owner-scoped stored result;
- `CancelTask` interrupts the active Harness run, persists `CANCELED` as the
  sole terminal task state, and leaves the context's session usable;
- `SendStreamingMessage` emits the exact submitted, working, artifact and
  completed sequence as official JSON-RPC SSE envelopes; cancellation replaces
  the last two entries with one canceled terminal status;
- closing an SSE observer does not cancel its task: a layer-owned fiber keeps
  draining the official SDK generator so task-store updates survive, while
  server shutdown interrupts the remaining work;
- the application resolves authenticated principal + untrusted A2A context id
  to a branded Harness session id, while the principal's stable subject scopes
  the official task store;
- task execution fibers and named Harness sessions belong to the server layer's
  scope;
- an official v1 client discovers the card over a real Node HTTP server and
  proves two-turn context continuity plus deterministic session release;
- the public layer channels and resolver inference are pinned by cast-free
  compile-time assertions, deliberately broken once and restored.

Still pending in this phase: input-required continuation, the remaining
terminal error matrix, REST, the Harness A2A client and typed request/result
helper, and the reverse official-server peer test. The current card does not
advertise the unimplemented capabilities.

### Server mapping

- A2A context ID maps to a session identity through a dedicated resolver.
- A2A task ID maps to a harness submission/run identity.
- The task store is separate from the live event `PubSub`; subscribers are not
  a durable state database.
- `message/send` creates or continues a harness prompt as required by the task
  state.
- `message/stream` projects ordered harness events into A2A task/status/artifact
  updates.
- `tasks/get` reads the task store.
- `tasks/cancel` interrupts only the active run associated with that task and
  rejects cancellation of unrelated or terminal work.
- Harness elicitation maps to A2A `input-required`, and a subsequent message
  supplies the pending response.
- Agent Card capabilities exactly match the installed transport and operations.

### Client surface

Provide:

- a typed native A2A client for protocol messages and tasks;
- `A2A.typed({ request, result, encodeRequest, decodeResult })`, or an equivalent
  schema-driven helper, for typed agent-to-agent request/result exchange;
- scoped client transport cleanup;
- typed protocol, remote-agent, schema, and cancellation errors.

### Interoperability tests

1. Official A2A SDK client -> Effect Harness A2A server.
2. Effect Harness A2A client -> official SDK server/executor.
3. JSON-RPC request/response and streaming.
4. REST request/response and streaming if included in the advertised card.
5. Task lookup, cancellation, continuation after input-required, terminal
   errors, artifacts, and disconnect cleanup.
6. If v0.3 compatibility is required, put it behind an explicit compatibility
   mode and test it separately; do not weaken the v1 types.

## Phase 7: Sandbox package

Add `/sandbox` as a proof that capabilities compose through Effect services,
scopes, and user-defined toolkits. It must not turn the core `Agent` into a
coding-agent framework.

### Public domain model

Define the minimum reusable concepts:

- `Workspace` value identifying the sandbox root;
- `SandboxProvider` service that acquires a sandbox;
- scoped `Sandbox` handle;
- schema-validated relative `SandboxPath`;
- `Command` with executable and arguments represented separately;
- bounded `CommandResult` including exit status, stdout, and stderr;
- file read, write, directory listing, metadata, and process execution
  operations needed by the example.

Define precise `Schema.TaggedError` variants for invalid paths, missing files,
permission failures, command launch failures, non-zero exits where relevant,
timeouts, output limits, and provider failures.

### Providers

Implement:

- a deterministic in-memory provider for unit tests;
- a Node local-directory provider using a scoped temporary workspace.

The local provider is explicitly not a security boundary. Its documentation
must state this prominently. It still needs safe path resolution, well-defined
symlink behavior, separate executable/argument handling, bounded output,
timeouts, and scope cleanup.

Do not silently fall back from a requested isolated provider to the local
provider.

### Demonstration

Add `examples/sandbox.ts` containing user-defined tools that require the
`Sandbox` service and are assembled into a normal `Toolkit`. The example must
prove:

- the agent core is unchanged;
- requirements flow through the toolkit and layer types;
- no caller casts or rescued parameter annotations are needed;
- acquisition and cleanup follow session scope;
- swapping the in-memory and local provider is layer wiring, not tool rewriting.

Do not export first-party `read_file`, `write_file`, or `run_command` tools from
the core library solely for this example.

### Tests

- Path traversal and absolute paths are rejected.
- Symlink behavior matches the documented policy.
- Reads/writes/listing are deterministic in memory.
- Commands receive exact executable and argument values.
- Timeout and output limits interrupt and clean up child processes.
- Closing the sandbox scope releases temporary resources.
- The example carries compile-time no-`any` and exact-requirement assertions.

## Phase 8: Public integration and documentation

### Package exports

Add and verify package entry points for:

- `/rpc`;
- `/http`;
- `/ag-ui`;
- `/a2a`;
- `/sandbox`;
- the extended SDK-neutral `/mcp` API;
- `/mcp/v1` for the official monolithic SDK v1 compatibility adapter;
- `/mcp/v2` for the official split-package SDK v2 adapter.

Update the public API import test so every documented symbol imports from the
published package path rather than an internal source path.

### Documentation

- Update `README.md` with one minimal, cast-free example for every adapter.
- Update `STATUS.md` with what was built, key design decisions, and explicitly
  deferred work.
- Reconcile stale comments or docs that still describe MCP consumption as
  missing.
- Document session ownership, shutdown, authorization, idempotency, and
  non-durable event semantics once in a shared client/transport section.
- State exact official peer versions used in conformance tests.
- Document the supported SDK v1 semver floor, the tested v1 range, the pinned
  v2 range, and the distinction between SDK major and negotiated protocol era.
- Include cast-free setup examples for a v1 SDK client, a v2 SDK client in
  legacy mode, and a v2 SDK client in modern/auto mode.
- Include troubleshooting for protocol negotiation and clean-environment CI.

### Package verification

- Build and pack the package.
- Install the tarball into a fresh fixture project.
- Import every public subpath from that fixture.
- Typecheck a consumer example with no casts and no annotations added merely to
  satisfy this library.
- Confirm internal-only modules are not accidentally exported.

## Delivery sequence

Use small, independently reviewable changes. The recommended sequence is:

1. **CI and protocol schemas (complete)** — repair clean installs; add canonical wire
   schemas and compile-time type assertions.
2. **Session host and idempotency (complete)** — add scoped ownership, authorization seam,
   request deduplication, and deterministic concurrency tests.
3. **RPC (complete)** — implement the complete RPC surface and real transport tests.
4. **HTTP/SSE (complete)** — expose the same contract to plain clients and verify stream
   lifecycle behavior.
5. **AG-UI (complete)** — add the stateful event projection and official-client test.
6. **MCP consumption (complete within the pinned Effect server surface)** — the SDK-neutral port, isolated v1/v2
   entry points, scoped `fromSdkClient`, Streamable HTTP and stdio constructors,
   v2 auto-negotiation default, v1.10 declaration-floor check, same-major
   in-memory tests, and the complete real Streamable HTTP and stdio negotiation
   matrices are complete. HTTP coverage includes pagination, modern list
   changes, cancellation, and scoped subscription cleanup. Stdio coverage uses
   deterministic child-process fixtures to prove each negotiated era, modern
   cancellation, and scoped process cleanup. Hostile official-client
   transports prove typed malformed-response and disconnect handling;
   unsupported rich content fails explicitly rather than being discarded.
   Official SDK v1.30 and v2.0 clients now call the real Harness server over
   HTTP and stdio, proving continuity, isolation, failures, malformed input,
   exact legacy fallback, and scope cleanup. Modern server negotiation and
   official-client cancellation remain blocked by the documented Effect server
   limitations above.
7. **A2A** — add the official v1 adapter, task store, client, and peer tests.
8. **Sandbox** — add services/providers and the user-defined toolkit example.
9. **Closure** — finish exports, package fixture tests, README, `STATUS.md`, and
   issue checklist reconciliation.

Each slice should leave the full repository green. Avoid one large branch that
allows type drift or protocol incompatibilities to accumulate across adapters.

## Definition of done

Issue 1 is ready to close only when all of the following are true:

- [ ] A clean checkout installs and passes typecheck, Effect diagnostics, and
      tests without dependencies inherited from outside the repository.
- [x] The canonical remote session contract covers every existing session
      operation with precise schemas and typed errors.
- [x] Server-side sessions have explicit scoped ownership and deterministic
      shutdown.
- [x] Mutating remote requests are safely idempotent under retry.
- [ ] Authorization is explicit and exercised by all public transports.
- [x] Effect RPC works over a real transport and preserves event order, errors,
      cancellation, and tracing.
- [x] Plain HTTP covers the full session API and SSE cleanup is deterministic.
- [ ] An official AG-UI client completes batch, streaming, tool, error,
      interruption, and human-in-the-loop scenarios.
- [x] MCP exposes separate cast-free SDK v1 and v2 integration entry points over
      one SDK-neutral `McpToolkit.Connection` contract.
- [x] SDK v1 and v2 client objects cannot cross adapters at compile time, and
      neither SDK's nominal or schema types leak through `/mcp`.
- [x] MCP passes the v1/v1, v1/v2, v2/v1, and v2/v2 peer matrix over applicable
      Streamable HTTP and stdio transports, with the negotiated legacy/modern
      era asserted explicitly.
- [ ] The lowest declared and latest supported SDK v1 releases both pass type,
      package, and runtime conformance tests; the supported range is documented.
- [x] MCP protocol fallback, discovery pagination/list changes, rich results,
      cancellation, malformed responses, and scoped cleanup are tested.
- [ ] A2A works against official peers in both directions for the capabilities
      advertised in the Agent Card.
- [ ] The sandbox example proves Services + Scope + Toolkits composition without
      coupling coding tools into the agent core.
- [x] Every new public example and test uses no casts and preserves inferred
      success, error, and requirement types.
- [x] New operations use idiomatic `Effect.fn` definitions and the Effect
      language service reports zero diagnostics.
- [x] Event and trace tests assert exact ordering and structure without sleeps.
- [x] All public subpath exports work from a packed-package consumer fixture.
- [ ] `README.md` and `STATUS.md` describe the final implementation and its
      remaining deliberate limitations.
- [ ] `npm run typecheck`, `npm run lint`, and `npm test` pass on the supported
      Node versions.

## Planning checkpoint before implementation

Before starting each adapter, compare its proposed public names and semantics
against current upstream package APIs. MCP, A2A, AG-UI, and Effect RPC are
versioned external contracts and may have moved since this plan was written.
Version changes may alter the implementation details, but they must not weaken
the invariants, scope boundaries, or acceptance criteria above. Any conflict
with `PLAN.md` must be documented explicitly before code proceeds.
