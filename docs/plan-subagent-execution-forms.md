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

Two additions worth making, and one effect-agent idea declined:

1. **A result projection.** effect-agent's `projectResult` lets a declaration
   expose *part* of the child's output as the tool's answer. Here the tool's
   success is the child's output schema exactly. A `project` option on
   `Subagent.tool` — `(value: Value) => Tool.Success` — would close the gap
   without a second child or a wrapper tool.
2. **A failure mapper — declined unless a caller needs it.** effect-agent maps
   a child's failure to an application error. Here the child's failure is
   already typed on the child's own error channel and readable as
   `ToolCallFailed` (whose `failure` carries the class), while the parent
   model gets a string under `onError: "return"`. A mapper would add a
   parameter without adding information, because the delegation tool's
   `failure` schema is a string; a *typed* parent-tool failure would mean
   changing that schema, which is a different and larger decision. Reopen only
   if a caller asks for it.
3. **The exhaustion shape.** *Deliberately different, and decided
  2026-09-23.* effect-agent returns `{ output, budgetExhausted }` as a value;
   here a child a bound cut off mid-work is a `SubagentExhaustedError` on the
   tool's failure channel (returned to the model by default), and one that
   answered on a final turn crosses normally — distinguished by
   `AgentRun.Result.endedOnFinalTurn`. The reason to keep the typed failure:
   a value the model must remember to inspect is the thing `Exhaustion`'s
   `onExhaustion: "fail"` was added to stop relying on, and `"return"` already
   puts it in front of the model as data. A caller who wants a structured
   partial instead writes a child that *answers on the way out*
   (`onExhaustion: "final-answer"`), which makes it a success; `project` is
   for narrowing a success, not for rescuing a failure.

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

### The concrete design — scoping pass, 2026-09-24

D5's sentence "the delegating tool starts the child's own durable submission"
cannot be read literally, and `src/durable/DurableToolkit.ts` says why in its
own comments:

- `DurableToolkit.wrap` wraps **every** tool call in an `Activity.make`; the
  handler runs inside its `execute`.
- A handler's requirements are `never`, so it cannot name `WorkflowEngine`.
- The engine suspends by interrupting the fibre, which the activity's
  interruption branch cannot catch, so a suspending activity comes back
  `Suspended` and its re-execution records `Unresolved`.

So **the handler cannot start the child, and must not suspend**. The
delegation has to happen one level up: in the **workflow body**, where
`DurableAgent.workflow`'s `toLayer` already resolves `WorkflowEngine` and
`WorkflowInstance`, and where the engine does expose what is needed —
`WorkflowEngine.execute(workflow, payload, executionId?)` starts a workflow,
and `Workflow.suspend(instance)` parks one. The build is therefore:

1. **A delegation is marked, not handled.** A durable subagent tool carries
   its child workflow definition as an annotation (a `Context.Reference`),
   because the handler cannot hold it and `DurableToolkit` must read it.
2. **`DurableToolkit.handle` special-cases the marker.** For a marked tool it
   does *not* build an `Activity`. From the workflow body it calls
   `engine.execute(child, payload, childExecutionId)` — the child id derived
   deterministically from the parent's execution id and the tool call id, so a
   re-execution addresses the same child — then polls. If the child has not
   finished it calls `Workflow.suspend(instance)`; on re-execution it polls
   again and, once the child has completed, returns its result as the call's
   journalled result.
3. **The child's result shape.** `DurableAgent.workflow`'s success is
   `Schema.String` (the child's text). A typed child needs the child
   workflow's success to carry the encoded value, or the delegation to read it
   from the child's recorded session. First slice: text.
4. **Approval.** The child parks on its *own* durable elicitation, and the
   parent is suspended behind it because it awaits the child's completion; the
   answer is given against the child's execution id. What the *parent's* user
   is shown, and how they reach the child's elicitation, has no design yet:
   the parent's event stream does not carry the child's requests, and the
   in-process `inherit: { approval: "parent" }` is not the durable path.

Build order, and the risk: **probed 2026-09-24, and it holds.** A workflow body
*is* given `WorkflowEngine` (and `WorkflowInstance`), and `Child.execute({ n })`
from a parent's body completes with the child's result; `test/ChildWorkflow.test.ts`
pins it and fails if the engine stops providing the context. (The first attempt
failed on wiring, not the engine: `Layer.mergeAll` leaves `toLayer`'s own
`WorkflowEngine` requirement unsatisfied. The working wiring is
`Layer.mergeAll(parentLayer, childLayer).pipe(Layer.provideMerge(engine))`,
which is what `DurableAgentClient`'s own tests do — worth knowing before
blaming the engine.)

So the child-workflow design is **reachable**: parts (2) and (3) are a build,
part (4) is its own decision, and the refusal stays only until someone builds
them.

**The suspension probe holds too** (same file, 2026-09-24). A child that parks
on a `DurableDeferred` — the mechanism `DurableElicitation` uses — and a parent
awaiting `Child.execute` from its body, resumed by an outside
`DurableDeferred.succeed`, completes with the child's result. So the part with
a recorded failure nearby (a durable sleep inside a *handler* never resumed) is
sound from the *body*: the failure was the handler's, not the engine's. What
this does not measure is whether the parent releases its execution slot while
it waits — that is the engine's business, and the mechanism `Workflow.suspend`
exists for.

So (4) approval routing is designable: the child parks on its own durable
elicitation, the parent awaits it, and an answer resumes the child. What is
*not* designed is how the parent's user is shown that request and how they
reach it — the child's execution id, not the parent's — which is a product/UX
decision as much as a kernel one.

#### The `DurableToolkit` seam — built 2026-09-24

The engine half is proven; this was what the build had to do. It is written and
tested: `DurableToolkit.delegate` marks a tool, `wrap`'s `handle` branches on
the marker **before** the start marker and the `Activity`, and
`test/DelegationSeam.test.ts` runs a durable parent whose tool is a child
workflow. Both assertions hold: the parent completes with the child's result,
and a **suspension after the delegation replays it from the child's journal,
with the child running exactly once** — the money assertion. Broken once
(seam disabled) and restored.

What the build does, for the record:

- **A delegation is a marked tool.** `DurableDelegation` is a
  `Context.Reference<Option<Delegation>>` on the tool, with `delegate(tool,
  run)` as the authoring path. The child workflow *definition* and the payload
  it is given from the call's parameters are `run`'s business, so
  `DurableToolkit` never learns about agents.
- **The seam branch.** In `handle`, before the start marker and the
  `Activity`: for a marked tool, no activity — `delegation.run(params, id)`
  under the captured `workflowContext`, mapped to the handler's journalled
  results. No start marker, so the per-attempt-marker hazard does not arise.
- **Result and failure mapping.** Success encodes through the tool's
  `successSchema`; a child failure is a tool failure the parent model reads,
  via the existing `reraise` rule, so it matches a normal call's disposition.
- **Replay** works by execution id: the child's idempotency key is a pure
  function of the delegation's parameters, so a re-execution addresses the same
  child and the engine returns its recorded result.
- **The safety argument changed narrowly, on purpose.** `wrap`'s comment says
  "a handler cannot suspend the workflow, and this relies on it." The
  delegation seam is the one exception, opt-in by annotation; a normal handler
  gains nothing.

**Still open:** widening the child's success beyond `Schema.String`, and
approval routing (part 4).

**`Subagent.durable` landed 2026-09-24** (`src/subagent/Durable.ts`), the
user-facing constructor over the seam. It takes the child's
`DurableAgent.workflow` and marks a tool whose call admits the child with a
session id derived from the **parent's execution id and the tool call id**, so
a replay addresses the same child and a tool-call id reused by another session
cannot reach it. `test/DurableSubagent.test.ts` is the end-to-end test: a
durable parent delegates to a child agent running as its own workflow, reads
its text as the tool's result, and completes. The application provides both
workflows' layers to the engine, as `DurableAgentClient` does for one agent.

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

1. **`Subagent.tool` `project`** — small, additive, useful to the attached
   form alone. Gate: a caller that wants a projected result.
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
  tool's success schema.
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

## Decisions

Reasoned 2026-09-23, in place of asking. Each follows from a commitment the
library already makes, not from taste.

### 1. The attached result is a typed failure, not a data flag

Interruption and mid-work exhaustion are the **same event** — the child did
not finish — so they must take the same shape. `SubagentInterruptedError`
already established that shape (item 50); `SubagentExhaustedError` is its
twin. A `{ output, budgetExhausted }` value would split two identical events
into different shapes, and the split would be load-bearing: the parent's model
would have to learn to check a field for one and catch a failure for the
other.

Three further reasons, in order of weight:

- **The primary consumer is a model.** `ToolCallFailed` with
  `returnedToModel: true` guarantees the model is shown the failure; a field
  in a success object is ignorable. And `toolFailurePolicy` /
  `toolDenialPolicy` already let the caller choose between failing the run and
  returning the failure to the model — a choice the data shape cannot express.
- **The data path already exists, and it is the child's to choose.** A child
  that wants to hand back a partial declares an `AgentOutput` and configures
  its loop with `onExhaustion: "final-answer"`: it *answers* on the way out, so
  the delegation succeeds with a real value and no flag is needed. Partial as
  data is an explicit child decision, not a harness default that every child
  inherits.
- **A programmatic caller already has structure.** The error class is exported
  and `catchTag`-able, and the same failure is on the parent's event stream as
  `ToolCallFailed`. Nothing is lost that a flag would return.

The `project` option (form 1, item 1) stays separate: it narrows a *successful*
child output for the parent tool, which is a different concern from what
happens when the child does not finish.

### 2. A report never joins a run implicitly; the default is a new run

`SessionInbox`'s rule — a ping-back is future input, never an implicit
follow-up — exists because timing must not decide meaning. A **background
child is, by definition, one the parent is not waiting for**, so its report
has no claim on the parent's current run. The default is therefore: the report
starts a **new submission**, committed as a **framework message** (system
role), not as the application input.

That last clause is the design, not a detail. "Delivered separately from the
parent's application input" is already achievable for a raw-input agent:
`AgentInput.prompt`'s schema accepts any `Prompt.RawInput`, so an item whose
input is a `Prompt` carrying a **system-role** message commits a *system*
message, not a user one. `examples/ref-subagent-forms.ts` does exactly that
(its `parentReportTexts`), and a direct probe confirmed the committed role is
`system`. So framework *provenance* is not the missing primitive — this plan
said it was, and the example corrected it.

The primitive that **is** missing is narrower: `SessionInbox` cannot feed an
agent with a declared `AgentInput` at all (`SessionInbox.ts`: "cannot be fed
from here yet"), because the wire carries that schema's encoded value and the
inbox carries a prompt. A typed-input parent therefore cannot receive a report,
and the run a report starts has no application input to give
`AgentInput.Current`.

**The framework submission, as a design.** A submission opened by framework
messages with no application input. It has the same lifecycle as any other --
submission, runs, turns, budget, events, canonical history -- with one
difference: it carries no `AgentInput` value, so `AgentInput.Current` is
`None` for its tools, and its messages commit with framework provenance.

- **Entry.** `AgentSession.framework(messages)` in process, and
  `SessionInbox.Item.input` becomes a small union --
  `{ kind: "input", input } | { kind: "framework", messages }` -- so the inbox
  can carry either.
- **Committed, not injected.** The messages go to canonical history, so a
  report is auditable, replayable and durable like everything else. A
  `ContextTransform` injection would be ephemeral and would not survive a
  replay.
- **In process first.** The wire form (`AgentProtocol`) and the durable journal
  are deliberately *not* decided here: they are the same work as item 113's
  child-workflow host, and a request nobody has made should not mint a wire
  field. The first slice is `AgentSession.framework` plus the inbox union, in
  process; the inbox item is persisted, so its additive `kind` is measured by
  a fixture even though nothing on the wire changed.
- **Rejected: do nothing.** It leaves a typed-input parent unable to receive a
  report at all, which is the gap this decision is about.

**Landed 2026-09-24 (the in-process slice).** `AgentSession.framework` admits
a submission opened by framework messages; `AgentInput.Current` is `None` for
its tools, no input is recorded on `SubmissionStarted`, and the messages are
committed like any input (`test/FrameworkSubmission.test.ts`).
`RemoteSession.framework` is an *optional* method the in-process client
implements; a transport that omits it makes a framework delivery
`Undeliverable` rather than mis-delivering it as application input.
`SessionInbox.Item` gains an optional `kind` (`"input"` when absent), measured
by `test/fixtures/session-inbox-item.json` and held by
`test/SessionInbox.test.ts`. Still open: the wire form and the durable journal,
which remain item 113's decision.

Joining at a boundary is expressible and safe **when chosen at wiring time**,
because then the caller, not the arrival time, decides the relationship:
`reportToParent: "input-boundary"` steers the report into the active run at a
turn boundary, default off. Updates take the same path and the same default:
provisional, a framework message, never stopping the child.

### 3. Background budgets are their own by default

An attached child's spend is the parent's because a parent capped at N is
usually capped *because* it delegates, and the child is part of the same
submission. A background child is a different session on a different lifetime:
the parent may have ended before the child does. Charging a dead parent is
worse than charging nobody, so a background child's budget is its own unless
the caller explicitly shares one — the reverse of the attached default, and
deliberately so.

### 4. No caller today; find one with a reference example, not with code

The two consumers that exist — the workbench's task board (`TaskRunner` /
`TaskWorker` / `WorkQueue`, item 82) and `apps/worker` — each hand-rolled
their own background execution rather than needing a kernel battery. Building
the battery now would be speculative, which is exactly what the scope rule
forbids.

The repository's own way to test whether a surface is worth packaging is a
**reference implementation built only from the public API**
(`plan-primitives.md` §4): `examples/ref-delegation.ts` did this for the A2A
bridges and found nothing missing, which is what let the bridges ship with
confidence. The same test was run here:

> **Done 2026-09-23 — `examples/ref-subagent-forms.ts`**, run in CI as
> `npm run smoke:ref-subagent-forms`. It composes and it works: a tool starts
> a child session that outlives the parent's run, and the child's completion
> comes back through `SessionInbox` as a delivered report. It is **not** a
> dozen lines, and it names three things a battery would have to supply:
>
> 1. **No portable multi-agent client.** `AgentClient` serves one agent and
>    only the sessions it created, so a parent and child need two clients
>    wired by hand; the multi-agent host exists only in the workbench and
>    `apps/worker`.
> 2. **The client/agent circularity.** The client is built from the agent,
>    whose tool needs the client; breaking it took a `Context.Service` plus a
>    lazy `Ref`, because the tool cannot close over a value that does not
>    exist yet.
> 3. **Provenance is expressible, but only for a raw-input agent.** Delivering
>    a `Prompt` with a system-role message commits a *system* message, so a
>    report is not mistaken for the person's input — the example does this.
>    What is *not* expressible is delivering to an agent with a declared
>    `AgentInput`; that is the framework submission decision 2 names, and it is
>    narrower than "framework messages do not exist".

So the composition is real but it is not ergonomic, and the three findings
above are the battery's specification. That is a caller's evidence, not a
mandate: the work is still gated on someone wanting it, and the example is the
thing to read first.

The same test applies to `project` (form 1): write it by hand once; if it is
trivial, decline the option.

### Summary

| question | decision |
| --- | --- |
| attached result shape | typed failure (`SubagentExhaustedError`); partial-as-data is the child's `final-answer` |
| failure mapper | declined unless a caller needs a typed parent-tool failure |
| reports joining a run | never implicitly; new run by default, boundary-join opt-in at wiring time |
| report input path | a framework message bypassing `AgentInput` — a missing primitive the background work supplies |
| background budgets | own by default |
| next step | the reference example ran; it names the battery's contents (see decision 4) |
