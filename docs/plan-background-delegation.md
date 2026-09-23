# Plan — background delegation (`Subagent.background`)

Status: **proposal, not started.** Gated on a caller, and its durable form
depends on item 113's design of record. This plan weighs the options and
records the recommendation.

Written 2026-09-23, from the `danieljvdm/effect-agent` subagent surface, whose
`Subagent.background(target, { start, followUp, reportToParent })` gives a
parent `start` and `follow-up` tools and lets "background workers keep running
after the parent finishes or aborts", with "follow-ups [that] continue the
same child thread" and durable recovery of "accepted work and pending report
delivery".

The three-form model this sits in is
[plan-subagent-execution-forms.md](./plan-subagent-execution-forms.md); this
file is its form 3, in detail.

## The problem

`Subagent.tool` is synchronous and attached, by decision. The child session
opens inside the delegating tool's scope, which is the parent submission's
scope (`Subagent.ts`, "Interruption"), so:

- the parent's next model call waits for the batch of delegations to settle;
- interrupting the parent interrupts every attached child through ordinary
  structured concurrency.

That is right for a question the parent needs the answer to. It is the wrong
shape for work that should outlive the parent: a long crawl, a build, a
research task a person will check on later, or a task that reports back while
the person keeps talking.

## What already exists, and why it is not this

The pieces to do this are here; what is missing is a name and a lifetime.

- **`/scheduling`** — `AgentDispatcher.dispatch({ input, delay })` is the
  "enqueue future work" seam, and `Scheduling.recurring` runs an agent on a
  `Schedule`. This schedules *new* work; it does not track a running child.
- **`/sessions`** — `SessionInbox` over `PersistedQueue`: `enqueue` is
  idempotent on the item's id, `deliver` starts a new submission on an idle
  session, retries on a busy one, and survives a crash between the two. This
  is exactly "deliver a report to the parent session" and "continue the same
  child thread", already durable.
- **`/tree`** — sessions as a branchable tree, so a background child can be a
  node a person opens later.
- **Item 113** — the decided design of record
  (`decisions-2026-09-11.md` D5) for a *durable* delegation is delegation as a
  **child workflow**: the delegating tool starts the child's durable
  submission instead of running it in the handler, so the child's approval
  parks the child and the engine suspends the parent behind it. This is the
  durable primitive a background form would build on.

So "background" here is a *lifetime* decision, not a new execution model: it
is a session that outlives the submission that started it, plus inbox
deliveries in both directions.

## The principle this must not break

Structured concurrency is a design commitment, not an implementation detail:
"Background workers keep running after the parent finishes" is, in fiber
terms, an orphan. The library's answer to work that outlives its caller is an
owned entity — a session, a process (`/process` owns a process that outlives
the tool call that started it, with a stable `ProcessId` and an explicit
manager) — never a detached fiber. A `Subagent.background` that hid that
would hide a lifetime, which is the one thing a caller must choose.

So the recommendation is that a background child is **a session**, named and
enumerable, and the parent holds a reference to it — not a fiber the parent
forgot.

## Options

### A. Do nothing; document the composition

A tool that enqueues a submission to a child session through `SessionInbox`,
and a report tool that enqueues back to the parent session, works today. The
cost is the same dozen lines `Subagent.tool` exists to remove — a `Tool.make`,
a toolkit, a handler that resolves the child session, and the two inbox
edges — and, more importantly, each caller would decide the idempotency and
recovery rules again.

### B. `Subagent.background(child, options)` (recommended, when a caller needs it)

Composes A into one value, with the lifetime explicit:

```ts
const background = Subagent.background(Researcher, {
  start: true,          // a tool that opens/attaches a child session and delivers the task
  followUp: true,       // a tool that delivers more input to that same child session
  reportToParent: true  // the child's result delivered as a new submission to the parent
})

const Lead = Agent.make({
  instructions: "…",
  toolkit: background.toolkit        // start / follow-up tools
})
// background.layer supplies the handlers, over /scheduling + /sessions
```

Open questions this plan does not answer, and would have to:

- **Budget.** An attached child's spend is the parent's by default
  (`Subagent.Inherit.budget`). A background child is a different session on a
  different lifetime; charging it to a parent that may have ended is wrong.
  Recommendation: a background child has its own budget, and the parent pays
  only for what it explicitly shares.
- **Report delivery.** "Findings become new input to the parent" is
  `SessionInbox.deliver` to the parent session — which requires the parent to
  be *idle* (a busy parent retries). What happens when the person is
  mid-conversation is a product decision, not a kernel one; the honest
  default is a queued report the session accepts at its next idle point, and
  never a steer into a running turn.
- **Abort semantics.** An attached child dies with the parent. A background
  child must not — but then "cancel the parent" leaves it running, and the
  user needs a way to see and stop it. That is `/sessions`' directory plus a
  cancel, and it is why the child must be enumerable rather than anonymous.

### C. Build item 113's child-workflow delegation first

The durable attached form. A background form needs the same machinery — a
child that is a durable submission with its own identity, recoverable after a
restart — so C is a prerequisite for B's durable half, not an alternative to
it. C is already decided and gated on an adopter that needs forwarded approval
across a durable delegation.

## What the effect-agent surface adds, and where each piece goes

Four capabilities the `effect-agent` background surface has that the options
above do not yet name. None is a kernel noun; each is a battery over an
existing seam, and each wants its own caller.

### Reports and updates

A completion is a report: the child's result (or a bounded failure) delivered
to the parent. `SessionInbox` is that delivery, and its acknowledgement
vocabulary — handed over, persisted, accepted, settled (`guide-sessions.md`,
"What a success means") — is exactly what effect-agent's `{ worker, delivery
}` / receipt / "pending delivery says nothing about child execution"
describes. What is new is the **update**: a provisional finding emitted before
the completion, through a native `emit_update` tool.

```ts
const HotelResearcher = Agent.make({
  instructions: "…",
  updates: AreaConcern,          // installs emit_update
  output: HotelFindings
})
```

An update is data, independent of the final result, and never stops the child.
Here it is a battery: `emit_update`'s handler publishes to a channel, and the
background layer forwards each value into the parent's input. The seam under
it is the same inbox (or an explicit `steer`); the new thing is the tool and
the `updates` declaration, which is why it is its own item rather than part of
`Subagent.background`.

**Where a report lands is decided, not accidental.** `SessionInbox`'s rule is
that a completion starts a new submission on an idle session or waits, and
never joins one in flight; joining is the explicit act of
`AgentSession.steer`. effect-agent joins at "an input boundary"; that is
timing deciding meaning, which `SessionInbox` exists to refuse. A report that
must land inside the running conversation is a steer the caller asks for.

### Assignments

effect-agent's `runDisposition: { workerLifecycle: "assignment", schema,
fromOutput }` lets a worker's typed output decide `waiting` (the run ends, the
assignment stays steerable) versus `completed` (the assignment seals, once its
latest accepted instructions have applied). Failed or exhausted runs seal too.
That is a lifecycle state machine, and `/state` (persistent typed state) is
the seam it would build on. It is a real new concept and the least justified
of the four: a worker that is a long-lived assignment rather than a one-shot
task is a caller this plan does not yet have.

### Control: follow-up, inspect, cancel, stop

No new primitive; a toolkit over what exists.

- **Follow-up** — deliver more input to the same child session. `SessionInbox`
  again; the returned delivery state is its acknowledgement, and the caller
  keeps the item id rather than resending.
- **Inspect / list** — `SessionDirectory` enumerates sessions; a delivery's
  state is the inbox's `Delivered` / `Undelivered`; a saved result is the
  session's history.
- **Cancel** — `AgentSession.interrupt`, targeted at one submission. It does
  not close the worker, matching effect-agent's "cancellation targets one
  input's receipt; it does not close the worker". An input cancelled before it
  starts a run produces no completion, because no run happened.
- **Stop** — a stable command key that seals the worker; the idempotency key
  is what makes a re-sent stop one request, as `SessionInbox.Item.id` is for a
  report.

### Authorization

effect-agent's `WorkerHostAuthorizer` authorizes a worker operation by
principal and source thread, denying by default. That is `AgentSessionHost`'s
authorization plus `Principal.CurrentPrincipal`, which already denies by
default and is established per request by the host
(`AgentSessionHost.Options.subject`); a worker operation is one more
authorized operation on that host, not a second authorizer.

## Recommendation

- **A now.** The composition works and is documented; nothing speculative is
  built.
- **B when a caller needs it**, over `/scheduling` + `/sessions`, with the
  child a named session, its own budget by default, and reports delivered as
  queued input at the parent's next idle point.
- **C when forwarded approval across a durable delegation is needed** — the
  already-recorded decision, unchanged.

Updates, assignments and the control toolkit are separate, caller-gated items
on top of B, in that order of justification: control is a toolkit over
existing seams, updates add one tool and one declaration, assignments add a
lifecycle. The full sequence is in
[plan-subagent-execution-forms.md](./plan-subagent-execution-forms.md).

## Gate

A caller. "Run this in the background and tell me when it is done" is the
first real one; the workbench's task board (item 82, `TaskRunner` /
`TaskWorker` / `WorkQueue`) is adjacent but is the product's own task model,
not a subagent mode, and the plan should not be built merely because that
exists.

## Acceptance, when built

- A parent submission completes (or is interrupted) while its background
  child keeps running; the child is enumerable and can be cancelled.
- A follow-up continues the same child thread, and a report arrives as new
  input to the parent session at its next idle point.
- A durable restart recovers an accepted start and an undelivered report
  (`SessionInbox`'s persistence, exercised across a process boundary).
- A background child's spend is charged to its own budget unless the parent
  explicitly shares, and the parent's ceiling is unaffected.
- An update reaches the parent before the completion, is provisional, and does
  not stop the child.
- A worker operation from a principal or source thread other than the
  authorized one is refused by default; cancel targets one input and does not
  close the worker; stop seals it under a stable command key.
