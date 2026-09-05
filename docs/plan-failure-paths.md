# Plan: making the failure paths provable

*2026-09-03, after reading `danieljvdm/effect-agent`'s **source** rather than
its README, and after the relay's own post-commit review.*

Two earlier plans read that project from the outside:
[plan-effect-agent-comparison.md](./plan-effect-agent-comparison.md) read the
site, [plan-rfc-286-durable.md](./plan-rfc-286-durable.md) read issue 286. This
one reads the code, and it finds something the other two could not: **their
tests can crash a durable pass at a named point and ours cannot.**

That is the thread running through everything below. We do not have a
correctness problem so much as an *evidence* problem. This session is the
example. The relay shipped, its review found two real defects in client
teardown, and the test written to cover them **passes with the fix removed**.
The faults are reachable and not observable, so they were reasoned rather than
caught. That is the same sentence we will keep writing about `/durable` until
something changes.

> **Two projects share the name `affe-agent`.** Throughout this document
> *theirs* is `github.com/danieljvdm/effect-agent`, scope `@effect-agent/*`;
> *ours* is this repository, `affe-agent`. Their counterpart of our
> `src/durable` is `packages/thread`, **not** `packages/workflow`, which is
> only an adapter onto the engine.

## 1. What was read

| theirs | lines | what it is |
| --- | --- | --- |
| `packages/workflow/*` | ~840 | the adapter: dispatch outbox, host, repair |
| `packages/thread/DurableAgentRuntime.ts` | 8911 | the durable runtime itself |
| `packages/thread/{Recovery,RunJournal,Subscriptions}.ts` | ~3200 | recovery, canonical journal, inbound event sources |

Read in full: the workflow package, and the service interfaces, observe
options and subscription surface of the thread package. **Not** read: the body
of `DurableAgentRuntime.ts`, which is most of their code. Nothing below claims
their implementation is correct, only that a particular *technique* is worth
having.

Three facts, because they are load-bearing and easy to get wrong later:

* **Their durability is not in the workflow journal.** The registered handler
  carries no `Activity` at all. It validates identity, reruns journal
  recovery, asks whether the submission settled, and otherwise suspends. The
  comment says it outright: *"No Activities: rerun journal recovery directly on
  every native resume."* Canonical records, a submission ledger and a thread
  store are the durable state; the engine only schedules, suspends and
  triggers recovery.
* **Ours is the opposite bet and stays that way.** `src/durable` makes the
  journal the durability and rebuilds canonical history from replayed activity
  results, which is why it needs no history store. See §5 — this is not a gap
  to close.
* **We already have the idempotency property their RFC is careful about.**
  `DurableSubmission`'s key is `${name}:${sessionId}:${submissionId}`, keyed on
  identity and not on input, so a replay carrying different input conflicts
  with the original admission instead of launching new work. Recorded so the
  next audit does not re-derive it.

## 2. The ranking

1. **48a. Retry safety declared on the tool** — the live correctness defect,
   already ranked highest as 47a and still unimplemented. Ships first because
   it is a bug, not infrastructure.
2. **48b. Failpoints** — a typed crash-injection seam. The largest new idea in
   this document, and the thing that makes 48a, 48c and 48d provable rather
   than argued.
3. **48c. Never acknowledge on the engine's word** — reconcile against
   canonical state before completing a waiter, and retain the intent on
   disagreement.
4. **48d. The teardown contract belongs in the conformance suite** — this
   session's relay bug was a *transport contract* violation, not a relay quirk.
5. **48e. The relay's deferred half** — durable mailbox, reconnection, lease
   expiry, enrollment.

Items 48b and 48d are the ones I would do even if nothing else on this list
happened.

## 3. The items

### 3.1 (48a) Retry safety declared on the tool

**Unchanged from 47a, restated because it is still open.** `grep -rn retrySafe
src/` returns nothing.

`DurableToolkit.wrap` turns every handler into an `Activity`, and upstream's
`Activity` retries an *interrupted* effect up to ten times. So a tool
interrupted mid-request is reissued, which nothing in our code asked for and
which is wrong for anything that charges a card or sends a message.

**Design.** A tool declares `retrySafe` where it already declares
`needsApproval`, defaulting to today's behaviour so nothing changes for
existing agents. A tool that is *not* retry-safe and whose outcome is
unresolved parks the submission the way an `Ask` does, on the `DurableDeferred`
machinery `DurableElicitation` already uses.

**Test.** Interrupt a run inside a non-retry-safe tool, resume, and assert the
handler ran exactly once and the submission parked. Break it by flipping the
default and watch the count go to two.

**Size.** Small in `DurableToolkit.ts`, plus a field on the tool and a
paragraph in [guide-durable.md](./guide-durable.md).

### 3.2 (48b) Failpoints

**The gap.** We have no way to crash a durable pass at a chosen point.
`test/DurableStorageFaults.test.ts` can make a *store* fail, which is a
different thing: it exercises error handling, not the window between two
durable writes. Every "what if the process dies here" question in
`/durable`, `/cluster` and now `/relay` is currently answered by reading.

**What theirs does.** A `Context.Reference` whose single method is
`hit(location, intent)`, defaulting to a no-op, called at ten named points
across one dispatch:

```text
intent:before-persist   intent:after-persist
launch:before           launch:after
completion:before-observe   completion:after-observe
completion:before-notify    completion:after-notify
cleanup:before          cleanup:after
```

The locations are a `Schema.Literals`, so the set is closed and a test cannot
name a point that does not exist. Their dispatch test is the largest file in
the package and drives recovery from each. There is a second one for
subscriptions and a third inside the runtime, so this is a house technique
rather than one clever test.

**Why it is right for us.** The default is a no-op reference, so production
pays nothing and the seam does not leak into any public signature. It is the
one mechanism that would have made this session's relay review produce a
failing test instead of an argument.

**Design.**

* `src/internal/failpoint.ts` — a `Context.Reference` with `hit(location)`,
  defaulting to `Effect.void`, generic over a location union.
* Each subsystem owns its own closed location schema, next to the code it
  describes: `DurableSubmission`, `DeliveryLog`, `DurableChannels`,
  `RelayRpc`. Not one global enum, which would rot.
* A testing helper — `src/testing/Failpoints.ts` — that fails, dies or
  interrupts at the *n*th hit of a named location, and records the hits it saw
  so a test can assert the order. Since 2026-09-05 (`plan-context-lessons.md`
  2.6) it also has `covered(group, drive)`: crash at every boundary the
  subsystem declares, through the real path, and die by name for any the
  driver never reaches -- so a declared crash window with no test that
  crashes at it fails the build rather than sitting in the tuple unexercised.

**Naming rule, learned from theirs.** A location names the *durable boundary*
it sits beside (`before-persist`, `after-persist`), never a line of code.
Renaming a function must not invalidate a test.

**First three tests to write, in order.**

1. `DeliveryLog` — die between accepting an event and committing its sequence,
   restart, assert the event lands exactly once and no sequence is skipped.
   This is the one our replay bet makes load-bearing.
2. `DurableSubmission` — die after the model activity records and before the
   turn commits, resume, assert the model is not called twice.
3. `RelayRpc` — die between failing outstanding requests and sending `Eof`,
   assert the far end still releases the client. This is the review finding
   from this session, turned into a test that can fail.

**Size.** The seam is small, perhaps 120 lines with the helper. The tests are
the work, and they are the point.

**Risk.** Failpoints invite a test suite that pins implementation detail. The
closed location schema is the guard: adding a point is a deliberate edit to a
schema someone reviews.

### 3.3 (48c) Never acknowledge on the engine's word

**What theirs does.** When the native workflow completes, they do not trust the
value it returns. They read the canonical settlement, compare the returned
reference against it field by field, and on any disagreement they fail the pass
**and deliberately retain the dispatch intent** so a later repair retries.
Notifying the waiter is the last step, after the check.

**Why it matters here.** Our relay bug this session was the impoverished
version of the same mistake: a waiter that could never be satisfied because the
thing meant to satisfy it had been discarded. The general rule is worth
stating once and applying in three places.

**Where it applies.**

* `DurableAgentClient.prompt` — the workflow's `Outcome` should be checked
  against the session store's recorded submission before the caller is told
  the prompt completed.
* `47c`'s dispatch intents for the Durable Object host, when that lands, get
  this discipline by construction.
* `RelayRpc`'s finalizer already fails outstanding requests rather than waiting
  on a remote acknowledgement, which is the same principle. Add the comment
  that says so, so it is not "fixed" back later.

**Test.** With failpoints from 48b: make the engine report success while the
canonical record says otherwise, and assert the caller sees a failure and the
work is retried rather than being told it succeeded.

### 3.4 (48d) The teardown contract belongs in the conformance suite

**The finding.** `RelayRpc.clientProtocol`'s finalizer must settle in-flight
requests locally before the channel goes away, because a transport being torn
down cannot promise a remote acknowledgement. That is not a fact about the
relay. It is true of every transport we ship, and nothing currently tests it
for any of them.

`src/testing/AgentClientConformance.ts` is 649 lines and covers submission,
idempotency, conflicts, approval and interruption. It has no teardown case.

**Design.** Add one case to the conformance suite: with a request in flight,
close the client's scope, and assert (a) the in-flight effect completes as
interrupted rather than hanging, and (b) it does so within a bound, without an
outer timeout rescuing it. Every transport already running the suite — rpc,
http, durable, relay — then answers the question.

**Why this ranks high for its size.** It is one case, it applies to five
implementations, and it converts the one thing this session actually learned
into something that cannot regress. Verify by reverting the relay finalizer and
watching the relay's run of the suite fail.

### 3.5 (48e) The relay's deferred half

Landed 2026-09-03 in `2d65ccf` and `778d8af`; four things were deliberately
left out and each is now the reason the relay is a demo rather than a
deployment.

* **Durable mailbox — do not build this as specified.** *(2026-09-03, after
  reconnection landed.)* The scope above said "`PersistedQueue` per peer,
  drained on connect; a `Request` is worth queueing, an `Ack` is not". Both
  halves are wrong, and the second is wrong in a way that would have been
  discovered late.

  **The relay cannot make that decision, and should not learn how.** Deciding
  that a `Request` is worth queueing means parsing the frame, and the frame
  being opaque is the property that keeps the relay a transport rather than a
  participant. If frames are to be classified, the *sender* must do it — it is
  the layer that knows what its own bytes mean — which is a field on
  `Outbound`, not a parser in `RelayServer`.

  **But for request/response there is nothing worth queueing.** Walk it
  through. The relay drops an offline peer, so the target's `send` back is
  refused, so its server protocol releases the RPC client holding the request
  (`RelayRpc.ts`'s `catchTag` on `RelayPeerOfflineError`), and the caller has
  already had its in-flight requests settled as a transport failure. Now
  deliver the queued `Request` an hour later: `clientFor` mints a *fresh*
  client for that (peer, channel), the handler runs, and the agent does the
  work — for a caller that was told an hour ago that it failed and is no longer
  there. That is not delivery, it is a duplicated side effect with no consumer,
  and it is strictly worse than the honest error we return today.

  **What a mailbox is actually for is one-way traffic** — a notification, an
  event pushed at a device — where redelivery has a meaning. Effect RPC already
  names those: `isNotification`. That is a real and much narrower feature than
  "queue the requests", and it is the only shape worth building.

  **And the request/response case is already solved a layer up.** "Reach this
  session again later, exactly once" is what `idempotencyKey`, the
  `DurableSessionStore` and the `DeliveryLog` are; a caller who needs a
  submission to survive a disconnect wants the durable client, not a queue
  inside the transport. Putting durability here would duplicate that at the one
  layer that cannot make it mean anything, because the transport does not know
  what a retry *is*.

  So: if this is picked up, it is `isNotification`-only, opted into by the
  sender on `Outbound`, and it needs a reason a notification matters more than
  the reconnection that now exists. None of the current callers has one.
* **Reconnection.** `RelayClient.status` goes `offline` for good and says why.
  A reconnect must re-subscribe every handler and decide what happens to the
  requests that were in flight — and per 48c the answer is that they fail, not
  that they wait.
* **Lease expiry.** `heartbeat` records `lastSeenAt` and nothing reaps. A
  half-open connection stays `online` in the directory forever.
* **Enrollment.** `bearerTokens` is a fixed map. The service seam is already
  the right shape; it needs a store behind it.

**Order.** Lease expiry first, because it is small and the directory currently
lies. Then reconnection, then the mailbox, which is the only large one.

## 4. Deliberately not taken

* **Their canonical-records bet.** Making canonical records the durable source
  of truth and using no activities is coherent, and it is not ours. Our
  `DeliveryLog` deduplicates by a semantically derived key precisely *because*
  we replay emission; theirs needs no such thing because it never replays.
  Adopting half of this would give us both costs. If we ever revisit it, it is
  a rewrite of `src/durable`, not a refactor.
* **Their per-thread lane semaphore.** They serialize one thread's recovery
  with a semaphore inside one host. We make the session a cluster entity, so
  single ownership across nodes and routing of out-of-band steering come from
  the entity mechanism. Ours is the stronger guarantee; theirs is the one that
  works without a cluster. No change.
* **Conformance suites.** Not a gap in either direction. They ship executable
  contracts for their ledger, thread store, schedule store and subscriptions;
  we ship them for the client, channels, delivery log, session store, node
  store, sandbox and directory.
* **A `WorkflowDispatchStore` in `src/durable`.** Their outbox exists because
  their engine may not be running. Ours runs. 47c already scopes this to the
  Durable Object host, where the constraint is real and measured, and it stays
  host-local.

## 5. What this changes elsewhere

* [remaining-work.md](./remaining-work.md) gains item 48 pointing here, and
  47a is restated as 48a rather than duplicated.
* [guide-durable.md](./guide-durable.md) gains the `retrySafe` paragraph when
  48a lands, and nothing before.
* Nothing in `STATUS.md` changes until an item ships.

## Related

* [plan-rfc-286-durable.md](./plan-rfc-286-durable.md) — the same project read
  through its RFC; 47a/47b/47c originate there.
* [plan-effect-agent-comparison.md](./plan-effect-agent-comparison.md) — the
  same project read through its documentation.
* [plan-durability-hardening.md](./plan-durability-hardening.md) — the earlier
  durability pass, which 48b would retrofit tests onto.
