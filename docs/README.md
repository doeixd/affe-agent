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
| [MODULES.md](./MODULES.md) | Every public module — what, why, and what it composes with. The answer to "which module do I need for X". |
| [remaining-work.md](./remaining-work.md) | The ranking, easiest first, of what is actually left. |
| [transport.md](./transport.md) | Reference for how a session crosses a process boundary: the client seam and every transport over it. |

## Current design threads (2026-08-27)

Written together over one pass; heavily cross-referenced. Since then
`/tool-source`, the host-based MCP frontend, the workerd probe and the first
reference agent have landed; each file carries its own status line, and
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
| [plan-filetypes.txt](./plan-filetypes.txt) | End-to-end multimodality. Phase 1 (the `PromptWire` codec) landed; blob storage and protocol projections (phases 2–5) remain. |
| [plan-branching-and-compaction.md](./plan-branching-and-compaction.md) | Pi's token-budget triggering, branch summarisation and manual compaction over `/compaction` and `/tree`. Phases 1–7 landed; 8–15 (default summariser, manual `compact()`, branch summaries, durable activities) remain. |
| [plan-a2a-layers-bridges.txt](./plan-a2a-layers-bridges.txt) | Two features: another agent *as a model*, and spawning Claude Code / OpenCode as A2A agents. |
| [plan-relay.txt](./plan-relay.txt) | A secure addressable transport for services behind NAT, as an `RpcClient.Protocol`. Sixteen phases. |
| [opencode-completion-plan.md](./opencode-completion-plan.md) · [effect-plan-2.txt](./effect-plan-2.txt) | A design brief for `SessionInbox` / `ProcessManager`; the second is the tree-annotated revision with the implementation order. |

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
| [plan-durability-hardening.md](./plan-durability-hardening.md) | The durability guarantees. Complete; `npm run verify:durability` re-runs SD2. |
| [plan-tui-port.md](./plan-tui-port.md) · [plan-tui-tool-views.md](./plan-tui-tool-views.md) | `apps/tui`, and per-tool rendering. |

## Research — other people's code, at a point in time

Treat as dated. Each names the commit or the date it was read.

| document | subject |
| --- | --- |
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
