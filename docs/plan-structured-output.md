# Structured output for a session

**Status:** landed. `AgentOutput`, `Agent.make({ output })`, `Result.value`.

## The gap

`PLAN.md` §1 lists structured output among the things Effect AI already
provides, and for a chain that is not agentic that remains true and remains the
right answer: `LanguageModel.generateObject` takes a schema and returns the
decoded value, and no session is needed to hold a single call.

What was missing was the agentic case. A run that uses tools, takes steering and
follow-ups, and is bounded by a loop policy could only end in a `string`. Two
routes existed and both cost something real:

* **Drop to `generateObject`.** Gives up the session entirely — no tools, no
  loop, no steering, no events.
* **Route the value through an `AgentData` channel written by a tool.** Keeps
  the session, but the shape becomes a convention between a tool and whoever
  reads the channel rather than a property of the agent, and the result of
  `prompt` still says nothing about it.

The evaluate step of any evaluator–optimiser loop wants the first thing and the
second thing at once.

## The shape chosen

**An output is a tool the model calls to report its answer.** `AgentOutput.make`
builds it from a schema; `Agent.make({ output })` declares it; the turn injects
it into the toolkit it resolves; `Result.value` is `Option<Value>`.

```ts
const Quality = AgentOutput.make(Schema.Struct({
  hasCallToAction: Schema.Boolean,
  clarity: Schema.Number
}))

const Critic = Agent.make({ instructions: "Evaluate the copy.", output: Quality })

const { value } = yield* AgentSession.prompt(session, copy)
//      ^? Option<{ hasCallToAction: boolean; clarity: number }>
```

Everything else follows from it being a tool:

* the value is what the model **produced**, validated against the schema at the
  provider boundary and decoded by the toolkit;
* it costs **no extra model call**;
* it lands in canonical history as an ordinary call and result, so the answer
  is auditable, replayable and durable exactly as every other call is (the
  *call*, that is — see the boundary below);
* permission, failure policy, streaming and `ExecutionPlan` needed no changes.

## The alternative, and why not

**One `generateObject` over the finished history, after the loop goes idle.**
Rejected on two counts. It bills a second model call per submission, and the
value it produces is a *re-reading of the transcript* that can differ from what
the run actually concluded — a result no turn produced, which is not a result
this kernel can claim its history explains. It also has no good answer for
follow-ups: extract per run, or per submission, and either choice is arbitrary.

## Two decisions worth keeping

**Declared on the `Agent`, not passed per `prompt`.** An agent that must answer
in a shape is defined by that shape: its instructions and its schema are written
together. `stream` is per-prompt because it is a delivery concern; this is a
contract. A per-prompt override can be added later if a second feature needs one
— the scope rule in AGENTS.md, applied to this.

**Stopping is loop policy, not engine.** `withOutputStop` composes onto whatever
loop the agent has: the inner policy is consulted first, and a call to the output
tool turns a `Continue` into a `Stop`. Nothing in `AgentRun` or `AgentTurn`
learns that outputs exist. Without it, `untilIdle` would see a turn that made a
tool call, continue, and spend a model call on a closing remark nobody reads.
`withLoop` and `updateLoop` re-apply the rule, because it belongs to the output
contract rather than to whichever loop object was carrying it.

## The one subtlety

A tool handler runs **before** the turn's atomic commit. A value written
straight into `progress` would therefore be reported by a submission whose turn
was rolled back by an interrupt — an answer the transcript never records the
model giving. So the handler stages the value in `session.pendingOutput`, and
`AgentTurn` promotes it inside the same uninterruptible region as the commit.
`text` and `response` have always followed that rule; this follows them rather
than inventing a second one.

`test/AgentOutput.test.ts` pins it: *a value from a turn that never commits is
not reported*.

## Known boundary: the value is local to the session

`Result.value` does not cross the remote or the durable boundary.
`AgentClient`'s `RemoteResult` and `DurableSubmission`'s `Outcome` are fixed
schemas shared by every agent, and carrying a value through one means deciding
how the caller names the schema to decode it with -- a typed-remote-output
feature, not a field. Until then, a remote or durable caller reads the answer
out of history, where the tool call and its result are recorded in full.

The claim that survives unchanged is the one about the *call*: it is committed,
journaled and replayed exactly as every other tool call is.

## Deliberately open: a stale value across runs

A follow-up starts a second run under the same submission. If that run answers
in prose without calling the output tool, the submission still reports run one's
value. That is consistent with `text`, which behaves the same way and for the
same reason -- the result reports what landed, not what the last run happened to
produce -- but a caller cannot distinguish "this answers the follow-up" from
"this answered the original prompt". Making the value per-run would need a
per-run result, which the surface does not have.

## What is deliberately not tested

A malformed report. The scripted model validates a call's parameters against the
toolkit's schema before emitting it, exactly as a real provider validates against
the tool schema it was given, so an ill-shaped report cannot be produced at all.
That is the point of the output being a tool — the shape is enforced at the
provider boundary, and there is no post-hoc decode step of this library's own to
regression-test.
