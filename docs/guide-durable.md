# Durable execution

The same `Agent` value run inside an Effect `Workflow`, across a cluster,
and behind the `AgentClient` seam. Ships as the experimental subpaths
`/durable`, `/cluster` and `/durable-streams`. The runnable proof is
[`examples/durable-resume.ts`](../examples/durable-resume.ts)
(`npm run smoke:durable-resume`): four processes over one SQLite file.

The same `Agent` value, interpreted durably — no redefinition, no separate
framework:

```ts
import { DurableAgent, DurableChannels } from "affe-agent/durable"

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
twice. A SQLite-backed submission also survives losing the process while it is
durably parked and resumes when another process answers the outstanding wait.
A real multi-node cluster additionally reassigns a shard when its owner dies
during a model activity; the peer replays completed activities and redelivers
only the unfinished call. `SingleRunner` cannot perform peer failover and does
not make that claim. Canonical history is not stored: it is rebuilt from
replayed activity results.

**A tool interrupted mid-call is not reissued unless it says it may be.**
Upstream's `Activity` retries an interrupted effect up to ten times, which for
a tool means the refund goes out ten times rather than twice. So a handler is
reissued only when its tool is annotated `Tool.Idempotent` -- upstream's own
annotation, the one emitted as the MCP `idempotentHint`, which defaults to
`false`. A tool nobody has thought about is assumed to have side effects.

When a non-idempotent handler is interrupted, its outcome is genuinely
unknown, and the run ends with `DurableToolUnresolvedError` rather than an
invented answer. It ends as a *defect* on purpose: a typed tool failure would
be shown to the model under the default `ReturnToModel` policy, and the
model's reasonable next move on "charge failed" is to charge again. Annotate
the tools that can safely be repeated:

```ts
const readBalance = Tool.make("read_balance", { /* ... */ })
  .annotate(Tool.Idempotent, true)
```

The window this does not close: if the process dies before the engine persists
the journal entry recording the unknown outcome, the call is unjournalled and
a replay runs it. Only the engine's write can close that, so the guarantee is
at-most-once for interruption, not for power loss.

`result` yields an `Exit`, because a failed submission is still a *completed*
workflow. Its failure crosses as a typed `DurableAgentFailure` carrying the
originating error's tag, not an opaque defect.

Steering and follow-ups are queued through the same store, so they reach a
submission running in another process, and they are drained exactly once. A
`followUp` accepted before quiescence is guaranteed to run; once the submission
closes, further input is refused with `AgentIdleError` rather than accepted and
dropped.

## Across a cluster

Streaming and durability compose, with a caveat worth knowing: the journal holds
one entry per model call containing the completed response, never the individual
deltas. A streamed durable submission commits exactly the history a batched one
does, but its deltas arrive whole. Remote consumers observe them through the
`DeliveryLog` the durable client records into (below), not through the journal.

## The durable client

`DurableAgentClient` provides the ordinary `AgentClient` service over a durable
interpreter, so a program written against the client seam runs unchanged in
either execution mode — and every transport built on `AgentClient` (RPC, HTTP,
MCP, A2A) reaches durable agents without knowing durability exists.

Streaming under durability is live. A `stream: true` prompt reaches the
provider's stream from inside the journalled model activity, and each chunk
is emitted as a `MessageDelta` -- and recorded by the delivery log -- as it
arrives, at the same granularity as the in-process client. The journal still
holds one completed response per model call, never the chunks: on a replay
after process loss the journalled response is re-expressed as one delta per
text part (the original chunking belonged to a connection that no longer
exists), and the keyed delivery log does not duplicate chunks it already
recorded live. A streamed submission commits exactly the history a batched
one does, first run or replay.

```ts
import { AgentClient } from "affe-agent/client"
import {
  DeliveryLog,
  DurableAgentClient,
  DurableChannels,
  DurableSessionStore
} from "affe-agent/durable"

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

Polling policy can stay explicit through the constructors above, or come from
Effect `Config` through `DurableAgentClient.layerConfig`,
`DeliveryLog.sqlLogConfig` / `sqlLogWithTableConfig`, and
`DurableAgent.resultConfig`. The validated defaults and stable environment
names live in `DurablePolling`:

| Environment variable | Default | Controls |
|---|---:|---|
| `EFFECT_AGENT_DURABLE_CLIENT_POLL_INTERVAL` | `10 millis` | initial client outcome poll delay |
| `EFFECT_AGENT_DELIVERY_LOG_POLL_INTERVAL` | `250 millis` | cross-node SQL delivery polling |
| `EFFECT_AGENT_DURABLE_INTERRUPT_POLL_INTERVAL` | `25 millis` | workflow interrupt-intent polling |
| `EFFECT_AGENT_DURABLE_RESULT_POLL_INTERVAL` | `10 millis` | lower-level `DurableAgent.resultConfig` polling |

Values must be positive finite Effect duration strings. Invalid policy fails
with `ConfigError`; it is never silently replaced by a default.

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
a fiber. See [`examples/durable-client.ts`](../examples/durable-client.ts).

The local and durable implementations pass the same conformance suite
(`test/AgentClientContract.ts`); the durable one is additionally proven across a
process loss while the workflow is parked for approval on SQLite
(`test/DurableAgentClientSql.test.ts`). The underlying workflow topology is
also tested with two real HTTP runners: closing the owner during a model
activity makes the peer finish the submission without repeating completed work
(`test/ClusterMultiNode.test.ts`).

`affe-agent/cluster` addresses a session as a cluster `Entity`, so the
session id is the routing key and out-of-band input reaches the owning node.

```ts
import { EntityClient } from "affe-agent/cluster"

const client = EntityClient.wrap(yield* makeRawClient("session-1"))

yield* client.submit("refund order 42")   // Effect<string, never>
yield* client.steer("be brief")           // Effect<void, AgentIdleError>
```

`EntityClient` wraps the generated entity client: it accepts the same
`Prompt.RawInput` the rest of the library does, retries through shard
reassignment, and keeps the cluster's transport failures out of the error
channel — so the only error left is the one a caller can act on.


## Durable Streams

`affe-agent/durable-streams` integrates the official
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
import { DurableAgentClient } from "affe-agent/durable"
import { DurableStreamsDeliveryLog } from "affe-agent/durable-streams"

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

