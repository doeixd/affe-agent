# Plan: what to take from their Workflow RFC, and what to leave

**Status: specified 2026-09-02; §3.2 answered and pinned the same day, §3.1 and §3.3 not started.** Written from a read of
[danieljvdm/effect-agent#286](https://github.com/danieljvdm/effect-agent/issues/286),
"RFC: Run agents with any Effect Workflow engine", opened the same day by the
author of `effect-cf` — the same project
[plan-effect-agent-comparison.md](./plan-effect-agent-comparison.md) read on
2026-09-01. That plan compared the documentation site; this one compares one
RFC against `/durable`, and it is the same method: each item names the gap, the
seam it lands on, its acceptance test, and what it deliberately does not do.

Every claim below about our code and about `effect@4.0.0-rc.111`'s workflow
module was read out of the source, not remembered. Line numbers are as of
`b07acf2`.

---

## 1. What the RFC proposes, and where we already are

Their durable runtime is their own: a journal, a submission ledger with FIFO
lanes and ownership fencing, and "Attempts". The RFC keeps all of it and adds
a thin Effect `Workflow` **driver** on top, whose whole job is to advance one
Attempt, ask whether its own submission settled, and suspend if not. The engine
arrives as a `Layer`, so `ClusterWorkflowEngine` today and the upstream
Cloudflare engine (Effect PR #7322) later, with no backend branches. Around it:
a dispatch intent persisted before every launch, bounded repair passes for a
lost launch and a lost final wake, and service contracts for dispatch storage
and repair triggers.

**Their headline goal is where `/durable` started.** "Supply any
`WorkflowEngine` as a `Layer` without touching agents or tools" is
`DurableAgent`'s signature: `WorkflowEngine.WorkflowEngine` has been in its
requirements since 2026-08-21, `/cluster` runs it on `ClusterWorkflowEngine`
with shard failover, and the four-process resume demo is in the suite. The RFC
proposes to arrive at the position we shipped from. That is worth stating
plainly and then setting aside, because it is not what makes the RFC worth
reading.

**Where the two designs actually differ** is what an Activity is for. We make
the model call, every tool handler, every permission decision and each channel
drain an `Activity`, and rebuild canonical history by replaying their results
— which is why `/durable` needs no store of its own. The RFC refuses that for
tools specifically, and gives a reason:

> Activities can retry interrupted effects, but an ordinary tool with an
> unresolved external outcome must not run again automatically.

That is item 3.1, and it is the one thing in the RFC that would make ours
better.

## 2. The ranking

| # | item | size | why here |
| --- | --- | --- | --- |
| 1 | **Retry safety declared on the tool** (§3.1) | medium | A real correctness gap on the one thing durability exists to protect: an external side effect. Ranked above most of what is left in `remaining-work.md`. |
| 2 | ~~**The resume-before-suspension race**~~ (§3.2) | small | **Done 2026-09-02**: verified present in the engine, verified *not* to reach us, and pinned by a test. |
| 3 | **Dispatch intents for the Durable Object host** (§3.3) | medium | The one structural idea that fits a host where the workflow engine cannot run. |

## 3. The items

### 3.1 Retry safety declared on the tool

**The gap, precisely.** `DurableToolkit` wraps each handler as
`Activity.make({ name: \`tool-{name}-{toolCallId}\`, ... })`, and its own doc
comment states the intent: "a *tool* call repeated on replay reissues its side
effect. The refund goes out twice." Wrapping fixes the *completed* case — a
replay reads the journalled outcome. Two windows remain, and they are not the
same size:

1. **Crash between the side effect and the journal commit.** The activity has
   no result, so replay runs the handler again. This window is identical in
   both designs; theirs pauses, ours re-runs.
2. **Interruption, which upstream retries automatically.** This one we did not
   know about. `effect/unstable/workflow/Activity.ts` wraps every activity in
   `retryOnInterrupt`, whose policy is
   `Schedule.while((meta) => meta.attempt <= 10 && Cause.hasInterrupts(meta.input))`
   — so an interrupted activity is re-executed **up to ten times** before the
   engine gives up and dies with "interrupted and retry attempts exhausted".
   A tool interrupted mid-`fetch` therefore reissues that request, and nothing
   in our code asked for that.

`STATUS.md` and `guide-durable.md` are honest that we refuse to claim
exactly-once. Honest is not the same as safe: today the harness makes the
retry decision for every tool identically, and the tool that sends the email
has no way to say otherwise.

**The shape.** The decision belongs to the tool, because only the tool knows
whether its effect is repeatable, and it should be declared where
`needsApproval` already is — the precedent is exact: a per-tool property that
the durable interpreter reads and the local one mostly ignores.

- A tool declares `retrySafe` (name to settle in the design pass; `idempotent`
  reads as a stronger promise than we can check). Default **`true`**, which is
  today's behaviour, so nothing changes until a tool opts out. Defaulting to
  `false` would be safer in the abstract and would silently park every
  existing agent's first crash, which is not a change to make by default.
- Under `/durable`, a tool with `retrySafe: false` whose activity is found
  *started but unresolved* on replay does not re-execute. It **suspends the
  submission the way an `Ask` permission does** — the machinery is already
  there (`DurablePermission`, `DurableElicitation`, `DurableDeferred`), and
  the parked run is resolved out of band by a human or a policy that knows
  whether the refund went out. The RFC calls this "unknown-outcome
  resolution"; we should call it what our vocabulary already calls it.
- Locally the flag is inert, and says so.

**The subtlety that decides the design.** Knowing an activity *started* is not
free: the journal records outcomes, not attempts, so "started but unresolved"
is not a state we can currently read. Either the activity writes a start
marker before running the handler (a second journal write per non-retry-safe
call, paid only by tools that ask for it) or the interpreter infers it from
the engine's attempt counter (`Activity.CurrentAttempt` is already threaded by
`retryOnInterrupt`). The design pass picks one and says why; the marker is the
honest one and the counter is the cheap one.

**Acceptance.** A tool declared `retrySafe: false`, crashed after its effect
and before its outcome is journalled, leaves the submission parked with a
resolvable pending record rather than running twice — broken once by flipping
the flag to `true`, which must make it run twice. A second test pins the
interrupt path: an interrupted non-retry-safe activity is not re-executed,
where a retry-safe one is (this one fails today). `Presets.coding`'s shell and
write tools are audited and declared explicitly either way, since a plan that
adds a flag nobody sets has done nothing.

**Not this item.** Exactly-once. It does not exist, the docs say so, and this
change does not alter that — it moves the *choice* about the unresolved case
from the harness to the tool.

### 3.2 The resume-before-suspension race

**Verified present.** `ClusterWorkflowEngine`'s exported `resume`
(`node_modules/effect/src/unstable/cluster/ClusterWorkflowEngine.ts:273`) reads
the stored reply for the execution's `run` request and then:

```ts
const maybeSuspended = Option.filter(
  maybeReply,
  (reply) => reply.exit._tag === "Success" && reply.exit.value._tag === "Suspended"
)
if (Option.isNone(maybeSuspended)) return
```

A resume that arrives before the execution has recorded a `Suspended` reply is
**silently dropped**. The RFC found this and works around it; the version it
describes is the version we pin.

**Whether it reaches us is an open question, and a testable one.** We never
call `engine.resume` — the string appears nowhere in `src/`. We reach it
indirectly through `DurableDeferred`, which is how elicitation
(`DurableElicitation`), an `Ask` permission and submission settlement all
park and wake. Note that the engine's *other* wake path,
`sendResumeParent`, is written more carefully: with no prior resume request it
sends a persisted entity message rather than returning. So the answer may well
be "the deferred path is durable and we are fine", which is a good result to
record rather than a milestone to miss.

**Answered 2026-09-02: it does not reach us.** The test below was written and
passes: an elicitation answered immediately after launch -- while the run is
still in its first model call and has not reached the elicitation at all -- is
honoured, and honoured once. `DurableDeferred` stores the answer durably, so
the workflow reads it when it later awaits rather than needing a wake to
arrive in the right order. Broken once by deleting the answer, which parks the
submission and fails with that sentence. So the deferred indirection is what
saves us, and it is now pinned rather than assumed.

**Acceptance (met).** One test: answer an elicitation *before* the run reaches
its await, and assert the submission still completes. If it parks forever, the
race reaches us and the fix is ours to choose. Either way the outcome is
recorded in `status-history.md`, and if it is upstream's, it joins
`docs/upstream/` beside the workerd finding.

### 3.3 Dispatch intents for the Durable Object host

**Why this one transfers and the rest does not.** Their two-store design —
engine state plus their own ledger — costs them intents, repair scans of both,
and the workaround in §3.2. We have one journal, the engine's, and that is
simpler. But it is a bet on the engine, and we have already measured that bet
losing: `docs/upstream/effect-workflow-on-workerd.md` records Effect Workflow
starting and never completing on workerd, stalling at the first activity
boundary, which is why `apps/worker` runs *without* `/durable`.

On that host, "the engine recovers it" is not available, and the RFC's
mechanism is exactly the shape that fits: **persist a dispatch intent before
launching, scan outstanding intents in a bounded repair pass, delete an intent
only after checking completion against the canonical settlement.** We already
have the durable trigger it needs — the Durable Object alarm is an
`AgentDispatcher`, shipped 2026-09-01 — and the delivery-log journal to record
against. This is cheaper than the engine-level recovery we cannot run there,
and it is host-local: nothing in `src/durable` changes.

**Acceptance.** Kill the runtime between the admission commit and the launch;
the repair pass finds the intent and starts the run exactly once. Kill it after
settlement but before the intent is deleted; the pass verifies against the
canonical settlement and deletes rather than re-running. Both on miniflare,
as the rest of the worker is tested.

**Not this item.** Bringing intents to the Node path. There the engine's
journal already is the intent, and adding a second record would be the
duplicate bookkeeping §4 refuses.

## 4. Deliberately not taken

- **The FIFO lane, the Attempt vocabulary, and the separate ledger.** That is
  their runtime's shape, not a gap in ours. Our claim rules and
  `DurableSubmission` cover the same ground with the engine's journal as the
  single source of truth.
- **`awaitSettlement` as a third spelling of submit-and-await.** `submit` +
  `awaitSubmission` is that operation, and
  `plan-effect-agent-comparison.md` §4 already refused a third spelling of
  "run without waiting" on the roadmap's "never a parallel execution model"
  rule. The same rule applies here.
- **A driver so thin the engine is replaceable.** It is the right call *for
  them*, because their journal is the source of truth and the engine is a
  scheduler. Ours rebuilds history from the engine's journal, so a driver-only
  shape would mean building the store we deliberately do not have. Worth
  re-opening only if the engine's own durability fails us on a host we care
  about — and note that their shape would not have survived workerd either,
  since the stall was in suspend and resume, which their driver still needs.

## Related

- [plan-effect-agent-comparison.md](./plan-effect-agent-comparison.md) — the
  read of the same project's documentation site, 2026-09-01.
- [guide-durable.md](./guide-durable.md) — what `/durable` promises today.
- [upstream/effect-workflow-on-workerd.md](./upstream/effect-workflow-on-workerd.md)
  — the measured stall that §3.3 is a response to.
- `remaining-work.md` item 47.
