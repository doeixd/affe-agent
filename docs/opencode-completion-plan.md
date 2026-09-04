Mostly yes. The last response contains the **architecture, the important Effect v4 substitutions, the new semantics, lifecycle rules, permission model, persistence boundaries, implementation order, and the key invariants** an agent would need to make good design decisions.

The detailed, tree-annotated revision of this brief is
[effect-plan-2.txt](./effect-plan-2.txt) (what already ships, closed
evaluations, related plans, and what to implement first).
[remaining-work.md](./remaining-work.md) still lists this architecture as
hard / not this pass.

I would not hand it to an autonomous coding agent completely unchanged, though. It is a very good **design brief**; to make it an implementation brief, I’d append a short section making a few things non-negotiable.

The agent should understand that the target architecture is:

```text
Agent / AgentSession / AgentClient
        │
        ├── normal interactive execution
        │
        └── session.submit(...)
                ↑
                │
          SessionInbox
                ↑
      durable/background completion


BACKGROUND COMPUTATION

local Effect      → Fiber / FiberMap
trusted JS        → Effect Worker
OS process        → Effect ChildProcess + ProcessManager
durable handoff   → PersistedQueue
durable wait      → Workflow + DurableClock
durable worker    → DurableQueue
recurrence        → Schedule / ClusterCron


MANAGEMENT

SessionDirectory
SessionProjection
ProcessManager
WorkspaceManager
host-wide events
```

The main new affe-agent semantics are only:

```text
SessionInbox
idempotent session.submit()
ProcessManager identity/management
stable workspace lifetime
SessionDirectory/read model
host-wide events
normalized model-usage events
```

Everything else should aggressively reuse Effect.

## What I would append before handing it off

### 1. Explicit non-goals

The implementation agent should **not** create:

```text
BackgroundTask
BackgroundExecutor
TaskRuntime
MonitorRuntime
WorkerPool abstraction
custom queue framework
custom scheduler
custom process primitive
custom durable timer
custom deferred
custom retry framework
```

unless a concrete semantic gap is demonstrated first.

In particular:

```text
ProcessManager ≠ process implementation
```

It is a management layer over Effect's process facilities.

And:

```text
SessionInbox ≠ another queue framework
```

It should use Effect Persistence.

### 2. `session.submit()` is probably the first architectural prerequisite

The agent should implement this before the inbox.

Desired semantics:

```ts
const receipt = yield* session.submit(input, {
  requestId: "process:abc:exit"
})
```

returns after the work has been **durably/admittedly accepted**, not after the model finishes.

```ts
interface SubmissionReceipt {
  readonly submissionId: SubmissionId
}
```

Then:

```ts
session.prompt(input)
```

can conceptually remain:

```ts
const receipt = yield* session.submit(input)
return yield* session.await(receipt.submissionId)
```

It doesn't necessarily have to literally be implemented that way internally, but the semantics should line up.

Most importantly:

```text
same requestId + same request
    → same SubmissionReceipt

same requestId + different request
    → conflict
```

Without that, reliable ping-back is impossible.

### 3. `SessionInbox` should be boring

Its job is only:

```text
persist future session input
        ↓
retry delivery
        ↓
dedupe
        ↓
submit when session can accept it
```

Not:

```text
run agents
schedule timers
understand processes
understand monitors
understand workflows
```

Those systems merely write into it.

Something like:

```ts
interface SessionInbox {
  enqueue(item: InboxItem): Effect<void>
}
```

backed by `PersistedQueue`.

### 4. Default ping-back semantics must be explicit

The implementation should follow:

> A background ping is a new future submission to the target logical session.

Not:

> Whatever submission happens to be running receives a follow-up.

That avoids race-dependent conversational meaning.

If later we support:

```ts
{
  target: {
    sessionId,
    submissionId
  }
}
```

then attaching to a particular submission can be deliberate.

### 5. Workspace lifetime needs solving before long-lived processes

This is easy to miss.

Do not implement:

```text
start process in temporary sandbox
return process ID
sandbox scope closes
workspace disappears
```

A managed process must hold/reference its workspace lifetime.

I would explicitly ask the agent to investigate using:

```text
LayerMap<WorkspaceId, WorkspaceServices>
```

or `RcMap`, so the workspace can be retained independently by:

```text
session
process
monitor
other service
```

and released only after nobody needs it.

### 6. ProcessManager should have one strong invariant

> **A ManagedProcess handle does not own process lifetime. ProcessManager does.**

Therefore:

```ts
const p = yield* processManager.start(...)

// caller scope disappears
```

does not kill it.

But:

```text
ProcessManager's own layer shuts down
```

should clean up locally-owned processes.

Use `FiberMap<ProcessId>` for supervision unless testing proves another Effect primitive is better.

### 7. Do the ChildProcess migration as a semantic spike first

The current sandbox implementation contains meaningful process-tree behavior.

Before replacing it with Effect's current `ChildProcess` APIs, create tests for:

```text
grandchild survives parent
grandchild holds stdout open
timeout
fiber interruption
SIGTERM → SIGKILL
Windows tree termination
output limits
```

Then see whether Effect gives equivalent guarantees.

If yes:

```text
delete custom plumbing
```

If no:

```text
retain only the missing tree-kill adapter
```

Do not casually regress those guarantees for architectural purity.

### 8. Scheduling refactor should be careful

The existing custom `JobStore` is now suspicious because Effect `PersistedQueue` provides substantially richer queue semantics.

But don't replace every timing primitive with a queue.

The agent should use this table:

| Requirement                      | Use                         |
| -------------------------------- | --------------------------- |
| Retryable durable handoff now    | `PersistedQueue`            |
| Local delay                      | `Effect.delay` / `Schedule` |
| Durable workflow delay           | `DurableClock`              |
| Parent workflow waits for worker | `DurableQueue`              |
| Local recurrence                 | `Schedule`                  |
| Cluster recurrence               | `ClusterCron`               |
| Keyed local background work      | `FiberMap`                  |

### 9. Do not add `Monitor` yet

This should be an explicit instruction.

Implement **recipes first**:

```text
process watcher
    ProcessManager.events

local watcher
    Effect.repeat + Schedule + FiberMap

finite durable monitor
    Workflow + Activity + DurableClock

perpetual durable monitor
    ClusterCron + persistent observation state

completion
    SessionInbox
```

Only introduce `/monitor` after actual applications reveal shared missing semantics.

Likely future semantics would be:

```text
MonitorId
target session
definition
enabled/paused
last observation
state
```

not execution itself.

### 10. Permissions belong at creation/mutation boundaries

Tell the implementation agent to preserve:

```text
Permission → Elicitation → capability
```

For example:

```text
monitor.create
process.start
process.write
process.signal
process.stop
```

A monitor approved to query endpoint X every minute does not ask again every minute.

The authorization applies to the monitor definition.

Changing its authority requires another permissioned mutation.

Likewise a process doesn't re-request approval for every stdout byte.

### 11. Add background correlation metadata

This is one small thing I would explicitly add to the design brief.

All background-owned resources should carry enough correlation to answer:

```text
who created this?
where should it report?
```

For example:

```ts
interface Origin {
  readonly sessionId?: SessionId
  readonly submissionId?: SubmissionId
  readonly toolCallId?: string
}
```

Then:

```ts
ProcessInfo {
  ...
  origin?: Origin
}
```

and future:

```ts
MonitorInfo {
  ...
  origin?: Origin
}
```

This should be metadata, not lifetime ownership.

The process should survive the originating tool call.

### 12. Background events should remain observational

Another explicit invariant:

```text
ProcessExited
MonitorChanged
JobCompleted
WorkerFailed
```

do **not** enter canonical history merely because they happened.

Only:

```text
SessionInbox delivery
```

creates new canonical agent input.

That separation is important.

### 13. Management-plane query model stays separate

The agent should implement:

```text
SessionDirectory
SessionProjection
```

without polluting:

```text
AgentSession
AgentClient
```

with administrative methods.

Similarly, ProcessManager can have its own query API.

A future OpenCode-like server becomes composition over these services rather than the reason the kernel grows.

### 14. Prefer Effect's keyed resource primitives

One general implementation rule I'd add:

```text
keyed fibers      → FiberMap
keyed scoped layers/resources → LayerMap / RcMap
queue work        → PersistedQueue
durable queue work → DurableQueue
timers            → Schedule / DurableClock / ClusterCron
OS process        → ChildProcess
trusted worker    → Worker
```

The agent should justify any new lower-level registry/map/worker loop before writing one.

### 15. Final acceptance scenario

I'd give the coding agent this end-to-end test because it proves the architecture actually works:

```text
1. User asks agent:
   "Start the test suite in the background and tell me when it finishes."

2. Tool permission:
   process.start("npm test") → Ask

3. User approves.

4. ProcessManager starts the process in workspace W.

5. Tool returns ProcessId immediately.

6. Agent responds to user and becomes idle.

7. Original HTTP connection closes.

8. The process continues.

9. Server restarts where supported by the chosen process backend,
   or local process is correctly marked Lost.

10. Process finishes.

11. Exactly one inbox item is written:
    process:{id}:exit

12. Inbox delivery calls:
    session.submit(..., { requestId })

13. Crash after submission admission but before inbox ACK.

14. Inbox retries.

15. Same SubmissionReceipt is returned;
    no duplicate agent turn occurs.

16. Agent receives:
    "Background tests completed with exit code 1..."

17. It optionally reads ProcessOutputLog.

18. Agent decides what to do.

19. SessionDirectory reports:
    updated submissions / turns / tool usage / token usage.

20. Host/global event stream exposes the lifecycle throughout.
```

If that works correctly, then most of the harder delegated-task architecture works.

So: **yes, the previous answer contains the design.** I would append the points above because they turn it from “the architecture we want” into **instructions an autonomous implementation agent is much less likely to misinterpret**.

The largest additions are really just: make `submit()` semantics extremely explicit, solve workspace retention before processes, add origin/correlation metadata, and give the agent a concrete end-to-end acceptance test.
