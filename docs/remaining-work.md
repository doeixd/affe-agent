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
| `plan-filetypes.txt` phases 1–4 | `PromptWire` codec at every boundary; `content` on the remote result and the completed-message event; streamed files announced whole; media through A2A, OpenAI and AG-UI. |
| `plan-shell-tool.md` | S0–S5 landed: `shell` tool, construction-time dialect, `configure`. |
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
2. ~~**`plan-shell-tool.md` (S0–S5)**~~ — landed 2026-08-29: the tool is
   `shell`, described for the dialect the toolkit was built with, resolved
   once by `configure`; no `bash` alias. Release note in the README.
3. ~~**Filetypes phases 2–4**~~ — landed 2026-08-29: `RemoteResult.content`,
   `MessageCompleted.content`, `MessagePartCompleted`, `PromptWire.Part`,
   and media in/out of A2A, OpenAI (`image_url`, `input_audio`, `file`) and
   AG-UI (`binary` input); fixed the kernel dropping file parts from history
   on the way. Phase 5 (blob store) is item 23.
4. ~~**`session.submit` on the remote surfaces + `requestId` idempotency**~~
   — landed 2026-08-29 with the retention contract
   ([plan-submit-await.md](./plan-submit-await.md)): `submit` /
   `awaitSubmission` on every client, bounded per-session retention in the
   in-process client, the journal for the durable one,
   `AgentSubmissionNotFoundError`.
5. ~~**MCP frontend host seam**~~ — landed 2026-08-30: `host.sessions` and
   `host.eventLog` (bounded tail, `oldest`/`latest`, refusal behind the
   bound), `agent://sessions` and `agent://session/{id}/events[/after/{n}]`.
   Left: delete the legacy `AgentMcp.layer`/`handlers` path (still used by
   the stdio fixture, the conformance suite and `examples/mcp.ts`); serve
   `eventLog` from the durable `DeliveryLog` on durable-backed hosts;
   progress tokens and native HTTP elicitation stay blocked upstream; skill
   prompts wait on a permission-aware `SkillRegistry` load.
6. **Tool-source gaps** — mostly landed 2026-08-30: MCP hints ride on
   `RemoteTool.annotations` through both real clients, and every bind path
   (`McpToolkit.bind`/`bindDiscovered`, `ToolSource.bind`/`bindDiscovered`,
   `fromMcpConnection`) turns a source's approval hint into the tool's own
   `needsApproval` -- the thing `intrinsicApproval` actually reads; before,
   `requiresApproval` was only a permission *projection*, and no approval was
   ever asked. Declared tools are floored, never loosened. Dropped names and
   `skipped` entries are logged. Left: headers are not `Redacted`, and the
   real design item -- per-principal credential resolution
   (research-tool-sources §7), of which only the per-invocation `headers`
   hook exists.
7. ~~**Cluster D7 wire contract**~~ — landed 2026-08-30: `submit`, `steer`
   and `followUp` declare `StorageError` beside `AgentIdleError`; the entity
   no longer turns a store failure into a defect, and `EntityClient.wrap`
   folds it into `AgentTransportError` as the durable client does.
8. ~~**Elicitation terminal state**~~ — verified 2026-08-30 rather than
   built: the memory elicitor already refuses a second answer (the
   `Deferred` is the terminal state; a racing pair is pinned), and the
   durable engine journals the observed answer. See `ROADMAP.md` and the
   note at `DurableElicitation.respond`.

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
