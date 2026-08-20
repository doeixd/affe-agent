Yes. **Seamless integration with Effect Workflow should be one of the strongest reasons for the project to exist.**

But I would preserve one boundary:

> **Effect Harness core should not require Workflow. A durable harness package should be able to reinterpret the same agent semantics using Workflow.**

That gives you:

```text
                     Agent
                       │
                Effect Harness
                       │
            ┌──────────┴──────────┐
            │                     │
     normal execution       durable execution
            │                     │
       Fibers/Scope          Effect Workflow
```

Effect V4 currently exposes Workflow under the unstable Effect modules, alongside persistence, EventLog, RPC, Cluster, etc., so its API can still change. ([GitHub][1])

## The mapping is almost perfect

Our concepts already happen to correspond to durable-workflow concepts:

| Effect Harness         | Effect Workflow                |
| ---------------------- | ------------------------------ |
| `AgentSubmission`      | `Workflow` instance            |
| model invocation       | `Activity`                     |
| tool invocation        | `Activity`                     |
| submission ID          | workflow execution ID          |
| waiting for approval   | `DurableDeferred`              |
| sleep/backoff          | `DurableClock`                 |
| queued external work   | `DurableQueue`                 |
| result schemas         | Workflow success/error schemas |
| canonical commits      | workflow/event persistence     |
| resume after crash     | workflow replay                |
| normal local execution | plain Effect/Fibers            |

Effect Workflow's model is specifically that **Activities are side-effectful units whose results are persisted; on replay their saved results are returned instead of repeating the side effect**. It also provides durable waits, clocks, and queues. ([GitHub][2])

That's almost exactly the machinery agents need.

---

# The most important architectural idea

Don't write a separate "durable agent."

The same:

```ts
const Researcher = Agent.make({
  toolkit: ResearchTools,
  loop: AgentLoop.untilIdle()
})
```

should be runnable in two interpreters.

Ordinary:

```ts
yield* AgentSession.prompt(
  session,
  "Research this"
)
```

Durable:

```ts
yield* DurableAgent.submit(
  Researcher,
  "Research this"
)
```

Conceptually:

```text
                Agent semantics
                      │
                      ▼
          ┌─────────────────────┐
          │ AgentRun / AgentTurn│
          └──────────┬──────────┘
                     │
           execution boundary
           ┌─────────┴─────────┐
           ▼                   ▼

      Local runtime       Workflow runtime

LanguageModel Effect      Model Activity
Tool Effect               Tool Activity
Queue                     DurableQueue
Deferred                  DurableDeferred
Clock                     DurableClock
Fiber                     Workflow execution
```

If this works cleanly, that's a **very strong validation of the core design**.

---

# Model calls should probably become Activities

Suppose a workflow crashes after Claude returned an answer but before the next turn starts.

Without durability:

```text
Claude call
   ↓
process crash
   ↓
restart
   ↓
call Claude again
```

You may get:

* a different output
* duplicate billing
* duplicate model-side effects
* non-deterministic replay

With Workflow:

```text
Model Activity
   ↓
result persisted
   ↓
process dies
   ↓
workflow replays
   ↓
persisted model result returned
```

That gives you deterministic durable execution around an intrinsically nondeterministic service.

Conceptually:

```ts
const response =
  yield* Activity.make({
    name: `model:${runId}:${turnIndex}`,
    execute: LanguageModel.generateText(...)
  })
```

The exact current API may differ, but that's the semantic boundary.

---

# Tools are an even stronger case

Imagine:

```text
send refund
```

Tool executes:

```text
Stripe refunded $500
```

Then your server crashes *before* canonical history records:

```text
refund succeeded
```

Naive replay:

```text
tool runs again
   ↓
another refund
```

Bad.

Durable activity semantics let you make:

```text
ToolCall(run=r4, turn=3, call=abc)
```

a stable activity identity.

```text
first execution
    ↓
refund
    ↓
Activity result persisted

replay
    ↓
lookup result
    ↓
"refund succeeded"
```

rather than rerunning it.

That is considerably stronger than ordinary "persist my chat history."

---

# This also clarifies durability vs persistence

We talked about this before, but Workflow makes the distinction concrete.

### Persistence

```text
What happened?
```

Stores:

```text
messages
events
session metadata
compaction checkpoints
```

### Durability

```text
Where exactly was computation, and what is safe to execute again?
```

Stores things like:

```text
Activity A finished → result X
Activity B has not finished
waiting on external signal Y
timer wakes tomorrow
```

So:

```text
@effect-harness/persistence
```

and:

```text
@effect-harness/durable
```

should remain separate.

The latter can depend on Effect Workflow.

---

# Approvals become particularly elegant

Our in-process design might have:

```ts
const approval =
  yield* Approval.request(...)
```

backed by a `Deferred`.

That's fine until the process restarts.

The durable version can be backed by:

```text
DurableDeferred
```

Conceptually:

```text
Agent
  ↓
tool wants approval
  ↓
DurableDeferred.await
  ↓
process can disappear for three days
  ↓
user clicks Approve
  ↓
DurableDeferred.complete
  ↓
workflow resumes
```

The agent doesn't need to remain in memory.

That's much closer to a production "human-in-the-loop agent" than keeping some server Fiber alive indefinitely.

---

# Follow-ups also map nicely

Current harness:

```text
Queue<FollowUp>
```

Durable runtime:

```text
DurableQueue<FollowUp>
```

Potentially:

```text
Agent submission running

        ↓

user says:
"also test Windows"

        ↓

DurableQueue.offer(...)

        ↓

worker dies

        ↓

new process starts

        ↓

workflow resumes

        ↓

follow-up still exists
```

Again, same semantic concept, stronger interpreter.

---

# Even scheduled agents fall out

With `DurableClock`:

```ts
yield* DurableClock.sleep("24 hours")
```

you could build:

```text
research topic
     ↓
wait a day
     ↓
check for changes
     ↓
wait a day
```

without adding:

```text
AgentScheduler
CronAgent
SleepTool
PersistentTimerManager
```

to your harness.

Workflow owns durable time.

That's exactly the philosophy we've been converging on.

---

# The tricky part: Fibers inside durable workflows

Here I would be careful.

Normal Effect:

```ts
Effect.all([
  agentA,
  agentB,
  agentC
], {
  concurrency: "unbounded"
})
```

has very natural Fiber semantics.

But durable execution imposes **replay constraints**, and not every arbitrary concurrent Effect program can automatically become a deterministic durable workflow.

There have already been concurrency/replay edge cases in Effect Workflow—for example, an issue involving concurrent `Activity.make` calls deadlocking during replay in an older workflow version. ([GitHub][3])

So don't promise:

> "Any Effect Harness program magically becomes durable."

Instead promise:

> **The harness exposes explicit semantic boundaries that can be mapped safely onto Workflow primitives.**

That distinction matters.

Local runtime may freely use:

```text
Fiber
Queue
Deferred
Clock
```

Durable runtime maps selected semantics onto:

```text
Workflow
Activity
DurableQueue
DurableDeferred
DurableClock
```

rather than serializing arbitrary Fiber state.

---

# This suggests an important internal architecture

It might eventually be valuable for the core to define an **execution capability**, but only internally or once the durable implementation proves the need.

For example, conceptually:

```ts
interface AgentExecution {
  readonly modelCall: ...
  readonly toolCall: ...
}
```

Local implementation:

```text
modelCall → ordinary Effect
toolCall  → ordinary Effect
```

Workflow implementation:

```text
modelCall → Activity
toolCall  → Activity
```

But I would **not add `AgentExecution` to v0.1 now**.

First implement the local runtime.

Then build the Workflow spike.

If the durable adapter requires the same interception points repeatedly, *then* extract that interface.

That's a much safer path than guessing the abstraction.

---

# A possible package

I'd eventually expect:

```text
@effect-harness/durable
```

with something like:

```ts
const DurableResearcher =
  DurableAgent.from(Researcher)
```

or perhaps better:

```ts
yield* DurableAgent.submit({
  agent: Researcher,
  input: "Research this"
})
```

and configuration:

```ts
DurableAgent.layer.pipe(
  Layer.provide(WorkflowEngine.layer),
  Layer.provide(AgentStore.layer),
  Layer.provide(...)
)
```

Again, `DurableAgent` would be a higher-level interpreter of the same agent definition.

---

# It could also make remote/distributed execution really interesting

Suppose the parent agent runs on server A.

A child delegation could become:

```text
parent Workflow
      │
      ▼
DurableQueue
      │
      ▼
worker
      │
      ▼
child agent
```

Or perhaps an A2A remote agent interaction becomes a Workflow Activity:

```text
Parent Agent
    ↓
A2A.sendTask
    ↓
Activity
    ↓
remote agent execution
    ↓
result persisted
```

Then your protocol architecture and durable architecture compose:

```text
                 Agent
                   │
             Effect Harness
                   │
       ┌───────────┼───────────┐
       │           │           │
      MCP         A2A       Workflow
       │           │           │
 capabilities   agents      durability
```

That's the kind of combination where using the Effect ecosystem really starts paying off.

---

# Effect Cluster could come later too

You could imagine:

```text
AgentSession
   ↓
Cluster entity
```

where session identity determines placement.

Then:

```text
AgentSession.Id
     ↓
cluster routing
     ↓
node holding session
```

while Workflow provides durable submissions and RPC provides client calls.

Potential future architecture:

```text
Frontend
   │
Effect RPC
   │
Cluster
   │
AgentSession
   │
Workflow
   │
Activities
   ├── LanguageModel
   ├── tools
   └── remote agents
```

All while core Agent code remains:

```ts
Agent.make(...)
```

That's a pretty high ceiling.

---

## This should become a design criterion

I would add this to the project's architecture principles:

> **Agent semantics must remain independent of their execution strength.**

Meaning the same concepts should admit progressively stronger interpretations:

```text
Agent
 │
 ├ embedded
 │   Ref / Queue / Fiber
 │
 ├ persistent
 │   AgentStore
 │
 ├ distributed
 │   RPC / Cluster
 │
 └ durable
     Workflow / Activity /
     DurableQueue / DurableDeferred
```

That gives you **progressive infrastructure**.

A developer can begin with:

```ts
Effect.runPromise(...)
```

and eventually deploy the same conceptual agent into a durable distributed runtime without switching to a different agent framework.

That may ultimately be one of Effect Harness's strongest distinctions from Pi or Flue: not that it has more built-in agent features, but that **Effect already provides a path from a local Fiber to typed RPC, persistence, workflows, and distributed execution within the same programming model**. ([GitHub][4])

[1]: https://github.com/Effect-TS/effect/blob/main/MIGRATION.md?utm_source=chatgpt.com "effect/MIGRATION.md at main · Effect-TS/effect · GitHub"
[2]: https://github.com/mpsuesser/pi-effect-harness/blob/main/harnesses/effect/skills/effect-workflow/SKILL.md?utm_source=chatgpt.com "pi-effect-harness/harnesses/effect/skills/effect-workflow/SKILL.md at main · mpsuesser/pi-effect-harness · GitHub"
[3]: https://github.com/Effect-TS/effect/issues/6014?utm_source=chatgpt.com "@effect/workflow: Effect.all with concurrency > 1 wrapping Activity.make causes deadlock during replay · Issue #6014 · Effect-TS/effect · GitHub"
[4]: https://github.com/Effect-TS/effect/blob/main/LLMS.md?utm_source=chatgpt.com "effect/LLMS.md at main · Effect-TS/effect · GitHub"
