# Remaining work — the ledger

*Split from [remaining-work.md](./remaining-work.md) on 2026-09-05
(`plan-after-seams.md` 2.8). That file is the live list: what is open.
This one is everything it had closed, verbatim, in the sections and order it
sat in there, so that a closed entry's reasoning and its `verify:` lines --
which pin the work as **done** -- are kept and still checked.
`npm run verify:remaining-work` scans both files. Item numbers are stable
across the two and never reused, so every plan that cites one by number
still resolves -- here, if not in the list. Nothing here is next;
`STATUS.md` is what is true now and `status-history.md` the chronology.*

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

    ```text
    verify: grep "resolveFor" src/toolSource/Credentials.ts
    ```

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

### Newly ranked — from the effect-cf research (2026-09-01)
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

### Newly ranked — from the effect-agent.com comparison (2026-09-01)
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

46. ~~**Every agent has an input; the prompt is the default**~~ — **DONE
    2026-09-05**, all six steps, two deviations recorded in the plan
    (`agent.output` stays an `Option`; step 4's "always write `input`" is
    deliberately not done). The guide is `guide-sessions.md`, "Typed input
    and output". Was:
    (`plan-input-default.md`, 2026-09-02). Removes the `Input = never` /
    `PromptInput<Input>` conditional that caused every awkwardness in 41
    and 41b: `AgentInput.prompt` as the default, one wire shape (the
    session's encoded input, byte-identical to today's prompt wire for an
    untyped agent), `AgentInput.Current` always set, and then the same for
    output (`AgentOutput.text` as the default `Value`, which finishes item
    35 as a consequence). A refactor across ~100 signatures, nearly all of
    which get shorter; sequenced after 26l/26n/26p land so it does not
    cross their edits. Acceptance and the six steps are in the plan.

    **Front extracted 2026-09-04 (`plan-seams.md` E):** `Agent.Any` and the
    extractors `ToolsOfAgent`, `ErrorOf`, `RequirementsOf`, `ModelOf`. Doing
    it found the cause stated exactly: `AgentDefinition<any, ...>` admits no
    untyped agent, because `any` in an invariant slot does not admit `never`.
    So `Any` is a structural interface, not an alias, and it cannot be run --
    the `PromptInput<Input>` conditional that a helper hits when it *asks* a
    generic agent is what this item still owes.

    **Steps 1 and 2 landed 2026-09-04.** `AgentInput.prompt` is the default
    input -- the prompt wire codec as its schema, the identity as its render
    -- `Agent.make` fills it in, `Input` defaults to `Prompt.RawInput`,
    `PromptInput` is deleted, `definition.input` is never an `Option`, and
    `AgentInput.Current` is set on every submission (the encoded prompt under
    the default, so `None` means exactly "not inside a submission", and a
    tool asking for a ticket there gets the schema's own error). The
    `verify:` line that pinned the conditional as present is what said this
    entry was stale, which is the checker doing its job. **Step 3 landed the
    same evening**: one wire shape, `AgentInput.Typed` deleted, an untyped
    client's bytes recorded before the change and pinned equal after it
    (`test/InputWire.test.ts`). **Step 5 followed**: `Value` defaults to
    `string`, an untyped agent's `Result.value` is its text and is always
    `Some`, the wire carries it uniformly (recorded before, pinned as "the
    same plus `value`"), `Subagent.Answer` is an alias, and `Agent.Any` is
    the alias `AgentDefinition<any, ...>` at last. One deviation, stated in
    the plan: `agent.output` stays an `Option`, because the output's default
    is the absence of a tool rather than a different codec. What is still
    owed: step 4 (journals carry `input`; `InputBoundary.declared` survives
    for the records until then) and step 6 (the guide). **Both closed
    2026-09-05**: `askedOf` decodes with the agent's own schema and needs no
    `Declared`; the doubling of every prompt in every record that the rest of
    step 4 asked for is not done, and the plan says why.

    ```text
    verify: grep "export const prompt: AgentInput<Prompt.RawInput, unknown, never, never>" src/AgentInput.ts
    verify: no-grep "export type PromptInput" src/AgentSession.ts
    verify: grep "export const declared = " src/internal/inputBoundary.ts
    verify: no-grep "askedOf(InputBoundary.declared" src/durable/DurableAgent.ts
    verify: grep "## Typed input and output" docs/guide-sessions.md
    verify: no-grep "TypedInput" src/AgentInput.ts
    verify: exists test/fixtures/prompt-request.json
    verify: grep "export type Any = AgentDefinition<any, any, any, any, any, any>" src/Agent.ts
    verify: exists test/fixtures/prompt-response.json
    verify: exists test/fixtures/README.md
    ```

### In flight (2026-09-01)
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

35. ~~**A typed output across the remote and durable boundaries.**~~
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

52. ~~**A child's tokens are not counted against the parent's ceiling**~~ (same
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

    **Closed 2026-09-04 (`plan-seams.md` B).** `Subagent.Options.inherit.budget`
    defaults to `true`: the child runs under the parent's `Budget`, and --
    since `plan-after-seams.md` 2.4, the same evening -- the *engine*
    records every turn against the `Budget` in context (`Budget.record`),
    so its turns land on the parent's counter and the parent's ceiling sees
    them when the delegating turn ends. (For a day this was a charge-only
    loop combinator, `Budget.charge`, wrapped around the child; it is gone,
    and `within` and `cost` are pure decisions.) `false` is the old behaviour, chosen. The
    child is counted rather than capped within one delegation; a child that
    should stop on its own caps its own loop with `Budget.within`, which now
    reads the shared counter, and `Subagent.tool` admits `Budget` in the
    child's requirement without asking `provide` for it. All three rows in
    `test/BudgetCombinations.test.ts`.

    Closing it found a second bug in item A's fix: the occurrence key was
    `runId:turnIndex`, run ids are minted **per session**, and `Budget.layer`
    documents "once for the whole application" as a supported scope -- so any
    two sessions sharing a budget collided on their first turns and the
    second's charges were dropped as replays. A delegated child is a session,
    which is how it surfaced: the parent's own turns vanished. The key
    included the session id for a day; since `plan-after-seams.md` item 1
    the *run id* carries its session, so the key is the run again and the
    fix lives where ids are made. `test/Budget.test.ts` pins two sessions on
    one budget summing rather than deduplicating.

    One residue, stated in `Budget.record`'s doc: it records cost only when a
    table in context prices the child's model, and records nothing for cost
    otherwise -- the opposite of `cost`'s fail-on-unpriced rule, because
    recording has no ceiling and cannot know whether money is watched, and a
    table is often in context for the context-window check. So a parent
    capped with `cost` whose child runs on an unpriced model is not charged
    for that child's money. Give the child a priced model, or its own `cost`
    cap.

    ```text
    verify: grep "yield* RunLedger.record({" src/AgentRun.ts
    verify: grep "${sessionId}:run-${n}" src/internal/ids.ts
    ```

53. ~~**A child agent's approval-requiring tool cannot be approved by anyone**~~
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

    **The silence is closed (2026-09-04, `plan-seams.md` B, first half); the
    policy question is still open.** `Subagent.tool` and `toolScoped` now
    refuse at construction -- by throwing, the way `Agent.make` refuses two
    toolkits -- a child holding any tool marked `needsApproval`, the function
    form included, since it may ask and nobody could answer it either.
    `toolScoped` refuses before building the child's layer. To read a child's
    tools before the child runs, a toolkit built from a static list now
    *declares* them (`Agent.toolkit`, `tools: [...]`, `withTools`; see
    `internal/toolkit.ts`), which is what `Agent.toolkit` returning a bare
    Effect had made impossible. The one child the check cannot reach is one
    whose toolkit is resolved per turn from runtime state, which declares
    nothing until it runs; that child keeps the runtime refusal, and
    `test/PermissionSubagent.test.ts` pins it in the direction that fails when
    someone closes it. **The review found that this is the common case for
    the tools that matter:** `McpToolkit.bind` and `ToolSource.bind` list the
    server, and the server's `requiresApproval` annotation becomes
    `needsApproval` only then, so a child whose approval-requiring tools are
    remote is exactly the child the check cannot see. Not a reason to
    inspect the static list `bind` is given -- it would under-report -- but
    the reason the second half is not optional.

    **Second half closed 2026-09-04.** `inherit: { approval: "parent" }`
    forwards the child's approvals to the parent session's elicitor. The
    harness provides `Elicitation.Current` around every handler -- the
    session's elicitor, wrapped so a forwarded request is also announced on
    the *parent's* event stream, which is the one the parent's consumers
    watch -- and a child opened under `"parent"` gets a factory that reads
    it. The request's `detail.via` names the delegating tool (outermost first
    through nested delegations), so the person asked is told who is asking;
    `Permission.ApprovalDetail` gained that optional field. Answered with
    `AgentSession.respond` on the parent, as any approval is. Opt-in, and the
    default stays the construction-time refusal, because forwarding puts a
    real question to a person about an agent they cannot see. Outside any
    session `Current` is `None` and the child refuses as it always did. Three
    rows in `test/PermissionSubagent.test.ts`: granted, refused, no
    session, a delegation of a delegation (`via` is the path), and -- found
    by the review -- a forwarded request and the parent's own asked at once.
    Elicitation ids are `submission-N:elicit-M` with both counters per
    session, so a child's first request had exactly the parent's first id and
    the elicitor kept one waiter. The forwarded id was namespaced by the
    child session for a day; since `plan-after-seams.md` item 1 a submission
    id carries its session and an elicitation id inherits it, so `Subagent`
    rewrites nothing and the row still hangs if that stops being so.

    ```text
    verify: grep "Effect.provideService(Elicitation.Current, Option.some(forwardable))" src/ToolExecution.ts
    verify: grep "via: Schema.optional(Schema.Array(Schema.String))" src/Permission.ts
    ``` This is also the answer for the MCP-bound child above, which the
    static check cannot see: forward, and the person decides.

    Two things that *are* right and are pinned in the same file: a child's
    tools are governed by the child's own policy (a denying child blocks its
    own tool, and the parent is asked only about the delegation), and a parent
    approving a delegation is not approving what the child then does with it.

### Newly ranked — from the combination matrix (2026-09-04)

56. ~~**Run limits are probably not enforced across a delegation, and nobody has
    checked.**~~ **CLOSED 2026-09-05, decided the other way from money.** `maxTurns`, `maxToolCalls` and `maxDuration` are loop
    combinators, and a child agent has its own loop — the same shape as item 52
    (a child's tokens are charged to nobody), for the same reason. If it holds,
    an agent capped at N turns can exceed that cap by delegating, which is the
    shape of an agent capped *because* it delegates. Unlike 52 this has not
    been measured, so it is written as a suspicion with its reasoning rather
    than as a finding. One test in the shape of `BudgetCombinations` settles
    it; the fix, if needed, belongs with B's `inherit` decision rather than on
    its own.

    **Measured 2026-09-05** (`test/LimitsAcrossDelegation.test.ts`): a
    parent's `maxTurns` counts the parent's turns, `maxToolCalls` counts the
    delegation as one call, and a child's own bound holds under a delegation.
    Decided as the right behaviour rather than fixed: a turn is a fact about
    one run and is not fungible across agents the way a token is, so the
    bound that means "this child may take at most N turns" is on the child's
    loop, where it means the same thing whoever calls it. The matrix cell is
    the test.

    ```text
    verify: exists test/LimitsAcrossDelegation.test.ts
    ```

58. ~~**No test asserts that a principal reaches a tool over a wire.**~~ **CLOSED 2026-09-05.** Found
    reviewing the matrix rather than by running anything: the cell read
    "`Principal`, relay stamp" and neither backs it. `Principal.test.ts` covers
    in-process and durable; the relay's `PEER_HEADER` stamps a peer, which is a
    node's identity and not a user's.

    The design intent is that the wire does **not** carry it — a principal
    arriving in the protocol is a caller asserting its own identity, which is
    the trust bug the seam exists to avoid, so a serving host establishes it
    from its own authentication and provides it around the submission. That is
    a sentence about how it is meant to work, which is the class of claim that
    has been wrong twice this week. The test is small: an `AgentHttp` or
    `AgentRpc` server whose host provides `CurrentPrincipal` from the request's
    credentials, and a tool that reports what it saw — plus the negative, that
    a principal a *client* tries to send does not become the one the tool
    reads.

    ```text
    ```

    **Closed by `test/PrincipalOverWire.test.ts`**: a real agent behind a real
    HTTP server, the host's `subject` mapping reaching the tool, a
    client-invented identity header not reaching it, and a host that maps no
    subject putting nothing on the fibre. The two `no-grep` pins that recorded
    the absence are gone, because the absence is.

    ```text
    verify: exists test/PrincipalOverWire.test.ts
    ```

54. ~~**Deciding what happens at the seams**~~ **CLOSED 2026-09-04**: all six items of `plan-seams.md` shipped; the plan records what each did not predict. ([plan-seams.md](./plan-seams.md),
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

### Newly ranked — after the seams pass (2026-09-04)

59. ~~**[plan-after-seams.md](./plan-after-seams.md)**~~ **CLOSED 2026-09-05**: all thirteen items of `plan-after-seams.md` shipped, withdrawn or reconsidered, each with its reasoning kept. -- eight items the
    seams pass tripped over, ranked: ids carry their session (**done**, the
    same evening: `session-N:submission-M`, `session-N:run-M`, and the two
    local prefixes deleted); the construction-time refusal at
    `AgentSession.make` (**withdrawn** the same evening: the `denied`
    default is fail-closed *and loud* -- the run fails with
    `ToolApprovalRequiredError` -- and only the delegation was silent);
    item 46; the engine recording usage so the loop only decides (**done**:
    `Budget.record` in `AgentRun`, `within` and `cost` pure, and a memo-map
    sharing bug found by the `budget: false` row on the way); naming what a
    tool can see of its session (**done**: `guide-sessions.md`); the static
    toolkit as the common case in the type; a typed child returning its
    value (**done**: `Subagent.Answer`, the matrix's "text only" cell is a
    test); and this file becoming a list again. Open: item 46, the static
    toolkit, and the split of this file.

    **Added the same evening (§2b of the plan)**, after item 46's steps 1–3:
    sequence 46 as 5, 4, 6; a fixture convention for wire and journal
    changes (`test/fixtures/README.md`, a `verify: exists` per fixture);
    two Effect notes for AGENTS.md (`Effect.fn` generics fall to their
    default silently; a module-level layer is one instance under one memo
    map); one wire type for "JSON the receiver decodes" across input,
    elicitation detail and output value; and a `COLLABORATION.md` claim, or
    an explicit "abandoned", for work that sits in the tree.

    ```text
    verify: grep "Ids.makeIdSource(id)" src/AgentSession.ts
    ```

57. ~~**Nobody has asked what a tool holding a resource does when the
    *connection* dies.**~~ **CLOSED 2026-09-05.** `ToolCleanup` covers interruption of a run, and covers
    it in-process, under replay and under delegation. A client disconnecting
    mid-tool is a different event reaching a different seam, and the answer
    could reasonably be "the run continues and the resource is released when it
    ends" — but that is a decision, and it is currently whatever the transport
    happens to do.

    **Asked, by `test/CleanupOverWire.test.ts`**: the disconnect tears nothing
    down, the tool finishes, the resource is released exactly once, and the
    idempotent retry gets the answer. Pinned as the decision, since tearing a
    tool down because a socket closed would make every flaky connection a
    partial write. The matrix has no "not tested" cell left.

    ```text
    verify: exists test/CleanupOverWire.test.ts
    ```

### Newly ranked — from `danieljvdm/effect-agent#335` (2026-09-05)

60a. ~~**The model can see its own window.**~~ **DONE 2026-09-05.** A
    read-only tool, `Controller.tools.contextRemaining`, reporting the last
    projection the controller recorded for the calling session -- estimated
    tokens, the limit compaction keeps it under, what remains, how much
    history is folded -- and the ambient `Budget`'s totals through the
    previous turn, `null` where the policy sets no token limit. The
    transform records the projection at both of its exits, so the number is
    the one the harness measured rather than a second estimate; a tool given
    to an agent without the transform fails by name rather than inventing
    zeros. It needed one more thing a tool can see of its session, its id
    (`internal/currentSession.ts`), provided by the harness beside the
    elicitor. Broken once: with the recording removed, exactly the three
    rows that read a projection fail and the three that test the failure
    paths still pass.

    ```text
    verify: grep "contextRemaining" src/compaction/Compaction.ts
    verify: grep "Effect.provideService(CurrentSessionId" src/ToolExecution.ts
    verify: exists test/ContextRemaining.test.ts
    ```

60b. ~~**A declared failpoint location with no test fails the build.**~~
    **DONE 2026-09-05.** `Failpoint.group` exposes `all`, the subsystem's
    declared boundaries qualified, and `Failpoints.covered(group, drive)` in
    `/testing` crashes at every one of them through the real path and
    **dies by name** for any the driver never reaches. The row in
    `test/Failpoints.test.ts` iterates `DeliveryLog.failpoints.all` through
    the SQL log, so a boundary added to the declaration is a boundary the row
    crashes at. It found the gap it was built for: `before-commit` had been
    declared and never stopped at; now both are, and the property that holds
    for either -- one retry leaves exactly one row at sequence 1 and the next
    event is 2 -- is asserted for each, with the retry's answer differing
    (`Appended` before the commit, `Duplicate` after) as the boundaries
    differ. Broken once: a third boundary declared with no `hit` makes the
    row die naming it. The first draft pinned reach counts and learned the
    duplicate path never reaches `after-commit`; counts are the driver's
    shape and are not pinned.

    ```text
    verify: grep "export const covered" src/testing/Failpoints.ts
    verify: grep "Failpoints.covered(DeliveryLog.failpoints" test/Failpoints.test.ts
    ```

60c. ~~**`Behavior-Change:` as a trailer the checker reads.**~~ **DONE
    2026-09-05.** Its own script rather than a branch of the claims checker,
    because it reads the commit log, not the docs:
    `scripts/verify-behavior-change.mjs`, in `check`, walks every commit
    since the fixtures convention landed (`1c6b2bd`) and fails by name for a
    commit that touched a fixture without a `Behavior-Change:` trailer, and
    for one that carried the trailer and touched none. The README in that
    directory is not a fixture and is excused. A shallow clone that cannot
    see the baseline fails rather than passes. Broken once, against the
    range `4ee770d..1c6b2bd`, where two commits changed fixtures before the
    rule existed: both named.

    ```text
    verify: exists scripts/verify-behavior-change.mjs
    verify: grep "verify:behavior-change" package.json
    verify: grep "## The trailer" test/fixtures/README.md
    ```

60d. ~~**Rollover: a fresh window as a compaction decision, with the harness
    as interpreter.**~~ **DONE 2026-09-05.** `Compaction.Checkpoint` is now
    `Schema.Union([Summary, Rollover])`; a summary recorded before the union
    has no `kind` and decodes as a `Summary`, measured by
    `test/fixtures/compaction-checkpoint.json` (recorded at `d6e4a69`, asserted
    to round-trip byte-for-byte). A `Rollover` projects the leading system
    messages of the folded prefix, one window marker carrying the model's
    handoff, and the retained tail; no summariser runs. Two triggers: the
    model's `new_context` call (`Compaction.NewContext`, a tool whose handler
    echoes the request so canonical history records it, read back by the
    transform from the uncovered tail -- crash-safe and replay-safe with no
    engine change), and a token policy's `CompactionCannotHelpError` when
    `onCannotHelp: "rollover"` is chosen, cutting at the last user message
    and never behind the existing checkpoint. `Trigger` gained `"requested"`;
    `Compaction.failpoints` marks both sides of the checkpoint write and
    `Failpoints.covered` drives both, the next pass ending in the same window
    either way. The `Budget` is untouched, asserted. A durable replay pin sits
    beside phase 14's: a suspension between the tool result committing and the
    checkpoint saving loses the request nowhere. Broken four ways once: no
    request detection (five rows fail), the fallback ignoring its option (one),
    the protected prefix dropped (three), a `hit` removed (`covered` dies
    naming it). Review found the fallback could make no progress -- a
    rollover already on record and no user message since puts the cut where
    coverage already is -- and would have written a new window every turn
    under pressure; it now takes the fallback only when the cut moves
    coverage or replaces a summary, and otherwise fails with the original
    error (row nine, broken once). Not shipped, each now its own item: the overflow trigger
    (60d-i), refusing a mixed batch (60d-ii); and a finding, the summary
    projection dropping the same instructions a rollover keeps (60l).

    ```text
    verify: grep "export const Rollover" src/compaction/Compaction.ts
    verify: grep "export const NewContext" src/compaction/Compaction.ts
    verify: grep "onCannotHelp" src/compaction/Compaction.ts
    verify: exists test/fixtures/compaction-checkpoint.json
    verify: grep "Failpoints.covered(Compaction.failpoints" test/ContextRollover.test.ts
    verify: grep "survives a suspension, from the journalled tool result" test/Durable.test.ts
    ```

60l. ~~**A summary projection drops the canonical instructions.**~~ **DONE
    2026-09-05.** A session's instructions are its first canonical message,
    so the first fold covered them, and the projection began at the summary
    message: from the first compaction on, the model ran without its
    instructions unless the summariser had restated them. One helper,
    `protectedPrefix`, returns the system messages that lead the folded
    history, and every projection keeps them ahead of what stands in for the
    rest -- a fresh summary, a stored summary, or a rollover marker (60d had
    it for rollovers only). One row drives four prompts through a summary and
    a stored checkpoint; breaking either projection site alone fails it.

    ```text
    verify: grep "const protectedPrefix" src/compaction/Compaction.ts
    verify: grep "the instructions survive a summary" test/Compaction.test.ts
    ```

60g. ~~**The engine records facts; seams only decide.**~~ **DONE
    2026-09-05.** `RunLedger`, a kernel module because the engine writes it:
    after every turn `AgentRun` makes one recording call, `RunLedger.record`,
    which writes an `Entry` -- session, submission, run, turn, tool calls,
    input and output tokens, cost when a `ModelCapabilities` prices the
    model, elapsed since the run started -- to the ambient ledger and charges
    the ambient `Budget`, either or both optional. Entries are keyed by the
    `Budget.Occurrence`, so a replayed turn is one entry; `run(runId)` and
    `totals` add them up, `sum` is exported for a reader's own selection.
    `AgentLoop.State` is not rebuilt over it -- a session with no ledger
    still needs a loop -- but the two are held equal after every turn by a
    row that reads the ledger from inside a loop, and `elapsed` is now read
    once and shared, so they cannot drift. "A child's turns are the child's"
    is a row: one ledger, two session ids, the parent's run view unmixed.
    Broken twice: the engine's write skipped (four rows fail), the
    occurrence dedupe removed (one). Not done, and not planned: making
    `Budget` a view over the ledger, which would require both services
    wherever one is provided today.

    ```text
    verify: grep "export class RunLedger" src/RunLedger.ts
    verify: grep "RunLedger.record" src/AgentRun.ts
    verify: no-grep "Budget.record(" src/AgentRun.ts
    verify: grep "\"RunLedger\"" test/PublicApi.test.ts
    ```

60h. ~~**Seams that describe themselves.**~~ **DONE 2026-09-05.** Every
    `AgentLoop` carries a `Description` built by the constructor that built
    it -- `UntilIdle`, `MaxTurns`, `MaxToolCalls`, `MaxDuration`,
    `FinalTurn`, `And`, `Or`, and `Custom` with a name, details and an
    inner description for a loop written by hand or by a battery
    (`Budget.within` and `cost` describe themselves so; the output stop
    `Agent.make` wraps around a loop does too). `and` and `or` flatten a
    nested conjunction, so `limits` reads as one. Every `Permission` policy
    constructor supplies a `Description` -- `AllowAll`, `AskAll`, `DenyAll`,
    `Rules` with each rule's matchers as data (a function matcher as
    `"function"`, a `RegExp` as its source), `All`, `Except`, `Remembered`
    -- on an optional field, so a policy object written before descriptions
    existed still works and reads as `Custom`. `Agent.describe(agent)`
    returns one `Description`: instructions, tools when the toolkit declares
    them (`declaredTools`; `None` for one resolved per turn), the loop, the
    permission, the three execution policies, the input and output with
    their schemas as values. The context transform is not described, and
    the description is a TypeScript type rather than a Schema: a wire form
    waits on a consumer. Derived, so it cannot disagree: a row runs each
    bound past its ceiling and finds the run stopped at the described
    number; a row reads a composed agent back as one literal. Broken twice:
    `maxTurns` describing one more than its bound (two rows fail), `rules`
    describing the wrong `otherwise` (two).

    ```text
    verify: grep "export const describe" src/Agent.ts
    verify: grep "readonly description: Description" src/AgentLoop.ts
    verify: grep "readonly description?: Description | undefined" src/Permission.ts
    verify: grep "a described bound is the bound" test/AgentDescribe.test.ts
    ```

60i. ~~**`Agent.policy({...})` as sugar that expands to the seams.**~~
    **DONE 2026-09-05**, as `Presets.policy` rather than `Agent.policy`: a
    preset is exactly "an assembly over the primitives that returns the
    parts", and the kernel should not import `/budget` to spell one.
    `policy({ maxTurns, maxToolCalls, maxDuration, finalTurn, tokens, cost })`
    returns `{ loop, layer }`: `AgentLoop.limits` for the bounds and the
    final turn, `Budget.within` and then `Budget.cost` around it, and a
    `Budget` layer when either ceiling was named, `Layer.empty` otherwise.
    The types follow the record's keys -- `policy({ maxTurns: 2 }).loop` is
    `AgentLoop<never, never>`, and only a record with `cost` requires a
    `ModelCapabilities` or can fail to price -- asserted at the type level
    and broken once by widening the conditional. `readPolicy` is the
    inverse over `AgentLoop.Description`: `Some(record)` for exactly the
    shape `policy` produces, `None` for any other loop, so
    `readPolicy(describe(policy(p)))` is `p` for every record tried, and a
    row asserts it. Compaction is not a field, on purpose: a compaction
    transform owns state and is built with `yield*`, so it goes straight on
    `contextTransform`. Broken three ways once. Review found two defects:
    `readPolicy` read a bare bound as a record, which `policy` never
    builds, and the conditional types tested for a key's *presence*, so a
    record typed as the wide `PolicyOptions` with a `cost` at runtime was
    typed as needing nothing. Both fixed the same day: the inverse insists
    on `untilIdle` underneath, and the types ask whether a ceiling is given
    (`Given<O, K>`), so a wide record is typed as needing everything it
    might -- the sound direction -- with a type assertion that fails if the
    test is for presence again.

    ```text
    verify: grep "export const policy" src/presets/Presets.ts
    verify: grep "export const readPolicy" src/presets/Presets.ts
    verify: grep "describe(policy(p)) reads back as p" test/PresetsPolicy.test.ts
    ```

60k. ~~**`CHANGELOG.md`'s behaviour-change lines derived from
    `Behavior-Change:` trailers.**~~ **DONE 2026-09-05.**
    `scripts/changelog-behavior-changes.mjs` reads every commit since the
    last release tag that carries the trailer and regenerates one marked
    block under `## [Unreleased]` -- the sentence, the commit, and the
    fixture that measured it. `--write` rewrites the block
    (`npm run changelog:behavior-changes`); `--check` fails when the block
    is out of date and is in `npm run check` as `verify:changelog`, so a
    behaviour change that was measured cannot be left out of the changelog.
    The log reader moved to `scripts/lib/behavior-changes.mjs`, shared with
    `verify-behavior-change.mjs`, so the enforcer and the publisher cannot
    read the log differently. First run listed 60d's rollover; `--check`
    failed before `--write` and passed after, which is its break-once.

    ```text
    verify: exists scripts/changelog-behavior-changes.mjs
    verify: exists scripts/lib/behavior-changes.mjs
    verify: grep "verify:changelog" package.json
    verify: grep "behavior-changes:start" CHANGELOG.md
    ```

60j. ~~**Guides state; plans argue.**~~ **DONE 2026-09-05.** The rule is in
    `AGENTS.md` under "Writing docs": a guide says what happens, in
    declarative sentences, and links the plan that holds the argument; a
    plan argues, weighs and decides; the ledger records. The pass over the
    seven guides found them already in that voice where it was checked --
    every "decide" is a noun in a declarative sentence -- so the durable
    part of this item is the rule, and the guide sections written this week
    (rollover, the ledger, describe, the policy record) were written to it.

    ```text
    verify: grep "Guides state; plans argue" AGENTS.md
    ```
