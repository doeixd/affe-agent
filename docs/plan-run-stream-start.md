# Plan: `run` / `stream` / `start` ergonomics without weakening session semantics

**Status:** P1–P3 implemented 2026-09-08 — `Agent.start`,
`AgentSubmission.Handle`, `AgentTraceLimitError`, `Agent.stream`,
`AgentToolProgressLimitError` and the per-submission progress budget, with the
Phase 0 conformance file as `test/AgentOneShotContract.test.ts` and the bound's
rows as `test/ToolProgressLimit.test.ts`. P4–P7 remain specified, not
implemented.

P3 found two things worth carrying forward:

* **An engine limit must not be negotiable through the failure policy.** The
  first version let the budget breach reach the default `ReturnToModel` policy,
  which handed it to the model as an ordinary failed tool result -- so the run
  completed, and the next call started emitting again against a budget already
  spent. A harness limit is not the tool's answer: the model cannot act on it,
  so it always fails the run, as a defect does.
* **P1's `traceLimits` said "lowerable, not raisable" and did not enforce it.**
  Written as documentation and never as a clamp. `internal/limits.ts` now holds
  both ceilings and the one rule about them, and both are tested by asking for
  more than the ceiling and getting the ceiling.

P2 was as small as §5 predicted: `Agent.stream` is `start`'s events under a
scope the stream manages, sharing one collector and one bound rather than a
second implementation. Its ownership claim is enforced by the type rather than
only by a test — the signature carries no `Scope`, so the scope must be managed
inside, and abandoning the stream necessarily releases the ephemeral session.
The suite asserts the observable half too: the interruption reaches a *running
tool*, not merely the caller, which is what tells owning apart from detaching.

Two things P1 found, both recorded here because the next phase inherits them:

* **Settlement is not the end of the trace.** `await` resolves when the
  submission settles, which can be before the collector has drained what
  settlement produced — so a replay cut off at that moment is missing exactly
  the ending a reader came for. The trace closes on the terminal *event* having
  been collected, not on the awaiting fiber. §4.5's "after settlement,
  `handle.events` replays the complete retained trace" is easy to implement in a
  way that is usually right and occasionally short.
* **Numbering must be independent of retention.** A follower skips what it
  already replayed by index. Deriving that index from what the trace *kept*
  means it stops advancing once the bound is hit, and the follower then never
  sees another event — including the terminal one it ends on. An over-bound
  trace hung rather than failing. Counting and closing continue past the bound;
  only retention stops.

**Written:** 2026-09-08, after comparing the current Affe runtime with a similar Effect-native agent runtime's `Run & stream` contract.

This plan asks a narrow question:

> How do we take the best parts of a cleaner run-oriented API — `run`, `stream`, `start`, a scoped execution handle, hard progress bounds, explicit exhaustion, and operational failure observation — without giving up the stronger session/submission/durability model Affe already has?

The answer is **copy the affordances, not the ontology**.

Affe should keep:

```text
Session
  -> Submission
       -> Run
            -> Turn
```

and keep the existing distinctions between:

- canonical conversation history;
- model-facing derived context;
- live semantic observation;
- durable delivery logs;
- workflow journals;
- session, submission, run, and turn identity.

The work below adds a cleaner one-shot facade and a few resource/operational contracts over those semantics. It does **not** introduce another runtime engine.

---

## 1. What is already right

The comparison runtime makes `run`, `stream`, and `start` the primary public view of an agent execution. That API is attractive, but most of the hard semantics behind it already exist in Affe.

### 1.1 One-shot execution already exists

`Agent.run(agent, input)` is already the correct one-shot primitive:

```text
Agent.run
  = scoped AgentSession.make
  + AgentSession.prompt
  + quiescence
```

It inherits the same typed input, output, errors, environment, interruption, follow-up, and atomic-history semantics as a normal session. Do not replace it with an `AgentRuntime` class or a parallel execution path.

### 1.2 Session ownership is stronger than a history service

Affe deliberately says:

> `AgentSession` is the sole owner of canonical conversation history.

A context transform may derive the prompt for the next model call, but cannot mutate the canonical transcript. Streaming is observational; only a completed turn commits. Under durability, the workflow journal, transcript, and delivery log remain separate stores with separate meanings.

Do not replace this with a generic `ThreadHistory` requirement at every call site. A pluggable store may back a stronger runtime, but the *semantic owner* remains the session.

### 1.3 Submission / run separation is buying real semantics

A submission is the externally admitted unit of work. A run is one loop episode. Follow-ups start later runs under the same submission instead of pretending the original run never stopped.

That distinction is why these can all be true at once:

- a hard `maxTurns` remains authoritative;
- steering accepted at the stop boundary is not dropped;
- an accepted steer can start a continuation run rather than violate the stopped run's bound;
- follow-ups are ordered, observable later runs;
- durable identities name the conversation, request, and workflow execution separately.

Do not flatten those concepts into one generic `Run` merely to make the introductory API shorter.

### 1.4 Streaming already has the right semantic boundary

Provider chunks do not leak through the public event model. Affe emits semantic events for text/reasoning deltas, tool argument deltas, tool progress, lifecycle transitions, and terminals. Canonical history remains identical between batch and streaming execution.

Keep that.

### 1.5 Observation backpressure is already addressed

Affe's bounded observation seam limits a stalled observer by envelope count and encoded bytes, then disconnects that observer with a typed `AgentObservationLagError` without interrupting the run. A durable observer can resume from the delivery log where available.

That solves **consumer backlog**. It does not solve every resource problem; §5 adds the missing producer-side progress bound.

---

## 2. Target public experience

The goal is a symmetrical one-shot surface:

```ts
const result = yield* Agent.run(agent, input)

const events = Agent.stream(agent, input)

const started = yield* Agent.start(agent, input)
const result2 = yield* started.await
const trace = yield* Stream.runCollect(started.events)
```

while preserving the existing long-lived conversation surface:

```ts
const session = yield* AgentSession.make(agent)

yield* session.prompt(input)
yield* session.steer(...)
yield* session.followUp(...)
yield* session.respond(...)
```

The two surfaces have different ownership semantics on purpose.

### 2.1 Ownership table

| API | owner of execution | if consumer/waiter stops | replay | use when |
| --- | --- | --- | --- | --- |
| `Agent.run` | the call's internal scope | interrupting the call interrupts ephemeral work | none needed | await one result |
| `Agent.stream` | the stream's internal scope | ending/interruption of the only stream closes the ephemeral runtime and interrupts active work | stream-local | one ephemeral streamed execution |
| `Agent.start` | caller `Scope` | dropping an observer does not stop work; closing the owner scope does | bounded process-local replay | start now, await/observe separately |
| `AgentSession.prompt` | session scope + prompt waiter semantics | current existing semantics | session history/events | long-lived conversation |
| `AgentSession.stream` | session scope | ending the consumer detaches only the subscription; run continues | existing client/durable event semantics | stream one submission in an existing conversation |
| `AgentSession.submit` + `awaitSubmission` | session scope | abandoning the waiter does not cancel submitted work | retained outcome according to current boundary | detached work in an existing conversation |

This distinction must be documented prominently. `Agent.stream` and `AgentSession.stream` intentionally differ because one *owns the ephemeral runtime* and the other merely *observes work owned by a session*.

---

## 3. Phase 0 — pin the invariants before adding surface area

Before implementation, write a small conformance file for the three one-shot forms. This prevents the facade from accidentally becoming a second interpreter.

Required properties:

1. `Agent.run(agent, input)` and `Agent.start(agent, input).await` produce the same `AgentSubmission.Result` for the same deterministic model.
2. Draining `Agent.stream(agent, input)` yields the same semantic lifecycle a session submission produces, modulo session ids.
3. Batch and streamed execution commit identical canonical history.
4. The same `AgentInput` renderer/schema is used by all three forms.
5. The same `AgentOutput` contract is used by all three forms.
6. The same `AgentLoop`, permission policy, tool execution strategy, failure policy, context transform, budget, and execution plan are consulted.
7. No one-shot API executes tools through a separate path.
8. No one-shot API has its own history implementation.
9. No provider-native stream chunk enters a new event union.
10. No one-shot API creates a daemon fiber.

Suggested test file:

```text
test/AgentOneShotContract.test.ts
```

The test should be table-driven over `run`, `stream`, and `start` where meaningful rather than three unrelated test suites.

---

## 4. Phase 1 — add `Agent.start` and a scoped submission handle

This is the clearest ergonomic improvement from the comparison runtime.

### 4.1 Do not add `AgentRuntime`

Use the existing root `Agent` namespace:

```ts
const started = yield* Agent.start(agent, input)
```

`Agent.start` should be literally an ephemeral `AgentSession` plus one admitted submission plus a bounded trace collector. The caller must provide `Scope.Scope` because the handle owns process-local runtime state after the constructor returns.

Candidate signature:

```ts
export const start = <...>(
  agent: AgentDefinition<...>,
  input: NoInfer<Input>,
  options?: AgentSession.PromptOptions & StartOptions
): Effect.Effect<
  AgentSubmission.Handle<Tools, E, Value>,
  AgentSession.SubmitError | E,
  Scope.Scope | Model | R
>
```

Prefer extending the existing `AgentSubmission` namespace with `Handle` rather than introducing a new top-level `SubmissionHandle` module. `AgentSubmission` is already public from the root.

### 4.2 Handle contract

Candidate shape:

```ts
export interface Handle<Tools, E, Value> {
  readonly submissionId: AgentSubmission.Id
  readonly await: Effect.Effect<
    AgentSubmission.Result<Tools, Value>,
    AgentSession.PromptError<Tools, E>
  >
  readonly events: Stream.Stream<
    AgentEvent.AgentEventEnvelope,
    AgentTraceLimitError
  >
}
```

Do not put `steer`, `followUp`, `respond`, or general session state on this handle. Those are conversation operations and belong to `AgentSession`. An ephemeral `start` handle represents one submitted unit of work, not a miniature session API.

An explicit `interrupt` method is optional. Closing the owner scope is the fundamental cancellation mechanism. Add `interrupt` only if it can be derived directly from the private session and materially improves ergonomics without creating a second cancellation meaning.

### 4.3 Subscribe before admission

`Agent.start` must establish its internal event subscription **before** submitting the input. Otherwise a fast deterministic model can emit `SubmissionStarted` before the collector exists.

The repository already has tests proving subscribe-before-submit ordering for `AgentSession.stream`; reuse the same failpoint strategy rather than trusting scheduling.

Because `Agent.start` owns a fresh ephemeral session, there can be only one submission in that session. The collector can therefore subscribe before the submission id exists without ambiguity; after admission, the receipt supplies the id used for the public handle.

### 4.4 No observer may backpressure execution

The internal collector is the execution-adjacent observer. User observers read from the collector's replay/live view; they do not subscribe directly in a way that can hold up execution.

This preserves the desirable rule:

> Observers may fail, stop, or lag without changing the agent result.

The collector itself must obey a hard retention bound (§4.5) so “observers cannot backpressure execution” does not turn into “the runtime may allocate forever.”

### 4.5 Bounded process-local replay

The attractive part of the comparison runtime's `start` handle is not merely detachment; it is that an observer may attach after execution began and still see earlier events.

Implement that honestly, with a bound.

Suggested semantics:

- collect the submission's envelopes in order;
- expose `handle.events` as replay-then-follow;
- after settlement, `handle.events` replays the complete retained trace and ends;
- trace retention lives only until the owner scope closes;
- reaching the trace ceiling fails **trace observation**, not the agent run;
- never silently slide/drop old envelopes and still call the result a complete trace.

Candidate error:

```ts
AgentTraceLimitError {
  maxEnvelopes
  maxBytes
  retainedEnvelopes
  retainedBytes
}
```

Reuse the existing wire-size accounting utilities used by bounded observation. Count encoded UTF-8 bytes, not UTF-16 `String.length`.

A reasonable first default is to reuse the current observation defaults (2048 envelopes / 8 MiB) unless measurement shows that a normal submission crosses them. The implementation may expose lowerable `StartOptions.traceLimits`; a user must not be able to raise the hard engine ceiling without an explicit library-level constant/change.

If trace retention exceeds the bound:

```text
run/await           -> continue normally
handle.events       -> fail with AgentTraceLimitError
canonical history   -> unaffected
durable delivery    -> unaffected
```

That keeps observation observational.

### 4.6 Resource ordering

The handle must satisfy:

```text
run-local model/tool resources close
  before
handle.await returns
```

while the bounded replay buffer remains readable until the handle's owner scope closes.

Closing the owner scope while work is active interrupts:

- the ephemeral session;
- active model stream;
- active tools;
- collector;
- handle observers.

After the run has already settled, closing the owner only releases replay/observer state.

No daemon fiber survives the scope.

---

## 5. Phase 2 — add `Agent.stream` as the ephemeral streamed form

Once `Agent.start` is correct, `Agent.stream` becomes a thin scoped interpretation rather than another runtime path.

Candidate implementation shape:

```ts
export const stream = (...) =>
  Stream.unwrapScoped(
    Effect.map(Agent.start(agent, input, options), (started) => started.events)
  )
```

The exact implementation may avoid the replay collector if that is measurably wasteful, but its semantics must remain equivalent.

### 5.1 Important cancellation distinction

For `Agent.stream`:

> The stream owns the ephemeral session.

Therefore `Stream.take`, interruption, or abandoning the only ephemeral stream closes the stream's scope and interrupts active work.

For `AgentSession.stream`:

> The session owns the submission.

Therefore ending the stream detaches observation and does **not** cancel the run.

This is not inconsistency; it is structured concurrency. Document it in the API JSDoc and in the guide.

### 5.2 Do not create two event models

`Agent.stream` must emit the same `AgentEventEnvelope` union used everywhere else. No `RunStreamEvent`, no provider chunk wrapper, no alternative tool progress type.

---

## 6. Phase 3 — bound tool-progress production, not only observer lag

This is the most important resource-safety lesson from the comparison runtime.

Affe currently bounds how much an **observer can fall behind**. That does not bound how much progress an **agent can produce** when consumers are keeping up.

A tool can emit `ToolCallProgress` indefinitely. Even with zero observer backlog, that can consume unbounded network/storage/telemetry volume and can make a replaying handle/delivery log pathological.

### 6.1 Add a cumulative progress budget

Add a request/submission-scoped lowerable limit with a hard library ceiling.

Recommended first contract:

```ts
interface BufferLimits {
  readonly maxToolProgressBytes?: number
}
```

Default/hard ceiling proposal:

```text
8 MiB per submission
```

Use **submission**, not run, as Affe's accounting unit. A follow-up chain is one externally admitted unit of work; resetting an 8 MiB budget for every continuation run lets one submission emit unbounded progress merely by scheduling follow-ups.

If later evidence shows per-call protection is useful, add it as a second axis; do not invent a per-call number now.

### 6.2 Count the wire representation

Count the UTF-8 byte length of the stable encoded progress payload/envelope, using the same canonical encoding that a remote observer receives.

Do not count:

- object identity;
- V8 heap estimates;
- UTF-16 code units;
- a provider-specific representation.

This ensures “8 MiB” means the same thing in-process and over a transport.

### 6.3 Require stable owned JSON at the observation boundary

Audit what Effect AI currently permits through `context.preliminary` and what `AgentEvent.toWire` can encode.

The desired public rule is:

> A published progress snapshot must be stable, owned, wire-encodable data.

At minimum reject values that the stable event codec cannot faithfully encode. If the current schema accepts values whose meaning changes through getters/custom serialization/non-finite numbers, normalize or reject them before publication rather than letting local and remote observers see different values.

Do **not** broaden this into “all tool values must be JSON.” Final tool results continue to use their own Effect AI schemas and result bounds. Progress is a separate observational channel.

### 6.4 Overflow behavior

Do not truncate progress.

A truncated structured snapshot is usually a lie. When the cumulative progress budget is exceeded, fail the offending tool/run through one typed engine error, close the tool lifecycle correctly, and leave already committed history untouched.

Candidate error name:

```text
AgentToolProgressLimitError
```

The exact error should name:

- limit;
- observed bytes;
- tool name;
- tool call id;
- submission id.

### 6.5 Three separate bounds

Keep these concepts distinct in docs and code:

```text
observer lag bound
  != tool progress production bound
  != terminal tool result/output bound
```

A fix for one must not be cited as protection against the others.

Add the progress ceiling to `docs/limits.md` when it ships.

---

## 7. Phase 4 — make exhaustion a stable classification without replacing compositional policy

The comparison runtime's nicest budget UX is a result that can say:

```text
exhausted = turns | tool-calls | tokens
```

and a simple policy for whether exhaustion stops, gets one constrained final answer, or fails.

Affe already has the stronger underlying pieces:

- `AgentLoop.maxTurns` / `maxToolCalls` / `maxDuration`;
- `AgentLoop.Final` for exactly one tool-less final turn;
- replay-safe token/cost accounting in `/budget`;
- arbitrary custom stop policies;
- `Result.stopReason` for human-readable custom reasons.

Keep those primitives. Add a standard classification over them.

### 7.1 Add an `Exhaustion` ADT

Candidate:

```ts
export type Exhaustion =
  | "turns"
  | "tool-calls"
  | "duration"
  | "tokens"
  | "cost"
```

Do not replace `stopReason: Option<string>`. Custom loop reasons remain useful and open-ended.

Instead extend standard decisions/results so built-in ceilings may carry:

```ts
readonly exhaustion: Option.Option<AgentLoop.Exhaustion>
```

A custom `AgentLoop.stop("waiting for supervisor")` has no exhaustion classification.

### 7.2 Preserve the distinction between stop and exhaustion

These are different:

```text
model went idle                 -> normal stop
output tool reported value      -> normal stop
custom policy chose stop        -> normal stop
maxTurns reached                -> exhaustion(turns)
token ceiling reached           -> exhaustion(tokens)
```

Do not infer exhaustion by parsing `stopReason` strings.

### 7.3 Add a convenience policy only after classification is stable

Once exhaustion is represented, add one ergonomic helper/preset rather than replacing the existing combinators.

Candidate behavior:

```ts
onExhaustion:
  | "stop"
  | "final-answer"
  | "fail"
```

Semantics:

- `stop`: current hard-stop behavior;
- `final-answer`: one additional turn with ordinary agent tools withheld, using the existing `Final` mechanism; the final turn still counts usage;
- `fail`: fail before starting a final turn with a typed exhaustion error.

Important constraints:

- duration/cost policy may choose to disallow a final turn if spending another provider call contradicts the bound's meaning; do not blindly make every ceiling final-answer capable;
- `maxTurns` remains a bound on an ordinary run; if `final-answer` is selected, document that the final constrained turn is outside the ordinary-turn allowance, exactly because it is a terminal recovery action;
- under durability, the classification and final-turn decision must replay identically;
- `Budget` charges remain idempotent by semantic occurrence.

### 7.4 Prefer a preset/helper over a second budgeting engine

Do not add a monolithic `RunBudget` runtime that duplicates `AgentLoop` and `/budget`.

The user-facing helper should lower to those existing mechanisms. If its type requirements become dishonest or unreadable, stop at the `Exhaustion` classification and leave policy composition explicit.

---

## 8. Phase 5 — add a raw operational tool-failure observer only if `/observability` cannot already express it

There is an operationally important case:

```text
tool handler fails
  -> failure policy returns the failure to the model
  -> model recovers
  -> submission succeeds
```

The stable event stream should continue to carry a serializable failure projection, not a raw Effect `Cause`. But an operator may still want the original cause for error reporting.

### 8.1 Audit first

Inspect `ToolExecution` and `/observability` to answer:

> Can application telemetry currently receive the original local `Cause` of a recovered tool failure exactly once per attempt without changing run semantics?

If yes, document that route and add a recipe. Do not add a new seam.

If no, add one optional process-local observer service.

Candidate location:

```text
affe-agent/observability
```

not the root event ADT.

Candidate observation:

```ts
interface ToolFailureObservation {
  readonly sessionId: string
  readonly submissionId: string
  readonly runId: string
  readonly turn: number
  readonly toolCallId: string
  readonly toolName: string
  readonly cause: Cause.Cause<unknown>
  readonly disposition: "returned-to-model" | "failed-run"
}
```

### 8.2 Observer semantics

- process-local only;
- never serialized into history or the durable journal;
- at most once per in-memory attempt;
- replacement/retry attempts may produce another observation;
- observer defects/failures cannot change the tool result or run outcome;
- a slow observer may hold the tool permit if it runs inline, and that must be documented/measured;
- content/redaction remains opt-in, consistent with `/observability`.

Do not add `RawToolFailed` to `AgentEvent`; that would make a local runtime object part of a stable wire protocol.

---

## 9. Phase 6 — external-unknown one-shot helpers, only if they remove real boundary boilerplate

The comparison runtime has `runUnknown`, `streamUnknown`, and `startUnknown` for external values typed as `unknown`.

Affe already decodes encoded input at transport/host boundaries against the *agent's* `AgentInput` schema before execution. Safety is not missing.

A local helper may still be useful for:

- queue payloads;
- webhook bodies;
- CLI JSON;
- plugin boundaries;
- tests.

Do not add three helpers until one real caller shows the repeated pattern.

If needed, prefer one underlying decode function in `AgentInput` and derive:

```ts
Agent.runUnknown
Agent.streamUnknown
Agent.startUnknown
```

from the typed forms. Their errors must be the same input-decoding error the transport boundary uses, not a second validation type.

This phase is explicitly lower priority than the handle, progress bound, and exhaustion classification.

---

## 10. Documentation changes

The comparison runtime's `Run & stream` page is better than Affe's current presentation of the same ideas. Copy the clarity.

### 10.1 Add one compact execution page

Once phases 1–2 ship, add or reshape a guide around:

```text
run      -> await one ephemeral result
stream   -> own one ephemeral execution as a Stream
start    -> own one ephemeral execution through a scoped handle
session  -> own a conversation
```

Do not begin that guide with durability, transports, or every battery.

### 10.2 Put the turn ordering in one diagram

Document Affe's actual sequence, including the parts that are stronger than the comparison runtime:

```text
apply steering already accepted
  -> prepare derived context
  -> stream/reduce one model response
  -> decode complete tool calls
  -> authorize / elicit / execute bounded tools
  -> commit the completed turn atomically
  -> record run ledger / budget
  -> evaluate loop decision
  -> close steering admission + final steering drain on stop
  -> preserve a late accepted steer as a continuation run
  -> drain/close follow-ups at the submission boundary
```

The diagram should explicitly say that accepted late steering does not extend a run past a hard stop; it schedules a later run.

### 10.3 Add a scope ownership table

Document what these scopes own:

```text
application scope
session scope
ephemeral Agent.start scope
submission/run scope
tool scope
observer scope
```

For each, say what closing it interrupts and what survives.

### 10.4 Add small recipes

After implementation, add runnable/typechecked examples:

```text
examples/one-shot-run.ts
examples/one-shot-stream.ts
examples/one-shot-start.ts
```

The `start` example should prove the reason it exists: begin work, attach/reattach an observer, await separately, then close the owner.

---

## 11. Conformance / falsification matrix

Every phase should land with tests that fail when the property is deliberately broken.

### 11.1 `start` / `stream`

| property | falsification |
| --- | --- |
| subscription exists before first event | swap subscribe and submit; `SubmissionStarted` disappears |
| `start.await` matches `run` | route one through a different prompt/input path; results diverge |
| handle observer does not backpressure run | stall observer; run still settles |
| trace overflow does not fail run | set tiny trace limit; `await` succeeds while events fail |
| no silent trace sliding | exceed limit; receive typed trace failure, never a partial trace presented as complete |
| owner close interrupts active ephemeral work | gate model/tool, close scope, see interruption terminal/finalizers |
| observer close alone does not interrupt `start` work | stop observer, await still completes |
| `Agent.stream` early end *does* interrupt its ephemeral work | `take(1)` / interrupt stream, active run closes |
| `AgentSession.stream` early end still does not interrupt session-owned work | existing contract remains green |
| no daemon | after scope close, no collector/run fiber remains |

### 11.2 Progress limits

| property | falsification |
| --- | --- |
| counts UTF-8 bytes | use non-ASCII progress whose UTF-16 count fits but UTF-8 does not |
| cumulative per submission | several individually-small updates cross the total |
| follow-up run does not reset submission allowance | progress in run 1 + run 2 crosses total |
| no truncation | oversized structured value fails, never appears sliced |
| terminal tool result uses separate rule | progress ceiling does not cap an otherwise-valid final result unless its own bound says so |
| local/remote agreement | same payload reaches same limit through wire encoding |

### 11.3 Exhaustion

| property | falsification |
| --- | --- |
| built-in bounds classify exhaustion without string parsing | change reason wording; classification remains |
| normal stop is not exhaustion | idle/output stop yields `None` |
| final-answer is exactly one extra constrained turn | model asks for tools in final turn; none are offered |
| final turn usage is charged | budget total includes it |
| durable replay does not charge it twice | replay same occurrence |
| hard stop + late steer preserves both truths | bounded run stops; accepted steer begins continuation run |

### 11.4 Operational tool-failure observation

| property | falsification |
| --- | --- |
| recovered failure is reported | tool fails, model recovers, submission succeeds, observer sees cause |
| stable event remains wire-safe | serialized event contains projected failure, not `Cause` |
| observer defect cannot change result | observer dies; model still receives configured tool failure/result |
| attempt semantics are explicit | retry/replacement attempt can produce a second observation, not duplicate within one attempt |

---

## 12. Implementation order

Ranked by value and dependency:

### P1 — `Agent.start` + bounded replay handle

Why first: this is the largest ergonomic gain and composes existing primitives instead of changing kernel semantics.

Likely files:

```text
src/Agent.ts
src/AgentSubmission.ts
src/Errors.ts
src/internal/observation.ts (reuse byte/count machinery, if appropriate)
test/AgentOneShotContract.test.ts
docs/guide-sessions.md or a new guide-run-stream.md
```

### P2 — `Agent.stream`

Why second: after `start` exists this should be small and gives the desired `run / stream / start` symmetry.

Likely files:

```text
src/Agent.ts
test/AgentOneShotContract.test.ts
examples/one-shot-stream.ts
```

### P3 — progress production bound

Why third: correctness/resource hardening. It is independent of the ergonomic facade but becomes more important once local replay is available.

Likely files to inspect/change:

```text
src/ToolExecution.ts
src/AgentEvent.ts
src/AgentSession.ts / prompt options
src/Errors.ts
src/internal/* wire-size helper
docs/limits.md
test/ToolExecution.test.ts or dedicated progress-limit tests
```

### P4 — exhaustion classification

Why fourth: the engine already enforces the bounds; this primarily makes results/events easier to understand and creates a safe base for an ergonomic final-answer preset.

Likely files:

```text
src/AgentLoop.ts
src/AgentRun.ts
src/AgentSubmission.ts
src/budget/Budget.ts
src/AgentEvent.ts
test/AgentLoop.test.ts
test/Budget.test.ts
durable/client conformance rows
```

### P5 — exhaustion convenience preset

Only after P4. Lower to `AgentLoop` + `/budget`; do not introduce another runtime.

### P6 — raw recovered-failure observer

Audit `/observability` first. Implement only if raw cause access is genuinely missing.

### P7 — `*Unknown` helpers

Adopter-triggered convenience. Lowest priority.

---

## 13. Things deliberately **not** to copy

### 13.1 No second `AgentRuntime`

`Agent.run`, `Agent.stream`, and `Agent.start` belong on the existing `Agent` namespace and interpret `AgentSession`.

### 13.2 No generic history service as the semantic owner

Storage is replaceable. Session ownership of canonical history is not.

### 13.3 No flattening of Submission and Run

The extra noun already pays for itself in follow-ups, hard bounds, steering continuation, durable settlement, and correlation.

### 13.4 No per-run hook bag that duplicates existing seams

Before adding a `RunOptions` callback, ask whether the behavior is already one of:

```text
ContextTransform
Permission / Elicitation
ToolExecution
AgentLoop
Budget
RunLedger
AgentEvent/eventSink
InputChannel
Observability
```

If yes, compose the seam. A giant hook object makes runtime behavior harder to reason about and easier to configure differently between local/durable paths.

### 13.5 No raw provider SDK events

Keep one semantic event union.

### 13.6 No unbounded local replay

A convenient handle is not permission to retain arbitrary traces forever.

### 13.7 No different durable agent definition

The same `Agent` remains interpretable locally, durably, through a cluster, and behind `AgentClient`.

---

## 14. Interaction with the effect-uai interoperability plan

This work composes directly with [plan-effect-uai-integration.md](./plan-effect-uai-integration.md).

The layers remain orthogonal:

```text
                        application
                            |
                run / stream / start / session
                            |
                        affe-agent
                 execution + lifecycle semantics
                            |
                effect/unstable/ai LanguageModel
                            |
              +-------------+--------------+
              |                            |
      official Effect AI            effect-uai adapter
          providers                        |
                                      effect-uai providers
```

`Agent.start` and `Agent.stream` must not care whether the model service came from an official Effect AI provider, an execution plan, or the proposed effect-uai bridge.

Likewise, progress bounds and exhaustion classification are kernel semantics and therefore apply identically across model-provider ecosystems.

This is the intended “best of both worlds” direction more generally:

> Affe owns execution semantics; provider/capability ecosystems plug underneath; ergonomic projections sit above. None of those layers needs to absorb the others.

---

## 15. Acceptance criterion

This plan is successful when a newcomer can begin with:

```ts
Agent.run(agent, input)
Agent.stream(agent, input)
Agent.start(agent, input)
```

and get an API as easy to understand as a run-oriented framework, while an application that grows into a real agent product can move to:

```ts
AgentSession
AgentClient
/durable
/cluster
```

without changing what a turn, tool call, interruption, history commit, submission, or event means.

The test for every proposed implementation choice is:

> Does this make the common case easier **without creating a second semantic path through the runtime**?

If yes, take it.

If no, leave the feature in the comparison project.