# Plan: making the durability claims bulletproof

Fifth in the series. Unlike the others this one ports nothing — it hardens what
is already built, so that three specific promises can be made without
qualification:

1. **Accepted work is never lost.**
2. **Interrupted sessions resume automatically.**
3. **Clients reconnect without starting over.**

Today the first two hold and are tested; the third holds *on one path and not
another*, which is the kind of thing that turns a true claim into a support
ticket. The goal is not more tests. It is that every claim is written down as
an invariant, holds on every path a user can take, and has a test that fails
when the guarantee is removed.

## Where we actually stand

Established by reading the code and tests, not the docs:

- **Accepted work.** A named invariant, quoted in `STATUS.md`: *"A follow-up
  that is accepted is always executed. Rejecting it is fine; accepting and
  dropping it is not."* Admission is a single-step admit-or-refuse in both the
  memory and SQL stores, with concurrent-drain tests. It has already been
  violated once (the durable path bypassed the core gate) and fixed — which is
  better evidence than never having found a bug.
- **Resumption.** The same `Agent.make({...})` runs under
  `DurableAgent.workflow`; a resumed submission replays completed work rather
  than repeating it, a completed tool call does not fire twice, and a steer
  queued during suspension applies exactly once. Process loss is covered: a
  test tears runner A down mid-suspension and resumes on runner B over the same
  SQLite database.
- **Reconnect.** True on the durable client with `DeliveryLog` — there is a
  test named *"a consumer disconnects mid-run, the agent carries on, and it
  resumes from its offset in another process"*. **Not true on plain HTTP**:
  *"SSE is deliberately live-only… Reconnection does not imply replay or a
  durable cursor."*

## The five weaknesses this plan targets

**W1 — The claims are not written down as invariants.** The tools port has
I1–I15, each with a test that was broken once to prove it bites. Durability has
excellent prose in `STATUS.md` and no enumerated list. You cannot make
something bulletproof without first listing the bullets.

**W2 — Every crash test crashes where the author chose.** Crashes are simulated
by releasing a scope at a hand-picked point. The bugs that survive are the ones
at points nobody thought of. There is **no property-based or randomised testing
anywhere in the repository** — confirmed by search.

**W3 — Two reconnect stories, one of them silently weaker.** A user on the HTTP
adapter reasonably believes they have the durability the front page advertises.
That is a design defect, not a documentation gap.

**W4 — Storage is assumed to work.** Tests exercise concurrency and process
loss, but not a store that fails a write, half-commits, duplicates, reorders or
stalls. "Never lost" is a claim about the system *including* its storage.

**W5 — Known limits are real and unlisted at the boundary.** `DeliveryLog.live`
fans out within one process, so cross-node live delivery is unimplemented;
replayed streamed submissions re-offer deltas whose chunking the journal does
not preserve, reported as a conflict and logged at warning; the interrupt signal
is polled every 25ms; shard leases hold for 35s and that path is not
time-tested.

## The invariants

Written as the tools invariants were: each is a sentence, and each gets a test
that fails when the guarantee is removed.

**D1 — Admission is a promise.** Work reported as accepted is executed exactly
once, or the failure is reported to the caller. Refusal is always allowed;
silent loss never is.

**D2 — Resumption never repeats completed work.** Across any number of
resumptions, each completed activity — model call, tool call, side effect —
executes exactly once.

**D3 — Resumption never skips accepted work.** A submission accepted before a
crash reaches a terminal state after recovery, without operator action.

**D4 — Interruption is terminal, crash is not.** An explicitly interrupted
submission stays interrupted; a submission lost to process death resumes. The
two are never confused.

**D5 — Observation is at-least-once with a stable cursor.** A consumer that
disconnects and reconnects from its saved offset sees every event it had not
seen, in order, with no gap; duplicates are detectable by key.

**D6 — A recorded event is replay-stable.** The same event, produced again by
replay, carries the same key. A key collision with a different payload is a
conflict and is surfaced, never silently accepted.

**D7 — Storage failure degrades, it does not corrupt.** A store that fails a
write causes the caller to see a failure; it never causes work to be reported
accepted and then dropped, nor an activity to be committed twice.

**D8 — Every claim names its path.** No guarantee is advertised that does not
hold on the path the user is on.

## Milestones

### H1 — Write it down: invariants and a durability matrix

No code. D1–D8 land in the docs beside the claim they support, and a matrix
gives every claim × path a verdict and a test:

| Guarantee | In-process | `/durable` | `/cluster` | HTTP+SSE | Durable client |
| --- | --- | --- | --- | --- | --- |
| Accepted work executes | ✓ test | ✓ test | ✓ test | … | … |
| Resume after process loss | n/a | ✓ test | ✓ test | … | … |
| Reconnect from offset | n/a | … | … | **✗ live-only** | ✓ test |

Filling this in is the milestone. Empty cells are the backlog, and the `✗` is
the honest answer until H5 changes it. This single table is what stops a user
adopting the wrong path, and it is also the outline for the README copy.

**H1: landed (2026-08-24).** The matrix below. Empty cells are the backlog and
the `✗` is the honest answer until H5 changes it.

| Guarantee | In-process | `/durable` | `/cluster` | HTTP+SSE | Durable client |
| --- | --- | --- | --- | --- | --- |
| D1 Accepted work executes or is refused | ✓ `AgentSession.test` | ✓ `DurableAdmission` | ✓ `Cluster` | ✓ `DurableHttpConcurrency` | ✓ `DurableAgentClient` |
| D2 Resumption never repeats work | n/a | ✓ `Durable` | ✓ `Cluster` | n/a | ✓ `DurableAgentClient` |
| D3 Resumption never skips accepted work | n/a | ✓ `DurableAgentClient` | ✓ `Cluster` | n/a | ✓ `DurableAgentClient` |
| D4 Interruption terminal, crash resumable | ✓ `AgentSession.test` | ✓ `Durable` | ✓ `Cluster` | ✓ `DurableHttpIntegration` | ✓ `DurableAgentClient` |
| D5 Reconnect from a saved offset | n/a | ✓ `DeliveryLog` | ✓ `DeliveryLog` | ✓ `AgentHttp` (H5) | ✓ `DurableAgentClient` |
| D6 A recorded event is replay-stable | n/a | ✓ `DurableAudit` | ✓ `DurableAudit` | ✓ `DurableAudit` | ✓ `DurableAudit` |
| D7 Storage failure degrades, not corrupts | n/a | ✓ `DurableStorageFaults` | ✓ `Cluster` (defect, see below) | ✓ `DurableHttpIntegration` | ✓ `DurableAgentClient` |
| D8 Every claim names its path | this table | this table | this table | this table | this table |

**The one `✗` is W3, and it is a design defect rather than a documentation
gap.** A user on the HTTP adapter gets live-only delivery: disconnect and the
events emitted while away are gone. Until H5, the honest statement is that
reconnect-from-offset is a property of the durable client, not of the SSE
transport.

**H2: landed (2026-08-24).** Every invariant with a mechanism was broken once
and the suite re-run over nine durability test files (121 tests). Results:

| Invariant | Break applied | Verdict |
| --- | --- | --- |
| D1 | admit even when already claimed | **bites** (4 fail) |
| D2 | randomise the tool activity name | **bites** (2 fail) |
| D2b | make every occurrence look like the first | **bites** (1 fail) |
| D3 | leave an accepted-but-undispatched claim alone | **bites** (1 fail) |
| D4 | record an interrupted result as completed | **bites** (4 fail) |
| D5 | ignore the caller's `after` offset | **bites** (2 fail) |
| D6 | never notice a duplicate key | **bites** (4 fail) |
| D7 | remove the idempotency key from `claim` | **bites** (2 fail) |

**H2 found what the plan predicted it would.** D7 had no test at all.
`test/StorageError.test.ts` covers the *read* side thoroughly -- a corrupt row
decodes to a failure rather than a defect -- and nothing anywhere injected a
store that failed a **write**. Every durability test assumed storage worked,
which is precisely the assumption "never lost" is not allowed to make.

`test/DurableStorageFaults.test.ts` covers it, and the route there is worth
recording because the first version of the suite established nothing.

It injected faults by replacing an operation with a bare `Effect.fail`, so the
mutation under test never ran -- and "no claim was left behind" was true of a
store nothing had touched. Running the operation for real and *then* failing,
which is what a store that commits and loses its acknowledgement actually does,
gave a different answer: **the claim is left behind.** The caller is told it
failed; the session is claimed anyway.

The write cannot be undone -- a store that has committed has committed, and
nothing on this side reaches back through a dropped connection. What was
missing was a way for the caller to *find out*. `claim` now takes an
idempotency key, so a retry naming the same request is recognised as that
request rather than refused as a second one, and an indeterminate failure
becomes a recoverable one. A caller that omits the key gets the old behaviour,
which is pinned by its own test rather than left implied.

Also established: a failure reaching the store before its transition is
typed and leaves nothing behind, a delivery append that
fails reports rather than swallowing, an event that failed to record is absent
rather than present-and-broken, and a store failure is a *failure* rather than
a defect -- the distinction the error channel exists for, since a defect kills
the fibre under it and a caller who wanted to retry never gets the chance.

One methodological note worth keeping: the harness reverts each edit in a
`finally`. The first version did not, crashed on an encoding error partway
through, and left a broken `DurableSessionStore` in the tree -- which then
looked like four unrelated admission failures. A break-the-invariant harness
that can leave the tree broken will eventually cost more than it finds.

### H2 — Break every invariant once

The methodology that worked for the tools: for each of D1–D8, disable the
mechanism that enforces it and confirm a test fails. Any invariant whose tests
still pass is not tested — it is decorated. Expect this to find at least one,
because it did every time in the tools work.

### H3 — Property-based crash testing

The big one, and the answer to W2. `effect/testing` already exports
`FastCheck`, and `fast-check` is already installed, so this needs no new
dependency.

- **Enumerate crash points** rather than choosing them: the workflow journal
  has activity boundaries, so a run of N activities has N+1 places to die.
- **Crash at each**, deterministically, and assert D1–D4 after recovery.
- **Then randomise**: a generated schedule of crashes, resumptions, steers and
  follow-ups, replayed against the invariants. Shrinking gives a minimal
  reproduction, which is the property worth having when it fails at 3am.
- Keep the exhaustive pass in CI and the randomised pass seeded, with failures
  pinned as ordinary tests so a found bug never returns.

### H4 — Storage fault injection — **done**

A wrapper over the store interfaces — the same technique the coding toolkit
tests use for the sandbox — that can fail a write, fail a read, duplicate a
record, reorder a batch, stall, or half-commit. Run the existing durable suites
under each fault. Asserts D7, and gives D1 teeth: "never lost" should be tested
against a store that is actively unhelpful.

**Blocked until the store has an error channel to fault.**
[audit-effect-ecosystem.md](./audit-effect-ecosystem.md) E14 measured 58
`Effect.orDie` in `src/`, 33 of them in `durable/` and 17 in
`DurableSessionStore.ts` alone. `encodeHistory` and `decodeHistory` are typed
`Effect.Effect<string>` and `Effect.Effect<Prompt.Prompt>` — **no error channel
at all** — and the `sql` calls behind `get`, `create` and the claim update are
`orDie`d too.

That is a stronger claim than `unknown` in an error channel, and a false one:
decoding a history we *read back* meets truncated writes, rows from an older
schema version and half-committed transactions, and every one of them currently
becomes a defect. So does every database failure.

The consequence for this milestone is direct. **Six distinct faults produce one
observation.** A fault-injecting wrapper can prove the system noticed, and can
prove nothing about D7's actual claim — *"a store that fails a write causes the
caller to see a failure; it never causes work to be reported accepted and then
dropped."* A defect is not a failure the caller sees; it is a fiber death, and
"it died" is compatible with both halves of D7.

So H4 gains a first step: **triage the `orDie` sites in `durable/` and `state/`
into three groups** — genuinely impossible (keep, with a comment saying why), a
failure the caller must see (give it a typed error), and a failure the caller
cannot act on (still a defect, but stated at the site). The goal is not a lower
count; it is a justified one. Only then does the wrapper have something to
distinguish.

**Status: `DurableSessionStore` is done.** `durable/StorageError.ts` is a
`Schema.TaggedError`, so it crosses the journal; the store's methods declare it;
`DurableAgentClient` folds it into the existing `AgentTransportError`, leaving
`RemoteError` and the wire protocol unchanged. `DurableSubmission.isInfrastructure`
now reads a typed error instead of matching `"SqlError"` against defect `name`
strings. `test/StorageError.test.ts` asserts that distinct faults produce
distinct observations — the property this milestone needs.

**`DeliveryLog` is done too**, and it mattered most. D5 (*a stable cursor,
at-least-once, no gap*) is a claim about this component specifically, and a row
that cannot be decoded **is** the gap D5 forbids — yet while `decodeEnvelope`
was `orDie`, a reconnecting consumer met it as a dead fibre rather than as
something it could report or retry from its last sequence. `append`, `live` and
`read` now declare `StorageError`; the client's `events` stream ends with an
`AgentTransportError` instead of a defect.

One `orDie` in this path stays, deliberately.
`AgentSession.MakeOptions.eventSink` is a core seam declaring `Effect<void>`, so
`DurableSubmission`'s recorder cannot report a failed append through it — and
dying is also the right outcome, because a submission whose events were not
recorded has a gap in the client's stream and must not be reported as having
completed normally. `isInfrastructure` turns it into an `Infrastructure`
outcome, which the client reports as retryable. The typed error made that
classification reliable rather than dependent on a driver's `name` string.

**Remaining before H4 is fully unblocked:** `DurableChannels` (8 sites) and
`state/AgentState` (5). Neither carries a durability invariant of its own, so
H4 can begin against the session store and the delivery log — which is where
D1, D5, D6 and D7 actually live — while those two follow.

This is also the milestone where D7 stops being aspirational, which makes it a
better place for the work than a general cleanup pass would be.

### H4b — Does `effect/unstable/eventlog` already do this? (evaluation, no code)

**Gate on H5 and H6.** Both of those build log machinery, and the ecosystem
ships a log module we have never imported —
[audit-effect-ecosystem.md](./audit-effect-ecosystem.md) E2.

What we have is already an event log by every structural test: `AgentEvent`
envelopes carrying session-local sequence numbers, a canonical history committed
per turn, `Snapshot`, and a `DeliveryLog` with `read({ after })`. D5 (*a stable
cursor, at-least-once, no gap*) and D6 (*replay-stable keys*) are not agent
invariants; they are the invariants **any** event log states about itself. When
two designs converge that hard, one of them is usually re-deriving the other.

The evaluation answers three questions in writing, before H5 wires
`Last-Event-ID` and before H6 builds cross-node fan-out:

1. Does `eventlog` subsume `DeliveryLog` — cursor semantics, at-least-once
   delivery, key-based duplicate detection — or only overlap it?
2. Does it close W5's cross-node gap, which is the expensive half of H6 and the
   usual reason a project reaches for a log module?
3. Does it force a representation on the canonical history? If adopting it means
   the committed `Prompt` stops being the source of truth, the answer is no
   regardless of the other two, because that trades the thing this library is
   built around for plumbing.

**Any of the three answers is acceptable, including "no, because".** What is
not acceptable is shipping a second hand-rolled log and discovering the module
afterwards. Record the verdict here; audit invariant A3 requires it in writing,
and A1 requires that adoption — if it happens — *deletes* `DeliveryLog` rather
than joining it.

A related, smaller question rides along: `state/AgentState.ts` and
`durable/DurableChannels.ts` each define their own `interface Store`, and
`effect/unstable/persistence` is the module for that (audit E3). The interfaces
are fine; the cost is the N backings behind them, which H4's fault injection
would then only have to be written against one seam.

### H5 — Resumable SSE, closing the reconnect gap — **done**

It was smaller than it looked in one sense and larger in another. The wiring
was indeed trivial: `Last-Event-ID` is echoed by any `EventSource` without help
from page code, the ids already were the envelope's sequence, and
`DeliveryLog.read({ after })` already existed. `AgentClient.events` became a
function taking `{ after }`, `EventsRequest` carries it, and the HTTP adapter
reads the header (with `?after=` for callers that cannot set one).

The part that was not trivial is the **join**. A resumption is a read of what
was missed plus a subscription for what comes next, and an event recorded while
the read is in flight belongs to neither by default. Subscribing first and
reading second is the only safe order — it can duplicate, and duplicates are
removable where gaps are not — but "subscribe" has to *mean* something: a
`Stream` subscribes when it is first pulled, so handing `live` to a queue only
forks something that will subscribe eventually, and the read races that fork.
The first implementation did exactly this and lost events.

`DeliveryLog` therefore grew `subscribe`: a subscription **established before
the effect returns**. All three logs implement it by their own means — a real
`PubSub.subscribe` in memory, a captured `MAX(sequence)` cursor in SQL, a
synced offset in durable-streams — and the client cuts the resulting overlap by
sequence.

Where a session has no delivery log, resumption fails rather than returning a
live stream: a caller reconnecting from 41 and silently handed events from 60
has lost eighteen and cannot find out.

### H6 — Cross-node live delivery

`DeliveryLog.live` fans out in one process. Multi-node is where durability
claims are actually tested, so this closes the honest gap over `read({ after })`
as `STATUS.md` already anticipates. Runs the existing `DeliveryLogContract`
plus the cross-process tests against a multi-node fixture.

### H7 — Time-dependent paths, on `TestClock`

Shard leases hold for 35s; a real-time test is unaffordable and therefore
absent. `TestClock` is already used in `Scheduling.test.ts`. Bring lease
expiry, reassignment-during-call, and the 25ms interrupt poll under virtual
time so those paths are tested in milliseconds and deterministically.

### H8 — Settle the delta-chunking conflict

A replayed streamed submission re-offers deltas whose chunking the journal does
not preserve; the log reports a conflict and warns. That is a **known false
positive**, and false positives train people to ignore the alarm that matters
(D6). Decide deliberately: make replay re-chunk deterministically, exclude
deltas from conflict detection by keying them differently, or keep the warning
and document it as expected. Any of the three is fine; leaving it ambiguous is
not.

### H9 — Soak

One long-running test: hundreds of submissions, dozens of resumptions,
consumers connecting and disconnecting throughout, asserting D1–D6 continuously
rather than at the end. Catches leaks and slow drift that scenario tests never
will.

## Success conditions

- **SD1:** ✓ The matrix has no empty cells. Every claim × path is ✓ with a
  test, ✗ with a documented reason, or n/a.

  D7's three remaining cells were the last of them, and they do not all say
  the same thing:

  - **Durable client** -- a `StorageError` becomes an `AgentTransportError`, so
    the caller gets a value it can retry or fail over on. A defect could not be
    caught and would take the calling fibre with it.
  - **HTTP+SSE** -- that error maps to 503, and the server keeps serving. The
    test calls again afterwards, which is the difference between degrading and
    falling over.
  - **`/cluster`** -- **weaker, deliberately, and the cell says so.** The
    entity's handlers implement an `Rpc` whose error schema declares
    `AgentIdleError` and nothing else, so a store failure is converted to a
    defect and carried by the cluster's transport-versus-declared-error
    distinction rather than by a typed error of its own. The caller is told,
    which is what D7 requires; it is not told in a form it can pattern-match,
    which widening the wire contract would fix. That is the open half of E14
    and belongs to whoever owns the protocol.

  All three fail when the guarantee is removed: letting the client's store
  errors die, and letting the entity swallow a failed offer.
- **SD2:** Each of D1–D8 has a test that fails when the guarantee is removed,
  demonstrated by actually removing it.
- **SD3:** Every activity boundary in a representative run is exercised as a
  crash point, and the count is asserted so new activities cannot silently go
  untested.
- **SD4:** The existing durable suites pass under write-failure,
  duplicate-record and reorder faults.
- **SD5:** ✓ A browser `EventSource` reconnect resumes from `Last-Event-ID` with
  no gap and no duplicate, tested end to end. `AgentHttp.test.ts` covers the
  header, the `?after=` fallback and an unparseable id; `DurableAgentClient
  .test.ts` covers the join, driving an append on each side of the catch-up
  read so one assertion catches both a gap and a duplicate. Both directions
  fail when the guarantee is removed.
- **SD6:** No known limit remains unlisted at its boundary: every one is either
  fixed or documented where a user meets it, not only in `STATUS.md`.

## What this plan does not claim

Honesty about the ceiling, because "bulletproof" invites overclaiming:

- **Testing bounds the claim, it does not prove it.** Property-based crash
  testing explores far more of the space than scenario tests, but the space is
  infinite. What it buys is that the *reachable* failures are the ones nobody
  has thought of yet, not the ones anybody would have.
- **We inherit our storage's guarantees.** If the database loses an
  acknowledged commit, D1 fails and no amount of our testing changes that. What
  we can do is not add loss of our own, and be explicit that durability is
  bounded by the store.
- **Clock skew and partition are only modelled.** `TestClock` proves logic under
  time; it does not prove behaviour under a real partition with real skew.
- **This is a `0.0.1` library.** Every guarantee here is tested, including
  against real SQL and across processes. "Tested" and "proven in production"
  are different claims, and the second is earned rather than planned.
