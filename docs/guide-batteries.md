# Batteries

Capabilities built only out of the kernel's seams. None of them adds
anything to the engine; each is a service, a `ContextTransform`, an
`AgentLoop`, a tool, or an observer over the event stream. Which seam each
one uses is in the [README's seam table](../README.md#the-mental-model-one-kernel-a-few-seams).

## Subagents

A subagent is a tool that opens a child session — no first-class concept, just
the pieces composing. `affe-agent/subagent` packages that pattern so
you write it once instead of by hand:

```ts
import { Subagent } from "affe-agent/subagent"

const research = Subagent.tool("research", Researcher, {
  description: "Research a question and return a short findings summary.",
  provide: OpenAiLanguageModel.model("gpt-4o-mini")   // the child's own world
})

const Lead = Agent.make({
  instructions: "Delegate research, then decide.",
  tools: [research]                                    // an ordinary bound tool
})
```

`Subagent.tool` returns an `Agent.BoundTool`, so it drops into any agent's
`tools` beside hand-written ones and is gated by a policy like anything else.
Two properties come for free from the structured pieces underneath:

- **Isolation.** The child runs under the model and services named in
  `provide`, supplied there and nowhere else — so parent and child never share
  a conversation, and a cheaper model for a narrow subtask is one argument.
- **Interruption.** The child session opens inside the tool handler's scope,
  which is the parent submission's scope, so interrupting the parent interrupts
  the child through ordinary structured concurrency — no cancellation protocol
  crosses the boundary.

A child failure returns to the parent model as a string on the tool's `failure`
channel by default — "the researcher could not find it" is something the parent
can route around — while a defect still propagates as a bug. Pass
`onError: "die"` to fail the parent run instead.

## Scheduling & self-dispatch

`affe-agent/scheduling` adds two thin things over Effect's own
scheduling — it is not a scheduler runtime. **`AgentDispatcher`** is the
"enqueue future work" seam: a tool calls `Scheduling.dispatch({ input, delay })`
to schedule a follow-up run without touching timers or infrastructure, and a
layer decides where it goes. **`Scheduling.recurring`** runs an agent on a
`Schedule` (including `Schedule.cron`), resiliently — a failing run is logged
and the cadence continues.

```ts
import { Scheduling } from "affe-agent/scheduling"

// A tool self-dispatches a follow-up (depends on the dispatcher seam):
Agent.tool(ScheduleFollowUp, ({ prompt, afterMinutes }) =>
  Scheduling.dispatch({ input: prompt, delay: `${afterMinutes} minutes` }))

// A daily digest, resiliently, on cron:
yield* Effect.forkScoped(Scheduling.recurring(Digest, "summarise today", Schedule.cron("0 9 * * *")))
```

`Scheduling.local` runs dispatched jobs in-process (`Effect.delay` + a forked
fibre in the layer's scope); for durability, provide a Workflow/queue
implementation of the same `AgentDispatcher` — the agent doesn't change. For
durable, cluster-wide cron there's already `ScheduledAgent` over `ClusterCron`.

## Lifecycle hooks

`affe-agent/hooks` runs typed side effects at points in a run — a tool
starting, a run completing — without touching the run. There's no new mechanism
and, deliberately, no new PubSub: a session already publishes its lifecycle as
`AgentEvent`s over an internal PubSub, and `AgentSession.events(session)` is a
subscription to it, so hooks fan out off the one bus alongside observability, a
UI and a delivery log.

```ts
import { Hooks } from "affe-agent/hooks"

// Fork it beside the run; it runs until the stream ends.
yield* Effect.forkScoped(Hooks.on(AgentSession.events(session), {
  ToolCallStarted: (e) => Metrics.toolStarted(e.name),   // event.name is typed
  RunCompleted:    (_e, env) => Audit.record(env.sessionId)
}))
```

Over a raw `AgentEvent.match` loop it adds the two things a convenience layer
should: handlers are **optional** (register only the events you want), and each
handler's failure is **isolated** — a hook that throws is logged (or sent to
your `onError`), never tearing down the observer or the run. Hooks *observe*;
behaviour is changed through the run's own seams (`Permission`,
`ContextTransform`, `AgentLoop`).

## Connectors

`affe-agent/connectors` puts an agent in front of an external platform —
Slack, a webhook, a queue — over the same `AgentSessionHost` seam the HTTP, RPC,
AG-UI and A2A adapters use. A connector is a thin adapter, not a second Agent API;
it owns at most four things, and everything else is the host's: verify (the
host authenticates the principal from the delivery's headers), map the external
conversation to a session, prompt, and reply.

```ts
import { Connectors } from "affe-agent/connectors"

const connector = yield* Connectors.make({
  host: Host,                                   // the shared AgentSessionHost tag
  reply: (result, { delivery }) => postToSlack(delivery.conversation, result.text)
})
yield* connector.deliver({ conversation, text, deliveryId, headers })
```

Two properties fall out. **Duplicate deliveries dedupe for free**: webhooks
redeliver by design, and a connector derives the host's `RequestId` from the
platform's stable delivery id, so the host joins a repeat to its first result
rather than running it twice — no extra store. And the **prompt-injection
boundary holds**: the message text is untrusted model input, while identity and
authorization come from the host's principal (from headers), never from strings
the sender supplied. `Connectors.serverLayer` mounts a webhook that acks within
the platform's timeout and does the work in the background; the app's `decode`
owns the platform specifics (signature check, challenge, retries) — so the core
stays portable.

Signature verification is the one platform bit that needs real crypto, so it
ships as a **host-flagged** sub-entry rather than in the portable core:
`affe-agent/connectors/slack` provides `Slack.verifier`, which checks
Slack's `v0=` HMAC-SHA256 over `v0:{timestamp}:{body}`, rejects stale timestamps
(the replay window), and compares in constant time — drop it into a `decode`
instead of re-implementing it. See [`examples/connectors.ts`](../examples/connectors.ts).

## Structured data

An agent often has typed output beyond its reply — an order it created, a row
for a table, a chart's data. `affe-agent/data` gives that a home: a
Schema-first named channel a tool writes to, and a stream a UI or transport
reads, typed on both ends rather than `unknown` at the wire.

```ts
import { AgentData } from "affe-agent/data"

const Orders = AgentData.channel("orders", OrderSchema)

// In a tool handler — fully typed; requires the DataChannels service:
yield* Orders.write({ id: "A-1", total: 42 })

// In a UI/transport — a typed stream of just this channel's values:
yield* Stream.runForEach(Orders.stream, (order) => render(order))
```

It is **observational**: writing to a channel never touches canonical
conversation history — rendering a card is not the same as saying it. The
payload crosses the wire in its Schema-encoded form and is decoded back for the
reader; `AgentData.layer` is an in-process PubSub, and a transport can bridge
`DataChannels.events` to a client.

## Observability

`affe-agent/observability` standardises the *names and attributes* an
agent emits, rather than wrapping Effect's tracing. It observes the public event
stream and maps each event to the span tree the runtime already nests —
`agent.session → submission → run → turn → {ai.model, ai.tool}` — under stable
`agent.*` / `ai.*` keys, so telemetry groups and filters the same way across
services.

```ts
import { Observability } from "affe-agent/observability"

// Fork an observer; metadata only by default (ids, event and tool names).
yield* Effect.forkScoped(Observability.trace(AgentSession.events(session)))
```

**Content is opt-in.** Prompts, tool parameters, tool results and model output
are omitted unless a `RedactionPolicy` turns them on, and a `redact` hook scrubs
what does get through — telemetry defaults to metadata, never a PII or secret
leak. `Observability.describe` is the pure event → record mapper if you want to
build your own exporter; the default `trace` sink logs structured records any
Effect tracing backend already captures.

Each successful provider call emits `ModelCallCompleted` before any requested
tools run, with normalised input/output/total token counts and finish reason.
`Observability.metrics` records those as `agent_model_tokens` (by `direction`),
alongside turn depth, tool outcomes and duration, and pending input.

## Evals

A test asks whether the code works; an eval asks whether the *agent behaves* —
did it call the right tool, stay under a turn budget, answer with the right
shape. `affe-agent/evals` is that, kept separate from `/testing`, and
it runs entirely through the public session interface, so one eval runs
unchanged against a scripted model (exact, CI-friendly) or a real provider —
swap the `LanguageModel` layer, nothing else.

```ts
import { Evals } from "affe-agent/evals"

const eval = Evals.defineEval({
  name: "reports the weather",
  agent: WeatherAgent,
  test: (t) => Effect.gen(function* () {
    yield* t.send("what's the weather in Paris?")
    yield* t.succeeded()
    yield* t.calledTool("get_weather")
    yield* t.reply(Evals.includes("Sunny"))
    yield* t.turns(Evals.atMost(3))
    yield* t.judge("Does the reply name a real city?")   // optional LLM judge
  })
})

const results = yield* Evals.runAll([eval], { concurrency: 4 })
console.log(Evals.formatText(results))    // or Evals.formatJUnit(results) for CI
```

Checks are recorded, not thrown, so every check in a test runs and the
`EvalResult` collects them all — one failure never hides the next. Assertions
cover the classes that matter: completed, tool called / not called / called-with
/ count, reply and value matchers, turn and token ceilings, and an LLM judge.
Paired with `/testing`'s deterministic model, infra evals are exactly
reproducible.

## Memory

Long-term, cross-session memory — what a session should still know next week,
not the conversation transcript. `affe-agent/memory` is a service plus
a transform: the contract is the minimal `recall(scope, query)` /
`remember(scope, entry)`, and everything is written against the `Memory`
**service**, never a particular store. The in-memory keyword matcher shipped
here is one implementation; a real backend — embeddings, Redis, a hosted
system — is a layer you provide, and the agent above it does not change.

```ts
import { Memory } from "affe-agent/memory"

const assistant = Agent.make({
  tools: [Memory.rememberTool(userId)],       // the model saves durable facts
  contextTransform: Memory.recall(userId)     // relevant memory, injected each turn
})

// Bring your own store — implement two methods and provide it as a layer:
const embeddings = Layer.effect(Memory.Memory, Effect.succeed<Memory.MemoryShape>({
  recall: (scope, query) => /* search a vector store */ Effect.succeed({ entries: [] }),
  remember: (scope, entry) => /* upsert */ Effect.void
}))
// ...or the built-in for tests and single-node: Memory.layer()
```

Recall is **non-fatal** by default: a broken memory backend logs and passes the
prompt through rather than failing the run. Writing has two paths — the
`remember` tool (the model decides what's worth keeping) and `Memory.writer`, a
loop hook that records after each turn from an extractor you supply. The `scope`
is a trusted id (a user or tenant), derived from your auth and never from model
output, so one user's session cannot read another's memory. `load_skill`-style
gating applies too: `remember` carries a `memory` permission projection.

## Skills

A skill is an on-demand capability — workflow guidance, reference material —
that the model loads only when it needs it. `affe-agent/skills` is the
[OpenCode loading strategy](https://opencode.ai/v2/docs/skills) over the seams
the library already has: a registry service, one context transform that
advertises metadata, and one tool that loads a body. Core stays ignorant of it.

The strategy is the point: advertise only metadata, never the bodies. A hundred
skills cost a hundred one-line descriptions in the prompt, not a hundred
documents — the model reads the catalogue, decides what it needs, and pulls that
one body (its resources staying lazy until asked for by name).

```ts
import { Skills } from "affe-agent/skills"

const registry = Skills.layer([
  Skills.skill({
    id: "refunds",
    name: "Issuing refunds",
    description: "How to issue a refund and the limits on doing so.",
    body: "1. Verify the order... 2. Refunds over $500 need a manager...",
    resources: { policy: "...long-form document, read only if needed..." }
  })
])

const agent = Agent.make({
  tools: [Skills.loadTool],          // the model calls this to load a body
  contextTransform: Skills.advertise // the catalogue, metadata only, each turn
})
// ...provide `registry` at the session.
```

Catalogue visibility and execution authorization stay apart: everything
registered is advertised, but `load_skill` carries a `skill` [permission](./guide-permissions.md)
projection on its id, so a policy decides which skills a session may actually
load — the Skills package owns no authorization of its own.

## Agent state

The harness keeps no application-state slot on a session on purpose — "state
belongs in ordinary Effect services, so the harness never becomes a competing
state-management system." `affe-agent/state` is the ergonomic form of
exactly that: a typed value a tool reads and writes, optionally shown to the
model and optionally persisted, adding nothing to the engine. It is neither
conversation history (canonical, owned by the run engine) nor semantic memory —
it is structured state a session works on: a plan, a running total, a form.

```ts
import { AgentState } from "affe-agent/state"

interface Plan { readonly steps: ReadonlyArray<string> }
const Plan = AgentState.Tag<Plan>("app/Plan")

// A tool declares the state as a dependency, exactly as a coding tool declares
// the sandbox, and mutates it through the requirement channel.
const record = Agent.tool(RecordStep, ({ step }) =>
  AgentState.update(Plan, (p) => ({ steps: [...p.steps, step] })).pipe(Effect.as("recorded")))

const agent = Agent.make({
  tools: [record],
  // The model sees the plan each turn, derived — canonical history untouched.
  contextTransform: AgentState.transform(Plan, (p) => `Plan so far: ${p.steps.join("; ")}`)
})
```

The value arrives through a layer, so which world the state lives in is wiring:

```ts
// Ephemeral: fresh each process.
AgentState.layer(Plan, { initial: { steps: [] } })

// Persistent: loaded at build, written through on every mutation, keyed per
// user (or conversation) so a later session resumes where the last left off.
AgentState.layer(Plan, {
  initial: { steps: [] },
  persistence: { schema: PlanSchema, store, key: `plan:${userId}` }
})
```

A `Store` is two methods over JSON strings — `memoryStore` for tests, `sqlStore`
for a real backend, or five lines of your own over Redis or a KV table.


## Compaction

A long conversation has to fit a context window without being lost.
`affe-agent/compaction` is a `ContextTransform` — it adds nothing to
the kernel, which is the point:

```ts
import { Compaction } from "affe-agent/compaction"

const agent = Agent.make({
  contextTransform: yield* Compaction.make({
    policy: Compaction.whenLongerThan(40, { retain: 10 }),
    summarise: ({ messages, previous }) => summarise(messages, previous)
  })
})
```

Canonical history is never rewritten, truncated, or summarised in place. What
changes is the projection: the instructions, a summary of the head, the retained
tail, and everything since. The system messages that lead history are a
protected prefix every projection keeps, so a fold never costs the model its
instructions. The tail stays verbatim because it is what the model is still
reasoning over.

Summaries are checkpointed, so a conversation past the threshold does not
re-summarise every turn, and each new checkpoint is handed the previous summary
so it folds rather than forgets. `Compaction.Checkpoint` is a Schema value and
records token measurements when a token policy supplied them. By default the
checkpoints use a bounded in-memory cache; pass an Effect `KeyValueStore` as
`checkpointStore` when they must survive process recreation. Persistence and
schema failures remain in the transform's error channel.

For production context pressure, use a token policy. The budget can be a fixed
value or an Effect-valued resolver, so model metadata stays in application
wiring rather than entering `Agent`:

```ts
const compact = yield* Compaction.make({
  policy: Compaction.tokens({
    budget: {
      contextWindow: 200_000,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000
    },
    estimate: Compaction.estimate.approximate
  }),
  summarise: ({ messages, previous }) => summarise(messages, previous)
})
```

Supply an exact provider tokenizer by replacing `estimate.approximate`; its
typed failures and service requirements flow through the transform. Token cuts
walk backward from the newest message and then move off tool results so a
retained tail never begins with an orphaned tool answer.

`summarise` is an ordinary Effect — a cheaper model, a heuristic, a cache — and
may fail and require services of its own. It may return a string or
`Compaction.SummaryResult`, whose provider-neutral usage is retained with the
checkpoint. `Compaction.serialize(messages)` is the safe starting point for a
model summarizer: it labels every prompt part, truncates oversized tool results,
and describes file payloads instead of copying them into the summary request.

The default summariser is `Compaction.model()`. It asks the ambient
`LanguageModel` for a continuation summary — goal, constraints, progress,
decisions, next steps, critical context, files — using
`Compaction.continuationSummary`, or a `Template` of your own. The model is a
requirement rather than an argument, so the summarising model can differ from
the agent's: discharge it yourself and the agent's model is untouched.

```ts
summarise: (input) => Compaction.model()(input).pipe(Effect.provide(cheapModel))
```

`Compaction.controller` returns the transform together with the handle that
owns its checkpoints, for the things an application does around compaction:

```ts
const compaction = yield* Compaction.controller({ policy, summarise: Compaction.model() })
const agent = Agent.make({ contextTransform: compaction.transform })

// A `/compact` command: fold now, regardless of the threshold, with focus text
// the summariser receives as `instructions`. The next turn projects the result.
yield* compaction.compact({
  sessionId: session.id,
  history: yield* session.history,
  instructions: "Keep the migration plan."
})
yield* compaction.checkpoint(session.id) // Option<Checkpoint>, as stored
yield* compaction.clear(session.id)      // the next turn starts from the transcript
compaction.events                        // Stream<CompactionEvent>
```

`CompactionStarted`, `CompactionCompleted` (carrying the checkpoint and the
summary's usage) and `CompactionFailed` are reported for automatic and manual
compactions alike. They are a Schema on the controller, not new session events:
compaction is one transform among many, and its reporting belongs to whoever
built it rather than to every remote client's wire vocabulary. Manual
compaction has no turn in flight to measure, so it cuts by message count —
`retain`, defaulting to the policy's own under `whenLongerThan` and to six under
`tokens` — aligned off tool results like every other cut. `Compaction.make`
remains the transform-only convenience over the same controller.

### A fresh window instead of a summary

A summary pays a model call and can invent. The other kind of checkpoint,
`Compaction.Rollover`, pays nothing and keeps only what the model chose to
carry: the next turn sees the instructions, one marker naming the window
("Context window 2: the conversation before this point was cleared"), the
model's handoff note if it left one, and whatever came after the decision.
`Checkpoint` is the union of the two, told apart by `kind` — `isSummary` and
`isRollover` narrow it — and a checkpoint stored before rollovers existed
still decodes as a summary.

Two things start one. The model can ask, with a tool the controller builds:

```ts
const agent = Agent.make({
  tools: [compaction.tools.newContext, compaction.tools.contextRemaining],
  contextTransform: compaction.transform
})
```

`new_context({ handoff? })` does nothing but hand its request back as its
result. That result is then in canonical history, and the transform reads it
from there before the next model call — so a crash or a durable replay between
the call and the new window loses nothing, and a request the window already
covers can never fire twice. It must be called alone: the tool carries
`ToolExecution.Alone`, so a request that arrives beside other calls is not run
and comes back to the model as a `ToolNotAloneError`, while the other calls
run as they would have. The model calls again, by itself, and the window moves
then.

Or a token policy can fall back to one when a summary will not fit:

```ts
Compaction.controller({ policy, summarise, onCannotHelp: "rollover" })
```

The default is `"fail"`, which leaves `CompactionCannotHelpError` to the
caller as before; `"rollover"` cuts at the last user message, so the turn
being answered survives, and records the window as an `automatic` compaction
whose checkpoint is a `Rollover`. Either way the `Budget` is untouched: a new
window is not a new run. `CompactionCompleted` carries the checkpoint, under
the `requested` trigger when the model asked.


## Agent Plugins

[`affe-agent/plugins`](https://agent-plugins.org) loads a portable
plugin directory — a `plugin.json` manifest, `skills/<name>/SKILL.md` skills, and
an `mcp.json` of MCP servers — into an agent. The standard is a vendor-neutral
composition of two things this library already models (Agent Skills → `/skills`,
MCP servers → `/mcp`), so support is an **adapter over existing seams**, not a new
capability: it adds nothing to the engine, and reads the plugin through the
`Sandbox` seam, so it stays portable.

```ts
const loaded = yield* Plugins.load()                       // reads via Sandbox.Current
const agent = yield* Agent.make({ instructions: "…" }).pipe(Plugins.install(loaded))
const session = yield* AgentSession.make(agent).pipe(
  Effect.provide(Plugins.skillsLayer(loaded))
)
// …provide a Sandbox (sandbox/local pointed at the plugin dir, or a MemorySandbox).
```

The spec's failure model is honoured exactly: only a fatal `plugin.json` fails the
load; a missing `skills/`/`mcp.json`, a single bad `SKILL.md`, or a bad server
entry is a `Warning` and the rest of the plugin loads. Skills map onto the
progressive-disclosure `/skills` registry (metadata advertised, body loaded on
demand); MCP servers are connected and their discovered tools bound as
`Tool.dynamic` via `Plugins.mcpToolkit`. Extension namespaces are ignored (spec
requires clients to skip namespaces they don't implement).

