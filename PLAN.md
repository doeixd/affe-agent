# PLANV2.md

# Effect Harness — Implementation Plan V2

## Status

**Implementation-ready design and execution plan**

This document supersedes the previous design draft.

It incorporates the architectural review, Effect ecosystem review, and the first implementation spike findings, including these critical discoveries:

1. The harness must own canonical conversation history rather than relying on Effect AI's mutable `Chat`.
2. Model-facing context must be derived ephemerally per turn.
3. The harness must disable Effect AI's automatic tool-call resolution so it can own tool execution semantics.
4. Tool failure behavior is policy and must not be hard-coded prematurely.
5. Streaming is intentionally deferred until partial-message commit semantics are defined.
6. Steering is turn-boundary input, not implicit cancellation.
7. Follow-ups extend the current externally observed submission lifecycle while internally creating subsequent runs.
8. Live events are observational, not a durability mechanism.
9. The core must remain Effect-native: values describe semantics, Effects perform behavior, Services represent capabilities, Layers provide implementations, Scopes own lifetimes, Streams expose observation, and Schema defines serializable domain values.

Implementation of v0.1 confirmed all nine and added the following, each of which is now specified in the relevant section:

10. The runtime baseline is **Effect v4**, where the AI modules live in-tree at `effect/unstable/ai`. There is no separate `@effect/ai` dependency. See §2.8.
11. A session must survive interruption of `prompt`'s **caller**, not only interruption of its own run. See §23.
12. Claiming an idle session must be a single atomic transition, not a read followed by a write. See §11.
13. Event emission must be serialized, so delivery order matches `sequence` order rather than merely being reconstructible from it. See §28.
14. A public error channel must never be `unknown`. See §33.
15. End-user code must never require a type cast. This is a design constraint on the API, not a style preference. See §33.1.
16. An agent always has a toolkit, empty if it declares no tools. This is what keeps tool types intact through the model call. See §16.

The library should remain small enough that higher-level systems such as coding agents, durable agents, memory systems, skill systems, UI protocols, and OpenCode integrations can be built **on top of it without modifying core**.

---

# 1. Project Thesis

Effect AI already provides the primitives needed to talk to language models:

- `LanguageModel`
- `Prompt`
- `Tool`
- `Toolkit`
- model providers
- structured output
- model responses
- streaming primitives
- MCP primitives

Effect already provides:

- `Effect`
- `Layer`
- `Context.Service`
- `Scope`
- `Fiber`
- `Queue`
- `PubSub`
- `Ref`
- `SubscriptionRef`
- `Stream`
- `Deferred`
- `Schedule`
- structured concurrency
- interruption
- typed errors
- tracing
- resource management
- `Schema`

What is missing is a small reusable layer of **agent execution semantics**.

Effect Harness should provide exactly that layer.

```text
┌──────────────────────────────────────────────────────────┐
│ Product/framework layer                                  │
│                                                          │
│ coding agents · memory · skills · sandbox · persistence  │
│ subagents · channels · UI · durable workflows · evals    │
└───────────────────────────┬──────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────┐
│ Effect Harness                                           │
│                                                          │
│ session · submission · run · turn · loop · events       │
│ steering · follow-ups · context derivation · tool exec  │
└───────────────────────────┬──────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────┐
│ Effect AI                                                │
│                                                          │
│ LanguageModel · Prompt · Tool · Toolkit · provider APIs │
└───────────────────────────┬──────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────┐
│ Effect                                                   │
│                                                          │
│ Effect · Layer · Scope · Fiber · Queue · Stream · Schema│
└──────────────────────────────────────────────────────────┘
```

The library is worthwhile only if it continues to respect this boundary.

---

# 2. Architectural Rules

These rules are load-bearing.

## 2.1 Values describe semantics

These should be ordinary values:

- `Agent`
- `AgentLoop`
- `ContextTransform`
- `AgentEvent`
- IDs and domain state
- loop decisions
- policies

Do not turn these into Services merely because the library uses Effect.

## 2.2 Effects perform behavior

Runtime operations should return `Effect`s:

- creating sessions
- prompting
- steering
- following up
- interrupting
- executing runs
- executing turns
- resolving context
- executing tools

## 2.3 Services represent capabilities

Use `Context.Service` only for environmental/infrastructural capabilities:

- `LanguageModel`
- application auth
- memory
- persistence
- sandbox
- approval
- database
- remote APIs
- clocks/configuration where appropriate

Do **not** make every harness concept a Service.

## 2.4 Layers construct/provide Services

Layers belong at dependency/infrastructure boundaries.

Do not create:

```text
Agent.layer
AgentLoop.layer
Run.layer
ContextTransform.layer
```

unless those things eventually become actual injectable capabilities.

## 2.5 Scopes own runtime lifetimes

`AgentSession` is a scoped runtime value.

Its scope owns:

- active run fiber
- queues
- pubsub
- child resources
- interruption cleanup

Closing the session scope must interrupt active work and release session-owned resources.

## 2.6 Streams expose observation

Public execution observation should be exposed as:

```ts
Stream.Stream<AgentEventEnvelope>
```

Internal implementation may use `PubSub`.

The live event stream is not durable storage.

## 2.7 Schema defines durable domain data

IDs, event envelopes, terminal states, and other data likely to cross process or persistence boundaries should use Effect Schema from the start.

---

## 2.8 Runtime Baseline

The target runtime is **Effect v4** (`effect@4.0.0-rc.*`). The AI modules are part of the `effect` package at `effect/unstable/ai`; `@effect/ai` is a v3-line package and has no v4 release. Provider packages remain separate (`@effect/ai-anthropic`, `@effect/ai-openai`) and publish matching v4 versions.

Several v4 details bear directly on this design and were only discovered by building against it:

**`Queue.takeAll` waits for at least one element.** The non-blocking drain is `Queue.clear`. Every steering and follow-up drain in this design is non-blocking by nature — the queue is usually empty — so `takeAll` would deadlock the turn loop. Use `Queue.clear`.

**Tool handlers return a stream.** `Toolkit.WithHandler.handle` has type `Effect<Stream<HandlerResult>>`, so a tool may emit preliminary results before its final one. The harness collects the stream and commits only the final result. Surfacing preliminary results is a streaming concern and is deferred with the rest of streaming (§24).

**`generateText` decodes response parts against the declared tools.** A tool call naming a tool the agent does not have therefore fails *inside the model call*, as a typed `AiError`, before the harness executes anything. This is stricter than the harness could be on its own, and it means such a failure never reaches the tool failure policy (§19).

**`LanguageModel.generateText` already emits a span** carrying GenAI semantic conventions from `effect/unstable/ai/Telemetry`. The harness must not restate those annotations; its own spans (§32) are simply the parents of that span.

**There is no `Schema.Cause` codec.** This blocks Schema-defining the failure events; see §42.

**Prompt combinators**: `Prompt.concat` appends (there is no `Prompt.merge`), `Prompt.fromResponseParts` converts model output into committable messages, and `Prompt.Prompt` is a plain immutable value, so snapshotting a turn is free.

---

# 3. Core Non-Goals

The core MUST NOT initially implement:

- long-term memory
- vector search / RAG
- skills
- filesystem conventions
- shell tools
- browser control
- sandboxes
- MCP orchestration
- channels
- Slack/Discord/Teams
- cron/schedules
- HTTP server
- RPC protocol
- React/Vue/Svelte bindings
- durable workflow execution
- persistence database
- authentication
- authorization framework
- coding-agent conventions
- subagent framework
- planner
- reflection/reasoning DSL
- eval framework
- provider routing
- model fallback
- human approval framework
- deployment platform
- plugin system

These should be buildable later through composition.

---

# 4. Core Vocabulary

The public core should stay near this size:

```text
Agent
AgentSession
AgentSubmission
AgentRun
AgentLoop
ContextTransform
AgentEvent
```

`AgentSubmission` is introduced in V2 because the follow-up semantics require a distinction between:

- an externally initiated unit of work
- one or more internal runs required to reach quiescence

This is preferable to overloading `Run`.

Potential namespace types:

```text
AgentSession.Id
AgentSubmission.Id
AgentRun.Id
AgentTurn.Index
AgentLoop.State
AgentLoop.Decision
```

Do not add more exported nouns unless implementation pressure requires them.

---

# 5. Canonical Conversation Ownership

## Decision

**Do not build the harness on Effect AI's mutable `Chat` as the canonical source of truth.**

The session owns canonical conversation state directly.

Recommended representation:

```ts
Ref.Ref<Prompt.Prompt>
```

or the closest Effect AI `Prompt` representation that supports deterministic append/replace semantics.

Conceptually:

```text
AgentSession
    │
    ├── canonical Prompt/history
    │       │
    │       ├── durable/replayable semantic state
    │       └── single source of truth
    │
    └── per-turn derived model context
            │
            ▼
       LanguageModel
```

## Why

Effect AI's `Chat` owns mutable history internally.

That becomes problematic once the harness must define:

- deterministic replay
- canonical history
- context compaction
- ephemeral memory/RAG injection
- steering insertion
- persistence
- run boundaries
- commit timing
- streaming interruption semantics

The harness should not have two competing owners of conversation state.

## Invariant

> `AgentSession` is the sole owner of canonical conversation history.

No `Chat` object may contain a second independently mutable authoritative history.

---

# 6. Derived Context

Before each model invocation, the harness derives the model-facing prompt from canonical state.

```text
canonical Prompt
      │
      ▼
ContextTransform
      │
      ▼
ephemeral model-facing Prompt
      │
      ▼
LanguageModel.generateText
```

A `ContextTransform` does **not** mutate canonical history.

Suggested type shape:

```ts
export interface ContextTransform<E = never, R = never> {
  readonly transform: (
    context: ContextTransform.Context
  ) => Effect.Effect<Prompt.Prompt, E, R>
}
```

`ContextTransform.Context` should include enough metadata for useful derivation without exposing mutable runtime internals.

Candidate fields:

```ts
interface ContextTransform.Context {
  readonly sessionId: AgentSession.Id
  readonly submissionId: AgentSubmission.Id
  readonly runId: AgentRun.Id
  readonly turnIndex: number
  readonly canonicalPrompt: Prompt.Prompt
}
```

Possible later fields:

- token usage
- workspace metadata
- run start time

Do not add speculative fields in v0.1.

## Valid uses

- RAG injection
- memory recall
- dynamic system instructions
- environment/workspace injection
- current date/time
- permissions-derived context
- ephemeral summarization
- model-facing token trimming

## Invalid use

Persistent compaction that changes canonical history.

That is a session-state mutation and should be represented separately later.

---

# 7. Compaction

Compaction has two meanings and must not be conflated.

## Ephemeral compaction

Transform canonical history into a smaller prompt only for the next model call.

This **is** a `ContextTransform`.

Canonical history remains unchanged.

## Canonical compaction

Replace old canonical messages with a summary or compressed representation.

This **changes session state**.

Do not introduce a generic `SessionTransform` abstraction in v0.1 unless implementation pressure requires one.

For now, canonical compaction is deferred.

The important rule:

> `ContextTransform` is derivation, never mutation.

---

# 8. Agent Definition

`Agent` is a reusable value describing execution semantics.

It is not a Service.

Initial shape may look like:

```ts
const Researcher = Agent.make({
  instructions: "Research carefully.",
  toolkit: ResearchToolkit,
  loop: AgentLoop.untilIdle(),
  contextTransform: ContextTransform.identity
})
```

Do not put a concrete provider/model instance directly on `Agent`.

The current `LanguageModel` should come from the Effect environment.

Model selection remains normal Effect composition:

```ts
program.pipe(
  Effect.provide(
    OpenAiLanguageModel.model("...")
  )
)
```

This allows the same Agent value to run under different model Layers.

---

# 9. Dynamic Agent Configuration

Do not add Flue-style hooks or eve-style dynamic capability slots to core.

Dynamic behavior should be expressible through ordinary Effects.

For example, if context/tool resolution eventually becomes effectful:

```ts
Effect.gen(function* () {
  const user = yield* CurrentUser
  const permissions = yield* Permissions

  return permissions.canWrite(user)
    ? ReadWriteToolkit
    : ReadOnlyToolkit
})
```

Do not generalize toolkit configuration to an Effect in the first pass unless a real test requires it.

The design principle is:

> runtime-varying capabilities should emerge from Effect composition rather than a separate dynamic-agent DSL.

---

# 10. Session

`AgentSession` is a scoped runtime handle.

It should probably be an opaque interface returned from an Effect rather than a class.

Creation:

```ts
const session = yield* AgentSession.make(agent)
```

Lifecycle:

```ts
Effect.scoped(
  Effect.gen(function* () {
    const session = yield* AgentSession.make(agent)
    ...
  })
)
```

Closing the enclosing scope must:

1. interrupt any active execution fiber
2. close session queues/pubsub
3. release session-owned resources

Candidate internals:

```text
AgentSession
├ Ref<Prompt>
├ SubscriptionRef<SessionStatus>
├ Queue<SteeringInput>
├ Queue<FollowUpInput>
├ PubSub<AgentEventEnvelope>
├ Ref<Option<Fiber<...>>>
├ Ref<SequenceNumber>
└ IDs / metadata
```

Do not include canonical messages in `SubscriptionRef<SessionState>`.

Expose history separately:

```ts
AgentSession.history(session)
```

---

# 11. Session State Machine

Initial public interaction semantics:

```text
IDLE
 │
 │ prompt
 ▼
RUNNING
 │
 ├ steer
 │
 ├ followUp
 │
 └ interrupt
 │
 ├───────────────── normal quiescence ───────────────► IDLE
 │
 └───────────────── interruption ─────────────────────► IDLE
```

Rules:

```text
prompt      valid only while idle
steer       valid only while running
followUp    valid only while running
interrupt   valid only while running
```

Potential typed errors:

```text
AgentBusyError
AgentIdleError
AgentClosedError
```

Do not silently reinterpret invalid operations.

Examples:

- `prompt()` during active work => `AgentBusyError`
- `steer()` while idle => `AgentIdleError`
- `followUp()` while idle => `AgentIdleError`

## 11.1 Claiming the session must be atomic

Reading the status and then writing it is a check-then-act race: two concurrent
`prompt` calls can both observe `IDLE` and both proceed. The "at most one run
per session" invariant would then hold only by luck of where the runtime happens
to yield.

The transition must be a single atomic modify that both claims the session and
allocates the submission id:

```text
modify(state):
  closed  -> Closed
  running -> Busy
  idle    -> Claimed(submissionId), status := running
```

Allocating the id inside the same transition is what keeps the id and the claim
from disagreeing, and keeps ids gap-free when a concurrent prompt is rejected.

This race did not reproduce under the v4 scheduler during implementation. It was
fixed on principle: an invariant this central must not depend on scheduling.

---

# 12. Submission

A submission is the externally observed unit started by `prompt`.

Example:

```ts
const result = yield* AgentSession.prompt(session, "Implement X")
```

That Effect should not resolve merely because the first internal run stops.

It resolves when the submission reaches **quiescence**.

A submission may contain multiple runs because follow-ups can be queued while it is active.

```text
Submission S1
│
├ Run R1
│   ├ Turn 0
│   ├ Turn 1
│   └ stop
│
├ queued follow-up exists
│
├ Run R2
│   ├ Turn 0
│   └ stop
│
└ no follow-ups remain
    ↓
SubmissionCompleted
```

## Quiescence

A submission is quiescent when:

1. the current run has reached `Stop`
2. there is no pending follow-up input
3. no replacement run is being started

Then `prompt()` resolves.

This avoids fire-and-forget work continuing after `prompt()` has returned.

---

# 13. Run

A run is one contiguous agent-loop execution episode.

A follow-up starts a new internal run under the same submission.

Run terminal states:

```text
completed
failed
interrupted
```

A failed run fails the surrounding submission unless policy converts the relevant failure into model-visible data.

At most one run may execute at a time per session.

---

# 14. Turn

A turn is one model invocation plus resolution of its requested tool calls.

Initial turn lifecycle:

```text
1. Drain pending steering
2. Commit steering messages to canonical history
3. Snapshot canonical history
4. Derive model-facing Prompt
5. Emit TurnStarted
6. Call LanguageModel.generateText
7. Inspect response
8. Execute tool calls, if any
9. Commit assistant message + tool results to canonical history
10. Emit TurnCompleted
11. Evaluate AgentLoop
```

This ordering must be made explicit in tests.

**Corrected during implementation (guidance #15).** An earlier draft of this
list snapshotted canonical history *before* committing steering. That ordering
is self-defeating: the snapshot is what becomes the model-facing prompt, so
steering committed after it would not reach the model call it was meant to
influence, and a steer would silently take effect one turn later than promised.
Commit first, then snapshot.

Two consequences of steps 4 and 5 being in this order are worth stating, since
both are easy to get backwards:

* The prompt is derived **before** `TurnStarted` is emitted. A context transform
  that fails therefore cannot leave an orphaned `TurnStarted` with no matching
  `TurnCompleted`, which would otherwise break the §27 ordering invariant.
* `SteeringApplied` is emitted **before** `TurnStarted`, matching §27's
  `SteeringQueued < SteeringApplied < next TurnStarted`. Steering belongs to the
  boundary between turns, not to the turn it goes on to influence.

Important: streaming is not part of v0.1, so the assistant response is committed atomically after `generateText` completes.

---

# 15. Agent Loop

`AgentLoop` decides whether a completed turn should be followed by another turn.

Suggested interface:

```ts
export interface AgentLoop<E = never, R = never> {
  readonly decide: (
    state: AgentLoop.State
  ) => Effect.Effect<AgentLoop.Decision, E, R>
}
```

Initial decision type:

```ts
type Decision =
  | { readonly _tag: "Continue" }
  | { readonly _tag: "Stop" }
```

No `Suspend` in v0.1.

State must contain all information needed for built-in policies.

Candidate:

```ts
interface AgentLoop.State {
  readonly sessionId: AgentSession.Id
  readonly submissionId: AgentSubmission.Id
  readonly runId: AgentRun.Id
  readonly turnIndex: number
  readonly response: LanguageModel.Response
  readonly toolCalls: ReadonlyArray<ToolCall>
}
```

Do not include follow-up queue state unless a real loop policy needs it.

Follow-ups are submission orchestration, not necessarily loop policy.

## Built-ins

```ts
AgentLoop.untilIdle()
AgentLoop.maxTurns(n)
AgentLoop.and(a, b)
AgentLoop.or(a, b)
AgentLoop.make(...)
```

Composition should be explicit.

Do **not** support:

```ts
AgentLoop.untilIdle().pipe(
  AgentLoop.maxTurns(20)
)
```

if that syntax disguises logical conjunction.

Preferred:

```ts
AgentLoop.and(
  AgentLoop.untilIdle(),
  AgentLoop.maxTurns(20)
)
```

---

# 16. Tool Resolution Ownership

This is a critical implementation decision discovered by the spike.

Effect AI's `generateText` resolves tool calls internally by default.

That prevents the harness from owning:

- tool lifecycle events
- tool concurrency policy
- exact tool result commit timing
- tool failure policy
- interruption semantics around tool execution
- future approvals/policies

Therefore the harness MUST invoke the language model with:

```ts
disableToolCallResolution: true
```

or the exact current Effect AI option that disables automatic resolution.

The harness then calls the toolkit's handler itself.

Conceptually:

```text
LanguageModel.generateText({
  ...,
  disableToolCallResolution: true
})
      │
      ▼
Response with tool calls
      │
      ▼
Harness
      │
      ├ emit ToolCallStarted
      ├ toolkit.handle(...)
      ├ emit ToolCallSucceeded / failure event
      └ commit ToolResultPart
```

## Architectural note

This is a real coupling to Effect AI's manual tool-resolution API.

Document it explicitly.

Do not hide it as an implementation detail because compatibility with future Effect AI versions depends on this capability remaining available.

---

## 16.1 An agent always has a toolkit

An agent that declares no tools gets `Toolkit.empty`, not `undefined`.

This looks like a triviality and is not. With an optional toolkit, the model
call has to be written as a conditional:

```ts
LanguageModel.generateText({
  prompt: context,
  ...(handler === undefined ? {} : { toolkit: handler }),
  disableToolCallResolution: true
})
```

That conditional spread destroys inference: the call no longer resolves to
`GenerateTextResponse<Tools>`, so `response.toolCalls` degrades to `any` and the
tool types have to be re-asserted by hand further down. One code path with a
possibly-empty toolkit keeps the types intact end to end, and removes the
"model requested a tool but the agent has no toolkit" branch entirely — that
case is now a decode error inside the model call (§18.1).

---

# 16.2 Out-of-band input is a substitutable channel

Steering and follow-ups are the only values a run consumes that come from
neither the model, the tools, nor canonical history. That makes them the only
inputs a stronger runtime cannot reproduce for itself, and it is why they sit
behind `InputChannel` rather than a bare `Queue`:

```ts
interface InputChannel {
  readonly offer: (input: string) => Effect<void>
  readonly drain: Effect<ReadonlyArray<string>>   // never blocks
  readonly size: Effect<number>
}
```

`AgentSession.make` takes an optional factory and defaults to in-memory queues,
so ordinary use is unchanged.

The reason is replay determinism, and it is worth stating precisely because it
is not obvious. A durable interpreter replays model and tool results from its
journal, so a turn re-derives the prompt it derived the first time. But a queue
drain reads whatever happens to be pending at that instant: on replay the queue
is empty, the turn derives a *different* prompt from the one whose model result
is being replayed, and canonical history silently diverges from the journal.

Making the channel substitutable lets a durable interpreter record the drained
batch alongside the turn that consumed it.

This is the **only** seam of its kind in the core. Model and tool interception
need nothing, because `LanguageModel` is a service and toolkit handlers are
constructed by the caller — both are already Layer substitution (§30.1). If a
future interpreter needs interception the Layer boundary cannot express, that is
the argument for an execution interface; this is not.

---

# 17. Tool Execution

Use Effect AI's `Tool` and `Toolkit`.

Do not create parallel harness-specific tool abstractions.

The harness owns orchestration, not tool definition.

Initial execution policy:

- if one tool call: execute normally
- if multiple tool calls: concurrency policy must be explicit

Recommended initial default:

```ts
Effect.all(toolEffects, {
  concurrency: "unbounded"
})
```

but this should likely be represented by a narrow value:

```text
ToolExecution.parallel
ToolExecution.sequential
ToolExecution.concurrency(n)
```

Do not create a large tool middleware system.

The purpose of this value is only scheduling semantics.

---

# 18. Tool Lifecycle Invariant

Every tool call owned by a live run must have an observable lifecycle.

At minimum:

```text
ToolCallStarted
     ↓
ToolCallSucceeded
   or
ToolCallFailed
   or
ToolCallInterrupted
```

Do not emit only a generic run failure if a tool began execution.

Consumers need correlated tool lifecycle events.

This invariant is one of the primary reasons manual tool resolution is required.

## 18.0 The interrupted case must be emitted from a finalizer

`ToolCallInterrupted` cannot be emitted from the ordinary continuation that
inspects the tool's `Exit`. Once the fiber is interrupted that continuation
never resumes, so the event is simply never published — and the test for it
fails in a way that looks like the event was never wired up at all.

Wrapping the emit in `Effect.uninterruptible` does not help either: the problem
is not that the emit gets interrupted, it is that control never reaches it.

The terminal event must therefore be attached to the interruption path itself:

```ts
handler.handle(name, params, id).pipe(
  Effect.flatMap(Stream.runCollect),
  Effect.onInterrupt(() => emit(ToolCallInterrupted))
)
```

This is the general shape for any event that must survive the thing that caused
it.

---

## 18.1 The invariant is scoped to calls the harness starts

A tool call naming a tool the agent does not declare never reaches the harness:
`generateText` fails while decoding the response (§2.8). No `ToolCallStarted` is
emitted, so no terminal event is owed. The invariant is about calls the harness
began, not about every tool name a provider might return.

---

# 19. Tool Failure Policy

**Resolved during implementation.** Both behaviours were built and tested before
one was chosen as the default; the shape below is the outcome, and the reasoning
is retained because the decision is a policy judgement rather than a fact.

Effect AI supports failure results via `ToolResultPart.isFailure`.

Most practical agents want many tool failures to be returned to the model so it can recover:

```text
tool throws domain failure
      ↓
encode failure as ToolResultPart
      ↓
commit to conversation
      ↓
next model turn sees failure
      ↓
model retries / changes plan
```

But some failures should terminate the run:

- invariant violation
- session corruption
- harness bug
- infrastructure failure that cannot be represented safely
- interruption

Therefore tool failure handling should become an explicit policy boundary.

Do **not** hard-code "all tool errors fail run" as the permanent behavior.

Do **not** hard-code "all tool errors become model results" either.

## Resolution

`ToolExecution.FailurePolicy` is a two-case value on the agent definition:

```ts
type FailurePolicy =
  | { readonly _tag: "ReturnToModel" }
  | { readonly _tag: "FailRun" }
```

`ReturnToModel` is the default. The common tool failure is a bad argument the
model can correct, and destroying the run for it discards the context that was
just built. `FailRun` exists for pipelines that must not continue on bad state.

Three consequences follow, and none of them needs its own setting:

**Defects always fail the run**, whatever the policy. A defect means the handler
is broken, not that the model asked for something the tool could refuse. Only
typed failures are eligible to be returned to the model.

**Failure reported as a value** — `HandlerResult.isFailure`, which v4 supports —
is already the model's problem, so it is committed as a failed
`ToolResultPart` under either policy.

**Parallel failure aggregation follows from the policy.** Under `ReturnToModel`
a typed failure is not an error at all, so sibling tool calls always run to
completion. Under `FailRun` the first failure interrupts its siblings, which is
ordinary `Effect.all` semantics. No aggregation strategy needs to be invented.

The policy lives on `Agent`. It is deliberately *not* an `AgentLoop` concern:
the loop answers "should there be another turn", while this answers "was that an
error at all", which is upstream. Putting it in the loop would force the loop to
inspect tool results it otherwise never touches.

## Important

This is probably **not the AgentLoop's responsibility**.

The AgentLoop decides whether to continue after a completed turn.

Tool failure handling determines whether the turn can complete at all.

Keep those layers separate unless evidence strongly favors unification.

---

# 20. Steering

Steering changes future reasoning without implicitly cancelling work already in progress.

Default semantics:

> steering is observed only at turn boundaries.

If a steer arrives:

- during model generation: queue it
- during tool execution: queue it
- between turns: drain it before the next model call

Diagram:

```text
Turn N
│
├ model generation
│      ↑ steer arrives
│
├ tools
│
└ TurnCompleted
       ↓
drain steering queue
       ↓
append steering messages
       ↓
Turn N+1 model call
```

## No implicit abort

`steer()` must not automatically abort:

- model stream
- model request
- tools
- current turn

Immediate cancellation is the responsibility of:

```ts
AgentSession.interrupt(session)
```

A higher-level package may later implement:

```text
interrupt-and-reprompt
interrupt-and-steer
```

but these are compositions, not core semantics.

---

# 21. Steering Commit Semantics

At the next turn boundary:

1. drain steering queue in FIFO order
2. convert steering inputs to canonical prompt messages
3. append them to canonical history
4. emit steering-applied event(s)
5. derive next model-facing context

A queued steer should not merely exist ephemerally; once applied, it becomes part of canonical history.

Different behavior can be reconsidered only if replay use cases prove that steering needs separate provenance.

---

# 22. Follow-Ups

A follow-up queues additional work for the current submission.

```ts
yield* AgentSession.followUp(
  session,
  "Then add tests."
)
```

Follow-ups do not affect the currently running turn.

They do not change the current AgentLoop decision.

After the current run stops:

```text
run stops
   │
   ▼
follow-up queue nonempty?
   │
   ├ yes → append follow-up to canonical history
   │        create next Run under same Submission
   │
   └ no  → submission reaches quiescence
```

FIFO ordering by default, and FIFO all the way through — including the batch a
single drain returns. An implementation that takes the first item and puts the
tail back on the queue reverses it: `A, B, C` becomes `A, C, B`. Buffer the
batch instead of re-queueing it.

A follow-up submitted while idle returns `AgentIdleError`.

## 22.1 Closing a submission's input is a distinct step

Quiescence has a window that is easy to miss. The submission drains an empty
queue and concludes it is finished, but the session does not become idle until
the `prompt` call returns — so `followUp` still succeeds in between, and that
accepted input is then discarded when the session is released. The caller was
told the work was queued, and it never runs.

`status` cannot express this, because the submission finishes fractionally
before the session is idle. Session state therefore carries an explicit
`acceptingFollowUps` gate, and the close is a three-step sequence:

```text
drain -> empty?
   |
   +-- atomically clear acceptingFollowUps   (nothing more can be accepted)
   |
   +-- drain again                            (catch anything accepted first)
   |
   +-- non-empty? re-open the gate and keep going
```

The second drain is the part that makes it correct: after the gate closes,
nothing new can arrive, so one more look is guaranteed to find everything that
was accepted.

> A follow-up that is accepted is always executed. Rejecting it is fine;
> accepting and dropping it is not.

---

# 23. Interruption

Interruption uses Effect structured concurrency.

The active submission/run executes in a fiber owned by the session scope.

```text
AgentSession Scope
      │
      └ Active Execution Fiber
            │
            ├ LanguageModel request
            └ Tool execution fibers
```

Calling:

```ts
AgentSession.interrupt(session)
```

interrupts the active execution fiber.

Child fibers must obey structured interruption.

No custom cancellation-token abstraction.

## v0.1 commit semantics

Because streaming is deferred, interruption semantics are simple:

- completed previous turns remain committed
- current incomplete turn is not committed
- already completed tool side effects cannot be undone
- any canonical steering/follow-up inputs already committed remain according to their explicit commit points

Tests must verify exactly when canonical state changes.

---

## 23.1 Interrupting the caller must release the session

`prompt` forks its submission into a fiber owned by the **session** scope and
awaits it. That is what allows `interrupt` to be ordinary fiber interruption.
It also creates a failure mode that is easy to miss.

If the *caller* of `prompt` is interrupted — an `Effect.timeout`, a lost
`Effect.race`, an enclosing fiber going away — the await is cancelled, but the
submission fiber is owned by the session and keeps running. The session stays
`RUNNING` for good, and every later `prompt` fails with `AgentBusyError`.

This is not an edge case. Timing out an agent call is ordinary usage.

The release must therefore be a finalizer that runs however the call ends:

```text
Fiber.await(submission)
  ensuring:
    Fiber.interrupt(submission)   // no-op if already done
    release: status := idle, drop queues, clear active fiber
```

Stated as an invariant:

> A submission never outlives the `prompt` call that started it.

This was a real defect in the first implementation, reproduced before it was
fixed, and it is the strongest argument for treating structured concurrency as
a design obligation rather than something Effect handles for you automatically.

---

# 24. Streaming — Explicitly Deferred

Do not implement `streamText` in v0.1.

Do not emit `MessageDelta` yet.

Reason:

Streaming introduces unresolved commit semantics for partially generated assistant messages.

Questions that must be answered before implementation:

- If interrupted mid-stream, is partial assistant text committed?
- Is partial text observable but noncanonical?
- If a streamed tool call is incomplete, what is persisted?
- If a provider emits malformed/incomplete tool-call chunks before interruption, what becomes canonical?
- Should the event stream expose data that canonical history later omits?
- Does replay need to reproduce partial output events?

Current v0.1 rule:

> assistant messages are committed atomically after non-streaming `generateText` completes.

Once this is stable, add a dedicated streaming design phase.

---

# 25. Event Model

Every event should be serializable domain data.

Use Effect Schema.

Recommended envelope:

```ts
interface AgentEventEnvelope {
  readonly sessionId: SessionId
  readonly submissionId: Option<SubmissionId>
  readonly runId: Option<RunId>
  readonly turn: Option<number>
  readonly sequence: number
  readonly event: AgentEvent
}
```

`submissionId` is optional for the same reason `runId` is: `SessionStarted` and
`SessionClosed` belong to no submission. Correlation is supplied by the emitting
code, which always knows its own position, rather than read back from session
state, which may already have moved on.

These are `Option`, not `| null`; see §33.3.

Sequence is monotonically increasing per session.

This provides:

- total event order
- correlation
- gap detection
- deterministic tests
- easier persistence later

Event payloads should not redundantly repeat identifiers already in the envelope unless needed independently.

---

# 26. Initial Event Set

Session:

```text
SessionStarted
SessionClosed
```

Submission:

```text
SubmissionStarted
SubmissionCompleted
SubmissionFailed
SubmissionInterrupted
```

Run:

```text
RunStarted
RunCompleted
RunFailed
RunInterrupted
```

Turn:

```text
TurnStarted
TurnCompleted
```

Model/message:

```text
MessageCompleted
```

No `MessageDelta` in v0.1.

Tools:

```text
ToolCallStarted
ToolCallSucceeded
ToolCallFailed
ToolCallInterrupted
```

Interaction:

```text
SteeringQueued
SteeringApplied
FollowUpQueued
FollowUpApplied
```

Avoid adding dozens of micro-events initially.

---

# 27. Event Ordering

Per session, envelope `sequence` establishes total ordering.

Required invariants:

```text
RunStarted
  <
TurnStarted
  <
all events belonging to turn
  <
TurnCompleted
  <
RunCompleted
```

For tools:

```text
ToolCallStarted
  <
ToolCallSucceeded | ToolCallFailed | ToolCallInterrupted
```

For steering:

```text
SteeringQueued
  <
SteeringApplied
  <
next TurnStarted
```

For follow-up:

```text
FollowUpQueued
  <
current RunCompleted
  <
FollowUpApplied
  <
next RunStarted
```

These should be tested as event-sequence assertions.

---

# 28. Event Delivery

Internally:

```text
PubSub<AgentEventEnvelope>
```

Publicly:

```ts
Stream.Stream<AgentEventEnvelope>
```

The exact PubSub strategy is implementation-specific.

Important contract:

> `session.events` is an observational live stream, not a durable journal.

A slow/disconnected subscriber is not guaranteed to be a persistence mechanism.

Do not compromise agent execution semantics by forcing durability through PubSub backpressure.

A future persistence extension should attach at the commit/event-production boundary, not rely on arbitrary live subscribers.

---

## 28.1 Emission must be serialized

Allocating a `sequence` and publishing the envelope are two steps. Two
concurrent emitters — parallel tool calls are the obvious case — can therefore
take sequence numbers in one order and publish in the other.

Consumers could always recover the intended order by sorting on `sequence`, so
this is not a correctness bug. But "arrival order matches sequence order" is a
materially stronger guarantee for a live consumer such as a UI, and it costs one
semaphore permit around allocate-and-publish. Take it.

The publish itself must remain non-blocking: the PubSub is unbounded, and a slow
subscriber must never apply backpressure to the agent loop (§28).

---

# 29. Persistence Extension Boundary

Do not implement persistence in core v0.1.

But structure commits so a future persistence service can hook into canonical transitions.

Potential future capability:

```ts
class AgentStore extends Context.Service<...>()(...)
```

with concepts like:

```text
appendEvent
loadSession
saveSnapshot
```

The durability/persistence implementation may require synchronous commit acknowledgement before runtime state advances.

That is separate from `session.events`.

---

# 30. Durability

Persistence is not durability.

Durability eventually requires explicit semantics for:

- crash during model call
- crash after tool side effect but before result commit
- retries
- idempotency
- safe checkpoints
- process restart
- journal replay
- external side effects

Do not leak incomplete durability semantics into v0.1.

Future integration targets may include:

```text
effect/unstable/workflow
effect/unstable/eventlog
effect/unstable/persistence
```

but only after the in-process state machine is stable.

## 30.1 The Workflow mapping, tested

A spike checked the load-bearing question:
can the same agent definition be reinterpreted durably **without the harness
knowing durability exists**? The answer shapes whether core needs an
interception interface.

**It can, and core needs no change.** An agent built with plain `Agent.make`
runs inside `Workflow.toLayer` calling plain `AgentSession.prompt`, and the
model call becomes an `Activity` purely by swapping the provided
`LanguageModel` layer. The reason is structural rather than lucky:
`LanguageModel.make` takes a provider returning `Array<Response.PartEncoded>`,
which is already an encodable value, so the activity boundary lands exactly
where persistence needs it. Tools work the same way — a durable package wraps
the toolkit's handlers when constructing it.

That is the answer to the `AgentExecution` question WORKFLOW.md raises: **the
interception points a durable interpreter needs are already Layers**, and Layers
are already the substitution mechanism. Do not add `AgentExecution` until a
durable implementation demonstrates interception that the Layer boundary cannot
express.

### Friction the durable package must absorb

* `LanguageModel.make` pins its provider's requirements to `IdGenerator`, so an
  `Activity` (needing `WorkflowEngine | WorkflowInstance`) cannot be dropped
  straight in. The workflow context has to be captured inside the running
  workflow and provided to the activity, which means **the model layer must be
  constructed inside the workflow body**. Encode this in the package's API so
  users never hand-roll it.
* A defect terminates a workflow permanently: re-executing the same idempotency
  key returns the recorded failure. `Effect.die` therefore does not simulate a
  crash, and a test written that way proves nothing.
* Resumption is not "call `execute` again" — that hangs on an interrupted
  execution. Use `Workflow.resume(executionId)`.

### The durable engine is testable without SQL

A follow-up check established that `ClusterWorkflowEngine.layer` composes with
`TestRunner.layer`, which has no dependencies of its own. The durable path can
therefore be developed and tested in ordinary unit tests, with no database.
`WORKFLOW_CLUSTER_PLAN.md` builds every phase on that.

### What remains unproven

The headline claim — process dies mid-submission, restarts, and the persisted
model result is returned rather than the model being called again — needs a
persistent engine and the resume path, not `WorkflowEngine.layerMemory`. It is
the first thing `@effect-harness/durable` should demonstrate.

Concurrent `Activity.make` at unbounded concurrency (which §17 relies on for
tool execution) completes normally on `4.0.0-rc.111`, so
[effect#6014](https://github.com/Effect-TS/effect/issues/6014) does not
reproduce — but only on the fresh-execution path, and that issue was about
replay. Treat durable parallel tool execution as unvalidated until replay is
tested.

## 30.2 Agent semantics are independent of execution strength

The principle this supports, and the reason the boundary is worth keeping:

> The same agent definition should admit progressively stronger interpretations
> without being rewritten.

```text
Agent
 ├ embedded    Ref / Queue / Fiber          (v0.1)
 ├ persistent  AgentStore
 ├ distributed RPC / Cluster
 └ durable     Workflow / Activity / DurableQueue / DurableDeferred
```

This is a constraint on core, not a feature of it: core must keep its execution
boundaries explicit enough to be reinterpreted, and must not require any of the
stronger runtimes. What must **not** be promised is that arbitrary harness
programs become durable automatically — durable execution imposes replay
constraints that ordinary fiber concurrency does not.

---

# 31. AgentSession API Style

Prefer Effect module-style APIs over large mutable OO classes.

Example:

```ts
const session = yield* AgentSession.make(agent)

const result = yield* AgentSession.prompt(
  session,
  "Hello"
)

yield* AgentSession.steer(
  session,
  "Focus on the API."
)

yield* AgentSession.followUp(
  session,
  "Then write tests."
)

yield* AgentSession.interrupt(session)
```

Potential pipeable dual APIs may be added only if consistent with Effect style and worthwhile.

Do not prioritize fluent method ergonomics over ecosystem consistency.

---

# 32. Effect.fn and Tracing

Meaningful runtime operations should use named `Effect.fn` where appropriate.

Examples:

```text
AgentSession.make
AgentSession.prompt
AgentSubmission.execute
AgentRun.execute
AgentTurn.execute
ToolExecution.execute
ContextTransform.apply
```

This should naturally produce useful spans/traces.

Avoid creating a separate custom tracing subsystem.

Use Effect tracing first.

## 32.1 `Effect.fn`, not `Effect.gen` + `withSpan`

Use `Effect.fn` as the **function definition**, taking the operation's own
parameters:

```ts
export const execute = Effect.fn("AgentTurn.execute")(function* <Tools>(
  session: Session<Tools>,
  submissionId: SubmissionId,
  runId: RunId,
  turn: number
) {
  yield* Effect.annotateCurrentSpan({ runId, turn })
  // ...
})
```

Not as a wrapper around a zero-argument generator that is then invoked:

```ts
// wrong: an immediately-invoked Effect.fn
export const execute = (session, ...) =>
  Effect.fn("AgentTurn.execute")(function* () { /* ... */ })()
```

Both produce a span, so the difference is invisible in tests and in the trace.
The Effect language service flags the second form (`effectFnIife`), and it is
worth listening to: `Effect.fn` also supplies argument capture and stack-trace
information, which the wrapper form discards.

One caveat learned the hard way. Do **not** annotate the generator's return type
to steer inference:

```ts
function* (...): Generator<any, Result<Tools>, any>   // destroys E and R
```

That collapses the error and requirement channels to `unknown`, silently undoing
§33.1. Let the return type be inferred, and verify with a type-level assertion.

## 32.2 Attributes belong on the current span

Use `Effect.annotateCurrentSpan` inside the function rather than passing an
`attributes` object to a span wrapper. It keeps the annotation next to the value
it describes, and it is the only option once the function *is* the span.

The engine annotates:

```text
AgentSession.prompt      -
AgentSubmission.execute  submissionId
AgentRun.execute         runId, submissionId
AgentTurn.execute        runId, turn
ToolExecution.tool       tool, toolCallId
```

Note that `LanguageModel.generateText` already opens its own span and annotates
it with GenAI semantic conventions (§2.8). The harness's spans are that span's
parents, so a trace nests correctly with no further work. Do **not** add GenAI
attributes at the harness layer: model-level semantics belong to the model
layer, and restating them there would produce two sources of truth for the same
attributes.

---

## 32.3 Exporting Traces

The harness emits ordinary Effect spans, so exporting them is application
wiring, not a harness concern. It should never depend on an exporter.

v4 ships an OTLP exporter in-tree at `effect/unstable/observability`:

```ts
Otlp.layer({
  baseUrl: "http://localhost:4318",
  resource: { serviceName: "effect-harness" }
}).pipe(Layer.provide(FetchHttpClient.layer))
```

or `Otlp.layerFromConfig(...)` to read the standard `OTEL_*` environment
configuration. This covers traces, logs and metrics with no OpenTelemetry SDK
dependency.

`@effect/opentelemetry` (which does publish a matching v4 version) is the SDK
bridge, and is only needed to interoperate with existing OTel instrumentation in
the same process. Prefer the built-in exporter otherwise: one less dependency in
the example surface, and nothing in the harness changes either way.

A trace of one prompt should nest as the execution nests:

```text
AgentSession.prompt
└── AgentSubmission.execute
    └── AgentRun.execute
        └── AgentTurn.execute
            ├── LanguageModel.generateText   (GenAI conventions, from Effect AI)
            └── ToolExecution.tool
```

This nesting is worth asserting in a test — it is the cheapest available proof
that the engine's structure is what the design claims.

---

# 33. Typed Requirements

`AgentLoop` and `ContextTransform` should preserve Effect environment requirements.

For example:

```ts
ContextTransform<MemoryError, Memory | Workspace>
```

or whatever generic order matches the project style.

This allows higher-level features to express dependencies through the Effect type system itself.

Likewise a loop may depend on:

```text
TokenBudget
UsagePolicy
FeatureFlags
```

without the harness understanding those concepts.

The type:

```text
Effect<Success, Error, Requirements>
```

is the capability algebra.

Do not invent a separate capability registry.

## 33.1 The error channel must never be `unknown`

Preserving requirements is only half of it. A public function's **error channel
must name what can go wrong**.

This is easy to lose by accident. The first implementation typed `prompt` as:

```ts
Effect<Result, AgentBusyError | AgentClosedError | unknown>
```

which TypeScript collapses to `Effect<Result, unknown>`. The runtime `Cause` was
preserved perfectly; the *type* was thrown away — erasing exactly the
information Effect's error channel exists to carry, and the thing §23 of the
previous draft warned against.

The correct shape names every source:

```ts
type PromptError<Tools> =
  | AgentBusyError
  | AgentClosedError
  | AiError                              // the provider
  | Tool.HandlerError<Tools[keyof Tools]> // each tool's declared failure
```

A tool declaring `failure: Schema.Literal("not_found")` must surface
`"not_found"` to the caller of `prompt`. Verify this with a type-level
assertion; it is not visible from reading the code.

## 33.2 End-user code must never need a cast

This is a constraint on the API, not a style rule for users.

No `as any`, no `as unknown as`, and no hand-annotated parameters that inference
should have supplied. If using the harness requires a cast, that is a defect in
a signature.

The practical consequence is that **the engine is generic end to end**. It is
tempting to run the internals on erased tool types and re-assert at the public
boundary; doing so pushes the erasure outward until it surfaces in user code.
`Session`, `AgentTurn`, `AgentRun`, `AgentSubmission` and `ToolExecution` all
carry `Tools`.

A small number of casts inside `src/` are legitimate, and each needs a stated
reason of a specific kind:

- constructing a phantom type parameter that has no runtime counterpart;
- an inference fact the compiler cannot restate (for example, that a defaulted
  toolkit branch is only reached when `Tools` was inferred as `{}`);
- an identity the type system cannot see, such as TypeScript declining to reduce
  `Tools[keyof Tools]` to `Tools[string]` for an unresolved generic.

"It was easier" is not one of them.

### Compiling is not evidence

`any` satisfies every call site. When a public signature changes, assert that
inference stayed precise rather than concluding it from a green build — and
**break each assertion once** to confirm it is enforced. An assertion that
cannot fail proves nothing, and a type-level assertion is unusually easy to
write in a form that cannot fail.

The reference is a worked example carrying its own assertions: a full typed
agent with tools, a custom loop and a context transform, written with no casts
and no annotations, asserting that tool calls, results and the error channel are
not `any`.

---

## 33.5 Tool parameters reach the loop encoded

The harness runs with `disableToolCallResolution: true` (§16), and Effect AI
deliberately leaves tool-call parameters in their **encoded** schema form in
that mode — decoding is the handler's job, and `Toolkit.handle` accordingly
takes encoded parameters.

`GenerateTextResponse<Tools, EncodedToolParameters>` defaults its second
parameter to `false`, so writing `GenerateTextResponse<Tools>` silently claims
*decoded*. `AgentLoop.State` and `AgentTurn.Result` must therefore both spell
out `true`.

The distinction is invisible for a parameter schema like
`{ query: Schema.String }`, where encoded and decoded coincide — which is
exactly why it is worth a test with a transforming schema. With
`Schema.DateFromString`, a loop typed as decoded would claim a `Date` while
holding a string.

## 33.6 Requirements are complete, or they are misleading

Three kinds of requirement reach a session, and all three must appear in
`AgentSession.make`:

```text
LanguageModel        the model
loop / transform     policy services            (§33)
toolkit              a tool's `dependencies`    (Tool.HandlerServices)
```

The third is easy to drop. A tool declaring `dependencies: [Greeter]` produces a
handler requiring `Greeter`; if `ToolkitInput` erases that to `any`, the program
typechecks and fails at the first tool call — precisely the failure the Effect
environment exists to prevent. `ToolkitInput<Tools, R>` carries it, and
`Agent.make` unions it into the agent's `R`.

> A requirement that is real at runtime and absent from the type is worse than
> no type at all, because it is trusted.

## 33.3 Absence is `Option`, in domain types

Domain types express absence with `Option`, never `null` or `undefined`:

```text
AgentEventEnvelope.submissionId / runId / turn
SessionState.activeSubmissionId / activeRunId
AgentSubmission.Result.response
Agent.instructions
```

The distinction that matters is **domain value versus options record**. An
argument record describing what a caller may omit keeps optional properties —
`readonly turn?: number | undefined` — because that is how Effect's own APIs
express arguments, and because `Option.none()` is noise at a call site that
simply did not pass something. `Correlation` is such a record and deliberately
keeps optional properties.

The cost lands on consumers, and is worth paying:

```ts
// before
const usage = result.response?.usage
// after
const usage = Option.map(result.response, (r) => r.usage)
```

Slightly longer, but absence is now impossible to forget: there is no path where
`undefined` silently flows onward. A serialization boundary can still project
`Option` to `null` — that is the wire format's business, not the domain's.

## 33.4 `message` is a getter, not a Schema field

Harness errors are `Schema.TaggedError`. `message` is defined as a getter on the
class and is deliberately **not** among the schema's fields:

```ts
export class AgentBusyError extends Schema.TaggedError<AgentBusyError>()(
  "AgentBusyError",
  { sessionId: SessionId }
) {
  override get message() {
    return `Session ${this.sessionId} is already running a submission`
  }
}
```

This keeps both properties that matter. The error still reads well in a log or a
stack trace, because it is an ordinary `Error` with a real message. And because
the message is *derived*, it cannot drift from the fields it describes, and it
never enters the encoded form — the wire carries `{ _tag, sessionId }` and
nothing a receiver could rebuild for itself.

Decoding restores it for free: the codec reconstructs the class, so the getter
is present again on the far side of the boundary.

Both halves are worth a test, because each is invisible from reading the code:
that `message` is absent from the encoded value, and that it is present after
decoding.

---

# 34. Models for Parent and Child Agents

The harness must document how nested sessions can run with different `LanguageModel` implementations.

Example:

```ts
const Delegate = Tool.make(...)

const DelegateLive =
  Delegate.toLayer(
    Effect.gen(function* () {
      return {
        delegate: () =>
          Effect.scoped(
            Effect.gen(function* () {
              const child =
                yield* AgentSession.make(ResearchAgent)

              return yield* AgentSession.prompt(
                child,
                "Research this subproblem"
              )
            })
          ).pipe(
            Effect.provide(
              AnthropicLanguageModel.model("...")
            )
          )
      }
    })
  )
```

Parent model and child model are independently provided through Effect.

This should be a documented pattern, not a new subagent abstraction.

---

# 35. Subagents

No first-class subagent concept in v0.1.

A child agent is simply a tool implementation that creates another scoped session.

Advantages:

- lifetime follows structured concurrency
- interruption propagates naturally
- model can be independently provided
- no multi-agent graph abstraction required

Add a convenience abstraction only after repeated real-world use demonstrates common semantics.

---

# 36. Human Approval

No first-class approval state machine in core.

A tool may depend on an `Approval` Service and block until resolved.

This is superior to adding `Suspend` to `AgentLoop`.

`AgentLoop.Decision` remains only:

```text
Continue
Stop
```

Approval is tool behavior, not loop behavior.

---

# 37. Memory

No first-class core memory abstraction.

Memory can be implemented as:

```text
AgentEvent / canonical outputs
          │
          ▼
Memory writer

Memory Service
          │
          ▼
ContextTransform
          │
          ▼
next model-facing prompt
```

This architecture should be validated later as an external package.

---

# 38. Sandbox

No core sandbox abstraction.

Tools may depend on:

```ts
Sandbox
```

as a Service.

Different Layers can provide:

```text
LocalSandbox
DockerSandbox
CloudflareSandbox
VercelSandbox
DaytonaSandbox
RemoteSandbox
```

Harness remains unchanged.

---

# 39. Skills

No core skill abstraction.

A higher-level package may define:

```text
Skill
├ metadata
├ instructions
├ tools
└ resources
```

and expose selected skill contents through:

- tool availability
- context derivation
- application-level registries

Do not add skill-loading semantics to core.

---

# 40. OpenCode Integration

OpenCode is not the foundation.

Dependency direction:

```text
OpenCode adapter / integration
        │
        ▼
Effect Harness
        │
        ▼
Effect AI
        │
        ▼
Effect
```

Potential future use:

- expose OpenCode-backed coding capabilities as tools/services
- compare lifecycle semantics
- adapt OpenCode sessions into higher-level interfaces
- reuse ideas around permissions, compaction, skills, coding tools

Do not bind core correctness to `@opencode-ai/sdk-next`.

---

# 41. Package Structure

Initial package:

```text
@effect-harness/core
```

or whichever final name is selected.

Suggested source modules:

```text
src/
├ Agent.ts
├ AgentSession.ts
├ AgentSubmission.ts
├ AgentRun.ts
├ AgentTurn.ts          # possibly internal initially
├ AgentLoop.ts
├ AgentEvent.ts
├ ContextTransform.ts
├ ToolExecution.ts      # internal or minimally exported
├ internal/
│  ├ ids.ts
│  ├ eventBus.ts
│  ├ history.ts
│  └ state.ts
└ index.ts
```

Do not export every internal module.

`AgentTurn` and `ToolExecution` may remain internal until external use cases exist.

---

# 42. Public API Target for v0.1

Aim for roughly this surface:

```ts
Agent.make(...)

AgentSession.make(agent)
AgentSession.prompt(session, input)
AgentSession.steer(session, input)
AgentSession.followUp(session, input)
AgentSession.interrupt(session)
AgentSession.history(session)
AgentSession.status(session)
AgentSession.events(session)

AgentLoop.make(...)
AgentLoop.untilIdle()
AgentLoop.maxTurns(n)
AgentLoop.and(...)
AgentLoop.or(...)

ContextTransform.make(...)
ContextTransform.identity
ContextTransform.compose(...)
```

Plus exported Schemas/types for:

```text
IDs
events
statuses
decisions
errors
```

If implementation requires dozens more public functions, reconsider the abstraction boundary.

## 42.2 Convenience, and the bar it has to clear

§44's rule — no new exported concept until two independent features need it —
applies to sugar as much as to abstractions. Four helpers cleared it, each
because it removes friction that was demonstrably repeated in this repository
rather than friction someone might hypothetically feel:

**`Agent.toolkit(tools, handlers)`** builds and binds in one step. The two-step
form appeared 20 times, and it has a silent failure mode: naming
`Toolkit.make(T)` twice binds the handlers to an instance you are not using, so
every tool call resolves to nothing and *succeeds*. This makes that
unrepresentable rather than documented.

**`AgentLoop.bounded(n)`** is `and(untilIdle(), maxTurns(n))`, which appeared
six times including the definition of done. Spelling it out invites leaving the
bound off, and an unbounded loop against a looping model is unbounded spend.

**`ContextTransform.appendSystem` / `prependSystem`** cover the dynamic
instruction case §6 lists first. They add a *discrete* system message rather
than folding into an adjacent one, because folding makes `compose` order
unpredictable — two transforms each adding a line can end up concatenated.

**`AgentEvent.match`** replaces the switch every stream consumer writes. A
hand-written switch silently stops covering events as the ADT grows; this makes
that a type error.

None of them adds a concept. Each is a shorter spelling of something the
existing vocabulary already expresses, which is the only kind of sugar worth
exporting.

## 42.1 Which of these are Schemas, and which are not yet

Implementation split this list rather than satisfying it uniformly.

**Schemas now**, because they cost little and pay immediately:

- **IDs** — `Schema.String.pipe(Schema.brand(...))` rather than a hand-rolled
  branded alias, so an id carries a validator and codec instead of a
  compile-time tag only.
- **Errors** — `Schema.TaggedError`. They remain ordinary yieldable Effect
  errors, catchable by tag, while also being transportable across an RPC or HTTP
  boundary without a parallel set of wire types.

**Events are Schemas too, and the `Cause` question is settled.**

The blocker was concrete rather than stylistic: `RunFailed`, `SubmissionFailed`
and `ToolCallFailed` each carried a `Cause`, and v4 has no `Schema.Cause` codec.
That forced the question of how a failure crosses a serialization boundary.

**Events now carry `AgentEvent.Failure`** — `{ tag, message, isDefect }` — and
not a `Cause`. The constraint prompted the decision, but the decision stands on
its own: events are the *serializable* record of what happened, and a `Cause` is
an in-process value holding fibers and arbitrary defect payloads that no wire
format should try to reproduce. `isDefect` preserves the distinction consumers
actually act on (§19), and the full `Cause` remains where it can be used — the
typed error channel of `prompt` (§33.1).

`AgentEvent` and `AgentEventEnvelope` are `Schema.Union`/`Schema.Struct`, so an
AG-UI projection, an RPC surface or a store can decode them without a parallel
set of wire types. This does **not** make the live stream durable (§28).

**Statuses and decisions remain plain types.** They are closed unions of string
literals with no serialization consumer yet.

---

# 43. Implementation Phases

## Phase 0 — Repository setup

Create:

- package
- tsconfig
- build/test setup
- Effect
- Effect AI
- one supported provider or fake model adapter for tests
- strict lint/typecheck

Deliverable:

```text
pnpm/bun test
pnpm/bun typecheck
```

working from the start.

---

## Phase 1 — Deterministic model test harness

Before production code, create a deterministic fake `LanguageModel` or the cleanest Effect AI-compatible test double.

It must support scripted responses such as:

```text
Turn 0:
  assistant requests tool A

Turn 1:
  assistant returns final answer
```

Also support:

- delayed model response
- model failure
- multiple tool calls
- inspection of exact Prompt received

This is essential for testing context derivation and steering.

---

## Phase 2 — Canonical history

Implement session-owned canonical `Prompt`.

Tests:

1. initial prompt is committed correctly
2. model receives derived copy
3. `ContextTransform` can alter model-facing prompt
4. canonical prompt remains unchanged by transform
5. response commits exactly once
6. canonical ordering is deterministic

Do not use Effect AI `Chat` as authority.

---

## Phase 3 — Manual tool resolution

Implement language-model invocation with Effect AI automatic tool resolution disabled.

Verify:

```text
disableToolCallResolution: true
```

or current equivalent.

Then execute returned tool calls via toolkit handling.

Tests:

1. tool is not auto-executed by Effect AI
2. harness executes tool once
3. `ToolCallStarted` precedes completion
4. result becomes Effect AI `ToolResultPart`
5. result is committed to canonical history
6. next model turn receives the result

This phase validates the most important external coupling.

---

## Phase 4 — Turn execution

Create internal `AgentTurn.execute`.

Responsibilities:

1. apply pending steering
2. snapshot canonical prompt
3. derive model prompt
4. emit start
5. call model
6. manually resolve tools
7. atomically commit completed turn
8. emit completion
9. return turn result

No loop yet.

Test atomic commit behavior.

---

## Phase 5 — AgentLoop

Implement:

```text
Continue
Stop
```

and:

```ts
untilIdle()
maxTurns(n)
and(...)
or(...)
```

`untilIdle()` should continue when the completed model response requested executable tool calls and stop when no tool work remains.

Tests:

- one-turn completion
- repeated tool loop
- max-turn stop
- logical composition

---

## Phase 6 — Run fiber

Implement `AgentRun.execute`.

Responsibilities:

```text
repeat AgentTurn.execute
evaluate AgentLoop
continue/stop
```

Run is executed inside a fiber owned by session.

Tests:

- one active run
- cancellation
- model failure
- tool failure current behavior
- run terminal events

---

## Phase 7 — Steering queue

Implement FIFO steering queue.

Tests using deterministic synchronization:

### steer during model generation

Expected:

```text
steer queued
current turn completes
steer applied before next TurnStarted
```

### steer during tool execution

Same semantic result.

### multiple steers

Preserve FIFO ordering.

### steer while idle

`AgentIdleError`.

Do not abort current model/tool work.

---

## Phase 8 — Follow-up queue and submission

Implement `AgentSubmission`.

`prompt()` creates submission and waits for quiescence.

Tests:

### follow-up during Run 1

Expected:

```text
Run 1 stops
follow-up applied
Run 2 starts
prompt() still pending
Run 2 stops
queue empty
prompt() resolves
```

### multiple follow-ups

FIFO.

### follow-up while idle

`AgentIdleError`.

### prompt while running

`AgentBusyError`.

This phase resolves the previous run/follow-up ambiguity.

---

## Phase 9 — Interruption

Implement structured interruption.

Tests:

- interrupt during model request
- interrupt during tool execution
- interrupt between turns
- previous committed turns remain
- current incomplete turn not committed
- terminal events correctly emitted
- session becomes usable/idle afterward unless closed

Use Effect synchronization primitives, not sleeps.

If `TestClock` is useful for specific delays, use it; otherwise prefer `Deferred`/latches for deterministic race control.

---

## Phase 10 — Event envelopes and ordering

Implement:

- session sequence counter
- IDs
- envelope
- live Stream

Tests should assert exact event sequences.

Do not merely test that events exist.

Example:

```text
SubmissionStarted #1
RunStarted        #2
TurnStarted       #3
ToolCallStarted   #4
ToolCallSucceeded #5
TurnCompleted     #6
...
```

Sequence numbers must be strictly monotonic per session.

---

## Phase 11 — Tool failure policy spike

Before freezing v0.1 behavior, implement tests for two policies:

### Policy A — fail run

```text
tool failure
  ↓
ToolCallFailed
  ↓
RunFailed
  ↓
SubmissionFailed
```

### Policy B — return failure to model

```text
tool failure
  ↓
ToolCallFailed
  ↓
ToolResultPart(isFailure = true)
  ↓
TurnCompleted
  ↓
next model turn
```

Evaluate which API boundary cleanly owns this decision.

**Outcome:** both policies implemented and tested, exported as
`ToolExecution.FailurePolicy` on the agent definition, defaulting to
`ReturnToModel`. It is not in `AgentLoop`. See §19 for the full reasoning and
for the two consequences that fell out of it — defects always failing the run,
and parallel aggregation needing no separate setting.

---

## Phase 12 — API cleanup

Only after semantics are proven:

- finalize names
- minimize exports
- make values opaque where appropriate
- add docs
- add Effect.fn span names
- add Schema definitions
- inspect inferred `E`/`R` requirements
- remove implementation artifacts from public types

---

# 44. Deterministic Test Matrix

The test suite is load-bearing.

## 43.0 The Effect language service is part of the toolchain

Install `@effect/language-service` and register it in `tsconfig.json`:

```json
{ "compilerOptions": { "plugins": [{ "name": "@effect/language-service" }] } }
```

It catches Effect-specific problems that `tsc` cannot see, and it works against
v4. On this codebase it immediately found, in code that typechecked cleanly and
passed every test:

- eight `Effect.fn` calls written as immediately-invoked wrappers (§32.1);
- a `yield* Effect.never` that should have been `return yield*`, so the
  generator had no definitive exit point for narrowing;
- several single-statement `Effect.gen` wrappers that added a layer for nothing.

Run it in CI, not only in the editor:

```bash
npx effect-language-service diagnostics --project tsconfig.json
```

A green `tsc` is not evidence that Effect is being used correctly. Treat a
non-empty diagnostic list the same way as a type error.

---

## 44.0 Synchronising deterministically

Two mistakes made these tests non-deterministic in practice, and both are easy
to repeat.

**Synchronise on the event you actually mean.** Waiting for session state to
show a run is active and then interrupting is a race: a run becomes active
slightly *before* it reaches the model. The interrupt can land first, the run
consumes no scripted response, and every later assertion in the test is
misaligned against the script. The symptom appears far from the cause — usually
as an unrelated hang later in the test.

The fake model must therefore expose a latch that fires when a model call is
genuinely entered, and interruption tests must wait on that, not on state.

**Build each toolkit once.** Writing

```ts
Toolkit.make(T).pipe(Effect.provide(Toolkit.make(T).toLayer(handlers)))
```

creates two unrelated toolkits and binds the handlers to the one that is not
used. Every tool call then resolves to nothing and *succeeds silently* — no
error, no warning, and a green test that proves nothing. Name the toolkit once
and derive its layer from that value.

**Assertions must be able to fail.** This applies to type-level assertions in
particular: write one, break it once, confirm the build fails, restore it.

## Canonical history

- transform is ephemeral
- commits happen once
- steering commit ordering
- tool result ordering
- failed/incomplete turns do not partially commit

## Loop

- no tool calls => stop
- tool calls => continue
- max turns
- compound policies

## Tools

- one call
- multiple parallel calls
- sequential mode if implemented
- tool success
- tool typed failure
- defect
- interruption
- exact lifecycle events

## Steering

Arrival during:

- model wait
- completed model response before tools
- tool execution
- turn boundary

## Follow-ups

Arrival during:

- model request
- tool execution
- final turn before stop
- between runs

## Interruption

During:

- model request
- tool call
- multiple parallel tools
- after turn commit
- before next turn

## Errors

- busy session
- idle steer
- idle follow-up
- closed session
- model failure
- tool failure

## Events

- exact ordering
- sequence monotonicity
- correct IDs
- correct turn index
- no duplicate terminal events

---

# 45. Required Invariants

These should appear in code comments/tests/docs.

## History ownership

> `AgentSession` is the sole owner of canonical conversation history.

## Derived context

> `ContextTransform` never mutates canonical history.

## Single execution

> At most one `AgentRun` executes per `AgentSession`.

## Submission completion

> `prompt()` resolves only after its submission reaches quiescence.

## Steering

> Steering is FIFO and takes effect only at turn boundaries.

## No hidden steering cancellation

> Steering never implicitly interrupts the current turn.

## Follow-ups

> Follow-ups never modify the currently executing run; they schedule later runs under the same submission.

## Tool ownership

> The harness, not Effect AI automatic resolution, owns tool execution.

## Tool lifecycle

> Every started tool call receives exactly one terminal lifecycle event within the live process.

## Turn commit

> A non-streaming turn commits atomically after model generation and tool execution complete according to policy.

## Event order

> Every event receives a monotonically increasing session-local sequence.

## Event stream

> Live events are observational and are not a durability guarantee.

---

# 46. Open Questions That May Be Settled During Implementation

These are intentionally limited. **All six were settled during v0.1**; each is
recorded below with what was decided and why, so the reasoning survives even
though the question is closed.

## 46.1 Tool failure policy — settled

Configurable, defaulting to `ReturnToModel`. See §19.

## 46.2 Defects vs typed failures — settled

Yes, as anticipated. Defects always fail the run; only typed failures are
eligible to be returned to the model. A defect means the handler is broken, not
that the model asked for something the tool could refuse.

## 46.3 Parallel tool failure aggregation — settled, and needs no setting

This turned out not to be an independent question. It falls out of §46.1: under
`ReturnToModel` a typed failure is not an error, so siblings finish; under
`FailRun` the first failure interrupts them, which is ordinary `Effect.all`
behaviour. Adding an aggregation strategy would have been a knob with no
position that the failure policy did not already determine.

## 46.4 Prompt result type — settled

A small structured result:

```ts
interface Result<Tools> {
  readonly submissionId: SubmissionId
  readonly status: "completed" | "interrupted"
  readonly runs: number
  readonly turns: number
  readonly text: string
  readonly response: GenerateTextResponse<Tools> | undefined
}
```

Carrying the final response keeps usage and finish reason available without the
caller reconstructing them from the event stream. `status` is where interruption
surfaces: an interrupted submission is a terminal state reported as a value, not
a failure of the `prompt` call (§23).

## 46.5 Dynamic toolkit resolution — implemented

The instruction was to defer this, and it was implemented anyway. Recorded
plainly because that was a deviation, not a judgement the plan invited.

The justification, assessed after the fact: `ToolkitInput` admits an Effect, the
toolkit is resolved once per turn regardless, and the entire cost is one
`Effect.isEffect` branch. §9 also treats capabilities varying with runtime state
as central to the design. If that reasoning is rejected, removing it is deleting
that branch and narrowing `ToolkitInput` to `Toolkit.WithHandler`.

## 46.6 Streaming — unchanged

Explicitly post-v0.1. Nothing in the implementation weakened this: §24 stands,
and §2.8 adds one more input to that design, since preliminary tool results
arrive on the same stream mechanism that streaming will use.

---

# 47. Post-v0.1 Streaming Design Phase

Only begin after non-streaming invariants pass.

Streaming architecture should answer:

```text
model stream
   │
   ├ live noncanonical events
   │
   └ terminal completed response
          │
          ▼
      canonical commit
```

A promising rule is:

> deltas are observational; only completed messages are canonical.

This would allow interruption mid-stream without committing partial text.

But this requires careful treatment of streamed tool-call parts.

Do not assume this rule is correct until tested.

Potential future events:

```text
MessageStarted
MessageDelta
MessageCompleted
MessageInterrupted
```

---

# 48. Post-v0.1 Extension Validation

After core stabilizes, prove extensibility with small external packages/spikes rather than adding core features.

Recommended validation spikes:

## Memory

Service + ContextTransform + event consumer.

## Sandbox

Service used by a shell tool.

## Subagent

Tool that starts a child session with a different model Layer.

## Persistence

Commit-hook/store prototype that does not rely on live PubSub.

## AG-UI adapter

Convert AgentEvent Stream into a UI protocol.

## Coding toolkit

Read/write/edit/shell tools built outside core.

## Web battery

### Decision and justification

Add a portable `@doeixd/effect-agent/web` battery after the coding toolkit. It
is composed with `/coding`; it is not part of `CodingToolkit` and does not
change the agent core.

```text
Coding or research agent
├─ CodingToolkit → Sandbox.Current → filesystem/process provider
└─ WebToolkit
   ├─ web_search → WebSearch → search-provider Layer → HttpClient
   └─ web_fetch  → WebFetch  → guarded-fetch Layer  → HttpClient
                         │
                         └─ Permission gates each invocation first
```

This is an authorised extension seam, not an OpenCode port. It clears the
public-concept bar for two independent consumers that will be demonstrated in
examples and inference tests:

1. a coding agent which searches for documentation and fetches a selected
   source alongside `CodingToolkit`; and
2. a research/child agent which uses the web battery without filesystem or
   process authority.

It also contains two independently useful operations. Search is a request to a
provider-owned, fixed endpoint; fetch is a request to a model-selected URL and
has a materially stronger security boundary. They share a toolkit namespace,
schemas and presentation conventions, but **not** one all-or-nothing provider
service. Applications may provide and compose either capability without
granting the other.

This section is the design authority for web access and supersedes M6 in
`docs/plan-opencode-tools-port.md` wherever that earlier proposal differs.

### Responsibility boundaries

The three controls are complementary and must not be described as substitutes:

- **Tools** define the model-facing operation and structured input/output.
- **Permission** decides whether this particular invocation may proceed. It is
  semantic policy, not physical isolation.
- **`WebSearch` / `WebFetch` providers** own physical network behavior. Their
  Layers capture an abstract Effect `HttpClient`, configuration, rate limits
  and egress restrictions.
- **`Sandbox`** owns filesystem and process behavior. Web tools do not depend on
  it. Saving fetched content remains a separately permissioned `write_file`
  call rather than a combined network-and-write tool.

The last point matters because one `Permission.Request` projects one action and
one resource. A compound download-and-write tool would hide two authorities
behind one decision and is not part of either milestone.

The local sandbox is explicitly not a network security boundary. A coding
agent with `bash` may still run `curl`, `gh`, a package manager, or another
networked executable. An application requiring real egress isolation must deny
or ask for `shell`, use a network-isolated sandbox provider, or enforce egress
through the host/proxy. Adding `/web` does not change that fact.

The honest invariant is therefore:

> No implementation in `/web` performs network I/O except through its declared
> web capability and an injected Effect `HttpClient`, and no web tool is
> available to an agent unless the application explicitly composes it.

This is a local invariant for the `/web` package, not a claim that an arbitrary
agent has no other route to the network.

### Portable package shape

The portable `./web` entry exports schemas, capability services, ordinary
Effect AI tools and their handlers. Provider adapters remain separate entry
points so importing `./web` performs no configuration lookup and acquires no
network capability.

Planned modules:

```text
src/web/WebSearch.ts       provider-neutral search service, values and errors
src/web/WebFetch.ts        provider-neutral guarded-fetch service, values/errors
src/web/WebToolkit.ts      Search and Fetch tools, handlers and composition values
src/web/brave.ts           Brave search Layer over HttpClient + Config.redacted
src/web/http.ts            guarded generic HTTP fetch Layer over HttpClient
src/web/index.ts           portable public battery
src/testing/...            deterministic canned web providers
```

`WebSearch` and `WebFetch` are infrastructure capabilities, so
`Context.Service` is appropriate. Implementations use `Effect.fn` as the
function definition, return named error unions, and arrive through Layers. The
tools declare those services in `dependencies`; the requirements must flow
through `Agent.toolkit`, `Agent.withTool(s)` and `AgentSession.make` so omitting
a provider is a compile-time error.

The battery exposes its tool values and handlers separately, as `/coding`
does, so callers can take search only, fetch only, replace a handler or bind one
tool without casts. A convenience combined toolkit may be exported only as a
short spelling of those same values; it must not make both provider services
mandatory when the caller selected only one tool.

Provider errors are `Schema.TaggedError`s with derived `message` getters. The
tool failure schema remains `Schema.String` initially and maps service errors
to short, actionable prose the model can respond to. The public Effect error
channel must never widen to `unknown`.

### Permission projection and parameter decoding

Search is annotated as:

```text
action:   net.search
resource: the exact outbound query
```

There is no result domain before a search runs, so projecting a domain would
be fictitious. The query is the sensitive value leaving the application.

Fetch is annotated as:

```text
action:   net.fetch
resource: the canonical URL origin (scheme, hostname and effective port)
```

Neither tool has intrinsic `needsApproval: true`. Explicit composition and
provider wiring enable the capability; the application Permission policy
chooses Allow, Ask or Deny. Deployments may therefore allow public searches,
ask for every fetch, or deny both. The existing intrinsic approval floor still
applies if an application replaces either tool with a stricter one.

Before `web_fetch` lands, `ToolExecution` must resolve an existing contract
mismatch. Model tool calls reach the loop with **encoded** parameters (§33.5),
while Effect AI's dynamic `needsApproval` function and
`Permission.annotate` projection are typed against decoded
`Tool.Parameters<T>`. Today the harness calls both before `Toolkit.handle`
decodes, which is unsound for transformed schemas even though string-only
tools hide it.

The resolution is to decode with the tool's parameter Schema before invoking
dynamic approval or the permission projection:

- valid calls project and evaluate permission from the same decoded value the
  handler will observe;
- invalid calls invoke neither policy nor provider and become the ordinary
  tool-parameter validation failure;
- events, journaling and `Toolkit.handle` retain the encoded model payload
  where their existing contracts require it; and
- projection remains total. A throwing projection is still a tool-author
  defect, never a recoverable policy result.

A transforming-schema test must fail against the old behavior and prove the
fix before the fetch URL schema relies on canonical decoded data. This change
must preserve end-user inference without a new erasing cast.

### Milestone W1 — provider-neutral `web_search`

Ship search first. It supplies most immediate coding/research value while the
model can reach only a provider-owned fixed endpoint, avoiding the arbitrary
URL and redirect surface of fetch.

The provider-neutral domain is intentionally small:

```ts
interface SearchOptions {
  readonly limit?: number
  readonly freshness?: "day" | "week" | "month" | "year"
}

interface SearchResult {
  readonly title: string
  readonly url: string
  readonly snippet: string
}
```

The tool accepts a query, an optional result limit and optional freshness. The
default result limit is 8 and the hard maximum is 10. It does not expose
provider-specific deep-search, automatic mode or other model-selected billing
multipliers. Results are structured and preserve source URLs; provider content
is explicitly described to the model as untrusted external text.

The first real adapter is Brave's ordinary Web Search REST API, not its
provider-specific LLM-context response. It uses no provider SDK. Its Layer:

- loads the API key with `Config.redacted`, never `process.env`;
- requires Effect's `HttpClient` and captures a restricted client whose base
  endpoint is fixed by the provider, never by model parameters;
- sends credentials only in the provider's authentication header and never
  includes them in errors, events or span attributes;
- treats the outbound query as sensitive telemetry. If the provider protocol
  requires it in a URL query string, application trace exporters must be
  assumed to see it until the existing redacting-tracer work is supplied;
- decodes the response through Schema and bounds both advertised
  `Content-Length` and actual streamed bytes to 1 MiB before constructing
  results;
- places one 15-second timeout around request plus body consumption, so fiber
  interruption aborts the underlying request;
- limits the provider to four concurrent searches; and
- uses only a bounded retry Schedule: at most one retry for a pre-response
  transport failure or 429, with `Retry-After` capped at two seconds. It never
  retries authentication, other 4xx, decode or body-limit failures. No Effect
  HTTP default that can retry forever is accepted.

The service error union names transport, authentication, rate-limit, provider
response, decode, response-too-large and timeout failures. The handler maps
them to guidance such as "misconfigured; do not retry", "quota exhausted;
retry later", or "timed out; try a narrower query". Defects remain defects.

No HTML conversion dependency is introduced in this milestone.

#### W1 acceptance

- A no-cast/no-annotation example composes `CodingToolkit` with search, and a
  second example composes search into a research/child agent without Sandbox.
- Tool parameters, results, service requirements and `PromptError` remain
  precise and non-`any`; omitting `WebSearch` fails at compile time. Every new
  inference assertion is deliberately broken once and restored.
- Without explicit composition, existing agents and toolkits contain no web
  tool and require no web provider.
- Allow, Ask and Deny evaluate exactly once; denial never invokes the provider;
  the Permission request carries `action: "net.search"` and the exact query.
- A deterministic fake `HttpClient` proves the fixed endpoint, request shape,
  schema rejection, credential redaction, advertised and actual byte limits,
  bounded retries, concurrency, timeout and interruption without sleeps.
- A canned `WebSearch` Layer supports deterministic higher-level tool, durable
  replay and lifecycle tests. A replayed completed call does not repeat the
  provider request.
- Tool events keep their existing exact lifecycle and the TUI's generic tool
  view renders search without a required TUI change.
- The provider never annotates spans with the API key, response body or search
  result snippets. Search queries are ordinary tool parameters and may be
  visible to a configured tracer under the existing tool-span behavior and in
  an HTTP URL when the provider requires a query string; that privacy
  limitation is documented rather than misrepresented as redaction.
- `npm run check` and packed-entry portability verification pass.

W1 updates `STATUS.md` only after these conditions are built and verified.

### Milestone W2 — guarded `web_fetch`

W2 starts only after W1 is green and the decoded-permission prerequisite above
is proven. It adds arbitrary HTTP(S) retrieval as a separate `WebFetch`
capability and `web_fetch` tool; an application can omit it while retaining
search.

The model supplies a URL only. Initial output is a structured response with
the final canonical URL, HTTP status, media type, body format
(`text | html | markdown`) and body. The default portable provider returns
bounded textual content in its honest format; it does not add a heavy
HTML-to-Markdown dependency or claim that tag stripping is semantic
conversion. Rich conversion and PDF/image extraction are later provider
features, not part of W2.

The guarded provider, not Permission, enforces the network boundary:

- accept only `http` and `https` URLs and reject embedded credentials;
- canonicalize scheme, hostname and effective port before permission;
- reject loopback, link-local, private-address, `.local` and known cloud
  metadata targets whenever the portable runtime can establish them;
- expose redirects rather than relying on an HTTP client that follows them
  invisibly;
- follow at most five same-origin redirects;
- return a typed cross-origin redirect refusal containing the new URL, so the
  model must issue a fresh call and trigger a fresh permission decision;
- accept textual media types only at first (including text, HTML, JSON and
  XML), rejecting binary, PDF and image bodies;
- enforce a fixed 1 MiB maximum on actual bytes delivered after decompression,
  as well as an early `Content-Length` check. The body is streamed and folded
  under the cap; an unbounded `response.text()` is forbidden;
- bound request plus redirects plus body consumption with one 20-second
  timeout; and
- perform no automatic retry. A fetch is an externally observable request and
  retry policy belongs to the caller/provider, not an invisible default.

The service names invalid-URL, denied-target, transport, HTTP-response,
cross-origin-redirect, redirect-limit, unsupported-content-type,
response-too-large and timeout errors. Each error's encoded form contains only
the fields needed to diagnose it and its `message` is a getter. The tool maps
expected failures to actionable model text under the existing tool failure
policy.

Portable code cannot completely defeat DNS rebinding or prove the resolved
address used by every `HttpClient`. The portable guard is therefore baseline
defense, not a strong isolation claim. Environments that require that guarantee
must supply a `WebFetch` provider backed by an egress proxy or a runtime with
address-aware policy. Documentation and examples must say so directly.

Fetched bodies are untrusted model input. The result preserves source URL and
media type, clearly delimits external content, and never treats page text as
harness instructions. Delimiting reduces accidental confusion but is not
presented as a complete prompt-injection defense.

#### W2 acceptance

- The transformed URL schema proves decoded permission evaluation; the
  projection emits the exact canonical origin and never throws.
- Table-driven tests cover invalid schemes, credentials, loopback, IPv4/IPv6
  private/link-local literals, metadata hosts, canonical ports and fragments.
- Redirect tests prove same-origin following, the five-hop cap, cross-origin
  refusal before the second request, and a fresh permission decision when the
  model explicitly calls the redirected origin.
- Deterministic stream tests cover lying/missing `Content-Length`, chunked and
  decompressed overflow, unsupported media types, malformed text, timeout and
  interruption. No test uses a sleep.
- Allow, Ask and Deny gate provider invocation exactly once with
  `action: "net.fetch"`; denial performs no DNS or HTTP work.
- A fetched result can be followed by an independently permissioned
  `write_file`, while no combined fetch-and-write authority is introduced.
- Durable replay does not repeat a completed fetch, exact lifecycle events are
  unchanged, API credentials and bodies do not enter provider spans, and the
  TUI generic fallback remains sufficient.
- Public examples require no casts or hand annotations, all error channels are
  named, no erasing cast is added without satisfying the repository inventory,
  and `npm run check` plus packed-entry portability verification pass.

W2 updates `STATUS.md` only after these conditions are built and verified.

### Explicit non-goals for W1 and W2

- No network capability is added to agent core or `Agent.make`.
- No automatic inclusion in `CodingToolkit` and no new `Agent.make` type
  parameter or configuration field.
- No global claim that Permission or LocalSandbox prevents network access.
- No combined search/fetch/write/browser tool, browser automation, JavaScript
  page execution, login/cookie jar, robots-policy engine, crawling, PDF/image
  extraction or cache.
- No provider-cost accounting in the model token budget. W1 prevents
  model-selected expensive modes and bounds calls locally; a shared tool/API
  cost abstraction waits for two independent consumers.
- No provider A/B selection or ambient environment-variable probing.

Except for the decoded-parameter correction explicitly authorised above, if a
web milestone requires modifying core internals, revisit the extension
boundaries.

---

# 49. Success Criteria

The project succeeds if:

1. The core remains small.
2. It feels like a natural extension of Effect and Effect AI.
3. It does not duplicate Effect abstractions.
4. It owns agent-specific execution semantics clearly.
5. It provides deterministic steering/follow-up/interruption behavior.
6. It provides complete observable tool lifecycle semantics.
7. It preserves canonical history and replayability.
8. Higher-level abstractions can be built independently.
9. Model/provider selection remains ordinary Effect Layer wiring.
10. Tool implementations remain ordinary Effect AI Toolkit handlers.
11. The event stream can support UI/telemetry without becoming a persistence hack.
12. The first implementation does not need streaming, durability, memory, skills, or sandboxing to be useful.

---

# 50. Definition of Done for v0.1

v0.1 is complete when the following program works with a fake model and at least one real Effect AI provider:

```ts
const Researcher = Agent.make({
  instructions: "Research carefully.",
  toolkit: ResearchToolkit,
  loop: AgentLoop.and(
    AgentLoop.untilIdle(),
    AgentLoop.maxTurns(20)
  )
})

const program = Effect.scoped(
  Effect.gen(function* () {
    const session =
      yield* AgentSession.make(Researcher)

    yield* AgentSession.events(session).pipe(
      Stream.runForEach(Effect.log),
      Effect.forkScoped
    )

    const fiber =
      yield* AgentSession.prompt(
        session,
        "Research Effect AI."
      ).pipe(
        Effect.fork
      )

    yield* AgentSession.steer(
      session,
      "Focus on runtime semantics."
    )

    yield* AgentSession.followUp(
      session,
      "Then summarize the API."
    )

    return yield* Fiber.join(fiber)
  })
)
```

And the following statements are all true:

```text
- canonical history has one owner
- transforms are ephemeral
- Effect AI does not auto-resolve tools
- tool lifecycle is fully observable
- tool results are committed by the harness
- only one run executes at a time
- steering waits for a turn boundary
- follow-ups keep prompt() pending until quiescence
- interruption uses structured concurrency
- events are globally ordered within a session
- live events are not mistaken for durability
- no streaming semantics are half-implemented
```

---

# 51. Guidance to the Implementing Agent

When implementing this plan:

1. **Prefer semantic correctness over API polish.**
2. **Do not add abstractions because they seem likely to be useful.**
3. **Do not hide unresolved policy decisions behind arbitrary defaults.**
4. **Write deterministic tests before generalizing an API.**
5. **Use Effect primitives directly wherever they already express the needed semantics.**
6. **Keep `LanguageModel`, tool handlers, and external capabilities in the Effect environment.**
7. **Keep Agent/Loop/Transforms as values.**
8. **Keep Session/Run as scoped runtime values.**
9. **Keep canonical Prompt ownership inside AgentSession.**
10. **Keep automatic Effect AI tool resolution disabled.**
11. **Do not implement streaming in v0.1.**
12. **Do not implement durability in v0.1.**
13. **Do not build memory, skills, sandbox, subagents, or persistence into core.**
14. **Treat new public nouns as expensive.**
15. **If implementation reveals a contradiction in this plan, stop and document the exact semantic conflict before adding a workaround.**

The desired result is not a feature-rich framework.

The desired result is a **small, rigorous, Effect-native agent execution kernel** on which richer frameworks can be built.
