# Plan: after streaming -- what the streaming work suggests changing

*2026-09-06. `plan-streaming.md` shipped in one day: P1 to P5 and items 68
to 73. This records what the work suggested about the design around it,
ranked, with a second reviewer's opinion appended. Nothing here blocks;
the first and fourth are what I would do next.*

## 1. Two orderings are said, not proved

Subscribe-before-submit is the property P1 exists for. It was broken twice
and did not bite: in-process because admission publishes nothing before the
receipt returns, and in the durable client because a workflow starts slowly
enough that the log subscription lands first. The ledger says so. A refactor
that changed either schedule would silently lose the property and no row
would notice.

*Proposal:* a test-only seam that makes the ordering observable. In-process,
a bus that publishes the submission's first envelopes synchronously during
admission (a `Compaction.failpoints`-style hook on `EventBus`), so
subscribing after `submit` provably misses `SubmissionStarted`. Durable, a
`DeliveryLog` decorator whose `subscribe` returns only after a gate, with
the workflow started before it opens. Then the two breaks bite. Small.

## 2. `RemoteSession` is wide, and `stream` is derivable

`prompt`, `submit`, `awaitSubmission`, `events`, `stream`: every fake in the
suite had to grow a member for item 72, and each transport implements
`stream` by the same derivation from `submit` and an established `events`.

*Proposal:* keep `stream` on the interface for callers, but make the
implementation one function -- `AgentClient.streamFrom` already is -- and
let a client *declare* the one fact it turns on: "my `events()` subscription
is established before the stream is returned". The conformance option
`streamsSubmissions` then goes away, replaced by a capability the client
states about itself and the contract checks both ways. Medium, mostly
deletion.

## 3. Refusals happen at first use

A durable client with no log refuses `stream`; the HTTP client refuses
`events({ after })`. Honest, and late: a deployment learns at the first
request. *Proposal:* a capability record on the client (`resumesEvents`,
`streamsSubmissions`), fixed at construction, so wiring can assert it and
the contract reads it rather than a test option. Pairs with §2. Small.

## 4. Retention has its trigger now

P4 measured retention and deferred bounding until "a long-lived remote
subscription whose peer stops reading". `POST /sessions/:id/stream` over SSE
is exactly that subscription. The SSE body is bounded, but the bus
subscription behind it is not, and a reader that stalls holds every envelope
until the connection dies.

*Proposal:* a bounded observation seam, not a sliding bus. A subscriber that
lags past `maxLag` envelopes is disconnected explicitly with a typed error
naming the last sequence it received, and resumes from the journal with
`events({ after })` where a log exists. Sliding raw deltas corrupts text and
JSON; disconnecting is the honest bound. The sink (journal) is unaffected.
Medium; measure again after.

*Done 2026-09-07, as the reviewer reshaped it, in three attempts.* The bound
is `maxObservationLag` on `AgentClient.layer`, `fromSession`,
`DurableAgentClient` and the Cloudflare host (defaults 2048 envelopes /
8 MiB of wire JSON); past it the stream fails with
`AgentObservationLagError { lastDelivered, retained, bounds }` and the
subscription is released. In-process it is enforced **by the publisher**:
`EventBus.subscribeEvents` with a bound registers a watcher, and after each
publish the bus reads every watched subscription's exact backlog, charges
the envelope's wire size once, and closes a lagging subscription's own
scope from its side, so the backlog is freed at once and the consumer's next
pull finds the failure. For a delivery log, `Observation.bounded` pumps the
log's established subscription into a counted queue. The two rejected
designs are recorded in `internal/observation.ts`: a pump around the host's
stream moved the subscription one fibre hop later than `events` promised
and the A2A elicitation listener missed its request (four rows caught it);
a per-pull race against a kill signal made the host's own record read one
hop stale (two rows caught it). The host passes the failure through, the
SSE failure frame carries it, status 503 where a status is needed. Rows:
the envelope bound ends a stalled observer by the publish that took it past
the bound while the run completes and the record resumes after
`lastDelivered`; the byte bound ends it before the envelope bound would;
the default bound does not end an ordinary consumer and the record holds
the run. Broken once by disabling the check: both bound rows time out.

## 5. `DelegatedEvent` cost the envelope its inferred types

Nesting an envelope made the schema recursive, so `AgentEventEnvelope` and
its encoded form are written-out interfaces held equal by a row, and the
nested envelope must go through the JSON codec (found in review). Safe, and
a tax on a type that changes.

*Alternative:* carry the child's envelope in its JSON-encoded form with a
typed decode helper, since it only ever crosses as JSON, and keep the
envelope schema non-recursive. Trade: consumers decode one level on demand.
Decide once; either is fine.

## 6. A nameless `ToolCallDelta` is nearly useless

`name` is optional because a provider may skip `tool-params-start`. The
AG-UI projection drops such fragments. *Options:* resolve the name from the
toolkit when the id later matches a `tool-call` (too late for a UI), buffer
fragments until named (adds state), or document it as a provider defect and
keep dropping. I lean to the last, with a metric.

## 7. A2A always streams now

The adapter prompts with `stream: true` for every request so the answer
forms as artifact chunks. That moves every A2A prompt from `generateText` to
`streamText`, and providers differ between the two. *Proposal:* a
`serverLayer` option, streaming by default, batch as the escape hatch.
Small.

## 8. Item 73 suggests an audit

A tool defect failed an in-process run and completed a durable one, found by
accident. Everywhere the durable path reifies an outcome as a journal value
and re-raises it is a place the two can drift: permission decisions,
elicitation timeouts, model failures, unresolved tools. *Proposal:* one pass
listing those sites, and a conformance case per rule they share. Medium.

### §8, done 2026-09-06: the inventory and the matrix

Every site where the durable path records an outcome as a value and turns
it back into an effect, and the rule each applies:

| site | recorded as | back into | rule |
| --- | --- | --- | --- |
| tool call, `DurableToolkit.reraise` | `Succeeded` / `Failed { isDefect }` / `Unresolved` | results / typed `DurableToolFailure` / defect | expected failure typed so the policy applies; defect stays a defect; unknown outcome is a defect |
| model call, `DurableModel.reraise` | `Succeeded` / `Failed { isDefect }` | response / typed `DurableModelFailure` / defect | **was: always typed**, so a model defect reached a remote caller as `isDefect: false`; now the tool rule |
| input rendering, `DurableAgent` | `DurableAgentFailure { isDefect }` | typed, projected once | keeps `isDefect`; a failure that already crossed is not projected again |
| permission decision, `DurablePermission` | `Permission.Decision` | the decision | the policy cannot fail; a policy defect dies as one |
| the submission, `DurableAgent.workflow` | `DurableAgentFailure` / interrupted marker | the workflow's typed error | interruption outranks the cause; a cause with both is re-raised, not projected |
| elicitation, `DurableElicitation` | a `DurableDeferred` answer | the answer | no outcome reified; a timeout is the harness's, not a journal value |

Two rules were exercised on the recorded value alone
(`test/DurableOutcomes.test.ts`), which is the path a replay takes, since no
suspension point exists between an activity's record and its re-raise. The
contract gained the matrix rows: a tool's expected failure shown to the
model under `ReturnToModel`; a model defect reported as a defect and a
provider failure as a failure, on every client. Broken once each way: the
model rule restored to always-typed fails the matrix on the durable clients
and the recorded-value row; the tool rule restored fails the recorded-value
row. Interruption's row is the existing "interrupts a run and reports it".

## Second opinion (gpt-6-astra, through the Codex CLI, same day)

Its ranking: **8, 4, 1, 6, 3, 7, 5, 2.** Where it differs from mine and
what I take from it:

- **Do first: the reification audit (§8), across replay too.** Its
  invariant is sharper than mine: crossing a journal boundary must keep
  success, expected failure, defect and interruption distinguishable, on
  fresh execution *and* on replay, and the break is to restore
  defect-to-typed on replay alone. Taken; item 74.
- **Bound observation at the transport seam, by bytes and count (§4).**
  Bounding the PubSub alone changes little if the pump drains into an
  unbounded socket buffer; lag failure is an observation failure, not a
  submission one; "last sequence sent" is not receipt, so resume from the
  client's last parsed cursor and only where a delivery log holds the
  envelopes. Taken, with the byte bound; item 75.
- **Ordering proofs (§1), but not by changing admission.** A hook that
  publishes during admission proves a contract the harness does not have.
  Force the earliest *legal* publication and gate the subscription's
  registration instead. Taken; item 76.
- **Don't shrink `RemoteSession` (§2) and don't move `DelegatedEvent` to
  JSON form (§5).** Subscription readiness and submission streaming are
  different capabilities, and HTTP shows a declaration cannot make the
  hosted stream derivable. Keep the recursive typed envelope and add a
  two-level JSON round trip with absent and present `Option`s. Accepted;
  the round trip is already `test/DelegatedEvents.test.ts`, extended under
  item 77.
- **Nameless fragments (§6): buffer within a bound rather than drop.**
  Remember names by id, and use the assembled call to recover presentation
  data. Accepted as the direction if a provider is ever seen to omit the
  start part; until then it stays documented as a defect, no item.
- **A2A always-stream (§7) is an execution-policy change**, because emitted
  parts forbid fallback, so a caller asking for a completed answer can lose
  a provider recovery. Fixtures before the default is endorsed: failure
  before and after the first part, several messages on one artifact, tool-only
  turns, cancellation after partial output. Item 78.
- **What I missed: lifecycle guarantees.** "Scope ends" and "stream
  finishes" are different observations; release after natural exhaustion,
  after `take(1)`, after consumer failure and after interruption each need a
  row. The appended `awaitSubmission` tail is a normal-consumption barrier,
  not a finalizer, so the guarantee is "normal exhaustion waits for release"
  and a consumer that stops at the terminal has not waited. And
  `Effect.exit` on that tail swallows a waiter *defect* as normal exhaustion;
  suppress only failures the terminal already represents. Item 77.

The full text follows, unedited.

---

I would prioritize **8, 4, 1, 6, 3, 7, 5, 2**. The durable defect exposed semantic drift; SSE makes observation lifetime an immediate concern. Interface simplification comes after those contracts are defensible.

1. **#8 — Do.** Audit outcome reification, then test shared failure rules across clients, including journal replay.
2. **#4 — Do differently.** Bound observation at the transport seam by bytes and envelope count; disconnect without affecting execution, and promise replay only where a delivery log actually supports it.
3. **#1 — Do differently.** Force the earliest *contractually legal* publication and gate actual subscription registration; a test that changes admission semantics proves a hypothetical contract.
4. **#6 — Do differently.** Remember names by call ID, buffer preceding fragments within a bound, and use the assembled call to recover missing presentation data; never silently discard arguments.
5. **#3 — Do differently.** Derive immutable capabilities from constructed dependencies and host negotiation; derive conformance expectations from them, while retaining runtime checks for operational failure.
6. **#7 — Do differently.** Put model-streaming policy in the A2A adapter’s construction value, with an explicit default justified by compatibility fixtures.
7. **#5 — Don’t.** Keep delegated envelopes typed and recursive; fix codec boundaries and strengthen round-trip fixtures instead of moving decoding into consumers.
8. **#2 — Don’t.** Subscription readiness and submission streaming are different capabilities: HTTP/RPC already demonstrate why one cannot replace the other.

I would change those judgments with specific evidence: a complete shared reification boundary already covered through replay lowers #8; verified bounds throughout the SSE path lower #4; a contractual allowance for publication during admission validates #1’s hook. A provider guarantee that every fragment carries its name weakens buffering’s case. A concrete recursion-related compiler or tooling failure could justify #5. No declaration can make HTTP’s hosted stream derivable from an unestablished client subscription.

**First priority: durable outcome fidelity (#8).**

The invariant is that crossing a journal boundary preserves an outcome’s meaning: success, expected failure, defect, and interruption remain distinguishable. In-process execution, initial durable execution, and replay must agree on model-visible feedback, terminal submission state, and committed canonical history. They need not preserve JavaScript object identity or identical stacks.

Failure semantics must follow the original rule. A tool defect stays a defect and fails the submission; it does not become ordinary `ReturnToModel` feedback. Expected failures follow their documented recovery policy. Interruption must not become a typed tool failure merely because the journal requires serializable data. Undecodable recorded outcomes should fail explicitly.

The first commit should inventory reification sites, identifying each encoder, decoder, and re-raise operation. Add a small outcome matrix to the shared contract, starting with the known tool boundary. Exercise both fresh durable execution and reconstruction from recorded outcomes. Record terminal envelopes and canonical history; assert model feedback separately. This makes the existing regression case durable across replay, rather than merely across client implementations.

Break it once by restoring defect-to-typed-failure conversion on replay alone. The replay case must fail even while fresh execution passes. Follow with one case per distinct recovery rule, rather than one mechanically duplicated test per call site.

**Second priority: bounded remote observation (#4).**

The invariant is that a stalled observer has bounded retained resources and cannot stall execution or the journal sink. It receives a contiguous event prefix or an explicit observation failure. It never receives a silently truncated argument stream presented as complete.

SSE is enough reason to investigate now, but its existence does not locate the queue. If a pump drains PubSub into an unbounded socket buffer, bounding PubSub alone changes little. Bound the actual retention chain, including serialized writes and oversized individual envelopes. Envelope count alone cannot bound memory when payload sizes vary, especially with nested delegation.

Lag failure belongs to observation, not submission. That creates an explicit distinction from the local stream’s admission-only typed error contract. An SSE error frame is best effort: a peer that stopped reading may never receive it. Close the connection, record the reason server-side, and resume from the client’s last completely parsed cursor. “Last sequence sent” is not proof of receipt.

Also, canonical turn history is not necessarily an event replay log. Offer resumption only with a delivery log that records these observational envelopes; otherwise report a gap and expose the completed result separately. Reconnection must observe the existing submission, never repeat its POST.

The first commit should add the bounded host observation seam and a gated slow-writer fixture. Observe queued bytes/count, disconnection, subscriber release, continued turn completion, and uninterrupted journal recording. Where replay exists, verify continuity across the replay/live boundary.

Break it once by disabling overflow termination. Use a finite deterministic burst and assert the bound fails, rather than exhausting memory.

**The list misses lifecycle guarantees that need their own contract cases.**

“Scope ends” and “stream finishes” are not interchangeable observations. Measure subscription release after natural exhaustion while an enclosing application scope remains alive, after downstream `take(1)`, after consumer failure, and after interruption. The existing retention measurement proves cleanup when the owning scope closes; it does not establish the narrowest ownership lifetime.

The appended wait is a normal-consumption barrier, not a finalizer. A downstream consumer can stop after seeing the terminal event without pulling the tail. Therefore, document the guarantee as: **normal exhaustion waits for submission release**. Seeing a terminal event alone does not establish readiness. Do not move an indefinite submission wait into cleanup: disconnecting an observer must release observation promptly while the run continues.

Test interruption during subscription acquisition and admission too. Once admission commits, cancellation of the observing fiber must neither cancel the run nor leak its subscription. Any interruption masking should protect only the necessary ownership handoff.

`Effect.exit(awaitSubmission)` deserves scrutiny because `exit` reifies the whole outcome, not merely expected typed failures. Discarding it can conceal a waiter defect as normal exhaustion. Effect’s [current source documents that outcome encapsulation](https://github.com/Effect-TS/effect-smol/blob/main/packages/effect/src/Effect.ts); make the pinned rc.112 behavior executable in your tests. Suppress only submission failures already represented by terminal data, preserve unexpected causes, and verify interruption remains prompt. Separately, gate session release after terminal publication: collection must stay pending until release. Breaking the tail should make that assertion fail.

Coldness also means collecting or retrying the stream can submit again. Document this prominently and ensure remote reconnect logic resumes observation instead.

**Always-stream A2A changes execution policy, not just presentation.**

Because emitted parts prohibit fallback, streaming can change which provider failures recover—even for an A2A caller requesting a completed response. That makes a default-on option a compatibility decision, not merely an escape hatch.

Before endorsing the default, record fixtures for failure before and after the first part, multiple assistant messages, tool-only turns, and cancellation after partial output. The “first chunk of each message uses `append:false`” rule needs particular attention when messages share one result artifact: replacement may erase previously displayed content. Verify stable artifact identity, final replacement, and exactly one terminal outcome. Partial artifacts must remain distinguishable from committed answers when the turn fails.

For delegation, add a two-level JSON round trip with absent and present `Option`s and unchanged child correlation fields. That directly tests the boundary that already broke, without weakening the public event type.
