# Transport: how a session crosses a boundary

This is the reference for everything that moves a session's operations and
events between processes: the client seam, the transports that implement
it, what goes on the wire and how it is encoded, how streams are framed, and
what *durable* delivery adds on top of *live* delivery. It assumes you know
what an `AgentSession` is (see the README); it explains how one is reached
from somewhere else.

The one idea to hold on to:

```text
semantic layer      AgentEvent, Prompt, RemoteResult, RemoteError
                          │  Schema, everywhere, in both directions
client seam         AgentClient.Service  (createSession / session → RemoteSession)
                          │
transports          in-process · Effect RPC · HTTP+SSE · AG-UI · A2A · OpenAI · MCP
                          │
delivery            live (the session's bus)  or  durable (DeliveryLog: memory / SQL / Durable Streams)
```

Every transport speaks the same vocabulary, defined once in
`@doeixd/effect-agent/client` as `Schema`s. No transport invents its own
notion of a session, a result, an error, or an event. What differs between
transports is only *how far* the vocabulary is carried and *in what
framing*.

---

## 1. The seam: `AgentClient`

```ts
import { AgentClient } from "@doeixd/effect-agent/client"

interface Service {
  createSession(options?: { sessionId?: string }): Effect<RemoteSession, RemoteError, Scope>
  session(sessionId: string): Effect<RemoteSession, RemoteError>
}

interface RemoteSession {
  readonly id: string
  prompt(input, options?: { stream?: boolean }): Effect<RemoteResult, RemoteError>
  steer(input): Effect<void, RemoteError>
  followUp(input): Effect<void, RemoteError>
  interrupt(): Effect<void, RemoteError>
  respond(response: Elicitation.Response): Effect<boolean, RemoteError>
  readonly pending: Effect<ReadonlyArray<Elicitation.Request>, RemoteError>
  readonly history: Effect<Prompt, RemoteError>
  readonly status: Effect<"idle" | "running" | "closed", RemoteError>
  events(options?: { readonly after?: number }): Stream<AgentEventEnvelope, RemoteError>
}
```

Three things are deliberately narrower than a local session:

- **`RemoteResult` carries no provider response.** A model response is not a
  value a protocol can carry faithfully, so it is dropped rather than
  half-encoded. `text`, `status`, `runs`, `turns`, `submissionId` cross.
- **A tool's typed failure arrives as `AgentExecutionError`** with the
  originating `tag`, `detail`, and `isDefect`. The far side has no access to
  the tool definitions, so it cannot be handed the typed error itself.
- **`events` is what the transport chooses to forward.** Locally it is the
  session's bus. Over HTTP it is an SSE subscription. Over the durable client
  it is a delivery log's live tail. The shape is identical; the *history* a
  subscriber gets differs (§7).

`createSession` is scoped. What closing the scope means is the
implementation's: the in-process client ends the session (its lifetime is
its scope); the durable client releases only the *handle* -- the logical
session outlives every handle and is reacquired with `session(id)` from any
process.

### Errors are part of the protocol

`RemoteError` is a `Schema.Union` of tagged errors, so every failure is
typed on both sides of every transport:

| Error | Meaning | HTTP status |
|---|---|---|
| `AgentInvalidRequestError`, `AgentProtocolCodecError` | the request or a frame could not be decoded | 400 |
| `AgentUnauthorizedError` | no principal | 401 |
| `AgentForbiddenError` | principal not allowed | 403 |
| `AgentSessionNotFoundError` | no such session (a lookup that can never succeed) | 404 |
| `AgentBusyError`, `AgentIdleError`, `AgentClosedError` | the session is in the wrong state for the operation | 409 |
| `AgentSessionAlreadyExistsError`, `AgentRequestConflictError` | identity reuse | 409 |
| `AgentCapacityExceededError`, `AgentRequestCapacityExceededError` | host limits | 429 |
| `AgentExecutionError` | the agent failed (a property of the request; will recur) | 422 |
| `AgentTransportError` | the transport failed (will not necessarily recur) | 503 |

The 422 / 503 split is load-bearing: a caller's retry policy must be able to
tell an agent failure from a transport failure, or it retries a model call
per attempt forever. The same reasoning gives a missing session its own
tag rather than a transport error.

### Request identity

Every mutating call over RPC and HTTP carries a `requestId`. The session host
keeps one entry per `(session, requestId)`: a retry with the same id and the
same payload **joins** the in-flight or completed work and returns its
result; the same id with a different operation or payload is an
`AgentRequestConflictError`. This is what makes a lost acknowledgement safe
to retry. The in-process client has no request ids -- there is no wire to
lose an acknowledgement on.

---

## 2. Encoding: what goes on the wire

Everything that crosses is encoded through `Schema`, and specifically
through the **JSON codec** (`Schema.toCodecJson`), not the in-memory
declaration. The distinction matters for three things:

1. **`Option` fields.** `AgentEventEnvelope.submissionId / runId / turn` are
   `Schema.Option(...)`. In memory that is an `Option`; on the wire it is
   the JSON form the codec defines. Encoding with the plain schema would
   produce an object no decoder on the other side accepts. Every adapter,
   the delivery logs, and the SSE writer use the JSON codec.
2. **Decoded values that do not survive `JSON.stringify`.**
   `ToolCallSucceeded.result` and `ToolCallProgress.result` are the tool's
   *decoded* success value -- a `Date`, a class instance, a branded type. Their
   `encodedResult` twins are JSON by construction (the model receives them).
   `AgentEvent.toWire(envelope)` substitutes `result := encodedResult` once,
   and every recorder and transmitter applies it, so no adapter re-derives
   it and no adapter mangles a `Date` into a string-that-is-not-a-date.
3. **Prompts and tool results in history.** `PromptWire` is the shared JSON
   codec. It restores prompt type ids and exact string / bytes / URL file-data
   variants; decoded tool values that are not JSON fail encoding instead of
   being silently changed.

A value admitted by a schema must encode; failure to do so is a bug in the
producer, not a condition callers handle. Adapters therefore treat encode
failures as defects, with one exception: an individual **event** that fails
to encode for SSE is logged and skipped rather than ending the stream (§4),
because one bad frame must not tear down an otherwise healthy session's
subscription.

---

## 3. Effect RPC: the full-fidelity transport

`@doeixd/effect-agent/rpc` exposes the protocol as an `RpcGroup`:

```ts
import { AgentRpc } from "@doeixd/effect-agent/rpc"

AgentRpc.Protocol     // RpcGroup: createSession, closeSession, getSession, prompt,
                      //           steer, followUp, interrupt, respond, pending,
                      //           history, status, events (stream: true)
AgentRpc.serverLayer({ host })   // host: AgentSessionHost.Tag<Principal>
AgentRpc.clientLayer  // Layer<AgentRpc.Client, never, RpcClient.Protocol>
```

Each procedure's `payload`, `success`, and `error` are the protocol schemas,
so the generated client's methods keep their exact types and `events` is a
typed `Stream`. The RPC layer is transport-agnostic by Effect's design: the
application picks the protocol (`RpcServer.layerHttp`, WebSocket, socket,
worker) and the serialization. The test suite runs it over a real HTTP server
with `RpcSerialization.layerNdjson`; `layerJson` and MsgPack are equally
valid, because nothing here depends on the serialization -- only on the
schemas.

Use RPC when both ends are Effect. It is the reference the other transports
are checked against, and the only one that carries *every* operation with no
loss.

---

## 4. HTTP + SSE: the portable transport

`@doeixd/effect-agent/http` is the same protocol as plain HTTP, for clients
that are not Effect (or not TypeScript):

```text
POST   /sessions                    createSession
DELETE /sessions/:id                closeSession
GET    /sessions/:id                getSession
POST   /sessions/:id/prompt         prompt        { requestId, input, options? }
POST   /sessions/:id/steer          steer         { requestId, input }
POST   /sessions/:id/follow-up      followUp      { requestId, input }
POST   /sessions/:id/interrupt      interrupt     { requestId }
POST   /sessions/:id/respond        respond       { requestId, response }
GET    /sessions/:id/pending        pending
GET    /sessions/:id/history        history
GET    /sessions/:id/status         status
GET    /sessions/:id/events         events        text/event-stream
```

`AgentHttp.Api` is an `HttpApi` definition, so `HttpApiClient.make(AgentHttp.Api, { baseUrl })`
gives a typed client with the same error union as RPC, and `AgentHttp.serverLayer(...)`
registers the routes on the current `HttpRouter`. Errors are JSON bodies of
the tagged error, with the status from the table in §1.

### SSE framing

`GET /sessions/:id/events` is Server-Sent Events, one frame per envelope:

```text
: connected

id: 17
event: MessageDelta
data: {"sessionId":"s","submissionId":{"_tag":"Some","value":"..."},...,"sequence":17,"event":{"_tag":"MessageDelta","kind":"text","delta":"Hel"}}

```

- The `: connected` comment goes out **first, before any event exists**, so
  the response headers reach the client immediately. Without it, `fetch`
  does not resolve and `EventSource` does not open until the session emits
  something -- which for a subscription opened *before* the prompt is
  exactly the interesting case. The subscription is also acquired eagerly
  (the source is run into a queue from the moment the response starts), so a
  client that has connected is observing from then, not from its second
  read.
- `id` is the envelope's `sequence`; `event` is the event's `_tag`; `data` is
  the JSON-codec envelope (§2), with `toWire` applied.
- **A stream failure is one specific frame**:

  ```text
  event: effect/httpapi/stream/failure
  data: <JSON-codec Cause of RemoteError>
  ```

  This is the one event name Effect's `HttpApiClient` recognises as a
  failure of a streaming endpoint; its `data` must decode as a `Cause` of the
  endpoint's declared error. A bespoke `event: error` frame would reach the
  typed client as an envelope that failed to decode rather than as the
  `RemoteError` it is. Non-Effect consumers should treat this event name as
  terminal.
- `cache-control: no-cache, no-store`, `x-accel-buffering: no` are set so
  proxies do not buffer.

The events endpoint is **live by default**: it forwards what the underlying
client's `events` stream forwards (§7). A reconnecting client may send
`Last-Event-ID` (or `?after=`); when the host's client has a delivery log the
stream resumes from that offset, and when it does not the resume fails typed
rather than silently restarting live. Replay itself is the delivery log's
job; SSE only carries the cursor.

### Principals and hosts

Every adapter serves an **`AgentSessionHost`** -- one service, not one per
adapter. The application makes a tag for its principal type
(`AgentSessionHost.Tag<User>("app/host")`), builds it once
(`AgentSessionHost.layer(tag, { principal, authorization, maxSessions,
maxRequestsPerSession })` over an `AgentClient`), and provides it to each
adapter's `serverLayer({ host: tag, ... })`. So HTTP and AG-UI in front of
one client share **one** registry, **one** capacity limit, and **one**
authentication path: a session created through HTTP is reachable through
AG-UI, and it counts once against `maxSessions`. The host enforces the
capacity bounds, resolves a principal per request
(`principal.resolve({ operation, sessionId, headers })`), authorizes it,
and keeps the request-id table. A host in front of the durable client can
**adopt** a session it did not create (`session(id)` falls through to the
client), which is what lets two nodes front one cluster.

`AgentA2A` takes the same host tag plus a `principal.subject` -- the one
thing it needs beyond authentication, a stable owner key to isolate the
official task store.

---

## 5. Protocol projections: AG-UI, A2A, OpenAI, MCP

These are not new transports of the session protocol; they are *projections*
of the same semantic events onto someone else's wire protocol. Each one sits
on `AgentClient` and nothing lower, so each works unchanged over the
in-process and the durable client.

**AG-UI** (`/ag-ui`). `POST /ag-ui` accepts the official `RunAgentInput` and
answers an SSE stream of AG-UI events. The projection is a pure
`transition(state, envelope) → [state, events]` lifted over the stream with
`Stream.mapAccumEffect`; protocol state (open message/tool frames, the run
id) lives in the projection. An `ElicitationRequested` ends the AG-UI run
with `RUN_FINISHED { outcome: { type: "interrupt", interrupts: [...] } }`
carrying the request; the answer comes back as the next run's resume input
on the same endpoint.

**A2A v1** (`/a2a`). JSON-RPC and HTTP+JSON over one official SDK request
handler, task store and event-bus manager. The portable Effect router exposes
the REST send/stream, task get/list/subscribe/cancel and push-configuration
resources without importing the SDK's Express-only adapter. A session is
addressed by `contextId`; a paused run surfaces as `INPUT_REQUIRED` with the
elicitation detail, and the next message on that task answers it. Tasks can be
cancelled while parked. The reverse direction -- an agent calling another
agent -- is `AgentA2A.client` / `AgentA2A.typed`.

**OpenAI** (`/openai`). `POST /v1/chat/completions`. Non-streaming returns a
`chat.completion`; `stream: true` returns SSE of `chat.completion.chunk`
frames -- bare `data:` lines as OpenAI writes them, a role chunk first, then
content deltas, a finish chunk, then `data: [DONE]`. Only text crosses:
tools stay inside the harness. A failed run is a `{"error": ...}` frame then
`[DONE]`. Strict mode runs the caller's `messages` as a fresh session; the
`x-agent-session-id` header addresses a persistent one. `idempotency-key`
joins or replays work (and in strict mode names the session, so a durable
backend refuses a concurrent retry from another process).

**MCP** (`/mcp`). An agent exposed as an MCP server's `ask_agent` tool, and
MCP servers bound as toolkits. stdio transports are loaded lazily so the
portable entry never imports Node.

What they share: *none of them own persistence*, and none of them carry the
whole session protocol. Steering, follow-ups, interrupts, elicitation
answers, history, status and replay are the native client's; a surface that
has no slot for one of those does not emulate it.

---

## 6. Streams: the one runtime

There is one stream type in this library: Effect's `Stream`. A session's
`events` is a `Stream`; an SSE response body is a `Stream` of frames; a
durable stream's `read` is a `Stream` of records; a protocol projection is
`Stream.mapAccum`. Nothing introduces a second stream runtime, a "durable
stream datatype", or a flow engine.

Two conventions keep that honest:

- **Observational streaming.** `MessageDelta`, `MessageStarted`,
  `ToolCallProgress` and the like report generation as it happens; canonical
  history is committed atomically at the end of the turn. A consumer renders
  deltas; the transcript is unaffected by whether it did. A transport may
  forward deltas or not (the durable backend forwards one delta per model
  activity; the in-process one forwards the provider's chunks). Nothing
  downstream may turn a delta into canonical state.
- **Derived streams are logical.** `events.pipe(Stream.filter(isToolEvent))`
  is a derived `Stream`, not a new log. Something becomes *durable* only when
  it is explicitly appended to a `DeliveryLog` or a `DurableStreams` stream.

Interruption is the only way a live subscription ends early, and it
releases the transport resource (the SSE connection, the durable stream's
long-poll) without touching the session or the log.

---

## 7. Delivery: live vs. durable

A session's bus is **live**: a subscriber sees events emitted after it
subscribed, and nothing before. That is what the in-process `events`
exposes. The durable client and HTTP honour `after`, reading the delivery
log first and then going live. The live bus alone is enough for a UI that
is connected while the run happens.

It is not enough for a browser that disconnected at event 137, a Slack bot
that never saw event 1, or a run that outlives the process that started it.
For those there is the **`DeliveryLog`**: the third store, kept apart from
the other two.

```text
Workflow journal      what the computation did   (Effect Workflow activities)
canonical transcript  what the conversation is    (Prompt, committed per turn)
DeliveryLog           what a client observes      (every event, deltas included)
```

```ts
interface DeliveryLog {
  append(sessionId, key, envelope): Effect<"Appended" & { sequence } | "Duplicate" | "Conflict">
  read(sessionId, { after? }): Effect<ReadonlyArray<AgentEventEnvelope>>
  live(sessionId): Stream<AgentEventEnvelope>
}
```

Two numbers, and they are different:

- **`key`** is the event's *identity*. The recorder (`DurableSubmission`)
  derives it from semantic coordinates -- submission, run, turn, tool call id,
  occurrence -- not from a counter, because a counter is not stable under
  replay when tools run in parallel. A replay re-offers the same event under
  the same key and it lands once (`Duplicate`). The same key with a different
  payload is a recorder bug, reported as `Conflict` rather than hidden.
- **`sequence`** is the session-wide *delivery offset*, assigned on
  acceptance. It replaces the envelope's per-process `sequence` on the way
  in. `read({ after })` and a reconnecting client are addressed by it.

The durable client records into the log from inside the workflow, with one
ordering guarantee worth knowing: the submission's **terminal event is
delivered only after history and status have been committed**, so a reader
that acts on `SubmissionCompleted` by fetching `history` sees the transcript
the event describes.

Three implementations:

| | `append` | `live` | across processes |
|---|---|---|---|
| `DeliveryLog.memoryLog` | in memory | PubSub | no |
| `DeliveryLog.sqlLogWithTable()` | SQL row, `BEGIN IMMEDIATE` | poll from the tail, PubSub-woken | yes, both |
| `DurableStreamsDeliveryLog.make({ baseUrl })` | one record on the session's durable stream | the protocol's own tail | yes, both |

The SQL log's `live` is honest across processes: it starts from the
session's current tail and polls the table for rows after the last it
delivered, so a node reconnected elsewhere tails appends another node
made. The in-process `PubSub` is a low-latency wake signal, not the source
of truth -- correctness rests on the poll, so nothing is missed if the
signal does not arrive. `pollInterval` (default 250ms) bounds a
cross-process subscriber's delay. The Durable Streams log's `live` is the
protocol's own tail, with no polling.

---

## 8. Durable Streams

`@doeixd/effect-agent/durable-streams` wraps the official protocol client.
The protocol is a URL-addressable, append-only, ordered byte log with
opaque offsets, catch-up reads, live tailing (SSE or long-poll, the client
chooses), durable close, and fenced idempotent producers. The wrapper adds
only the Effect boundary.

```ts
import { DurableStreams } from "@doeixd/effect-agent/durable-streams"

const events = DurableStreams.make({ url, schema: AgentEvent.AgentEventEnvelope })
yield* events.ensure
yield* events.append(envelope)                              // Schema-encoded JSON
events.read({ after: offset, live: true })                  // Stream<{ value, offset }>
yield* events.close                                         // durable EOF, idempotent
const p = yield* events.producer("writer-1", { epoch: 3 })  // fenced, batched, retry-safe
```

### Offsets are transport positions

An `Offset` is an opaque string. It answers "where is this consumer in the
log", never "what is the state". The client reports positions **per
delivered batch**, so the wrapper's contract is:

> A record's `offset` is a position that is always safe to resume after. It
> is the position *after* the batch on the batch's last record and the
> position *before* the batch on the others. Resuming after any record loses
> nothing; resuming after a record that was not last in its batch
> re-delivers that batch.

At-least-once for a mid-batch checkpoint, exact at a boundary -- and a
completed read, and every live-tailed record (a tail delivers one batch per
append), are boundaries. A consumer that needs exactness across a mid-batch
checkpoint keys its records; the delivery log does.

### Reads

`read({ live: false })` returns the catch-up body as one batch and ends at
up-to-date. `read({ live: true })` (the default) delivers the catch-up batch,
then one batch per append, and ends at EOF. A record that does not decode
fails the read with the `SchemaError` -- after the records that decoded
before it, so a reader can still find its position -- rather than being
skipped. The reader's buffer is unbounded on purpose: a consumer slower than
the network must not lose records. Interrupting a reader aborts its
connection and nothing else.

### `fold`: deltas into state

```ts
const { state, offset } = yield* DurableStreams.fold(deltas, initial, apply)
// later, with a snapshot { state, offset }:
const current = yield* DurableStreams.fold(deltas, snapshot.state, apply, { after: snapshot.offset })
```

The stream stores ordered history; the application's `apply` supplies the
state-transition semantics. A snapshot records the offset it covers, and the
protocol knows nothing about snapshots. A corrupt delta fails the fold; it
never silently mutates state.

### Not in the client at this version

Forking a stream at an offset. It is deferred, not emulated.

---

## 9. Choosing

| You have | Use |
|---|---|
| Effect on both ends, want everything | RPC (`/rpc`) over the protocol layer you already run |
| Non-Effect or non-TypeScript callers | HTTP + SSE (`/http`) |
| A frontend speaking AG-UI | `/ag-ui` |
| Other agents, or an A2A registry | `/a2a` |
| An OpenAI SDK or tool that expects one | `/openai` |
| An MCP host | `/mcp` |
| One process, no boundary | `AgentClient.layer(agent)` -- the same code, no transport |

And independently of the transport: **`AgentClient.layer`** when the
session's life is the process's; **`DurableAgentClient.layer`** when it is
not, with a memory log for tests, the SQL log for one node with a database,
and the Durable Streams log when clients reconnect to different nodes.

Authentication sits at the transport boundary in every case (`principal`
and `authorization` on the hosts, headers on the stream client) and never in
the session, the policy, or the stream.
