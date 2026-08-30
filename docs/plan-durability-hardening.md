# Plan: making the durability claims bulletproof

Fifth in the series. Unlike the others this one ports nothing — it hardens what
is already built, so that three specific promises can be made without
qualification:

1. **Accepted work is never lost.**
2. **Sessions lost to process failure resume automatically.**
3. **Clients reconnect without starting over.**

Accepted work, multi-node recovery, and reconnect-from-offset now hold on their
named paths. `test/ClusterMultiNode.test.ts` proves owner loss during an active
model call and the N+1 journal-boundary recovery sweep; the single-runner path
remains exactly what its name says and does not advertise peer failover. The
goal is not more tests. It is that every claim is written down as an invariant,
holds on every path a user can take, and has a test that fails when the
guarantee is removed.

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
  queued during suspension applies exactly once. Parked recovery, active model
  failover, and every pre/post-activity journal position are covered. The
  latter two use two real HTTP runners with shared SQL cluster storage.
- **Reconnect.** True on the durable client with `DeliveryLog` — there is a
  test named *"a consumer disconnects mid-run, the agent carries on, and it
  resumes from its offset in another process"*. H5 also made it true on HTTP
  when a delivery log is configured: `Last-Event-ID` (or `?after=`) resumes
  from the saved sequence, and a resumptive request fails rather than silently
  degrading to live-only delivery if no log exists.

## The five weaknesses this plan originally targeted

**W1 — The claims are not written down as invariants.** The tools port has
I1–I15, each with a test that was broken once to prove it bites. Durability has
excellent prose in `STATUS.md` and no enumerated list. You cannot make
something bulletproof without first listing the bullets.

**W2 — Every crash test crashes where the author chose.** Closed by H3. The
suite discovers the representative activity count, runs all N+1 pre/post
positions, then runs seeded `FastCheck` schedules of crash positions,
resumptions, steers and follow-ups. A failure is shrunk and its minimal schedule
is pinned as an ordinary regression.

**W3 — Two reconnect stories, one of them silently weaker.** At the start of
the plan, a user on the HTTP adapter reasonably believed they had the durability
the front page advertised. H5 closed that design defect.

**W4 — Storage is assumed to work.** Closed by H4. The tested contract is typed
failure before mutation, commit with a lost acknowledgement, idempotent retry,
duplicate/conflict detection, and ordered reads. The original draft's stall and
arbitrary batch-reordering matrix is explicitly outside D7; the decision and
rationale are recorded under H4 rather than left as an accidental omission.

**W5 — Known limits are real and unlisted at the boundary.** Closed. H5 and H8
settled reconnect and delta replay, SQL plus Durable Streams pass a
cross-process live-delivery contract, and H6 names the topology boundary:
multi-node runners recover owner loss; `SingleRunner` does not imply peers.

## Completion audit — 2026-08-26

All implementation workstreams and the acceptance-criteria decision are now
closed. H4b's ecosystem evaluation is recorded below.

| Work | Result |
| --- | --- |
| H3 crash/property testing | Ten representative activities produce eleven deterministic suspension positions. Seeded `FastCheck` schedules add repeated resumes, steers and follow-ups, with shrinking and a pinned counterexample. |
| H4 fault scope | Narrowed explicitly to D7's observable storage guarantees: typed pre-mutation failure, indeterminate commit, idempotent retry, duplicate/conflict detection and ordering. |
| H6 multi-node recovery | Two HTTP runners form over shared SQL storage; a peer takes over during an active model call without repeating it. |
| H9 soak | 208 submissions, 24 resumptions, 8 terminal interrupts and 300 reconnectable delivery events run in the bounded CI soak. |

The H6 root cause was a recursive sharding runtime hidden inside
`HttpRunner.layerHttpClientOnly`. Health now uses the lower-level
`Runners.layerRpc`, so the serving sharding runtime is the only one assigning
shards. The fixture has no skip left.

H3 found a real admission bug. A steer accepted just after a completed drain
was consumed by process-local session cleanup when the workflow suspended, so
the peer never saw it. `SessionState.acceptingSteering` and
`InputChannel.Factory.setSteeringAdmitting` (`${sessionId}:steering:open` in
the durable store) now close admission before the final drain. Input queued
before that close gets a future sequential run without overriding the stopped
run's loop policy; input after it is refused. Durable
release also leaves queues untouched while the workflow is suspended. The
minimal schedule is an ordinary regression beside the seeded property.

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

*Amended (issue #77).* `DurableAgent.workflow` held this only by delegating to
`Workflow.interrupt`, which the engine implements as **mark and resume**: it
sets a flag and forks a replay that knows nothing about why it was restarted,
and the replay ran to completion. An interrupted submission therefore finished
*successfully*. The test that should have caught it could not: it polled at the
instant the engine had forked and recorded no exit, so `poll` returned `None`
every time and its assertion was vacuous.

`DurableAgent.workflow` now carries the recorded-intent mechanism
`DurableSubmission` already had. `DurableAgent.interrupt(store, sessionId)`
writes the intent to the channels store, under a session-scoped key (this
module's idempotency key is the session). The body observes it in two places --
once at the top, before anything runs, so a replay resumed in any process
cannot finish first, and once per tick from a forked poller -- and delivers it
through `AgentSession.interrupt`, so committed turns stay committed. Because a
session absorbs interruption by design, `prompt` returns *normally* with the
partial text; every terminal branch therefore consults the intent before it
believes the outcome, and converts it into a typed `DurableAgentFailure` tagged
`SubmissionInterrupted`. The intent is peeked and never cleared: taking it
would let a crash between the take and the recorded outcome replay into a body
that finds nothing and completes.

**D5 — Observation is at-least-once with a stable cursor.** A consumer that
disconnects and reconnects from its saved offset sees every event it had not
seen, in order, with no gap; duplicates are detectable by key.

**D6 — A recorded event is replay-stable.** The same event, produced again by
replay, carries the same key. A key collision with a different payload is a
conflict and is surfaced, never silently accepted.

**D7 — Storage failure degrades, it does not corrupt.** A store that fails a
write causes the caller to see a failure; it never causes work to be reported
accepted and then dropped, nor an activity to be committed twice.

*Amended (issue #78).* The recovery half of this was unreachable. `Claim.key`
closes the crash window where a claim commits and its acknowledgement is lost,
but no caller in `src/` ever supplied one -- only the store's own unit tests
did, so the "bites" verdict below was narrower than it read. `RemotePromptOptions`
now carries `idempotencyKey`, and `DurableAgentClient` forwards it to
`sessionStore.claim` as `key`, spread rather than passed as `undefined` because
absent means "no idempotence". Covered at the client level by
`a retry under the same idempotency key rejoins the claim it already made`;
dropping the forward turns that retry back into `AgentBusyError`.

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
| D3 Resumption never skips accepted work | n/a | ✓ `ClusterMultiNode` journal sweep | ✓ `ClusterMultiNode` owner loss | n/a | ✓ parked/reconciled; active client takeover is not separately claimed |
| D4 Interruption terminal, crash resumable | ✓ `AgentSession.test` | ✓ interruption, boundary recovery and owner loss | ✓ interruption and owner loss | ✓ `DurableHttpIntegration` on the parked path | ✓ explicit interruption and parked recovery; active client takeover is not separately claimed |
| D5 Reconnect from a saved offset | n/a | ✓ `DeliveryLog` | ✓ `DeliveryLog` | ✓ `AgentHttp` (H5) | ✓ `DurableAgentClient` |
| D6 A recorded event is replay-stable | n/a | ✓ `DurableAudit` | ✓ `DurableAudit` | ✓ `DurableAudit` | ✓ `DurableAudit` |
| D7 Storage failure degrades, not corrupts | n/a | ✓ `DurableStorageFaults` | ✓ `Cluster` (typed `StorageError` on the wire since 2026-08-30) | ✓ `DurableHttpIntegration` | ✓ `DurableAgentClient` |
| D8 Every claim names its path | this table | this table | this table | this table | this table |

**Historical note.** The one `✗` when H1 landed was W3: HTTP delivery was
live-only. H5 closed it. The current matrix instead avoids turning H6's tested
`DurableAgent.workflow`/cluster takeover into an untested claim about every
adapter; the durable client and HTTP rows state their focused parked-path
coverage.

**SD2 re-run: 2026-08-28.** The 2026-08-24 table below was evidence about code
that had since been rewritten — conditional writes, resumable SSE and
multi-node takeover all landed after it, and the suite grew from 121 tests to
1389. Re-running it is now `scripts/falsify.mjs`, so it is repeatable rather
than a thing someone has to remember to redo.

Against a green baseline of 190 tests over eleven durability files:

| Invariant | Break applied | Verdict |
| --- | --- | --- |
| D1 | admit even when already claimed (both stores) | **bites** (7 fail) |
| D2 | randomise the tool activity name | **bites** (4 fail) |
| D2b | make every occurrence look like the first | **bites** (2 fail) |
| D3 | leave an accepted-but-undispatched claim alone | **bites** (1 fail) |
| D4 | record an interrupted result as completed | **bites** (4 fail) |
| D4b | convert an interrupted run into a typed durable failure | **survives** |
| D5 | ignore the caller's `after` offset | **bites** (3 fail) |
| D6 | never notice a duplicate key | **bites** (2 fail) |
| D7 | remove the idempotency key from `claim` (both stores) | **bites** (2 fail) |

Every verdict the original table recorded still holds, and D1 and D2 now bite
harder (7 and 4, against 4 and 2) because the breaks reach both store
implementations and the suites around them have grown. **The guarantees that
were enforced in August are still enforced.**

**D4b is the one finding, and it is narrower than it first looked.**
`DurableAgent` discriminates an interrupt from a failure before deciding
whether to propagate the cause or convert it to a typed `durableFailure`:

```ts
instance.suspended || instance.interrupted || Cause.hasInterruptsOnly(cause)
  ? Effect.failCause(cause)
  : Effect.fail(durableFailure(cause))
```

Removing the two interrupt disjuncts changes nothing any of the 1389 tests can
see. Probing the one scenario that exercises it — `Durable.test.ts`'s
"an interrupted submission reaches a terminal state and stays there" —
`definition.poll` returns `Option.none()` **both** with the guard and without
it, so the two paths are indistinguishable there.

That leaves two possibilities, and this pass does not settle which:

1. The interrupt disjuncts are redundant, because an interrupt at this point
   already leaves the execution non-terminal by another route. `suspended` —
   the disjunct with the documented hang hazard — is separate and *is* still
   load-bearing; it was not part of the break.
2. They matter in a scenario nothing constructs: an interrupt arriving while
   the workflow is *running* rather than parked on a gate.

Deliberately not "fixed" by writing a test to match. A test asserting a
difference that the probe says is not observable would be a test of nothing,
and the existing assertion is already weak in the way that let this through —
`isFalse(Complete && isSuccess)` passes for a failure exit just as it does for
an interrupt. Whoever owns this branch should decide whether it is dead code or
under-tested; both answers are cheap once the question is stated.

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

### H3 — Property-based crash testing — **done**

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

`ClusterMultiNode.test.ts` now does all four. Its representative run discovers
ten completed activities and executes the eleven positions before the first
and after each completion. The generated schedules vary that position, accepted
or refused steering/follow-up input, and repeated resume requests. The fixed
seed is `0x5eed`; FastCheck's counterexample path is reported on failure and the
steering-loss counterexample it found is pinned outside the generator.

### H4 — Storage fault injection — **done; focused scope chosen**

The accepted fault model is the one D7 can observe and act on: fail before a
read or write, commit and lose the acknowledgement, retry the same idempotency
key, replay a duplicate, surface a conflicting payload, and preserve the
store's declared ordering. `test/storageFaults.ts`,
`DurableStorageFaults.test.ts`, `StorageError.test.ts`, and the delivery-log
contracts cover those transitions.

The original draft also listed arbitrary stalls, batch reordering, and running
every durable suite beneath every injected fault. That broader matrix is not
the criterion. A stall has no defined outcome without a timeout/retry policy,
so inventing one here would hide a policy decision behind a test default;
arbitrary reordering violates the ordered store contract rather than modelling
an ambiguous commit. Focused contract tests give each supported fault an exact
assertion and keep unrelated durable suites from multiplying the same cases.
This is an explicit narrowing, not an unimplemented promise.

**Historical prerequisite, now closed: the store needed an error channel to
fault.**
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

**Historical blocker, now closed:** `DurableChannels` and `state/AgentState`
were the remaining `orDie` triage sites when this paragraph was written. Both
now expose typed storage failures; `docs/audit-effect-ecosystem.md` records the
decision. H4 is unblocked across every store. The H4 section above records
the focused fault contract selected for H4 and why the undefined stall and
contract-breaking reorder cases are not acceptance criteria.

This is also the milestone where D7 stops being aspirational, which makes it a
better place for the work than a general cleanup pass would be.

### H4b — Does `effect/unstable/eventlog` already do this? (evaluation, no code) — **done**

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

**Verdict (2026-08-26): retain `DeliveryLog`; do not adopt EventLog here.** The
overlap is real but stops before the invariants this package needs:

1. `EventJournal.write` creates a fresh UUIDv7 `EntryId`. Its `primaryKey`
   groups an event's aggregate and detects conflicts during remote replay; it
   is not a caller-supplied idempotency key. Offering the same semantic agent
   event twice therefore creates two local entries. `DeliveryLog.append`
   instead takes the recorder's replay-stable key and distinguishes
   `Duplicate` from `Conflict` by comparing the offered payload.
2. EventLog exposes the whole local journal plus a process-local changes
   subscription. Its remote protocol has a replication sequence, but that
   sequence belongs to a remote/store replication session. It is not the
   monotonic per-agent-session integer that is emitted as SSE `id`, persisted
   in `Last-Event-ID`, and accepted by `read({ after })`. An adapter would need
   to add exactly the key index and cursor allocator `DeliveryLog` already is.
3. EventLog's remote server can replicate and stream journal entries, but it
   does not provide cluster runner health, shard lease reassignment, or
   redelivery of an in-flight workflow request. It therefore does not close
   H6. SQL `DeliveryLog` and `DurableStreamsDeliveryLog` already pass the
   two-instance `crossProcessLive` contract without adding EventLog's identity,
   encryption, handler and replication machinery.
4. EventLog would not inherently force canonical history away from `Prompt`,
   but it would add a second event-processing runtime beside the workflow
   journal and delivery ledger without deleting either. That fails audit A1's
   deletion test and adds no invariant this plan still lacks.

Revisit only if EventLog gains caller-supplied idempotency keys and
per-aggregate cursor reads, or if the product later needs its offline
client-replication protocol for an independent feature. Canonical `Prompt`
history remains untouched.

**Persistence verdict: retain both package-specific store seams.** The apparent
duplication is superficial:

- `DurableChannels.Store` is an ordered queue with atomic `offerIfOpen`, drain,
  size and gate transitions. `KeyValueStore` has no atomic conditional enqueue
  or ordered multi-value drain, and its default `modify` is a read followed by
  a write rather than the SQL transaction the admission invariant requires.
- `AgentState.Store` is intentionally the smallest bring-your-own persistence
  boundary: two string operations whose failures are normalised to the
  library's `StorageError`. Replacing it with the much wider
  `KeyValueStore` service would be a public break, expose an ecosystem-specific
  error, and would not delete the swap-and-persist semaphore or schema codec.
  Its two built-in backings already exist, so an adapter would add a third path
  rather than remove one.
- `NodeStore` is different: it needed ordinary keyed persistence backings and
  could use `KeyValueStore` as a substrate while keeping tree indexing in its
  domain adapter. That adoption does not imply that a transactional queue is a
  key-value map.

The answer to H4b is therefore “overlap, not substitution” for both evaluations.

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

### H6 — Multi-node recovery and cross-node live delivery — **done**

`DeliveryLog.live` fans out in one process. Multi-node is where durability
claims are actually tested, so this closes the honest gap over `read({ after })`
as `STATUS.md` already anticipates. Runs the existing `DeliveryLogContract`
plus the cross-process tests against a multi-node fixture.

`test/ClusterMultiNode.test.ts` uses `HttpRunner.layerHttp`,
`RunnerHealth.layerPing`, and shared SQL message/runner storage. Two nodes
register the same workflow, a submission dispatched through either completes,
and closing the owner while its model activity is in flight causes the peer to
acquire the shard and finish. The owner and peer model recorders each show one
call: unfinished work is redelivered and completed work is not repeated.

The fixture originally bound both servers and left every submission pending.
The cause was `layerHttpClientOnly`: using it to satisfy the health layer also
built a second sharding runtime. Health now receives `Runners.layerRpc` over
the HTTP client protocol and shared message storage, which breaks the layer
cycle without constructing another sharder.

Cross-process tailing remains covered by the focused SQL and Durable Streams
delivery-log contracts. H6 proves the topology and takeover concern rather
than duplicating those log tests.

### H7 — Time-dependent paths, on `TestClock` — **mostly moot; capability pinned**

The premise was that these paths are absent because a real-time test is
unaffordable. Measuring first dissolved most of it:

- **The 25ms interrupt poll is already tested**, by four cases across
  `Durable.test.ts` and `DurableAgentClient.test.ts`, and they run in 627ms
  together. There was no expensive test here to make cheap.
- **The durable suites are not slow.** Re-measured after H6 landed: 2.0s
  (`Cluster`), 3.2s (`Durable`), 3.8s (`DurableAgentClient`), 11.9s
  (`DurableAgentClientSql`), 8.0s (`DurableHttpIntegration`) -- and the slow
  ones spend it on deliberate `sleep`s for shard leases, not on polling.
- **Lease expiry and reassignment were untested, and not because of time.**
  They need a second runner to reassign *to*, and `SingleRunner` has no-op
  runner health checks -- it never concludes a peer has died and never moves a
  shard, so the scenario could not occur at any speed.

  **H6 has since closed this**, and the answer it gave is the one that
  mattered: in a real topology a peer *does* take over a submission whose owner
  is lost mid-activity. The single-runner behaviour measured here -- 75 seconds
  of nothing -- was the topology and not the product, which was the open
  question at the time this was written.

What survived was the piece H6 stood on, pinned by
`DurableVirtualTime.test.ts`: **the cluster's timing goes through Effect's
`Clock`**, so a `TestClock` drives it. `Sharding` reads
`clock.currentTimeMillisUnsafe()` rather than `Date.now()`. A full durable
submission completes in ~86ms of virtual time, which is what makes a multi-node
fixture viable -- one that had to wait out real 35-second leases per
observation would not be a test anyone runs.

The test is deliberately small. It was a load-bearing assumption for the next
milestone, and an assumption earns a test exactly when something is about to be
built on it.

**What is left of H7 is a cost question, not a coverage one.**
`ClusterMultiNode.test.ts` runs in real time at ~15s for three tests, which is
the most expensive file in the suite. Driving it on the `TestClock` this
section pinned would shrink that, and is worth doing if the multi-node fixture
grows -- but nothing is untested for want of it.

### H8 — Settle the delta-chunking conflict — **done**

Settled by the second option: `DurableSubmission`'s recorder warns on a
conflict only when the event is *not* a `MessageDelta`. The first run streams
the provider's chunks live and a replay re-expresses the journalled text as one
chunk, so the payloads differ under the same key -- expected, and the log keeps
the first either way. A conflict on any other event is a recorder disagreeing
with itself about a lifecycle fact, which is what the warning is for.

Recorded here because the milestone was written as though the decision were
still open; the code had already made it.

### H9 — Soak — **done**

One long-running test: hundreds of submissions, dozens of resumptions,
consumers connecting and disconnecting throughout, asserting D1–D6 continuously
rather than at the end. Catches leaks and slow drift that scenario tests never
will.

`DurabilitySoak.test.ts` is the bounded CI soak: 208 accepted submissions share
one engine, 24 park and resume, 8 are explicitly interrupted and remain
terminal after a later resume request, and the remaining 176 execute normally.
Exactly 200 model calls occur. A separate 300-event workload repeatedly saves
only part of the available tail and reconnects from that cursor while also
checking duplicate and conflict outcomes. It covers D1–D6 without sleeps and
runs in a few seconds rather than becoming an opt-in test nobody executes.

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
- **SD2:** ✓ (2026-08-28) Each of D1–D8 has a test that fails when the
  guarantee is removed, demonstrated by actually removing it — eight of nine
  breaks bite; see the re-run table above. `scripts/falsify.mjs` makes this
  repeatable, which matters more than the one result: the previous table went
  stale silently because nothing re-ran it. The single survivor, D4b, is
  recorded there with what the probe showed and what it does not settle.
- **SD3:** ✓ `ActivityBoundaries.test.ts` pins the boundary families, while
  `ClusterMultiNode.test.ts` discovers ten completed activities and executes
  all eleven pre/post positions. Its seeded, shrinking FastCheck property adds
  resumes, steers and follow-ups. A separate owner-loss test closes a runner
  during the model activity and observes peer takeover without a repeated call.
- **SD4:** ✓ The focused D7 fault contract covers typed pre-mutation failure,
  commit-with-lost-acknowledgement, idempotent retry, duplicate/conflict
  handling and ordering. H4 records why undefined stall policy and arbitrary
  contract-breaking reordering are not acceptance criteria.
- **SD5:** ✓ A browser `EventSource` reconnect resumes from `Last-Event-ID` with
  no gap and no duplicate, tested end to end. `AgentHttp.test.ts` covers the
  header, the `?after=` fallback and an unparseable id; `DurableAgentClient
  .test.ts` covers the join, driving an append on each side of the catch-up
  read so one assertion catches both a gap and a duplicate. Both directions
  fail when the guarantee is removed.
- **SD6:** ✓ (2026-08-28) No known limit remains unlisted at its boundary.

  The three limits `STATUS.md` names were already at theirs and stayed there:
  `DeliveryLog.live`'s single-process fan-out (`DeliveryLog.ts`, twice — the
  module header and `live` itself), the replayed-`MessageDelta` conflict
  (`DurableSubmission.ts`, at both the shape and the branch that tolerates it),
  and the 25 ms interrupt poll (`DurablePolling.ts`, now with every default
  listed beside it).

  The sweep found the gaps somewhere else. Every one was in `/toolSource`,
  which is the newest module and the least exercised — the same correlation the
  review findings showed:

  | Limit | Was | Now |
  | --- | --- | --- |
  | `select` length (4096) | bare literal, twice | `MAX_SELECT_CHARS`, with why it is bounded apart from the operation |
  | operation length (8192) | bare literal, twice | `MAX_OPERATION_CHARS`, documented as a backstop rather than a policy |
  | URL length (2048) | bare literal | `MAX_URL_CHARS`, with the reason a local refusal beats an opaque 414 |
  | `$ref` depth (32) | bare literal | `MAX_REF_DEPTH`, distinguishing the cycle guard from the depth guard |
  | header name/value truncation | undocumented `.slice()` | named, and the silent truncation justified — a credential never arrives this way |
  | error `detail` truncation (500) | one-line comment | named, and it says the untruncated value stays on `ToolError.error` |
  | `GraphQLOptions` / `OpenApiOptions` | **no JSDoc at all** | every field documented with its default |

  The options interfaces were the real find. A caller meets `maxResponseBytes`
  and `timeout` directly, and nothing told them what they got by omitting one —
  which is exactly the shape SD6 names: a limit that exists, is reachable, and
  is written down nowhere the person hitting it will look.

  Also documented at its boundary: `AgentMcp`'s ticket retention, which borrows
  `host.maxSessions` for a different purpose than the host uses it for, and now
  says what a caller actually loses when it evicts.

  Checked and already sound: `AgentSessionHost.maxSessions` /
  `maxRequestsPerSession`, `Truncate.MAX_LINES` / `MAX_BYTES`,
  `Compaction`'s 1024-session checkpoint bound, `EntityClient`'s retry window
  against the 35 s shard lease, `ToolExecution.MAX_RENDERED_FAILURE`, Slack's
  300-second replay tolerance, and the A2A push-URL policy.

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
