# Remaining work

Rewritten 2026-08-29 from an audit of every plan in `/docs` against what ships
at `b554458` (four read-only passes: kernel/durability plans, transport/server
plans, tools/toolkit plans, and the progress files themselves). This is the
live list; `STATUS.md` is the chronology and `ROADMAP.md` the capability view.

State of play: issues #1–#3 and #5–#80 are closed; #4 (the roadmap tracker) is
the only open issue. `npm run check` is green: 1466 tests in 131 files, zero
Effect diagnostics, portability and the workerd bundle pass, and
`npm run verify:durability` shows D1–D7 biting (D4b survives by construction).

## Already done — do not restart

| Plan | State |
| --- | --- |
| `plan-execution-plan.md` | Complete (X1–X4, XS1–XS4). |
| `plan-opencode-tools-port.md` | M1–M6 landed, post-review hardening included. |
| `plan-pi-toolkit.md` | P0–P5 landed. |
| `plan-session-tree.md` | T1–T5 landed; delta storage deliberately deferred; ST6 example never written. |
| `plan-snapshot-export.md` | E1–E5 landed. |
| `plan-agent-server.md` | S1–S5 landed. |
| `plan-durability-hardening.md` | H1–H9, SD1–SD6 landed; `scripts/falsify.mjs` is the re-runnable SD2. |
| `plan-tui-port.md` / `plan-tui-tool-views.md` | V0–V9, W1–W5 landed (W5's diff view shipped once the data existed). |
| `audit-effect-ecosystem.md` | All actions closed. |
| `plan-filetypes.txt` phase 1 | `PromptWire` codec at every boundary. |
| `plan-branching-and-compaction.md` phases 1–10 | Preparation, token policy, Schema checkpoint, KV persistence, serializer, default model summariser, controller with manual `compact()`, compaction events. |
| `research-tool-sources.md` first slice | `/tool-source` seam; OpenAPI, GraphQL, MCP sources; per-invocation `headers`. |
| `plan-mcp-frontend.md` phases 1–3 | Host-based `serverLayer`, nine tools, history/pending resources, stdio elicitation. |
| `plan-deployment.md` §10.1 | workerd typecheck + bundle probe in `check`. |

## Ranked

Ordered by user-visible value per unit of work. Each row says why it is still
open, so the next pass does not have to re-derive it.

### Functional gaps in shipped packages

1. ~~**Compaction phases 8–10**~~ — landed 2026-08-29: `Compaction.model`
   / `continuationSummary`, `Compaction.controller` with `compact` /
   `checkpoint` / `clear` / `events`, and the `CompactionEvent` Schema.
   Phases 11–15 are item 22.
2. **`plan-shell-tool.md` (S0–S5)** — fully specified, zero code. The
   model-facing tool is still named `bash` in `/coding` and `/pi`
   (`CodingToolkit.ts`, `PiToolkit.ts`), its prompt says "with bash", and both
   toolkits resolve `Shell.current()` at execution rather than construction.
   On a PowerShell host the API lies about itself.
3. **Filetypes phases 2–4** — `RemoteResult.content`, `MessageCompleted`
   content parts, and media on A2A / OpenAI `image_url` / AG-UI are text-only
   (`AgentClient.ts`, `AgentEvent.ts`, `AgentA2A.ts`, `AgentAgUi.ts`). The
   codec exists, so these are mechanical. Phase 5 (blob store) is separate and
   larger.
4. **`session.submit` on the remote surfaces + `requestId` idempotency** —
   the receipt exists on `AgentSession` only; not on `AgentClient`,
   `AgentSessionHost` or the durable client, and the retention contract for
   completed outcomes is still undecided (`STATUS.md`, "Three issues from a
   review pass"). Prerequisite for the `SessionInbox` architecture.
5. **MCP frontend host seam** — `agent://sessions` and `…/events?after=N`
   need session enumeration and a finite event-log read on
   `AgentSessionHost`; neither exists. Also delete the legacy
   `handlers`/`layer` path in `AgentMcp.ts` once nothing uses it. Progress
   tokens and native HTTP elicitation stay blocked on upstream `McpServer`;
   skill prompts wait on a permission-aware `SkillRegistry` load.
6. **Tool-source gaps** — MCP `readOnly`/`destructiveHint` are not carried
   into permissions; `bindDiscovered` silently drops invalid names and
   `skipped` entries; `Permission.annotate` is applied in `bindDiscovered` but
   not `bind`; headers are not `Redacted`. Then the real design item:
   per-principal credential resolution (research-tool-sources §7), of which
   only the per-invocation `headers` hook exists.
7. **Cluster D7 wire contract** — `AgentEntity`'s RPC error schema is
   `AgentIdleError` only; a `StorageError` becomes a defect on the wire
   (`src/cluster/AgentEntity.ts`). Widen it so the cluster is not the weaker
   D7 cell.
8. **Elicitation terminal state** — decoding `Response.value` against the
   request's schema exists; an explicit terminal state guarding against
   double-resolution does not (`ROADMAP.md`).

### Proof and hygiene

9. **`SandboxConformance.suite`** in `/testing` over the real `Sandbox`
   contract (`read/write/list/stat/canonical/exec`), broken once against a
   deliberately wrong provider. Unblocks `Sandbox.fromExec` /
   `fromOperations` and every deployment step that needs a non-local sandbox.
10. **Cross-adapter conformance matrix** — `AgentClientContract`,
    `DeliveryLogContract`, `NodeStoreContract` and `McpServerConformance` exist,
    but nothing holds HTTP, RPC, AG-UI, A2A and MCP to one answer on capacity,
    auth, idempotency and resumption (design-assessment rec 4).
11. **Public/SPI boundary** — `MakeOptions.eventSink` / `submissionIds` and
    `ToolExecution.execute` are public but engine-facing (design-assessment
    rec 2). Then a maturity label per subpath; README marks only three
    packages experimental (rec 3).
12. **TUI** — remove the nine `as never` casts in `apps/tui/src/smoke.tsx`
    (CLAUDE.md rule; test code counts) and add the missing SV2 render
    assertions for `search`, `read_file`, `write_file`. Live-region scrolling
    and syntax highlighting stay blocked on OpenTUI parsers.
13. **A2A slow-consumer test or bound** — both SSE pumps are
    `Queue.unbounded` with a rationale (#31); AG-UI is bounded at 256. Either
    add the slow-consumer test that justifies the asymmetry or bound it.
14. **Small A2A additions** — `A2A.tool(...)` wrapping `RemoteAgent.send` +
    `typed()`; there is no equivalent today.
15. **`examples/session-tree.ts`** (ST6) — write it or strike ST6.
16. **`ChannelConformance`** packaging — the Slack cases (signature, replay,
    idempotency) exist ad hoc; threading, attachments and hostile payloads do
    not.
17. **Compress `STATUS.md`** — 3k chronological lines; the 2026-08-29 section
    corrected the flatly wrong sentences, but a short "current truth" document
    with the chronology moved under `docs/` is still the right end state
    (design-assessment rec 7).
18. **Close #4** — mark the shipped items and close the tracker.

### Larger, correctly parked

19. **Real workerd / Durable Object host** — `apps/worker` is a compile-time
    fence; a DO-hosted `AgentHttp`, a DO-storage `KeyValueStore`, and the
    `/durable`-on-DO decision are unstarted (`plan-deployment.md` §3, §7).
20. **Reference gateway and declarative references, presets, LSP/code-mode
    batteries** (`plan-primitives.md` steps 3–6) — only the coding reference
    exists.
21. **Code mode** (`research-code-mode.md`) — signature generation and the
    budgeted catalog are useful without an interpreter; nothing in `src/`.
22. **Compaction phases 11–15** — branch-seed seam, `BranchSummary`, `/coding`
    file details, durable summariser activities, overflow recovery.
23. **Filetypes phase 5** — blob store, size/MIME policy.
24. **Session-tree delta storage + `Cache`** — only if whole-snapshot
    serialisation actually bites.
25. **`plan-a2a-layers-bridges.txt`, `plan-relay.txt`, `effect-plan-2.txt`**
    — new packages and architecture (Claude Code / OpenCode bridges, relay
    transport, `SessionInbox` / `ProcessManager`). Preconditions are all met
    and tested; nothing started. `plan-deployment.md` §6.3 narrows when the
    relay is the right tool.

### Known, deliberately left

- **D4b** survives the falsification harness by construction:
  `instance.suspended` carries the correctness and the two remaining
  disjuncts in `DurableAgent`'s `catchCause` are defence in depth. Recorded in
  `plan-durability-hardening.md` and `scripts/falsify.mjs`; nobody has decided
  to delete them, and the harness will say so if that changes.
- **`DurableAgent.workflow` requirement erasure** claims `never` while
  resolving `LanguageModel` at runtime (`STATUS.md`, durable client).
- **Legacy MCP cancellation id mismatch** — upstream; the official client's
  cancel cannot interrupt the server.
- **Anthropic example** has never been run live with a key.
- **`ClusterMultiNode` on real time** (~15 s) — H7 would move it to
  `TestClock`; cost only.
