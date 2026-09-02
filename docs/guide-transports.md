# Transports: a session across a boundary

How a session is driven from another process: the `AgentClient` seam and
the adapters over it (HTTP/SSE, RPC, AG-UI, A2A, MCP, OpenAI-compatible).
The wire-level reference — encoding, SSE framing, live vs. durable delivery
— is [transport.md](./transport.md); the cross-adapter conformance rows are in
[conformance-matrix.md](./conformance-matrix.md).

> The full reference for transports, wire encoding, SSE framing, live vs.
> durable delivery and Durable Streams is [docs/transport.md](./transport.md).

## The client seam

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
arrives as `AgentExecutionError` carrying the originating tag. What it does
carry is `content`: the final assistant message as provider-neutral prompt
parts -- text, reasoning and files, in order -- so a model that answered with
an image reaches a remote caller as more than `text`. The same parts appear on
`MessageCompleted.content`, and under `stream: true` a file that arrives whole
is announced as `MessagePartCompleted` rather than faked as deltas.

```ts
const result = yield* session.prompt("draw the architecture")
for (const part of result.content) {
  if (part.type === "file") save(part.mediaType, part.data) // Uint8Array | string | URL, as produced
}
```

`prompt` waits for quiescence. When the caller cannot -- a webhook that must
answer now, a queue worker that will come back -- `submit` returns at
admission with a receipt, and `awaitSubmission` later returns exactly what
`prompt` would have:

```ts
const { submissionId } = yield* session.submit("index the repository", {
  idempotencyKey: "job-42"   // a retry joins this submission; a different request under it conflicts
})
// ... later, from anywhere holding the session id ...
const result = yield* session.awaitSubmission(submissionId)
```

Outcomes are retained per session under a stated bound
(`maxRetainedSubmissions`, default 64): a settled outcome is evicted only to
admit a newer submission, never while it runs, and after eviction
`awaitSubmission` fails with `AgentSubmissionNotFoundError` rather than
re-running anything. The idempotency key lives exactly as long as the
outcome. The durable client's retention is the journal, which keeps every
outcome. The rule in full: [docs/plan-submit-await.md](./plan-submit-await.md).

That is deliberately *not* `AgentTransportError`. An agent failure is a property
of the request and will recur, so wearing the transport tag would turn a
caller's retry policy into a loop with a model call per attempt. The same
reasoning gives a missing session its own `AgentSessionNotFoundError`: a
lookup that can never succeed is not a transport hiccup either. Failures that
*are* part of the protocol stay typed, because every one of them is a
`Schema.TaggedError`.

`AgentClient.layer(agent)` is the in-process implementation: useful on its own,
and the reference other transports are checked against.

### Typed input over a transport

An agent that declares an `AgentInput` is asked with the schema's type
locally, and the same over any transport. `AgentClient.typed(agent)` is the
spelling: the same `createSession` / `session`, whose sessions' `prompt` and
`submit` take the value. It is encoded with the agent's schema on the way
out and decoded with the same schema by the host that holds the session,
which refuses a mismatch -- a prompt to a typed agent, a value to an untyped
one, or a value the schema rejects -- as `AgentInvalidRequestError` (400)
before anything runs. On the wire the value is `{ "_tag": "TypedInput",
"value": ... }` in the `input` field of a prompt or submit; nothing names
the schema, because the session already declares it. `steer` and `followUp`
still take a prompt, as they do locally. The durable client journals the
encoded value and renders it inside the workflow, where the renderer's
services are; an Effect-valued renderer runs as an activity, so a replay
reads the rendering back instead of rendering again.

```ts
const client = yield* AgentClient.typed(Support)
const session = yield* client.createSession()
yield* session.prompt({ customerId: "c-42", body: "my order is late" })
```

### Multiple agents and authentication

`AgentServer` composes several HTTP-backed hosts without taking ownership of
their policy. Each host keeps its own principal resolver, authorization rules,
capacity and `AgentClient` backend; the server only assigns distinct paths and
adds the read-only `/inventory` projection.

[`examples/agent-server-auth.ts`](../examples/agent-server-auth.ts) is the full
compiling example: one bearer-authenticated support mount and one
cookie-authenticated admin mount, with separate role authorization and
`Config.redacted` credentials. Authentication failures retain the protocol's
typed 401 and authenticated principals crossing a mount's policy receive its
typed 403.

### Conventional CLI

`apps/cli` is a composable command-line client over the same `AgentClient`
contract. It uses `effect/unstable/cli` for parsing/help and Effect `Terminal`
for output; it does not embed a second agent runtime. Point it at any mounted
HTTP agent, local or durable:

```sh
npm run cli -- create --id demo
npm run cli -- prompt demo "research this"
npm run cli -- status demo --json
npm run cli -- follow-up demo "also compare alternatives"
npm run cli -- respond demo approval-1 allow
```

`--url` falls back to `EFFECT_AGENT_URL` and then
`http://127.0.0.1:3000`. `--token` falls back to `EFFECT_AGENT_TOKEN`; the
value stays `Redacted` until the HTTP authorization header is built. See
[`apps/cli/README.md`](../apps/cli/README.md) for the command inventory.

## AG-UI

A user message may carry AG-UI's typed input parts as well as a string:
`text`, and `binary` with inline base64 `data` or a `url`, which become
`Prompt.FilePart`s with the declared `mimeType` and `filename`. A binary part
referenced only by `id` is refused as `binary-input-by-id` -- there is no
upload store behind this adapter -- and malformed base64 is an invalid
input. Output stays AG-UI's text event vocabulary.

`@doeixd/effect-agent/ag-ui` projects that same session contract onto the
official AG-UI HTTP/SSE protocol:

```ts
import { AgentAgUi } from "@doeixd/effect-agent/ag-ui"
import { AgentClient, AgentProtocol, AgentSessionHost } from "@doeixd/effect-agent/client"

// The host -- registry, capacity, authentication, authorization -- is one
// service the adapters share. Make a tag for the principal type once:
const Host = AgentSessionHost.Tag<User>("app/host")
const HostLive = AgentSessionHost.layer(Host, {
  principal: { resolve: ({ headers }) => authenticate(headers) },
  authorization,
  maxSessions: 100,
  maxRequestsPerSession: 32
}).pipe(Layer.provide(AgentClient.layer(Researcher)))

const AgUiLive = AgentAgUi.serverLayer({
  host: Host,
  session: {
    resolve: ({ principal, input }) =>
      Effect.succeed(
        AgentProtocol.SessionId.make(`${principal.id}:${input.threadId}`)
      )
  }
}).pipe(Layer.provide(HostLive))
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


## OpenAI-compatible chat completions

Message content may be the typed parts Chat Completions defines: `text`,
`image_url` (a `data:` URL is decoded to bytes with its own type; a remote
image stays a URL typed `image/*`), `input_audio`, and `file` with inline
`file_data`. A `file_id` is refused as an `invalid_request_error`
(`unsupported_file_id`) rather than silently dropped. The assistant's reply
is text, as the protocol defines it.

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

Messages carry `raw` bytes and `url` parts as well as text, in and out: a
file the model returns is a `raw` (or `url`) part of the response message and
artifact with its media type and filename, and file parts in an incoming
message reach the agent as `Prompt.FilePart`s. Structured `data` parts are
refused by name.

`@doeixd/effect-agent/a2a` exposes a Harness agent through the official A2A v1
JSON-RPC and HTTP+JSON protocols:

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
  host: Host,
  // A2A needs one thing the host does not: a stable owner key for the
  // official task store.
  principal: { subject: (principal: User) => principal.id },
  session: {
    resolve: ({ principal, contextId }) =>
      Effect.succeed(
        AgentProtocol.SessionId.make(`${principal.id}:${contextId}`)
      )
  },
}).pipe(Layer.provide(HostLive))
```

Mounting the layer serves the v1 card at
`/.well-known/agent-card.json`, native JSON-RPC at `/a2a`, and the v1 REST
resources below `/a2a` (`message:send`, `message:stream`, task get/list,
subscribe, cancel, and push-configuration resources). Both bindings use one
official SDK request handler, task store, and event-bus manager. The adapter
supports blocking text `SendMessage` and owner-scoped `GetTask`; carrying the
returned task's context id into another message continues the same Harness
session. `CancelTask` interrupts an active Harness run, stores the canceled
terminal state, and leaves that session usable. Push routes return the protocol's
capability error because the card deliberately advertises push notifications as
disabled.

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
completes with the run's final answer.

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

For an application serving more than one frontend, use the shared host path so
MCP, HTTP, RPC, AG-UI and A2A see one registry and one capacity policy:

```ts
import { AgentSessionHost } from "@doeixd/effect-agent/client"
import { AgentMcp } from "@doeixd/effect-agent/mcp"
import { McpServer } from "effect/unstable/ai"

const Host = AgentSessionHost.Tag<User>("app/AgentSessionHost")

AgentMcp.serverLayer({ host: Host }).pipe(
  Layer.provide(HostLive),
  Layer.provide(McpServer.layerStdio({
    name: "researcher",
    version: "1.0.0"
  }))
)
```

On Streamable HTTP, MCP authorization headers reach the host's ordinary
principal resolver. Stdio has no request headers and is treated honestly as a
single-user process transport. The shared-host layer exposes `ask_agent` plus
`agent_start`, `agent_await`, `agent_close`, `agent_steer`, `agent_follow_up`,
`agent_interrupt`, `agent_status`, and `agent_respond`. `ask_agent` remains one-shot:
an anonymous call releases its session as soon as the call ends. An anonymous
`agent_start` instead returns its generated `sessionId`; the run outlives that
tool call and the client releases it explicitly with `agent_close`.

The same layer exposes authenticated `agent://session/{id}/history` and
`/pending` resource templates. A complete cast-free stdio composition is in
[`examples/mcp-frontend.ts`](../examples/mcp-frontend.ts).

`agent_await` can be called more than once and never starts the prompt again.
Its retained ticket table is bounded by the host's `maxSessions` and
`maxRequestsPerSession`, evicts only settled entries, and refuses admission
when every eligible slot is still in flight. Every await authenticates and
authorizes against the ticket's session, so a request id is not a bearer token.
Steering changes the active run at its next safe model boundary; follow-up adds
a sequential run under the same submission and await ticket; interrupt stops
the active run, after which await returns an `interrupted` result.

`agent_status` returns session state and pending elicitation requests together;
`agent_respond` answers one pending id. When a stdio client advertises MCP form
elicitation, a tool-approval question is presented natively during
`agent_await`/`ask_agent` and its answer resumes the run. The unsupported policy
is configurable as `pending` (the default), `deny`, or `fail`; none grants
silently.

With the pinned Effect transport (rc.112 at the time of writing), Streamable HTTP cannot flush a reverse
elicitation request while the originating tool call is open. HTTP therefore
uses the explicit status/respond path even when the client advertises forms;
calling native elicitation there would hang. This restriction is transport
gating, not a permission fallback, and can be removed when the upstream
transport supports the full-duplex exchange.

There is one way in. The client-backed `AgentMcp.layer` / `handlers` path,
which kept a one-tool `ask_agent` surface and evicted the oldest idle
conversation at capacity, was removed on 2026-08-30: a conversation a client
can still address must not vanish because another client opened one, so the
host *refuses* a newcomer at `maxSessions` and the operator raises the number.
A stdio server with one caller is a host with a constant principal and
`allowAll` -- see `examples/mcp.ts`.

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
than the Harness adapter. With the pinned Effect (`4.0.0-rc.112`), legacy
`notifications/cancelled` from official clients do not reach the numeric
request fiber: the server converts the request id to a string before lookup.
Streamable HTTP also assigns the cancellation POST a different transport client
identity. Closing the server scope still interrupts in-flight work and releases
every session deterministically, but protocol-level cancellation against the
Harness MCP server must remain disabled until the upstream transport preserves
the original request identity.

