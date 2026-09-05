# Remaining work

Rewritten 2026-08-29 from an audit of every plan in `/docs` against what ships
at `b554458` (four read-only passes: kernel/durability plans, transport/server
plans, tools/toolkit plans, and the progress files themselves). This is the
live list; `STATUS.md` is what is true now, `docs/status-history.md` the
chronology, and `ROADMAP.md` the capability view.

**An entry that makes a claim about the code carries the check that falsifies
it** (`plan-seams.md` F, 2026-09-04), as a `verify:` line in a fenced block:
`grep "literal" path`, `no-grep "literal" path`, `exists path`, `absent path`.
`npm run verify:remaining-work` runs every one and `npm run check` includes
it, so a claim that has gone stale -- open work that landed, done work that
was undone -- fails the build until the text is fixed. This file misdirected
twice in one day before that existed. Fix the text, not the check.

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

  ```text
  verify: grep "it.live" test/ClusterMultiNode.test.ts
  ```
- ~~The count includes work that is not committed.~~ No longer true as of
  2026-09-01: item 27's working-tree changes were committed as `be75b83`.

**Closed entries live in [remaining-work-closed.md](./remaining-work-closed.md)**
(2026-09-05, `plan-after-seams.md` 2.8), verbatim and still checked, so this
file is the list of what is open and nothing else. A struck heading here
means an entry closed since the split and not yet moved; move it. Item
numbers are stable across the two files and are never reused, so a plan
that cites "item 41" and finds no 41 here will find it in the ledger.

## Ranked

Ordered by user-visible value per unit of work. Each row says why it is still
open, so the next pass does not have to re-derive it.

### Functional gaps in shipped packages

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
24. **Session-tree delta storage + `Cache`** — only if whole-snapshot
    serialisation actually bites.
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

### Newly ranked — from the effect-cf research (2026-09-01)

Full reasoning in [plan-effect-cf-and-webtransport.md](./plan-effect-cf-and-webtransport.md).
Split out because one of these is a defect and the rest are options.

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

    **Closed 2026-09-04 by `plan-input-default.md` step 5.** `RemoteResult`
    and `Outcome` had gained an opaque encoded `value` decoded at the edge with
    the agent's output schema (`AgentClient.typedSession`, 48f); step 5 made
    it uniform. Every agent has a `Value` -- its text unless it declares an
    `AgentOutput` -- so every completed result carries one on the wire and in
    the journal, an untyped agent's is its text, and a caller generic over
    agents reads a value from all of them. `test/InputWire.test.ts` pins the
    wire change as exactly the added field.

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

    ```text
    verify: grep "an interrupted child answers with what it had, and the parent is not told" test/SubagentDurable.test.ts
    ```

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

    **Half done 2026-09-05.** `isTerminal` now decides by the relay's own
    error schemas -- `Schema.is(Schema.Union([RelaySupersededError,
    RelayUnauthorizedError]))` -- and the two literal strings are gone, so a
    rename moves the errors and the check together and cannot desync them
    within one version; `RelayReconnect`'s supersession-flap row is what fails
    if supersession ever becomes retryable. What is *not* done is the
    cross-version case, because it is not a relay question: two package names
    talking disagree at the decode layer, before any check runs, and the only
    fix is a wire tag that does not derive from the package name. That is the
    "decide once" below, it applies to every `affe-agent/...` tag and every
    `affe_*` table default, and it is a decision to make, not a patch to land.

    ```text
    verify: no-grep "affe-agent/relay/RelaySupersededError\"," src/relay/RelayClient.ts
    verify: grep "Schema.is(Terminal)" src/relay/RelayClient.ts
    ```

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

### Newly ranked — after the seams pass (2026-09-04)

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
