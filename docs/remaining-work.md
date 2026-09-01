# Remaining work

Rewritten 2026-08-29 from an audit of every plan in `/docs` against what ships
at `b554458` (four read-only passes: kernel/durability plans, transport/server
plans, tools/toolkit plans, and the progress files themselves). This is the
live list; `STATUS.md` is what is true now, `docs/status-history.md` the
chronology, and `ROADMAP.md` the capability view.

State of play, re-measured 2026-09-01: every issue through #80 is closed, #4
(the roadmap tracker) last, on 2026-08-30. `npm test` is green at **1820 tests
in 168 files** (up from 1466 in 131 when this was written), zero Effect
diagnostics, portability and the workerd bundle pass, and
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
  tests are **not** fixed by this and want their own entries:
  `ClusterMultiNode` (races a real ~15s clock; H7 would move it to
  `TestClock`) and `DurableStreams`' "linear, not quadratic", which asserts an
  asymptotic bound by measuring wall time and spawns no processes at all.
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
    `examples/deploy-cloudflare/` holds the Alchemy stack. Left: a real
    model wired through the stack and deployed from a clean account; Rivet.
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
25. **Per-principal credentials** — *note (2026-09-01): item 6 still says
    multi-user is "blocked on the principal reaching the tool fibre". That
    mechanism shipped 2026-08-31, recorded in this very entry, so the blocker
    is stale and items 6 and 25 are one piece of open work described twice.
    Merge them the next time either is touched.* (`plan-tool-credentials.md` §6) — the
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

26l. **`SessionDirectory`** (`effect-plan-2.txt` §26) — the management/query
    model over sessions: `get` / `list` / `active` / `stats` / `rename` /
    `move` / `annotate`, paginated from day one. Needs a backing store, which
    is why it did not land with 26k; 26k is the reducer it would keep per
    session to answer `stats`. Explicitly **not** `DurableSessionStore` (that
    is execution correctness, and the plan says do not merge them), not
    `/tree` (a conversation DAG) and not `AgentSessionHost.size` (a live count
    in one process).

26m. **`SessionInbox`** (`effect-plan-2.txt` §1–5) — a durable queue wrapper
    over `PersistedQueue` that accepts a background completion
    (`process:id:exit`, `monitor:id:complete`), waits for the target session to
    be idle, and starts a **new** submission on it idempotently. The plan calls
    this more important than `ProcessManager` and it is the one piece of
    §1–14 that needs neither processes nor relay. Phase 0 is closed: keep
    `/scheduling`'s `JobStore` for due-time dispatch, use `PersistedQueue` for
    immediate durable handoff (`evaluation-persisted-queue-job-store.md`).
    Note `/scheduling`'s `AgentDispatcher` is *not* this — it starts
    independent work rather than resuming a conversation.

26n. **`ProcessManager` / `WorkspaceManager`** (`effect-plan-2.txt` §8–14) —
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

26p. **Relay transport** (`plan-relay.txt`) — server and client, peer
    directory, enrollment credentials, durable mailbox over `PersistedQueue`,
    heartbeat/lease, backpressure. The genuinely large one, and the only thing
    blocking `plan-a2a-layers-bridges.txt` steps 5–7 (both bridges over the
    relay, at which point local vs remote is transport selection).
    `plan-deployment.md` §6.3 narrows when it is the right tool.

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

    What remains is the implementation: an opaque encoded field on
    `RemoteResult` and `Outcome`, and a decode at the edge, shaped after
    `AgentA2A.typed`. Still ranked here rather than done, because it changes
    two public wire schemas and no caller has asked for it yet.

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
