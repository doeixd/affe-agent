# Implementation status — v0.1

Built on **Effect v4 (`effect@4.0.0-rc.111`)**. The AI modules live in-tree at
`effect/unstable/ai`; `@effect/ai` has no v4 line and is not used.

`npm test` — 281 passing. `npm run lint` — 0 Effect diagnostics.
`npm run typecheck` — clean, including all examples. `npm run verify:package`
imports every published entry point from the packed tarball.

**The engine is generic end to end.** `Session`, `AgentTurn`, `AgentRun`,
`AgentSubmission` and `ToolExecution` all carry `Tools`, so tool types are never
erased internally and then re-asserted at the boundary.

**User-side code needs no casts and no type annotations.**
`examples/typed-agent.ts` is a full typed agent written with zero casts and zero
annotated parameters, carrying compile-time assertions that inference stays
precise rather than degrading to `any` — because `any` compiles, so a passing
build proves nothing on its own.

The kernel vocabulary has not grown. Everything below the first block is built
*from* it rather than into it, which is the property the whole design was
betting on.

```
src/
├ Agent.ts             reusable agent definition (carries no model)
├ AgentSession.ts      the session handle, and its module functions
├ AgentSubmission.ts   prompt + follow-up chain (internal vocabulary)
├ AgentRun.ts          turns until the loop stops
├ AgentTurn.ts         one model call + its tools, committed atomically
├ AgentLoop.ts         continuation policy (Continue | Stop)
├ AgentEvent.ts        event ADT + correlation envelope
├ ContextTransform.ts  canonical history -> ephemeral model prompt
├ ToolExecution.ts     concurrency strategy + failure policy
├ InputChannel.ts      where out-of-band input waits (the one durable seam)
├ Errors.ts            the typed failures
└ internal/            ids, eventBus, history, state, stream accumulator
│
├ testing/             scripted model + lifecycle probe   (/testing)
├ compaction/          summarise the head, keep the tail  (/compaction)
├ client/              protocol-neutral session transport (/client)
├ rpc/                 Effect RPC client + server rendering  (/rpc)
├ http/                plain JSON routes + live SSE events   (/http)
├ durable/             the same agent inside a Workflow   (/durable)
├ cluster/             a session as a cluster Entity      (/cluster)
└ mcp/                 expose an agent, and bind its tools (/mcp)

scripts/verify-package.mjs   imports each entry point from the packed tarball
.github/workflows/ci.yml     check, build, and that verification
examples/                    typed agent, tracing, durable, a real provider
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

## Review findings (REVIEW.md)

All eleven core items are addressed. Five were already done; the rest:

**`Tool.needsApproval` was silently bypassed (P0).** Effect AI's resolver
honours it, and the harness resolves tools itself, so a tool marked as needing
approval simply ran. It now fails with a typed `ToolApprovalRequiredError`,
emitted as a `ToolCallFailed` so the lifecycle invariant still holds, and never
returned to the model — this is the harness refusing, not an outcome the model
can correct. A dynamic `needsApproval` counts as requiring approval, since
deciding otherwise means evaluating it and acting on the answer.

**Provider-executed tool calls were executed locally (P1).** `toolCalls` now
means "calls this harness must execute": provider-executed ones are filtered,
so they are neither re-run nor counted by `untilIdle` as outstanding work.

**`ContextTransform.compose` overloaded `canonicalPrompt` (P2).** `Context` now
carries both `canonicalPrompt` (always the committed snapshot) and `prompt`
(the derivation so far). Threading the accumulator through `canonicalPrompt`
made the field mean two things by position — the one distinction this design
cannot blur.

**The typed example was runtime-invalid (P2).** It steered after `prompt`
resolved, which is by definition idle. It now forks the submission, waits for
`running`, steers, and joins. Examples are copied verbatim, so this mattered.

**Namespaces normalised (P3)** from `@effect-harness/*` to
`@doeixd/effect-agent/*` before anyone persists a branded id.

**Durable `steer`/`followUp` bypassed admission.** They wrote straight to the
store, so input for a finished submission was accepted and never drained. They
now check an admission marker the submission owns — the durable counterpart of
core's `acceptingFollowUps` — opened by `submit` before dispatch and cleared
however the submission ends.

Both previously-deferred items are now done.

**Canonical history moved out of the observable `SubscriptionRef`** into its own
`Ref`. Both stay session-owned, but they change for different reasons: every
commit appends to an ever-growing `Prompt`, and a UI subscribed for status and
turn progress was being handed the entire transcript each turn. A test asserts
that every state emission describes runtime progress only.

**The typed-failure gap turned out to be a much worse bug than `orDie`.**
`Activity.make` defaults its error schema to `Schema.Never`, so an activity whose
`execute` fails cannot encode the failure and the engine records an unencodable
`SchemaError` instead — every tool and provider failure under the durable
interpreter was destroying its own failure information. Activities now carry an
outcome as a value (`Succeeded | Failed`) and the wrapper re-raises
`DurableToolFailure`/`DurableModelFailure`, which also makes failures replayable.
Interruption is excluded: it is the run going away, not a tool outcome.

The outcome needs a real schema rather than `Schema.Unknown` — response parts
are class instances `Unknown` cannot encode, which is why a parts schema existed
in the first place.

## Type-story gaps

Three gaps where the types claimed more, or allowed less, than the runtime.

**Tool parameters reach the loop encoded, and were typed decoded.** With
`disableToolCallResolution: true` Effect AI leaves parameters in encoded schema
form — `GenerateTextResponse`'s second type parameter defaults to `false`, so
`GenerateTextResponse<Tools>` silently claimed decoded. Invisible for
`{ query: Schema.String }`; wrong for any transforming schema. Now threaded as
`true`, with a `Schema.DateFromString` test showing the loop observing the raw
string while the handler receives a `Date`. See PLAN §33.5.

**Tool requirements did not reach `AgentSession.make`.** A tool declaring
`dependencies` produced a handler requiring those services, but `ToolkitInput`
erased them, so the program typechecked and failed at the first call.
`ToolkitInput<Tools, R>` now carries them into the agent's `R`; a type-level
assertion proves omitting the service cannot compile. See PLAN §33.6.

**Input was `string`, excluding multimodal prompts.** `prompt`, `steer` and
`followUp` take `Prompt.RawInput`. `InputChannel` carries `Prompt`, and the
durable store holds prompts encoded through their Schema, so a key-value store
still backs it unchanged.

A related ergonomic fix fell out: `Agent.make` accepts a bare function for
`loop` and `contextTransform`, so writing one inline gets `Tools` by contextual
typing from the toolkit on the same object — without that, `state.toolCalls` is
`unknown` unless the user writes a type argument.

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

**Process loss is now covered too**, and closing it found two real bugs. First,
`Workflow.suspend` signals by setting a flag on the `WorkflowInstance` and
interrupting the fiber — and a session absorbs interruption by design, so the
workflow body returned normally and committed `Success("")`. Losing a runner
*finalised* the submission instead of leaving it resumable. The body now checks
`instance.suspended`, re-suspends, and keeps the session's open marker while
suspended. Second, shards stay leased until `shardLockExpiration` (35s by
default) elapses; calls routed through a shard mid-reassignment are rejected as
**defects**, which `result`'s `"pending"` retry never saw. `submit`, `steer`,
`followUp` and `result` now retry through reassignment and re-raise everything
else. A test tears runner A down mid-suspension and resumes from runner B over
the same database, asserting turn 1 is replayed rather than re-issued.

Phase 6 turned up a design error worth remembering: an entity handler must not
block on a workflow. The handler holds the session's mailbox, and starting a
workflow routes back through the same runner, so the two deadlock. Handlers now
derive the execution id and fork the execution.

## Hardening pass on /durable and /cluster

The workflow boundary has a typed error channel at last. It declares
`DurableAgentFailure` and projects a failed run's `Cause` into it, so a caller
in another process branches on a real `_tag` instead of receiving an opaque
defect. It cannot be the agent's own `PromptError<Tools, E>` — there is no
schema for an arbitrary `E` — so the projection carries tag, detail and whether
it was a defect. Interruption is deliberately excluded: suspension *is*
interruption, and projecting it would permanently fail every parked submission.

Projecting a cause turned out to be lossier than expected. `Schema.TaggedError`
subclasses inherit `Error`'s empty `message` unless the author overrides it, so
most failures reduced to a bare tag with no detail. The projection now falls
back to rendering the error's own named fields, which is where tagged errors
keep their information.

On the cluster side, three pre-release breaking changes to `AgentEntity`:
`steer`/`followUp` declare `AgentIdleError` rather than dying on it, so a remote
caller can distinguish an idle session from a downed runner; `interrupt` takes
no payload, because the execution id is a pure function of the session and
asking for one only allowed interrupting the wrong thing
(`DurableAgent.executionIdFor` exposes the derivation); and payloads are
`Prompt`, matching core's multimodal surface. The `as unknown as` cast on the
handler layer was unnecessary once the handlers stopped `orDie`-ing.

`EntityClient` closes the wrapper gap. The generated entity client is a faithful
rendering of the wire protocol, which is not the same as a good API: it demands
a `Prompt` where the rest of the library takes `Prompt.RawInput`, and it carries
the cluster's transport failures in the same channel as the one domain failure a
caller can act on. Worse, `Prompt.Prompt` as an RPC payload *accepts a bare
string at the type level* and rejects it at encode time, so a wrong call site
compiles and fails at runtime — which is exactly how the cluster test broke.

`EntityClient.wrap` normalises through `Prompt.make`, retries transient cluster
conditions (reassignment, `MailboxFull`, `AlreadyProcessingMessage`), and dies
on the rest. The result is `submit`/`interrupt` with no error channel at all and
`steer`/`followUp` failing only with `AgentIdleError`. `EntityClient.client` is
the sharded version; `wrap` is exposed separately so a test client gets the same
treatment. Errors are matched by `_tag` rather than `instanceof`, since they are
rebuilt by their schema on the far side of the wire.

## Hardening pass: two bugs that only real storage could show

**Every durable submission whose model called a tool failed.**
`DurableAgent.workflow` defaulted its toolkit to `Toolkit.empty` when the
`options.toolkit` override was absent, instead of taking it from the agent. An
empty toolkit makes `Response.Part(toolkit)` produce a part union with no
`tool-call` variant, so the first response containing a tool call failed to
encode — surfacing as a model failure with nothing pointing at the toolkit. It
went unnoticed because the API required passing the toolkit *twice*, to
`Agent.make` and again to `workflow`, and every existing test happened to do
both. The toolkit is now resolved from the agent, and the option is an override.

**A tool returning a non-JSON value killed the submission on SQL storage.**
Tool results were journalled under `Schema.Unknown`. A handler result carries an
`encodedResult` (JSON, for the model) *and* a decoded `result` — whatever the
tool's success schema produces: a `Date`, a class instance, a branded type.
`Schema.Unknown` cannot encode those, so SQLite rejected the write with
`SchemaError: Expected JSON value`. The in-memory engine does not enforce JSON,
which is exactly why every test passed. Results are now journalled through the
tool's own schema, split on success/failure because a failed call's `result`
holds the tool's failure value, which a success schema would reject.

Worth keeping: these were found by writing a test against SQLite rather than the
in-memory engine. Both were invisible to `TestRunner`.

**`ScheduledAgent` had no tests and a signature that erased its requirements.**
It was annotated `Layer<never, never, WorkflowEngine | any>`, which is just
`Layer<never, never, any>` — the union swallows everything, so callers lost
requirement checking entirely, and a cast held it in place. The return type is
now inferred. Its `sessionId` also defaults to one derived from the firing time:
a submission's idempotency key is its session, so a scheduled agent that reused
one session ran once and then silently did nothing forever.

## Resolved: admission at quiescence under durability

Core promises that an accepted follow-up is processed: `AgentSubmission` drains,
closes `acceptingFollowUps` atomically, then drains **once more** so nothing
accepted before the close is stranded. The durable path could not use that gate
— `followUp` is called from another process — so it read a marker in the store
instead, and that marker was only cleared when the workflow exited. A `followUp`
landing after the closing drain was accepted, written to the queue, and then
discarded by `AgentSession.release`, whose job is to drop leftovers. The caller
was told the work was accepted and it never ran.

Pinning it down took instrumenting from core's side rather than the store's. An
earlier attempt wrapped `Store.takeAll`, which counts *activity executions* and
also sees the steering and marker keys, so the injection point could not be
identified — the resulting evidence was unreliable enough to be discarded. The
follow-up channel is drained exactly twice for a single-turn submission (once at
the top of the loop, once after the gate closes), so offering immediately after
the second drain hits the window every time.

The fix is a seam, not a special case. `InputChannel.Factory` gained an optional
`setAdmitting`, which the session calls at the exact moment its gate moves; the
durable factory implements it against the store marker. Ordering carries the
whole guarantee: the close is published *before* the closing drain, so anything
accepted while the marker was stale was necessarily offered earlier and the
drain catches it, and anything later is refused. Publishing after the drain
leaves precisely the gap it was meant to remove — that ordering was reverted
once to confirm the test fails.

Two things learned:

* An earlier fix attempt put the closing drain in the *workflow body*. It could
  never have worked: `AgentSession.release` runs first and deliberately drops
  whatever is queued, so the body always saw an empty queue. The body is too
  late to be the place where this is fixed.
* `release` must **not** withdraw admission, even though it looks like the
  natural place. It also runs when a run is merely interrupted, and under
  durability that includes a submission suspending. A parked submission is still
  open for business, so withdrawing there refuses steering aimed at a run that
  is about to resume.

## The gate had a hole on the in-process side too

The durable fix published the close before the closing drain, which is sound
for a caller who checks the marker and writes as one operation — but the
in-process `followUp` never offered atomically. It read
`acceptingFollowUps`, and offered to the queue as a second step. The
submission could close its gate and run its final drain in between: the
read said *open*, the offer landed after the drain had already looked, and
`release` discarded it. The caller was told `FollowUpQueued`; the work never
ran. Same disease the gate was built for, surviving on the other side of the
publish ordering.

The fix is a per-session semaphore (`Session.inputGate`) held across
check-and-offer in `AgentSession.followUp` and across the closing drain in
`AgentSubmission.execute`. The two pairs are now mutually exclusive:
anything offered while the gate read open is still in the queue when the
closing drain runs, and anything offered later reads a closed gate and is
refused outright. Steering is deliberately left outside the gate: steering
arriving during the final turn is already never applied, so dropping one at
quiescence is consistent semantics rather than a broken promise.

Reproduced deterministically by parking the channel's `offer` mid-call —
after the gate check, before the insertion — and releasing it only once the
first empty drain had been seen (`test/FollowUpOrder.test.ts`). With the
ungated closing drain the test fails; with the permit, the late item is
caught and executed.

## Announcements moved under the gate too

Extending the permit to every drain closed a second gap for free. The
acceptance events — `FollowUpQueued`, `SteeringQueued` — were published after
the offer returned, outside any exclusion, so a drain could consume the input
and commit `FollowUpApplied` before `Queued` ever reached the stream: PLAN
§27's ordering held by scheduling luck. Offer and announcement now share the
gate with the mid-run drain, the steering drain at the turn boundary
(`AgentTurn.applySteering`) and the closing drain, so nothing can observe an
input whose acceptance has not been announced.

One consequence is worth stating: a channel whose `offer` parks now holds up
the next drain. That is deliberate — an offer that has been admitted must be
announced before anything can act on it, and in-memory offers never park
anyway. It also makes the original defect unschedulable rather than merely
unlikely: reproducing it requires the parked offer to slip past a drain that
is waiting on the very permit the parked offer holds. The falsification pass
reflected exactly that — breaking the fix (moving the announcement back
outside) no longer produced a failing run in ten attempts, because the
interleaving that made it observable is gone. The tests pin what remains
externally decidable: accepted work executes, refusals store nothing, and
`Queued` precedes `Applied` under concurrent offers.

## The durable side had the same hole, wider

`DurableAgent.steer` and `followUp` checked the marker and wrote the input as
two store round-trips (`admit`, then `offer`) — the same check-then-act, over
a network. A sender that read an open marker could have its write land after
the submission's closing drain had already looked: accepted, never drained.
The ordering argument for publishing the close before the drain assumed
check-and-write was one operation, and nothing made it one.

Admission is now a single store operation. `Store.offerIfOpen(key, input,
gateKey)` checks the gate and inserts inseparably — one `Ref.modify` in
`memoryStore`, one transaction in `sqlStore` — and `DurableAgent.steer` /
`followUp` refuse with `AgentIdleError` when it returns false. It is required
on the interface rather than composed from `size` and `offer` here, because
composition is precisely what reintroduces the gap. Pinned by contract tests
against both stores and real SQLite (`test/DurableAdmission.test.ts`),
alongside the end-to-end case: input offered after quiescence is refused
*typed*, and nothing lands in a queue nobody will drain.

## A store a cluster can actually use

The library shipped only `memoryStore`, and under the cluster that is silently
wrong rather than merely limited. `steer` is routed to whichever node the caller
reached; the submission it targets runs on the node owning the session's shard.
The steering is written to one process's map and drained from another's, so it
is accepted and never seen. Nothing fails — the input disappears.

`DurableChannels.sqlStore` closes that, with no new dependency: `SqlClient` is
in-tree at `effect/unstable/sql`, and any deployment already has one because
`ClusterWorkflowEngine` needs it for the journal. `sqlStoreWithTable` creates the
table for development; a deployment managing its own schema uses `sqlStore`.

Two properties are load-bearing and tested against real SQLite rather than
asserted. Ordering: rows are drained by autoincrement `id`, because callers
depend on follow-ups running in the order they were queued — a reordering bug of
exactly that kind turned A, B, C into A, C, B once already. Atomicity: a drain
reads and deletes in one transaction, so concurrent drains cannot hand the same
value to two callers or lose one offered in between.

The table name reaches `sql.literal`, which does not parameterise, so anything
that is not a plain identifier is refused rather than quoted.

## Multimodal submissions across the journal

The workflow payload is a `Prompt`, and the claim throughout has been that
`Prompt` carries its own Schema so a multimodal submission survives the journal
exactly as a text one does. That was never exercised against real storage, which
is where the last two bugs in this area came from.

It holds, with one caveat worth knowing. A `Uint8Array` in a file part survives
in *content* but not in *representation*: `Prompt` encodes it as base64, and
decoding leaves it a base64 string rather than restoring the array. That is
Effect AI's wire form rather than a choice this library makes, but it is a real
difference between a fresh run and a resumed one — a tool that branches on
`instanceof Uint8Array` takes the other arm after a durable round trip. Pinned
by a test so it cannot change silently.

## Tool progress events

`Toolkit.handle` returns a `Stream`, and a handler reports intermediate results
through `context.preliminary`. `ToolExecution` collected that stream with
`Stream.runCollect` and used only its last element, so the intermediate results
were computed and thrown away: a long-running tool was invisible for exactly as
long as it was interesting.

It now folds the stream, emitting `ToolCallProgress` as each preliminary result
arrives. Only the final result is committed, so canonical history is unchanged —
progress is observational.

One design detail is worth keeping, because the first version got it wrong and
looked right. Emitting the *previous* result when the next one displaces it
gives identical output for a tool that streams steadily, and needs no trust in
the `preliminary` flag. But it withholds the last report until the handler
finishes, so a tool that reports progress and then waits — for a build, a remote
call, an approval — has its most useful report delayed until the moment it stops
mattering. The test for it deadlocked, which is the honest form of that bug.

## AgentSession as a method-bearing handle (issue #2)

`AgentSession.make` now returns a small typed handle: `prompt`, `steer`,
`followUp`, `interrupt` as methods, `history`, `status`, `events` and `state` as
values, plus a public `id`. The module functions stay and are the single
implementation — the methods delegate to them, so there is one set of semantics
and one set of spans. The handle is inert: building `session.prompt(input)`
starts nothing.

The change paid for itself immediately by removing the last `as unknown as` in
`AgentSession.ts`. Construction was previously an assertion because `Tools` and
`E` lived in a phantom field with no runtime counterpart; carrying them in the
method signatures means the compiler can check the construction instead of being
told to trust it.

It also exposed a claim that had been false the whole time. The phantom declared
`out Tools` — covariance — but a submission's `Result` holds a
`GenerateTextResponse<Tools, true>`, which Effect AI makes **invariant** in
`Tools`. With real members the compiler checks the annotation against the
structure and rejects it. The annotation is gone rather than worked around, so
the type now states what is true: a session built with a toolkit is not
assignable to `AgentSession<{}>`. Three tests were relying on that false
covariance and now name their tool type, which reads better anyway.

## Model streaming (roadmap #1 item 3)

`prompt(input, { stream: true })` streams the model calls, emitting
`MessageStarted`, `MessageDelta`, `MessageStreamCompleted` and
`MessageInterrupted`. Request-level rather than part of the `Agent`, because
whether a run is interactive depends on the caller.

The design keeps one shape flowing through the harness. A stream is folded back
into the `GenerateTextResponse` a batch call would have returned, so everything
downstream of the model call -- tool execution, the loop, the single atomic
commit -- is byte-for-byte the same code. Streaming changes when output is
observed, never what is recorded, and a test asserts that by running one script
both ways and comparing the resulting history.

Deltas are normalised to `{ kind, delta }`. Exposing the provider's stream
protocol as the harness event model would make every consumer track chunk ids,
start and end markers, and per-provider differences.

Three cases in the accumulator are handled rather than assumed away: a chunk
the provider never closed is flushed, a delta with no matching start is
accepted, and an error reported *inside* the stream is surfaced instead of
folded in -- committing a turn the provider just disowned would be wrong.

`MessageInterrupted` is emitted from a finalizer, not after the fold, because
on interruption the continuation never runs. Every opened message owes a
terminal event or a consumer is left rendering one that never resolves. The
matching history guarantee is tested directly: interrupt mid-stream, and
canonical history holds only the user message.

## Streaming under durable execution

Adding streaming to core made `prompt(input, { stream: true })` under
`/durable` reachable for the first time — and it died, because `DurableModel`
had no `streamText`. Defining that interaction was the last open item in the
durable review.

The separation the plan draws settles it. The workflow journal is *computation*
durability; canonical history is *semantic* state; reconnectable streaming
output would be a *delivery log*. Journalling every token delta would put a
delivery concern in the computation journal and make a replayed turn depend on
how a provider happened to chunk its output.

So the journal keeps exactly what it kept before: one entry per model call,
holding the completed response, produced by the same activity whichever way the
caller asked. `DurableModel.streamText` then produces its stream from that
response. A streamed durable submission therefore commits precisely the history
a batched one does, on the first run and on replay, and a resumed run replays
the journalled response rather than re-issuing it.

Two limitations, stated rather than hidden. Deltas arrive **whole** — the
original chunking is a property of the provider's connection, not of the turn.
And they are emitted *inside* the workflow, where a consumer in another process
cannot see them; live remote streaming needs the delivery log, which does not
exist. `DurableAgent.workflow` takes `stream` as a definition-level option, so
replay makes the same choice the original run did.

## Compaction (roadmap #1 item 5)

The interesting thing about compaction is how little it needed. It is a
`ContextTransform` and nothing else — no kernel change, no new seam, no
cooperation from `AgentSession` — which is the strongest evidence so far that
the canonical-history / derived-context split was the right shape.

Canonical history is never rewritten, truncated or summarised in place. The
projection becomes a summary of the head, the retained tail, and everything
since. A destructive alternative would have been simpler and irreversible:
nothing could later re-derive a longer window, audit what the model was told, or
change the strategy mid-conversation.

Two details carry the design. The threshold counts only what has accumulated
*since* the last checkpoint, or a conversation past the line re-summarises every
turn — the expensive thing compaction exists to avoid. And the retained tail is
kept verbatim, because it is what the model is still reasoning over; summarising
it would compact away the live part.

Worth recording a testing mistake: the first version of the checkpoint-reuse
test asserted `summaries < 8`, which passes whether or not the checkpoint is
used. Measuring both ways gave 3 with the checkpoint and 6 without, so the
assertion is now exact. A bound that cannot discriminate is not a test.

## Session snapshots (roadmap #1 item 8)

`AgentSession.snapshot` / `restore`, with `Snapshot` as a Schema value. Enough
for stored conversations, shutdown and restart, and deterministic fixtures,
without committing to a WAL or an event-sourced model.

The scope is the design. A snapshot holds the conversation and the session id
and nothing else: a session also owns a scope, a fibre, an event bus, queued
input and a captured environment, none of which are data and all of which belong
to the process that created them. Identity is kept because durable and
distributed correlation depend on it; a restored session has no history of
*events*, because those described a run that is over.

Snapshots are refused for a running session. A turn commits its assistant
message and its tool results as one unit, so a snapshot taken between them would
record a conversation that never existed. Waiting for quiescence is the caller's
job, and `AgentBusyError` is how they find out they have not.

`MakeOptions.history` is the mechanism, and it *replaces* the agent's
instructions rather than being prepended: a restored transcript already contains
whatever system message the original session opened with, and prepending a
second one would quietly change what the model sees on every subsequent turn.

## The transport seam (roadmap #1 item 6)

`@doeixd/effect-agent/client` gives adapters — RPC, HTTP/SSE, AG-UI, A2A — one
notion of what a session is, instead of each inventing its own.

The design work was deciding what *cannot* cross. `AgentSession` carries the
agent's tool types, hands back a `GenerateTextResponse`, and fails with whatever
the agent's tools and transforms fail with. A caller on the far side of a wire
has none of that: no tool definitions to interpret a typed tool failure, and no
format that carries a provider response. So `RemoteResult` drops the response
rather than half-encoding it, and non-protocol failures arrive *described*
rather than typed — honest about what crossed, instead of pretending a shape
survived that did not.

What stays typed is what a remote caller can act on: busy, idle, closed, and
transport. Every one is a `Schema.TaggedError`, so the union survives the wire.

`fromSession` is exported because an RPC *server* needs exactly this projection;
writing it once here is the difference between a seam and a convention. The
in-process layer is both a real implementation and the reference the others are
checked against.

`AgentProtocol` now fixes the wire vocabulary before any one transport gets to
choose it: branded session, submission and request ids; schemas for every
session operation and response; the existing ordered event envelope; and a
serializable error union that distinguishes lookup, conflict, authorization,
capacity, execution, transport and codec failures. `RemoteResult.submissionId`
was tightened from a plain string to its existing schema brand; the inference
assertion was deliberately broken once to prove that widening is detected.

The protocol server host stays internal even though RPC and HTTP are now two
real consumers: it is shared adapter machinery, not a new end-user concept.
It acquires every session in a child scope linked to the server
scope, publishes it only after acquisition succeeds, closes it explicitly or at
shutdown, and serializes create/close transitions. Its policy is explicit:
capacity refuses a new session rather than evicting live work.

Mutations are idempotent by request id. One request owns a `Deferred`; exact
duplicates join it, completed duplicates replay it, and a reused id with a
different operation or payload is a typed conflict. The mutation fiber belongs
to the host scope rather than the first transport waiter, so disconnecting that
waiter cannot cancel work another retry is joining. Records are bounded per
session: completed entries are evicted FIFO, while a bucket containing only
in-flight work refuses another mutation with a typed capacity error. Every
operation passes through a caller-supplied authorization policy; allow-all is an
explicit test/example choice rather than a hidden default.

One note on Effect v4: service keys are `Context.Service<Self, Shape>()("key")`,
not `Context.Tag`, and a key is yielded with `Effect.service(Key)`.

## Effect RPC transport (issue #1)

`@doeixd/effect-agent/rpc` is the first real rendering of `AgentProtocol`.
`AgentRpc.Protocol` defines all twelve procedures directly from the canonical
request, response and error Schemas; `events` is an Effect RPC stream, so event
envelopes retain their per-session sequence order without a second wire model.

`AgentRpc.serverLayer` builds one scoped internal session host and resolves an
authenticated principal for every call from the RPC headers, operation and
optional session id. Authorization remains the host's separate concern. The
layer stops at Effect RPC handlers on purpose: applications choose
`RpcServer.layer`, HTTP POST, WebSocket or another upstream protocol rather than
the harness hiding serialization and transport configuration.

`AgentRpc.clientLayer` exposes the exact schema-derived client, including
`RpcClientError` only on the transport side. Domain errors decode as their
original tagged classes. `AgentRpc.acquireSession` is the ownership helper: it
installs a remote close finalizer whose request id is derived from the create
request id, making finalizer retries deterministic and idempotent. A direct
`getSession` attaches without taking ownership or installing a close finalizer.

Conformance runs through `RpcTest`, a real Node HTTP server with NDJSON, and a
real WebSocket connection. The tests cover every operation, error typing,
authorization metadata, request retry after the first waiter is interrupted,
ordered streaming, retry after a real HTTP disconnect, explicit socket shutdown
and exact server span ancestry.
The propagated client trace id is asserted at the host mutation, not inferred
from a passing request.

## HTTP and SSE transport (issue #1)

`@doeixd/effect-agent/http` exposes the same twelve operations as ordinary
JSON routes plus `GET /sessions/:id/events` as server-sent events. The path id
is projected into the canonical request before the shared host sees it; bodies,
responses and tagged failures use `AgentProtocol` rather than HTTP-specific
copies. `AgentHttp.Api` supplies a schema-generated Effect client, while the
same endpoints are verified with plain `fetch`.

The status policy is public and exhaustive: validation/codec failures are 400,
authentication 401, authorization 403, missing sessions 404, conflicts and
invalid state transitions 409, execution failures 422, capacity 429, and
transport failures 503. Expected errors have the canonical machine-readable
body. Defects remain server defects and are not rendered with an internal stack
by the adapter.

SSE is deliberately live-only. A subscription receives events published after
that observation begins; an `id` is the session-local sequence and `event` is
the harness event tag. Reconnection does not imply replay or a durable cursor.
A stream failure ends with an `error` SSE carrying the canonical remote-error
body. The JSON codec is explicit here because domain `Option` values project to
JSON only at the boundary.

Observer lifetime is independent of session lifetime. Disconnecting a client
interrupts only its event subscription, while an in-flight idempotent mutation
continues in the host scope for a retry to join. Conversely, closing the HTTP
layer signals every active SSE response before session teardown; this explicit
signal is necessary because response streams execute in request scopes rather
than the server layer's scope.

Real-network tests cover all routes through the generated client, plain-fetch
success and error bodies, concurrent controls during a prompt, an interrupted
waiter followed by an idempotent retry, SSE parsing and disconnect cleanup, and
whole-layer shutdown with an open subscription. The client response and stream
inference assertions were deliberately broken once and restored.

## AG-UI adapter (issue #1)

`@doeixd/effect-agent/ag-ui` is a projection over the same internal session
host, served as `POST /ag-ui`; it is not another execution runtime. The
production adapter is SDK-independent and Schema-defined. Conformance is pinned
to `@ag-ui/client` and `@ag-ui/core` 0.0.58 in development, so using the adapter
does not add either package to an application's runtime dependency graph.

The inbound codec accepts the official `RunAgentInput` wire type, including its
omittable default state, tools, context and forwarded-properties fields. A
compile-time assertion pins that assignability and was deliberately broken
before restoration. Only text user prompts are currently meaningful. Nonempty
client tools/context/state/forwarded properties and multimodal user input fail
with typed AG-UI errors instead of being accepted and ignored.

Thread ids are explicitly untrusted. The application first authenticates the
request, then resolves principal + thread id to a branded protocol session id;
the adapter never treats the client field as authorization. The resulting
session uses the host's bounded ownership, per-operation authorization and
idempotent request records.

The stateful outbound mapper derives stable message and step ids from harness
run/turn correlation. Native message deltas pass through once; a batch-only
message synthesizes start/content/end, and the later canonical completion after
a stream is suppressed. Tool arguments and results are JSON at the boundary,
progress and harness run metadata are named custom events, and every open text
or step frame closes before success, failure, interruption or human input.
Every golden event is also parsed by the official core event schema.

The adapter also owns its protocol construction sugar. `event(type, fields)`
is the single generic constructor seam; named `text`, `tool`, `step` and `run`
constructors remove magic discriminant strings, and semantic macros expand a
batch message, tool call, success or interrupt into exact plain protocol
values. `events(...)` and those macros preserve readonly tuples rather than
widening immediately to `Event[]`. A callable `run({ threadId, runId })` binds
correlation for a block but remains a pure value builder—construction and SSE
delivery are deliberately separate. All types derive from the Schema union,
and the one generic object-spread assertion is confined and documented at that
adapter seam.

Elicitation uses AG-UI's current interrupt/resume contract. The request stream
finishes with a `RUN_FINISHED` interrupt outcome while the host-owned prompt
remains suspended. A later request's `resume` entries call the existing
`respond` operation; unmatched interrupt ids are rejected rather than leaving
an SSE response open forever. The official client test covers the complete
interrupt/resume cycle.

Observer lifetime remains separate from operation lifetime. The adapter
subscribes before starting the prompt and coordinates fresh lifecycle events
against the cached-result fallback. Disconnecting the first HTTP observer and
retrying the same run therefore executes one prompt and delivers one balanced
official lifecycle to the retry. Real-network tests cover the official client,
plain JSON errors, human resume and this disconnect/retry path without sleeps.

## Elicitation: execution that needs an answer from outside

**Durable elicitation, which the docstrings had claimed and nothing
implemented.** Both `Elicitation` and `AgentSession` said a durable interpreter
substitutes a `DurableDeferred`-backed elicitor; `DurableAgent` did not mention
elicitation at all, so an approval-requiring tool under `/durable` silently got
the default and was refused. That is the third comment in this project found
asserting a property it did not have.

Now built. Awaiting a `DurableDeferred` *suspends the workflow*, so a submission
waiting for approval stops consuming anything and resumes in whatever process is
running when the answer arrives — which is the lifetime the feature actually
needs, since an answer from a human comes in minutes or days. `respond` derives
its token from the workflow and execution rather than holding it, because the
process that asked is typically gone.

Two consequences worth stating. `pending` returns nothing under durability: a
suspended workflow is not running, so no process holds a list. And request ids
are `elicit-N` per session in ask order, which is deterministic by design — that
determinism is what lets a caller answer without having observed the request,
since `ElicitationRequested` is emitted inside the workflow where nothing else
can see it.


`needsApproval` was detected and refused with no way to satisfy it — a dead end
rather than a feature. `Elicitation` is the general form, of which tool approval
is one instance: the same shape covers asking a user a question, requesting a
review, obtaining a credential, waiting on an external signal.

Deliberately not called *interrupt*. In Effect, and in `AgentSession.interrupt`,
interruption means a fibre being torn down. A pause that resumes is a different
thing, and giving them the same word would make both harder to reason about.

Two decisions carry it. The default answers *no*, so an approval-requiring agent
behaves exactly as it did before rather than beginning to wait forever for an
answer nobody is positioned to give — a caller opts in to being asked. And
`elicit` takes the announcement as an argument, running it *after* registering
the request: announcing first looks equivalent and is not, because the only
sensible way to answer is to react to the announcement, and a prompt consumer
would then answer a request nothing was waiting for. The answer is reported
unmatched and the run hangs, with the event stream showing a question asked and
answered. That ordering was got wrong first and caught by the tests.

## Three issues from a review pass

**`PromptError` omitted `ToolApprovalRequiredError`.** `ToolExecution` raises it
instead of running the handler, so it never appears in `Tool.HandlerError` — and
because `prompt` asserts its submission to `PromptError`, the public type
claimed an approval-requiring agent could not fail with the exact error it
throws. The assertion was hiding the omission rather than causing it, which is
what assertions do. The compile-time test that pins `prompt`'s exact error union
caught the correction immediately, which is what *it* is for.

**`/client` reported agent failures as transport failures.** Not merely
imprecise: dangerous. An agent failure is a property of the request and will
recur, so a caller retrying on transport failure would retry it forever, paying
for a model call each attempt. `AgentExecutionError` now carries the originating
tag and is distinct from `AgentTransportError`, whose whole meaning is that the
same call may succeed on another connection.

**`/client` could not ask for streaming.** The seam exposes `events` so a
consumer can render generation as it happens, which is only reachable if a
caller can request it — and the remote surface had no options parameter at all.
It now mirrors `AgentSession.PromptOptions`, minus anything that cannot cross.

## Type-safe tools from an MCP server

The question was whether an agent can have inferred tool types when the tools
come from MCP. Not from the server, no: `tools/list` is a runtime value and
inference is a compile-time operation, so there is nothing to infer *from*.

`McpToolkit.bind` takes the other route. Tools are declared locally, exactly as
for a local toolkit, and the server is verified against the declaration on
connect — failing with `McpToolMissingError` naming both the missing tools and
the offered ones, because "search is missing" is half an answer when the real
problem is being pointed at the wrong server. Verification is at bind time
rather than first call: a deployment mismatch should not be discovered
mid-conversation in production.

What the declaration then buys is a contract rather than an annotation.
Parameters are encoded through the declared schema on the way out and results
decoded through it on the way back, so a server answering the wrong shape fails
at the boundary with a typed error naming the tool. A transforming schema makes
that observable — the handler is given a `Date`, the wire carries a string, the
server's string comes back a `Date` — which is what the round-trip test asserts.

The type claim is checked the way this project requires rather than by
compiling: the loop reads `call.params.query` as `string`, and assigning it to
`number` is a compile error. Had `bind` returned a loosely-typed toolkit it
would have been `any`, and `any` compiles.

`Connection` remains an SDK-neutral interface. It is now implemented by
separate official TypeScript SDK adapters at `/mcp/v1` and `/mcp/v2`, so the
monolithic v1 and split-package v2 nominal client types never meet. `/mcp`
re-exports the v2 Streamable HTTP and stdio constructors as the default; their
client defaults to automatic modern/legacy protocol negotiation. Every owned
client is scope-bound, tool pagination and list-change notifications normalize
to Effect values, transport failures stay typed, and structured tool results
fall back to legacy single-text content when talking to older peers.

The v1 optional peer range begins at 1.10.0, the first release with the
Streamable HTTP client used by this surface. CI compiles the adapter against
that declaration floor while normal tests exercise the latest v1 release. A
real in-memory peer test covers each same-generation adapter, and compile-time
negative tests prove that v1 and v2 client objects cannot cross entry points.

The complete Streamable HTTP and stdio matrices now run through real peers:
v1/v1, v1/v2 legacy fallback, v2 automatic fallback to v1, and v2/v2 modern.
The tests assert the negotiated era and exact revision, not only a successful
tool call. HTTP additionally covers multi-page tool discovery, rich and legacy
results, reported tool failures, modern `subscriptions/listen` list changes,
Effect interruption reaching the server request signal, and subscription
removal at scope close. The stdio fixtures are real child processes with clean
protocol stdout; lifecycle records prove that modern cancellation reaches the
server and the process serving calls exits when its Effect scope closes.

Scripted hostile transports drive both official client generations with
schema-invalid discovery and invocation results. Their SDK validation failures
remain typed `McpTransportError` values at the Harness boundary, and a peer
disconnect during a call settles the request instead of stranding it. A
repeated pagination cursor is rejected rather than looping. Structured output
remains authoritative: if present but incompatible with the locally declared
success Schema, a valid-looking text fallback cannot mask the mismatch.

Rich protocol content now has an explicit boundary policy. A single text block
is the legacy fallback and structured content is the machine value; images,
resource links, embedded resources, mixed blocks and empty content fail with
`McpUnsupportedContentError`, which names the tool and observed content kinds.
They are never silently dropped or exposed as nominal SDK values.

The server direction now has real peer conformance too. Official SDK v1.30 and
v2.0 clients call the actual `AgentMcp` tool over Streamable HTTP and stdio.
Tests prove tool discovery, named-session continuity, anonymous-call isolation,
declared failure, malformed parameters, v2 automatic fallback to the exact
`2025-11-25` revision, child-process cleanup, and release of every named session
when the server layer closes. That last assertion exposed a Harness bug: named
session child scopes were kept in the registry but never closed by the handler
layer. Its finalizer now atomically drains the registry and closes each scope.

Effect `4.0.0-rc.111` exposes only the legacy `2024-11-05`, `2025-03-26`,
`2025-06-18`, and `2025-11-25` server adapters, so the Harness server advertises
those exact wire revisions rather than claiming SDK-major or modern-era
support. The v2 client proves the intended automatic fallback. There is one
upstream cancellation gap: Effect converts a legacy cancellation request id to
a string before looking up the numeric RPC fiber; HTTP cancellation also arrives
under a new request-scoped client id. Official-client protocol cancellation
therefore cannot interrupt this server yet. Scope shutdown remains structured
and deterministic, and the limitation is recorded rather than hidden by a
timing-based test.

A bug found immediately after, by testing the claim that a bound toolkit is
"indistinguishable from a local one". It was not: `failureSchema` was never
referenced and `callTool` had no channel for a tool-level failure, so a tool
declared with `failure:` could not fail in its declared way. The consequence was
larger than the omission — every server-side refusal escalated to an `AiError`
and ended the run, so the default `ReturnToModel` policy never engaged and the
model never got to react. `McpToolError` now carries what the server reported,
decoded against the declared schema; a server reporting an error for a tool
declared infallible is named as the mismatch it is rather than papered over.

## A2A v1 adapter (roadmap #1 item 7, in progress)

The first `@doeixd/effect-agent/a2a` vertical slice now serves a native A2A v1
Agent Card and JSON-RPC endpoint using the official `@a2a-js/sdk` 1.0.1 server
types and request handler. This is a protocol adapter over `AgentClient` and the
same internal session host used by RPC, HTTP and AG-UI; it is not another agent
runtime.

The application authenticates the HTTP request and resolves principal + A2A
context id to a branded Harness session id. A separate stable principal subject
scopes the official task store, so one authenticated owner cannot load another
owner's tasks. The official SDK owns v1 routing, task persistence and JSON
encoding; Harness owns authorization, execution and scope lifetime.

The current card advertises exactly the implemented surface: JSON-RPC with
streaming enabled and push notifications disabled. Blocking `SendMessage`
accepts text parts, emits the required submitted/working/completed task
lifecycle, and returns a text artifact; `GetTask` reads that owner-scoped stored
result. A second message carrying the first task's context id reuses the same
Harness session. The conformance test performs discovery, both sends and lookup
through the official v1 client against a real Node HTTP server, then asserts
that the one session is released when the server scope closes.

`SendStreamingMessage` is native v1 JSON-RPC SSE, not a separate wire model.
The official handler produces JSON-RPC response envelopes and the HTTP adapter
formats those with the SDK's SSE formatter. The exact observable sequence is
Task submitted, working status, artifact update, completed status; task,
context and artifact correlation are asserted at every step, followed by a
stored-task lookup. A canceled stream instead ends with one canceled status and
never exposes the executor's synthetic failure state.

Consuming the official SDK generator is also what updates its task store, so
the generator cannot belong to the HTTP observer. It is drained in a
layer-owned fiber into a finite response queue. Disconnecting the client ends
only that queue's observer while the task remains working; closing the layer
interrupts the drain, executor and hosted session together. The first bridge
used queue shutdown as completion and lost buffered terminal frames because
shutdown discards them. Completion is now an explicit sentinel, so every
queued protocol frame drains before the SSE body ends.

`CancelTask` is now covered through that same official client. The test starts
a prompt that blocks on a `Deferred`, waits for its actual start, asks the SDK
to cancel the submitted task, and proves that the stored terminal state remains
`CANCELED` while a later message reuses the session successfully. The first
implementation exposed a real ordering bug: interrupting the prompt rejected
the executor before the canceled status was published, so the official handler
persisted `FAILED` and rejected cancellation. The adapter now uses a two-phase
handshake: mark cancellation intent, resolve the Harness interrupt, publish the
terminal status, then release the executor. An interrupt failure still fails
the cancellation instead of claiming work stopped when it did not.

This is intentionally not the completed phase. Input-required continuation,
REST, a Harness-native typed client, and the reverse official-server peer test
remain. None is advertised by the current Agent Card. The public layer
inference assertion was deliberately broken once and restored; the test and
adapter contain no caller-side casts.

## MCP protocol adapters (roadmap #1 item 7)

`/mcp` exposes an agent to MCP clients as a tool. The adapter is small, and
that is the result rather than the goal: the handler talks to `AgentClient`, so
MCP is a protocol adapter over the transport seam rather than a second way into
the harness. Sessions are held in the layer's scope, so a `sessionId` really
continues a conversation and omitting one really is a one-shot.

The A2A direction is now underway in the section above. Unlike the earlier
specification-only state, its first slice is checked by the official SDK in a
real client/server exchange. The unimplemented capabilities remain named rather
than inferred from that one successful path.

A testing note. The conversation-continuity test first asserted the *answer*
returned by the tool — which proves nothing, because a scripted model returns
turn 2's text whether or not the session was reused. What discriminates is the
prompt the model was given. Both session tests now assert transcripts, and both
were checked by breaking the session lookup in each direction.

## Bug sweep over the new packages

Three real bugs, all in code written this session.

**Compaction summarised nothing, forever, at its own default.** The threshold
was measured against everything past the checkpoint — a stretch that
permanently includes the retained tail, so it never falls back below the line
and compaction ran on nearly every turn. Worse, when `retain` was at least as
large as that stretch, the fold boundary landed exactly on the checkpoint: the
summary was computed from an *empty* range and overwrote the real one with a
meaningless summary. `whenLongerThan(4)` with the default `retain` of 6 did
this. The threshold now measures the *foldable* stretch — what lies between the
checkpoint and the tail, which is what a new summary would actually absorb.

**The MCP session registry raced and grew without bound.** Looking a session up
and then creating it is check-then-act, so two calls arriving together for one
id each opened a session: one leaked, and the two calls silently held different
conversations. Creation is serialised now. Separately, every distinct id a
client sent opened a session that lived for the server's lifetime — unbounded
memory driven by input from outside. Each named session now has its own child
scope so it can be closed individually, and the registry evicts the oldest past
`maxSessions`.

**Two error paths through the transport seam had no test.** A tool's typed
failure must arrive described, since a caller with no tool definitions cannot
act on it; a session-level failure must survive as itself, or a client cannot
tell busy from broken. Both are covered now.

**A stale compaction checkpoint dropped the entire conversation.** Session ids
get reused — a snapshot is restored, a durable submission replays, a server
hands the same id to a new conversation after evicting the old one — and the
transform outlives all of it. A checkpoint claiming to cover more messages than
exist sliced past the end of history, so the model received a summary of a
conversation that no longer existed and *none* of the actual messages. Silently,
with the transcript itself perfectly intact. Reachable through the MCP adapter,
where an evicted session id is exactly what a client reuses. A checkpoint that
cannot describe the current history is now discarded.

**Compaction's checkpoint cache grew without bound.** An `Agent` is a value,
usually built once and shared, so every session that ever compacted left a
checkpoint behind forever. Evicting one is safe — it caches work already done,
and losing it costs a re-summarisation — so the map is now bounded, oldest
first, with the entry refreshed on write so busy sessions are not evicted ahead
of idle ones.

**A failed stream left its message open.** The docstring claimed every
`MessageStarted` owes a terminal event, and interruption was handled while
failure was not: a provider error produced `MessageStarted`, deltas, then
`RunFailed` somewhere else entirely, with nothing closing the message. A
consumer tracking messages would render one that never resolves. `MessageFailed`
now exists alongside `MessageInterrupted`, for the same reason tools have both
`ToolCallFailed` and `ToolCallInterrupted`: one is the run going away, the other
is something going wrong, and a consumer usually shows them differently.

**A provider failure changed channel depending on `stream: true`.** An error
part arriving inside the stream was turned into a defect, while the identical
condition on the batch path surfaces as a typed `AiError`. A caller should not
have to handle a provider failure differently because it asked to stream, so
the streaming path now fails with `AiError.InternalProviderError` carrying the
reported detail. `TestLanguageModel` gained a `streamError` turn option to
script the case, since a batch call has no equivalent.

One test was written and then found to prove nothing — `assert.isTrue(true)`
standing in for a real check on eviction. It now asserts that the evicted
conversation actually starts over, and fails when the bound is removed. Another
test claimed to prove the creation lock and does not: forcing two fibres to
interleave inside session creation is not something a test can arrange on
demand, and the unserialised code passes it too. The comment says so rather
than implying coverage that is not there.

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

## Durable client (issue #5)

The architecture from the issue: execution strength and transport are
independent Layer choices. `DurableAgentClient.layer(name, agent, options)`
provides the ordinary `AgentClient` service over a durable interpreter, so
every transport built on `AgentClient` reaches durable agents without knowing
durability exists. `examples/durable-client.ts` runs one program under both
layers.

Three identities are kept apart: session (the conversation), submission (one
prompt + follow-ups), execution (one workflow run). The pieces:

* `DurableSessionStore` — the durable logical-session projection: status,
  canonical history between submissions, the claimed request itself, and the
  elicitation projection (pending requests, recorded answers). `claim` is one
  atomic transition (`Ref.modify` in memory, one transaction on SQL), so two
  concurrent prompts produce exactly one `Claimed` and one `Busy`. The claim
  records the prompt and streaming choice, because a crash between "claimed"
  and "dispatched" must be reconcilable rather than leaving the session
  permanently busy. Memory and SQLite implementations pass one contract.
* `DurableSubmission` — a per-submission workflow keyed
  `${name}:${sessionId}:${submissionId}`, so sequential prompts run in fresh
  executions while history crosses through the store. Agent failures cross as
  data on the success channel (`Outcome.Succeeded | Failed`); infrastructure
  alone uses the error channel. History is committed by a replay-safe activity
  inside the workflow — the workflow owes the projection, not the process
  awaiting the result.
* `DeliveryLog` — client observation, kept out of the workflow journal. Keyed
  by semantic coordinates (submission, run ordinal, turn, tag, tool-call or
  request id, ordinal) rather than the in-process sequence, which is not
  replay-stable under parallel tools; numbered by a session-wide offset the
  log assigns. A duplicate key with the same payload is a replay; with a
  different payload it is reported as `Conflict`, never `INSERT OR IGNORE`d.
  Recording goes through an `eventSink` on `AgentSession.make` — the earned
  seam the issue's Phase 8 B allows, taken because a `Stream` subscriber
  attaches asynchronously and cannot promise the first envelope. The sink is
  generic; the local runtime never supplies one.
* Reconciliation on reacquisition. `session(id)` and `createSession` finish
  what a lost process left owed: a claim with no execution behind it is
  dispatched (idempotently — the execution id is a pure function of the
  claim), and answers recorded but not delivered are delivered.
* Interruption is a store-recorded intent, polled inside the workflow and
  delivered through a *local* Deferred to `AgentSession.interrupt` — the local
  path, so committed turns stay committed and the session returns idle.
  Awaiting a `DurableDeferred` for this was tried first and is wrong in an
  interesting way: the engine suspends on any pending durable await, even in a
  child fibre, parking every merely-interruptible submission.

Findings worth keeping:

**A suspension looks exactly like success.** `DurableDeferred.await` parks a
workflow by interrupting its fiber; the session absorbs interruption by
design, so `prompt` returns *normally*, with an interrupted result. The first
draft committed the terminal projection on that path before consulting
`instance.suspended` — the session went idle with no claim while the
execution was merely parked, and `respond` found nothing to deliver to. The
flag is now consulted before any terminal commit, and the event sink drops
the `RunInterrupted` / `SubmissionInterrupted` a suspension emits, which
describe the process, not the submission.

**Activity names need an execution scope.** `model-0` and `steering-drain-0`
assumed one live execution per definition. The client runs several against
the same engine, and their journals must not share an activity namespace;
model and drain activities now take a submission-scoped prefix.

**A test hung and the engine was innocent.** Two `yieldNow`s separated
dispatch from interrupt — enough locally, nowhere near enough when dispatch
crosses an engine and a workflow body. The interrupt landed before the first
turn, the script cursor never moved, and the *next* submission consumed the
hanging turn. The repo's own rule was the fix: synchronise on the model
call's `started` deferred, not on yields.

**Two "processes" in one test need one engine.** `TestRunner` keeps its
journal in memory, so two engine instances are two clusters that cannot see
each other's executions — and the engine silently ignores a second
registration of a workflow it already has, while a registration's handler
context dies with the layer scope that made it. The memory suite therefore
builds one runtime per test and makes additional clients thin `AgentClient`
layers over the same stores and engine; genuine process loss — runner A dies
with a submission parked for approval, runner B over the same SQLite file
answers it and carries the conversation on — is `DurableAgentClientSql.test.ts`.

Phase 0 extracted `test/AgentClientContract.ts`, the shared conformance suite
both interpreters are judged by, now on the live clock because the cluster
engine's timers do not advance under the test clock. Local and durable-memory
pass all of it; the durable suites add the busy race, failure preserving
history, interrupt-and-reuse, the dispatch and answer crash boundaries, HITL
across clients, event delivery with durable ids, and replay under parallel
tools with zero conflicts.

**Elicitation ids are per execution, the projection was per session.** Request
ids are `elicit-1`, `elicit-2`… from a fresh counter in every execution. A
process dying between delivering an answer and taking it left `elicit-1 =
granted` recorded under the session, and the next submission's `elicit-1`
would have been approved by reconciliation before anyone was asked. Both
`claim` and `finish` now clear the session's elicitation projection in the
same transition — an idle session has nothing outstanding by definition — and
`addPendingRequest` is idempotent over an already-answered id, so a replayed
ask finds its answer rather than waiting again. Pinned in both store
contracts and end to end, and falsified once: without the clearing, the
stale answer approves the second submission.

**Claim and dispatch are one uninterruptible step.** A caller cancelled
between the two — an aborted HTTP request, a timed-out fibre — would have
left a claimed session with no execution behind it until something happened
to reacquire it. Once the claim is taken the caller owes the dispatch; only a
dead process may leave that to reconciliation. A stale interrupt intent is
drained when its submission exits, so the channels store does not accumulate
signals nothing will read.

**The admission marker is per session; clearing it on exit raced the next
submission.** `finishProjection` set the session idle, and only then did the
workflow's `onExit` clear the `open` marker — so a client that claimed and
dispatched submission N+1 in that gap had its admission wiped by submission
N's exit, and steering aimed at running work was refused as idle. The
failure path was the real exposure: on success the session's own closing
drain had already cleared the marker, on failure nothing had. Admission (and
the stale interrupt intent) now closes *inside* `finishProjection`, before
the session goes idle; pinned by a store wrapper asserting the marker is
already gone when `finish` is called, on both paths, and falsified once
(`[0, 1]` without the fix).

**Durable session ids cannot come from a process-local counter.** The local
client's `session-1, session-2…` would make two processes sharing a store
share one conversation. `createSession()` without an id now draws from the
platform's random source.

**The client layer declares `LanguageModel`.** The agent definition's erased
requirements let the workflow layer claim `never` while its body resolves
the model from the registration context at runtime; `DurableAgentClient.layer`
now requires it in the type. `DurableAgent.workflow` has the same erasure and
is left as is for now — changing it is a typed break of an older API and
belongs in its own change.

**Interrupting a parked submission did nothing until someone answered.** A
workflow suspended on an approval runs no fibre, so the recorded intent had
nothing to notice it — `interrupt()` returned and the session stayed
running indefinitely. Waking the run is the only way to deliver the
interruption, and the only honest way to wake it is to answer: `interrupt`
now records the intent and refuses every outstanding request; the resumed
elicitation consults the intent before handing any answer back and, finding
it, withholds the answer forever while the session's own interruption ends
the run. Two subtleties earned their lines: the poller must not act during
replay before this execution has re-committed the user message (it is gated
on the transcript having grown), or the interrupted outcome commits an empty
history; and the poller and the resumed elicitation race for the signal, so
the elicitation checks the interrupter's deferred as well as the store.
Pinned: interrupted result, tool never ran, `["user"]` committed, session
reusable, and exactly two real model calls across the whole episode.

Known limits, stated rather than hidden: `DeliveryLog.live` fans out within
one process (cross-node live delivery is a transport concern over
`read({ after })`); a replayed streamed submission re-offers `MessageDelta`s
whose chunking the journal does not preserve, which the log reports as a
conflict and the recorder logs at warning level; the interrupt signal is
polled every 25ms while a submission runs.

## A bounded exec returned before its process was gone

`sandbox/local` settled a timed-out or output-limited exec the moment it sent
`SIGTERM`. Control came back while the child was still running — still
writing, still holding its working directory — which is how the sandbox
test's teardown met `EBUSY` on Windows. The failure is now delivered only
from the child's `close` event, with `SIGKILL` after a one-second grace
period for a child that ignores `SIGTERM`. The test grows a file from the
child and checks it has stopped growing once the exec returns; on Windows
the signal is a hard kill, so that probe is a guard rather than a proof —
the proof was the teardown race, which no longer reproduces.

## A review sweep across the packages

With the durable client done, the rest of the tree got the same treatment:
read for the failure a comment promises away, write the test, break the fix
once. What turned up, by package:

**Core.** `prompt` claimed, forked and registered as three interruptible
steps: a caller interrupted in between left the session `running` with
nothing to release it, and `interrupt` landing there passed `requireRunning`
and reported success against a fibre not yet registered. One uninterruptible
step now, with the release finalizer installed inside it. The submission's
terminal events were emitted by whoever awaited it, so a caller that timed
out left none — and a closing session's `SessionClosed` could precede them.
The submission fibre emits them itself, and the close finalizer awaits it.
The post-tool commit is uninterruptible: completed side effects cannot vanish
from history between the tool finishing and the commit landing.

**Sandbox.** `resolveWithin` walked up with `stat`, which follows links, so a
*dangling* symlink to an outside path looked like a missing file, the check
passed on the workspace, and the write created the target on the far side.
`lstat`, refuse dangling links, operate on the checked real path. `exec`
returned no cleanup from `Effect.callback`, so a caller's interruption left
the child running; it is now killed and awaited.

**a2a.** A resumed run that asked a *second* question hung the continuation
(only terminal events were awaited) and, worse, the respond idempotency key
was per task, so the second answer was rejected as a replay of the first.
The task entry was registered before the input and subscription could fail,
leaving an entry a later cancel would act on — against whatever the session
was running by then. The elicitation listener leaked one fibre per request
that never paused. Malformed bodies answered `-32603`.

**MCP.** Several text parts in a result — the most ordinary response there
is — were refused as unsupported content, and an error result with content
the client could not read lost its `McpToolError` classification, so the
model never saw the refusal. `AgentMcp` eviction closed a session's scope
under a call in flight; it now skips busy sessions and refuses the newcomer
when every session is busy.

**Compaction.** The retained tail opened wherever the message count fell —
on a tool result whose call had just been summarised away, a projection
providers reject on every turn until the window moved. The first fix aligned
to a user turn and was wrong in the other direction: a long agentic run is
one user message and many assistant/tool exchanges, and could never fold.
The rule is exactly the invariant: never open on a tool result.

**HTTP.** A failing event stream was framed as a bespoke `error` event; the
generated client only treats `effect/httpapi/stream/failure` carrying an
encoded `Cause` as a failure, so the declared `AgentTransportError` arrived
as a `SchemaError` about an undecodable envelope.

**AG-UI.** A session was created before the prompt was validated, so bad
requests with fresh thread ids exhausted capacity. The mapper projected
every submission on the session, so a second request on a busy thread could
render the first run's answer as its own. Observer-versus-synthetic
reporting was decided by reading a deferred after a yield; it is one atomic
step now. The source ending without a terminal event left the SSE response
open.

**Client.** A missing session was a retryable `AgentTransportError` in the
in-process and durable clients while the protocol already had
`AgentSessionNotFoundError`; the client vocabulary now includes it and the
protocol re-exports the client's class. A host shutting down with a mutation
in flight stranded every joiner on its deferred; the owner's interruption
now interrupts the deferred. `closeRaw` closed the session scope — and
waited for its finalizers — while holding the registry gate.

Two findings were examined and left as documented semantics rather than
changed: steering accepted during a submission's final turn is discarded at
release (the queue is per session and the drop is deliberate), and a failed
or interrupted submission keeps its user message in history (the
documented "only completed commits survive" rule applies to turns, not to
the accepted input).

## The whole stack, and what only the whole stack could show

`test/DurableHttpIntegration.test.ts` runs the generated HTTP client against
an HTTP server whose `AgentClient` is the durable one over a SQLite-backed
cluster engine, then kills that process with a submission parked on an
approval and answers it over HTTP from a second process -- new server, new
engine, new client, same database. Two things no unit suite had caught:

**The session host could not reach a session it had not created.**
`findSession` consulted only the host's own map, so over every transport a
durable session created by another process -- or by this one before a
restart -- was "not found". The headline of issue #5 held in-process and
failed at the first HTTP boundary. A miss now asks the client: a session it
can address is adopted into the registry under its own scope; one it cannot
is the not-found it always was. The transport fixtures, whose fake clients
had answered a miss with a transport error, now answer with
`AgentSessionNotFoundError` as a real client does.

**The SSE endpoint sent no headers until the first event.** A subscription
opened *before* the prompt -- the only way to see a run from its start --
left `fetch` unresolved and `EventSource` unopened for as long as the
session stayed quiet; every existing test used a fake client that emitted
at once. The response now opens with an SSE comment, and the subscription
is acquired eagerly by running the source into a queue from the moment the
response starts, so a connected client is observing from then rather than
from its second read (a plain `concat` starts the source only after the
comment is consumed -- the shutdown test caught that version).

Noted, not fixed here: `NodeHttpServer`'s preemptive shutdown interrupts
the fibre closing the scope when a request is in flight at close; the
integration fixture disables it.

## Sandbox, durable, cluster and streams: a second sweep

**Sandbox.** `exec` waited on the child's `close`, which a descendant
holding the stdio pipes -- `npm`, a shell with a background job -- could
defer forever, past every timeout; it settles on `exit` with a short grace
for the streams, and ends the command's whole tree (a process group on
POSIX, `taskkill /T` on Windows), with a hard deadline after `SIGKILL`.
Output kept accumulating after a limit tripped, and `Buffer.concat` per
chunk was quadratic; chunks are dropped once a limit has tripped and joined
once. A signal-ended process reports its signal rather than an exit code a
tool might have chosen. `list` followed symlinks for sizes, reporting an
outside file's metadata that `read` would refuse. `realpath` comparisons use
the native implementation, which canonicalises case and 8.3 names on
Windows. A missing `workspaceRoot` is refused at acquire rather than as a
permission error on every operation. Temp-directory removal retries and
logs. The memory provider's first acquisition of a workspace is one
`Ref.modify`; two fibres used to fork the world.

**Durable.** The interrupt intent was consumed on sight and cleared
non-durably, so a crash between taking it and recording the interrupted
outcome replayed into a run that completed normally; it is peeked, and
cleared only inside the journalled finish activity -- which also clears the
admission marker, so a replay after a crash past that activity cannot wipe
the marker the next submission opened. A store failing under the agent (a
busy database) was projected as the agent failing; it crosses as an
`Infrastructure` outcome -- the session freed, the client told it was
transport -- because a body defect is terminal for the engine and re-raising
would have wedged the session. The SQL `claim` reads its row back and
answers `Busy` when its `UPDATE` did not land, which row-level concurrency
(Postgres) allows and SQLite's serialised writers never showed.
`DurableAgent.submit` on a session whose execution completed returned the
old result and reopened admission into channels nothing drained; it now
recognises the finished execution. The entity cannot make that check
(polling routes through its own runner) and says so.

**Cluster.** `EntityClient` retried `AlreadyProcessingMessage` for `steer`
and `followUp`: that error means the runner is already handling this very
envelope, and a retry is a second envelope -- the same input offered and
applied twice. It is accepted, not retried, for the non-idempotent
operations.

**Streams.** `EventBus.events` ends after `SessionClosed`, so SSE and RPC
observers of a closed session complete instead of hanging until the
connection drops. `MessageStarted` is emitted uninterruptibly, so the
finalizer's `MessageInterrupted` cannot close a message never opened. One
unencodable envelope is logged and skipped rather than ending a healthy
session's SSE stream with a failure frame.

Examined and not reproducible: a subagent run by a tool under durability
was said to shift the parent's `model-N` journal on replay. A handler's
context is fixed when its toolkit layer is built, before the durable wrapper
exists, so a child inherits the raw model and its calls are covered by the
tool activity's journal; the test pins that (three calls, nothing
re-issued, the parent's own answer).
