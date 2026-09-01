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
| `plan-branching-and-compaction.md` phases 1–14 | Preparation, token policy, Schema checkpoint, KV persistence, serializer, default model summariser, controller with manual `compact()`, compaction events; branch-seed seam, `BranchSummary` carryover, `/coding` cumulative file details, durable replay pin. Only phase 15 (overflow recovery) remains, deliberately parked. |
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
   `skipped` entries are logged. 2026-08-31: query placements applied by both sources (the `credentials`
    hook), `methodFromOpenApi` deriving methods from `securitySchemes`,
    per-subject `Bindings`/`resolveFor` over `CurrentPrincipal`, and
    finally `fromRefreshing` + `withReauth` (the OAuth escape hatch and
    reconnect-by-elicitation) -- **`plan-tool-credentials.md` is now
    complete**. The credential design item has its contract
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
    model wired through the stack and deployed from a clean account; Rivet.
    `Sandbox.fromExec` / `fromOperations` landed 2026-08-30 (a remote
    sandbox for the Worker is now one exec function away); a real remote
    provider (E2B/Daytona) still needs an account. The two upstream findings
    are drafted for filing in `docs/upstream/`.
20. **Presets, `ref-declarative`, batteries** (`plan-primitives.md` steps
    4–6). Step 3 landed 2026-08-31: `examples/ref-gateway.ts` is the
    integration axis' acceptance test, runs in CI, and found nothing
    missing (findings in `STATUS.md`). Step 2 completed the same day with
    the credentials plan, and step 6's code-mode battery is `/code`. Step 4 landed
    2026-08-31: `@doeixd/effect-agent/presets` (`Presets.coding`,
    `Presets.gateway`), derived from what the two references had written
    by hand, and both references rewritten on top of them as the
    acceptance test. A chat preset waits for a caller. Step 5 landed the same day:
    `examples/ref-declarative.ts` substantiates the ergonomics claim --
    state, its rendering, capability rules and reactions each declared as
    data -- and records the boundary it found (a toolkit is fixed at
    construction; what follows live state is the policy, per call). What
    remains: **step 6's batteries** (LSP, truncation as a service,
    rendered prompts), ranked by what step 1 found. **`plan-primitives.md`
    steps 1–5 are complete.**
21. ~~**Code mode**~~ (`research-code-mode.md`,
    `plan-code-mode-engine.md`) — complete 2026-08-31, plan and all six
    steps. `/code` ships `Catalog` (JSDoc TypeScript signatures from any
    toolkit, the token-budgeted round-robin catalog stating its own
    completeness, deterministic field-weighted search), the plain-data
    boundary, shape recovery, an owned tree-walking interpreter over
    `acorn@8.18.0` (v1 is plain JavaScript; TS gets a dedicated
    diagnostic), and `CodeMode`/`CodeTool` — a model-written program runs
    against real toolkits with every nested call passing the same
    `ToolExecution.decide` a direct call gets, an `Ask` pausing on the
    host's elicitor and a refusal throwing into the program. Two audit
    passes followed: hardening (a throwing builtin no longer fails the
    run, byte-accurate output limits, bounded call concurrency, search
    16x faster by memoising derived facts) and edges/type-UX
    (no-argument calls, no internal class names in diagnostics, and
    type-level pins — broken from the library side — that a tool's
    `dependencies` and a policy's `R` reach `execute`).
    `examples/code-mode.ts` runs, needs no services, and has no cast.
    Deliberately not built: durable suspension of a *paused* program,
    documented at the `elicitor` option rather than promised.
22. ~~**Compaction phases 11–15**~~ — 11–14 landed 2026-08-30: the
    branch-seed seam on `tree.branch`, `BranchSummary` over `divergence`
    with canonical carryover, `CodingSummary.wrap`'s cumulative file
    details, and the replay-not-repaid durable summariser pin. Phase 15
    (provider-overflow recovery) stays parked as the plan's own "later,
    narrow phase" — it needs a model-invocation recovery seam justified
    independently, not a compaction special case.
23. ~~**Filetypes phase 5**~~ — landed 2026-08-30: `/blob` (`BlobStore`
    content-addressed by SHA-256 with memory and `/blob/fs` backings,
    `withPolicy` size/MIME acceptance, typed `BlobRejectedError` /
    `BlobMissingError`) and `BlobWire.externalize`/`resolve`/`references`
    over the `PromptWire`-encoded form — oversized inline bytes become
    refs, a receiver resolves deliberately, an unresolved doc is refused
    loudly by the codec. The plan's step 6 (adapters/durable stores
    calling externalize automatically) and step 7 (relay) remain with the
    relay work, item 26.
24. **Session-tree delta storage + `Cache`** — only if whole-snapshot
    serialisation actually bites.
25. **Per-principal credentials** (`plan-tool-credentials.md` §6) — the
    principal decision is made and its mechanism SHIPPED 2026-08-31
    (`docs/plan-principal-on-tool-fibre.md`, decided as recommended):
    `Principal.CurrentPrincipal` on the root, set by
    `AgentSessionHost.Options.subject` around the five mutations
    (owner-of-the-reservation semantics), and carried on the durable path
    as `claim.principal` → `Payload.principal` → provided around the
    in-workflow run, optional/additive so existing journals decode.
    Pinned by `test/Principal.test.ts` (bare session reads `None`; two
    principals interleave on one hosted session; the durable tool reads
    what the claimer set), both mechanisms broken once. Still queued
    behind it: the per-subject `Bindings` store and
    `Credentials.resolveFor`, reauth via elicitation, `securitySchemes`
    derivation.
26b. **OpenRouter example** — SHIPPED 2026-08-31, `examples/openrouter.ts`.
    OpenRouter speaks the OpenAI API and `@effect/ai-openai@4.0.0-rc.112` takes
    an `apiUrl`, so the provider layer is ten lines of caller configuration and
    `src/` stays out of it (`plan-primitives.md`, model gateways). The example
    carries that snippet plus the two things a caller cannot guess: that routing
    *across* calls belongs to `ExecutionPlan` while OpenRouter's own routing is
    *within* one call, and that usage still reaches `/budget` through the
    ordinary usage events — in tokens, not dollars, which is the trap when a
    plan spans vendors at different prices. Typecheck-only, as
    `examples/anthropic.ts` is; the `_NeedsNothing` assertion was broken once to
    confirm it is enforced. One thing the plan had wrong: rc.112 speaks the
    **Responses** API (`POST /responses`), not chat completions, so "OpenAI-
    compatible" was not on its own sufficient — OpenRouter's `/api/v1/responses`
    was checked against its OpenAPI document. `@effect/ai-openai` is now a
    devDependency, for the example only.

26a. **`Sandbox.execStream`** — SHIPPED 2026-08-31, the prerequisite
    `plan-a2a-layers-bridges.txt` does not name. Its step 1 is "spawn through a
    child process; parse `stream-json`", and parsing `stream-json` means
    consuming output *incrementally* — that is how a bridge shows the agent
    working, maps interruption, and answers a permission prompt mid-run. There
    was no streaming exec anywhere in `src/`: `Sandbox.exec` buffers to a
    `CommandResult`. So the seam came first, where the plan's own physical
    boundary already puts the spawned CLI (§"Physical boundary").
    `ExecEvent` (bytes per stream, then exactly one `Exit`), `Sandbox.lines`
    (decoding across chunk boundaries), `Sandbox.collect` (events back to a
    `CommandResult`). Required on the handle, optional on `Operations` with a
    buffered derivation that is reported in `derived`. The local provider now
    has *one* process implementation — `exec` is `collect(execStream(...))` —
    and the conformance suite measures incrementality with a command that
    prints on a timer instead of believing a provider that claims it. The
    bridges are ordinary portable modules on top; the OpenCode bridge, which
    goes over `opencode serve`'s HTTP API, needs none of it, which is the sign
    the seam is in the right place.

26c. **Claude Code A2A bridge** — SHIPPED 2026-08-31,
    `src/a2a/claudeCode.ts` (`ClaudeCodeA2A`), the plan's step 1. The CLI is
    spawned through `Sandbox.execStream` inside a workspace and presented as a
    `RemoteAgent`, so `AgentA2A.tool` makes it a tool with no new concept —
    the payoff the plan names. `stream-json` is parsed permissively (unknown
    event types ignored, non-JSON lines ignored: the CLI writes warnings to the
    same stream); the A2A context maps to the CLI session id and a second
    message `--resume`s it; a run ending without a `result` is *cancelled*,
    never completed; `cancel(id)` stops a run for a caller who holds a task id
    and no fiber, and waits for it to actually settle. `Bridge.delegate`
    narrows `send`'s `Message | Task` to `Task`, since this peer never replies
    with a bare message. Tested against a scripted provider — no `claude`
    binary in CI, which is the same property that lets it run against a remote
    sandbox unchanged.

26d. **Claude Code permission bridge** — SHIPPED 2026-09-01,
    `src/a2a/claudeCodePermissions.ts`, the plan's step 2 and the boundary 26c
    left open. `--permission-prompt-tool` routes the CLI's prompts to a one-tool
    MCP server whose answer is `Permission.Policy` plus `Elicitation`. The
    default projection maps the CLI's tools onto `/coding`'s own `read` /
    `write` / `shell` actions, so one rule set governs both runtimes — that is
    the whole claim, and `test/ClaudeCodePermissions.test.ts` pins the action
    strings because the claim is false if they drift. An `Ask` raises a
    `tool-approval` elicitation of the same `kind` the harness raises, and
    "allow always" reaches `policy.remember`. Fails closed: no elicitor means an
    `Ask` is a denial, a request naming no tool is denied before the policy is
    consulted, and `--strict-mcp-config` is on by default so the delegated run's
    tool surface does not depend on the host. `decide` is exported because it is
    the whole behaviour and needs no server to test; `tool` is exported so the
    wire contract (snake_case *and* camelCase in, a JSON *object* out) is
    pinned directly.

    Known and deliberate: the policy sees `messages: []`, because the delegated
    agent's transcript is its own — a policy that needs the conversation to
    decide cannot be used here, which is better than one deciding on a
    transcript that is not the real one. And the endpoint is an authority:
    anything that can reach it can be asked to approve a call, so it belongs on
    loopback. A per-run bearer token would be the next hardening step.

    Still open from the plan: **step 3**, the OpenCode bridge over
    `opencode serve`'s HTTP API (independent of both: it needs no subprocess
    seam and has native permission endpoints), and steps 5-7 (relay transport,
    then the `LanguageModel` adapter experiment).

26. **`plan-relay.txt`, `effect-plan-2.txt`, and the rest of
    `plan-a2a-layers-bridges.txt`** — relay transport, `SessionInbox` /
    `ProcessManager`, and the bridge steps listed under 26c.
    `plan-deployment.md` §6.3 narrows when the relay is the right tool.

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
