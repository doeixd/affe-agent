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

## Recommendation

- **A now.** The composition works and is documented; nothing speculative is
  built.
- **B when a caller needs it**, over `/scheduling` + `/sessions`, with the
  child a named session, its own budget by default, and reports delivered as
  queued input at the parent's next idle point.
- **C when forwarded approval across a durable delegation is needed** — the
  already-recorded decision, unchanged.

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
