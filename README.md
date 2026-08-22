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

### Pausing for a human

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

### Composing declarative values

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

### Authoring an agent, two ways

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
does, but its deltas arrive whole. Remote consumers observe them through the
`DeliveryLog` the durable client records into (below), not through the journal.

### The durable client

`DurableAgentClient` provides the ordinary `AgentClient` service over a durable
interpreter, so a program written against the client seam runs unchanged in
either execution mode — and every transport built on `AgentClient` (RPC, HTTP,
MCP, A2A) reaches durable agents without knowing durability exists.

```ts
import { AgentClient } from "@doeixd/effect-agent/client"
import {
  DeliveryLog,
  DurableAgentClient,
  DurableChannels,
  DurableSessionStore
} from "@doeixd/effect-agent/durable"

// The program speaks only `AgentClient`.
const program = Effect.gen(function* () {
  const client = yield* AgentClient.AgentClient
  const session = yield* client.createSession({ sessionId: "customer-123" })
  return yield* session.prompt("Investigate this refund")
})

// Local: the agent runs in this process.
program.pipe(Effect.provide(AgentClient.layer(Support)))

// Durable: the same program, the same agent, over a workflow engine.
const DurableSupport = DurableAgentClient.layer("Support", Support, {
  store: yield* DurableChannels.sqlStoreWithTable(),
  sessionStore: yield* DurableSessionStore.sqlStoreWithTables(),
  delivery: yield* DeliveryLog.sqlLogWithTable()
}).pipe(Layer.provide(ClusterWorkflowEngine.layer))

program.pipe(Effect.provide(DurableSupport))
```

Three identities are kept apart underneath: the **session** (the conversation),
the **submission** (one prompt and its follow-up chain), and the **execution**
(one workflow run, keyed `${name}:${sessionId}:${submissionId}`). Sequential
prompts run in fresh executions while canonical history crosses between them
through the `DurableSessionStore`, which is also where status, the active
claim, and pending elicitation requests are projected — so `history`, `status`,
`pending` and `respond` answer from any process, including one that never saw
the prompt.

What that buys, concretely:

- **Handles are disposable.** Closing a `createSession` scope ends the handle;
  the durable session and any running submission continue. `session(id)`
  reacquires it from shared state — a session created by a process that has
  since died is still there.
- **At most one submission per session.** `claim` is one atomic store
  transition, so two concurrent `prompt`s from two processes yield exactly one
  acceptance and one `AgentBusyError`.
- **Accepted work is owed an outcome.** The claim persists the request before
  dispatch, and an answer is persisted before it wakes the workflow; a process
  lost in between leaves a record that the next `session(id)` reconciles.
- **Only completed turns survive.** `interrupt` routes through the session's
  own interruption inside the workflow, so committed turns stay committed and
  the session returns to `idle`; a failed submission keeps its history exactly
  as a local one would.
- **Events come from a `DeliveryLog`**, separate from the workflow journal:
  keyed by semantic coordinates so a replay lands each event once (a disagreeing
  replay is reported as a conflict, never hidden), numbered by a session-wide
  offset so a client resumes with `read({ after })`. Tool results cross in
  their encoded form (`AgentEvent.toWire`). No per-token activities exist.

Three clients can address one session — a web request starts it, a Slack bot
answers its approval question, a CLI queues a follow-up — and none of them hold
a fiber. See [`examples/durable-client.ts`](./examples/durable-client.ts).

The local and durable implementations pass the same conformance suite
(`test/AgentClientContract.ts`); the durable one is additionally proven across a
real runner loss on SQLite (`test/DurableAgentClientSql.test.ts`).

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

## Talking to a session across a boundary

> The full reference for transports, wire encoding, SSE framing, live vs.
> durable delivery and Durable Streams is [docs/transport.md](./docs/transport.md).

`@doeixd/effect-agent/client` is the seam adapters implement — RPC, HTTP/SSE,
AG-UI, A2A — so each does not invent its own notion of what a session is:

```ts
import { AgentClient } from "@doeixd/effect-agent/client"

const client = yield* AgentClient.AgentClient
const session = yield* client.createSession({ sessionId: "researcher-1" })

const result = yield* session.prompt("research this")
yield* session.steer("focus on runtime semantics")
yield* session.prompt("and this", { stream: true })
yield* session.events.pipe(Stream.runForEach(render))
```

The same five operations and the same event stream as a local session, in terms
that can cross a process boundary — including the request-level `stream`
option, without which the seam could not ask for the behaviour `events` exists
to expose.

It is deliberately narrower: a caller on the far side has no access to the tool
definitions, and a provider response is not a value a protocol can carry — so
`RemoteResult` drops it rather than half-encoding it, and a tool's typed failure
arrives as `AgentExecutionError` carrying the originating tag.

That is deliberately *not* `AgentTransportError`. An agent failure is a property
of the request and will recur, so wearing the transport tag would turn a
caller's retry policy into a loop with a model call per attempt. The same
reasoning gives a missing session its own `AgentSessionNotFoundError`: a
lookup that can never succeed is not a transport hiccup either. Failures that
*are* part of the protocol stay typed, because every one of them is a
`Schema.TaggedError`.

`AgentClient.layer(agent)` is the in-process implementation: useful on its own,
and the reference other transports are checked against.

## AG-UI

`@doeixd/effect-agent/ag-ui` projects that same session contract onto the
official AG-UI HTTP/SSE protocol:

```ts
import { AgentAgUi } from "@doeixd/effect-agent/ag-ui"
import { AgentClient, AgentProtocol } from "@doeixd/effect-agent/client"

const AgUiLive = AgentAgUi.serverLayer({
  principal: { resolve: ({ headers }) => authenticate(headers) },
  session: {
    resolve: ({ principal, input }) =>
      Effect.succeed(
        AgentProtocol.SessionId.make(`${principal.id}:${input.threadId}`)
      )
  },
  authorization,
  maxSessions: 100,
  maxRequestsPerSession: 32
}).pipe(Layer.provide(AgentClient.layer(Researcher)))
```

Mounting the layer serves `POST /ag-ui`. It accepts the official
`RunAgentInput` wire shape and emits official JSON SSE events; the conformance
suite runs through `@ag-ui/client` 0.0.58 as well as plain `fetch`.

The application resolves an untrusted AG-UI `threadId` together with an
authenticated principal into a harness session id. Client-provided tools,
context, state and forwarded properties are rejected until they have an
unambiguous harness meaning. Text prompts, batch and streaming replies, tool
lifecycle events, failures and interruption are supported. Harness
elicitations become AG-UI interrupt outcomes; a later `resume` entry answers
the suspended run through the existing session `respond` operation.

Disconnecting the SSE observer does not cancel the host-owned prompt. Repeating
the same `runId` joins or replays the idempotent operation; explicit protocol
interruption remains the only cancellation request.

Protocol values can be built without repeating discriminants or widening away
their exact types:

```ts
const run = AgentAgUi.run({ threadId, runId })

const output = AgentAgUi.events(
  ...run.text.message({
    id: messageId,
    role: "assistant",
    text: result.text
  }),
  run.success(result)
)
```

`output` remains a readonly tuple of start/content/end/finished event types.
`AgentAgUi.event(type, fields)` is the checked escape hatch; `text`, `tool`,
`step`, and `run` expose one-to-one constructors, while `text.message`,
`tool.call`, `run.success`, and `run.interrupt` are pure semantic macros. These
functions only construct Schema-derived values—delivery remains a separate
HTTP/SSE concern.

## Durable Streams

`@doeixd/effect-agent/durable-streams` integrates the official
[Durable Streams](https://github.com/durable-streams/durable-streams)
protocol through its official client, as two things:

- **`DurableStreams`** -- a schema-typed stream at a URL. `make({ url, schema })`
  gives `create` / `ensure` / `head` / `append` / `read` / `close` / `delete`
  and an idempotent `producer`. `read({ after, live })` is an ordinary Effect
  `Stream` of `{ value, offset }`: catch-up, then tail, resumable from any
  offset; a record that does not decode fails the read rather than being
  skipped. A record's `offset` is always safe to resume after: exact at a
  batch boundary (every live-tailed record, every completed read), and
  re-delivering the batch for a checkpoint taken mid-batch -- at-least-once,
  never loss. `fold` replays typed deltas into state, from the start or from a
  snapshot's offset. There is no second stream datatype: a durable stream is
  somewhere a `Stream` comes from.
- **`DurableStreamsDeliveryLog`** -- the durable client's `DeliveryLog` on one
  stream per session. The log's two numbers are kept apart from the protocol's
  offsets: the **key** is an event's identity under replay (a key's first
  occurrence is the event; later ones are skipped by every reader, a
  disagreeing one is a `Conflict`), and the **sequence** is the record's
  position among first occurrences, counted from the stream by every reader
  in every process -- so no writer assigns it and no two can disagree.
  `live` is the protocol's own tail, which is what the memory and SQL logs
  cannot offer across processes.

```ts
import { DurableAgentClient } from "@doeixd/effect-agent/durable"
import { DurableStreamsDeliveryLog } from "@doeixd/effect-agent/durable-streams"

const delivery = yield* DurableStreamsDeliveryLog.make({ baseUrl: "https://streams.example/sessions" })
const Client = DurableAgentClient.layer("agent", agent, { store, sessionStore, delivery })
// Any process: session.events tails live; DeliveryLog.read({ after }) catches up.
```

What stays separate, on purpose: the workflow journal (computation
durability), the canonical transcript (semantic state), and this log (what a
client observes -- token deltas and tool progress included, none of it
canonical). Offsets are batch positions the client reports, never semantic
state. Session streams are never closed by the log; `close` is for finite
streams. Forking is not in the client at this version and is deferred rather
than emulated. Auth composes at the HTTP boundary (`headers`, `fetch`).

## Permissions

Between "the model asked for a tool call" and "the handler runs" there is one
decision, and `Permission` is where it is made. It is deliberately not the
sandbox (the physical boundary of what a call can affect -- an approval never
widens it) and not `Elicitation` (how an undecided question gets its answer).
A policy says one of three things about one invocation:

```text
Allow   run it
Ask     someone outside decides; the run pauses on an Elicitation
Deny    refuse it
```

```ts
import { Agent, Permission, ToolExecution } from "@doeixd/effect-agent"

// The tool says what it *is*, for policy purposes; the policy never parses
// a parameter schema. Without an annotation the action is "tool" and the
// resource is the tool's name.
const Bash = Permission.annotate(
  Tool.make("bash", { parameters: Schema.Struct({ command: Schema.String }), success: Schema.String }),
  { action: "shell", resource: ({ command }) => command }
)

const agent = Agent.make({
  toolkit: Agent.toolkit([Bash, Read], { ... }),
  permission: Permission.rules(
    [
      { action: "shell", resource: /^git (status|diff)/, decision: Permission.allow },
      { action: "shell", resource: /^git push/, decision: Permission.ask("remote write") },
      { action: "shell", resource: /rm -rf/, decision: Permission.deny("destructive") },
      { tool: "read", decision: Permission.allow }
    ],
    { otherwise: Permission.ask() }   // required: nothing is allowed by omission
  ),
  // What a refusal does: fail the run (default), or tell the model so it
  // can take another route. The call never runs either way.
  toolDenialPolicy: ToolExecution.ReturnToModel
})
```

The rules, exactly:

- **Conservative combination.** `Deny > Ask > Allow`, everywhere decisions
  meet: `Permission.combine`, `Permission.all`, and within `Permission.rules`,
  where every matching rule counts and the order of the list is never
  load-bearing -- an `ask` listed above a `deny` cannot shadow it.
- **The tool's own `needsApproval` is a floor.** It is *evaluated* -- a
  function of the parameters and the conversation, as Effect AI defines it,
  not treated as `true` because it is a function -- and the result is at
  least an `Ask` whatever the policy says. No option lowers it.
- **A policy cannot fail.** `evaluate` has no error channel; a policy that
  cannot decide decides `Deny` and says why. A projection that throws is a
  bug and the call dies.
- **`Ask` is an `Elicitation`** of kind `tool-approval`, whose detail carries
  the tool, the call id, the action, the resource and the policy's reason.
  Locally it is a `Deferred`; under `/durable` a `DurableDeferred`, so a
  question asked today can be answered tomorrow from another process.
- **"Allow always" is two things**: the answer to this question, and a grant
  the policy keeps. A granted answer with `value: { remember: true }` calls
  the policy's `remember`; `Permission.remembered(policy)` keeps grants in
  memory, keyed by exact action and resource, and a grant never overrides a
  `Deny`. A refused answer records nothing.
- **Decisions are journalled under `/durable`** (`DurablePermission`), like
  tool calls: a replay after process loss sees the decisions it made, so a
  policy tightened overnight cannot "deny" a call whose side effect already
  happened. New calls get the policy now in force.

What belongs elsewhere: who may *control* the agent (answer this question,
read that session) is transport authorization, on the client and adapters;
what an approved call can physically touch is the sandbox.

## OpenAI-compatible chat completions

`@doeixd/effect-agent/openai` serves `POST /v1/chat/completions` over any
`AgentClient`, so an OpenAI SDK -- or anything that speaks to one -- can talk
to an agent without knowing the harness exists. It is an *inference* surface,
not the full session protocol: prompt, response, streaming. Steering,
follow-ups, interrupts, elicitation answers, history and status stay on the
native HTTP / RPC client, and several surfaces may front one session.

```ts
import { OpenAiAgent } from "@doeixd/effect-agent/openai"
import { AgentClient } from "@doeixd/effect-agent/client"

const OpenAiLive = OpenAiAgent.serverLayer({ model: "research-agent" }).pipe(
  Layer.provide(AgentClient.layer(agent))
)
// The same layer over a durable client, unchanged:
//   OpenAiAgent.serverLayer({ model: "research-agent" }).pipe(
//     Layer.provide(DurableAgentClient.layer("research", agent, stores))
//   )
```

Two conversation semantics, kept apart:

- **Strict mode** (the default, what an OpenAI SDK expects): `messages` is the
  whole conversation. Each request runs as a fresh session whose one prompt is
  those messages; the history stays with the caller.
- **Stateful extension**: an `x-agent-session-id` header (configurable)
  addresses one persistent session, created on first use. Its history is
  authoritative, so only the *delta* is submitted -- the user messages after
  the last assistant message; system and developer messages are the agent's
  to supply and are dropped. A request with no delta is a 400.

Tools stay inside the harness: the agent runs its own tools and the caller
receives the assistant's text, streamed as content deltas (role first, finish
chunk, `[DONE]`). Reasoning is not forwarded. A failed run is a 422 whose
`code` is the originating error's tag; a transport failure is a 503; a busy
or closed session is a 409; an unknown `model` is a 404 -- a retry policy
can tell them apart.

An `idempotency-key` header (configurable) makes a retried request return the
first one's result: the same key and the same request join in-flight or
completed work, a different request under the same key is a 400. In strict
mode the key also names the session, so a durable backend refuses a retry
that lands on *another* process while the work is still running (409) and
replays the answer from the session's history once it is done -- without the
two processes sharing an idempotency store. The default store is
process-local memory; supply `idempotency.store` to share one.

Authentication is not agent semantics: compose HTTP middleware around the
router. The layer is host-independent and lives on Effect's `HttpRouter`.

## A2A v1

`@doeixd/effect-agent/a2a` exposes a Harness agent through the official A2A v1
JSON-RPC protocol:

```ts
import { AgentA2A } from "@doeixd/effect-agent/a2a"
import { AgentClient, AgentProtocol } from "@doeixd/effect-agent/client"

const A2ALive = AgentA2A.serverLayer({
  card: {
    name: "Researcher",
    description: "Researches a question",
    version: "1.0.0",
    skills: [{
      id: "research",
      name: "Research",
      description: "Research a text question",
      tags: ["research"],
      examples: ["How does structured concurrency help agents?"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"]
    }]
  },
  principal: {
    resolve: ({ headers }) => authenticate(headers),
    subject: (principal) => principal.id
  },
  session: {
    resolve: ({ principal, contextId }) =>
      Effect.succeed(
        AgentProtocol.SessionId.make(`${principal.id}:${contextId}`)
      )
  },
  authorization,
  maxSessions: 100,
  maxRequestsPerSession: 32
}).pipe(Layer.provide(AgentClient.layer(Researcher)))
```

Mounting the layer serves the v1 card at
`/.well-known/agent-card.json` and native JSON-RPC at `/a2a`. The current slice
supports blocking text `SendMessage` and owner-scoped `GetTask`; carrying the
returned task's context id into another message continues the same Harness
session. `CancelTask` interrupts an active Harness run, stores the canceled
terminal state, and leaves that session usable.

`SendStreamingMessage` emits native JSON-RPC SSE in exact task, working,
artifact, completed order. Disconnecting the SSE response stops observation but
does not cancel the task; the official SDK generator continues under the server
layer so its task store reaches the terminal state. Explicit `CancelTask` ends
a live stream with a canceled status. The Agent Card therefore advertises
streaming, while push notifications remain disabled.

A run that pauses for an answer — tool approval, or any `Elicitation`
question — surfaces as the A2A `input-required` task state with the question
rendered in the status message. A follow-up message carrying the same task id
supplies the answer: the text is granted to the pending request and the task
completes with the run's final answer. REST remains planned rather than
silently accepted.

### Talking to another agent's A2A endpoint

The reverse direction is covered too. `AgentA2A.client` discovers the card,
wraps the official client in Effect terms — typed errors instead of
rejections, a `Stream` instead of an async generator — and `AgentA2A.typed`
adds a schema-driven request/result exchange over text parts:

```ts
const agent = yield* AgentA2A.client({ url: "https://peer.example/a2a" })

const exchange = AgentA2A.typed({
  request: Schema.Struct({ question: Schema.String }),
  result: Schema.Struct({ answer: Schema.String })
})
const reply = yield* exchange.exchange(agent, {
  contextId: "",
  request: { question: "What changed?" }
})
```

Remote refusals ("no such task", "not cancelable") arrive as
`AgentA2ARemoteError`, distinct from `AgentA2ATransportError`: one is an
answer, the other means the same call may succeed on another connection.
Conformance runs against a real official-SDK server in both directions.

## MCP

`@doeixd/effect-agent/mcp` exposes an agent to MCP clients as a tool:

```ts
import { AgentMcp } from "@doeixd/effect-agent/mcp"
import { McpProtocol, McpServer } from "effect/unstable/ai"

AgentMcp.layer.pipe(
  Layer.provide(McpServer.layerStdio({
    name: "researcher",
    version: "1.0.0",
    protocols: [
      McpProtocol.v2025_11_25,
      McpProtocol.v2025_06_18,
      McpProtocol.v2025_03_26,
      McpProtocol.v2024_11_05
    ]
  })),
  Layer.provide(AgentClient.layer(Researcher))
)
```

The handler talks to `AgentClient`, not to the harness, so MCP is a protocol
adapter over the transport seam rather than a second way in. Passing a
`sessionId` continues a conversation across calls; omitting it gives a one-shot
session, which is the right default for an unrelated question.

The pinned Effect server supports the legacy revisions shown above, latest
first. Official SDK v1.30 and v2.0 clients exercise this server over real
Streamable HTTP and child-process stdio transports; a v2 client in automatic
mode falls back to `2025-11-25`. Named conversations are released when the
server layer closes, while anonymous calls release their sessions immediately.

### Using a remote server's tools, with types

An MCP server's tool list is a runtime value — `tools/list` returns JSON Schema
while the program is already running — and inference is a compile-time
operation. Nothing can infer a type from that.

So the types come from a local declaration and the server is checked against it:

```ts
const Search = Tool.make("search", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.Struct({ hits: Schema.Array(Schema.String) })
})

const toolkit = yield* McpToolkit.bind(connection, [Search])
const agent = Agent.make({ toolkit })
```

`bind` verifies on connect that the server offers each declared tool, failing
with `McpToolMissingError` that names both what is missing and what is on
offer. From then on the agent has exact tool types, and the declared schema is
the decoding contract in both directions: parameters are encoded through it on
the way out, results decoded through it on the way back, so a server that
answers the wrong shape fails at the boundary rather than handing `unknown` to
the agent. A tool that *reports* a failure — MCP's `isError` — is decoded
against the declared `failure` schema and reaches the agent as itself, so the
run's `FailurePolicy` applies and the model can react to a refusal instead of
the run ending. For tools genuinely discovered at runtime, Effect AI's
`Tool.dynamic` is the honest alternative, and the two compose.

`McpToolkit.Connection` stays independent of either official TypeScript SDK
generation. The default client uses the split v2 SDK and automatically
negotiates modern discovery or falls back to the legacy initialize handshake:

```ts
import { McpClient, McpToolkit } from "@doeixd/effect-agent/mcp"

const connection = yield* McpClient.streamableHttp({
  url: new URL("http://localhost:3000/mcp"),
  clientInfo: { name: "researcher", version: "1.0.0" }
})

const toolkit = yield* McpToolkit.bind(connection, [Search])
```

The connection is scoped: leaving the surrounding Effect scope closes the SDK
client and its transport exactly once. `McpClient.stdio` provides the same
contract for a spawned server process.

Applications whose public types still use the monolithic SDK import the
isolated compatibility adapter instead:

```ts
import { McpClientV1 } from "@doeixd/effect-agent/mcp/v1"

const connection = yield* McpClientV1.streamableHttp({
  url: new URL("http://localhost:3000/mcp"),
  clientInfo: { name: "legacy-client", version: "1.0.0" }
})
```

The v1 subpath supports `@modelcontextprotocol/sdk >=1.10.0 <2.0.0` and is an
optional peer dependency. The repository compiles it against 1.10.0 and runs
the conformance suite against the latest declared v1 dependency. The v1 and v2
client classes intentionally cannot cross adapters; only normalized Harness
values cross into `/mcp`. Real Streamable HTTP and child-process stdio tests
cover all four v1/v2 client/server combinations and assert legacy fallback
versus modern negotiation explicitly. The stdio suite also verifies modern
request cancellation and scope-bound process cleanup. Malformed discovery and
tool responses from either SDK generation become typed `McpTransportError`
values. Rich image, resource-link and embedded-resource content is never
discarded or leaked as an SDK-owned value: until the neutral adapter defines a
stable representation for those blocks, calls fail explicitly with
`McpUnsupportedContentError` naming the tool and content kinds.

One server-side limitation belongs to the current Effect MCP transport rather
than the Harness adapter. With `effect@4.0.0-rc.111`, legacy
`notifications/cancelled` from official clients do not reach the numeric
request fiber: the server converts the request id to a string before lookup.
Streamable HTTP also assigns the cancellation POST a different transport client
identity. Closing the server scope still interrupts in-flight work and releases
every session deterministically, but protocol-level cancellation against the
Harness MCP server must remain disabled until the upstream transport preserves
the original request identity.

## Sandbox

`@doeixd/effect-agent/sandbox` is a scoped filesystem-and-process capability
that user-defined tools demand through the ordinary requirement channel. It
exists to prove the composition the whole design bets on — nothing here
changes the agent core, and no first-party coding tools are exported:

```ts
const ReadFile = Tool.make("read_file", {
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.String,
  failure: Schema.String,
  dependencies: [Sandbox.Current]
})

const toolkit = Agent.toolkit([ReadFile], {
  read_file: ({ path }) =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.Current
      return yield* Sandbox.readText(sandbox)(yield* Sandbox.path(path))
    }).pipe(Effect.mapError((error) => error.message))
})
```

`Sandbox.path` is where raw model output becomes a usable value: absolute
paths, drive qualifiers and any `..` segment are refused with a typed error,
so traversal is unrepresentable past that boundary. The workspace arrives as
a layer — deterministic in-memory worlds for tests, a real directory for
everything else — and swapping providers rewrites one line of wiring while the
agent and every handler stay untouched:

```ts
Layer.provideMerge(
  Sandbox.currentLayer(Sandbox.workspace("coding-agent")),
  MemorySandbox.layer({ seed: { "src/add.test.ts": "..." } })
)
// or, from the Node-only entry `@doeixd/effect-agent/sandbox/local`:
LocalSandbox.layer()
```

The local provider creates a fresh temporary directory per acquisition and
removes it when the acquiring scope closes; commands run without a shell,
with exact executable/argument separation, time limits and bounded output.
Its documentation states plainly what it is not: **a security boundary**. It
runs with your program's full privileges.

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
- [`examples/authoring.ts`](./examples/authoring.ts) — the pipeable and
  object authoring styles, bound tools, a bundle and `Agent.run`
- [`examples/tracing.ts`](./examples/tracing.ts) — OTLP export
- [`examples/anthropic.ts`](./examples/anthropic.ts) — a real provider
- [`examples/durable.ts`](./examples/durable.ts) — durable execution and the
  cluster client; the snippets above are lifted from it, so they are
  type-checked rather than prose
- [`examples/durable-client.ts`](./examples/durable-client.ts) — one program
  over `AgentClient`, run locally and durably by swapping a Layer; three
  clients addressing one durable session
- [`examples/sandbox.ts`](./examples/sandbox.ts) — user-defined coding tools
  over the sandbox seam; provider swap is one line of layer wiring

## Runtimes

The package declares no Node engine requirement, because it has none: every
entry except `@doeixd/effect-agent/sandbox/local` reaches the host only
through Effect's platform services (`SqlClient`, `HttpServer`, `HttpClient`,
…), and the application supplies the concrete Layer for Node, Bun, Deno or an
edge runtime. The local sandbox provider spawns processes and reads a real
filesystem; it is Node-specific and lives at its own entry so that importing
the portable sandbox surface never loads it. MCP over stdio loads the SDK's
stdio transport only when `stdio(...)` is called.

This is verified, not promised: `npm run lint:portability` rejects host
coupling in portable source, and `npm run verify:package` imports every entry
of the packed artifact under a resolution hook that refuses Node built-ins and
resolves without the `node` export condition.

Developing the library itself does use Node (the test suite runs SQLite
through `node:sqlite`, which needs Node 22.5 or later).

## Development

```bash
npm run check   # typecheck + Effect language service + portability + tests
npm run build
npm run verify:package
```

[`PLAN.md`](./PLAN.md) is the design authority; [`STATUS.md`](./STATUS.md)
records what is built and why. [`AGENTS.md`](./AGENTS.md) holds the conventions.

## License

MIT
