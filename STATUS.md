# Implementation status — v0.1

Built on **Effect v4 (`effect@4.0.0-rc.111`)**. The AI modules live in-tree at
`effect/unstable/ai`; `@effect/ai` has no v4 line and is not used.

`npm test` — 107 passing, including the durable and cluster phases. `npm run lint` — 0 Effect diagnostics. `npm run typecheck` — clean, including all examples.

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

One note on Effect v4: service keys are `Context.Service<Self, Shape>()("key")`,
not `Context.Tag`, and a key is yielded with `Effect.service(Key)`.

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

`Connection` is an interface. Effect ships no MCP client, so keeping the
transport abstract settles the type story before the client arrives instead of
retrofitting around it — and makes all of it testable against a fake.

A bug found immediately after, by testing the claim that a bound toolkit is
"indistinguishable from a local one". It was not: `failureSchema` was never
referenced and `callTool` had no channel for a tool-level failure, so a tool
declared with `failure:` could not fail in its declared way. The consequence was
larger than the omission — every server-side refusal escalated to an `AiError`
and ended the run, so the default `ReturnToModel` policy never engaged and the
model never got to react. `McpToolError` now carries what the server reported,
decoded against the declared schema; a server reporting an error for a tool
declared infallible is named as the mismatch it is rather than papered over.

## MCP, and what was deliberately not built (roadmap #1 item 7)

`/mcp` exposes an agent to MCP clients as a tool. The adapter is small, and
that is the result rather than the goal: the handler talks to `AgentClient`, so
MCP is a protocol adapter over the transport seam rather than a second way into
the harness. Sessions are held in the layer's scope, so a `sessionId` really
continues a conversation and omitting one really is a one-shot.

The other two directions in item 7 were **not** attempted, for the same reason:

* **Consuming a remote MCP server's tools** needs an MCP *client*. Effect ships
  `McpServer`, `McpProtocol` and `McpSchema` but no client, so this is writing a
  protocol implementation, not an adapter.
* **A2A** is a specification with no peer available here to check an
  implementation against. The vocabulary maps cleanly — a Task is a submission,
  a context is a session, cancel is interrupt, updates are the event stream —
  and the two prerequisites the roadmap named are now in place, so it is ready
  to be written by someone who can test it against a real implementation.

Shipping either from the specification alone would produce plausible code with
nothing establishing it is correct, which is the failure mode this project has
repeatedly caught in itself.

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
