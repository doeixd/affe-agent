# Spike: durable execution via Effect Workflow

Not part of the published package. Run with `npx vitest run spike/`.

`WORKFLOW.md` argues that the harness should not require Workflow, and that a
durable package should reinterpret the same agent semantics using it. This spike
tests the load-bearing half of that claim.

## The question

> Can the same agent definition be reinterpreted durably, without the harness
> knowing durability exists?

If it cannot, the durable package needs an interception interface — the
`AgentExecution` idea WORKFLOW.md floats and then, correctly, defers. If it can,
the harness's existing dependency-injection boundaries already *are* the
interception points, and no such interface is needed.

## What the spike establishes

**An agent submission runs inside a Workflow with no core changes.** The agent
is built with plain `Agent.make`, the session with plain `AgentSession.make`,
and neither mentions Workflow. `AgentWorkflow.toLayer` simply calls
`AgentSession.prompt` in its body.

**The model call becomes an Activity through the `LanguageModel` layer.** This
is the important structural result. `LanguageModel.make` takes a provider
function returning `Array<Response.PartEncoded>` — already an encodable value —
so the activity boundary lands exactly where persistence needs it. Swapping the
provided `LanguageModel` layer is enough; nothing above it changes.

The same technique applies to tools: a durable package wraps the toolkit's
handlers when constructing it, rather than asking the harness for a hook.

**Concurrent activities complete.** A turn executes its tool calls with
`Effect.all` at unbounded concurrency (PLAN §17). WORKFLOW.md cites
[effect#6014](https://github.com/Effect-TS/effect/issues/6014), where concurrent
`Activity.make` deadlocked during replay, which would force durable tool
execution to abandon that default. Four concurrent activities complete normally
here on `4.0.0-rc.111`. See the caveat below.

## Friction worth knowing before building the package

**`LanguageModel.make` pins its provider's requirements.** The provider function
is typed `(options) => Effect<Array<PartEncoded>, AiError, IdGenerator>`, so an
`Activity` — which needs `WorkflowEngine | WorkflowInstance` — cannot simply be
dropped in. The fix is to capture the workflow context inside the running
workflow and provide it to the activity, which means **the model layer must be
constructed inside the workflow body**, not passed in from outside. Workable,
and worth encoding in the durable package's API so users never do it by hand.

**A defect terminates a workflow permanently.** Simulating a crash with
`Effect.die` does not exercise replay: the engine records a terminal failure,
and re-executing the same idempotency key returns that same failure. A defect is
a bug, not a lost process — the distinction matters when writing these tests.

**Resumption is not "call `execute` again".** After interrupting an in-flight
execution, re-executing the same idempotency key hangs rather than resuming. The
engine exposes `Workflow.resume(executionId)` for that, and validating it
properly needs a durable engine rather than `WorkflowEngine.layerMemory`.

## What is therefore still unproven

The headline durability claim — *a process dies mid-submission, restarts, and
the persisted model result is returned instead of the model being called
again* — is **not** demonstrated here. It requires a persistent engine and the
resume path.

The concurrency result carries the same caveat: it covers fresh execution, not
the replay path that #6014 was actually about.

Both are the first things the `@effect-harness/durable` package should prove.

## Conclusion for the core

No change to the core is justified by this spike, which is the outcome
WORKFLOW.md and PLAN §30 both predicted. The interception points that a durable
interpreter needs — the `LanguageModel` service and the toolkit's handlers — are
already Layers, and Layers are already the harness's substitution mechanism.

`AgentExecution` should stay unbuilt until a durable implementation demonstrates
it needs interception the Layer boundary cannot express.
