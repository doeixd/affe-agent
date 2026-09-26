# Architecture

Written 2026-09-26 from a read of `src/` at `add04a3`. This is the one
document that describes how the parts fit together. Each part has its own
guide or plan, linked from its section. [`PLAN.md`](../PLAN.md) holds the
decisions and their arguments, and this document states their outcome. For
"which module do I need", see [`MODULES.md`](./MODULES.md). For what is true
and measured today, see [`STATUS.md`](../STATUS.md).

The claims in this document that name a mechanism carry `verify:` lines, and
`npm run verify:remaining-work` runs them (see `scripts/verify-remaining-work.mjs`).
If a mechanism moves, the build fails until this text moves with it. The file
paths below are stable. Line numbers are left out on purpose, because they drift.

---

## 1. What the system is

Effect AI can already talk to a model: `LanguageModel`, `Prompt`, `Tool`,
`Toolkit` and the providers. Effect supplies the rest of the runtime: fibres,
scopes, layers, queues, streams, `Schema` and tracing. What neither provides is
**agent execution semantics**:

- what a conversation is;
- when a model is called again;
- when input that arrives mid-run takes effect;
- what a tool call may do and who approves it;
- what an observer sees;
- what survives a crash.

This library is that layer, and nothing else.

```text
 product / framework   coding agents · memory · skills · sandbox · subagents · UI · durable hosts
        │
 affe-agent kernel     session · submission · run · turn · loop · events · tool execution
        │
 Effect AI             LanguageModel · Prompt · Tool · Toolkit · providers
        │
 Effect                Effect · Layer · Scope · Fiber · Queue · PubSub · Stream · Schema
```

Everything above the kernel is built *from* the kernel's seams. A module adds
a capability, a policy, an interpreter or an adapter. **It never adds a second
execution model.** The rest of this document follows from that rule.

## 2. The shape of the code

Almost every module is one of five kinds. Dependencies point downward only:

```text
  hosts        sandbox/local (Node) · blob/fs · cloudflare (workerd)      concrete platforms
     │
  adapters     client · http · rpc · mcp · a2a · ag-ui · openai · relay    the session over a protocol
     │         durable · cluster · durable-streams                         the session under a stronger runtime
     │
  batteries    coding · pi · web · code · subagent · skills · memory ·     capabilities built only
     │         state · compaction · budget · hooks · tool-source · ...     out of seams
     │
  seams        Loop · ContextTransform · Permission · Elicitation ·        substitution points
     │         InputChannel · ToolExecution · ToolExposure · Toolkit ·
     │         LanguageModel · Sandbox
     │
  kernel       Agent · AgentSession · AgentSubmission · AgentRun ·         the only code that executes
               AgentTurn · AgentEvent · ToolExecution
```

The kernel is the root entry, `affe-agent`. Every other module is an
explicit subpath of the package (`affe-agent/durable`, `affe-agent/http`,
...), listed in `package.json`'s `exports`. The maturity label of each subpath
(core, supported, experimental, reference) is in the README's maturity map.

`AgentTurn` and the engine entry points `AgentSession.makeEngine`,
`EngineOptions` and `ToolExecution.execute` can be reached by module path but
are absent from the root entry. A durable interpreter needs them, and an
application does not. `src/AgentSessionPublic.ts` lists the public
`AgentSession` namespace explicitly, and `test/PublicApi.test.ts` pins it.

```text
verify: exists src/AgentSessionPublic.ts
verify: exists test/PublicApi.test.ts
```

### 2.1 How Effect's parts are used

These rules decide which Effect construct each concept becomes
([`PLAN.md`](../PLAN.md) §2):

| construct | used for | examples |
| --- | --- | --- |
| plain **value** | semantics: descriptions, policies, decisions, ids | `Agent`, `AgentLoop`, `ContextTransform`, `Permission.Policy`, `AgentEvent`, `AgentLoop.Decision` |
| **Effect** | behaviour | `prompt`, `steer`, running a turn, executing a tool |
| **`Context.Service`** | environmental capabilities only | `LanguageModel`, `Sandbox`, stores, `AgentClient`, `AgentSessionHost` |
| **`Layer`** | constructing those capabilities at an infrastructure boundary | a provider, a SQL store, `DurableModel.wrap` |
| **`Scope`** | the lifetime of a running thing | a session owns its fibre, its queues and its bus |
| **`Stream`** | observation | `session.events`, `AgentSession.stream` |
| **`Schema`** | anything that crosses a process or storage boundary | ids, event envelopes, errors, wire prompts |

An `Agent` is not a service and has no layer. The one exception to "values,
not services" is the `Context.Reference`s the harness sets on the fibre:
`CurrentPrincipal`, `AgentInput.Current`, `ToolScheduling.Current`,
`Elicitation.Current` and `Sandbox.Current`. Each carries context that a tool
handler, many calls below, needs to read.

## 3. The core objects

| noun | what it is | lifetime |
| --- | --- | --- |
| `Agent` | A **description**: instructions, toolkit, loop, context transform, tool policies, optional typed input and output. **Carries no model.** | a value; reusable across sessions |
| `AgentSession` | One line of conversation. It owns the canonical history, the state machine, the input channels and the event bus. | a scope |
| `AgentSubmission` | One externally started unit of work: a `prompt` or `submit`, plus every follow-up it absorbs. The caller waits on it. | a forked fibre inside the session scope |
| `AgentRun` | One contiguous loop episode. It runs turns until the loop says stop. | inside a submission |
| `AgentTurn` | One model call, plus the tool calls it asked for. It commits atomically. | inside a run |

A session id is either given by the caller or generated. Submission and run
ids are derived from it, never random: a submission is
`${sessionId}:submission-${n}`, and a run is `${sessionId}:run-${n}`
(`src/internal/ids.ts`). The durable layer depends on this, because it can
recompute an execution id instead of storing it.

### 3.1 The Agent value

`Agent.make` (`src/Agent.ts`) fills every slot with a default:

| slot | default |
| --- | --- |
| toolkit | `Toolkit.empty` |
| loop | `AgentLoop.untilIdle()`: continue while the turn called tools |
| context transform | `ContextTransform.identity` |
| tool execution | `Parallel` |
| tool exposure | `ToolExposure.eager()` |
| tool failure policy | `ReturnToModel` |
| permission | `Permission.allowAll` |
| tool denial policy | `FailRun` |
| input | `AgentInput.prompt` |

The model is absent on purpose. It arrives through the environment when the
session is built (`Effect.context<Model | R>()` in `makeEngine`), so the same
agent runs against any of these without change:

- a provider;
- the scripted `TestLanguageModel`;
- a routing layer;
- the journaling `DurableModel`.

**Cross-cutting concerns are combinators, not type parameters.** Each
`withX` / `updateX` replaces or composes one slot and unions its own error
and requirement channels into the agent's `E` and `R`: `withPermission`,
`withContextTransform`, `withLoop`, `withTools`, `withInput`,
`withExecutionPlan` and the others. A requirement therefore accumulates
through the `pipe`. A new concern gets a new combinator, and `Agent.make`
does not grow a tenth type parameter (see [`AGENTS.md`](../AGENTS.md)).
A single internal `definition` function assembles every value, and it holds
the one erasure the loop's invariant `Tools` slot requires.

```text
verify: grep "export const untilIdle" src/AgentLoop.ts
```

## 4. Execution

### 4.1 The session and its state machine

`AgentSession.makeEngine` (`src/AgentSession.ts`) allocates the following, all
owned by the session's scope:

- **`state`**: a `SubscriptionRef<SessionState>` holding `status`
  (`idle | running | closed`), the submission counter, the active submission
  and run, the current turn, and two gates, `acceptingSteering` and
  `acceptingFollowUps`.
- **`history`**: a `Ref<Prompt.Prompt>`. It is the canonical conversation, it
  is append-only, and it is deliberately separate from `state`, so a state
  subscriber is never handed the whole conversation.
- **`steering` and `followUps`**: two `InputChannel`s. The default is an
  unbounded `Queue`, and the channel is a seam so that `/durable` can journal
  what a turn drained.
- **`inputGate`**: a one-permit semaphore. Every drain and every
  gate-flip happens under it.
- **the event bus** (§6), and the active and settled submission fibres.

```text
          prompt / submit                      submission settles
   IDLE ─────────────────────────► RUNNING ──────────────────────────► IDLE
     ▲                              │  steer · followUp · interrupt       │
     └──────────────────────────────┴─────────────────────────────────────┘
                     scope closes, from any state ──► CLOSED
```

Operations that are invalid in the current state fail with a type. They are
never reinterpreted:

- `prompt` while running fails with `AgentBusyError`.
- `steer`, `followUp` or `interrupt` while idle fails with `AgentIdleError`.
- Any operation after close fails with `AgentClosedError`.

**Claiming the session is one atomic `SubscriptionRef.modify`.** The same
transition checks `idle`, sets `running` and allocates the submission id. Two
concurrent `prompt`s therefore cannot both observe `idle`, and a rejected
prompt burns no id. `admitResolved` performs the claim uninterruptibly:
claim, fork the submission into the session scope, attach
`ensuring(release)`, then publish the fibre. A submission that has claimed
the session always releases it, however it ends.

```text
verify: grep "const claim = (self: Session<any>): Effect.Effect<Claim> =>" src/AgentSession.ts
verify: grep "SubscriptionRef.modify(self.state" src/AgentSession.ts
```

`prompt` is `startSubmission` followed by settling with
`interruptWithCaller: true`: if the caller is interrupted, the submission is
interrupted too. `submit` followed by `awaitSubmission` is the detached form:
the work outlives the caller's fibre, and a later call collects the result.

### 4.2 Submission, run, turn

```text
AgentSubmission.execute ─ SubmissionStarted
│ while (there is input, or a late steer asked for another run)
│   commit input to history          (FollowUpApplied if not the first run)
│   AgentRun.execute ─ RunStarted
│   │ loop
│   │   applySteering                ← the only place steering is drained
│   │   AgentTurn.execute            ← one model call + its tools, committed atomically
│   │   RunLedger.record
│   │   loop.decide(state)           → Continue | Stop | Final
│   │ on Stop: close steering, drain late steers; any late steer → another run
│   └ RunCompleted { turns, stopReason?, answeredBy? }
│   drain follow-ups under inputGate; if none, close follow-ups atomically
└ SubmissionCompleted { runs }
```

Each level is owned by exactly one module, and each decides one thing:

- **The loop decides whether another turn happens** (`src/AgentLoop.ts`).
  - It returns `Continue`, `Stop(reason?)` or `Final`.
  - `Final` runs one more turn with the agent's tools withheld, then stops.
  - The loop is a pure policy over `AgentLoop.State`: turn count, tool calls,
    elapsed time and the last response. It cannot see follow-up state.
  - `maxTurns`, `maxToolCalls`, `maxDuration`, `/budget` and
    `failOnExhaustion` are all loops.
- **The run decides where steering lands.**
  - Steering is drained at the start of every turn, and only there. A steer
    therefore changes the next model call and never the one in flight.
  - When the loop says stop, the run closes steering under the gate and
    drains once more. A steer that arrived in that window starts a fresh run
    instead of being lost.
- **The submission decides what follow-ups mean.** A follow-up never changes
  the running run. It is committed and becomes the input to the next run,
  after the current `RunCompleted`. Closing the follow-up gate is a separate
  atomic step that runs after a last drain, so a follow-up that races the end
  of a submission is either applied or refused. It is never dropped.

```text
verify: grep "export const applySteering" src/AgentTurn.ts
```

### 4.3 One turn

`AgentTurn.execute` (`src/AgentTurn.ts`) runs these steps in order:

1. **Derive the context.** It snapshots the history and runs the
   `ContextTransform`. The result is what the model sees for this turn, and
   it is discarded afterwards (§5).
2. **Resolve the toolkit.** A toolkit may be an `Effect`, so it is resolved
   again every turn. The harness's protocol tools are merged in: the output
   tool when the agent declares an `AgentOutput`, and `discover_tools` under
   progressive exposure. The exposed set is computed (§7.1). On a `Final`
   turn, the agent's tools are replaced by `Toolkit.empty`.
3. **Emit `TurnStarted`.**
4. **Call the model.**
   - `LanguageModel.generateText` is used by default, and `streamText` when
     the submission streams.
   - Both are called with `disableToolCallResolution: true`, so Effect AI
     decodes tool calls but the harness executes them.
   - `toolChoice` restricts the model to the exposed names.
   - An `ExecutionPlan` (provider fallback) wraps only this call.
   - Streaming emits `MessageStarted`, `MessageDelta`, `ToolCallDelta`,
     `MessagePartCompleted` and `MessageStreamCompleted`, with
     `MessageInterrupted` or `MessageFailed` on exit.
5. **Charge the budget, uninterruptibly, then emit `ModelCallCompleted`**
   with usage and finish reason.
6. **Execute the tool calls** through `ToolExecution.execute` (§7).
   Provider-executed calls are filtered out first, and a duplicate call id is
   a defect.
7. **Commit.** One uninterruptible block does all of the following:
   - appends the assistant parts and the tool results to history;
   - promotes a staged output value;
   - emits `MessageCompleted` and `TurnCompleted`.

   An interrupted turn therefore leaves no partial record.

### 4.4 Interruption and cancellation

There is no cancellation token. Interruption is fibre interruption:

- `interrupt` interrupts the submission's fibre.
- Closing the session's scope interrupts whatever is active, sets `closed`
  and emits `SessionClosed`.
- A tool call that was started and then interrupted still gets its terminal
  `ToolCallInterrupted`, because that event is emitted from a finalizer.
- A submission whose exit contains only interrupts settles as
  `status: "interrupted"`, with the progress made so far.

## 5. History and context

**The session is the only owner of the conversation.** The harness does not
use Effect AI's mutable `Chat`, because two sources of truth could not share
replay, compaction, steering insertion and commit timing
([`PLAN.md`](../PLAN.md) §5).

- **Canonical history** is appended through `Prompt.concat`
  (`src/internal/history.ts`) and nothing else. Durable replay and exports
  are built from it. Canonical compaction replaces it by committing a new,
  shorter history.
- **Model context** is produced fresh for each turn by the agent's
  `ContextTransform`, from a snapshot of history. `/compaction`, `/memory`,
  `/skills` and `/state` are transforms. They add, summarise or window what
  the model sees, and **a transform never writes history**.

```text
verify: exists src/internal/history.ts
verify: exists src/ContextTransform.ts
```

## 6. Events

`AgentEvent` (`src/AgentEvent.ts`) is the Schema-typed observation contract,
and **the only thing any observer reads**. The following all read it:

- `/hooks`, `/observability`, `/data`, `/export`, `/evals` and `/sessions`;
- every streaming transport;
- the TUI and the workbench.

Each event is wrapped in an envelope:

```text
{ sessionId, submissionId?, runId?, turn?, sequence, event }
```

`sequence` is a per-session counter with no gaps. The event set covers:

| group | events |
| --- | --- |
| session | `SessionStarted`, `SessionClosed` |
| submission | `SubmissionStarted`, `SubmissionCompleted`, `SubmissionFailed`, `SubmissionInterrupted` |
| run | `RunStarted`, `RunCompleted`, `RunFailed`, `RunInterrupted` |
| turn and model | `TurnStarted`, `TurnCompleted`, `ModelCallCompleted` |
| messages | `MessageStarted`, `MessageDelta`, `MessagePartCompleted`, `MessageStreamCompleted`, `MessageInterrupted`, `MessageFailed`, `MessageCompleted` |
| tools | `ToolCallStarted`, `ToolCallDelta`, `ToolCallProgress`, `ToolCallSucceeded`, `ToolCallFailed`, `ToolCallInterrupted`, `DelegatedEvent` |
| elicitation | `ElicitationRequested`, `ElicitationResolved` |
| input | `SteeringQueued`, `SteeringApplied`, `FollowUpQueued`, `FollowUpApplied` |

When a newer peer sends a tag this version does not know, it decodes as
`UnknownEvent` instead of failing.

**Emission is serialized.** The event bus (`src/internal/eventBus.ts`) holds
an unbounded `PubSub`, the sequence `Ref` and a one-permit `order` semaphore.
Taking a number and publishing happen under that permit, so arrival order is
sequence order even when parallel tool calls emit at the same time. Publishing
never blocks, so a slow subscriber cannot slow the agent.

Observers attach in three ways, which differ in what a failure does:

| way | how it attaches | a failure |
| --- | --- | --- |
| `sink` | synchronous, set at construction | fails the emit. This is how `/durable` and the Cloudflare host journal events |
| `observe` | synchronous, under the permit | is logged |
| `events` / `subscribe` | a `Stream` | cannot affect execution |

**The live stream is not a journal.** A subscriber that attaches late sees
only what comes after it. The one exception is the terminal `SessionClosed`
envelope, which is retained so that a late stream still ends. Where
observation must be resumable, that job belongs to a `DeliveryLog` fed by the
sink (§9.5): an `events({ after })` cursor is served from the log, never from
the `PubSub`.

A failure is carried by the event as a lossy projection. The full `Cause`
stays in `prompt`'s typed error channel, because Effect has no `Schema`
codec for `Cause`.

```text
verify: grep "PubSub.unbounded<AgentEventEnvelope>()" src/internal/eventBus.ts
verify: grep "const order = yield* Semaphore.make(1)" src/internal/eventBus.ts
```

## 7. The tool-call pipeline

The model proposes tool calls. The harness decides whether each call runs,
when it runs and what the model is told afterwards. `ToolExecution.execute`
(`src/ToolExecution.ts`) takes the turn's decoded calls through this sequence:

```text
batch checks ── exposure: a call to an unexposed tool gets ToolNotExposedError; its siblings still run
     │          exclusivity: an `Alone` call with siblings rejects the whole batch, returned to the model
     ▼
dispatch ────── Strategy: Sequential | Parallel | Concurrency(n) | PerTool(limits, total)
     ▼
host scheduling ToolScheduling.Current.around(call): may delay a call, never start one
     ▼
ToolCallStarted (the terminal event is guaranteed from here on, by a finalizer)
     ▼
decide ──────── decode params → projection (action, resource, subject)
     │          → Permission policy, combined with the tool's needsApproval floor
     ├─ Deny ─► ToolPermissionDeniedError ─► denial policy: return to model | fail run
     ├─ Ask ──► Elicitation (§7.3) ─► granted → continue | refused → ToolApprovalRequiredError
     ▼
handler ─────── Toolkit.handle(name, params)
     │          with Elicitation.Current, CurrentSessionId and ParentEvents provided
     │          a stream of results: each preliminary one → ToolCallProgress (byte-bounded)
     ▼
settle ──────── success                → ToolCallSucceeded, a tool-result part
                typed failure          → failure policy: ReturnToModel (rendered, ≤4096 chars) | FailRun
                defect or engine limit → fails the run
```

The results return to `AgentTurn`, which commits them together with the
assistant message. The whole pipeline runs under `ToolExecution.tool` spans,
nested inside `AgentTurn.execute`.

### 7.1 Exposure is what the model sees, not what it may do

`ToolExposure` (`src/ToolExposure.ts`) narrows tools in three steps:
registered → visible (a per-principal rule) → exposed.

- `eager()` exposes every tool.
- `progressive({ pinned, maxTools, ... })` exposes the pinned tools plus a
  `discover_tools` tool. The model searches the catalogue with it, and the
  result of the latest discovery *is* the selection. That selection is read
  back from committed history, so replay reproduces it without a journal
  entry of its own.

Exposure never grants anything. An exposed call still goes through
`Permission`.

### 7.2 Permission

A `Permission.Policy` (`src/Permission.ts`) is a value. Its infallible
`evaluate` maps a request to `Allow`, `Ask(reason?)` or `Deny(reason?)`. The
request carries an action, a resource, an optional subject, the tool's
intrinsic approval and the recent messages.

- **Decisions combine most-severe-wins**: Deny > Ask > Allow.
- **A tool's own `needsApproval` is a floor.** It combines as `Ask`, which no
  application policy can lower.
- **`rules` combines every matching rule.** It is not first-match, and its
  `otherwise` is required.
- **Remembered grants** (`remembered`) upgrade `Ask` to `Allow` for a key of
  tool, action and resource. They never override `Deny`.
- **A tool is projected onto a resource** by the `Permission.annotate`
  annotation. For example, `/coding`'s file tools project to read or write on
  a path, and `shell` projects to its command. Without a projection, the
  resource is the tool's name.

Permission is neither the sandbox (the physical boundary, §10.1) nor
elicitation (the means of getting an answer).

```text
verify: grep "export const annotate" src/Permission.ts
verify: grep "export const remembered" src/Permission.ts
```

### 7.3 Elicitation: pausing for an outside answer

`Elicitation` (`src/Elicitation.ts`) is the general human-in-the-loop
primitive. Tool approval is one use of it among several. An `Elicitor` has
`elicit(request, announce)`, `respond` and `pending`, and its contract is
register, then announce, then await. Whoever answers can therefore find the
request by the time they see `ElicitationRequested`.

| implementation | what it waits on | a pause survives |
| --- | --- | --- |
| `Elicitation.denied` | nothing; it refuses at once | n/a (the session default) |
| `Elicitation.memory` | a `Deferred` per request | the process |
| `DurableElicitation` | a `DurableDeferred` | a crash; the workflow suspends |

Inside a handler, `Elicitation.Current` is a forwardable elicitor, which is
how a subagent's question reaches the parent's caller (§11).

### 7.4 Typed ends: input and output

`AgentInput` and `AgentOutput` sit at the two ends of a submission.

- **`AgentInput` (the typed input).**
  - It separates the value a submission is asked with from the rendering the
    model sees.
  - The value travels on the fibre as `AgentInput.Current`, and on
    `SubmissionStarted`. Only the rendering enters history.
  - Across a wire, the value crosses encoded with the agent's schema, and
    the host decodes it with the same schema.
- **`AgentOutput` (the typed output).**
  - It ends a submission in a typed value, delivered by a tool the model
    calls. There is no second model call.
  - The output tool is marked `Alone`, and its handler stages the value.
  - The turn commit promotes the staged value, and `withOutputStop` then
    stops the loop.

## 8. Types as architecture

The generic parameter `Tools` is carried through the engine from end to end:
`AgentSession`, `AgentSubmission`, `AgentRun`, `AgentTurn` and
`ToolExecution` all have it. Tool types are never erased internally and
re-asserted at the edge. Three consequences follow.

- **The error channel names what can fail.** `prompt` fails with
  `PromptError<Tools, E>`, which is the union of:
  - `AgentBusyError` and `AgentClosedError`;
  - `AiError`;
  - each tool's declared failure type;
  - `ToolApprovalRequiredError` and `ToolPermissionDeniedError`;
  - the agent's accumulated `E`.

  `unknown` in an error channel is treated as a bug.
- **User code needs no casts.** The type friction is absorbed inside `src/`.
  Every erasing cast (`as any`, `as unknown as`, `as never`) is listed in
  [`AGENTS.md`](../AGENTS.md) with its reason, and `test/Casts.test.ts` fails
  the build on one that is not listed.
- **Inference is asserted, not assumed.** `examples/typed-agent.ts` is a full
  agent with no casts or annotations. It carries compile-time assertions that
  calls, results and errors are not `any`.

```text
verify: exists test/Casts.test.ts
verify: exists examples/typed-agent.ts
```

## 9. Durability: the same agent under a stronger runtime

The core has no knowledge of durability. **The same `Agent` value runs
durably inside an Effect `Workflow`**, with every change made at a seam
([`guide-durable.md`](./guide-durable.md), [`PLAN.md`](../PLAN.md) §30).

```text
                 local (default)                 durable (inside the workflow body)
LanguageModel    provider layer                  DurableModel.wrap            → one Activity per model call
toolkit          handlers                        DurableToolkit.wrap          → one Activity per tool call
permission       policy                          DurablePermission.wrap       → decision journaled
InputChannel     Queue                           DurableChannels.factory      → each drain journaled
Elicitation      Deferred                        DurableElicitation           → DurableDeferred
event sink       none                            delivery recorder            → DeliveryLog
tool strategy    agent's                         captured once at admission, then replayed
```

### 9.1 Two workflow shapes

Both are built on `effect/unstable/workflow` (`src/durable/`):

| workflow | executions | idempotency key | result |
| --- | --- | --- | --- |
| `DurableAgent.workflow` | one per session | `${name}:${sessionId}` | text |
| `DurableSubmission.workflow` | one per submission | `${name}:${sessionId}:${submissionId}` | an `Outcome`: `Succeeded`, `Failed` or `Infrastructure` |

`DurableAgentClient` drives the per-submission form.

### 9.2 What is journaled and what is re-run

**Re-run on replay:** the workflow body, which is the harness loop, context
derivation and event emission. Canonical history is *not* stored by
`DurableAgent`. It is rebuilt from the replayed activity results.

**Read back from the journal:** every activity result. Activities have
deterministic names, so replay matches them to the same program points:

| step | activity name |
| --- | --- |
| model call | `model-${n}`, a per-submission ordinal |
| tool call | `tool-${occurrence}-${name}-${id}` (plus `tool-start-…` for a non-idempotent tool) |
| permission decision | `permission-${index}-${tool}-${toolCallId}` |
| input drain | `${channel}-drain-${index}` |
| Effect-valued input rendering | `render` |
| admission-time captures | `execution-strategy`, `host-scheduling`, `contract-digests` |

Outcomes are journaled as **data**: `Succeeded`, `Failed` or `Unresolved`,
never as workflow failures. The same `reraise` then turns a recorded outcome
into the same effect on the first run and on replay.

### 9.3 Guards against a program that changed under its journal

Replaying a journal against changed code fails loudly:

- **A changed tool contract** raises `ToolContractChangedError`. Each tool's
  SHA-256 contract digest is recorded at admission, and a tool can declare
  itself `CompatibleWith` an older one.
- **A changed permission policy** raises `PermissionPolicyChangedError`.
- **A changed host scheduling** raises `ToolSchedulingChangedError`.
- **An `ExecutionPlan`** makes a durable agent refuse to start, because a
  plan step provides its own model and would bypass the journal.

### 9.4 Side effects

A tool that is not marked `Tool.Idempotent` writes a start marker before its
handler runs. If a replacement process finds the marker without an outcome, it
records `Unresolved`, which re-raises as `DurableToolUnresolvedError`, and
the call is not reissued.

The guarantee is **at-most-once under interruption**. It does not extend to
power loss between a side effect and its record, and no local mechanism could
extend it that far.

Streaming works like this:

- The journal holds one completed response per model call.
- On the first run, deltas are tapped live.
- On replay, each part is re-emitted as one chunk, rebuilt from decoded parts
  with its metadata. Reasoning signatures therefore survive a crash.

`src/testing/DurableEquivalence.ts` checks that property: a crash followed by
recovery must produce the same outcome as no crash.

### 9.5 Storage

The library defines the stores for its own state. The workflow journal
belongs to the upstream engine: `ClusterWorkflowEngine` over its SQL message
storage.

| store | holds | backings |
| --- | --- | --- |
| channels store | steering, follow-ups, gate markers, interrupt intents, the dispatch outbox | memory, SQL `affe_channel_input` |
| `DurableSessionStore` | status, history, the admission claim, pending elicitations | memory, SQL `affe_session`, `affe_elicitation` |
| `DeliveryLog` | the event log that `events({ after })` resumes from | memory, SQL `affe_delivery`, Durable Streams |

A `DeliveryLog` keys each event by its semantic coordinates. A second write
under the same key must match the first, or it is a conflict. Replay can
therefore re-emit events without duplicating them. `SessionDirectory` and
`AgentState` have tables of their own, but execution does not depend on
either.

### 9.6 Checking the guarantees

The durability invariants are stated in
[`plan-durability-hardening.md`](./plan-durability-hardening.md) as D1–D8:

- D1: admission is a promise.
- D2: resumption never repeats completed work.
- D3: resumption never skips accepted work.
- D4: interruption is terminal; a crash is not.
- D5: observation is at-least-once, with a stable cursor.
- D6: a recorded event is replay-stable.
- D7: storage failure degrades; it does not corrupt.
- D8: recovery is indistinguishable from never having crashed.

`npm run verify:durability` (`scripts/falsify.mjs`) removes each guarantee
from the code in turn and records whether the tests notice. Every break
fails the tests except D4b. D4b removes two interrupt checks, and the plan
records that it is not yet settled whether those checks are redundant or
guard a scenario that no test constructs.

Changing a journal-bearing fixture under `test/fixtures/` requires a
`Behavior-Change:` trailer on the commit, and `CHANGELOG.md` is generated
from those trailers.

```text
verify: exists src/durable/DurableModel.ts
verify: exists src/durable/DurableToolkit.ts
verify: exists src/testing/DurableEquivalence.ts
verify: grep "A durable agent cannot carry an ExecutionPlan" src/durable/DurableAgent.ts
```

## 10. Crossing a process boundary

`AgentSession` is the local handle. It knows the agent's tool types, returns
Effect AI's full `GenerateTextResponse` and fails with each tool's own typed
error, and none of that survives a wire. **`AgentClient`**
(`src/client/AgentClient.ts`) is the session narrowed to what can cross:

- `createSession` and `session(id)`;
- per session: `prompt`, `submit`, `awaitSubmission`, `steer`, `followUp`,
  `interrupt`, `respond`, `pending`, `history`, `status`,
  `events({ after })` and `stream`.

On this surface:

- A result is `RemoteResult`: provider-neutral content, with no provider
  response.
- A tool's typed failure arrives as `AgentExecutionError`, which carries the
  original tag.
- Transport failures are a separate type, the retryable `AgentTransportError`.

`AgentClient.typed(agent)` restores typed input and output for an agent the
caller knows. The service has these implementations:

| client | where the session lives |
| --- | --- |
| `AgentClient.layer` | in this process |
| `AgentHttp.agentClientLayer` / `AgentRpc.agentClientLayer` | behind a server |
| `DurableAgentClient.layer` | in a workflow; the handle can die and reattach |

Every `AgentClient` implementation (in-process, HTTP, RPC, durable, and RPC
over the relay) is held to one conformance suite,
`test/AgentClientContract.ts`. The cross-adapter matrix is
[`conformance-matrix.md`](./conformance-matrix.md).

### 10.1 The host, and the adapters over it

The server side is **`AgentSessionHost`** (`src/client/AgentSessionHost.ts`).
All adapters share one host, and the host holds everything request-facing:

- **Registry.** One session registry. On a local miss, it calls
  `client.session(id)` and adopts the result, which is how one process serves
  a durable session created by another.
- **Authentication.** A `PrincipalResolver` runs on every operation and yields
  the principal, or `AgentUnauthorizedError`.
- **Identity.** `subject(principal)` becomes `CurrentPrincipal` on the
  submission fibre. Tools, visibility rules and credential bindings read it
  there.
- **Limits.** `maxSessions` refuses new sessions rather than evicting old
  ones. There are per-session request limits and a bounded event-retention
  tail. A read from before the oldest retained event is refused, never served
  with a gap.
- **Idempotency.** A wire `requestId` deduplicates mutations.
- **Host-wide events.** `hostEvents` is a merged feed for directories and
  dashboards.

The adapters translate a protocol into host operations. They add no
execution. `/openai` is the exception to the shared host: it runs directly
over an `AgentClient`, and it opens a fresh session per request unless a
header names one.

| adapter | serves | consumes |
| --- | --- | --- |
| `/http` | REST + SSE at `/sessions/...`, resumable with `Last-Event-ID`; `AgentServer.mount` puts several agents on one server | `AgentHttp.agentClientLayer` |
| `/rpc` | an `RpcGroup` mirroring the protocol; the app chooses the RPC transport | `AgentRpc.agentClientLayer` |
| `/mcp` | the agent as MCP tools (`ask_agent`, `agent_start`, `agent_await`, ...) | an MCP server as a toolkit (`McpToolkit.bind`) |
| `/a2a` | an Agent Card, JSON-RPC and HTTP+JSON | a remote agent as a client or a tool; Claude Code and OpenCode bridges |
| `/ag-ui` | `POST /ag-ui` → AG-UI events; an elicitation becomes an interrupt | none |
| `/openai` | `POST /v1/chat/completions`, text only | none |

`PromptWire` (`src/PromptWire.ts`) is the one JSON-safe codec for prompts. It
keeps file data tagged as a string, bytes or a URL, so persistence cannot
change which variant of the union a value is.

### 10.2 Relay, cluster and Cloudflare

These are three ways to place a session.

**The relay** (`src/relay/`) serves nodes behind NAT. A node holds one
outbound connection to a public relay, which routes opaque RPC frames by peer
id. The rest works like this:

- `AgentRpc` runs over the relay unchanged.
- The relay stamps the authenticated sender, so a peer cannot forge its
  identity to the host's principal resolver.
- Liveness is a lease, renewed by traffic or heartbeat (60s by default).
- The newest connection for a peer supersedes the older one.

**The cluster** (`src/cluster/`) makes a session a sharded entity:
`Entity.make("AgentSession", ...)` from `effect/unstable/cluster`.

- The entity id is the session id, which guarantees a single owner across
  runners.
- `submit` writes an outbox row before it acknowledges, and every handler
  re-dispatches rows still owed.
- Client calls retry through shard reassignment for longer than the shard
  lease.
- `ScheduledAgent` fires a `ClusterCron` job once per cluster.

**Cloudflare** (`src/cloudflare/`) runs one Durable Object per session, with
a Worker that routes to it. **It does not use `/durable`**, because Effect
Workflow stalls on workerd. The durability is the platform's:

- History is written to DO SQLite on every committed turn.
- Events go to a `DeliveryLog` through the session's sink.
- Scheduled work is a logical alarm, with its intent row written in the same
  transaction.
- A runtime lost in the middle of a run loses the turn in flight.

`apps/worker` is the reference deployment.

```text
verify: exists src/client/AgentSessionHost.ts
verify: exists test/AgentClientContract.ts
verify: grep "AgentClientContract" test/RelayContract.test.ts
verify: grep "Entity.make(\"AgentSession\"" src/cluster/AgentEntity.ts
verify: grep "Workflow stalls on workerd" src/cloudflare/index.ts
```

## 11. Batteries, and what they plug into

A battery is a value that fits a seam. The kernel imports none of them.

| seam | batteries |
| --- | --- |
| toolkit | `/coding` and `/pi` (file and shell tools over `Sandbox`), `/web`, `/code`, `/subagent`, `/skills`, `/mcp`, `/tool-source`, `/plugins` |
| context transform | `/compaction`, `/memory`, `/skills`, `/state` |
| loop | `AgentLoop.*` limits, `/budget` |
| permission | `Permission.rules`, `/coding` projections, the bridge projections |
| event observation | `/hooks` (observe only), `/observability`, `/data`, `/export`, `/evals`, `/sessions` |
| `LanguageModel` layer | providers, `/model` metadata, `/effect-uai`, `/durable`'s wrapper |
| `Sandbox` layer | `/sandbox` (memory; derived from `exec`), `/sandbox/local` (Node), `/blob` |

Two of these are commonly mistaken for security boundaries:

- **`/sandbox/local` is not a security boundary.** It is a real directory
  with escape checks. Isolation belongs to whatever provides the `Sandbox`
  layer.
- **Code mode** (`/code`) is one `execute` tool that runs a program in an
  owned interpreter. The interpreter's only authority is an `invoke` hook,
  and `invoke` calls `ToolExecution.decide`, the same permission decision
  every other tool call goes through. There is never a cheaper path to a
  tool. The default interpreter is neither an OS nor an isolate boundary.
  Isolation is a `CodeExecutor` choice, for example the Cloudflare isolate
  executor.

```text
verify: grep "This is not a security boundary." src/sandbox/local.ts
```

### 11.1 Delegation is a tool

A subagent is a tool whose handler opens a child session
(`src/subagent/`). There is no second agent runtime. The three forms differ
by host and lifetime ([`plan-subagent-execution-forms.md`](./plan-subagent-execution-forms.md)):

| form | the child session | lifetime |
| --- | --- | --- |
| `Subagent.tool` | `makeEngine` inside the handler's scope | ends with the call; interrupting the parent interrupts the child |
| `Subagent.background` | a named, enumerable session; reports arrive through `SessionInbox` | outlives the run; never a detached fibre |
| `Subagent.durable` | its own `DurableSubmission` workflow, `subagent:${parent}:${toolCallId}` | the parent's workflow suspends behind the child's |

What the child inherits is explicit (`Inherit`):

| inherited | default | option |
| --- | --- | --- |
| budget | shared, so the child's turns charge the parent | |
| approval | refuse, so a child with approval-requiring tools is rejected at construction | `"parent"` forwards through `Elicitation.Current` and stamps `via` |
| events | none | `"parent"` wraps them as `DelegatedEvent` |
| principal | always crosses, as a fibre reference | |

## 12. Portability and frozen identifiers

**Portable by default, host code quarantined.** A portable module needs
operating-system capabilities through Effect platform services:

- `FileSystem`, `Path`;
- `HttpClient`, `HttpServer`;
- `SqlClient`.

It must not import `node:*` or a runtime's platform package, and it must not
touch `process` or `Buffer`. Exactly four files are host modules:
`sandbox/local.ts`, `blob/fs.ts`, `cloudflare/index.ts` and
`cloudflare/isolate.ts`. These checks enforce the rule:

- `npm run lint:portability` parses every source file, and
  `test/Portability.test.ts` proves the checker fires.
- `npm run verify:package` imports every entry of the packed tarball with
  Node built-ins refused.
- `npm run verify:workerd` builds the Worker bundle.

**Identifiers that outlive a process are frozen.** Every `_tag`, service
key, brand, table name and persisted key prefix is built by
`src/internal/namespace.ts`, from the roots `affe-agent` and `affe_`. Those
roots are not the package name and will not follow a rename.
`test/Namespace.test.ts` holds two manifests, and a new identifier is a
deliberate manifest edit:

- `namespace-manifest.json` for namespaced identifiers;
- `error-tags-manifest.json` for bare error tags.

```text
verify: grep "const HOST_MODULES = new Set([\"sandbox/local.ts\", \"blob/fs.ts\", \"cloudflare/index.ts\", \"cloudflare/isolate.ts\"])" scripts/verify-portability.mjs
verify: exists src/internal/namespace.ts
verify: exists test/fixtures/namespace-manifest.json
verify: exists test/fixtures/error-tags-manifest.json
```

## 13. Invariants and what holds them

A name such as `AgentSession` refers to `test/AgentSession.test.ts`, and the
quoted text is the test case.

| invariant | mechanism | test that holds it |
| --- | --- | --- |
| At most one submission per session | atomic `claim` in one `SubscriptionRef.modify` | `AgentSession`: "concurrent prompts: exactly one claims the session" |
| A transform shapes the prompt, never history | history is a private `Ref`; transforms get a snapshot | `AgentSession`: "ContextTransform shapes the model prompt, not history" |
| Steering is FIFO and lands only at a turn boundary | `applySteering` is the only drain, under `inputGate` | `AgentSession`: "multiple steers apply once, in order, at one boundary" |
| A follow-up is never dropped at quiescence | follow-ups drained between runs; the gate closes atomically | `FollowUpOrder`: "a follow-up offered while the submission closes is not dropped" |
| A turn commits atomically | one uninterruptible commit block | `AgentSession`: "an interrupted turn commits nothing" |
| Every started tool call gets exactly one terminal event | `ToolCallInterrupted` from a finalizer | `AgentSession`: "every started tool call gets exactly one terminal event" |
| Arrival order is sequence order | allocate and publish under one permit | `AgentSession`: "delivery order matches sequence order under parallel tools" |
| A tool's `needsApproval` cannot be waived | intrinsic approval combined as a floor | `test/ToolApprovalFloor.test.ts` |
| Durable recovery equals never crashing | journaled outcomes; deterministic activity names | `test/DurableEquivalence.test.ts`, `verify:durability` |
| No unlisted erasing cast in `src/` | cast inventory in `AGENTS.md` | `test/Casts.test.ts` |
| No host coupling outside host modules | `HOST_MODULES`, AST check | `lint:portability`, `verify:package` |
| No stray persisted identifier | `namespace.ts` + manifests | `test/Namespace.test.ts` |

```text
verify: grep "concurrent prompts: exactly one claims the session" test/AgentSession.test.ts
verify: grep "ContextTransform shapes the model prompt, not history" test/AgentSession.test.ts
verify: grep "multiple steers apply once, in order, at one boundary" test/AgentSession.test.ts
verify: grep "a follow-up offered while the submission closes is not dropped" test/FollowUpOrder.test.ts
verify: grep "an interrupted turn commits nothing" test/AgentSession.test.ts
verify: grep "every started tool call gets exactly one terminal event" test/AgentSession.test.ts
verify: grep "delivery order matches sequence order under parallel tools" test/AgentSession.test.ts
verify: exists test/ToolApprovalFloor.test.ts
verify: exists test/DurableEquivalence.test.ts
verify: exists test/Namespace.test.ts
```

## 14. Where a new thing goes

Answer these in order. The first "yes" is the place.

1. **Is it a description of behaviour or a decision?** Make it a value: a
   loop, a transform, a policy, a strategy. If it is cross-cutting, attach it
   with a `withX` combinator. It is not a type parameter on `Agent.make`.
2. **Is it something the model can do?** Make it a tool, or a toolkit
   battery. If it needs the OS, it depends on `Sandbox.Current` or a platform
   service.
3. **Is it a capability of the environment**: a store, a provider or an
   external API? Make it a `Context.Service` supplied by a `Layer`.
4. **Is it the session over a protocol?** Make it an adapter over
   `AgentSessionHost` (serving) or an `AgentClient` implementation
   (consuming). It must pass `test/AgentClientContract.ts`.
5. **Is it the session under a stronger runtime?** Wrap the seams: the model
   layer, the toolkit, the channels, the elicitor and the sink. If a
   requirement cannot be met at a seam, that is a finding for
   [`PLAN.md`](../PLAN.md), not a hook to add to the kernel.
6. **Does it bind to one runtime?** Make it a host module with its own
   package entry and a line in `HOST_MODULES`.
7. **Does it need a new kernel noun?** Only when two independent features
   need it ([`AGENTS.md`](../AGENTS.md), "Scope discipline").

## 15. Known edges

These are the known edges, stated as they stand. The open work that
addresses them is ranked in [`remaining-work.md`](./remaining-work.md).

- **`framework` submissions do not cross a wire.** They are implemented by
  the in-process client, and the wire adapters do not implement them yet.
- **Live observation of a local session is not resumable.** The in-process
  client's `events({ after })` fails with `AgentTransportError`, because
  resuming needs a `DeliveryLog`.
- **The Cloudflare host is not `/durable`.** A crash there loses the turn in
  flight. Under `/durable`, the same crash resumes from the journal.
- **Durability of a non-idempotent side effect is at-most-once under
  interruption only** (§9.4).
- **`ClusterMultiNode` depends on a quiet machine.** It drives real cluster
  timeouts, and [`STATUS.md`](../STATUS.md) explains why `TestClock` cannot
  replace them.
