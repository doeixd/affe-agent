# Durable and Distributed Execution — Implementation Plan

## Status

**Implementation-ready plan for packages outside core.**

`PLAN.md` is the design authority for the harness itself and stays unchanged by
this document. `WORKFLOW.md` argued the case for Effect Workflow; this plan is
the executable version of that argument, corrected against what the spikes in
`spike/` actually established.

The governing boundary, restated from `WORKFLOW.md` and PLAN §30.2:

> Core must never require Workflow or Cluster. The same agent definition must
> admit progressively stronger interpretations without being rewritten.

```text
Agent
 ├ embedded    Ref / Queue / Fiber                     ← v0.1, shipped
 ├ persistent  AgentStore
 ├ durable     Workflow / Activity / DurableQueue
 └ distributed Cluster Entity / RPC
```

---

# 1. What the spikes established

These were measured, not assumed. The exploratory spikes have since been
replaced by the implementation and its tests; what they established is recorded
here.

**A submission already runs inside a Workflow with no core changes.** An agent
built with plain `Agent.make` runs inside `Workflow.toLayer` calling plain
`AgentSession.prompt`.

**The model call becomes an Activity by swapping a Layer.**
`LanguageModel.make` takes a provider returning `Array<Response.PartEncoded>` —
already an encodable value — so the activity boundary lands exactly where
persistence needs it. Tools work the same way, by wrapping handlers when the
toolkit is constructed.

**The durable engine is testable without SQL.**
`ClusterWorkflowEngine.layer` composes with `TestRunner.layer`, which has no
dependencies. Every phase below is therefore unit-testable; nothing needs a
database to develop against.

**Concurrent activities complete, including on replay.** effect#6014 was a
replay-path deadlock, so the fresh path alone would have tested the wrong thing.
A suspended submission whose turn ran three parallel tool calls resumes, replays
all three, and each tool executes exactly once in total. That is what lets
durable tool execution keep PLAN §17's unbounded-concurrency default.

## 1.1 Consequences that shape this plan

**`AgentExecution` is not needed.** The interception points a durable
interpreter requires — the `LanguageModel` service and the toolkit's handlers —
are already Layers, and Layers are already the substitution mechanism. Do not
add an execution interface to core. Revisit only if a phase below is blocked by
interception the Layer boundary cannot express.

**`LanguageModel.make` pins its provider's requirements** to `IdGenerator`, so
an `Activity` (needing `WorkflowEngine | WorkflowInstance`) cannot be dropped
in. The workflow context must be captured inside the running workflow and
provided to the activity, which means **the model layer is constructed inside
the workflow body**. The package must own this so users never hand-roll it.

**A defect terminates a workflow permanently.** `Effect.die` is not a crash
simulation: the engine records a terminal failure and re-executing the same
idempotency key returns it. Tests that simulate crashes with defects prove
nothing.

**Resumption is not `Workflow.resume` either.** Calling `execute` again hangs on
an interrupted execution, and `Workflow.resume(executionId)` returns without
re-dispatching the body under `TestRunner` — the execution stays `Suspended`.

The mechanism that does work, and the one the engine is designed around, is
**`DurableDeferred`**: awaiting it suspends the workflow, and completing it from
outside — with only the token, from any process — wakes the execution. A
resumed execution replays its completed activities rather than re-running them,
which is the property everything here depends on. Proven, and now
covered by `test/Durable.test.ts`.

Two corollaries. `Workflow.execute(payload, { discard: true })` is required to
start work that will suspend, since a suspended execution never produces the
result a plain `execute` waits for. And tests must use `it.live`: a resumed
execution continues on the real clock, so a `TestClock` never lets a poll loop
advance.

---

# 2. The central design idea: history is derived, not persisted

This is the most important claim in this plan, and the phase order exists to
falsify it early.

The harness holds canonical history in a `SubscriptionRef`. A durable
interpreter obviously cannot rely on process memory. The tempting conclusion is
that durability requires persisting canonical history — that is, that
`@effect-harness/durable` must depend on `@effect-harness/persistence`.

It does not, and should not.

If every model call and every tool call is an `Activity`, then on replay the
engine returns their **persisted results** instead of re-executing them. The
harness code above re-runs, but every nondeterministic input it consumes is
replayed identically. Canonical history is a pure function of that journal:

```text
activity journal                      canonical history
─────────────────                     ─────────────────
model-turn-1  → parts        ──►      user + assistant
tool-r1-t1-c1 → result       ──►      + tool results
model-turn-2  → parts        ──►      + assistant
```

Rebuilding history in memory during replay is therefore correct, and the durable
package needs no storage of its own. Persistence remains a separate concern for
a different reason — answering *what happened* for a UI or an audit — exactly as
PLAN §29/§30 separate them.

## 2.1 The determinism obligation this creates

The claim holds only while replaying the harness is deterministic given the same
activity results. That is a real constraint, and it is the thing most likely to
break.

Sources of nondeterminism in the current engine, and their status:

| Source | Status |
| --- | --- |
| Run and submission ids | Sequential counters — deterministic |
| Turn indices | Derived from loop iteration — deterministic |
| Model responses | Activity — replayed |
| Tool results | Activity — replayed |
| `Effect.all` ordering of tool results | Results are collected positionally, not by completion order — deterministic |
| **Steering queue drain** | **External input — NOT deterministic** |
| **Follow-up queue drain** | **External input — NOT deterministic** |
| Wall-clock time | Core reads none |
| Event sequence numbers | Derived from a counter — deterministic |

The two queue drains are the problem. `AgentTurn.applySteering` reads whatever
happens to be queued at that instant; on replay the queue is empty and the turn
would derive a different prompt from the one whose model result is being
replayed. History would silently diverge from the journal.

**Therefore: in the durable interpreter, draining steering and follow-ups must
itself be an Activity.** The drained batch is persisted with the turn that
consumed it, and replay returns the same batch.

**Core already provides this seam.** `AgentSession.make` takes an optional
`InputChannel.Factory`, defaulting to in-memory queues (PLAN §16.2). The durable
interpreter supplies one whose `drain` is an Activity over a `DurableQueue`:

```ts
const durableChannels: InputChannel.Factory = {
  make: (sessionId, name) =>
    Effect.map(DurableQueue.make(`${sessionId}:${name}`), (queue) => ({
      offer: (input) => DurableQueue.offer(queue, input),
      size: DurableQueue.size(queue),
      drain: Activity.make({
        name: `${name}-drain-${/* runId:turnIndex */ ""}`,
        success: Schema.Array(Schema.String),
        execute: DurableQueue.takeAll(queue)
      })
    }))
}
```

One wrinkle the implementation must solve: the activity name needs the current
run and turn to be stable across replays, and the channel does not receive them.
Options are a `FiberRef` the engine sets per turn, or widening `drain` to take
the correlation. **Prefer the second if it comes to it** — an explicit argument
beats ambient state — but try the `FiberRef` first, since it needs no further
core change.

This was previously flagged as the one place the Layer boundary might prove
insufficient. It was, and the seam now exists; what remains is verifying it
carries the durable case, not discovering whether it can.

---

# 3. Package structure

```text
@effect-harness/durable        Workflow interpreter for a submission
@effect-harness/cluster        Session as a Cluster Entity, RPC surface
```

They are separate because they answer different questions. Durable asks *where
was computation and what is safe to run again*. Cluster asks *which node owns
this session and how do clients reach it*. Either is useful without the other:
a durable submission on a single node needs no cluster, and a distributed
session with in-memory execution is a valid, cheaper deployment.

`@effect-harness/cluster` may depend on `@effect-harness/durable`. Never the
reverse.

---

# 4. `@effect-harness/durable`

## 4.1 Public API target

```ts
DurableAgent.workflow(agent, options)   // Workflow definition for an agent
DurableAgent.submit(workflow, input)    // start; returns an execution handle
DurableAgent.steer(executionId, input)
DurableAgent.followUp(executionId, input)
DurableAgent.interrupt(executionId)
DurableAgent.result(executionId)        // await terminal result
DurableAgent.layer(...)                 // wiring
```

## 4.2 `prompt` and `submit` are deliberately different

Local `prompt` resolves at quiescence (PLAN §12). A durable submission may
outlive the process that started it, so a blocking call cannot be the primary
API — the caller may be gone before the work finishes.

Do not paper over this. `submit` returns an execution id immediately; `result`
awaits separately. `prompt`-like blocking is then `submit` followed by `result`,
which is honest about what it does.

```ts
const execution = yield* DurableAgent.submit(Researcher, "Research this")
// process may end here
const result = yield* DurableAgent.result(execution)
```

Quiescence keeps its PLAN §12 meaning: the submission is complete when its run
has stopped and no follow-up remains.

## 4.3 Activity identity

Activity names must be stable across replays and unique within an execution.
Derive them from what the harness already produces:

```text
model:{runId}:{turnIndex}
tool:{runId}:{turnIndex}:{toolCallId}
steering:{runId}:{turnIndex}
```

`toolCallId` comes from the provider and is stable within a response, which is
what makes the refund-twice scenario in `WORKFLOW.md` impossible: a replayed
tool call returns its persisted result rather than executing again.

## 4.4 Mapping

| Harness | Durable |
| --- | --- |
| `AgentSubmission` | `Workflow` execution |
| submission id | idempotency key |
| model call | `Activity` |
| tool call | `Activity` |
| steering queue | `DurableQueue` + drain `Activity` |
| follow-up queue | `DurableQueue` + drain `Activity` |
| `interrupt` | workflow interruption |
| approval (future) | `DurableDeferred` |
| scheduled work (future) | `DurableClock` |
| canonical history | derived on replay (§2) |

---

# 5. `@effect-harness/cluster`

## 5.1 Session as an Entity

A session is stateful and single-owner — PLAN §11's "at most one run per
session" is exactly an entity invariant. `Entity.make(type, rpcs)` routes by
entity id, so `AgentSession.Id` becomes the routing key and the cluster
guarantees a single owner per session without the harness adding locking.

```ts
const AgentSessionEntity = Entity.make("AgentSession", [
  Rpc.make("prompt", { payload: { input: Schema.String }, success: ResultSchema }),
  Rpc.make("steer", { payload: { input: Schema.String } }),
  Rpc.make("followUp", { payload: { input: Schema.String } }),
  Rpc.make("interrupt", {}),
  Rpc.make("events", { stream: true, success: AgentEventEnvelopeSchema })
])
```

This is where the out-of-band problem is solved: `steer` arriving for a session
executing on another node is routed to the owning node by the same mechanism as
everything else. It requires no work in core.

## 5.2 The event stream must cross nodes

`AgentSession.events` is an in-process `PubSub` and is documented as
observational (PLAN §28). A remote subscriber needs an `Rpc` streaming endpoint
projecting the same events.

**Already unblocked.** `AgentEvent` and `AgentEventEnvelope` are Schema-defined
in core, with failures carried as `AgentEvent.Failure`
(`{ tag, message, isDefect }`) rather than `Cause` — see PLAN §42.1. The RPC
surface can encode them directly, and this is no longer Phase 6 work.

## 5.3 Scheduled agents

`Singleton.make` and `ClusterCron` give scheduled and recurring agents with no
harness concept at all — no `AgentScheduler`, no `CronAgent`. A cron entry
simply submits a durable agent submission.

---

# 5.4 Implementation status

Shipped as subpath exports rather than separate npm packages —
`@doeixd/effect-agent/durable` and `/cluster`. The architectural requirement is
that core never depends on them, which subpaths satisfy; splitting the repo into
a monorepo buys nothing until they version independently.

| Phase | State |
| --- | --- |
| 0 Durable test harness | done — `DurableDeferred` is the pause point, not fiber interruption |
| 1 Model calls as Activities | done, verified |
| 2 Tools as Activities | done, verified — the refund runs once across a resumption |
| 3 Steering and follow-ups | done, verified — a steer queued during suspension is applied exactly once |
| 4 Interruption | done, verified — an interrupted submission never later completes |
| 5 Single-node production wiring | done, with one residual — see below |
| 6 Cluster entity and RPC | done, verified — sharded submit, steer and follow-up round-trip |
| 7 Approvals and scheduling | done — approvals are the `DurableDeferred` pattern the tests use; `ScheduledAgent` wraps `ClusterCron` |

## What Phase 6 taught

The sharded round-trip initially deadlocked, and the cause was a design error
rather than test wiring: **an entity handler must not block on a workflow.**

A handler occupies the session's mailbox while it runs, and starting a workflow
routes back through the same runner — so `submit` waiting for dispatch had the
two waiting on each other. The handler now derives the execution id (which needs
no dispatch) and forks the execution, so the caller still gets its id
synchronously while the mailbox is released immediately.

This generalises: entity handlers are short, and anything long-running they
start must be forked.

## Resolved: activity failures were unencodable

The `orDie` at the workflow boundary was a symptom, not the disease.

`Activity.make` defaults its error schema to `Schema.Never`. An activity whose
`execute` fails therefore cannot encode that failure, and the engine records an
unencodable `SchemaError` defect in its place. Every tool failure and every
provider failure under the durable interpreter took that path, so the failure
information was destroyed on the way out — a strictly worse outcome than the
`orDie` that was blamed for it.

The fix is to stop letting activities fail. Both the tool and model activities
now carry an **outcome as a value** — `Succeeded | Failed` — and the wrapper
re-raises `DurableToolFailure` / `DurableModelFailure` outside the activity.
Interruption is excluded deliberately: it is the run going away, not a tool
outcome, and persisting it would make an interrupted call replay as failed.

This also makes failures replayable: a tool that failed once fails the same way
on resume rather than running again.

One detail worth keeping: the outcome needs a **real schema**, not
`Schema.Unknown`. Response parts are class instances that `Unknown` cannot
encode, which is why the original code had a parts schema at all. Wrapping them
in an `Unknown` envelope reintroduced the same `SchemaError` from the success
side.

## What remains: surviving a real restart

Phase 5 runs on `SingleRunner` with a SQLite journal on disk, and a submission
suspends and resumes correctly against it — the persisted model result is
replayed rather than re-issued, and the journal is a real file.

One thing is still not demonstrated, and it is the headline durability claim.
Tearing down the runner that started a suspended execution, then resuming from a
second independently built runner over the same database, records the execution
as `Complete` carrying an **`EntityNotAssignedToRunner`** defect. The shard
assignment is lost with the runner, so the execution is terminalised instead of
being left resumable.

That is a deployment concern — shard reassignment on startup — rather than
something the harness or the durable module can fix, and it is not something a
test should stub. So the precise status is:

> Resumption replays persisted work correctly, on real SQL storage, **within a
> runner's lifetime**. Surviving the loss of that runner is unproven.

Closing it means either a runner that reclaims orphaned shards on startup, or a
multi-runner setup where another runner takes the shard over. Until then, do not
claim process-restart durability in user-facing material.

---

---

# 6. Implementation phases

Every phase is unit-testable with `ClusterWorkflowEngine.layer` over
`TestRunner.layer`. No phase requires a database.

## Phase 0 — Harness for durable tests

Build the fixture the later phases assert against: a scripted `LanguageModel`
whose provider is an `Activity`, a toolkit whose handlers are `Activity`s, and a
crash harness that interrupts an execution mid-activity and resumes it with
`Workflow.resume`.

Deliverable: a helper that runs a submission, kills it at a named activity, and
resumes it, recording which activities actually executed.

**This phase is the prerequisite for every claim in this plan.** Until crash and
resume can be simulated deterministically, nothing below can be verified.

## Phase 1 — Model calls as Activities

Wrap the model call; run a multi-turn submission; crash after turn 1; resume.

Tests:

1. the turn-1 activity executes exactly once across both attempts
2. the resumed submission produces the same final result
3. canonical history after resume is identical to history without a crash

Test 3 is the falsification test for §2. If it fails, history is not derivable
and the durable package needs storage.

## Phase 2 — Tools as Activities

Same shape, for tool calls, with the refund scenario as the motivating test.

Tests:

1. a tool interrupted after its side effect does not re-execute on resume
2. parallel tool calls replay correctly — **the effect#6014 path**
3. `ToolExecution.Sequential` and `Parallel` both replay correctly
4. tool failure policy (PLAN §19) behaves identically under replay

If test 2 fails, durable tool execution must default to `Sequential` and the
limitation must be documented rather than hidden.

## Phase 3 — Steering and follow-ups (the risky one)

Implement steering and follow-up queues as `DurableQueue` with drains as
Activities, per §2.1.

Tests:

1. a steer queued before a crash is still applied after resume
2. a steer is applied exactly once across a crash
3. the drained batch on replay equals the batch originally consumed
4. a follow-up queued during a crashed run still extends the submission

**Explicit checkpoint.** The seam exists (`InputChannel`), so the question is
no longer whether interception is possible but whether activity naming can be
made stable — see §2.1. If it cannot without further core change, stop and
report the exact requirement rather than working around it.

## Phase 4 — Interruption and terminal states

Map `interrupt` onto workflow interruption; confirm PLAN §45's terminal-state
invariants hold durably, and that an interrupted submission cannot later
complete.

## Phase 5 — Single-node production wiring

`SingleRunner.layer` with SQL storage; document the `SqlClient` and `Crypto`
requirements. Prove a submission survives an actual process restart, not only a
simulated one.

## Phase 6 — Cluster entity and RPC

The entity, the RPC surface and the remote event stream. `AgentEvent` is already
Schema-defined, so this phase starts at the entity. `Entity.makeTestClient` keeps this unit-testable.

Tests:

1. two concurrent prompts to one session id — one wins, per PLAN §11
2. a steer routed from a different client reaches the owning node
3. a remote subscriber observes the same event sequence as a local one

## Phase 7 — Approvals and scheduling

`DurableDeferred` for human-in-the-loop; `ClusterCron` for scheduled agents.
Both are library-level compositions and neither adds a harness concept.

---

# 7. Risks

**Replay determinism is the whole bet.** §2.1 lists the known nondeterminism;
the unknown ones surface in Phase 1 test 3 and Phase 3 test 3. Order the work so
they fail early rather than after the API is public.

**Activity naming for queue drains** is the known-unsolved detail (§2.1), and
it lands in Phase 3 rather than at the end.

**Concurrent activity replay (effect#6014) is unverified.** It directly affects
PLAN §17's unbounded-concurrency default. Phase 2 test 2 decides whether the
durable interpreter can keep it.

**Workflow and Cluster are unstable modules.** Both live under
`effect/unstable/*` and may change. This is an argument for keeping them out of
core, not for avoiding them.

**Do not promise transparent durability.** Durable execution imposes replay
constraints that ordinary fiber concurrency does not. The promise is that the
harness exposes explicit boundaries that map onto Workflow primitives — not that
arbitrary programs become durable for free.

---

# 8. Non-goals

- No changes to core unless Phase 3 forces one, and then only the minimum.
- No multi-agent orchestration graph. Delegation stays a tool that opens a child
  session (PLAN §35); a distributed version routes that through the cluster.
- No bespoke persistence in the durable package (§2).
- No streaming. It remains deferred in core, and adding it under replay
  semantics before it exists locally would be backwards.

---

# 9. Definition of done

The same agent definition, unmodified, runs in three ways:

```ts
// embedded
yield* AgentSession.prompt(session, "Research this")

// durable
const execution = yield* DurableAgent.submit(Researcher, "Research this")

// distributed
yield* client.prompt({ input: "Research this" })
```

with these true:

```text
- core is unchanged, or changed only as Phase 3 justified in writing
- a crash mid-submission does not re-run completed model or tool calls
- canonical history after resume equals history without a crash
- steering survives a crash and is applied exactly once
- an interrupted submission never completes later
- one session has one owner across the cluster
- a remote subscriber sees the same event order as a local one
```

The first two lines are the ones worth having. The rest follow from them.
