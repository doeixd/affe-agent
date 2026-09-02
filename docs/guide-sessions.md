# Sessions: what the kernel gives you

The session semantics of `@doeixd/effect-agent`, in detail. The
[README](../README.md) has the quickstart and the seam map; this is the
long form of everything a local `AgentSession` does. For a session across a
process boundary see [guide-transports.md](./guide-transports.md); for one
that survives its process see [guide-durable.md](./guide-durable.md).

## Steering, without cancellation

`steer` injects guidance into a run that is already executing. It is applied at
the next **turn boundary** and never interrupts work in flight:

```ts
yield* AgentSession.steer(session, "Focus on runtime semantics.")
```

> A steer changes future reasoning; it never changes the meaning of a turn that
> has already started.

If you want to intervene immediately, that is `interrupt` followed by a new
`prompt` — two orthogonal operations rather than one ambiguous one.

## Follow-ups, and quiescence

`followUp` queues work that runs after the current run reaches its stopping
condition, under the same submission:

```ts
yield* AgentSession.followUp(session, "Then summarize the API.")
```

`prompt`, `steer` and `followUp` all take `Prompt.RawInput`, so an image or a
structured message steers a conversation exactly as a sentence does.

When a prompt crosses JSON or durable storage, use the root `PromptWire`
namespace rather than Effect AI's in-memory schema directly. Its `Prompt` and
`Message` codecs keep the decoded Effect types unchanged while preserving
whether each file part contains a string, `Uint8Array`, or `URL`:

```ts
import { PromptWire } from "@doeixd/effect-agent"
import { Schema } from "effect"

const json = yield* Schema.encodeEffect(PromptWire.Prompt)(prompt)
const restored = yield* Schema.decodeUnknownEffect(PromptWire.Prompt)(json)
```

The built-in HTTP, RPC, cluster, durable-store, export, and key-value-tree
boundaries already use this codec. It is public for custom stores and
transports that need the same stable representation.

`prompt` resolves only once the session goes quiet — after the initial prompt
**and** every follow-up queued while it ran. Nothing keeps executing after
`prompt` returns.

## Interruption is structured concurrency

There is no cancellation token. A run executes in a fiber owned by the session
scope, so leaving the scope interrupts it, and interrupting `prompt`'s caller —
a `timeout`, a lost `race` — releases the session rather than wedging it.

```ts
yield* AgentSession.interrupt(session)
```

Interruption is a terminal *state*, not a caller-level failure: you get
`{ status: "interrupted" }` back rather than being interrupted yourself.

## Canonical history, and derived context

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

## Dynamic instructions

The most common transform is injecting something that changes per turn —
workspace details, the date, permissions, recalled memory:

```ts
ContextTransform.appendSystem((context) =>
  Effect.map(Workspace, (ws) => `Working in ${ws.name}, turn ${context.turnIndex}`)
)
```

It is recomputed every turn and never enters canonical history, which is what
makes that safe.

## Streaming

Streaming is a property of the request, not of the agent — the same `Agent`
serves an interactive UI and a batch job:

```ts
const result = yield* session.prompt("explain this", { stream: true })
```

Output arrives on the existing event stream as `MessageStarted`,
`MessageDelta`, `MessageStreamCompleted` — or `MessageInterrupted` if a turn is
cut short, or `MessageFailed` if the provider errors. Every opened message gets
exactly one terminal event, so a consumer is never left rendering one that
cannot resolve. Deltas are normalised to `{ kind: "text" | "reasoning", delta }`
rather than exposing the provider's stream protocol.

**Streaming output is observational; canonical history remains atomic.** The
turn still commits once, after its tools have run, so a streamed submission and
a batched one produce identical transcripts — and an interrupted stream commits
no partial assistant message, which is a state no later model call could make
sense of.

## Pausing for a human

A run can need something a model cannot supply — approval, a credential, an
answer, a review. `Elicitation` is that, generally; tool approval is one
instance of it:

```ts
const session = yield* AgentSession.make(agent, {
  elicitation: Elicitation.memory
})

// elsewhere, reacting to the event stream
yield* AgentSession.respond(session, { id, granted: true })
```

The run **pauses**; it has not failed. That is why it is not called an
interrupt: in Effect, and in `AgentSession.interrupt`, interruption means a
fibre being torn down, and a pause that resumes is a different thing.

`ElicitationRequested` and `ElicitationResolved` bracket the wait, and
`AgentSession.pending` reports what is outstanding. Answering something nothing
is waiting for returns `false` rather than being swallowed — from outside,
"approved" and "approved too late" are otherwise indistinguishable.

The default answers *no*, which is the behaviour that existed before: a tool
declaring `needsApproval` is refused unless a caller opts in to being asked. And
because it is a seam, a durable interpreter can back it with `DurableDeferred`,
so a submission waiting on a human survives the process it started in.

## Tool progress

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

## Typed lifecycle events

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
  → ModelCallCompleted → ToolCallStarted → ToolCallSucceeded
  → MessageCompleted → TurnCompleted
  → RunCompleted → SubmissionCompleted
```

The harness owns tool execution (Effect AI's automatic resolution is disabled),
which is what makes the tool lifecycle fully observable and lets you choose the
concurrency strategy and the failure policy.

Events are Schema-defined, so a remote subscriber or a store can decode them.
That does not make the live stream durable — it remains **observational**.

## Typed errors

`prompt` names what can go wrong, including each tool's own declared failure:

```ts
type PromptError<Tools, E> =
  | AgentBusyError
  | AgentClosedError
  | AiError
  | Tool.HandlerError<Tools[keyof Tools]>
  | E // your loop's and transform's errors
```

## Tool failure is policy

A tool that fails on a bad argument usually should not destroy the run:

```ts
Agent.make({ toolkit, toolFailurePolicy: ToolExecution.ReturnToModel }) // default
Agent.make({ toolkit, toolFailurePolicy: ToolExecution.FailRun })
```

Defects always fail the run either way — a broken handler is not something the
model can correct.

## Per-tool concurrency

Global sequential, parallel and bounded strategies remain available. When one
tool mutates shared state while another is safe to fan out, limit them
independently:

```ts
Agent.make({
  toolkit,
  toolExecution: ToolExecution.perTool({
    limits: { shell: 1, read_file: 10 },
    defaultLimit: 4
  })
})
```

Limits are positive integers or `"unbounded"`. Different tool names use
independent pools, and the returned tool results retain the model's original
call order even when handlers finish out of order.

## Bounds, and a final turn

The bounds most agents want are loops, and `limits` is the one object that
composes them:

```ts
Agent.make({
  toolkit,
  loop: AgentLoop.limits({
    maxTurns: 20,
    maxToolCalls: 50,
    maxDuration: "2 minutes",
    // When a bound cuts the model off mid-work, take one more turn with the
    // tools withheld so the run ends in an answer rather than mid-thought.
    finalTurn: true
  })
})
```

`limits` is `and(untilIdle(), ...)` over the bounds given, so it lowers into
`AgentLoop.maxTurns`, `maxToolCalls` and `maxDuration`, each usable on its
own. Every bound is checked **after** the turn: the turn that crosses a
ceiling completes and commits, and no further one starts -- `maxToolCalls(3)`
on a turn that requested five calls runs all five, then stops. That is what
makes `maxDuration` different from `Effect.timeout` on the prompt, which
interrupts the run where it stands. Tokens and money stay in `/budget`,
because their scope is a `Layer`.

`finalTurn` is a third loop decision, `Final`: exactly one more turn with the
agent's tools withheld -- or, for an agent with an `AgentOutput`, with only
the output tool, so the last word is typed -- after which the loop is not
consulted. `AgentLoop.withFinalTurn(inner)` turns any policy's cut-off into
one; a stop on an idle model stays a plain stop. `and` keeps the most
stopping decision and `or` the least, with `Final` between `Continue` and
`Stop`.

A stop can say why. `AgentLoop.stop("reason")` and `final("reason")` carry it,
the built-in bounds and `Budget.within` name theirs, and it surfaces as
`stopReason` on `RunCompleted`, on the result, and across every client --
so a caller can tell a run that finished from one that was cut off without
reading the transcript.

One caveat, stated on `State.elapsed`: a duration bound is not replay-stable
under `/durable`, because a resumed submission measures its own elapsed time.
Turn and tool-call bounds are derived from journalled facts and are.

## Dynamic capabilities: a toolkit resolved per turn

A `toolkit` may be a plain value **or an `Effect`**. In the Effect form the
harness re-resolves it **once per turn**, so the tools — and the state their
handlers close over — can vary with whatever the resolver reads at that moment:
the current tenant, a feature flag, a freshly-fetched credential, a per-tenant
MCP connection.

```ts
class Tenant extends Context.Service<Tenant, { searchIndex: string }>()("Tenant") {}

const Assistant = Agent.make({
  // Re-read every turn; one definition serves every tenant.
  toolkit: Effect.flatMap(Tenant, (tenant) =>
    Agent.toolkit([Search], {
      search: ({ query }) => searchIn(tenant.searchIndex, query)
    }))
})
// Switching the provided `Tenant` layer switches what the tool reaches.
```

Two things follow from it being an ordinary Effect. Its **requirements join the
agent's** — here `Tenant` surfaces in the agent's `R`, so a session that forgets
to provide it is a type error, not a runtime surprise. And its **failures join
the agent's error channel** — acquiring a capability (connecting to a tenant's
MCP server, reading a policy) is allowed to fail, and that failure is catchable
by tag on the run rather than becoming a defect. Full example:
[`examples/dynamic-capabilities.ts`](../examples/dynamic-capabilities.ts).

## Composing declarative values

`Agent`, `AgentLoop` and `ContextTransform` are values, so an external
combinator can be applied to them without changing the library:

```ts
const bounded = AgentLoop.untilIdle().pipe(alsoStopAfter(20))
```

`.pipe` carries no agent semantics — it is syntax for passing a value through
functions. Combining policies stays explicit (`AgentLoop.and`, `.or`,
`ContextTransform.compose`), because a policy combined by argument position
would leave a reader guessing which one it was, and the difference between
`and` and `or` is the difference between a run that stops and one that does
not.

Composition is heterogeneous: composing transforms that fail differently, or
need different services, gives the union of both.

## Authoring an agent, two ways

The object form and the pipeable form build the same `AgentDefinition`; pick
whichever reads better. Each `withX` replaces; each `updateX` combines with
what is there, and says so.

```ts
const Search = Agent.tool(
  Tool.make("search", {
    parameters: Schema.Struct({ query: Schema.String }),
    success: Schema.String
  }),
  ({ query }) => search(query)         // `query: string`, inferred
)

const Researcher = Agent.make().pipe(
  Agent.withInstructions("Cite sources."),
  Agent.withTool(Search),
  Agent.withTool(ReadFile, ({ path }) => fs.readFileString(path)),
  Agent.withContextTransform(ContextTransform.instructions(today)),
  Agent.withLoop(AgentLoop.bounded(20))
)

// The same agent, object style:
const Researcher2 = Agent.make({
  instructions: "Cite sources.",
  tools: [Search, Agent.tool(ReadFile, ({ path }) => fs.readFileString(path))],
  contextTransform: ContextTransform.instructions(today),
  loop: AgentLoop.bounded(20)
})

const result = yield* Agent.run(Researcher, "What changed in Effect 4?")
```

`Agent.tool` pairs an Effect AI `Tool` with its handler and nothing more: it
lowers into the same toolkit `Agent.toolkit([...], handlers)` builds, so a
bound tool decodes, asks for approval, fails and reports exactly as one bound
in bulk. Tool names accumulate as a literal union (`"search" | "read_file"`),
a tool's declared `dependencies` join the agent's requirements, and a
handler's own timeouts, retries and spans go on the handler's Effect, where
they already compose. `Agent.run(agent, input)` is the scoped
`AgentSession.make` + `prompt` it replaces — same result, errors,
requirements and interruption; reach for `AgentSession` when the
conversation continues.

Bundles are ordinary functions over agents, generic in the agent's channels:

```ts
const CodingTools = <Tools extends Record<string, Tool.Any>, E, R>(
  agent: Agent.AgentDefinition<Tools, E, R>
) => agent.pipe(Agent.withTools(ReadFile, WriteFile, Bash))

const Coder = Agent.make().pipe(Agent.withInstructions(prompt), CodingTools)
```

The agent pipe carries agent behaviour only — instructions, tools,
transforms, loop, tool execution and failure policy. Models, durability,
storage, transports and sandboxes remain Layers on the Effect side.


## Snapshots

A conversation is a value, so it can be stored and brought back:

```ts
const snapshot = yield* AgentSession.snapshot(session)   // idle sessions only
// ...persist it, send it, keep it as a fixture

const restored = yield* AgentSession.restore(agent, snapshot)
```

`AgentSession.Snapshot` is Schema-defined, so it crosses a process boundary the
way anything else here does. It holds the conversation and the session id —
identity survives, so logging and correlation still point at the same thing
after a restart. Everything else is rebuilt: a new scope, a new event bus, empty
input queues.

Snapshots are refused for a running session, with `AgentBusyError`. A turn
commits its assistant message and tool results as one unit, and a snapshot taken
between those would record a conversation that never existed.


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


## Tracing

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
OpenTelemetry SDK is required. See [`examples/tracing.ts`](../examples/tracing.ts).

