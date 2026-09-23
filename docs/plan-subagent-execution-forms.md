# Plan — subagent execution forms: attached, durable attached, background

Status: **proposal, not started.** Parts are gated on a caller; the durable
attached form is item 113's already-recorded decision, built when an adopter
needs it. This plan weighs the options and records the design; it does not
commit to building. The detailed background design lives in
[plan-background-delegation.md](./plan-background-delegation.md), which this
plan feeds.

Written 2026-09-23, from the `danieljvdm/effect-agent` subagent surface, whose
three execution forms are *in-memory attached*, *durable attached* and
*durable background*.

## The one idea

A subagent is **a tool that opens a child session**. There is no second
execution model and no subagent runtime: every form below is a child
`AgentSession` plus the seams that already exist. What separates the forms is
**where the child runs and how long it lives**, not what a subagent *is*:

| form | the child is | lifetime | the parent |
| --- | --- | --- | --- |
| **attached** (in-memory) | a session in the tool handler's scope | the delegating call | waits for the batch |
| **durable attached** | a durable submission (a child workflow) | the parent's submission, recoverable | suspends, resumes with the result |
| **background** | a session of its own, addressed by an inbox | independent of the parent | keeps running |

This is why `Subagent.tool` and `Subagent.background` should share one
declaration (`Agent.make`) and differ only in how the parent is wired to it.
The effect-agent surface is right about that; this plan adopts it.

## The shared declaration

What a subagent declares is the child, and nothing about the host:

```ts
const Researcher = Agent.make({
  instructions: "…",
  input: ActivityRequest,                       // → the tool's parameters
  output: ActivityFindings,                     // → the tool's success schema
  toolkit: TravelTools,                         // the child's own tools
  loop: AgentLoop.bounded(8)                    // the child's own limits
})
```

Already true here: a child's `AgentInput` becomes the delegation tool's
parameters and its `AgentOutput` becomes the tool's success
(`Subagent.tool`), so a typed child hands its parent a value, not prose. A
child's limits are its own loop's (`conformance-matrix.md` footnote 5). The
host — `provide`, a durable client, a background layer — is chosen where the
delegation is wired, never on the child.

## Form 1 — attached (in-memory)

Ships. `Subagent.tool(name, child, { description, provide })` returns an
ordinary `Agent.BoundTool`; the child opens inside the handler's scope, so
interrupting the parent interrupts the child through structured concurrency.
`provide` is the child's world (its model and services); `inherit` decides
what crosses (budget by default, approval only when asked); `onError` decides
whether a child failure is returned to the parent model or fails the run.

Three additions worth making, each small and independently gated:

1. **A result projection.** effect-agent's `projectResult` lets a declaration
   expose *part* of the child's output as the tool's answer. Here the tool's
   success is the child's output schema exactly. A `project` option on
   `Subagent.tool` — `(value: Value) => Tool.Success` — would close the gap
   without a second child or a wrapper tool.
2. **A failure mapper.** `onError` is `"return" | "die"`. A third form that
   maps a child's typed failure to the application's own error is what
   effect-agent's "map failures to an application error" does; it is additive
   and belongs beside `onError`.
3. **The exhaustion shape.** *Deliberately different, and decided
  2026-09-23.* effect-agent returns `{ output, budgetExhausted }` as a value;
   here a child a bound cut off mid-work is a `SubagentExhaustedError` on the
   tool's failure channel (returned to the model by default), and one that
   answered on a final turn crosses normally — distinguished by
   `AgentRun.Result.endedOnFinalTurn`. The reason to keep the typed failure:
   a value the model must remember to inspect is the thing `Exhaustion`'s
   `onExhaustion: "fail"` was added to stop relying on, and `"return"` already
   puts it in front of the model as data. If a structured `budgetExhausted`
   field is wanted for a *projection*, that is what item 1 is for.

## Form 2 — durable attached

**Decided, not built.** The design of record is
`decisions-2026-09-11.md` D5: a delegation is a **child workflow**. The
delegating tool starts the child's durable submission instead of running the
child in its handler, so:

- the parent's next model call waits for the batch to settle, and the engine
  suspends the parent rather than holding an execution slot;
- a restart recovers the same child — same identity, same recorded result —
  because the child is a workflow, not a fibre in a dead process;
- the child's approval parks the child and suspends the parent behind it,
  which is exactly what forwarding an approval across a durable delegation
  needs (item 113's whole reason for existing);
- aborting the parent cancels its children and joins their terminal outcomes
  through the workflow's structured concurrency.

What is missing is not a concept but an implementation, plus the host that
registers it. effect-agent's `NodeDurableHost.layer([{ agent, model,
definitions }, …])` registers each agent with its model binding and its code
version. Here that is three existing pieces and one gap:

- **binding a revision to a model** — the workbench's `AgentResolver` +
  `Catalog` + `AgentRevision` already does this at the product level
  (`remaining-work.md` item 82); `/model` supplies the metadata.
- **code versions** — `/durable`'s `ToolContracts` and
  `ToolContractChangedError` already freeze a durable submission's tools, so a
  replay whose child changed is refused by name.
- **the gap** — a portable, non-product host that takes a *list* of
  `{ agent, model, definitions }` and serves them, as `DurableAgentClient`
  does for one agent. `apps/worker` and the workbench server are two
  hand-rolled instances of it; a `NodeDurableHost`-shaped entry is the third
  caller that would justify extracting it.

Registering the *exact child* (not just the parent) is the effect-agent
detail worth copying: recovery can only reconnect to a child the host can
resolve. Here that means the child's `AgentDefinition` and its model binding
must be resolvable by the same registry the parent's is.

## Form 3 — background

The pieces ship; the battery does not. Full design in
[plan-background-delegation.md](./plan-background-delegation.md); the shape:

```ts
const research = Subagent.background(Researcher, {
  start: true, followUp: true, reportToParent: true
})
// research.toolkit → the parent's start / follow-up tools
// research.layer   → handlers over /sessions' SessionInbox and /scheduling
```

A background child is a **named session** that outlives the submission that
started it — never a detached fibre (see "Divergences"). `start` and
`followUp` deliver input to it through `SessionInbox`; `reportToParent`
delivers the child's completion back as a *new submission* on the parent
session. The acknowledgement vocabulary the effect-agent docs describe —
`{ worker, delivery }`, a receipt after destination acceptance, "pending
delivery is queued and says nothing about child execution" — is exactly
`SessionInbox`'s, which already distinguishes handed-over / persisted /
accepted / settled (`guide-sessions.md`, "What a success means").

Three capabilities the effect-agent surface has that this plan adds to the
background design:

- **Updates.** `Agent.make({ updates: Schema })` installs a native
  `emit_update` tool; with `reportToParent` the parent receives provisional
  findings before the completion. This is new here and is a battery, not a
  kernel noun: an `emit_update` tool whose handler publishes to a channel,
  plus forwarding into the parent's input. It is the one piece of the
  background surface with no existing seam under it.
- **Assignments.** A worker whose typed output decides `waiting` (steerable)
  versus `completed` (sealed) is a lifecycle state machine. `/state` is the
  persistent-state seam it would build on; it is a real new concept and wants
  its own caller before it exists.
- **Control.** Inspect / list / cancel / stop map to existing seams:
  `SessionDirectory` lists sessions, `AgentSession.interrupt` cancels,
  idempotency keys make a re-sent command one request, and a stable command
  key seals a worker. No new primitive; the work is a toolkit and its
  authorization.

**Authorization.** effect-agent's `WorkerHostAuthorizer` (authorize by
principal and source thread, deny by default) is `AgentSessionHost`'s
authorization plus `Principal.CurrentPrincipal`, which already denies by
default and is set per request by the host (`AgentSessionHost.Options.subject`).

## Deliberate divergences

These are where affe-agent should *not* copy effect-agent, with the reason.

1. **No detached work.** "Background workers keep running after the parent
   finishes" is an orphan in fibre terms. The library's answer to work that
   outlives its caller is an owned entity — a session, a managed process —
   never a fibre the parent forgot. So a background child is enumerable and
   cancellable, and a caller can always see what is still running.

2. **A ping-back is future session input, never implicitly a follow-up.**
   `SessionInbox`'s rule (`SessionInbox.ts`, "The rule this module exists to
   enforce"): a completion starts a *new submission* on an idle session or it
   waits; it never joins a submission in flight. effect-agent says reports
   "join an active parent run at an input boundary"; here joining is the
   explicit act of `AgentSession.steer`, and timing must not decide meaning.
   A report that must land inside the running conversation is a steer the
   caller asks for, not a delivery that happens to arrive at a boundary.

3. **Typed failures, not data flags, for the attached form.** See form 1,
   item 3. A background *completion* may carry a `budgetExhausted` field,
   because a completion is a message and a message is data; an attached
   delegation's result is a tool result, and its failure channel is the typed
   place for it.

4. **Budget crosses by decision, not by default inheritance of mechanism.**
   An attached child's spend is the parent's by default (`Inherit.budget`),
   because a parent capped at N is usually capped *because* it delegates. A
   background child is a different session on a different lifetime, so its
   budget is its own unless the caller explicitly shares one — charging a
   dead parent is worse than charging nobody.

5. **One declaration, host-chosen.** `Subagent.tool` / `Subagent.background`
   take the same `AgentDefinition`; the host is wiring. This is already the
   library's position ("the model arrives through the environment").

## Sequence and gates

Ordered by dependency and by what a caller can justify.

1. **`Subagent.tool` `project` + failure mapper** — small, additive, useful
   to the attached form alone. Gate: a caller that wants a projected result.
2. **Durable attached (item 113)** — the child workflow. Gate: an adopter
   that needs forwarded approval (or any durable delegation) across a
   restart; already decided, deliberately unbuilt.
3. **Background battery** — over `/sessions` + `/scheduling`. Gate: "run this
   in the background and tell me when it is done" from a real caller. Its
   durable half depends on 2.
4. **Updates battery** — the `emit_update` seam. Gate: a caller that needs
   provisional findings before completion.
5. **Assignments** — the worker lifecycle. Gate: a caller whose workers are
   long-lived assignments rather than one-shot tasks.
6. **A portable multi-agent durable host** — extract the pattern
   `apps/worker` and the workbench server both hand-roll, once a third caller
   needs it. Gate: two independent hosts already exist; the third is the
   trigger.

`plan-auto-model-routing.md` is adjacent and independent: choosing a model
per delegation is a property of the `LanguageModel` layer, not of an
execution form.

## Acceptance, when built

- **Attached:** unchanged, plus a projected result type-checked against the
  tool's success schema, and a mapped failure that a caller can `catchTag`.
- **Durable attached:** a parent that suspends on a child resumes with the
  child's recorded result; a restart reconnects to the same child identity; a
  child's forwarded approval parks the child and suspends the parent; aborting
  the parent joins the child's terminal outcome.
- **Background:** the parent finishes or is interrupted while the child keeps
  running; the child is listed and cancellable; a completion arrives as a new
  submission on the parent session, or as an explicit steer; a durable restart
  recovers an accepted start and an undelivered report.
- **Updates:** an `emit_update` reaches the parent before the completion, is
  provisional, and never stops the child.
- **Authorization:** a worker operation from a principal or thread other than
  the source's is refused by default.

## Open decisions for the owner

1. **The result shape.** Keep the typed `SubagentExhaustedError` (recommended,
   consistent with `Exhaustion`), or add a structured `{ output,
   budgetExhausted }` result and a `projectResult`? The two are not exclusive;
   the question is which is the default.
2. **Reports joining a run.** Keep `SessionInbox`'s "never implicitly a
   follow-up" rule (recommended), or add an opt-in that lets a report steer a
   running parent?
3. **Background budgets.** Own by default (recommended) or shared from the
   source as effect-agent does?
4. **Which slice has a caller now?** Every item above is gated; naming one
   caller turns a plan into work.
