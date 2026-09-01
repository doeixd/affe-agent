# Module map

Written 2026-08-27 from a pass over `src/`. Every public module, what it is,
why it exists, and what it composes with. ~39k lines across 34 directories and
12 root modules.

`PLAN.md` is the design authority and `STATUS.md` records what was built and
why; this document is the index between them — the answer to "which module do I
need for X, and what does it sit on top of".

## How to read this

Almost every module in this repository is one of five things, and knowing which
tells you most of what you need:

```text
  kernel        sessions → submissions → runs → turns, and the events they emit
      │         the only thing that executes anything
      ▼
  seams         the substitution points: Loop, ContextTransform, InputChannel,
      │         Permission, Elicitation, Toolkit, LanguageModel, SandboxProvider
      ▼
  batteries     capabilities built *only* out of seams — skills, memory, state,
      │         budget, compaction, subagents, coding toolkits
      ▼
  adapters      the same session, spoken over a protocol — RPC, HTTP, MCP, A2A,
      │         AG-UI, OpenAI-compatible
      ▼
  hosts         concrete platforms, behind their own entry points
```

The governing rule, from `ROADMAP.md`: **a package adds a capability, policy,
interpreter, or adapter — never a parallel execution model.** When a module's
header says "it adds no capability to the engine", that is this rule being
stated on purpose.

Import paths below are the published ones from `package.json`. A module with no
subpath is exported from the root entry.

---

## 1. Kernel

The root entry, `@doeixd/effect-agent`. This is the part that executes.

| module | what | why |
| --- | --- | --- |
| **`Agent`** | A reusable *description* of behaviour — toolkit, loop, transforms. | An agent is a value, not a running instance, and **carries no model**: the model arrives through the environment, so one agent runs against any provider, a test double, or a routing layer. `Agent.make` deliberately does not grow type parameters; new cross-cutting concerns are combinators (`withPermission`, `withContextTransform`). |
| **`AgentSession`** | One line of conversation, with canonical history. The handle everything else takes. | The local, fully-typed handle: it knows the agent's tool types and fails with what its tools fail with. Related: `AgentClient` is the same five operations *minus* everything that cannot cross a wire. |
| **`AgentSubmission`** | The externally observed unit of work started by `prompt`. | What a caller waits on and what "quiescent" is defined against. Owns follow-up orchestration; the loop deliberately cannot see it. |
| **`AgentRun`** | One contiguous agent-loop episode inside a submission. | Turns until the loop says stop. Steering accepted after a run's stopping decision needs a *later* run — which is why runs are a level at all. |
| **`AgentTurn`** | One atomic model call plus its tool calls. | The only place steering is drained into canonical history: a steer changes future reasoning, never the semantics of an already-started turn. **Not exported from the root entry** — see §9. |
| **`AgentLoop`** | The continuation policy: does another turn happen? | Policy, never engine. It decides; it does not perform. Follow-up state is withheld from it by design. `/budget` is a loop; so is any stopping rule. |
| **`AgentEvent`** | The Schema-typed observation contract, as an ordered envelope stream. | The single source for everything observational: `/hooks`, `/observability`, `/data`, `/export`, `/evals`, the TUI and every streaming adapter read this and nothing else. Carries a *lossy projection* of failure, not a `Cause` — the full `Cause` stays in `prompt`'s typed error channel. |
| **`ContextTransform`** | Derive what the model sees from canonical history. | Canonical history is never rewritten; the projection is. `/compaction`, `/skills`, `/memory` and `/state` are all transforms. |
| **`InputChannel`** | Where steering and follow-ups are held. | The one seam a Layer boundary could not express. A durable interpreter must record the drained batch alongside the turn that consumed it, or replay derives a different prompt than the journal recorded. |
| **`Permission`** | May the agent attempt this call? `Allow` / `Ask` / `Deny`. | Not the sandbox (that is the physical boundary) and not elicitation (that is how a question gets answered). Combines conservatively, `Deny > Ask > Allow`, and a tool's own `needsApproval` is a floor an application cannot waive. |
| **`PromptWire`** | JSON-safe codecs whose decoded values are Effect AI `Prompt.Prompt` and `Prompt.Message`. | One stable file-data representation for HTTP, RPC, journals, exports and custom stores. Tags string, bytes/base64 and URL so persistence cannot silently change the runtime union arm. |
| **`Elicitation`** | Execution paused until something outside answers. | The generic HITL primitive — tool approval is one instance, not the concept. Deliberately not called "interrupt", which already means fibre teardown. Local implementation is a `Deferred`; under `/durable` it is a `DurableDeferred`, so a pause survives the process. Exported from the root and `/elicitation`. |
| **`ToolExecution`** | Errors the harness raises *before* a handler runs. | Referenced as an alias by every error union that must stay complete, so adding one flows into `AgentSession.PromptError` automatically. |
| **`Errors`** | The harness error set, as `Schema` classes. | Yieldable Effect errors that also carry a codec, so RPC and HTTP transport them without a parallel set of wire types. `message` is a derived getter, never a field. |

## 2. Execution substrate

| module | path | what | relates to |
| --- | --- | --- | --- |
| **`Sandbox`** | `/sandbox` | The portable execution capability: typed file ops, argv `exec` and `execStream` (output as it arrives; `lines` decodes across chunk boundaries, `collect` folds back to a `CommandResult`), branded `SandboxPath`, `Scope`-bound acquisition, `canonical` for lock identity, output bounds. | The seam `/coding`, `/pi` and `/shell` all sit on. `MemorySandbox` ships here; the Node provider is `/sandbox/local`. |
| **`ClaudeCodeA2A`** | `/a2a` | Anthropic's Claude Code CLI as a `RemoteAgent`, spawned through `Sandbox.execStream` inside a workspace; A2A context ↔ CLI session, `stream-json` ↔ task status/artifact updates. | An *adapter*, not a runtime: `AgentA2A.tool` already makes any `RemoteAgent` a tool, so a bridged CLI is additive. Does not bridge permissions yet — the sandbox is the boundary. |
| **`ClaudeCodePermissions`** | `/a2a` | The bridged CLI's `--permission-prompt-tool` prompts answered by this app's `Permission.Policy` + `Elicitation`, over a one-tool MCP server. | Projects the CLI's tools into `/coding`'s own `read`/`write`/`shell` vocabulary, so one rule set governs both runtimes. Fails closed; the endpoint is an authority, so loopback only. |
| **`OpenCodeA2A`** | `/a2a` | An `opencode serve` as a `RemoteAgent`: sessions, the event bus and its native permission requests over HTTP, no subprocess. | Same `Bridge` surface as `ClaudeCodeA2A`, same `read`/`write`/`shell` projection. Its `always` reply is the half a prompt tool cannot express. |
| **`MemorySandbox`** | `/sandbox` | In-memory provider. | The default for tests and for agents that need no real filesystem. |
| **local provider** | `/sandbox/local` | Node-backed provider. | **The one host module in `src/`** — its own entry so importing `/sandbox` never pulls `node:*`. Enforced by `scripts/verify-portability.mjs`. |
| **`Shell`** | `/shell` | Turns a one-line script into a `Sandbox.Command`. Bash, sh, zsh, fish, PowerShell, pwsh, Nushell, or a custom four-liner. | Isolation stays on `Sandbox`; this only constructs argv, so a toolkit never names a binary. |

## 3. Toolkits

| module | path | what | relates to |
| --- | --- | --- | --- |
| **`CodingToolkit`** | `/coding` | Read, write, edit, list, search, shell — OpenCode's contracts. | Over `Sandbox` + `Shell`, each tool carrying a `Permission` projection. |
| **`PiToolkit`** | `/pi` | The same jobs with Pi's contracts: batch `edits[]`, rendered `list_files`, injectable shell. | A *second* toolkit, not an improvement — same sandbox, same permission projections, different contracts. Shares `/coding`'s internals and its canonical-path write lock. |
| **`WebToolkit`** | `/web` | Model-facing search and guarded fetch, over provider-neutral `WebSearch` / `WebFetch` capabilities. | Providers are Layers: `/web/brave`, `/web/http`. Test doubles live in `/testing`. |
| **`McpToolkit`** | `/mcp` | Remote MCP tools as an ordinary `Toolkit`. | Two doors: `bind` (declare locally, verify at connect, fully typed) and `bindDiscovered` (`Tool.dynamic` over the server's JSON Schema). That pair is the model [research-tool-sources.md](./research-tool-sources.md) generalises. |
| **`ToolSource`** | `/tool-source` | One eager extraction + invocation seam over external tool catalogs. | The same declared/discovered doors over MCP, OpenAPI and GraphQL. Extraction reports skipped operations instead of silently creating broken tools; discovered toolkits preserve a `never` service requirement rather than leaking `any`. Credential resolution remains application/auth work. |
| **`Subagent`** | `/subagent` | A tool that delegates a prompt to a child agent. | Typed convenience over child sessions; adds nothing to the engine. Composes with `/tree` when the children should be navigable. |

## 4. Context, state and memory

All four are `ContextTransform`s. None touches canonical history.

| module | path | what | relates to |
| --- | --- | --- | --- |
| **`Compaction`** | `/compaction` | Keeps a long conversation inside a context window by changing the *projection* — summarise the head, keep the tail. | The transcript is never rewritten. `/export` still sees everything. |
| **`Skills`** | `/skills` | Capabilities the model loads only when it needs them: a registry, a transform that advertises metadata, a tool that loads a body. | OpenCode's loading strategy over existing seams. `/plugins` loads skills from a portable directory. |
| **`Memory`** | `/memory` | Long-term, cross-session memory: a service, a recall transform, a write tool and a loop hook. | Distinct from `/state` — that is typed *this* session's value; this is what survives across them. |
| **`AgentState`** | `/state` | A typed value handlers read and write, optionally surfaced into the prompt and persisted. | The battery `/budget` and most applications reach for first. |

## 5. Policy and control

| module | path | what | relates to |
| --- | --- | --- | --- |
| **`Budget`** | `/budget` | A token ceiling enforced through the loop seam. | The canonical example of "a battery is a `Loop` plus a service". |
| **`Scheduling`** | `/scheduling` | An `AgentDispatcher` seam for future work, plus a resilient `recurring` over `Schedule`. | Adapters over Effect's scheduling, not a scheduler runtime. `/cluster`'s `ScheduledAgent` is the distributed implementation. |
| **`Hooks`** | `/hooks` | Typed side effects at lifecycle points, with isolated failures. | A convenience over `AgentEvent.match`; adds nothing. |
| **`Redaction`** | `/redaction` | One vocabulary for content that must not leave. | Deliberately owned by neither the tracer nor the exporter, because both need it: `/observability` and `/export` share the rules. |

## 6. Transports and protocols

These all speak `AgentClient`, not `AgentSession`.

| module | path | what | relates to |
| --- | --- | --- | --- |
| **`AgentClient`** | `/client` | The remote-session seam: the same five operations and the event stream, in terms that cross a process boundary. | Every adapter below implements or consumes this rather than inventing its own session. |
| **`AgentProtocol`** | `/client` | The schemas, operations, request ids and typed errors the seam speaks. | Shared by RPC and HTTP so neither depends on the other. |
| **`AgentSessionHost`** | `/client` | One shared session registry, capacity, principal resolution and per-operation authorization for **all** adapters. | Exists because adapters with private registries gave one app multiple meanings of `maxSessions`. New `/mcp` applications use its additive shared-host path; the legacy one-tool MCP layer retains its documented idle-eviction policy for compatibility. Also the natural anchor for per-principal credentials ([research-tool-sources.md](./research-tool-sources.md) §7.6). |
| **`AgentRpc`** | `/rpc` | Effect RPC rendering of the protocol. | Assigns procedure names and marks `events` as a stream; the schemas stay in `/client`. |
| **`AgentHttp` / `AgentServer`** | `/http` | HTTP/SSE surface, and mounting several agents on one server. | `fromGenerated` / `agentClientLayer` let HTTP back an `AgentClient`, so one server can serve a local mount and a remote-backed one. |
| **`AgentAgUi`** | `/ag-ui` | The AG-UI protocol. | Event projection over the same stream. |
| **`AgentA2A`** | `/a2a` | Agent-to-agent: Agent Card, JSON-RPC and HTTP+JSON, streaming, cancel, input-required continuation, a typed client. | Its fork-a-listener-on-`events` pattern for elicitation is the shape `/mcp` should borrow. Both peer directions are tested against the official SDK. |
| **`AgentMcp`** | `/mcp` | The agent exposed *to* MCP clients as tools. | The outbound half; `McpToolkit` is the inbound half. The shared-host surface has bounded start/await, controls, status/respond and stdio-native elicitation; resources/progress and prompts remain in [plan-mcp-frontend.md](./plan-mcp-frontend.md). |
| **`McpClient`** | `/mcp` | Transport-agnostic MCP client seam. | SDK-specific adapters at `/mcp/v1` (monolithic SDK) and `/mcp/v2` (split packages), so the two nominal client types never meet. |
| **`OpenAiAgent`** | `/openai` | `POST /v1/chat/completions` over any `AgentClient`. | Makes any OpenAI-compatible client a front end. |
| **`Connectors`** | `/connectors` | An agent in front of an external platform — verify, map conversation to session, prompt, reply. | Over `AgentSessionHost`. Slack ships at `/connectors/slack` with a portable Web Crypto verifier. Conformance plan in [plan-integrations.md](./plan-integrations.md) §7. |

## 7. Durability and scale

| module | path | what | relates to |
| --- | --- | --- | --- |
| **`DurableAgent`** and friends | `/durable` | A submission interpreted as a durable workflow: model as activity, tools wrapped, input through `InputChannel.Factory`. | **Nothing reaches into the harness.** Canonical history is not persisted — it is rebuilt from replayed activity results, which is why the package needs no store. `DurableElicitation` is what lets a human pause outlive the process. |
| **`AgentEntity` / `EntityClient` / `ScheduledAgent`** | `/cluster` | The session as a cluster entity. | "At most one run per session" *is* an entity invariant and `AgentSession.Id` *is* a routing key, so single ownership and out-of-band input routing come free. The harness knows nothing about it. |
| **`DurableStreams`** | `/durable-streams` | The Durable Streams protocol as an Effect backend, and a reconnectable `DeliveryLog` over it. | What makes `events({ after })` a real resumption rather than a live stream wearing a resumption's clothes. |
| **`SessionTree` / `NodeStore` / `TreeExport`** | `/tree` | Conversations as a tree: every turn boundary is a node, any node can be branched from. | `branch` and `activate` hand back an ordinary `AgentSession`, which is what lets a tree be added without changing how an app talks to an agent. |

## 8. Observation, export and testing

| module | path | what | relates to |
| --- | --- | --- | --- |
| **`Observability`** | `/observability` | Semantic tracing conventions: a stable attribute vocabulary, content redaction, an observer over the event stream. | Standardises names; does not wrap Effect's tracing. Spans nest `session → submission → run → turn → {model, tool}`. Uses `/redaction` and `Metric`. |
| **`AgentData`** | `/data` | Schema-first named channels a tool writes and a UI reads, typed at both ends. | Observational — never touches canonical history. |
| **`Export` / `Replay`** | `/export` | A versioned envelope around a snapshot, plus a JSONL commit log. | `Replay` is why it earns its keep immediately: an exported transcript is already a `TestLanguageModel` script, so a session that hit a bug becomes a fixture with no provider and no network. |
| **`SessionProjection`** | `/sessions` | A session's events folded into what is true *now*: lifecycle, submission/run/turn counts, accumulated usage, tool outcomes, open tool calls and unanswered elicitations. | Pure `(state, envelope) => state`, so a live `Stream`, a `DeliveryLog.read({ after })` and an array all fold the same way — which makes repairing a gap a re-fold through `since(id, cursor)` rather than a second code path. Folds `DeliveryLog`; does not duplicate it. The `SessionDirectory` this would serve (`effect-plan-2.txt` §26) is not built. |
| **`Evals`** | `/evals` | Behavioural evals through the public interface: tools called, turns taken, reply shape, an LLM judge. | Distinct from `/testing` — that is the doubles, this is the assertions. |
| **`AgentProbe`** | `/testing` | Attaches once and buffers the whole event record. | A live stream means a late subscriber has already missed events. Records from `SubmissionStarted` onward; `SessionStarted` is emitted before any handle exists, and the probe says so rather than faking it. |
| **`TestLanguageModel`** | `/testing` | Scripted provider, including `failingAfter`. | In `src/` rather than `test/` on purpose: **test code counts as user code**, so the cast it needs lives in the one place licensed to hold it. |
| **`TestWebSearch` / `TestWebFetch`** | `/testing` | Doubles for the `/web` capabilities. | |

## 9. Plugins and extension

| module | path | what | relates to |
| --- | --- | --- | --- |
| **`Plugins`** | `/plugins` | Loads a portable Agent Plugins directory (`plugin.json` + `skills/` + `mcp.json`). | An adapter over `/skills`, `/mcp` and `/sandbox` — no core change. The main consumer of `McpToolkit.bindDiscovered`, and therefore the case that most needs code mode's catalog work ([research-code-mode.md](./research-code-mode.md) §5). |

## 10. Not public

`src/internal/` — `eventBus`, `history`, `ids`, `state`, `streamAccumulator`,
`telemetry`, `toolActivity`, `toolkit`, `detail`, `positive`, `schedules`. Not
in the export map; no stability guarantee.

Two engine-facing seams live in public modules but off the public namespaces:
`AgentSession.makeEngine` / `EngineOptions` (`submissionIds`, `eventSink`,
`beforeClose`) and `ToolExecution.execute`. `src/AgentSessionPublic.ts` and
`src/ToolExecutionPublic.ts` are what the package re-exports;
`test/PublicApi.test.ts` pins the lists. The README's maturity map labels
every subpath. `src/coding/internal/` likewise holds
the replacer chain, glob, line endings, prompts, read/search formatting, regex
safety and truncation shared by `/coding` and `/pi`.

## 11. Two findings from writing this — closed

Recorded here because they are export-map facts, not opinions.

**Elicitation was unreachable.** Closed 2026-08-27: the root and `/elicitation`
now export it, `PublicApi.test.ts` pins both surfaces, and the reference coding
agent uses `Elicitation.memory` through the package path.

`AgentTurn` is also unexported, and that one looks deliberate — nothing in the
public API takes or returns one.

**No example exercised the published export map.** Closed by
`examples/ref-coding-agent.ts`, which imports package paths only and runs in the
main check rather than merely typechecking.

## Related documents

- `PLAN.md` — the design authority.
- `STATUS.md` — what was built, and what was found wrong along the way.
- `ROADMAP.md` — the capability roadmap and the package rule quoted above.
- `AGENTS.md` — the conventions, and the no-casts rule.
- [plan-primitives.md](./plan-primitives.md) — the three axes and what is still
  missing.
- [research-code-mode.md](./research-code-mode.md),
  [research-tool-sources.md](./research-tool-sources.md),
  [plan-mcp-frontend.md](./plan-mcp-frontend.md),
  [plan-integrations.md](./plan-integrations.md),
  [plan-deployment.md](./plan-deployment.md) — the current design threads.
- [README.md](./README.md) — the index to everything else in this directory.
