# affe-agent

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
│ affe-agent                          │
│   sessions · runs · turns · events            │
│   steering · follow-ups · context transforms  │
└───────────────────────┬──────────────────────┘
                        │
┌───────────────────────▼──────────────────────┐
│ effect/unstable/ai  ·  effect                 │
└──────────────────────────────────────────────┘
```

> **Status: `0.0.1`, pre-release.** The semantics are implemented and tested,
> but the API may still move. See [Stability](#stability) before you pin a
> dependency.

## Contents

- [Install](#install) · [Quickstart](#quickstart) · [Getting started](./docs/getting-started.md) · [Platforms](./docs/platforms.md)
- [The mental model: one kernel, a few seams](#the-mental-model-one-kernel-a-few-seams)
- [Package map](#package-map) · [Maturity map](#maturity-map)
- [Design commitments](#design-commitments) · [Stability](#stability) · [Runtimes](#runtimes)
- [Guides](#guides) — the long-form documentation, one file per area

## Install

```bash
npm install affe-agent effect
```

`effect` is a peer dependency. Provider packages (`@effect/ai-anthropic`,
`@effect/ai-openai`) are yours to choose.

**Pin exact versions and upgrade them together.** This library, `effect`, and
your `@effect/ai-*` provider are all pre-1.0 and move in lockstep with the Effect
release candidate. A version skew between them surfaces as confusing type errors
at the `effect/unstable/ai` boundary, not a clean failure.

| Peer | Range | Notes |
|------|-------|-------|
| `effect` | `>=4.0.0-rc.111 <5.0.0` | required; this repository builds against `rc.112` |
| `@modelcontextprotocol/sdk` | `>=1.10.0 <2.0.0` | optional; only for `/mcp/v1` |
| `callscript` | `>=0.1.0 <0.2.0` | optional; only for `/code/callscript` |
| `@modelcontextprotocol/client` | `>=2.0.0 <3.0.0` | optional; only for `/mcp/v2` |
| `@a2a-js/sdk` | `>=1.0.1 <2.0.0` | optional; only for `/a2a` |
| `acorn` | `>=8.18.0 <9.0.0` | optional; only for `/code` |
| `effect-cf` | `>=0.39.0 <0.40.0` | optional; only for `/cloudflare` |
| `@durable-streams/client` | `>=0.2.6 <0.3.0` | optional; only for `/durable-streams` |

```jsonc
// package.json — exact, not caret ranges, until Effect 4 is GA
"dependencies": {
  "affe-agent": "0.0.1",
  "effect": "4.0.0-rc.112",
  "@effect/ai-anthropic": "4.0.0-rc.112"
}
```

## Quickstart

> New here? [docs/getting-started.md](./docs/getting-started.md) is one typed
> agent, running against a scripted model with no key, in one screen.

```ts
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { Agent, AgentLoop, AgentSession } from "affe-agent"

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

The handle is inert: `session.prompt(input)` builds an `Effect` and starts
nothing. Every operation is also a module function
(`AgentSession.prompt(session, input)`), the form to reach for when composing.

An `Agent` names no model. Provide one where you run the program:

```ts
program.pipe(Effect.provide(AnthropicLanguageModel.layer({ model: "…" })))
```

The same agent then runs against any provider, a routing layer, or the scripted
`TestLanguageModel` from `/testing`. Everything the handle does — steering,
follow-ups, interruption, streaming, elicitation, tool progress, typed events
and errors, per-tool concurrency, per-turn toolkits, snapshots — is in
[docs/guide-sessions.md](./docs/guide-sessions.md).

## The mental model: one kernel, a few seams

The kernel is small: it runs **sessions → submissions → runs → turns**, keeps
one append-only canonical history, and emits typed lifecycle events. Everything
else is a *battery* that plugs into one of a handful of **seams**. A battery
adds a capability, policy, interpreter, or adapter, never a second execution
model, and the core depends on no battery.

Each seam is attached at agent or session construction, or supplied as a
`Layer`:

| Seam | Where | What it swaps | Batteries that use it |
|------|-------|---------------|-----------------------|
| **`toolkit` / tools** | `Agent.make` | the tool set (static, or an `Effect` resolved per turn) | `/coding`, `/pi`, `/web`, `/subagent`, `/skills`, `/mcp`, `/tool-source`, `/code` |
| **`contextTransform`** | `Agent.make` | how the model-facing prompt is *derived* from canonical history | `/compaction`, `/memory`, `/skills`, `/state` |
| **`loop`** | `Agent.make` | the continue/stop policy after each turn | `AgentLoop.*`, `/budget` |
| **`permission`** | `Agent.make` | allow / ask / deny per tool call | `Permission`, `/coding` and bridge projections |
| **`toolExecution` / failure / denial** | `Agent.make` | concurrency, and what a failed or denied call does | core policies |
| **`elicitation`** | `AgentSession.make` | where a paused run waits for an outside answer | `Elicitation` (local / durable) |
| **`InputChannel`** | `AgentSession.make` | where steering / follow-up input is held | core (memory / durable) |
| **`eventSink` / `events`** | session | synchronous or streamed observation of lifecycle events | `/observability`, `/hooks`, `/data`, `/sessions`, `/export` |
| **`AgentSessionHost`** | transport | the request-facing session seam a transport drives | `/http`, `/rpc`, `/ag-ui`, `/a2a`, `/mcp`, `/openai`, `/connectors` |
| **`LanguageModel`** | `Layer` | the model provider | `@effect/ai-*`, `/model` metadata |
| **`Sandbox`** | `Layer` | the filesystem / process capability tools run against | `/sandbox` (+ `/sandbox/local`), `/blob` |

## Package map

Core is the default import; everything else is an explicit subpath. The
per-module reference, with what each composes with, is
[docs/MODULES.md](./docs/MODULES.md).

**Core** — `affe-agent`
: `Agent`, `AgentSession`, `AgentLoop`, `AgentEvent`, `AgentOutput`,
`ContextTransform`, `Permission`, `Elicitation`, `Principal`, `PromptWire`,
`ToolExecution`, `Snapshot`.

**Transports and durability**
: `/client` · `/rpc` · `/http` · `/ag-ui` · `/a2a` · `/mcp` (`/mcp/v1`,
`/mcp/v2`) · `/openai` · `/connectors` (`/connectors/slack`) · `/durable` ·
`/cluster` · `/durable-streams`.

**Batteries** (capabilities over a seam)
: `/coding` and `/pi` — file/shell tool batteries over a sandbox ·
`/shell` — construction-time shell dialects · `/web` (`/web/brave`,
`/web/http`, `/web/cloudflare`) — search, guarded fetch, rendered-page
capture and a bounded crawl · `/tool-source` — MCP / OpenAPI /
GraphQL catalogs as toolkits, with `Credentials` · `/code` (`/code/callscript`)
— code mode: one `execute` tool over a confined interpreter · `/subagent` ·
`/state` · `/skills` · `/memory` · `/compaction` · `/budget` — token and money
ceilings through the loop · `/model` — context window, modalities and cost
per model · `/evals` · `/observability` · `/redaction` · `/data` · `/hooks` ·
`/scheduling` · `/tree` — sessions as a branchable tree · `/sessions` — a
session's events folded into current state, and a paginated directory over
every session (memory or SQL) kept current from the host's events · `/export` — snapshot envelope
and JSONL commit log · `/blob` (`/blob/fs`) — content-addressed blob storage ·
`/plugins` — Agent Plugins packages over `/skills` + `/mcp` · `/presets` —
`Presets.coding` and `Presets.gateway`, composition and defaults only.

**Host and testing**
: `/sandbox` (portable) + `/sandbox/local` (Node) · `/cloudflare` — one
Durable Object per session and the Worker that routes to it, on `effect-cf`
(an optional peer) · `/elicitation` · `/testing` — the scripted
`TestLanguageModel`, `AgentProbe`, web doubles, and the conformance suites
every client and store is held to.

**Applications in this repository**
: `apps/tui` — the full-screen local coding harness · `apps/cli` — a
conventional client for any mounted HTTP agent · `apps/worker` — the
`/cloudflare` entry deployed with the scripted model, one DO per session.

### Maturity map

Every subpath is public, but not every subpath is equally settled. The label
says what a change there means for you, not how good the code is.

| label | meaning | subpaths |
| --- | --- | --- |
| **core** | the vocabulary; a breaking change here is a major version | root, `/client`, `/elicitation`, `/testing` |
| **supported** | contract-tested against the reference apps and the [cross-adapter matrix](./docs/conformance-matrix.md); changes are deliberate and noted in `STATUS.md` | `/http`, `/rpc`, `/mcp`, `/mcp/v1`, `/mcp/v2`, `/ag-ui`, `/a2a`, `/coding`, `/sandbox`, `/sandbox/local`, `/shell`, `/state`, `/hooks`, `/observability`, `/export`, `/compaction`, `/redaction`, `/budget`, `/subagent` |
| **experimental** | the fastest-moving surface; shapes may change between minors as the plans under `docs/` land | `/durable`, `/cluster`, `/durable-streams`, `/tool-source`, `/code`, `/process`, `/code/callscript`, `/plugins`, `/skills`, `/memory`, `/evals`, `/scheduling`, `/data`, `/connectors`, `/connectors/slack`, `/tree`, `/sessions`, `/openai`, `/web`, `/web/brave`, `/web/http`, `/web/cloudflare`, `/cloudflare`, `/pi`, `/model`, `/blob`, `/blob/fs`, `/presets` |
| **reference** | illustrative, not a dependency: read it, copy it, do not import it | `apps/tui`, `apps/cli`, `apps/worker`, `examples/` |

Engine-facing seams are on none of these namespaces. What a durable
interpreter or this repository's tests need (`AgentSession.makeEngine` with
`EngineOptions`, `ToolExecution.execute`) is reachable by module path and
deliberately absent from `affe-agent`; `test/PublicApi.test.ts` pins
both.

## Design commitments

These are enforced by tests, not just documented:

- `AgentSession` is the sole owner of canonical history.
- `ContextTransform` never mutates it.
- At most one run executes per session.
- Steering is FIFO and applies only at turn boundaries.
- Follow-ups never modify the running run; they schedule later runs.
- Every started tool call gets exactly one terminal event.
- A turn commits atomically. An interrupted turn leaves no partial record.
- Every event carries a monotonically increasing session sequence.
- **End-user code never needs a type cast.** Test code counts as user code.

Deliberately *not* in the core, and built on top of it without modifying it:
durability (`/durable` runs the same agent definition inside an Effect
`Workflow`), and memory, skills, sandboxes and subagents (each is a service, a
transform, or a tool, packaged).

## Relation to effect-agent.com

[effect-agent.com](https://effect-agent.com/) documents a different project,
`danieljvdm/effect-agent`, published as `effect-agent` on npm. The two are
independent, on the same substrate (Effect 4 and `effect/unstable/ai`), and
arrived at the same turn model: prepare context, call the model, execute the
tool batch, commit, drain steering, decide whether to continue. Where they
part: this library puts the session behind a protocol-neutral client seam
with HTTP, RPC, AG-UI, A2A and MCP adapters over it, runs the same agent
durably inside an Effect Workflow, and lets code mode reach any tool through
the ordinary permission decision; theirs ships a first-class Cloudflare host,
a typed input projection and an isolate-per-program code mode. A read of one
against the other is [docs/plan-effect-agent-comparison.md](./docs/plan-effect-agent-comparison.md).

## Stability

Two different things are pre-release here, and only one is under this library's
control:

- **The design is stable.** The session/run/turn model, the seams, and the
  commitments above are implemented, tested, and unlikely to change in shape.
  The kernel vocabulary has not grown since `0.0.1`.
- **The substrate is not yet.** This library targets **Effect v4, which is at
  release candidate**, and uses the AI modules from `effect/unstable/ai`,
  explicitly unstable upstream. Expect API churn coming *from Effect* until
  Effect 4 reaches GA, independent of this library's own versioning.

Practical guidance: pin `affe-agent`, `effect`, and your
`@effect/ai-*` provider to exact versions and upgrade them together, and treat
the subpaths marked experimental above as the fastest-moving surface.

## Runtimes

The package declares no Node engine requirement, because it has none. Every
entry except `/sandbox/local` and `/blob/fs` reaches the host only through
Effect's platform services (`SqlClient`, `HttpServer`, `HttpClient`, …), and
the application supplies the concrete Layer for Node, Bun, Deno or an edge
runtime. The two host entries live at their own paths so importing the
portable surface never loads them.

This is verified, not promised: `npm run lint:portability` rejects host
coupling in portable source, and `npm run verify:package` imports every entry
of the packed artifact under a resolution hook that refuses Node built-ins.
`apps/worker` proves the portable surface on workerd.

Developing the library itself uses Node 22.5 or later (the test suite runs
SQLite through `node:sqlite`).

## Guides

| document | covers |
| --- | --- |
| [guide-sessions.md](./docs/guide-sessions.md) | Steering, follow-ups, interruption, canonical history and transforms, streaming, elicitation, tool progress, events, errors, tool failure and concurrency policy, per-turn toolkits, authoring styles, snapshots, testing, tracing |
| [guide-permissions.md](./docs/guide-permissions.md) | `Permission`: allow / ask / deny, rules, exceptions, remembered grants, the `needsApproval` floor, journalling under `/durable` |
| [guide-sandbox.md](./docs/guide-sandbox.md) | `/sandbox`, `execStream`, the `/coding` and `/pi` toolkits, the `shell` tool and its dialect, Claude Code and OpenCode as A2A agents under one policy |
| [guide-code-mode.md](./docs/guide-code-mode.md) | `/code`: one `execute` tool over a confined interpreter, what the boundary is (each confinement citing its test), the read-only recipe |
| [guide-transports.md](./docs/guide-transports.md) | `AgentClient`, `submit` / `awaitSubmission`, `AgentServer`, the CLI, AG-UI, OpenAI-compatible completions, A2A v1 both directions, MCP both directions |
| [guide-durable.md](./docs/guide-durable.md) | `/durable`, `/cluster`, the durable client, polling configuration, Durable Streams |
| [guide-batteries.md](./docs/guide-batteries.md) | Subagents, scheduling, hooks, connectors, structured data, observability, evals, memory, skills, agent state, compaction, Agent Plugins |
| [limits.md](./docs/limits.md) | Every bound a user can hit, its default, and what happens at it |
| [examples.md](./docs/examples.md) | Every example under `examples/`, one line each |
| [transport.md](./docs/transport.md) | The wire-level reference: encoding, SSE framing, live vs. durable delivery |
| [MODULES.md](./docs/MODULES.md) | Every public module, what it is, and what it composes with |
| [docs/README.md](./docs/README.md) | The index to the plans, research and reviews under `docs/` |

## Development

```bash
npm run check   # typecheck, build, lint, portability, tests, mutations, package, smokes
npm run test
npm run verify:package
```

[`PLAN.md`](./PLAN.md) is the design authority; [`STATUS.md`](./STATUS.md)
states what is true now; [`AGENTS.md`](./AGENTS.md) holds the conventions.
Several agents may work here at once; [`COLLABORATION.md`](./COLLABORATION.md)
is where they coordinate.

## License

MIT
