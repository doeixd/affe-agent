# Plan: `ExecutionPlan` — provider fallback as a combinator

Eighth in the series, and the first to come out of
[audit-effect-ecosystem.md](./audit-effect-ecosystem.md) rather than out of
reading another project. It is E1 / A-3: the one item that audit found which is
a **missing capability** rather than a hardening of one.

## Goal

Let an agent fall back from one model to another — a different provider, a
smaller model, a second region — without the `Agent` naming any of them, and
without every user writing the same retry ladder by hand.

## Why this is a gap and not a nicety

The library's stated invariant is that *the model arrives through the
environment; an `Agent` never names a provider.* `AgentSession.make` requires
`LanguageModel.LanguageModel` and gets it from the context it was built in
(`AgentSession.ts:213`). That is the right design and it answers exactly one
question: **which** model.

It does not answer the question immediately after it — what to do when that
model is rate-limited, overloaded, or down. Today the answer is "the run
fails", and a user who wants better writes the fallback themselves, outside the
harness, around a session they have already built. That is the shape of a
missing primitive: everyone needs it, nobody can express it in our vocabulary,
so everyone reimplements it slightly differently.

`effect/ExecutionPlan` is the ecosystem's answer and we have never imported it.
A plan is *ordered fallback steps*, each providing a `Context` or `Layer` and
optionally carrying `attempts`, a `while` predicate and a `schedule`
(`ExecutionPlan.ts:206`). A step that provides a `LanguageModel` layer is
precisely a "try this model next".

## The constraint that decides the design

**A plan must wrap the model call, and nothing wider.**

This is the whole design, so it is worth being explicit about why. A turn is a
model call *and the tool calls it asked for*. If a plan wrapped the turn, then a
failure after tools had run would retry the turn on the next model — and re-run
the tools. Tool calls are side effects on the world: a file written twice, a
payment attempted twice. Retrying them because a *different* part of the turn
failed is not fallback, it is a bug.

The same argument rules out wrapping the run, the submission or the session,
more strongly each time.

So: the plan wraps `LanguageModel.generateText` / `streamText` inside
`AgentTurn`, and only that. Every step is an alternative answer to "produce the
next assistant message"; nothing downstream of that message is inside the plan.

A useful consequence: because the plan covers a *pure* call to a provider,
retrying it is safe by construction. The harness's own guarantees — atomic turn
commit, the lifecycle event ordering, canonical history — are untouched,
because none of them has happened yet when the plan is still choosing.

## Design

```ts
const plan = ExecutionPlan.make(
  { provide: Anthropic, attempts: 2, schedule: Schedule.exponential("200 millis") },
  { provide: OpenAi }
)

const agent = Agent.make({ toolkit, loop }).pipe(
  Agent.withExecutionPlan(plan)
)
```

**A combinator, not a tenth type parameter.** AGENTS.md §42.1 is explicit that a
cross-cutting concern is a `withX`, and this is the case it was written for.
`withExecutionPlan` follows `withPermission`'s shape exactly
(`Agent.ts:587`) — take the definition, return a definition, union the
requirements.

**It discharges `LanguageModel` rather than requiring it.** This is the one
place the signature is interesting. Every step in the plan *provides* a model,
so an agent carrying a plan no longer needs one from its environment:

```ts
withExecutionPlan: <Provides>(plan: ExecutionPlan<{ provides: Provides, ... }>) =>
  <Tools, E, R>(agent: AgentDefinition<Tools, E, R>) =>
    AgentDefinition<Tools, E, Exclude<R, Provides>>
```

and `AgentSession.make` on such an agent should stop demanding
`LanguageModel.LanguageModel`. That is the property that makes this worth
having rather than merely possible: the agent still names no provider, and the
*plan* — supplied at the edge, like a layer — names all of them.

Whether the exclusion can be expressed without a cast is **the first thing to
find out**, and it is P0 below. If it cannot, the honest fallback is that a
planned agent still declares `LanguageModel` and the plan overrides it, which
is weaker but not wrong.

## Streaming is the hard part

`Stream.withExecutionPlan` exists (`Stream.ts:9699`), so the mechanism is
there. The problem is not the mechanism.

Our streaming path emits `MessageStarted`, then `MessageDelta` per chunk, as
the stream runs. If a stream fails *after* deltas have been emitted and the plan
falls back to another model, the observer has already seen part of a message
that is now never going to be completed — and is about to see a second
`MessageStarted` for the same turn. Anything rendering those deltas has painted
text that the transcript will not contain.

Three options, and this plan does not pretend the choice is obvious:

1. **Fall back only before the first delta.** A `while` predicate that refuses
   to retry once output has been observed. Simple, honest, and it gives up
   exactly the cases where fallback is least likely to help (a provider that
   died mid-stream is usually not going to be rescued by a retry that starts
   over anyway). *Recommended default.*
2. **Emit a `MessageInterrupted` before falling back**, so the observer is told
   the partial message is void. Uses an event that already exists and already
   means "this message will not be completed". Costs a decision about whether
   that event's meaning stretches this far.
3. **Buffer deltas until the stream completes.** Correct and unacceptable: it
   turns streaming into batching, which is the one thing streaming exists to
   avoid.

**Recommend 1, with 2 available behind an option.** Settle it in P0 rather than
discovering it in a milestone.

## What this does *not* solve, contrary to the audit

The audit claimed `/budget` gains "a principled seam on which to hang *this run
has spent enough — step down to a cheaper model*." **That was wrong**, and the
correction belongs here rather than being quietly dropped.

An `ExecutionPlan` is *failure-driven*: it moves to the next step because the
current one failed. Budget-driven model choice is a *policy decision taken
before the call*, when nothing has failed at all. The `while` predicate does not
help — it decides whether to keep trying after an error, not which model to
start with.

Budget-driven selection is a different mechanism and a smaller one: a
`LanguageModel` layer built from an effect that reads `Budget` and returns the
cheap or the expensive model. That is `Layer.unwrap` over ordinary wiring, needs
no new API, and should be an example rather than a feature. Worth writing down
so nobody goes looking for it in a plan.

## Interaction with `/durable`

A durable run journals each model call as an activity (`DurableModel`), and the
journal records the **outcome**, not the path taken to it. So a plan that
falls back on the first execution and is replayed later replays the recorded
outcome and never consults the plan again — which is correct, and is the same
property that makes replay deterministic in the first place.

Two things follow, both worth stating in the docs rather than discovering:

- **Which step won is not journalled.** A replayed run cannot tell you it used
  the fallback. If that matters to an operator it belongs in telemetry, which
  is emitted live, not in the journal.
- **`attempts` and `schedule` are wall-clock policy inside one activity.** A
  plan with generous retries makes an activity take longer; it does not make
  the workflow retry. That is the right split, but a user who sets
  `attempts: 50` and wonders why their durable run is slow deserves the
  sentence.

## Observability

`Effect.withExecutionPlan` takes an `onEvent` handler receiving `AttemptStart`,
`AttemptSuccess` and `AttemptFailure`, each carrying `stepIndex`, `attempt` and
a duration (`ExecutionPlan.ts:391`). That is exactly the data an operator wants
and we now have somewhere to put it: A-2 added metrics over the event stream,
and A-0 gave spans and events one attribute vocabulary.

Recommend a counter attributed by step index and outcome — *how often are we
falling back, and to what* is the question a fallback ladder exists to make
answerable. Deliberately **not** a new `AgentEvent`: the kernel vocabulary has
not grown in this library's history without a fight, and a fallback is an
infrastructure fact rather than something the conversation did.

## Invariants

**X1 — A plan never re-runs a tool.** Fallback is confined to producing the
assistant message; nothing that has already acted on the world is inside the
retried region. Tested by failing a model *after* a tool call has committed and
asserting the tool ran exactly once.

**X2 — A planned agent names no provider.** The `Agent` value is unchanged;
every model in the ladder is named by the plan, which is supplied at the edge.

**X3 — Fallback is invisible to the transcript.** Canonical history after a
run that fell back is byte-identical to the same run that succeeded first time,
given the same final message. Which provider answered is telemetry, not
conversation.

**X4 — No partial message is left dangling.** An observer never sees deltas of
a message that the transcript will not contain, under whichever streaming
policy is chosen.

**X5 — Inference is not paid for.** `Agent.make` gains no type parameter, and a
planned agent's tool types, error channel and handler parameters are exactly
what they were. Asserted in `examples/typed-agent.ts` the way the rest are.

## Milestones

### P0 — Settle two questions, in writing ✅

**1. Can `LanguageModel` be discharged without a cast? — Yes.**

`AgentDefinition` gained a fourth type parameter, `Model`, defaulting to
`LanguageModel.LanguageModel`; `withExecutionPlan` sets it to
`Exclude<Model, Types["provides"]>`, and `AgentSession.make` requires
`Scope | Model | R` instead of hard-coding the model. Because the parameter is
defaulted, **all fifty existing `AgentDefinition<Tools, E, R>` references
compiled untouched**, and `Agent.make` still carries nine parameters.

The first signature *did* compile and was still wrong, which is the
"compiling is not proof" rule earning its place. Naming only `provides` and
widening the rest to `any`:

```ts
plan: ExecutionPlan.ExecutionPlan<{ provides: Provides, input: any, error: any, requirements: any }>
```

reads as more permissive and is in fact **stricter** — `ExecutionPlan` is
invariant in those slots, so a real `ExecutionPlan.make(...)`, which infers
`input: unknown, error: never`, is not assignable. The combinator would have
shipped compiling and impossible to call. Being generic over the whole `Types`
object fixes it.

**2. Which streaming policy? — Option 1, and Effect already ships it.**

`Stream.withExecutionPlan` takes **`preventFallbackOnPartialStream`**, whose
documented behaviour is *"a failing step can fallback even after emitting
elements; set this to fail instead of mixing partial output with a later
fallback"* — which is option 1 exactly. So this is a policy we **declare**
rather than a mechanism we build, and the deferral in X1 lasted one milestone.

Two things about it worth knowing rather than discovering:

- It is **slightly more conservative than strictly necessary**. The option
  counts any emitted *stream part*, while we emit a `MessageDelta` for only
  some of them — so a part that produced no delta still blocks the fallback.
  For a rule whose entire purpose is "do not mix partial output with a retry",
  erring that way is the right direction.
- A provider reporting an error **inside a well-formed stream** (an error
  part, `TestLanguageModel`'s `streamError`) is *not* a fallback trigger. That
  failure is raised in `AgentTurn`'s fold, downstream of the wrapped stream, so
  the plan never sees it. Arguably it should — but by the time an error part
  arrives, output has usually been emitted and the policy above would refuse
  the fallback anyway. Recorded rather than fixed.

### X1 — The combinator, non-streaming ✅

`Agent.withExecutionPlan`, the model call wrapped in `Effect.withExecutionPlan`,
`generateText` only.

Three tests (`test/ExecutionPlan.test.ts`). The one that matters is X1's
invariant, and it is arranged so the failure lands *after* a tool has run: the
primary answers the first model call with a tool call, then fails the call that
would read the tool's result. **A plan around the turn would re-run the tool;
this asserts it ran once.** Falsified by removing the wrapping entirely — two
of the three fail.

One cast was added, in `TestLanguageModel.failingAfter`. A test needed a
provider that answers once and then fails, and **test code counts as user
code**, so the cast belongs in the one place licensed to hold it rather than in
the test that wanted it. `test/Casts.test.ts` caught it and refused to pass
until AGENTS.md recorded it — which is A-11 doing exactly its job.

### X2 — Streaming ✅

`Stream.withExecutionPlan(plan, { preventFallbackOnPartialStream: true })`
around the `streamText` stream, inside `streamResponse` — so `MessageStarted`,
which is emitted once before the stream runs, sits *outside* the plan. A
fallback before any output is therefore invisible to an observer: one message,
completed by whichever step answered.

The test asserts that directly (X4): a streamed run whose primary fails falls
back, and emits **exactly one** `MessageStarted` with deltas following. Two
would mean a viewer saw a message begin, then begin again. Falsified by
removing the wrapping.

The after-output case is *forbidden* rather than handled, which is the whole
point of the flag — so there is no behaviour of ours to test there, only a
policy to state.

### X3 — Telemetry ✅

`agent_model_attempts`, a counter attributed by **step** and **outcome**, fed
from `onEvent` on both the batch and streaming wrappings.

It is defined in `internal/telemetry.ts` rather than in `/observability`, for
the reason A-0 established: the kernel produces it -- a plan runs inside
`AgentTurn` -- and a battery cannot be imported by the thing it is built over.
`/observability` re-exports it in `instruments`, so it is read like the rest.

`AttemptStart` is ignored, because every start is followed by a settle and
counting both would double every attempt.

One inference detail worth recording: the handler is generic in the failure
type. Typing it `Event<unknown>` pins what `withExecutionPlan` infers the
plan's error channel from, widening the whole call's `E` to `unknown`.

### X4 — Documentation and one example ✅

`examples/execution-plan.ts`: two rungs, a retry schedule on the first, and the
budget-driven-selection note showing what a plan *is not* for.

**The example nearly shipped with a false claim.** It said "without the plan
this program would not compile" -- and removing the combinator changed nothing,
because an exported `Effect` may carry requirements nobody has met yet. So the
file would have compiled just as happily with `LanguageModel` sitting
unsatisfied in `R`, while claiming the opposite.

The fix is a compile-time assertion in `typed-agent.ts`'s style, naming `R`
directly:

```ts
export type _NeedsNoModel = Assert<[Requirements] extends [never] ? true : false>
```

Removing the combinator now fails with *"Type 'false' does not satisfy the
constraint 'true'"*. This is the "compiling is not proof" rule applying to an
*example* rather than to library code -- the demonstration needed an assertion
for the same reason the library does.

## Success conditions

- **XS1:** An agent whose primary provider fails every call completes its run on
  the fallback, with a transcript identical to one produced by the fallback
  alone.
- **XS2:** A tool called in a turn whose *model* later fails runs exactly once.
- **XS3:** `Agent.make` still has nine type parameters, and
  `examples/typed-agent.ts`'s inference assertions are unchanged.
- **XS4:** `npm run check` clean; `test/Casts.test.ts` unchanged unless P0
  concluded a cast is needed, in which case AGENTS.md records it.

## Non-goals

Choosing a model by cost, latency or quality (see above — a layer, not a plan).
A model registry, a router, or anything that inspects a prompt to pick a
provider. Retrying tool calls. Cross-*turn* fallback. Any change to
`AgentLoop`, `ContextTransform` or the event vocabulary.
