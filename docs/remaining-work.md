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
    `plan-two-decisions.md`). **A real model landed 2026-09-06** as the first slice
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

### Newly ranked — from the real-model entry (2026-09-06)

62. **A model layer that fails to build is an empty 500.** Found writing
    `test/WorkerRealModel.test.ts`: when the Durable Object cannot build the
    agent's model layer (the secret missing, so
    `Binding.BindingNotFoundError`), opening the session answers a bare
    status with no body. The error names the binding, but only in the
    Worker's log, and a deployer following the quickstart sees nothing.
    `CloudflareHost.make` builds the layer inside the object; the failure
    should reach the HTTP surface as a typed protocol error with the
    binding's name, the way every other refusal does. Small; a row in the
    real-model test asserts the body once it does.

    ```text
    verify: grep "Recorded as a finding (item 62)" test/WorkerRealModel.test.ts
    ```

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
