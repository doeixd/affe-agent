# Remaining work

Rewritten 2026-08-29 from an audit of every plan in `/docs` against what ships
at `b554458` (four read-only passes: kernel/durability plans, transport/server
plans, tools/toolkit plans, and the progress files themselves). This is the
live list; `STATUS.md` is what is true now, `docs/status-history.md` the
chronology, and `ROADMAP.md` the capability view.

State of play, re-measured 2026-09-03: every issue through #80 is closed, #4
(the roadmap tracker) last, on 2026-08-30. `npm test` is green at **2071 tests
in 189 files** (1820 in 168 on 2026-09-01; 1466 in 131 when this was written),
zero Effect diagnostics, portability and the workerd bundle pass, and
`npm run verify:durability` shows D1–D7 biting (D4b survives by construction).

Two things that number hides, both worth knowing before trusting a red run:

- ~~The suite is flaky under process pressure on Windows.~~ **Diagnosed
  2026-09-01: the suite assumes it owns the machine.** Nine consecutive solo
  runs passed; two run concurrently both failed (6 and 8 files, one losing two
  files entirely to a worker that died before reporting). `0xC0000142` is
  machine-global handle exhaustion, and `CLAUDE.md` says other agents work here
  at the same time, so two concurrent runs are normal rather than misuse.
  `vitest.config.ts` caps `maxWorkers` at 8: about 29% slower solo, and two
  concurrent suites drop to one failure each. Eleven files spawn real processes
  (~247 tests), not the four previously named. Two residual load-sensitive
  tests were **not** fixed by this and wanted their own entries.
  `DurableStreams`' "linear, not quadratic" is **fixed 2026-09-03**
  (`ffd8b69`): it folded one log and asserted a wall-clock threshold, which is
  a claim about the machine rather than the algorithm, and it now folds n and
  2n and compares them, because load is exactly what a ratio cancels. The
  bound and the size are both measured -- at half the size the same regression
  hides inside a fold dominated by parsing, which an earlier draft discovered
  by passing with the bug restored. `ClusterMultiNode` remains, and **the fix recorded for
  it does not work.** H7 said move it to `TestClock`; it cannot go. It drives
  a real two-node cluster -- HTTP runners, liveness pings, shared SQL storage
  -- and the durable suites already run `it.live` because the engine's timers
  do not advance under a test clock. Nor is it sleeping on fixed durations:
  it already polls on conditions every 10ms, which is the pattern one would
  migrate *to*.

  Its load sensitivity is inherent rather than a defect. The cluster's windows
  are real timeouts, so a node starved for longer than `shardLockExpiration`
  genuinely loses its shards and the scenario under test becomes a different
  one. The honest options are to widen those windows in the fixture, trading
  duration for headroom, or to accept that this one wants a quiet machine.
  Neither is `TestClock`, and nobody should spend a session discovering that
  again.
- ~~The count includes work that is not committed.~~ No longer true as of
  2026-09-01: item 27's working-tree changes were committed as `be75b83`.

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
    `examples/deploy-cloudflare/` holds the Alchemy stack and, since
    2026-09-02, a `wrangler.jsonc` that mirrors it. **Deployed for real
    2026-09-02** (`worker-without-code-mode.ts` as `affe-agent-free`, from
    a Workers free plan; the HTTPS smoke matched the miniflare test). Left:
    the code tool needs Dynamic Workers, which is paid-plan only (error
    10195), so `apps/worker` as checked in deploys once the account is
    upgraded; a real model still wants a provider key in a Worker secret;
    Rivet.
    `Sandbox.fromExec` / `fromOperations` landed 2026-08-30 (a remote
    sandbox for the Worker is now one exec function away); a real remote
    provider (E2B/Daytona) still needs an account. The two upstream findings
    are filed in `docs/upstream/` (`effect-workflow-on-workerd.md`,
    `effect-sqlite-do-nested-migration-tx.md`). `plan-deployment.md`'s status
    line, §7, §9 and §10 were corrected 2026-09-01 — they still described the
    worker as unbuilt, which was the reverse of the truth. **D1 and the
    DO-storage `NodeStore` (that plan's §7 item 2) were never built and are
    not blocking anything**; DO SQLite covered history and the delivery log.
20. **Presets, `ref-declarative`, batteries** (`plan-primitives.md` steps
    4–6). Step 3 landed 2026-08-31: `examples/ref-gateway.ts` is the
    integration axis' acceptance test, runs in CI, and found nothing
    missing (findings in `STATUS.md`). Step 2 completed the same day with
    the credentials plan, and step 6's code-mode battery is `/code`. Step 4 landed
    2026-08-31: `affe-agent/presets` (`Presets.coding`,
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
25. ~~**Per-principal credentials**~~ — **CLOSED 2026-09-04, as already
    done.** Its own note asked whoever touched it to merge it with item 6,
    which is what this is. Item 6 records `plan-tool-credentials.md` as
    complete, and the code agrees: `Credentials.Bindings` selects by
    `(integration, subject)` with the user binding winning over the org one,
    `resolveFor` reads `CurrentPrincipal`, `methodFromOpenApi` derives methods
    from `securitySchemes`, and `withReauth` turns a `reauthRequired` failure
    into an elicitation and retries exactly once --
    `test/CredentialsReauth.test.ts` pins the five cases that matter,
    including that a misconfiguration is never turned into a question and
    that a reconnect which did not help fails rather than asking forever.

    The tail below said all four of those were "still queued". They were
    already built when it was written; the entry was never updated. It is
    left in place, struck through, because the misdirection is the point: a
    ranked list that says the top item is open when it shipped costs whoever
    reads it a session. *(Original text follows.)*

    (`plan-tool-credentials.md` §6) — the
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

26e. **OpenCode A2A bridge** — SHIPPED 2026-09-01, `src/a2a/openCode.ts`, the
    plan's step 3, and done the way the plan insists: over `opencode serve`'s
    HTTP API, not by parsing `opencode run`'s terminal. Sessions, the event bus
    and native permission requests all come with it. An A2A context maps to a
    server session; `permission.asked` frames are answered by the *same*
    `Permission.Policy` the Claude Code bridge uses -- the decision now lives
    once in `internal/delegatedPermission.ts` and each bridge encodes it, which
    is the part you do not want two diverging copies of. OpenCode's reply has a
    third value, `always`, so "allow always" reaches the delegated runtime as
    well as our policy; Claude Code's prompt tool cannot express that half.

    It needed **none** of `Sandbox.execStream` (26a) -- the seam the other
    bridge required does not appear here at all, which is the evidence that
    seam was put in the right place rather than everywhere. Tested against a
    stubbed `HttpClient`, including a permission answered while the prompt is
    still in flight, which is the ordering a real run has.

    Open questions, recorded rather than guessed: the permission-name table
    (`bash`/`edit`/`read`/`webfetch`) and the metadata field names were read
    from OpenCode's published OpenAPI document, not from a live server, so the
    projection is best-effort and overridable. `cancel` goes through
    `/session/{id}/abort` because there is no process to kill -- the run lives
    in the server, and interrupting the fibre here would leave it running.

26f. **`examples/ref-delegation.ts`** — SHIPPED 2026-09-01, the fourth
    reference example and the first place the bridges are used the way a *user*
    would: published entry points only, no casts, `npm run smoke:ref-delegation`
    in `check`. It asserts the two claims rather than describing them -- a
    bridged CLI and a bridged HTTP server are both ordinary tools of one
    manager, and one rule set written in `/coding`'s vocabulary governs both
    (an `edit` asked on OpenCode's bus becomes an elicitation and comes back as
    `always`; `git push` is refused in Claude Code's dialect). Compile-time
    assertions pin that both bridges narrow `send`'s union to `Task` and that
    either is accepted where a peer is wanted.

    Still open from the plan: steps 5-7 -- relay transport (both bridges over
    `plan-relay.txt`, at which point local vs remote is transport selection),
    then the `LanguageModel` adapter experiment, which the plan itself ranks
    last and least natural.

26g. **Both bridges run live** — 2026-09-01, against Claude Code 2.1.252 and
    OpenCode 1.18.23 on this machine. Delegation, the result artifact, session
    capture, resumption of the same conversation by a second message, and the
    streaming payload sequence all hold against the real runtimes. It found
    four things no stub could have, which is the argument for having done it:

    - **`bare: true` was the wrong default, and broke every run.** Bare mode
      never reads OAuth credentials, so against a subscription login the CLI
      answered `Not logged in - Please run /login` and the bridge dutifully
      reported a FAILED task carrying that text. (Two things did work exactly
      as designed there: the failure was FAILED and not COMPLETED, and the
      reason survived into the artifact.) Now off unless asked for.
    - **OpenCode could not talk to a secured server.** `opencode serve` warns
      `OPENCODE_SERVER_PASSWORD is not set; server is unsecured`, so it has an
      authenticated mode and `Options` had no way to reach it. `headers` now
      rides on every request, the event subscription included.
    - **The caller's own prompt came back as the agent's progress.** A real bus
      echoes the message it was sent as a text part, so `stream()` reported the
      question as the first thing the agent said. The bridge now mints the user
      message id (`messageID` on the prompt) and ignores parts carrying it.
    - **The permissive parsers earned their keep.** Claude Code emits a
      `rate_limit_event` this bridge has never heard of, and reports
      `subtype: "success"` *with* `is_error: true` on an auth failure -- both
      handled, the first by ignoring unknown types and the second by the `||`
      in the failure check rather than by luck.

26h. **OpenCode's permission loop, proven live** — 2026-09-01. The gap 26g
    left open is closed on the OpenCode side. A server started with a config
    that gates writes (`permission: { edit: "ask", bash: "ask" }` in the
    workspace's `opencode.json` -- the session-create `permission` ruleset did
    *not* have this effect, which is worth knowing) emits `permission.asked`,
    and the whole loop runs:

    - **Denied**: the policy saw `action=shell resource="pwd"`, answered
      `Deny`, the bridge replied `reject`, and the file the agent had been
      asked to create was never written.
    - **Allowed**: the policy saw `action=write resource="...\denied.txt"`,
      answered `Allow`, the bridge replied `once`, and the file was created
      with the expected contents.

    So the projection, the reply endpoint and the reply values are observed,
    not assumed. The captured frame is now a fixture in
    `test/OpenCodeA2A.test.ts` -- it caught one thing the schema had wrong:
    the metadata key is `filepath`, lowercase, where the guess was `filePath`
    (both are accepted now). `patterns[0]` on Windows arrives with the drive
    letter stripped; it is still the right resource, because it is what an
    `always` reply remembers.

    One observation, not yet a claim: prompting a second time into a context
    whose previous run had a *denied* permission came back with an empty
    answer. A fresh context behaved correctly. That may be OpenCode session
    state rather than anything here, and it is not reproduced in a test.

26j. **Claude Code's permission tool, proven live** — 2026-09-01, against CLI
    2.1.252. An MCP server standing on loopback, a real `claude -p` pointed at
    it by `ClaudeCodePermissions.args`, and both directions hold: **deny** put
    our own reason (`this workspace is read-only`) in the `tool_result`, Claude
    explained the block in those terms, and the file was never created;
    **allow** let the write through and the file exists. The projection was
    right first time (`tool=Write action=write resource=<path>`).

    Everything else about it was wrong, and only the real CLI could say so.
    `McpServer.registerToolkit` attaches `structuredContent` and declares an
    `outputSchema` whenever the success value is an object, and the CLI refuses
    such a result outright -- *Expected a single text block param with
    type="text" and a string text value*. The module as shipped could never
    have worked.

    Worse than not working: the run was blocked **by that error**, so from the
    outside it looked exactly like the gate doing its job. The first live run
    "passed" that way, and what gave it away was Claude's own account of it --
    "not by a denial, but by an error in the permission-checking layer itself".
    A test that only asserted "the write did not happen" would have agreed with
    the bug. The regression test therefore asserts the *envelope*: one text
    block, no `structuredContent`, no `outputSchema`, through a real MCP client.

    Also changed on the strength of it: a request that cannot be decoded is
    answered with a denial rather than a failed tool call, because a broken
    permission layer and a refusal must not look alike to whoever is watching.

    The request payload's casing is still the hedged part -- the live runs only
    exercised whatever this CLI version sends, and both spellings decode.

26i. **OpenCode v2** — SHIPPED 2026-09-01, `OpenCodeA2A.remote({ api: "v2" })`.
    Verified live against a `dev` server: two delegations in one context
    returned their own answers (`V2 BRIDGE OK`, then `SECOND V2 OK`), the
    session was reused, and a provider outage came back as a FAILED task
    carrying the provider's own message.

    It is a second client, not a rename, and the run loop is the reason:

    | | v1 | v2 |
    | --- | --- | --- |
    | prompt | `POST /session/{id}/message` → the finished message | `POST /api/session/{id}/prompt` → `SessionInputAdmitted` |
    | completion | the prompt returning | see below |
    | permission event | `permission.asked` `{ permission, patterns }` | `permission.v2.asked` `{ action, resources }` |
    | reply | `/session/{id}/permissions/{id}` `{ response }` | `/api/session/{id}/permission/{id}/reply` `{ reply, message? }` |
    | cancel | `/session/{id}/abort` | `/api/session/{id}/interrupt` |
    | envelope | `properties` | `data` |

    Three things only a live run could have established, each of which the
    first design got wrong:

    - **`POST /wait` does not work.** It is documented as "wait for a session
      agent loop to become idle" and answers
      `503 "Session wait is not available yet"` on every build that serves v2.
      Completion is read from the message projection instead
      (`GET /api/session/{id}/message`, `time.completed`), which is not a
      substitute but an improvement: a fact about the finished message rather
      than a race with the bus.
    - **The answer must be newer than the prompt.** The projection is a
      conversation, so the newest completed assistant message is the *previous*
      run's until this one finishes. The admission's `timeCreated` is the floor;
      without it a second delegation returned the first one's answer.
    - **A non-2xx answer was being read as a result.** The 503 above decoded as
      ordinary JSON and the bridge called the run finished, completing tasks
      with an empty answer. The client now filters on status — a v1 fix too.

    v2 is the better protocol to be on once it is released: its `action` is
    already this repository's vocabulary, and its permission reply carries a
    `message`, so a policy's *reason* reaches the delegated agent — v1 has no
    field for that. Default stays `v1`, because that is what a released server
    answers: 1.18.23 and `beta` expose `/api/...` and fail it
    (`no such table: session_input`); only `dev` serves it.

    Not verified: `permission.v2.asked` end to end. The frame is decoded and
    normalised into v1's shape (so one projection serves both, and a policy
    cannot tell which protocol answered it), and that normalisation is tested —
    but no live v2 run has asked for permission, because the free provider on
    the `dev` build 503s on tool-using runs. The v1 permission loop *is*
    verified live (26h), and the two share their decision.

26. **`plan-relay.txt`, `effect-plan-2.txt`, and the rest of
    `plan-a2a-layers-bridges.txt`** — relay transport, `SessionInbox` /
    `ProcessManager`, and the bridge steps listed under 26c.
    `plan-deployment.md` §6.3 narrows when the relay is the right tool.

    **Split out 2026-09-01.** This entry was one line covering six unbuilt
    pieces, which is why the oldest unimplemented work in the repository
    (`effect-plan-2.txt`, first committed 2026-08-25) was also the least
    visible: nothing here said that half of it needs no relay and lands in a
    sitting. The pieces are 26k–26p below. This line stays as the umbrella;
    the ranking is in the children.

26k. ~~**`SessionProjection`**~~ (`effect-plan-2.txt` §27) — SHIPPED
    2026-09-01, `src/sessions/SessionProjection.ts`, entry point `./sessions`.
    A session's events folded into what is true now: lifecycle, submission /
    run / turn counts, accumulated `ModelUsage`, tool outcomes, open tool calls
    and unanswered elicitations, last failure. Pure `(state, envelope) =>
    state`, so it runs over a live `Stream`, over `DeliveryLog.read({ after })`
    or over an array and cannot tell the difference — which is what makes
    repair a re-fold rather than a second code path, the claim §27 makes and
    `test/SessionProjection.test.ts` asserts by reproducing a whole projection
    from a lossy one, field for field.

    Three decisions the plan left open, decided here and written down because
    each could reasonably have gone the other way:

    - **A gapped event is applied, not dropped.** Freezing at the
      discontinuity would blank a live view permanently on one lost SSE frame.
      The counters become lower bounds and `gap` says so.
    - **Only the earliest gap is retained**, with a count. Not a memory
      compromise — repair reads after it, so every later gap is inside that
      read. Keeping ranges would grow unbounded and buy nothing.
    - **`empty` vs `since`.** Joining a live tail mid-conversation is not a
      gap; continuing from a known cursor makes the same envelope a gap.
    - **Repair is a re-fold of the whole log, not a resume at `gap.after`** —
      forced by the first decision. Once gapped events are in the
      accumulators the state cannot be corrected in place, and a fresh state
      begun at the cursor has never seen what came before it. So `gap.after`
      is diagnostic. The post-commit review caught this: the original test
      compared a cursor-resumed projection against a whole one on a
      *hand-picked subset* of fields and passed, while `started` was false
      where the whole fold had it true.

    Seven deliberate breaks were run against the suite. One of them —
    clearing the cursor on an unknown event instead of advancing it — **passed
    the test that claimed to cover it**, because a trailing known event
    re-baselines the cursor and `isComplete` stayed true. That is now its own
    case asserting the cursor while the unknown event is the most recent one.
    Worth recording: the bug was invisible to the obvious assertion.

26l. ~~**`SessionDirectory`**~~ (`effect-plan-2.txt` §26) — **SHIPPED 2026-09-02**
    (`src/sessions/SessionDirectory.ts`, memory + SQL behind one interface,
    `SessionDirectoryConformance` in `/testing`, `follow` over `hostEvents`;
    see `status-history.md`). Was: the management/query
    model over sessions: `get` / `list` / `active` / `stats` / `rename` /
    `move` / `annotate`, paginated from day one. Needs a backing store, which
    is why it did not land with 26k; 26k is the reducer it would keep per
    session to answer `stats`. Explicitly **not** `DurableSessionStore` (that
    is execution correctness, and the plan says do not merge them), not
    `/tree` (a conversation DAG) and not `AgentSessionHost.size` (a live count
    in one process).

26m. ~~**`SessionInbox`**~~ — **SHIPPED 2026-09-02** (`bc65708`), once
    `ProcessManager` (26n) existed to be its producer. `src/sessions/SessionInbox.ts`
    over `PersistedQueue`: `enqueue` idempotent on the item's id, `deliver`
    starting a *new* submission on an idle session, `run` looping.
    The design correction the tests forced is worth carrying forward: a
    first draft polled for an idle session inside the delivery, which
    duplicated `PersistedQueue.take`'s own retry and held a queue slot doing
    nothing. A busy session now fails its attempt immediately and the queue
    schedules the next; `maxAttempts` is the wait. Boundary stated in the
    module: an item carries a prompt, so a typed-input agent cannot be fed
    from here until item 46. Original scope: *(2026-09-01): blocked on having a **producer**,
    not on plumbing. `session.submit(input, { requestId })` already provides the
    idempotent admission this was meant to add (item 4, landed 2026-08-29), so
    the queue is composition sugar over a shipped API. Its named producers --
    `ProcessManager` (26n) and durable monitors (§16) -- are both unbuilt, so
    building it now would ship a queue with nothing to enqueue. Do not start it
    expecting a quick win; build a producer first.* (`effect-plan-2.txt` §1–5) —
    a durable queue wrapper
    over `PersistedQueue` that accepts a background completion
    (`process:id:exit`, `monitor:id:complete`), waits for the target session to
    be idle, and starts a **new** submission on it idempotently. The plan calls
    this more important than `ProcessManager` and it is the one piece of
    §1–14 that needs neither processes nor relay. Phase 0 is closed: keep
    `/scheduling`'s `JobStore` for due-time dispatch, use `PersistedQueue` for
    immediate durable handoff (`evaluation-persisted-queue-job-store.md`).
    Note `/scheduling`'s `AgentDispatcher` is *not* this — it starts
    independent work rather than resuming a conversation.

26n-a. ~~**`WorkspaceManager`**~~ (`effect-plan-2.txt` §12–13) — SHIPPED
    2026-09-01, `src/sandbox/WorkspaceManager.ts`, exported from `/sandbox`.
    A workspace is now a keyed, reference-counted resource over `LayerMap`:
    built on first request, shared by every holder, released once the last one
    goes *and* stays gone for `idleTimeToLive` (30s default). The idle window
    is the load-bearing part -- reference counting alone drops to zero the
    instant the first holder releases, so without it two consecutive tool calls
    in one conversation would get two different workspaces, which is §12's bug
    rather than a detail of it.

    Not a new `/workspace` entry point, though the plan proposes one:
    `Workspace` is already defined in `Sandbox.ts` and this manages sandbox
    acquisitions, so an entry point would be ceremony for one module. It earns
    one when `ProcessManager` joins it.

    `Presets.coding` takes an optional `workspaces` manager. **Opt-in, not the
    default**, because it changes a lifetime: a caller relying on a private
    throwaway directory per agent should not have that quietly become a shared
    one that outlives them.

    Five mutations fail the suite. Deliberately *not* built: anything that owns
    a process. §13 is right that a process is managed precisely because it
    outlives its handles, so reference counting would kill it on last drop --
    workspaces get `LayerMap`, processes will get `FiberMap` and a store.

26n. ~~**`ProcessManager`**~~ — **SHIPPED 2026-09-02** (`fb0c73b`), with the
    sandbox bug it exposed fixed in `6dc6d57`. Original scope
    (`effect-plan-2.txt` §8–11) —
    process identity and lifetime over Effect's own spawner (`ProcessId`,
    `ManagedProcess`, `FiberMap` supervision, `events`), plus workspace
    lifetime once processes outlive the tool call that started them. Blocked
    on §11's spike by the plan's own ordering. `Sandbox.exec` is a bounded
    command, not a managed background process, and the plan is emphatic that
    `ProcessManager` must not know `AgentSession` exists.

26o. ~~**Host-wide `AgentSessionHost.events`**~~ (`effect-plan-2.txt` §29) —
    SHIPPED 2026-09-01. `host.hostEvents(principal)` is one stream carrying
    `HostAttached` (the inventory, once), `SessionHosted`, `SessionEvent` and
    `SessionUnhosted`, with `pumps` exposing the live forwarder count so a leak
    can be named. `examples/host-events.ts` folds it into per-session
    `SessionProjection`s -- 26k's consumer, and its `foreign` counter is
    asserted there.

    Five decisions departed from the section's literal text, each because the
    code said so:

    - **No host-wide sequence, so no outer envelope.** Such a number records
      which pump fibre the scheduler ran first; making it mean even delivery
      order needs a host-wide permit on every event, which is the per-session
      bus's bottleneck one level up. Loss detection, the only thing it buys,
      `SessionProjection.gap` already gives at finer grain.
    - **`FiberMap` mirrors the pumps rather than owning them.** `FiberMap.make`
      binds to the *host's* scope, so an owned pump would outlive its session
      unless someone remembered to remove it -- the leak §29 exists to prevent.
      The session's child scope already tears it down; the map is there because
      its auto-removal makes `size` mean *live*, which `sessions.size` cannot.
    - **`SessionHosted` publishes before the pump is forked.** The first design
      gated forwarding on a `Deferred` opened afterwards and deadlocked: exit
      finalizers run uninterruptibly, so a stream ending inside that window
      waited on a gate nobody would open. Ordering the publish first gives the
      same guarantee with nothing that can block.
    - **`SessionUnhosted` comes from the pump's own exit, and its `reason` from
      whoever removed the session.** A closing subscription reaches the pump as
      a `Cause.Done` *defect*, indistinguishable in shape from a transport
      dying, so classifying from the cause reported `failed` for every ordinary
      close. Sessions now hang off a host-owned scope, because forked from the
      ambient one they closed before `releaseAll` could mark them and every
      shutdown looked like a session ending on its own.
    - **No `observedClose` flag.** One was written and deleted: closing a
      session shuts its subscription rather than delivering `SessionClosed` to
      an attached subscriber, so it was false even for a session closed through
      that host. A field that is always false reads like evidence.

    Deliberately not built: a host-wide tail or `after` cursor (a cursor into a
    nondeterministic merge is not a cursor -- `eventLog` stays the finite read,
    per session); a transport surface, which is `plan-agent-server.md`'s later
    step and needs a per-connection bound; and any `ServerEvent` merge helper in
    `src/`, which §30 says is the application's.

    **The day it took, recorded because the lesson is the point.** The module
    was written quickly and then held back for hours, because one of its
    passing tests was wrong and the bug it hid was the module's central
    claim.

    `terminate` interrupts the output pump and then records
    `{ _tag: "Terminated" }` unconditionally, on the stated assumption that
    "interrupting the pump interrupts `execStream`, and the sandbox ends the
    tree" (`ProcessManager.ts:355`). **On Windows the tree is not ended.**
    Measured, not inferred: the test's child runs
    `setTimeout(() => {}, 30000)` and the test takes 30.4s; change that sleep
    to 8000 and the test takes 8.8s. The duration tracks the child's *natural
    lifetime*, so nothing is killing it -- the run only finishes when the
    child exits by itself and finally releases the workspace directory the
    outer `fs.rm` is retrying against.

    The test passed throughout because it asserted the manager's own
    bookkeeping (`status` is `Terminated`, which `finish` set regardless) and
    because its stopwatch stopped *before* the teardown that did the waiting.
    A test green while the behaviour it names is false is the case `CLAUDE.md`
    singles out.

    **Diagnosed 2026-09-02, and it is not `ProcessManager`'s bug.** Chased to
    the bottom, in this order. A corrected assertion first: once the manager
    has closed, removing the workspace with `maxRetries: 0` must succeed,
    because Windows will not delete a directory that a live process holds as
    its cwd. That fails in 4s with the process still holding it. Two weaker
    assertions were tried and rejected on the way -- the reported status, and
    a file the child writes later, which the workspace's own one-second idle
    cleanup deletes before it can be read, so it passes vacuously.

    A twelve-line probe then took `ProcessManager` out of the picture
    entirely: fork a fibre running `Stream.runForEach` over
    `sandbox.execStream`, interrupt it, and the child still holds the
    directory. **So interrupting an `execStream` reader does not end the tree,
    and that is true for every caller of the sandbox, not just this module.**
    Note the contrast with `Sandbox.test.ts`'s "stopping ends it", which
    passes: a stream that *completes* (`Stream.take(1)`) does kill the tree.
    Completion is tested; interruption was not.

    Instrumenting `local.ts` shows the release is not the problem and neither
    is the manager: on interruption the release does run, does see a live
    child, and does call `killTree` with a valid pid (twice -- `SIGTERM`, then
    the 1s `SIGKILL`). The Windows branch of `killTree` spawns
    `taskkill /pid <n> /T /F` **asynchronously and never waits for it**, and
    the release then resumes on its own 2.5s deadline. Measured directly
    outside Effect on this machine, that `taskkill` returns status 1 with
    "This operation returned because the timeout period expired" and the child
    dies only some hundreds of milliseconds later -- so the 2.5s window is not
    reliably enough, the scope closes with the tree alive, and the workspace
    stays held until the child ends on its own.

    **The fix is in `src/sandbox/local.ts`. Two forms of it are already
    eliminated, and the third finding changes what the fix has to be.**

    - Making the Windows kill `spawnSync` hangs the release outright
      (measured: 62s against a 60s timeout).
    - Having the release *poll* `process.kill(pid, 0)` until the process is
      really gone, instead of trusting the exit event and a fixed deadline,
      does not help either -- because the process never dies at all.
    - **`spawn("taskkill", ...)` does not run in this environment.** Reduced
      to twenty lines with no Effect and no vitest: async-spawn `taskkill
      /pid <n> /T /F` against a live `node -e setTimeout` child and it emits
      **neither `exit` nor `error`**, and the child is still alive seconds
      later. Four option sets were tried -- `stdio:"ignore"` with
      `windowsHide`, each alone, and plain defaults -- with identical
      results. `spawnSync` with the same arguments *does* run it, returning
      status 1 and "This operation returned because the timeout period
      expired" while the child dies a few hundred milliseconds afterwards.

    So the tree-kill's Windows branch is firing into the void: no signal
    reaches the child, which is why every deadline and every poll above only
    changed how long we waited to observe the same live process. Before
    writing a fix, settle whether that async-spawn failure is a property of
    this machine (it is under heavy process pressure -- `vitest.config.ts`
    already documents Windows handle exhaustion here, `0xC0000142`, from
    concurrent runs) or of Windows generally, because the answer decides
    whether the fix is a more reliable kill or a retry-and-verify loop around
    an unreliable one. Reproduce on an idle machine first. Nothing is
    committed from this attempt: `src/sandbox/local.ts` is untouched at
    `HEAD`, and `ProcessManager` with its corrected test waits in the working
    tree.

26p. ~~**Relay transport**~~ (`plan-relay.txt`) — **landed 2026-09-03.**
    `src/relay/` is the whole slice: `Relay.ts` (the vocabulary — `PeerId`,
    `EndpointId`, `ChannelId`, `Envelope`, the errors), `RelayProtocol.ts`
    (the public protocol as an `RpcGroup`, so the relay invents no framing of
    its own), `RelayServer.ts` (the route table, the directory, bearer
    credentials, coarse authorization), `RelayClient.ts` (a node's one
    `listen` stream and its dispatch) and `RelayRpc.ts` (Effect RPC in both
    directions over it). `AgentRpc` runs across it unchanged, which is the
    claim `test/Relay.test.ts` makes: calls, a streamed response, the
    directory, supersession, a refused credential, and — the one that matters
    for the design — a forged `PEER_HEADER` losing to the relay's own stamp,
    so reaching a target through the relay never bypasses its authorization.

    **Both bugs the last two passes named are closed, and they were not the
    same kind of thing.**

    The dropped `Exit` was real, and the fix is in `clientProtocol`'s
    finalizer. A caller that interrupts a streaming request waits for the far
    end's `Exit`; the relay does route it; but by then the scope has
    unsubscribed, so `RelayClient.dispatch` finds no handler and discards the
    envelope. The hang was therefore uninterruptible — an outer timeout fires,
    interrupts the request, and waits forever on an acknowledgement that was
    thrown away. A transport being torn down cannot promise a remote
    acknowledgement, so it no longer makes its own shutdown depend on one: it
    fails every outstanding request as interrupted first, which is the truth,
    and only then sends `Eof`.

    The missing `Chunk` was not a transport fault at all. `events` without
    `after` is a **live tail**, so a subscription taken after the prompt has
    already completed waits for events that have gone by — correctly, and
    forever. The socket suite's equivalent passes because of its ordering, not
    because of its transport. The test now subscribes before it prompts and
    asserts what a tail taken at that moment actually sees, and it is `it.live`
    rather than `it.effect` because real sockets and real sleeps need a clock
    someone advances. The suspicion recorded at the end of the last pass — that
    the expectation was wrong rather than the transport — was the right one.

    Still open, and none of it blocks the bridges: the durable mailbox over
    `PersistedQueue` (a peer that is offline now gets `RelayPeerOfflineError`,
    which is honest but not durable), reconnection (`status` goes `offline`
    for good and says why), lease-based heartbeat expiry, and enrollment
    beyond the fixed token map. `plan-a2a-layers-bridges.txt` steps 5–7 are
    unblocked.

49. **Event resumption is a contract row** — **SHIPPED 2026-09-03**
    (`5111fbb`). Recorded because it is the third gap this pass found by
    asking what the seam *says* it owes rather than what an implementation
    happens to do. `AgentClient.events`'s own comment forbids quietly
    returning a live stream to a caller who asked to resume — a lost-events
    bug with no symptom — and nineteen rows never passed a cursor.
    `resumesEvents` picks which of two rows applies and neither is a skip, so
    a client that can resume but forgets the flag fails the refusal row.
    Bounded, because the first version reported a runner timeout where the
    answer was "the cursor was ignored".

    The pattern worth reusing: read an interface's emphatic sentences and ask
    which of them a suite would notice being broken.

### Newly ranked — from the effect-cf research (2026-09-01)

Full reasoning in [plan-effect-cf-and-webtransport.md](./plan-effect-cf-and-webtransport.md).
Split out because one of these is a defect and the rest are options.

31. ~~**Extend the portability guardrail's host-package pattern**~~ (that
    plan's C1) — **landed 2026-09-01.** `hostPackages` now also rejects
    `effect-cf`, `@cloudflare/*`, `@effect/sql-sqlite-do`, and the `bun:` /
    `deno` specifiers, each proved to fire by a probe import and each checked
    not to flag `effect`, `@effect/platform` or `@effect/ai-anthropic`. It
    changed no current result, which was the argument for doing it then. What
    follows is the entry as it stood.
    `verify-portability.mjs` rejects host packages by a hardcoded allowlist of
    known-bad (`platform-node|…|sql-d1|sql-libsql`), so it does **not** catch
    `effect-cf`, `@cloudflare/*`, or `@effect/sql-sqlite-do` — the last being a
    concrete platform package `apps/worker` already uses. Anything in that set
    imported into `src/` today passes the check built to stop it. Verified
    2026-09-01 that none of them are in `src/`, so extending the pattern is
    safe and changes no current result — which is the argument for doing it
    while it is still a cheap edit rather than a debate. Break it once.

32. **Hibernatable WebSockets: read, then answer the question** (C2–C3). Our
    worker serves HTTP+SSE, and `plan-deployment.md` §11 already says a dropped
    connection on a hibernating DO is "the normal case, several times an hour".
    We answer with resumption over the `DeliveryLog`, which is correct and
    tested across the runtime's death — but Cloudflare's Hibernatable
    WebSockets API is a way to need that recovery path *less often*, and
    verified 2026-09-01 we use none of it (no hibernation handling anywhere in
    `src/` or `apps/`). `effect-cf` has `DurableObject.WebSocket` /
    `RpcWebSocket` as prior art. The question worth answering first is ours,
    not theirs: **does a hibernatable socket carrying `AgentRpc` preserve the
    resumption contract across eviction, or merely relocate the gap?** A
    miniflare test importing nothing new can settle it, and "it relocates the
    gap, the cursor is still the only honest thing" is a good result to record
    rather than a failed milestone.

33. **`AgentRpc` over WebTransport, as evidence** (W1–W2) — optional, ranked
    last on purpose. `effect-webtransport`'s `WebTransportSocket` returns
    Effect's own `Socket.Socket`, and our WebSocket RPC path is already
    `Socket` → `RpcClient.makeProtocolSocket()` (`test/AgentRpc.test.ts:681`),
    so the swap is one line and `src/` does not move. The value is *not*
    WebTransport — resumption is transport-independent by design, so a new
    socket type solves nothing we have. The value is that `transport.md` §3's
    "transport-agnostic by Effect's design" has only ever been demonstrated
    against transports we wired ourselves; a third-party `Socket` is the first
    independent test of it. **Cloudflare cannot serve WebTransport**
    ([workerd#6451](https://github.com/cloudflare/workerd/issues/6451): no
    QUIC/HTTP-3 stack, not on the roadmap), so this never touches the CF path,
    and the real cost is standing up a Node-side WebTransport server. Drop it
    if that exceeds a day.

34. **`effect-cf` as a source for `plan-deployment.md` §7 item 2** — it has
    `D1`, `Kv`, `Storage` and `Sqlite` modules, which is the shopping list for
    the store layers that plan asks for and item 19 records as never built.
    This does **not** change the ranking: those layers still block nothing.
    Recorded only so the next person to want them does not start from the
    Cloudflare docs.

### Newly ranked — from the effect-agent.com comparison (2026-09-01)

[plan-effect-agent-comparison.md](./plan-effect-agent-comparison.md) read
the other `effect-agent` (danieljvdm's, the `effect-cf` author's) against
what ships here and found a convergent turn model, a much broader surface on
our side, and six gaps worth closing. Its §2 carries the full ranking with
sizes; the items are repeated here so this list stays the one tracker.

36. ~~**Getting-started page, lineage note, platforms table**~~ — landed
    2026-09-01 (`docs/getting-started.md`, `docs/platforms.md`, README
    section, `test/GettingStarted.test.ts`). As planned:
    `docs/getting-started.md` over a typechecked `examples/getting-started.ts`
    that runs against the scripted model with no key; `docs/platforms.md`
    (Node, workerd, Bun as *untested*); a four-sentence README section on the
    relation to effect-agent.com. Cheapest item; no decision needed.
37. ~~**Run policy completeness**~~ — landed 2026-09-01; see
    `status-history.md`. As planned: `AgentLoop.State` gains
    `toolCallsTotal` and `elapsed`; `AgentLoop.maxToolCalls`, `maxDuration`
    and `limits({...})`; a third `Decision`, `Final`, that takes one tool-less
    turn (output tool only, for an agent with an `AgentOutput`) so a bounded
    run ends in an answer; `withFinalTurn(inner)`; an optional `stopReason` on
    `RunCompleted` and the result. Additive throughout. The first growth of
    the kernel vocabulary since `0.0.1`, and `STATUS.md` should say so when
    it lands.
38. ~~**Ship the contracts**~~ — landed 2026-09-01; see `status-history.md`.
    As planned: `AgentClientContract`,
    `DeliveryLogContract` and `NodeStoreContract` move from `test/` to
    `/testing` in `SandboxConformance`'s shape, plus a `DurableSessionStore`
    contract that does not yet exist as one; each with a deliberately wrong
    implementation that fails exactly the promise it breaks.
39. ~~**DO host: history at turn boundaries, alarms as an `AgentDispatcher`**~~
    — landed 2026-09-01; see `status-history.md`. As planned (§3.3 a–b): a lost runtime costs the turn in flight, not the run;
    `/scheduling`'s seam gets its Durable Object alarm implementation. Both
    in `apps/worker`, both proved on miniflare, neither needing an account.
40. ~~**Code mode threat model, stated**~~ — landed 2026-09-01: README
    "Code mode" section (since 2026-09-02 `docs/guide-code-mode.md`, after the README trim dropped it), `test/CodeModeThreatModel.test.ts` pins the
    citations. As planned: the interpreter
    confines by construction of the language and `Permission` is the
    authority boundary; neither is an isolate, and the doc says so, each
    confinement citing its test. The readonly recipe is a `Permission` rule
    set, shown rather than built.
41. ~~**Typed input**~~ — phase 1 landed 2026-09-01 (in-process:
    `AgentSession`, `Agent.run`, tools, permissions, transforms, the event);
    phase 2 landed 2026-09-02 (the wire form `AgentInput.Typed`, the host
    decode in every `RemoteSession`, `AgentClient.typed`, the durable
    client's claim and payload, an Effect-valued render as an activity);
    see `status-history.md`; the rest of the surfaces (issue #81:
    `Scheduling`, `Subagent`, `DurableAgent.workflow` and the cluster entity,
    the Cloudflare alarm dispatcher) followed the same day through one
    shared boundary, `internal/inputBoundary.ts`. As planned: `AgentInput.make(schema, render)` as the
    mirror of `AgentOutput`: the full value reaches tools as
    `AgentInput.Current`, the model sees the rendering, the host decodes JSON
    at the boundary, `/durable` journals the encoded value. One more type
    parameter on `Agent.make`. Wants a design pass before code.
42. ~~**`WebCapture` and `WebCrawl`**~~ — landed 2026-09-01; see
    `status-history.md`. The interactive browser stays parked behind 43. As
    planned: rendered pages and a bounded
    same-host crawl over a provider seam in `/web`, Cloudflare Browser
    Rendering's REST API as the first (portable) provider, doubles in
    `/testing`, every bound in the README table. The interactive browser is
    parked behind item 43.
43. ~~**A published Cloudflare host entry**~~ — landed 2026-09-01 as
    `affe-agent/cloudflare` on `effect-cf` (decision:
    `plan-effect-cf-and-webtransport.md` §3a; see `status-history.md`).
    **The real deployment (§3.3d) still needs an account** and is item 19's
    remaining half. As planned (plan §3.3 c–d) — after 39: `affe-agent/cloudflare` as a host module in
    `/sandbox/local`'s shape, with its own exemption in
    `verify-portability.mjs` and still no `effect-cf`. This is the category
    decision of `plan-effect-cf-and-webtransport.md` §3 applied to our own
    code and should be recorded there. Item 19's real-model deployment
    re-ranks behind it.
44. ~~**An isolate executor behind `CodeExecutor`**~~ — landed 2026-09-01
    as `IsolateExecutor` in `/cloudflare`; see `status-history.md`. As
    planned (§3.5, later) — a
    Dynamic Worker with `globalOutbound: null` per program, tool calls back
    over RPC; lives in item 43's entry and cannot precede it. No Node
    equivalent is pretended.
45. ~~**`examples/pr-review.ts`**~~ — landed 2026-09-01; see
    `status-history.md`. As planned: `Presets.coding` + an
    `AgentOutput` review schema + `Budget.within` + `Evals.tokens`, against
    the scripted model. A reference, not a package.

41b. ~~**Typed agents everywhere else**~~ — landed 2026-09-02 (issue #81
    closed; see `status-history.md`): every surface below now admits a typed
    agent through `src/internal/inputBoundary.ts`; `src/cloudflare/index.ts`
    got the two-line alarm change only, its `agent` signatures still pin
    `Input`. Was: after phase 2 (2026-09-02) the
    remaining surfaces whose signatures pin `Input` to `never`:
    `src/scheduling/Scheduling.ts` (three signatures, and its persisted
    `input: Prompt.RawInput` would need to carry the typed form),
    `src/subagent/Subagent.ts` (two), `DurableAgent.workflow` / `submit` and
    the cluster `EntityClient` / `ScheduledAgent` over it (the payload is a
    `Prompt`; wants the same optional `input` as `DurableSubmission.Payload`),
    and `src/cloudflare/index.ts` (two; it uses `fromSession`, so the runtime
    path already works once the signature widens). `Evals` already accepts
    them. Widening alone is mechanical; Scheduling and DurableAgent need the
    payload change to be useful rather than merely compile. About half a day.

46. **Every agent has an input; the prompt is the default**
    (`plan-input-default.md`, 2026-09-02). Removes the `Input = never` /
    `PromptInput<Input>` conditional that caused every awkwardness in 41
    and 41b: `AgentInput.prompt` as the default, one wire shape (the
    session's encoded input, byte-identical to today's prompt wire for an
    untyped agent), `AgentInput.Current` always set, and then the same for
    output (`AgentOutput.text` as the default `Value`, which finishes item
    35 as a consequence). A refactor across ~100 signatures, nearly all of
    which get shorter; sequenced after 26l/26n/26p land so it does not
    cross their edits. Acceptance and the six steps are in the plan.

47. **What to take from their Workflow RFC** (`plan-rfc-286-durable.md`,
    2026-09-02). A read of `danieljvdm/effect-agent#286` against `/durable`.
    Their headline goal — any `WorkflowEngine` as a `Layer` — is where
    `/durable` started, so most of the RFC is not a gap for us. Three items
    are, ranked in the plan's §2:
    - **47a. Retry safety declared on the tool.** The one real correctness
      gap. `DurableToolkit` wraps every handler as an `Activity`, and
      upstream's `Activity` retries an *interrupted* effect up to ten times
      (`retryOnInterrupt`, `Schedule.while(attempt <= 10 && hasInterrupts)`) —
      so a tool interrupted mid-request reissues it, which nothing in our code
      asked for. A tool should declare `retrySafe` where it already declares
      `needsApproval`, defaulting to today's behaviour; a non-retry-safe tool
      whose outcome is unresolved parks the submission the way an `Ask` does,
      using `DurableDeferred` machinery we already have. Ranked above most of
      what is left in this list.
    - **47b.** ~~**The resume-before-suspension race.**~~ **Answered
      2026-09-02: it does not reach us.** The race is real in the pinned
      engine, and the indirection saves us. Pinned by "an answer that arrives
      before the workflow suspends is not lost" in `test/Durable.test.ts`,
      which answers an elicitation immediately after launch, while the run is
      still in its first model call; broken once by deleting the answer, which
      parks the submission and reports exactly that. Original scope: verified
      present in the
      pinned engine: `ClusterWorkflowEngine.resume` returns silently when the
      execution has not yet recorded a `Suspended` reply
      (`ClusterWorkflowEngine.ts:273`). We never call it directly and reach it
      only through `DurableDeferred`, whose engine path looks more careful, so
      the answer may be "we are fine" — but that is worth *testing* rather
      than assuming. One test: answer an elicitation before the run awaits it.
    - **47c. Dispatch intents for the Durable Object host.** Persist an intent
      before launch, repair in bounded passes, delete only after checking the
      canonical settlement. It fits precisely where the engine cannot run
      (the measured workerd stall), and the DO alarm is already the durable
      trigger it needs. Host-local: `src/durable` does not change.

48. **Making the failure paths provable**
    ([plan-failure-paths.md](./plan-failure-paths.md), 2026-09-03). A read of
    their *source* rather than their RFC, plus the relay's own post-commit
    review. The finding is not a missing feature: their durable tests can
    crash a pass at a named point and ours cannot, so every "what if the
    process dies here" question in `/durable`, `/cluster` and `/relay` is
    currently answered by reading the code. This session is the example --
    the relay review found two real defects and the test written for them
    passes with the fix removed. Ranked in that plan's §2:
    - **48a. Retry safety on the tool** -- ~~open~~ **SHIPPED 2026-09-03**
      (`8c46e3a`). Read from `Tool.Idempotent` rather than a `retrySafe` field
      of our own: the annotation already means exactly this, is emitted as the
      MCP `idempotentHint`, and defaults to `false`, which is the safe default.
      An interrupted non-idempotent handler journals `Unresolved` as a
      *success* of the activity, which is what stops the reissue -- the cause
      the retry schedule inspects no longer has interrupts -- and also stops a
      replay from running it. Raised as `DurableToolUnresolvedError`.
      Deliberately a behaviour change for every existing agent. The window it
      does not close, stated in the code: a process that dies before the
      engine persists that entry leaves the call unjournalled. At-most-once
      for interruption, not for power loss.
    - **48b. Failpoints** -- ~~open~~ **SHIPPED 2026-09-03** (`de132b4`).
      `src/internal/failpoint.ts` is the seam, `src/testing/Failpoints.ts` the
      half a test provides. `DeliveryLog.append` is instrumented in both
      implementations with `before-commit` / `after-commit`, and the test that
      matters crashes the SQL log after the commit: the row is there once, the
      retry is a `Duplicate`, and the next event is 2 rather than 3, because a
      crash must not burn an offset. Removing the boundary makes it fail.
      Still to point it at, from this plan's §3.2: the model-call boundary in
      `DurableSubmission`, and the relay's teardown.
    - **48c. Never acknowledge on the engine's word** -- reconcile the
      engine's answer against canonical state before completing a waiter,
      and retain the intent on disagreement.
    - **48d. Cancellation belongs in `AgentClientConformance`** -- ~~open~~
      **SHIPPED 2026-09-03** (`351b1e4`), with two corrections to this plan.
      The row is about *interruption*, not teardown: an earlier draft closed
      the client's scope, which tests the harness rather than the client,
      because every harness builds its server or workflow engine into the
      same layer -- and for durable that hangs uninterruptibly on an in-flight
      activity, which is the engine behaving correctly. And it covers
      **three** implementations, not five: in-process, HTTP and durable. RPC
      and the relay do not run the contract, so **the row does not guard the
      relay, the implementation that had the bug**. Its evidence is instead a
      falsification in `ShippedConformance`, checked in both directions.
    - **48f. An `AgentClient` over Effect RPC** -- ~~open~~ **SHIPPED
      2026-09-03** (`3010a13`). `AgentRpc.agentClientFrom` /
      `agentClientLayer`. RPC and the relay now run the contract, so it
      covers five implementations rather than three, the relay's twenty rows
      crossing two nodes and a real WebSocket.

      Two findings on the way. The delta row stopped collecting when `prompt`
      returned -- an in-process assumption, since over a wire the deltas
      travel on a separate response -- so it now collects until
      `SubmissionCompleted`. With that fixed HTTP passes the row it had opted
      out of, so `observesStreamDeltas` is retired: its stated reason (SSE
      connect latency) was wrong, and streaming deltas over HTTP had simply
      never been tested.

      **And a correction.** Reverting `RelayRpc.clientProtocol`'s in-flight
      settling finalizer leaves all twenty rows green, and also leaves a
      targeted teardown test green -- checked with a unary prompt and with a
      streamed response open, which is the shape 26p's trace describes. That
      finalizer is therefore defensive code whose necessity is **unproven**,
      not the fix `2d65ccf` claimed it was. The likelier explanation is that
      the other half of that commit -- taking the `events` subscription
      before the prompt rather than after -- is what removed the hang.
    - **48e. The relay's deferred half** -- **COMPLETE 2026-09-03**: lease
      expiry (`a2288f2`), reconnection (`1663fd9`) and enrollment (`3b92ead`),
      which puts a store behind the same `RelayAuthenticator` seam and keeps
      only a SHA-256 of each token, so a reader of the table cannot become the
      node. It forced a widening worth knowing about: `AuthenticatorService`
      now carries `StorageError` beside `RelayUnauthorizedError`, because
      unauthorized is *terminal* on the client, and reporting a database blip
      as a bad credential would take a whole fleet offline over a transient.
      The durable mailbox is **withdrawn** -- see the plan's §3.5, which walks
      through why queueing a request for an offline peer delivers work to a
      caller that was told an hour earlier it had failed. The relay also
      cannot classify frames without parsing them, which is the property that
      keeps it a transport. What survives of the idea is notification-only
      delivery, opted into by the sender, and nothing currently needs it.

      Reconnection was small because of two upstream facts worth not
      re-deriving: `makeProtocolSocket` already retries its socket and clears
      its error on open, so the RPC client heals; and it never replays
      requests, so the long-lived `listen` stream stays dead and re-issuing it
      is nearly the whole job. The relay holds no per-endpoint subscription
      state, so handlers need no re-registration.

      The rule that matters: **the reason for an ending decides whether to
      retry.** A superseded connection must not come back, or two nodes
      sharing an identity flap forever, each superseding the other; an
      unauthorized one must not either. The initial connection is still not
      retried, because a layer that hangs on a typo is worse than one that
      fails. In-flight requests are settled on a drop, which is 48c's rule in
      its second home and is forced rather than chosen -- the far end releases
      its client when its send is refused, so the response is genuinely gone.

      The lease is renewed by any traffic, not only `heartbeat`, and is
      evaluated when the relay is already doing something rather than by a
      reaper fibre -- whoever asks is the one who collects, so the answer a
      caller gets and the state the relay holds cannot disagree. Both halves
      had to land together: `RelayClient` heartbeated once at startup, so
      expiry alone would have dropped every node that was merely quiet.

    Recorded there so it is not re-derived: our submission idempotency key is
    already identity-based rather than input-based, which is the property
    their RFC is careful about; and their no-Activities, canonical-records
    bet is deliberately *not* taken, because our `DeliveryLog` deduplicates
    by semantic key precisely since we replay.

### In flight (2026-09-01)

Items 28 and 29 **landed while this section was being written** — `230745d`
(`feat(output)`) and `efc3306` (`feat(code): CallScript behind the executor
seam`). They are kept below, struck, rather than deleted, because the entry
records what shipped and the next audit should not have to re-derive it.

Item 27 is still in the working tree unstaged. `STATUS.md` does not claim it
and should not until it is committed. Item 30 is untouched.

27. **Model capabilities and prompt caching**
    (`docs/plan-model-capabilities.md`, milestones M0–M6). The plan's own
    status line now records this; the short version:
    - **M3 landed**: `ContextTransform.cacheBreakpoint` marks the end of the
      leading system run so Anthropic and OpenAI can bill the stable prefix at
      the cached rate, with `Presets.coding` setting it by default.
      `test/PromptCache.test.ts` pins placement, wire survival, and that
      canonical history is untouched.
    - **M1 landed 2026-09-01**: `src/model/ModelCapabilities.ts` (the
      `Capabilities` value, the service, `fromTable`, `builtin`, and the
      exhaustiveness test that fails the build when the pinned rc names a model
      with no row), committed as `be75b83` and reachable: `./model` is entry
      point 48 and `verify:package` imports it from the packed tarball.
    - **M2 landed 2026-09-01**: `ModelCapabilities.budget` is a resolver
      `Compaction.tokens` accepts unchanged, so the `ResolveBudget` seam
      carried the whole wiring and `src/compaction` did not move. A test hands
      it to `Compaction.tokens` and fails to compile if either shape drifts.
    - **M4 landed 2026-09-01**: `Budget.cost`, a money ceiling on the same
      loop seam as `Budget.within`, pricing `uncached` / `cacheRead` /
      `cacheWrite` / output separately. A test pins that a cache write is
      priced above an uncached token and fails if it is priced as a read.
    - **M5, M6 not started** — the opt-in pre-flight transform, and the
      selection example.

28. ~~**`AgentOutput`**~~ — SHIPPED 2026-09-01, `230745d`. A typed value a submission ends with, implemented as
    *a tool the model calls to report its answer* rather than a second model
    call, so it costs no extra call and lands in canonical history as an
    ordinary call/result that replays and audits like any other. Exported from
    `src/index.ts`, wired through `Agent`, `AgentTurn`, `AgentRun`,
    `AgentSubmission` and `Presets`; `test/AgentOutput.test.ts` passes.
    Documented by `docs/plan-structured-output.md` ("Status: landed"), which is
    in the index.

29. ~~**Code-mode executors**~~ — SHIPPED 2026-09-01, `efc3306`, which also
    updated `verify-package.mjs` for the new entry point.
    (`docs/plan-code-mode-executors.md`) — steps 1–3
    landed 2026-09-01 (`CodeExecutor`'s `Completed | Suspended` outcome,
    `CodeTool.searchTool`, the collect-all pre-flight). **Step 4 is now
    implemented too**: `src/code/callscript.ts` puts CallScript behind
    `CodeExecutor`, with a `./code/callscript` export and `callscript` as an
    optional peer dependency, and `test/CodeCallScript.test.ts` passes (6
    tests). The plan's step table and `docs/README.md`'s index were both
    corrected in the same pass. Step 4 was the acceptance test for 1 and 3
    ("a second executor is the only real evidence"), so landing it is the
    claim that seam is a seam.

30. ~~**Two junk files at the repository root**~~ — **deleted 2026-09-01**,
    and `nul` / `nul.d.ts` added to `.gitignore` so a stray redirect is never
    committed. `{})` turned out to be *tracked*, not untracked. Nothing in
    `package.json` or `scripts/` performs the redirect that made it, so nothing
    regenerates it. The entry as it stood: two junk files, untracked:
    `nul.d.ts` (170KB of
    generated declarations — the result of a `> nul` redirect on Windows, where
    `nul` is a device name, so `tsc` wrote a file instead of discarding output)
    and a zero-byte file literally named `{})`. Neither is referenced by
    anything. Delete both, and add `nul.d.ts` to `.gitignore` if the redirect
    that made it is in a script somebody still runs.

35. **A typed output across the remote and durable boundaries.**
    `AgentOutput` landed (`plan-structured-output.md`), and `Result.value` is
    local to an in-process session: `AgentClient`'s `RemoteResult` and
    `DurableSubmission`'s `Outcome` are fixed schemas shared by every agent, so
    neither carries it. A remote or durable caller reads the answer out of
    history instead.

    **The design question is now decided** (2026-09-01): **the schema comes from
    the call site.** This is not a fresh choice -- `AgentA2A.typed` already
    solves the same problem across the same kind of boundary, and has for a
    while. A2A's `SendMessageResult` is `Message | Task`, a fixed wire schema
    shared by every peer; `typed({ request, result })` encodes through the
    request codec into a JSON text part and decodes the result through the
    result codec, and a peer answering off-contract is `AgentA2ARemoteError`
    with code `BAD_RESULT` -- attributed to the peer rather than treated as a
    local bug. So the wire stays an agent-agnostic envelope and the caller
    names what it expects. Following that precedent means one story to
    document rather than two.

    **Publishing the schema on the agent card was considered and rejected** as
    the mechanism. A card is discovery metadata fetched at runtime, so a schema
    published there cannot give a caller a compile-time type: you would decode
    at the call site anyway, having also paid for the publication, and a card
    that drifts from its agent silently mistypes every consumer. The card is
    the right place to *advertise that a typed output exists* -- its JSON
    Schema, for a human or a model to read -- but it is not a substitute for
    the caller naming what it expects.

    **SHIPPED 2026-09-04** (`89d04ac`, `da4fba6`), exactly as described: an
    opaque encoded field on `RemoteResult` and on `Outcome`'s `Succeeded`, and
    a decode at the edge through `typedSession`, which already encoded the
    typed *input* the same way. `TypedSession` now carries `Value` beside
    `Input`. Additive on both wires -- the durable field is optional for the
    same reason `content` is, so an older journal decodes and reports no
    value.

    `AgentOutput.encode` dies and `decode` fails, deliberately: a value that
    will not encode came from this agent's own run against its own schema, and
    one that will not decode means the far end is not the agent this caller
    thinks it is.

    **It also uncovered a bug with no connection to item 35: a durable agent
    with a declared output could not run at all.** `DurableModel` built the
    journal's response-part schema from the agent's toolkit, and the output
    tool is injected per turn by `AgentTurn` rather than living there, so the
    model's call to it could not be encoded and the submission died with a
    `SchemaError` naming a union that omits it. Nothing combined the two
    features, so nothing caught it. `DurableModel.wrap` now takes
    `alsoDescribing` for tools the journal must describe but never executes.

50. **A parent cannot tell a cut-short delegation from a finished one**
    (found 2026-09-04 by `test/SubagentDurable.test.ts`, recorded rather than
    decided). A child session absorbs interruption by design, so an
    interrupted child does not fail its delegation: `Agent.run` returns with
    whatever was committed before the cut, `Subagent.tool` maps that to
    `result.text`, and the parent's tool call *succeeds* with a partial
    answer. The parent's model reads a short answer as an answer.

    One good consequence falls out of it and is worth knowing: subagents are
    structurally insulated from the reissue hazard 48a exists to stop, because
    nothing interrupt-shaped ever reaches `DurableToolkit`. Not by anyone's
    design, which is why it is written down.

    The question is whether `Subagent.tool` should report a cut-short child as
    a tool *failure* rather than a short success -- `onError` already exists
    for child failures and this is arguably one. Not changed here because it
    alters what a parent model sees on a path nobody has complained about, and
    the honest answer may be that a partial answer is better than none.

51. ~~**A replayed turn is charged to the budget twice**~~ — **FIXED 2026-09-04.** `Budget.spend`/`spendCost` now take an `Occurrence` — `(runId, turnIndex)` — and drop a charge for a turn already counted, so a replayed turn costs what it cost the first time. `test/BudgetCombinations.test.ts` asserted the wrong number until the fix landed and now asserts 2,000; disabling the dedupe returns it to 3,000. The number is also evidence that a run keeps its identity across a suspension, since a fresh `runId` on replay would have made the key differ. *(Original entry follows.)* (found 2026-09-04 by
    `test/BudgetCombinations.test.ts`, pinned at the wrong number so the suite
    stays honest). Measured: a two-turn script that suspends once makes
    **two** model calls and records **three** turns of spend. The journal is
    fine -- the pre-suspension call is replayed, not re-issued -- but the loop
    runs again on replay and `Budget.within` charges whatever response it is
    handed, including a replayed one.

    The direction is the problem. This is not a ceiling that fails to bite; it
    bites too early, and the more a run suspends the earlier, so a long durable
    conversation can be stopped for exceeding a budget it never spent. The
    number is also wrong as a ledger, which `Budget.cost` already warns about
    for a different reason.

    The fix is a decision, not a line: `Budget.spend` has no notion of turn
    identity, so making it idempotent means either keying spend by turn (a
    public signature change) or journalling the spend as an activity so replay
    returns the recorded total. The second is the durable-shaped answer and the
    larger change.

52. **A child's tokens are not counted against the parent's ceiling** (same
    file). `Budget.within` is a *loop* combinator and a child agent has its own
    loop, so an unbudgeted child spends through a model and is charged to
    nobody. A parent capped at N can spend without limit by delegating --
    which is the shape of an agent that is capped *because* it delegates.

    The `Budget` service is shared: a child inherits the parent's context, so a
    budgeted child charges the same counter. Everything is in place except
    anything that makes it happen, which is what makes it a footgun rather than
    a missing feature. The candidate fix is for `Subagent.tool` to wrap the
    child's loop when the parent's context carries a `Budget`, and the
    question it raises is whether a delegation should be able to opt out.

53. **A child agent's approval-requiring tool cannot be approved by anyone**
    (found 2026-09-04 by `test/PermissionSubagent.test.ts`). A tool marked
    `needsApproval` asks for an approval, and a session answers that from its
    elicitation seam. `Subagent.tool` opens the child with `Agent.run`, which
    has no elicitor: the parent's is not passed down and nothing else supplies
    one, so the request is refused and the tool never runs.

    The child's *policy* is not what decides it, which is what separates this
    from an ordinary denial: `Permission.allowAll` on the child makes no
    difference. Isolated with a control -- same child, same policy, same
    script, one tool annotated and one not; the plain tool runs and the
    annotated one is dead. So a delegated agent may hold any tool it likes as
    long as nobody has to approve it, and marking a tool as needing approval
    disables it rather than protecting it.

    The obvious fix -- pass the parent's elicitor to the child -- has a real
    question inside it: the parent's user would be asked to approve a tool
    call from an agent they cannot see, named by a tool they did not choose.
    `Subagent.Options` is where an answer would go, and "the child's tools are
    the delegation's blast radius, decided when you write the child" is a
    defensible answer too. What is not defensible is the current silence.

    Two things that *are* right and are pinned in the same file: a child's
    tools are governed by the child's own policy (a denying child blocks its
    own tool, and the parent is asked only about the delegation), and a parent
    approving a delegation is not approving what the child then does with it.

54. **Deciding what happens at the seams** ([plan-seams.md](./plan-seams.md),
    2026-09-04). The synthesis of items 50-53 and the fatal durable/output
    defect: none of them is a bug *inside* a module, and each is silent. The
    delegation boundary is the sharpest case, because the answers do not merely
    fail to exist -- they disagree. Principal crosses (a fibre reference),
    budget does not (a loop combinator), approval does not (a session option),
    and none of that was chosen.

    Ranked there: fix the budget under replay (a live bug that terminates
    correct work); decide the delegation boundary, starting with making a
    child's unapprovable tool fail at construction rather than silently at
    runtime; give injected tools one accessor, since the fatal defect was one
    caller of a set with no single definition; add a combination matrix so the
    next gap is a blank cell; extract `Agent.Any` from item 46; and make this
    file's claims verifiable, since it misdirected twice in one day.

### Newly ranked — from the rename (2026-09-04)

55. **A terminal-vs-retryable decision keyed on a package-scoped string.**
    `RelayClient.ts:101` holds `terminalTags` as two package-prefixed literals
    (`affe-agent/relay/RelaySupersededError`, `.../RelayUnauthorizedError`) and
    `isTerminal` decides not to retry by testing a live error's `_tag` against
    them. Within one version that is exact. Across two it is not: a node on the
    old package name talking to a relay on the new one fails to recognise those
    tags, treats supersession as a retryable drop, and produces precisely the
    flap the check exists to prevent — two nodes superseding each other
    forever. Found during the rename by the agent whose work it interrupted,
    who left it rather than widening a mechanical sweep into a design change.

    The rename is not the bug; it is what made an existing coupling observable.
    A decision about whether to retry should not depend on a string that
    changes when the package is renamed. The obvious repair is a structural
    marker on the error — a field, or membership in a declared set the relay
    owns — so the two sides agree on *what the error means* without agreeing on
    what the package is called. Single-version deployments are unaffected,
    which is why this is ranked rather than urgent for a pre-release package.

    **The same root cause, wider:** identifiers that outlive a process were
    renamed too, and each is orphaned rather than broken — a fresh empty table
    beside the old one, a checkpoint that is not found. Seven SQL table
    defaults (`affe_session`, `affe_elicitation`, `affe_delivery`,
    `affe_channel_input`, `affe_state`, `affe_session_directory`, plus
    `affe_history` in the Cloudflare store) and the compaction checkpoint
    prefix `affe-agent:compaction:`. All are already overridable
    (`sessionTable`, `elicitationTable`, `table`, `checkpointPrefix`), so
    pointing a deployment at its old data is a construction argument and no
    migration is owed. Worth deciding once, though, whether a persisted key
    should ever derive from the package name.

### Newly ranked — from the combination matrix (2026-09-04)

*Both are blank cells in the second table of
[conformance-matrix.md](./conformance-matrix.md), which is what that table is
for: the gap is recorded as a gap rather than assumed either way.*

56. **Run limits are probably not enforced across a delegation, and nobody has
    checked.** `maxTurns`, `maxToolCalls` and `maxDuration` are loop
    combinators, and a child agent has its own loop — the same shape as item 52
    (a child's tokens are charged to nobody), for the same reason. If it holds,
    an agent capped at N turns can exceed that cap by delegating, which is the
    shape of an agent capped *because* it delegates. Unlike 52 this has not
    been measured, so it is written as a suspicion with its reasoning rather
    than as a finding. One test in the shape of `BudgetCombinations` settles
    it; the fix, if needed, belongs with B's `inherit` decision rather than on
    its own.

57. **Nobody has asked what a tool holding a resource does when the
    *connection* dies.** `ToolCleanup` covers interruption of a run, and covers
    it in-process, under replay and under delegation. A client disconnecting
    mid-tool is a different event reaching a different seam, and the answer
    could reasonably be "the run continues and the resource is released when it
    ends" — but that is a decision, and it is currently whatever the transport
    happens to do.

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
