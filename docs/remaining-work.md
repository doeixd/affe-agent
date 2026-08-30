# Remaining work

Rewritten 2026-08-29 from an audit of every plan in `/docs` against what ships
at `b554458` (four read-only passes: kernel/durability plans, transport/server
plans, tools/toolkit plans, and the progress files themselves). This is the
live list; `STATUS.md` is what is true now, `docs/status-history.md` the
chronology, and `ROADMAP.md` the capability view.

State of play: every issue through #80 is closed, #4 (the roadmap tracker)
last, on 2026-08-30. `npm run check` is green: 1466 tests in 131 files, zero
Effect diagnostics, portability and the workerd bundle pass, and
`npm run verify:durability` shows D1–D7 biting (D4b survives by construction).

## Already done — do not restart

| Plan | State |
| --- | --- |
| `plan-execution-plan.md` | Complete (X1–X4, XS1–XS4). |
| `plan-opencode-tools-port.md` | M1–M6 landed, post-review hardening included. |
| `plan-pi-toolkit.md` | P0–P5 landed. |
| `plan-session-tree.md` | T1–T5 landed; delta storage deliberately deferred; ST6 example written 2026-08-30. |
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
   The legacy `AgentMcp.layer`/`handlers` path was deleted 2026-08-30 (the
   policy decided: refuse at capacity, never evict a live conversation); serve
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
   `skipped` entries are logged. The credential design item now has its contract
   (`docs/plan-tool-credentials.md`, 2026-08-30) and its single-user slice:
   `Credentials` in `/tool-source` -- method (placements), binding
   (opaque handles, `owner` a role), provider service (`fromValues`,
   `fromConfig`, `readOnly`), `Redacted` until `render`, typed
   `CredentialError` with `reauthRequired`, `headers(binding)` into the
   sources' hook (now typed to accept a failing effect). Multi-user is
   blocked on the principal reaching the tool fibre; see the parked list.
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

9. ~~**`SandboxConformance`**~~ — landed 2026-08-30 in `/testing`:
   framework-agnostic `cases(options)` (named Effects over
   `SandboxProvider`) and `run(layer, options)` returning a report with the
   *derived* capabilities (`exec`, `separateStderr`, `timeout`,
   `outputBound`). Passes against `memory` (scripted executor) and `local`
   (real processes); a deliberately wrong provider fails exactly the three
   promises it breaks. Not `suite(name, layer)`: `@effect/vitest` is a dev
   dependency, so the runner wiring is one line in the caller's test file.
   Next in that plan: `Sandbox.fromExec` / `fromOperations`.
10. ~~**Cross-adapter conformance matrix**~~ — landed 2026-08-30:
    `test/HostConformance.ts` (rows, runner, shared host and fixture) and
    `test/HostConformance.test.ts` (five drivers); the rendered table with
    every declared limitation is `docs/conformance-matrix.md`. It found and
    fixed an MCP defect (host refusals rendered as "internal server error";
    now `AgentMcp.ToolFailure`).
11. ~~**Public/SPI boundary**~~ — 2026-08-30: `submissionIds`, `eventSink`
    and `beforeClose` moved to `AgentSession.EngineOptions`, accepted by
    `makeEngine` only; `make` takes `MakeOptions`. `makeEngine` and
    `ToolExecution.execute` are off the package namespaces
    (`src/*Public.ts` re-export lists, pinned by `PublicApi.test.ts`). The
    README has a maturity map (core / supported / experimental / reference)
    for every subpath (rec 3).
12. ~~**TUI**~~ — 2026-08-30: the nine `as never` casts in
    `apps/tui/src/smoke.tsx` are gone (the fakes now carry the fields the
    event union requires; the restored history is built from typed
    messages), and SV2 has its `search`, `read_file` and `write_file`
    assertions, each named in the smoke. Live-region scrolling and syntax
    highlighting stay blocked on OpenTUI parsers.
13. ~~**A2A slow-consumer test or bound**~~ — 2026-08-30: the test
    justifies the asymmetry. On both the REST and JSON-RPC stream paths an
    unread stream's task completes and reading it late yields exactly the
    frames a prompt reader got (`test/AgentA2A.test.ts`, "stream
    backpressure"; broken once by dropping the pump's first frame -- a
    queue bound itself is not observable through a socket that buffers a
    whole few-KB response, which is the point). The A2A pump holds one
    finite protocol response; AG-UI's bound is backpressure on a live run's
    deltas. Both rationales now cite the test.
14. ~~**Small A2A additions**~~ — 2026-08-30: `AgentA2A.tool(name, {
    request, result, agent, contextId? })` is the typed exchange as a
    `BoundTool` for `Agent.make({ tools })`, in `Subagent.tool`'s shape;
    remote failures are the tool's declared failure, and an off-contract
    reply is `AgentA2ARemoteError` `BAD_RESULT`. Tested against the official
    SDK peer, through the handler and through a real run.
15. ~~**`examples/session-tree.ts`**~~ — written 2026-08-30 (ST6): branches,
    switches and renders to stdout, runnable against the scripted model
    (`npx tsx examples/session-tree.ts`), typechecked with the rest of
    `examples/`.
16. ~~**`ChannelConformance`** packaging~~ — 2026-08-30: `/testing` exports
    `ChannelConformance` (`cases(channel)` / `run(channel)`, signing relative
    to whatever `Clock` the verifier reads): signature, wrong secret, tampered body, the replay window in both
    directions, missing/mangled headers without throwing, and large/unusual
    bodies. Slack passes; a second in-test HMAC channel proves it
    generalises; a clockless channel fails exactly the replay case and a
    throwing one is reported, not crashed. Idempotency stays where it is
    (`Connectors.test.ts`: it is the host's dedupe, not the channel's).
    Threading and attachments are *not* in the suite: `/connectors` has no
    decoder seam to hold them to (a `Delivery` is text in a conversation), and
    asserting a shape that does not exist would be the wrong kind of test.
17. ~~**Compress `STATUS.md`**~~ — 2026-08-30: the 3.4k-line chronology is
    `docs/status-history.md` (moved with `git mv`, so its history follows
    it), and `STATUS.md` is ~130 lines of current truth: the gates as
    commands, the two properties, what ships per surface, what holds it
    there, what is deliberately not done. New work appends to the history
    and edits the line here it changes.
18. ~~**Close #4**~~ — closed 2026-08-30 with a comment naming what shipped
    since its last progress note; this list supersedes it as the tracker.

### Larger, correctly parked

19. **Real workerd / Durable Object host** — the core landed 2026-08-30:
    `apps/worker` is a real host (one DO per session, `/http` over
    `HttpRouter.toWebHandler`, history persisted to DO SQLite per completed
    submission, events journaled to the `DeliveryLog`, `events?after=N`
    gapless across the runtime's death), proven on real workerd by
    `test/WorkerDurableObject.test.ts` through miniflare, and the
    `/durable`-on-DO decision is recorded (no: the engine's resume machinery
    stalls on workerd -- measured minimal repro in `status-history.md`).
    `examples/deploy-cloudflare/` holds the Alchemy stack. Left: a real
    model wired through the stack and deployed from a clean account; the
    `fromExec` sandbox (blocked on `plan-integrations.md` §6.2); Rivet.
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
25. **Per-principal credentials** (`plan-tool-credentials.md` §6) — the
    binding must be chosen per principal per call, and the session does not
    carry the principal to the tool fibre. A kernel noun; design-review it
    (design-assessment rec 1) before building the `Bindings` store, reauth
    via elicitation and `securitySchemes` derivation that wait on it.
26. **`plan-a2a-layers-bridges.txt`, `plan-relay.txt`, `effect-plan-2.txt`**
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
