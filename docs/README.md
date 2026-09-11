# Documentation index

Written 2026-08-27. Thirty-odd documents accumulated here with no index; this is
it. Grouped by what the document *is*, because that decides how much to trust it.

**The four at the root are the authorities.** `PLAN.md` is the design
authority, `STATUS.md` is the short statement of what is true now (its
chronology lives in [status-history.md](./status-history.md)), `ROADMAP.md`
tracks capability against the roadmap issues, and `AGENTS.md` holds the
conventions — above all, that end-user code must never need a type cast.

**Plans record decisions; their historical paragraphs can outlive the work.**
Status labels below were reconciled on 2026-09-08. Use `STATUS.md`, the closed
ledger and the implementation together when checking what ships.
[remaining-work.md](./remaining-work.md) tracks open implementation, proposals
and work awaiting a caller or external evidence.

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
| [remaining-work.md](./remaining-work.md) | The ranking, easiest first, of what is actually left -- the live list, and only what is open. |
| [decisions-2026-09-11.md](./decisions-2026-09-11.md) | The decisions open on 2026-09-11 and how each was settled, with the evidence at the time: pushing (and the standing rule for it), the merged branches and the stash (with their undo), a capped key for live runs, item 113's design of record, plan Q1/Q4/Q5, item 100's thresholds, and the trigger that reopens each parked item. |
| [plan-context-lessons.md](./plan-context-lessons.md) | Six lessons from `danieljvdm/effect-agent#335` (durable context-window rollover), each mapped to a seam here: rollover as a compaction decision, the harness as interpreter, a context-remaining tool, bounded history tools, a behaviour-change trailer, failpoint coverage. Ranked and sequenced. |
| [plan-exposure-and-terminal-work.md](./plan-exposure-and-terminal-work.md) | Proposal from `danieljvdm/effect-agent` #395–#424 (2026-09-08..10): progressive tool exposure behind a new visibility stage, completion from ordinary tool results, exclusive terminal batches, failure disposition, delivery-acknowledgement and budget-topology audits, a matched benchmark suite. Part II (#376–#391): exact-response durable recovery, a crash/no-crash equivalence oracle, host scheduling captured per attempt, a continuity evaluation, versioned durable tool contracts. Nothing started. |
| [plan-next-milestone.md](./plan-next-milestone.md) | Usage and release work: a daily review consumer, an observed newcomer, public API review and journal compatibility. The owner declined its proposed feature freeze; these do not gate the implementation backlog. |
| [plan-streaming.md](./plan-streaming.md) | Completed P1–P5: submission streams, argument deltas, delegated events, retention measurement and adapter coverage. |
| [plan-streaming-followups.md](./plan-streaming-followups.md) | Streaming follow-ups: journal outcome fidelity, observation bounds, subscription ordering, lifecycle and A2A policy shipped. Client capability discovery remains a proposal (live item 86); nameless fragments await a provider reproduction. |
| [plan-two-decisions.md](./plan-two-decisions.md) | Decisions shipped: freeze existing wire/storage identifiers, and report interrupted delegation as a typed failure carrying partial output. Also records the explicit triggers for parked work. |
| [remaining-work-closed.md](./remaining-work-closed.md) | The ledger: every entry the live list has closed, verbatim, with its reasoning and its `verify:` lines still checked. Nothing in it is next. |
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
| [plan-mcp-frontend.md](./plan-mcp-frontend.md) | Host tools, resources and finite durable-backed event reads ship. Skill prompts need permission-aware loading; progress and resource subscriptions remain constrained upstream. |
| [research-code-mode.md](./research-code-mode.md) | Code mode — one `execute` tool over a confined interpreter — as opencode and executor each implement it, and how it would fit here. |
| [research-tool-sources.md](./research-tool-sources.md) | Turning OpenAPI, GraphQL, MCP, WebMCP, CLIs and typed SDKs into tools: the source seam, three tiers of type safety, laziness, and auth. |
| [plan-tool-credentials.md](./plan-tool-credentials.md) | Implemented credential methods, per-principal bindings, providers, refresh and reauthorization over CurrentPrincipal. |
| [plan-integrations.md](./plan-integrations.md) | Conformance suites and sandbox lifts ship. One real remote provider remains the acceptance test of the small-adapter claim; richer channel events remain open. |
| [plan-deployment.md](./plan-deployment.md) | Node, Durable Objects, Rivet actors, Alchemy, and how a public server fronts and delegates to any of them. |

## Plans — specified, not (or only partly) implemented

| document | what it is |
| --- | --- |
| [plan-agent-product-control-plane.md](./plan-agent-product-control-plane.md) | Persistent named-agent product/control-plane architecture: `AgentSpec -> AgentDefinition`, organizations, projects/tasks, SessionDirectory + Needs You, browser/computer, connections/OAuth, automations, artifacts, knowledge, frontend, and an ordered build sequence over the existing kernel. |
| [plan-workbench.md](./plan-workbench.md) | A fully open-source Open WebUI/bb-class workbench with Effect-native product/runtime/UI seams: `AgentClient` stays the execution contract, `AgentEvent` drives a UI-neutral projection, and React/assistant-ui/AG-UI are replaceable edge adapters. |
| [plan-filetypes.txt](./plan-filetypes.txt) | End-to-end multimodality. **Phases 1–5 landed** (the `PromptWire` codec, `content` on results and events, media through A2A/OpenAI/AG-UI, and `/blob`); steps 6 (adapters externalizing automatically) and 7 (relay) remain. |
| [plan-a2a-layers-bridges.txt](./plan-a2a-layers-bridges.txt) | Two features: another agent *as a model*, and spawning Claude Code / OpenCode as A2A agents. **Steps 1–4 landed** — both bridges ship, share one permission decision, and are proven against the real Claude Code and OpenCode runtimes; `examples/ref-delegation.ts` is the reference. Step 5, the bridges over the relay, holds with no new code (item 114, `test/A2ABridgeOverRelay.test.ts`); steps 6–7, the `LanguageModel` experiment, are item 115. |
| [plan-effect-cf-and-webtransport.md](./plan-effect-cf-and-webtransport.md) | effect-cf adopted at the Cloudflare host boundary by owner decision. WebTransport remains closed until a caller needs it. |
| [plan-effect-uai-integration.md](./plan-effect-uai-integration.md) | Comparison with `betalyra/effect-uai` and a staged interoperability plan: borrow its compatibility/loss-accounting, provider-data, Toolkit ergonomics, recipes and workspace lessons; adapt effect-uai behind Effect AI's `LanguageModel.make` first; then reuse search/RAG/sandbox/browser capabilities; defer a deeper replaceable AI substrate until adapter evidence demands it. |
| [plan-effect-uai-compatibility-contract.md](./plan-effect-uai-compatibility-contract.md) | Phase 0 of the plan above, done: the Effect AI <-> effect-uai translation contract read against `@effect-uai/core@0.14.0`. Conformance rows with an exact/degraded/unsupported policy each, a decided refusal mapping, and four findings that fix the adapter's shape -- the model id binds at construction, `generateText` must drain `streamTurn` because effect-uai's reasoning item has no text field, Effect AI's incremental-request fields have no counterpart, and non-image files are unsupported both ways. Item 89. |
| [plan-run-stream-start.md](./plan-run-stream-start.md) | Take the best run-oriented ergonomics without flattening Affe's execution model: keep `Agent.run`; add scoped `Agent.start` with bounded process-local replay and one-shot `Agent.stream`; add a producer-side tool-progress byte ceiling, stable exhaustion classification/presets, and (only if missing) a raw operational recovered-tool-failure observer. |

| [opencode-completion-plan.md](./opencode-completion-plan.md) · [effect-plan-2.txt](./effect-plan-2.txt) | A design brief for `SessionInbox` / `ProcessManager`; the second is the tree-annotated revision with the implementation order. **§27 `SessionProjection` landed 2026-09-01** as `/sessions`; the rest was ranked as items 26l–26p, all shipped and in [remaining-work-closed.md](./remaining-work-closed.md). |

## Plans — landed

Kept because they record *why*, not because there is work left in them. See
[remaining-work.md](./remaining-work.md) for the slices still open.

| document | what it built |
| --- | --- |
| [plan-seams.md](./plan-seams.md) | Completed: replay-safe budgeting, delegation inheritance, injected-tool definitions, combination tests, Agent.Any and executable documentation claims. |
| [plan-failure-paths.md](./plan-failure-paths.md) | Completed items 48a–48f: retry safety, failpoints, settlement verification, client conformance and relay lifecycle. Durable mailbox withdrawn. |
| [plan-model-capabilities.md](./plan-model-capabilities.md) | Completed M0–M6: exported metadata, compaction budgets, caching, cost accounting, capability preflight and model-selection example. |
| [plan-branching-and-compaction.md](./plan-branching-and-compaction.md) | Phases 1–14 and measured rollover/overflow handling ship. Provider-refusal recovery reopens only when adapters expose a structured overflow code. |
| [plan-effect-agent-comparison.md](./plan-effect-agent-comparison.md) | Completed comparison actions: onboarding, loop limits, contracts, typed input, Cloudflare entry and isolate executor. Remaining live deployment evidence is item 19. |
| [plan-input-default.md](./plan-input-default.md) | Completed: prompt/text defaults, typed wire input/output and guides. Duplicating default prompt input in journals was deliberately declined. |
| [plan-rfc-286-durable.md](./plan-rfc-286-durable.md) | Completed: retry safety, the early-answer race test and Durable Object dispatch intents (item 47). |
| [plan-relay.txt](./plan-relay.txt) | Relay implementation completed: authenticated routing, leases, reconnection, enrollment and RPC conformance. Bridge-specific integration evidence is live item 84. |
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
- `reports/` holds **generated** run output, not prose: `mutations.json` from
  `npm run verify:mutations`, `falsification.json` from `npm run
  verify:durability`. Each is overwritten wholesale by its script -- edit the
  script, never the file.

- [status-history.md](./status-history.md) — the chronology that used to be
  `STATUS.md`: every dated finding and falsification, oldest first; new work
  appends here and edits the line in `STATUS.md` it changes.
- [conformance-matrix.md](./conformance-matrix.md) — the cross-adapter
  conformance matrix: HTTP, RPC, MCP, A2A and AG-UI held to the same rows
  (creation, continuation, capacity, authorization, interruption,
  idempotency, resumption), with each adapter's declared limitations.
