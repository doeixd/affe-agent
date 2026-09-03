# Documentation index

Written 2026-08-27. Thirty-odd documents accumulated here with no index; this is
it. Grouped by what the document *is*, because that decides how much to trust it.

**The four at the root are the authorities.** `PLAN.md` is the design
authority, `STATUS.md` is the short statement of what is true now (its
chronology lives in [status-history.md](./status-history.md)), `ROADMAP.md`
tracks capability against the roadmap issues, and `AGENTS.md` holds the
conventions — above all, that end-user code must never need a type cast.

**Inside `docs/`, nothing is a record of what ships.** A plan marked *specified,
not implemented* has not been built; a research note describes somebody else's
code at a point in time. [remaining-work.md](./remaining-work.md) is the ranking
that says what is actually next.

---

## Start here

| document | what it is |
| --- | --- |
| [guide-sessions.md](./guide-sessions.md) | What a local session does: steering, follow-ups, interruption, streaming, elicitation, events, errors, authoring, snapshots, testing. |
| [guide-permissions.md](./guide-permissions.md) | The `Permission` seam: allow / ask / deny, rules, exceptions, remembered grants. |
| [guide-sandbox.md](./guide-sandbox.md) | `/sandbox`, the coding toolkits, the `shell` dialect, and the Claude Code / OpenCode bridges. |
| [guide-code-mode.md](./guide-code-mode.md) | `/code`: the `execute` tool, the interpreter's boundary with each confinement cited to its test, the read-only recipe. |
| [guide-transports.md](./guide-transports.md) | `AgentClient` and every adapter over it: HTTP, RPC, AG-UI, OpenAI-compatible, A2A, MCP. |
| [guide-durable.md](./guide-durable.md) | `/durable`, `/cluster`, the durable client, Durable Streams. |
| [guide-batteries.md](./guide-batteries.md) | Every battery: subagents, scheduling, hooks, connectors, data, observability, evals, memory, skills, state, compaction, plugins. |
| [limits.md](./limits.md) | Every bound a user can hit, with its default. |
| [examples.md](./examples.md) | Every example, one line each. |

These guides were the README's long sections until 2026-09-01; the README now
holds only the install, quickstart, seam map, package map and stability notes.


| document | what it is |
| --- | --- |
| [getting-started.md](./getting-started.md) | One typed agent, running against the scripted model with no key. The code is `examples/getting-started.ts`, pinned by a test. |
| [platforms.md](./platforms.md) | Node and Cloudflare Workers, one table: what runs where and what survives what on each. Bun is untested and says so. |
| [MODULES.md](./MODULES.md) | Every public module — what, why, and what it composes with. The answer to "which module do I need for X". |
| [remaining-work.md](./remaining-work.md) | The ranking, easiest first, of what is actually left. |
| [transport.md](./transport.md) | Reference for how a session crosses a process boundary: the client seam and every transport over it. |

## Current design threads (2026-08-27)

Written together over one pass; heavily cross-referenced. Since then
`/tool-source`, the host-based MCP frontend, all four reference agents,
`/presets`, `/code` and the two delegation bridges have landed — and the
workerd *probe* became a real Durable Object host (`apps/worker`, proven on
workerd through miniflare). Each file carries its own status line, and
[remaining-work.md](./remaining-work.md) ranks what is left.

| document | what it is |
| --- | --- |
| [plan-primitives.md](./plan-primitives.md) | The strategic frame: the six ecosystem targets are three axes, which of them need new primitives, and reference implementations as acceptance criteria. **Read this first of the six.** |
| [plan-mcp-frontend.md](./plan-mcp-frontend.md) | Growing `/mcp`'s outbound half from one blocking tool into a real frontend — start/await, elicitation, resources, cancellation. |
| [research-code-mode.md](./research-code-mode.md) | Code mode — one `execute` tool over a confined interpreter — as opencode and executor each implement it, and how it would fit here. |
| [research-tool-sources.md](./research-tool-sources.md) | Turning OpenAPI, GraphQL, MCP, WebMCP, CLIs and typed SDKs into tools: the source seam, three tiers of type safety, laziness, and auth. |
| [plan-tool-credentials.md](./plan-tool-credentials.md) | The credential contract for tool sources (method / binding / provider, `Redacted` end to end, invariants), its shipped single-user slice, and the one kernel decision the multi-user half is blocked on. |
| [plan-integrations.md](./plan-integrations.md) | Sandboxes, channels, stores and deployment providers — matching Flue's reach with a conformance suite and lifts instead of code generation. |
| [plan-deployment.md](./plan-deployment.md) | Node, Durable Objects, Rivet actors, Alchemy, and how a public server fronts and delegates to any of them. |

## Plans — specified, not (or only partly) implemented

| document | what it is |
| --- | --- |
| [plan-workbench.md](./plan-workbench.md) | A fully open-source Open WebUI/bb-class workbench with Effect-native product/runtime/UI seams: `AgentClient` stays the execution contract, `AgentEvent` drives a UI-neutral projection, and React/assistant-ui/AG-UI are replaceable edge adapters. |
| [plan-model-capabilities.md](./plan-model-capabilities.md) | The metadata upstream's `Model` omits — vision, window, cost — and what it unblocks in compaction and `/budget`; why cross-provider option normalization is a non-goal, and where prompt caching sits. M0 and M3 (prompt caching) done, M1 written but not exported, M2/M4/M5/M6 open — **and none of it is committed yet**. |
| [plan-filetypes.txt](./plan-filetypes.txt) | End-to-end multimodality. **Phases 1–5 landed** (the `PromptWire` codec, `content` on results and events, media through A2A/OpenAI/AG-UI, and `/blob`); steps 6 (adapters externalizing automatically) and 7 (relay) remain. |
| [plan-branching-and-compaction.md](./plan-branching-and-compaction.md) | Pi's token-budget triggering, branch summarisation and manual compaction over `/compaction` and `/tree`. **Phases 1–14 landed**; only phase 15 (provider-overflow recovery) remains, deliberately parked. |
| [plan-a2a-layers-bridges.txt](./plan-a2a-layers-bridges.txt) | Two features: another agent *as a model*, and spawning Claude Code / OpenCode as A2A agents. **Steps 1–4 landed** — both bridges ship, share one permission decision, and are proven against the real Claude Code and OpenCode runtimes; `examples/ref-delegation.ts` is the reference. Steps 5–7 (relay, then the `LanguageModel` adapter) remain. |
| [plan-effect-cf-and-webtransport.md](./plan-effect-cf-and-webtransport.md) | Whether two third-party Effect packages belong at our host boundary. Decides a category, not just two packages: `effect-cf` is read-and-mine, not adopt; `effect-webtransport` is a falsification test of the RPC seam, not a transport. One guardrail fix stands regardless. Nothing implemented. |
| [plan-effect-agent-comparison.md](./plan-effect-agent-comparison.md) | What to take from [effect-agent.com](https://effect-agent.com/) — the other `effect-agent`, read 2026-09-01 — and what to leave. Finds a convergent turn model and six gaps: onboarding, run-policy completeness (`maxToolCalls`, `maxDuration`, a `Final` decision), shipped contracts, the Cloudflare host, typed input, rendered pages. Ranked in §2; items 36–45 of [remaining-work.md](./remaining-work.md). Nothing implemented. |
| [plan-input-default.md](./plan-input-default.md) | Every agent has an input and the prompt is the default: removes the `Input = never` conditional behind typed input, collapses the wire to one shape, then does the same for output. Specified 2026-09-02, not started; item 46. |
| [plan-rfc-286-durable.md](./plan-rfc-286-durable.md) | What to take from their "any Workflow engine" RFC: retry safety declared on the tool (the one real gap), the verified resume-before-suspension race in the pinned engine, and dispatch intents for the Durable Object host. Specified 2026-09-02; item 47. |
| [plan-relay.txt](./plan-relay.txt) | A secure addressable transport for services behind NAT, as an `RpcClient.Protocol`. Sixteen phases. |
| [opencode-completion-plan.md](./opencode-completion-plan.md) · [effect-plan-2.txt](./effect-plan-2.txt) | A design brief for `SessionInbox` / `ProcessManager`; the second is the tree-annotated revision with the implementation order. **§27 `SessionProjection` landed 2026-09-01** as `/sessions`; the rest is ranked as [remaining-work.md](./remaining-work.md) 26l–26p rather than the single line it used to be. |

## Plans — landed

Kept because they record *why*, not because there is work left in them. See
[remaining-work.md](./remaining-work.md) for the slices still open.

| document | what it built |
| --- | --- |
| [plan-opencode-tools-port.md](./plan-opencode-tools-port.md) | `/coding` — opencode's tool engineering. |
| [plan-pi-toolkit.md](./plan-pi-toolkit.md) | `/pi` — a second toolkit with Pi's contracts. |
| [plan-shell-tool.md](./plan-shell-tool.md) | The `shell` tool: dialect-aware, resolved at construction, in both batteries. |
| [plan-session-tree.md](./plan-session-tree.md) | `/tree` — branch and rewind over ordinary sessions. |
| [plan-snapshot-export.md](./plan-snapshot-export.md) | `/export` — the versioned envelope and JSONL commit log. |
| [plan-agent-server.md](./plan-agent-server.md) | `AgentServer` — several agents on one HTTP surface. Complete, S5 included. |
| [plan-execution-plan.md](./plan-execution-plan.md) | Provider fallback as a combinator, from the ecosystem audit. |
| [plan-code-mode-engine.md](./plan-code-mode-engine.md) · [plan-code-mode-executors.md](./plan-code-mode-executors.md) | `/code` — the owned acorn interpreter, then the executor seam proved by a second executor: suspension, the pre-flight validator, a search tool, and CallScript behind `CodeExecutor`. |
| [plan-structured-output.md](./plan-structured-output.md) | `AgentOutput` — a session that ends in a typed value, as a tool the model calls rather than a second model call. |
| [plan-submit-await.md](./plan-submit-await.md) | `submit` / `awaitSubmission` on every client, and the bounded-retention contract that makes a lost acknowledgement safe to retry. |
| [plan-principal-on-tool-fibre.md](./plan-principal-on-tool-fibre.md) | Getting the caller's subject onto the fibre that acts — the one kernel decision the multi-user half of `plan-tool-credentials.md` was blocked on. Decided and shipped as `Principal.CurrentPrincipal`. |
| [plan-workflow-cluster.md](./plan-workflow-cluster.md) | `/durable` and `/cluster` — the original implementation plan for durable and distributed execution; `PLAN.md` builds on it. |
| [plan-agent-plugins.md](./plan-agent-plugins.md) | `/plugins` — Agent Plugins 1.0.0 support over `/skills` + `/mcp`. |
| [plan-durability-hardening.md](./plan-durability-hardening.md) | The durability guarantees. Complete; `npm run verify:durability` re-runs SD2. |
| [plan-tui-port.md](./plan-tui-port.md) · [plan-tui-tool-views.md](./plan-tui-tool-views.md) | `apps/tui`, and per-tool rendering. |

## Research — other people's code, at a point in time

Treat as dated. Each names the commit or the date it was read.

| document | subject |
| --- | --- |
| [flue.md](./flue.md) | Every Flue concept mapped onto an existing Effect or harness primitive; the correspondence `plan-primitives.md` and `plan-integrations.md` take as settled. Committed 2026-09-01 after living outside the repo. |
| [research-effect-workflow.md](./research-effect-workflow.md) | Why Effect Workflow integration is a reason for the project to exist, and the one boundary to preserve. Moved from the root 2026-09-01. |
| [review-2026-08-20.md](./review-2026-08-20.md) | The first implementation review; its findings are folded into [status-history.md](./status-history.md). |
| [research-opencode-tools.md](./research-opencode-tools.md) | opencode v2's built-in tools — the edit replacer chain, truncation, prompts, permissions. |
| [research-session-tree.md](./research-session-tree.md) | Whether Pi's branch-and-rewind tree fits our primitives. |
| [research-code-mode.md](./research-code-mode.md) | See *Current design threads*. |
| [research-tool-sources.md](./research-tool-sources.md) | See *Current design threads*. |

## Evaluations and audits — decisions with reasons

| document | decision |
| --- | --- |
| [design-assessment-2026-08-28.md](./design-assessment-2026-08-28.md) | A code-informed assessment of the architecture, API and primitives after working across the kernel and its adapters. Point-in-time judgment, not a plan. |
| [audit-effect-ecosystem.md](./audit-effect-ecosystem.md) | Where the library was re-deriving Effect. All actions landed. |
| [evaluation-sandbox-effect-platform.md](./evaluation-sandbox-effect-platform.md) | Retain the narrow Node adapter for `sandbox/local`; do not add a second. |
| [evaluation-persisted-queue-job-store.md](./evaluation-persisted-queue-job-store.md) | `PersistedQueue` versus a `/scheduling` job store. |

## Reviews — point-in-time

[review-2026-08-24.md](./review-2026-08-24.md) and its numbered siblings,
plus [review-recent-commits-2026-08-24.md](./review-recent-commits-2026-08-24.md).
Superseded by whatever landed since; useful for the reasoning, not the verdicts.

---

## Conventions in this directory

- **A plan states its status in the first few lines.** *"Specified, not
  implemented"* means exactly that.
- **Research names its source and the date it was read**, because the subject
  moves. opencode, executor, Flue, Alchemy and WebMCP all changed during the
  week the current threads were written.
- **Findings are recorded where they are found**, then ranked in
  [remaining-work.md](./remaining-work.md). A finding that only lives in a plan
  is a finding nobody will act on.
- `.txt` files are earlier, less-edited briefs; `.md` files have been through a
  pass. The extension carries no other meaning.

- [status-history.md](./status-history.md) — the chronology that used to be
  `STATUS.md`: every dated finding and falsification, oldest first; new work
  appends here and edits the line in `STATUS.md` it changes.
- [conformance-matrix.md](./conformance-matrix.md) — the cross-adapter
  conformance matrix: HTTP, RPC, MCP, A2A and AG-UI held to the same rows
  (creation, continuation, capacity, authorization, interruption,
  idempotency, resumption), with each adapter's declared limitations.
