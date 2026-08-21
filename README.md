# @doeixd/effect-agent

An Effect-native agent execution kernel.

Effect AI gives you `LanguageModel`, `Prompt`, `Tool` and `Toolkit`. Effect gives
you fibers, scopes, queues, streams and typed errors. What sits between them —
sessions, runs, turns, steering, follow-ups, interruption, lifecycle events — is
what every agent application ends up reinventing.

That layer is all this library is.

```
┌──────────────────────────────────────────────┐
│ your application                              │
│   coding agent · research agent · chat        │
└───────────────────────┬──────────────────────┘
                        │
┌───────────────────────▼──────────────────────┐
│ @doeixd/effect-agent                          │
│   sessions · runs · turns · events            │
│   steering · follow-ups · context transforms  │
└───────────────────────┬──────────────────────┘
                        │
┌───────────────────────▼──────────────────────┐
│ effect/unstable/ai  ·  effect                 │
└──────────────────────────────────────────────┘
```

> **Status: v0.1, pre-release.** The semantics below are implemented and tested,
> but the API may still move. It targets Effect v4, which is itself at release
> candidate. Durable and distributed execution ship as the
> experimental subpath packages [`/durable`](#durable-execution) and
> [`/cluster`](#across-a-cluster).

## Install

```bash
npm install @doeixd/effect-agent effect
```

`effect` is a peer dependency. Provider packages (`@effect/ai-anthropic`,
`@effect/ai-openai`) are yours to choose.

## Quickstart

```ts
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { Agent, AgentLoop, AgentSession } from "@doeixd/effect-agent"

const Search = Tool.make("search", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.Struct({ hits: Schema.Array(Schema.String) })
})

const toolkit = Agent.toolkit([Search], {
  search: ({ query }) => Effect.succeed({ hits: [query] })
})

const Researcher = Agent.make({
  instructions: "Research carefully and cite evidence.",
  toolkit,
  // Run until the model stops calling tools, but never past 20 turns.
  loop: AgentLoop.bounded(20)
})

const program = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* AgentSession.make(Researcher)
    const result = yield* session.prompt("Research Effect AI.")
    return result.text
  })
)
```

`AgentSession.make` returns a small typed handle. Actions are methods;
observations are values you run when you want them:

```ts
yield* session.prompt("Research Effect AI.")
yield* session.steer("Focus on runtime semantics.")
yield* session.followUp("Then summarise it.")
yield* session.interrupt()

const history = yield* session.history
const status = yield* session.status
yield* session.events.pipe(Stream.runForEach(render))
```

The handle is inert — `session.prompt(input)` builds an `Effect` and starts
nothing. Every operation is also available as a module function
(`AgentSession.prompt(session, input)`), which is the same implementation and
the form to reach for when composing. Everything mutable stays opaque: the
handle exposes what a session can *do*, plus its `id`.

An `Agent` names no model. Provide one where you run the program:

```ts
program.pipe(Effect.provide(AnthropicLanguageModel.layer({ model: "…" })))
```

The same agent then runs against any provider, a routing layer, or a test
double — and a subagent can run under a different model entirely.

## What it gives you

### Steering, without cancellation

`steer` injects guidance into a run that is already executing. It is applied at
the next **turn boundary** and never interrupts work in flight:

```ts
yield* AgentSession.steer(session, "Focus on runtime semantics.")
```

> A steer changes future reasoning; it never changes the meaning of a turn that
> has already started.

If you want to intervene immediately, that is `interrupt` followed by a new
`prompt` — two orthogonal operations rather than one ambiguous one.

### Follow-ups, and quiescence

`followUp` queues work that runs after the current run reaches its stopping
condition, under the same submission:

```ts
yield* AgentSession.followUp(session, "Then summarize the API.")
```

`prompt`, `steer` and `followUp` all take `Prompt.RawInput`, so an image or a
structured message steers a conversation exactly as a sentence does.

`prompt` resolves only once the session goes quiet — after the initial prompt
**and** every follow-up queued while it ran. Nothing keeps executing after
`prompt` returns.

### Interruption is structured concurrency

There is no cancellation token. A run executes in a fiber owned by the session
scope, so leaving the scope interrupts it, and interrupting `prompt`'s caller —
a `timeout`, a lost `race` — releases the session rather than wedging it.

```ts
yield* AgentSession.interrupt(session)
```

Interruption is a terminal *state*, not a caller-level failure: you get
`{ status: "interrupted" }` back rather than being interrupted yourself.

### Canonical history, and derived context

The session owns the conversation. A `ContextTransform` derives the
model-facing prompt for one call and cannot mutate what is stored — the
distinction that makes compaction, RAG and memory injection possible without
corrupting the record:

```ts
const withMemory = ContextTransform.make((context) =>
  Effect.gen(function* () {
    const memory = yield* Memory
    const recalled = yield* memory.recall(context.canonicalPrompt)
    return Prompt.concat(recalled, context.canonicalPrompt)
  })
)
```

Transforms and loops preserve their own errors and requirements, so a policy can
depend on services the harness knows nothing about.

### Dynamic instructions

The most common transform is injecting something that changes per turn —
workspace details, the date, permissions, recalled memory:

```ts
ContextTransform.appendSystem((context) =>
  Effect.map(Workspace, (ws) => `Working in ${ws.name}, turn ${context.turnIndex}`)
)
```

It is recomputed every turn and never enters canonical history, which is what
makes that safe.

### Streaming

Streaming is a property of the request, not of the agent — the same `Agent`
serves an interactive UI and a batch job:

```ts
const result = yield* session.prompt("explain this", { stream: true })
```

Output arrives on the existing event stream as `MessageStarted`,
`MessageDelta`, `MessageStreamCompleted`, with `MessageInterrupted` if a turn is
cut short. Deltas are normalised to `{ kind: "text" | "reasoning", delta }`
rather than exposing the provider's stream protocol.

**Streaming output is observational; canonical history remains atomic.** The
turn still commits once, after its tools have run, so a streamed submission and
a batched one produce identical transcripts — and an interrupted stream commits
no partial assistant message, which is a state no later model call could make
sense of.

### Tool progress

A tool handler may report intermediate results while it is still running, via
Effect AI's `context.preliminary`:

```ts
const toolkit = yield* Agent.toolkit([Build], {
  build: (_params, context) =>
    context.preliminary("compiling").pipe(
      Effect.andThen(context.preliminary("linking")),
      Effect.as("built")
    )
})
```

Each one is emitted as a `ToolCallProgress` event as it happens, not when the
tool finishes — a long-running shell, browser or remote call is visible while it
is still interesting.

Progress is **observational**. Only the tool's final result is committed to
canonical history, so a consumer may render progress freely without it becoming
part of the conversation. For tools running in parallel, progress arrives in
real completion order while canonical results are still committed in model call
order.

### Typed lifecycle events

Every meaningful transition is an event on one stream, with correlation and a
gap-free per-session sequence:

```ts
yield* Effect.forkScoped(
  Stream.runForEach(
    AgentSession.events(session),
    AgentEvent.match({
      ToolCallStarted: (event) => Effect.log(`tool ${event.name}`),
      RunCompleted: (event) => Effect.log(`${event.turns} turns`),
      orElse: () => Effect.void
    })
  )
)
```

`match` narrows each payload by tag, so a hand-written switch cannot quietly
stop covering events as the ADT grows.

```
SubmissionStarted → RunStarted → TurnStarted
  → ToolCallStarted → ToolCallSucceeded
  → MessageCompleted → TurnCompleted
  → RunCompleted → SubmissionCompleted
```

The harness owns tool execution (Effect AI's automatic resolution is disabled),
which is what makes the tool lifecycle fully observable and lets you choose the
concurrency strategy and the failure policy.

Events are Schema-defined, so a remote subscriber or a store can decode them.
That does not make the live stream durable — it remains **observational**.

### Typed errors

`prompt` names what can go wrong, including each tool's own declared failure:

```ts
type PromptError<Tools, E> =
  | AgentBusyError
  | AgentClosedError
  | AiError
  | Tool.HandlerError<Tools[keyof Tools]>
  | E // your loop's and transform's errors
```

### Tool failure is policy

A tool that fails on a bad argument usually should not destroy the run:

```ts
Agent.make({ toolkit, toolFailurePolicy: ToolExecution.ReturnToModel }) // default
Agent.make({ toolkit, toolFailurePolicy: ToolExecution.FailRun })
```

Defects always fail the run either way — a broken handler is not something the
model can correct.

## Design commitments

These are enforced by tests, not just documented:

- `AgentSession` is the sole owner of canonical history.
- `ContextTransform` never mutates it.
- At most one run executes per session.
- Steering is FIFO and applies only at turn boundaries.
- Follow-ups never modify the running run; they schedule later runs.
- Every started tool call gets exactly one terminal event.
- A turn commits atomically — an interrupted turn leaves no partial record.
- Every event carries a monotonically increasing session sequence.
- **End-user code never needs a type cast.**

## Observability

Every engine operation is a named `Effect.fn`, so a trace reads as the execution
structure:

```
AgentSession.prompt
└── AgentSubmission.execute
    └── AgentRun.execute
        └── AgentTurn.execute
            ├── LanguageModel.generateText   (GenAI conventions, from Effect AI)
            └── ToolExecution.tool
```

Export is ordinary application wiring — Effect v4 ships an OTLP exporter, so no
OpenTelemetry SDK is required. See [`examples/tracing.ts`](./examples/tracing.ts).

## Not included

Deliberately, and the core is designed so these can be built on top without
modifying it:

| | |
|---|---|
| **Durability in core** | Core stays in-process. Durable execution ships separately as `@doeixd/effect-agent/durable`, where the *same* agent definition runs inside an Effect `Workflow`: model and tool calls become `Activity`s, so a resumed submission replays them instead of repeating them. A refund goes out once. |
| **Memory, skills, sandboxes, subagents** | A subagent is a tool that opens a child session. Memory is a service plus a transform. Neither needs a first-class concept. |

## Durable execution

The same `Agent` value, interpreted durably — no redefinition, no separate
framework:

```ts
import { DurableAgent, DurableChannels } from "@doeixd/effect-agent/durable"

// Where out-of-band input waits. `sqlStore` is the one to use in a real
// deployment; `memoryStore` is a map in one process.
const store = yield* DurableChannels.sqlStoreWithTable()
const durable = DurableAgent.workflow("Support", Support, { store })

const executionId = yield* DurableAgent.submit(
  durable,
  store,
  sessionId,
  "refund it"
)
// the process may end here; the submission survives
const exit = yield* DurableAgent.result(durable, executionId)
```

Model calls and tool calls become `Activity`s, so a resumed submission returns
persisted results rather than re-issuing them — the refund does not go out
twice, including when the runner that started it is lost and another takes its
shards over. Journals to SQLite via `SingleRunner`, or runs in memory for tests.
Canonical history is not stored: it is rebuilt from replayed activity results.

`result` yields an `Exit`, because a failed submission is still a *completed*
workflow. Its failure crosses as a typed `DurableAgentFailure` carrying the
originating error's tag, not an opaque defect.

Steering and follow-ups are queued through the same store, so they reach a
submission running in another process, and they are drained exactly once. A
`followUp` accepted before quiescence is guaranteed to run; once the submission
closes, further input is refused with `AgentIdleError` rather than accepted and
dropped.

### Across a cluster

Streaming and durability compose, with a caveat worth knowing: the journal holds
one entry per model call containing the completed response, never the individual
deltas. A streamed durable submission commits exactly the history a batched one
does, but its deltas arrive whole, and they are emitted inside the workflow —
live streaming to a remote consumer would need a delivery log, which this
library does not have.

`@doeixd/effect-agent/cluster` addresses a session as a cluster `Entity`, so the
session id is the routing key and out-of-band input reaches the owning node.

```ts
import { EntityClient } from "@doeixd/effect-agent/cluster"

const client = EntityClient.wrap(yield* makeRawClient("session-1"))

yield* client.submit("refund order 42")   // Effect<string, never>
yield* client.steer("be brief")           // Effect<void, AgentIdleError>
```

`EntityClient` wraps the generated entity client: it accepts the same
`Prompt.RawInput` the rest of the library does, retries through shard
reassignment, and keeps the cluster's transport failures out of the error
channel — so the only error left is the one a caller can act on.

## Compaction

A long conversation has to fit a context window without being lost.
`@doeixd/effect-agent/compaction` is a `ContextTransform` — it adds nothing to
the kernel, which is the point:

```ts
import { Compaction } from "@doeixd/effect-agent/compaction"

const agent = Agent.make({
  contextTransform: yield* Compaction.make({
    policy: Compaction.whenLongerThan(40, { retain: 10 }),
    summarise: ({ messages, previous }) => summarise(messages, previous)
  })
})
```

Canonical history is never rewritten, truncated, or summarised in place. What
changes is the projection: a summary of the head, the retained tail, and
everything since. The tail stays verbatim because it is what the model is still
reasoning over.

Summaries are checkpointed, so a conversation past the threshold does not
re-summarise every turn, and each new checkpoint is handed the previous summary
so it folds rather than forgets. `summarise` is an ordinary Effect — a cheaper
model, a heuristic, a cache — and may fail and require services of its own.

## Testing

The deterministic model and lifecycle probe the library tests itself with ship
as `@doeixd/effect-agent/testing`:

```ts
import { AgentProbe, TestLanguageModel } from "@doeixd/effect-agent/testing"

const { layer, recorder } = yield* TestLanguageModel.script([
  TestLanguageModel.toolCall("search", { query: "effect" }),
  TestLanguageModel.text("found it")
])

const session = yield* AgentSession.make(agent)
const probe = yield* AgentProbe.make(session)

yield* session.prompt("find effect")

assert.include(yield* probe.tags, "ToolCallSucceeded")
assert.deepStrictEqual(
  TestLanguageModel.userTexts((yield* recorder.prompts)[0]!),
  ["find effect"]
)
```

A script can also block a call, fail one, or run an Effect *during* generation —
which is how steering, interruption and concurrency become assertions rather
than races. `recorder` exposes the model-facing prompt the harness derived, so
context transforms and canonical history are directly testable.

## Examples

- [`examples/typed-agent.ts`](./examples/typed-agent.ts) — a fully typed agent,
  with compile-time assertions that inference stays precise
- [`examples/tracing.ts`](./examples/tracing.ts) — OTLP export
- [`examples/anthropic.ts`](./examples/anthropic.ts) — a real provider
- [`examples/durable.ts`](./examples/durable.ts) — durable execution and the
  cluster client; the snippets above are lifted from it, so they are
  type-checked rather than prose

## Development

```bash
npm run check   # typecheck + Effect language service + tests
npm run build
```

[`PLAN.md`](./PLAN.md) is the design authority; [`STATUS.md`](./STATUS.md)
records what is built and why. [`AGENTS.md`](./AGENTS.md) holds the conventions.

## License

MIT
