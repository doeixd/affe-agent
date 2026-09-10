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
    upgraded. Rivet is closed as adopter-triggered (ledger, decision 4 of
    `plan-two-decisions.md`). The deployment plan's §6.2 gateway claim -- one
    `AgentServer` with a DO-backed mount and an in-process one, indistinguishable
    from outside -- is exercised by `test/GatewayMounts.test.ts` (2026-09-06). **A real model landed 2026-09-06** as the first slice
    of the deployment milestone (scoped with a second reviewer, decision
    record in `plan-two-decisions.md` §3): `worker-real-model.ts` with the
    key in a Worker secret, `wrangler.real.jsonc`, the README quickstart,
    `test/WorkerRealModel.test.ts` proving the exact entry on workerd with
    the provider substituted at miniflare's outbound boundary, and the
    opt-in `npm run smoke:cloudflare` against a deployment. The live smoke
    has **not** been run from this machine (no account here); the README's
    quickstart is the procedure, and a sanitized result belongs in the
    ledger when someone runs it.
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
    rendered prompts), each gated on a caller (decision 4 of
    `plan-two-decisions.md`, 2026-09-06): LSP on a coding caller that needs
    diagnostics, references or rename that existing tools cannot supply;
    truncation on a shell, search or MCP result measured over a caller's
    budget; rendered prompts on a caller that needs runtime workspace, model
    or task values in its prompt. None is built speculatively.
    **`plan-primitives.md` steps 1–5 are complete.**
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

47. ~~**What to take from their Workflow RFC**~~ **COMPLETE 2026-09-06**
    (`plan-rfc-286-durable.md`, 2026-09-02): 47a shipped as 48a, 47b answered,
    47c shipped. Kept until the next audit moves it to the ledger whole. A read of `danieljvdm/effect-agent#286` against `/durable`.
    Their headline goal — any `WorkflowEngine` as a `Layer` — is where
    `/durable` started, so most of the RFC is not a gap for us. Three items
    are, ranked in the plan's §2:
    - **47a.** ~~**Retry safety declared on the tool.**~~ **SHIPPED as 48a,
      2026-09-03**, read from `Tool.Idempotent` rather than a field of our
      own. The original framing, kept for the record: the one real correctness
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
    - **47c. Dispatch intents for the Durable Object host.** ~~open~~
      **SHIPPED 2026-09-06.** An intent row beside every dispatched alarm in
      one native transaction; the run's settlement marks it `settled` in the
      same SQL transaction as the history it settles; the alarm handler reads
      the intent before doing anything. `test/WorkerDispatchIntents.test.ts`
      kills the runtime at both boundaries on workerd and the job runs exactly
      once. Host-local: `src/durable` did not change.

48. ~~**Making the failure paths provable**~~ **COMPLETE 2026-09-06**
    ([plan-failure-paths.md](./plan-failure-paths.md), 2026-09-03): 48a
    through 48f all shipped, 48c last. Kept until the next audit moves it to
    the ledger whole. A read of
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
    - **48c. Never acknowledge on the engine's word** -- ~~open~~ **SHIPPED
      2026-09-06.** `DurableAgentClient` reads the session record after the
      workflow reports a submission settled: a record that still holds the
      submission's claim is a disagreement, the caller gets a retryable
      `AgentTransportError` naming it, and the claim -- the intent -- is
      retained. `test/DurableAgentClient.test.ts` proves it with a store whose
      `finish` reports success and writes nothing; broken once. `RelayRpc`'s
      finalizer carries the comment tying it to the same rule. 47c gets the
      discipline by construction when it lands.
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

Items 27 and 30 are in the ledger.

### Newly ranked — from `danieljvdm/effect-agent#335` (2026-09-05)

60. **[plan-context-lessons.md](./plan-context-lessons.md)** -- six lessons
    from the other `effect-agent`'s durable context-window rollover
    (`danieljvdm/effect-agent#335`), each mapped to a seam we have. The plan
    ranks and sequences them; the entries below are the slices, in the order
    to work them, each pinned on its *open* state so the checker turns red
    the moment one lands and its text has to move to the ledger.

60f. **Deliberately not taken**, recorded in the plan's §3 so nobody
    re-proposes them: their fourteen-knob `AgentPolicy` object (our limits
    and budget compose without one), working notes over memory ports (no
    port asks for it yet), and a bot review with a cost ceiling.

    **Design, from comparing the two** (the plan's §5): their coherence
    without their centre.

### Tool exposure, terminal work and failure routes — 2026-09-10 — [plan-exposure-and-terminal-work.md](./plan-exposure-and-terminal-work.md)

*From `danieljvdm/effect-agent` #395–#424. Order of work, not priority:
91 first (small, closes a live side-effect hazard), 92 builds on it, 93 is
the largest and wants 100's harness to be judged. The plan carries each
item's invariants and acceptance tests; the entries here say what is open
and pin the state it starts from.*

93. **Visibility, progressive exposure and discovery (plan E3, §3) -- first
    slice landed 2026-09-10.** `ToolExposure` (kernel): `eager` or
    `progressive({ pinned, maxTools, maxResults })`, each with an optional
    `visible(tool, principal)` rule -- declared on the agent, decided per
    caller (Q1). The model is sent pinned ∪ latest discovery selection ∪
    protocol tools as `toolChoice.oneOf`, so the provider sees only those
    schemas while the response still decodes against the whole toolkit; a
    call outside the exposed set is refused with `ToolNotExposedError`; a
    hidden tool is absent from requests and discovery even when pinned; the
    selection is read from history, and a durable crash after discovery
    recovers it. `maxSchemaBytes` bounds what one discovery selects by
    the UTF-8 size of the parameter schemas, skipping a match too large to
    fit and saying `more`; the exposure bounds are rows in `limits.md`.
    Measured by 100's scenario: over 100 tools, eager sends 2 requests, 200
    tool entries and ~45 KB of schema; progressive 3, 17 and ~3.5 KB, for
    one more model call. Composes with `/tool-source`: thirty tools a
    source declares as JSON Schema start unexposed, discovery finds one, and
    its call reaches the source (T3.7). Still open: a `ToolExposureChanged`
    event (T3.9 -- the discovery's own `ToolCallSucceeded` already carries
    the new selection, so it may not be worth an event), and a live-model
    cost run before the guide recommends progressive.

    ```text
    verify: exists src/ToolExposure.ts
    verify: grep "readonly toolExposure: ToolExposure.ToolExposure" src/Agent.ts
    verify: grep "readonly maxSchemaBytes: Option.Option<number>" src/ToolExposure.ts
    ```

94. **Failure disposition (plan E4, §6) -- first slice landed 2026-09-10.**
    Decided (T6.1), as the plan recommended: a tool's own `failureMode:
    "return"` wins over the agent's `toolFailurePolicy: FailRun` -- the
    tool author made its failure a value the model reads -- and
    `test/FailureDisposition.test.ts` pins both sides of it (there was no
    test). `Agent.describe().tools` entries now carry `failureMode`,
    `alone`, `readonly` and `idempotent` (most of T6.4), so the
    agent-level policy does not read as a promise a tool breaks.
    **T6.2/T6.3/T6.5 deferred, deliberately:** nested Code Mode calls do not
    emit `ToolCallFailed` (they report through `ToolCallProgress`), so the
    only dispositions that occur are the two `returnedToModel: boolean`
    already says; a three-valued field would be the same fact twice across
    five consumers. Worth doing when a third disposition exists. Open: the
    describe entry's source namespace and provider-executed flag. Small.

    ```text
    verify: grep "readonly failureMode: \"error\" | \"return\"" src/Agent.ts
    verify: exists test/FailureDisposition.test.ts
    ```

97. **Acknowledgement vocabulary (plan E5, §8).** Persisted /
    DeliveryPending / Accepted / Running / Settled: document which one each
    submit-like API's success means (audit table in the plan), retype the
    ambiguous `void`s, and surface the incumbent claim when
    `DurableAgentClient.submit` refuses with `AgentBusyError` rather than
    dropping it. There is no background subagent mode; one added later must
    adopt the vocabulary. After 95–96. Medium.

98. **Code Mode `uncertain` and `not-started` (plan E6, §7).** A call in
    flight at interruption is reported `failed` or not at all; add
    `uncertain` and `not-started`, and refuse to blindly re-run a program
    whose non-idempotent calls are uncertain on durable recovery. Medium.

    ```text
    verify: grep "readonly outcome: \"succeeded\" | \"failed\" | \"refused\"" src/code/CodeMode.ts
    ```

99. **Budget topology, stated (plan E7, §9).** Only engine turns reach
    `Budget.record`; compaction, branch and coding summaries report usage
    only, and `inherit.budget: false` leaves a child's usage nowhere. Write
    the per-source table into `limits.md`, make every uncharged source still
    report usage with a scope, and revisit the documented "counted, not
    capped" subagent default (a delegation can overshoot the parent by a
    whole child run). Any future model-backed battery declares its row
    before landing. Small–medium.

    ```text
    verify: grep "is *counted*, not capped" src/subagent/Subagent.ts
    ```

100. **Matched release→main benchmark suite (plan E8, §10) -- first slice
     landed 2026-09-10.** `npm run bench` (`scripts/bench.mjs` over
     `bench/run.ts`): base and head each in their own worktree -- the
     "release" is a git ref, `v0.0.1` by default, since nothing is published
     -- with that ref's own dependencies (linked when the lockfile matches,
     `npm ci` when it does not; v0.0.1 against today's modules fails), head's
     scenarios copied in, runs interleaved in rounds, median and IQR with raw
     samples and exact commit/src/lockfile identities, and no percentage when
     the artifacts are identical. Deterministic scenarios over the scripted
     model; the exposure pair also records requests, tools and schema bytes
     sent (100 tools: eager 2 requests / 200 tools / ~45 KB, progressive 3 /
     17 / ~3.5 KB). First observations, not verdicts, on a machine shared with
     other test runs (identical refs differed by ~20% at small samples):
     streaming 1024 chunks read +42% in one run and +0.8% in the next --
     noise; the forty-prompt history scenario was slower than v0.0.1 in all
     three runs (+20%, +114%, +33%), the one signal worth investigating
     (`docs/reports/bench-2026-09-10.json`). Not from this week's work:
     `c5ed5dc` vs `e096b7b` on that scenario alone, 24 samples a side, is
     -0.4%, so it lies somewhere in the 514 commits before. **Attributed in
     part, 2026-09-10:** a bisect was misled by noise near its threshold;
     timing each commit in one install put a step of ~5 ms at `97f6f7c`
     (every submission encoding its input through the schema, a full
     `PromptWire` encode for the default prompt). `2be0bbf` builds a text
     prompt's encoding directly, pinned to the schema by test: v0.0.1 vs
     HEAD on that scenario went from +65% to +34%
     (`docs/reports/bench-2026-09-10-dbe2fecd-*.json`, before and after).
     What remains is a fixed per-submission cost -- a one-turn run is +68%,
     1.7 → 2.8 ms, four tool rounds +51% -- and a profile of a bundled
     one-turn run (source-mapped by esbuild's file markers) finds no hotspot
     of ours: the time is Effect's run loop, i.e. more effect steps per
     submission as features landed, plus ~8% schema work of which the
     largest piece is Effect AI rebuilding `Response.Part`'s union on every
     `LanguageModel` call (upstream). It is also confounded: v0.0.1 runs on
     its own lockfile with an older Effect RC, so some of the gap may be the
     dependencies, and v0.0.1's source cannot run against today's to
     separate them. Treated as the cost of the features, not a regression,
     unless a scenario shows one. Still open: durable
     scenarios (settlement replay, DeliveryLog catch-up, SQLite contention),
     effect-uai native vs adapter, a live-model cost run for item 93, and
     characterising variance before any gate.

     ```text
     verify: exists scripts/bench.mjs
     verify: exists bench/run.ts
     ```

102. **Cloudflare AI Gateway option (plan E10, §12).** An optional model
     option in `/cloudflare`. Adopter-triggered; not built speculatively.

*Part II of the plan (durability and correctness, from #376–#391). The
near-term priorities across both parts are five: 93 (exposure), 91+92
(terminal work), 103+104 (exact-response recovery and the equivalence
oracle), 105 (host scheduling and authority capture), 106 (continuity
evaluation). Work order: 91 and 103 first, then 104, whose oracle is the
acceptance test for 105, 107 and 108.*

104. **Crash/no-crash canonical equivalence oracle (plan E12, §16) --
     first slice landed 2026-09-10.** In-turn failpoints exist
     (`internal/turnFailpoints.ts`: after the model response, after each tool
     call settles, before and after the commit), and
     `test/DurableEquivalence.test.ts` crashes a real process at each one --
     parked at the boundary, scope closed, a second process over the same
     SQLite file takes the shard over -- and asserts the recovered run equals
     the uninterrupted one: encoded canonical history, result, model calls
     split exactly between the two processes, and each tool run once. Batch
     and streamed; two cells in `npm test`, the whole matrix under
     `AFFE_EQUIVALENCE=full`, which `verify:durability`'s new D8 row sets.
     The harness ships as `affe-agent/testing`'s `DurableEquivalence` and
     speaks only Effect's `SqlClient` -- the journal (`SingleRunner` with SQL
     runner storage), channels, session store and delivery log all run over
     it -- so the caller supplies the database and the harness names no
     driver. Still open: (b) the plan's other scenarios: the output tool,
     compaction fold and rollover, a subagent with a suspended child
     elicitation, Code Mode with a suspending executor; (c) comparing events,
     usage/`RunLedger` and claim state, not only history and counts.

     ```text
     verify: exists test/DurableEquivalence.test.ts
     verify: grep "id: \"D8\"" scripts/falsify.mjs
     verify: exists src/testing/DurableEquivalence.ts
     ```

105. **Host scheduling, captured per durable attempt (plan E13, §17) --
     first slice landed 2026-09-10.** `ToolScheduling` (kernel) lets a host
     serialize calls by key across turns and sessions, cap concurrency, or
     combine both; it wraps each call and can only make it wait, so it
     tightens the agent's strategy and cannot widen it. Under `/durable` the
     agent's strategy is journalled at a submission's first execution (the
     `execution strategy` activity), so a run recovered by a process
     configured differently runs its tools as admitted --
     `test/DurableEquivalence.test.ts` crashes a `Sequential` run and
     recovers it in a `Parallel` process. Still open: (a) I17.3, applying the
     stricter of the captured and the current permission to an undecided call
     on recovery -- needs a policy that can be re-created from data (Q6);
     (b) capturing the host scheduling's description with the attempt and
     refusing a recovery whose host would widen it.

     ```text
     verify: exists src/ToolScheduling.ts
     verify: grep "execution-strategy" src/durable/DurableAgent.ts
     verify: grep "permission: durablePermission," src/durable/DurableSubmission.ts
     ```

106. **Long-lifetime continuity evaluation (plan E14, §18) -- first slice
     landed 2026-09-10.** `affe-agent/evals`'s `Continuity`: a scenario as
     data (statements, corrections, restarts, questions with ground truth), a
     model-agnostic runner that folds repeatedly with a content-free summary and
     restarts the session between submissions (snapshot, scope closed,
     restore), and programmatic scoring -- the answer is right and not stale,
     the statement was out of the prompt the model was sent, and a
     `search_context` hit pointed at the canonical message that stated it. A
     deterministic reference model runs the standard scenario in `npm test`
     (`test/Continuity.test.ts`: 12+ folds, 3 restarts, all three questions
     pass; a no-fold control fails; breaking search over folded history fails
     it); `npm run eval:continuity` runs it against a real model and writes a
     report -- **not yet run from this machine** (no key). It pins item 109's
     limit: a correction that is the fourth mention is never found. Still open:
     kills *inside* a submission (combine with `DurableEquivalence`), more
     scenarios, and a scheduled job for the live tier.

     ```text
     verify: exists src/evals/Continuity.ts
     verify: grep "eval:continuity" package.json
     ```

107. **Durable tool contracts are versioned (plan E15, §19) -- first slice
     landed 2026-09-10.** A submission journals a SHA-256 digest of every
     tool contract it can mention at its first execution (the `tool
     contracts` activity: name, parameter/success/failure JSON Schemas, the
     `Alone` annotation -- not the description); a replay under a changed or
     removed tool is refused with `ToolContractChangedError` naming each tool
     and both digests, as an ordinary agent failure that frees the session.
     An added tool is not a conflict. A recorded `new_context` result that no
     longer decodes now dies with an explanation instead of being read as no
     request. Still open: frozen legacy definitions for control tools, so a
     recorded run can finish rather than only be refused (T15.3), and
     declared-compatible changes (Q7).

     ```text
     verify: exists src/durable/ToolContracts.ts
     verify: no-grep "if (Option.isSome(request)) {" src/compaction/Compaction.ts
     ```

108. **Checkpoints are disposable caches (plan E16, §20) -- the
     mechanics landed 2026-09-10.** A stored checkpoint that does not decode
     used to fail the turn with a `SchemaError`; it is now removed, reported
     as `CompactionCheckpointDiscarded`, and rebuilt from history (an
     unreachable store still fails -- that is infrastructure). The prefix
     fingerprint is two 32-bit lanes plus the message count instead of one
     FNV-1a lane; old checkpoints rebuild once. `AgentSession.Snapshot`
     carries `version: 1`: an unversioned one decodes as 1, an unknown one is
     refused rather than half-read. Open: the truth/snapshot/checkpoint/index
     vocabulary in `guide-durable.md` (another agent has that file open).
     Small.

     ```text
     verify: grep "CompactionCheckpointDiscarded" src/compaction/Compaction.ts
     ```

112. **Recovery snapshots for O(suffix) cold recovery (plan E20, §24).**
     Parked until 100 measures a session where cold recovery cost matters;
     104's oracle is its acceptance test.

### The next milestone (2026-09-06) — [plan-next-milestone.md](./plan-next-milestone.md)

*Decided with a second reviewer when the list ran out of work one maintainer
can do alone: the next milestone is one person choosing to use the library
again. Feature expansion is frozen until these produce an observation.*

63. **A daily consumer: the post-commit review assistant.** A separate
    consumer of the packed library that reviews a commit -- diff, the source
    and tests it needs, findings with evidence, challengeable, interruptible.
    The maintainer's own workflow is the baseline. Measured by reviewed
    commits, accepted findings, false positives and abandonments, not by
    tools exercised. First slice: one commit, one diff-to-findings path, a
    review of the next real commit beside the current one. In parallel,
    five Effect users invited to a specific trial. Medium.

    ```text
    verify: absent examples/review-assistant.ts
    ```

64. **Observe a newcomer before touching the docs.** Someone who has never
    seen the repository follows the README to a running agent, adds one tool,
    handles one failure, watched silently. Time to first result, every
    detour, every rescue, provider friction kept separate from library
    friction. The README keeps one obvious route; the package map stays as
    reference. Wrong to restructure if the participant sails through. Needs
    a person; recorded as missing evidence until one is found. Small.

    ```text
    verify: no-grep "Newcomer audit" docs/getting-started.md
    ```

65. **The public promises, reviewed.** Forty-five subpaths inspected for the
    caller's job, the dependency boundary, maturity and evidence of intended
    use; accidental exports and duplicate spellings go, optional batteries
    stay provisional. Timeboxed, and run after 63 has a caller to say which
    promises matter. The one promise known to be broken -- the durable
    workflow layer's erased requirement -- is fixed (ledger). Medium.

    ```text
    verify: no-grep "## Public promises" STATUS.md
    ```

67. **The journal compatibility promise.** State whether cross-version replay
    of a durable journal is supported before anyone consumes a new version:
    if yes, a prior-version journal becomes a recorded fixture replayed
    against the candidate; if no, an incompatible journal is detected and
    refused clearly. A `Behavior-Change:` trailer records intent, not
    compatibility. Decided when 63 produces a journal worth keeping. Small.

    ```text
    verify: no-grep "journal compatibility" docs/guide-durable.md
    ```

### Known, deliberately left

- **D4b** survives the falsification harness by construction:
  `instance.suspended` carries the correctness and the two remaining
  disjuncts in `DurableAgent`'s `catchCause` are defence in depth. Recorded in
  `plan-durability-hardening.md` and `scripts/falsify.mjs`; nobody has decided
  to delete them, and the harness will say so if that changes.
- **Legacy MCP cancellation id mismatch** — upstream; the official client's
  cancel cannot interrupt the server.
- **MCP progress notifications** (`notifications/progress` for a running
  `agent_*` tool call) cannot be sent from this adapter: upstream's
  `McpServer` hands a tool handler only its payload, so the request's
  `_meta.progressToken` never reaches it, and the server's notification
  client is internal to its constructor. Ledger, item 71. Reopens when
  upstream exposes either.
- **Anthropic example** has never been run live with a key.
- **`ClusterMultiNode` on real time** (~15 s) — H7 would move it to
  `TestClock`; cost only.
