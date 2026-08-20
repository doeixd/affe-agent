# Implementation status — v0.1

Built on **Effect v4 (`effect@4.0.0-rc.111`)**. The AI modules live in-tree at
`effect/unstable/ai`; `@effect/ai` has no v4 line and is not used.

`npm test` — 96 passing, including the durable and cluster phases. `npm run lint` — 0 Effect diagnostics. `npm run typecheck` — clean, including all examples.

**The engine is generic end to end.** `Session`, `AgentTurn`, `AgentRun`,
`AgentSubmission` and `ToolExecution` all carry `Tools`, so tool types are never
erased internally and then re-asserted at the boundary. Making the toolkit
always present — an agent without tools gets `Toolkit.empty` — removed the
conditional that had been defeating inference at the model call. That took the
casts in `src/` from seven to two: constructing `AgentSession`'s phantom `Tools`
field, and defaulting an absent toolkit. Both are structural and commented.

**User-side code needs no casts and no type annotations.**
`examples/typed-agent.ts` is a full typed agent — tools, a custom loop, a
context transform, prompt and steer — written with zero casts and zero
annotated parameters, and carries compile-time assertions that inference stays
precise rather than degrading to `any`. The tests and the fake model are
cast-free too. The two remaining casts are inside `src/` and structural.

```
src/
├ Agent.ts             reusable agent definition (carries no model)
├ AgentSession.ts      public module-function API
├ AgentSubmission.ts   prompt + follow-up chain (internal vocabulary)
├ AgentRun.ts          turns until the loop stops
├ AgentTurn.ts         one model call + its tools, committed atomically
├ AgentLoop.ts         continuation policy (Continue | Stop)
├ AgentEvent.ts        event ADT + correlation envelope
├ ContextTransform.ts  canonical history -> ephemeral model prompt
├ ToolExecution.ts     concurrency strategy + failure policy
├ Errors.ts            AgentBusyError, AgentIdleError, AgentClosedError
└ internal/            ids, eventBus, history, state
examples/anthropic.ts  the DoD program on a real provider (typechecked only)
```

## Phase status

| Phase | State |
| --- | --- |
| 0 Repository setup | done |
| 1 Deterministic model harness | done |
| 2 Canonical history | done |
| 3 Manual tool resolution | done |
| 4 Turn execution | done — commit is atomic |
| 5 AgentLoop | done |
| 6 Run fiber | done |
| 7 Steering queue | done |
| 8 Follow-up queue and submission | done |
| 9 Interruption | done |
| 10 Event envelopes and ordering | done |
| 11 Tool failure policy spike | done — resolved, see below |
| 12 API cleanup | done except event Schemas, see deviations |

## Convenience API

Four helpers, each justified by repeated friction in this repository rather
than by anticipation (PLAN §42.2):

* `Agent.toolkit(tools, handlers)` — one step, one instance. The two-step form
  appeared 20 times and has a silent failure mode where handlers bind to an
  unused toolkit and every call succeeds having done nothing.
* `AgentLoop.bounded(n)` — `and(untilIdle(), maxTurns(n))`, which appeared six
  times. Spelling it out invites omitting the bound.
* `ContextTransform.appendSystem` / `prependSystem` — the dynamic-instruction
  case. They add a discrete system message rather than folding into an adjacent
  one, so `compose` stays order-predictable; the folding behaviour of
  `Prompt.appendSystem` produced `["firstsecond", "first"]` in a test, which is
  why the helper does not use it.
* `AgentEvent.match` — exhaustive dispatch with narrowed payloads, replacing a
  switch that silently stops covering new events.

`examples/typed-agent.ts` asserts at compile time that the sugar costs no
inference: a handler parameter is still exactly its schema type.

## Follow-up ordering and quiescence

Two defects in follow-up handling, both reproduced before fixing.

**Follow-ups drained together ran out of order.** The loop took the first item
and re-queued the tail *in reverse*, on the theory that this preserved order —
onto a FIFO it does the opposite, turning `A, B, C` into `A, C, B`. The comment
above the code asserted the behaviour it was breaking. The batch is now
buffered locally rather than re-queued.

**A follow-up accepted at quiescence could be silently dropped.** The submission
drains an empty queue and concludes it is done, but the session is not idle
until `prompt` returns — so `followUp` still succeeded in that window, and the
input was discarded on release. The caller was told it was queued.

`status` cannot express this, since the submission finishes fractionally before
the session goes idle, so state now carries an explicit `acceptingFollowUps`
gate. Closing is atomic, followed by a second drain that is guaranteed to catch
anything accepted just before the close, and the gate reopens if late work
arrived. See PLAN §22.1.

> A follow-up that is accepted is always executed. Rejecting it is fine;
> accepting and dropping it is not.

## Audit findings

A review pass after the durable work found four defects and one regression.

**A reused tool call id silently skipped a tool.** `DurableToolkit` derived
activity identity from the provider's `toolCallId`, but a provider is only
obliged to make that unique *within one response*. A model reusing an id across
turns collided, and the later call replayed the earlier result — the tool never
ran, and nothing surfaced. Identity is now the call's ordinal within the
submission, which is replay-stable; the id is kept alongside it for readable
traces. Reproduced before the fix.

**`AgentSession.state` handed out a writable `SubscriptionRef`.** Canonical
history lives in it, so a caller could have corrupted it — directly against
PLAN §45's "sole owner" invariant. It now returns a read-only `StateView`
(`get` and `changes`); observation and mutation are different capabilities and
only one is on offer.

**`AgentLoop.and()` with no arguments never stopped.** An empty conjunction is
vacuously true, which here means a run that loops forever. Both `and` and `or`
now require at least one policy, making it unrepresentable rather than
documented.

**A dispatch failure in the entity handler was swallowed.** The submit handler
forks the execution and the caller already has its id, so a failure cannot be
returned — it is now logged rather than discarded silently.

**Casts regressed in test code**, against the rule in AGENTS.md: 15 had crept
in with the durable tests. Down to one, absorbed inside a shared helper because
`LanguageModel.generateText` is heavily overloaded and decorating a provider is
a normal thing to do. Two of those casts pointed at a real API gap —
`DurableAgent.result` now returns the workflow's `Exit` instead of a `Complete`
whose failure had to be dug out untyped.

Two behaviours turned out to be correct but silent, so they are pinned by tests
rather than left to be discovered: a failed submission is still a *completed*
workflow carrying a failed exit, and a second `submit` for the same session
rejoins the live execution rather than starting a new one (the idempotency key
is the session, which is what makes retrying safe).

## Durable and distributed execution

Implemented as subpath exports: `@doeixd/effect-agent/durable` and `/cluster`.
Core does not depend on either.

The central claim of `WORKFLOW_CLUSTER_PLAN.md` is verified: **the same agent
definition runs durably, and a resumed submission replays completed work instead
of repeating it.** `Agent.make({...})` is passed unchanged to
`DurableAgent.workflow`; the model becomes an `Activity` by replacing a Layer,
tools by wrapping handlers, and out-of-band input through `InputChannel`.

Three tests carry the weight:

* a submission runs durably with no change to the agent;
* a resumed submission does not repeat a completed tool call — the refund goes
  out once, and each model call executes once across the resumption;
* a steer queued while the submission is suspended is applied exactly once.

Canonical history is not persisted anywhere. It is rebuilt from replayed
activity results, which is why the durable module needs no store of its own.

**The pause point is `DurableDeferred`, not a crashed fiber.** Interrupting the
fiber leaves an execution that `Workflow.resume` will not re-dispatch; awaiting
a `DurableDeferred` suspends the workflow properly and completing it from
outside — with only the token — wakes it. This also means approvals (plan Phase
7) already work: the tests are, structurally, human-in-the-loop approvals.

Interruption is terminal under durability, and the cluster entity round-trips a
sharded submit/steer/follow-up. Phase 5 runs on `SingleRunner` with a SQLite
journal on disk: a submission suspends and resumes against real SQL storage,
replaying turn 1 rather than re-issuing it.

**One claim remains unproven, and it is the headline one.** Tearing down the
runner that started a suspended execution and resuming from a second runner over
the same database records the execution as `Complete` with an
`EntityNotAssignedToRunner` defect — the shard assignment is lost with the
runner. So resumption replays persisted work correctly *within a runner's
lifetime*; surviving the loss of that runner needs shard reassignment on
startup, which is a deployment concern. Do not claim process-restart durability
in user-facing material until it is closed.

Phase 6 turned up a design error worth remembering: an entity handler must not
block on a workflow. The handler holds the session's mailbox, and starting a
workflow routes back through the same runner, so the two deadlock. Handlers now
derive the execution id and fork the execution.

## Breaking changes for the durable/distributed path

Two seams the earlier design lacked, both driven by concrete blockers found
while planning `WORKFLOW_CLUSTER_PLAN.md` rather than by speculation.

**`InputChannel` replaces the session's raw queues** (PLAN §16.2). Steering and
follow-ups are the only inputs a run consumes that come from neither the model,
the tools, nor canonical history — so they are the only ones a replaying
interpreter cannot reproduce. A queue drain reads whatever is pending at that
instant; on replay the queue is empty and the turn would derive a different
prompt from the one whose model result is being replayed. `AgentSession.make`
now takes an optional factory, defaulting to memory, so ordinary use is
unchanged. A test substitutes a recording channel and asserts every drained
batch is observable — which is exactly what a durable interpreter must capture.

**`AgentEvent` is Schema-defined**, and the `Cause` question is settled (PLAN
§42.1). Events carry `AgentEvent.Failure` — `{ tag, message, isDefect }` — not a
`Cause`. The missing `Schema.Cause` codec forced the question, but the answer
holds regardless: events are the serializable record, and a `Cause` is an
in-process value holding fibers and arbitrary defects. The full `Cause` stays in
`prompt`'s typed error channel. Envelope round-trip and defect-vs-failure
distinction are both tested.

## Durable execution: how it works

The same agent definition is reinterpreted durably without core knowing
durability exists — see PLAN §30.1.

The reason is structural: `LanguageModel.make` takes a provider returning
`Array<Response.PartEncoded>`, an already-encodable value, so wrapping it in an
`Activity` puts the durable boundary exactly where persistence needs it, reached
by swapping a Layer. The interception points a durable interpreter needs are
already Layers, so `AgentExecution` stays unbuilt.

`ClusterWorkflowEngine.layer` also composes with `TestRunner.layer` (no
dependencies), so the durable path is unit-testable without SQL —
`WORKFLOW_CLUSTER_PLAN.md` is the implementation plan built on that.

Both were subsequently implemented and tested; see the durable section above for
what is proven and what is not.

## Closing the remaining plan gaps

Three specified behaviours were missing after the earlier passes.

**§6 / §15 / §33 — typed requirements on policy.** `AgentLoop` and
`ContextTransform` were bare functions with no error or requirement channel, so
a policy could not depend on a service. Both are now records preserving `E` and
`R`:

```ts
interface ContextTransform<E = never, R = never> {
  readonly transform: (context: Context) => Effect<Prompt, E, R>
}
interface AgentLoop<E = never, R = never, Tools = any> {
  readonly decide: (state: State<Tools>) => Effect<Decision, E, R>
}
```

Those unions flow onto `Agent`, into `AgentSession.make`'s requirements and into
`PromptError<Tools, E>`. `test/Requirements.test.ts` proves it end to end: a
loop reads a `TurnBudget` service and fails with its own `BudgetExceeded`, which
the caller catches **by tag** from `prompt`.

`ContextTransform` also now receives the §6 `Context` record — session,
submission, run, turn index and the canonical prompt — rather than a bare
`Prompt`, so a transform can vary by position without the harness handing it
mutable state.

`AgentLoop.State` gained `sessionId`/`submissionId` and dropped
`hasPendingFollowUps`, per §15's instruction not to include follow-up state:
whether more work is scheduled after this run is submission orchestration, not a
reason for the current run to continue.

**§4 — namespaced ids and public vocabulary.** `AgentSession.Id`,
`AgentSubmission.Id` and `AgentRun.Id` are exported as Schemas, and
`AgentSubmission`/`AgentRun` are exported since §4 lists them as core
vocabulary. `test/PublicApi.test.ts` pins the exported surface so it cannot grow
unnoticed.

**§34 / §35 — subagents.** The claim that a child session can run under a
different model, with interruption propagating through structured concurrency,
was documented but never exercised. `test/Subagent.test.ts` proves both: two
independently scripted models where each sees only its own conversation, and an
interrupted parent that takes the hung child down with it. No harness code was
needed — which is the point of §35.

**§44 — test matrix.** Eleven uncovered cases added in `test/Matrix.test.ts`:
failed turns committing nothing, tool-result ordering, steering after the model
response and at a turn boundary, follow-ups during tool execution and between
runs, interruption across parallel tools and between turns, idle `interrupt`,
duplicate terminal events, and per-run turn indexing.

## Alignment with the revised plan

The revised `PLAN.md` settles the event vocabulary, and the implementation was
brought in line with it rather than the reverse — the plan's naming was better
reasoned:

* `ToolCallCompleted` → `ToolCallSucceeded`, `SteeringReceived` → `SteeringQueued`.
* `ToolCallInterrupted` added. The plan is right that a run-level failure alone
  leaves a consumer showing a tool as still running. It has to be emitted from
  an `Effect.onInterrupt` finalizer: once the fiber is interrupted the ordinary
  continuation never resumes, and `Effect.uninterruptible` does not help because
  the problem is reaching the emit at all, not being interrupted during it.
* `FollowUpApplied` added, asserted in the required position —
  `FollowUpQueued < RunCompleted < FollowUpApplied < RunStarted`.

## Review findings and fixes

A review pass after the phases were complete found two correctness defects and
two type-quality defects. All four are fixed, with regression tests.

**Interrupting `prompt`'s caller wedged the session permanently.** `prompt`
forked the submission into the *session* scope and awaited it. If the caller
was interrupted — `Effect.timeout`, a lost `Effect.race`, an enclosing fiber
going away, all ordinary usage — the await was cancelled but the submission
kept running and status stayed `running` forever, so every later `prompt`
failed as busy. Reproduced before the fix. `prompt` now releases through
`Effect.ensuring`, which interrupts the submission and returns the session to
idle however the call ends.

**Claiming the session was check-then-act.** Status was read and then written as
two steps, so two concurrent prompts could both observe `idle`. This did not
reproduce under the current scheduler — the interleaving never happened — so it
was a latent race rather than an observed failure, but "at most one run per
session" should not depend on where the runtime happens to yield. Claiming is
now a single `SubscriptionRef.modify`, which also allocates the submission id,
so the id and the claim cannot disagree.

**`prompt`'s error channel was `unknown`.** Every typed failure was erased at
the public boundary — exactly what §23 warns against. It is now
`PromptError<Tools>`: `AgentBusyError | AgentClosedError | AiError | ` the
tools' own declared failure types. A tool declaring `failure: Schema.Literal(
"not_found")` now surfaces `"not_found"` to the caller.

**`Tools` never reached the session.** `AgentSession` was not generic, so
`Result.response` was `GenerateTextResponse<any>` and `AgentLoop.State` was
`any`. `AgentSession<Tools>` now carries them at the type level, and
`AgentLoop.State<Tools>` gives a custom loop typed tool calls.

**Casts had leaked into user-side code.** The test helper built toolkits
through a generic array and cast the result, which erased `Tools` to `any` and
meant the tests never exercised the typed path they were supposed to prove.
Toolkits are now built the way a user builds them — one named `Toolkit.make`,
handlers bound to it, no annotations. The fake model's `streamText` stub was
also cast into shape; since v0.1 does not stream, it now fails loudly instead
of pretending to satisfy an interface it does not implement.

**Event delivery order.** `emit` allocated a sequence number and published as
two steps, so concurrent emitters — parallel tool calls — could take numbers in
one order and publish in the other. Consumers could always have sorted by
`sequence`, but arrival order matching sequence order is the stronger guarantee
and costs one semaphore permit. Pinned by a four-parallel-tool test.

## Option and error shape

Domain types express absence with `Option` rather than `null`/`undefined`:
the event envelope's `submissionId`/`runId`/`turn`, `SessionState`'s active
ids, `Result.response`, and `Agent.instructions`. `Correlation` deliberately
keeps optional properties — it is an options record describing what a caller
may omit, not a domain value, and `Option.none()` would be noise at a call site
that simply did not pass something.

Errors define `message` as a getter, never a Schema field. The error still reads
well in logs and stack traces, but the string is derived, so it cannot drift
from the fields it describes and never reaches the wire format — and decoding
reconstructs the class, so the getter works after a round trip. A test pins both
halves: `message` absent from the encoded value, present after decoding.

## Effect language service

Adopted as part of the toolchain (`npm run lint`). On a codebase that
typechecked cleanly and passed every test, it immediately found eight
`Effect.fn` calls written as immediately-invoked wrappers, a `yield*
Effect.never` that should have been `return yield*`, and several redundant
`Effect.gen` wrappers. All fixed; the diagnostic count is zero and is expected
to stay there.

Converting to idiomatic `Effect.fn` also removed a cast: inference through
`Effect.fn` produced the alignment `ToolExecution` had been asserting by hand.

One trap worth remembering: annotating the generator's return type
(`Generator<any, Result<Tools>, any>`) to steer inference collapses the error
and requirement channels to `unknown`, silently undoing the typed error channel.
Let it infer, and rely on the type assertions to catch regressions — which is
exactly how this was caught.

## Tracing

`Effect.fn` names every engine operation, so a trace reads as the execution
structure: `AgentSession.prompt` → `AgentSubmission.execute` →
`AgentRun.execute` → `AgentTurn.execute` → `LanguageModel.generateText` /
`ToolExecution.tool`. A test asserts that nesting from inside a tool handler.

Export is application wiring: `examples/tracing.ts` uses the in-tree OTLP
exporter at `effect/unstable/observability`, with no OpenTelemetry SDK
dependency. `@effect/opentelemetry` publishes a v4 version and is the bridge for
interop with existing OTel instrumentation.

## Effect ecosystem: what is used, and what is deliberately not

**Schema — adopted for ids and errors.** Correlation ids are
`Schema.String.pipe(Schema.brand(...))` rather than hand-rolled branded aliases,
so they carry a real validator and codec instead of a compile-time tag only.
Errors are `Schema.TaggedError`, so they stay ordinary yieldable Effect errors
while also being transportable across an RPC or HTTP boundary without a
parallel set of wire types. Both are covered by round-trip tests, including one
asserting a `RunId` is not assignable to a `SessionId`.

**Schema — still deferred for `AgentEvent`, now for a concrete reason.** The
earlier justification was stylistic ("do not freeze a wire format early"). The
real blocker is specific: v4 has no `Schema.Cause` codec — only internal
revivers — and `RunFailed`, `SubmissionFailed` and `ToolCallFailed` all carry
`Cause<unknown>`. Schema-defining the event ADT therefore requires first
deciding how a failure crosses a serialization boundary: a rendered summary, a
structured defect projection, or dropping the cause from the persisted form.
That is a persistence design decision, not a typing chore, and it belongs with
the package that needs it. Everything else about the events is already fixed, so
the codecs can be added without changing their shape.

**Platform (`effect/unstable/http`, `rpc`) — not in the kernel.** Serving a
session over HTTP is the `web`/`ag-ui` package in `ADDITIONAL.md`; §4 lists HTTP
servers as an explicit non-goal. The kernel's obligation is to make that package
possible without special privileges, which the event stream and the public
module API already do.

**`unstable/persistence` and `unstable/workflow` — the later packages.** The
durable mapping sketched in `ADDITIONAL.md` (submission as workflow, model and
tool calls as activities) is the right shape, and the explicit execution
boundaries here exist to support it. Reaching for it now would embed a durable
execution model in a runtime that has no persistence yet.

**Telemetry — already handled, and duplicating it would be wrong.**
`LanguageModel.generateText` emits its own span with GenAI semantic conventions
from `effect/unstable/ai/Telemetry`. The harness's `AgentTurn.execute`,
`AgentRun.execute` and `ToolExecution.tool` spans are its parents, so a trace
already nests correctly. Adding GenAI annotations at the harness layer would
restate what the model layer owns.

**`Metric` — not in core.** Turn counts and tool latencies are exactly what a
telemetry package should derive from the event stream. Putting meters in the
kernel would give observability a second, privileged seam alongside the events,
which is the thing the event stream exists to avoid.

## Invariants, and where they are enforced

Each is asserted by a test, not merely documented.

* **History ownership** — only `internal/history.ts` writes, and only
  `AgentSession` owns the ref.
* **Derived context** — `ContextTransform` returns a separate `Prompt`, so
  non-mutation is structural. Test: the model sees injected content that never
  enters history.
* **Single execution** — `prompt` rejects with `AgentBusyError` while running.
* **Submission completion** — `prompt` resolves only at quiescence; asserted via
  `runs`/`turns` in the result and the exact event sequence.
* **Steering FIFO at turn boundaries** — drained in exactly one place, at the
  top of the turn loop. Tested from inside a model call and inside a tool.
* **No hidden steering cancellation** — the turn already running completes
  untouched.
* **Follow-ups schedule later runs** — same submission id, new run ids.
* **Tool ownership** — `disableToolCallResolution: true`; a counting handler
  proves exactly one execution.
* **Tool lifecycle** — every `ToolCallStarted` has exactly one terminal event.
* **Turn commit atomicity** — see below.
* **Event order** — sequence numbers asserted gap-free and monotonic.
* **Event stream is observational** — unbounded PubSub, never backpressuring
  the loop; documented as not a durability guarantee.

## Phase 4/9 — atomic turn commit

The previous prototype committed the assistant message, then ran tools, then
committed their results. Interrupting between the two left history holding an
assistant message requesting tools whose results never arrived — a state no
later model call can interpret.

A turn now buffers both and commits once, after all its work succeeds. Two
tests cover it: interrupt during the model call, and interrupt while a tool
hangs. In both, history keeps only the completed earlier turns.

## Phase 11 — tool failure policy, resolved

Both policies are implemented and tested rather than one being assumed:

* `ToolExecution.ReturnToModel` (default) commits a failed `ToolResultPart` so
  the model gets another turn to react.
* `ToolExecution.FailRun` propagates, failing the run and its submission.

The decision lives on `Agent`, not `AgentLoop`. The loop answers "should there
be another turn"; this answers "was that an error at all", which is upstream of
it — putting it in the loop would force the loop to inspect tool results it
otherwise never touches.

`ReturnToModel` is the default because the common tool failure is a bad
argument the model can correct, and destroying the run for it wastes the
context just built. A documented decision, not a placeholder.

**Defects are excluded from the choice** (open question 46.2, resolved *yes*):
a defect means the handler is broken, not that the model erred, so it always
fails the run. Tested under `ReturnToModel`.

**Parallel failure aggregation** (46.3) follows from the above rather than
needing its own knob: under `ReturnToModel` a typed failure is not an error, so
siblings always finish; under `FailRun` the first failure interrupts them,
which is ordinary `Effect.all` semantics.

## Open questions resolved

* **46.1 tool failure policy** — configurable, defaulting to `ReturnToModel`.
* **46.2 defects vs typed failures** — defects always fail the run.
* **46.3 parallel aggregation** — falls out of the policy; no separate setting.
* **46.4 prompt result type** — a small structured `Result` carrying
  `submissionId`, `status`, `runs`, `turns`, `text` and the final `response`,
  so usage and finish reason are not discarded.

## A plan inconsistency (guidance #15)

§11 names the event `ToolCallCompleted`; the Phase 10 example sequence names it
`ToolCallSucceeded`. Nothing else distinguishes them, so I read it as one event
under two names and kept the ADT's spelling. If the Phase 10 name was meant to
signal a three-way outcome (succeeded / failed / interrupted) as distinct
tags, that is a real semantic difference and the ADT should change instead.

## Deviations from the plan

**Event Schemas are not exported.** §42 lists Schemas for ids, events,
statuses, decisions and errors. Ids, statuses and decisions are plain types;
errors are `Data.TaggedError`. Full event Schemas exist to serialise events,
and the only consumer of that is persistence — explicitly post-v0.1. Adding
them now would freeze a wire format before anything reads it, against guidance
#2 and #14. The types are exported; the codecs should arrive with the store
that needs them.

**Dynamic toolkit resolution is implemented, against §46.5.** That section says
not to implement it until a concrete example requires it, and no example here
requires it: every test could use a plain toolkit. It is one `Effect.isEffect`
branch in `AgentTurn`, and §18 treats varying capabilities as central — but
§46.5 is the later and more specific instruction, so this is a deviation rather
than a judgement call. Removing it means deleting that branch and narrowing
`ToolkitInput` to `Toolkit.WithHandler`; say the word.

**`ToolExecution.execute` is exported.** §41 suggests keeping it internal. It
is a legitimately reusable primitive and the module must export it for
`AgentTurn`; splitting it into `internal/` for the sake of the export list felt
like churn. Say the word and it moves.

**No streaming.** Per guidance #11, `MessageDelta` is absent rather than
half-implemented.

## Definition of done

The §50 program runs against the fake model as a test, asserting that the steer
lands inside run 1 and the follow-up becomes run 2. The same program is wired to
Anthropic in `examples/anthropic.ts`.

That example is **typechecked but not executed**: running it needs an
`ANTHROPIC_API_KEY` and would make live billed requests. It proves the layering
claim — the agent definition names no model, and provider choice is ordinary
Layer wiring — but the "works against a real provider" half of §50 is
unverified at runtime and needs one manual run with a key.

## Effect v4 migration notes

Mechanical renames: `Cause.isInterruptedOnly` → `hasInterruptsOnly`,
`Exit.isInterrupted` → `hasInterrupts`, `Effect.fork` → `forkChild`,
`Prompt.merge` → `Prompt.concat`, `Fiber.RuntimeFiber` → `Fiber.Fiber`.
`Effect.dieMessage` is gone. `Effect.yieldNow` is a value, not a function.
`Effect.forkIn` is data-last only. `SubscriptionRef.get`/`.changes` are module
functions. `Effect.reduce`'s seed is a `LazyArg`. `Tool.make` takes a real
schema. `Cause.findErrorOption` replaces failure extraction.

Two changes carried real semantic weight:

* **`Queue.takeAll` now waits for at least one element.** The non-blocking
  drain is `Queue.clear`. Every steering and follow-up drain uses `clear`;
  `takeAll` would deadlock the turn loop whenever nothing was pending.
* **Tool handlers return `Effect<Stream<HandlerResult>>`**, so a tool can emit
  preliminary results before its final one. Only the final result is committed;
  surfacing preliminary ones belongs with streaming.

## Two bugs worth remembering

**A timing-dependent interrupt test.** Two tests waited for
`activeRunId !== null` then interrupted, but a run becomes active slightly
before it reaches the model, so the interrupt could land first and the run
would consume no scripted turn. It passed on v3 by luck. The fake model now
exposes a `started` deferred that fires when a model call is genuinely entered.

**A silently empty toolkit.** Writing `Toolkit.make(T).pipe(Effect.provide(
Toolkit.make(T).toLayer(handlers)))` builds two unrelated toolkits, so the
handlers attach to the one that is not used. Calls then resolve to nothing and
succeed — no error anywhere. The `toolkitOf` test helper exists so this cannot
recur.
