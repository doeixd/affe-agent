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
> candidate. Streaming and durability are deliberately not implemented — see
> [Not included](#not-included).

## Install

```bash
npm install @doeixd/effect-agent effect
```

`effect` is a peer dependency. Provider packages (`@effect/ai-anthropic`,
`@effect/ai-openai`) are yours to choose.

## Quickstart

```ts
import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { Agent, AgentLoop, AgentSession } from "@doeixd/effect-agent"

const Search = Tool.make("search", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.Struct({ hits: Schema.Array(Schema.String) })
})

const SearchToolkit = Toolkit.make(Search)

const toolkit = SearchToolkit.pipe(
  Effect.provide(
    SearchToolkit.toLayer({
      search: ({ query }) => Effect.succeed({ hits: [query] })
    })
  )
)

const Researcher = Agent.make({
  instructions: "Research carefully and cite evidence.",
  toolkit,
  loop: AgentLoop.and(AgentLoop.untilIdle(), AgentLoop.maxTurns(20))
})

const program = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* AgentSession.make(Researcher)
    const result = yield* AgentSession.prompt(session, "Research Effect AI.")
    return result.text
  })
)
```

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

### Typed lifecycle events

Every meaningful transition is an event on one stream, with correlation and a
gap-free per-session sequence:

```ts
yield* Effect.forkScoped(
  Stream.runForEach(AgentSession.events(session), (envelope) =>
    Effect.log(`${envelope.sequence} ${envelope.event._tag}`)
  )
)
```

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
| **Streaming** | `MessageDelta` is absent rather than half-implemented; partial-message commit semantics are undefined. |
| **Durability in core** | Core stays in-process. Durable execution ships separately as `@doeixd/effect-agent/durable`, where the *same* agent definition runs inside an Effect `Workflow`: model and tool calls become `Activity`s, so a resumed submission replays them instead of repeating them. A refund goes out once. |
| **Memory, skills, sandboxes, subagents** | A subagent is a tool that opens a child session. Memory is a service plus a transform. Neither needs a first-class concept. |

## Durable execution

The same `Agent` value, interpreted durably — no redefinition, no separate
framework:

```ts
import { DurableAgent } from "@doeixd/effect-agent/durable"

const durable = DurableAgent.workflow("Support", Support, { store })

const executionId = yield* DurableAgent.submit(durable, sessionId, "refund it")
// the process may end here; the submission survives
const result = yield* DurableAgent.result(durable, executionId)
```

Model calls and tool calls become `Activity`s, so a resumed submission returns
persisted results rather than re-issuing them — the refund does not go out
twice. Journals to SQLite via `SingleRunner`, or run in memory for tests. Steering queued while a submission is suspended is applied exactly once.
Canonical history is not stored: it is rebuilt from replayed activity results.

`@doeixd/effect-agent/cluster` addresses a session as a cluster `Entity`, so the
session id is the routing key and out-of-band input reaches the owning node.

## Examples

- [`examples/typed-agent.ts`](./examples/typed-agent.ts) — a fully typed agent,
  with compile-time assertions that inference stays precise
- [`examples/tracing.ts`](./examples/tracing.ts) — OTLP export
- [`examples/anthropic.ts`](./examples/anthropic.ts) — a real provider

## Development

```bash
npm run check   # typecheck + Effect language service + tests
npm run build
```

[`PLAN.md`](./PLAN.md) is the design authority; [`STATUS.md`](./STATUS.md)
records what is built and why. [`AGENTS.md`](./AGENTS.md) holds the conventions.

## License

MIT
