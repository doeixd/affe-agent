# Status — what is true now

Last regenerated 2026-09-05. This is the short document: what ships, what
holds it there, and what is deliberately not done. The chronology -- every
finding, every falsification, every "what the second subscriber found" --
moved to [docs/status-history.md](./docs/status-history.md) and keeps growing
there; new work appends a dated section *there*, and edits the line here it
changes. [docs/remaining-work.md](./docs/remaining-work.md) is the ranked
list of what is next and only that; what it has closed is in
[docs/remaining-work-closed.md](./docs/remaining-work-closed.md). `ROADMAP.md`
is the capability view; `PLAN.md` the design authority. Claims in this file
and both of those carry `verify:` lines that `npm run check` runs.

## The gates

Regenerate these from the commands; do not hand-edit the numbers.

| gate | command | now |
| --- | --- | --- |
| tests | `npm test` | 2204 passing in 210 files, `McpServerConformance` included (it no longer runs separately). `vitest.config.ts` caps `maxWorkers` at 8 -- see the caveat below |
| Effect diagnostics | `npm run lint` (+ `lint:cli`, `lint:tui`, `lint:cloudflare`) | 0 errors, 1 warning (a chained `provide` in `test/ProcessManager.test.ts`, a colleague's file), 0 messages |
| types | `npm run typecheck` (+ `:cli`, `:tui`, `:worker`, `:cloudflare`) | clean, examples included |
| doc claims | `npm run verify:remaining-work` | every `verify:` line in the live list, the ledger and this file holds; a stale claim fails the build. It fired three times in its first two days, each time on text that had gone stale that hour |
| casts | `test/Casts.test.ts` | every erasing cast in `src/` is inventoried in `AGENTS.md` with its reason (six files) |
| portability | `npm run lint:portability`, `verify:workerd` | no host coupling outside host modules; the worker bundle builds. Widened 2026-09-01 to reject `effect-cf`, `@cloudflare/*`, `@effect/sql-sqlite-do` and the `bun:` / `deno` specifiers as well as Effect's own host bindings, each proved to fire; the check now covers what the claim says. |
| package | `npm run verify:package` | every published entry point imports from the packed tarball |
| break-once | `npm run verify:mutations` | 16 mutations across `/sessions`, host events and workspace lifetime; each names the tests that must fail, so a mutation failing the *wrong* test is an error too. In `check` (~65s) |
| durability | `npm run verify:durability` | D1–D7 bite when broken; D4b survives by construction |
| smoke | `smoke:ref-coding`, `smoke:cli`, `smoke:tui` | the reference coding agent, the CLI and the TUI run end to end |

Built on **Effect v4 (`effect@4.0.0-rc.112`)**; the AI modules are the in-tree
`effect/unstable/ai`. Node 22.5+ only for the host entries.

One caveat on the tests gate, **diagnosed 2026-09-01** (it previously read
"the suite is flaky under process pressure on Windows", undiagnosed): the
suite is reliable when it owns the machine and unreliable when it does not.
Nine consecutive solo runs passed. Two suites run *concurrently* both failed —
6 and 8 files, and one of them never reported two files at all, because the
worker died before finishing. That is the 0/2/20 variance: it tracks what else
was running, and `CLAUDE.md` says other agents may be working here at the same
time.

Eleven files spawn real child processes, not the four this note used to name:
`Sandbox`, `SandboxConformance`, `SandboxDerive`, `Cli`, `Portability`,
`McpClients`, `McpServerConformance`, `McpStdioCompatibility`, `PluginMcp`,
`CodingToolkit`, `WorkerDurableObject` — about 247 tests. `0xC0000142` is
Windows refusing a DLL init under handle exhaustion, which is machine-global.

`vitest.config.ts` now caps `maxWorkers` at 8, which costs about 29% on a solo
run (51s → 66s) and reduces two concurrent suites to a single failure each.
That failure is `ClusterMultiNode`, which races a real clock and is listed
below as deliberately left; a worker cap cannot fix a test that races a wall
clock. Neither can it fix `DurableStreams`' "linear, not quadratic", which
asserts an asymptotic bound by measuring elapsed time and spawns nothing —
that one will fail on any busy machine, including CI.

## The two properties everything rests on

- **The engine is generic end to end.** `AgentSession`, `AgentTurn`,
  `AgentRun`, `AgentSubmission` and `ToolExecution` carry `Tools`; tool types
  are never erased internally and re-asserted at the boundary.
- **User-side code needs no casts and no annotations.**
  `examples/typed-agent.ts` is a full typed agent with zero of either, with
  compile-time assertions that inference stays precise. Test code counts as
  user code. Compiling is not the proof -- `any` compiles -- the assertions are.

The kernel vocabulary (`Agent`, `AgentSession`, submission / run / turn,
`AgentLoop`, `AgentEvent`, `ContextTransform`, `ToolExecution`, `Permission`,
`Elicitation`, `InputChannel`) has grown once since `0.0.1`: on 2026-09-01
`AgentLoop.Decision` gained `Final` (one tool-less turn, then stop) and an
optional `reason`, and `State` gained `toolCallsTotal` and `elapsed` -- all
additive, and the engine's only new knowledge is that a `Final` has one
turn's notice -- and the same day `AgentInput` joined `AgentOutput` as a
root noun: the value a submission is asked with, split from the rendering
the model sees, carried on the fibre as a `Context.Reference` and on
`SubmissionStarted`. `Agent.make` and `AgentSession` gained an `Input` type
parameter, defaulting to `never` (`Prompt.RawInput`). Everything else is built *from* the vocabulary: a Service, a
Layer, a toolkit, a transform, an adapter.

## What ships

One line per surface; the maturity label is the README's
([Maturity map](./README.md#maturity-map)). The plan that specified each is in
[the ledger](./docs/remaining-work-closed.md#already-done--do-not-restart).

**Core.** Sessions with prompt / submit + awaitSubmission / steer / follow-up
/ interrupt / respond; bounded retention of settled outcomes with idempotency
keys; typed tool execution with strategies and failure policies; permission
policy with projections, rules and remembered grants; elicitation with a
terminal state; snapshots and restore; execution plans; the event ADT with
the correlation envelope; `PromptWire` so files cross every boundary intact;
typed input and output with defaults (every agent has an input and an
output; the defaults are the prompt and the text, so `Input` is
`Prompt.RawInput` and `Value` is `string` unless declared, `Result.value` is
always `Some`, `Agent.Any` is a plain alias, and the wire carries one shape
-- the session's encoded input, decoded by the host with the session's
schema, `AgentClient.typed` for the caller; journalled by the durable client
and rendered in the workflow); run policy on the loop seam -- `maxTurns`,
`maxToolCalls`, `maxDuration`, `limits`, `withFinalTurn` -- with the stop's
reason on `RunCompleted`, the result and every client; a `RunLedger` the
engine writes after every turn -- session, run, turn, tool calls, tokens,
cost, elapsed, keyed so a replay is one entry -- and charges the `Budget`
from, so `within` and `cost` are pure decisions and a delegated child's
spend reaches its parent's counter under the child's own session id; every
loop and permission policy carrying a description of itself, and
`Agent.describe` deriving the whole agent as data from them; a tool able to
insist on being the only call in its turn (`ToolExecution.Alone`); and a decided
delegation boundary (`Subagent.Inherit`: budget crosses by default, approval
only when asked to and then on the parent's event stream with the path of
delegating tools, a typed child's value returned as the tool's result, and a
child holding an approval-requiring tool refused at construction). Every id
the harness mints is qualified by its session, so anything shared across
sessions is safe by construction.

**Transports.** `/client` is the protocol-neutral seam (`AgentClient`,
`AgentSessionHost` with capacity, per-session request buckets, authorization,
idempotent mutations, enumeration and a bounded event tail). Over it: HTTP +
SSE (resumable from `Last-Event-ID` on a durable backing), Effect RPC (HTTP
and WebSocket), AG-UI (official client, elicitation through interrupt input),
A2A v1 (REST and JSON-RPC, official client, tasks, cancel, push configs, a
remote peer as a tool), MCP (nine tools, history / pending / sessions /
event-log resources, both official client generations, stdio elicitation).
The [cross-adapter matrix](./docs/conformance-matrix.md) holds all five to the
same rows. `/relay` carries any of them between two nodes that cannot dial
each other: a route table keyed by peer, an opaque frame, and a caller
identity the relay stamps and a caller cannot forge. Liveness is a lease,
renewed by any traffic and collected when someone asks, so the directory does
not claim a half-open peer is reachable. A node that loses its connection re-establishes it, unless the reason was
supersession or a refused credential, where coming back would flap or hide a
misconfiguration. Credentials live in a store -- memory or SQL, tokens kept as
digests -- so enrolling and revoking a node are writes rather than restarts. It
has no durable mailbox, and will not: queueing a request for an offline peer
would deliver work to a caller that was told long ago it had failed, so an
offline peer is a typed error rather than a queue.

**Durability and scale.** `/durable` runs the same agent inside a Workflow
with journaled events, typed `StorageError`s at every store, a delivery log
that makes resumption a property of the backing, and a durable client that
survives the process; `/cluster` makes a session an entity (typed
`StorageError` on the wire) and adds scheduled agents; `/durable-streams`
delivers events across nodes.

**Host-wide events.** `AgentSessionHost.hostEvents` is one stream over every
hosted session plus this host's own hosting lifecycle (`HostAttached`,
`SessionHosted`, `SessionEvent`, `SessionUnhosted`), authorized as its own
operation because granting a stream over every session is not the grant
per-session `events` is. Per-session order is preserved; there is deliberately
no host-wide sequence, because it would record scheduler order dressed as event
order and `SessionProjection.gap` already detects loss at finer grain.
`examples/host-events.ts` folds it into per-session projections, which is what
`/sessions` was built for.

**Workspace lifetime.** `WorkspaceManager` (`/sandbox`) makes a workspace a
keyed, reference-counted resource over `LayerMap`: shared by every holder,
released once the last one goes and an idle window passes. Without it,
`Sandbox.currentLayer` acquires per layer and the local provider makes a fresh
temp directory per acquisition, so two agents naming one workspace get two
directories that each die with their acquiring scope. `Presets.coding` takes
one optionally -- opt-in, because it changes a lifetime. It owns workspaces and
deliberately not processes: a managed process outlives its handles, so
reference counting would kill it at exactly the wrong moment.

**Principal.** `Principal.CurrentPrincipal` (root): the caller's subject on
the fibre that acts -- a `Context.Reference` the host sets per request
(`AgentSessionHost.Options.subject`), `None` outside any host, carried on
the durable claim/payload so replays see what the claimer saw.

**Cloudflare host.** `affe-agent/cloudflare` (since 2026-09-01):
`CloudflareHost.make({ agent, layer })` returns the Durable Object class and
the Worker class a deployment exports. Built on `effect-cf`, an optional
peer, by the owner's decision (`docs/plan-effect-cf-and-webtransport.md`
§3a) -- the one place it enters `src/`, compiled as its own program
(`tsconfig.cloudflare.json`) and exempted by name in the portability lint.
Durability is the platform's: `/durable`'s engine still stalls on workerd.
`IsolateExecutor` (same entry) is code mode in a Dynamic Worker: no
network but the object's broker route, every call still through the
host's `invoke`; proven on miniflare with a program that reaches for
`fetch` and gets nothing.

**Presets.** `affe-agent/presets`: `Presets.policy` (a run's bounds and
ceilings as one record, expanding to the loop and the `Budget` layer, with
`readPolicy` as its inverse over a loop's description); `Presets.coding` (toolkit, a
policy that asks before anything changes, an acquired workspace) and
`Presets.gateway` (source-bound tools behind one host, refusals returned
to the model, the caller's `subject` required rather than optional).
Composition and defaults only -- each returns the parts it assembled, so
dropping to the primitives is taking a field. Both references are built
on them.

**Durability, demonstrated.** `examples/durable-resume.ts`
(`npm run smoke:durable-resume`, ~20s) actually runs the claim rather
than typechecking it: four processes over one SQLite file, sharing no
memory. A conversation outlives the process that started it; a
submission whose process dies mid-tool is finished by the next one; and
the model call the dead process already made is replayed from the
journal, not re-issued. Each claim is asserted, and breaking one fails
the run. Deliberately *not* in `check`: the guarantees themselves are
covered by `DurableSql`, `DurableAgentClientSql`, `ClusterMultiNode` and
`verify:durability`, so this is a walkthrough rather than the proof, and
`check` should not pay 20 seconds for it.

**Reference implementations.** `examples/ref-coding-agent.ts`,
`examples/ref-gateway.ts` and `examples/ref-declarative.ts`
(`plan-primitives.md` §4) are built only from the
public surface, carry compile-time assertions that inference stayed
precise, and run in CI. What `ref-gateway` found, which is the point of
the exercise:

- **Nothing was missing.** Sources, the three credential layers,
  per-principal bindings, per-tool policy and the host all composed from
  `affe-agent/*` with no cast and no private import. That is the
  integration axis' acceptance test passing.
- **A write is refused twice, independently** -- and the second guard is
  the one nobody would notice losing. The operator's `Permission` policy
  denies it, *and* the OpenAPI source's own non-GET annotation is floored
  by `ToolSource.bind` into the tool's `needsApproval`, which asks; an
  agent with no elicitor fails closed. A gateway whose policy is
  misconfigured still does not silently write. Both are asserted, and
  disabling the floor fails the smoke.
What `ref-declarative` found:

- **Nothing was missing**, and the cohesion claim holds: state, its
  rendering into the prompt, capability rules and event reactions are
  each one declaration, and the harness does the assembling.
- **"Dynamic capability resolution" has a boundary worth stating.** The
  *toolkit* is fixed when the agent is constructed -- a model needs a
  stable list of what exists -- so what follows live state is the
  `Permission` policy, per call. That is enough for a mode change to take
  effect on the next call with no rebuild of the agent or session
  (asserted), but it is not a tool list that changes under the model.
- **A tool that touches state declares it**, in both directions:
  `dependencies: [tag]` for the service and a `failure` for the store's
  error. That is the type system doing its job, and it is worth knowing
  before writing the first stateful tool.
- **`docs/flue.md` was referenced by this plan but absent** from the
  repository until 2026-09-01; it is committed now, so the mapping this
  reference argues against can be checked.

- **Gap: no in-memory MCP transport.** An MCP surface can be *typechecked*
  in an example but not *built*, because every transport binds either the
  process's stdio or an `HttpRouter`. `examples/mcp.ts` has the same
  limitation and says so. Not blocking -- the server layer is exercised in
  `test/AgentMcp.test.ts` -- but it is why both examples stop at the
  transport.

**Code mode.** `/code`: `Catalog` (signatures, budgeted round-robin
catalog, deterministic search), the owned acorn-based interpreter, and
`CodeMode`/`CodeTool` -- a model-written JavaScript program runs against
real toolkits, every nested call passing the same `Permission` decision a
direct call gets -- including an `Ask`, which pauses the program on the
host's elicitor and throws into it when refused. The owned interpreter
never suspends -- its state is a JS call stack -- and that is asserted,
not merely omitted; but the `CodeExecutor` seam admits an engine whose
state survives a process boundary (`ExecutorOutcome.Suspended`, state to
the host through `onSuspend`, never to the model).

**Batteries.** `/blob` (+ `/blob/fs`): content-addressed blob storage with
size/MIME policy and `BlobWire` externalize/resolve over the encoded
prompt form; `/sandbox` (+ `/sandbox/local`) with a conformance suite and
tier-0/1 derivation (`Sandbox.fromExec` / `fromOperations`: any host that
can run a command is a sandbox, shell-derived operations reported as such);
`/coding` and `/pi` tool batteries over it; `/shell` with construction-time
dialects; `/tool-source` (OpenAPI, GraphQL, MCP; approval hints become
`needsApproval`; `Credentials` -- method, binding, provider -- `Redacted`
until the header is written); `/subagent`; `/state`; `/skills`; `/memory`; `/evals`;
`/observability`; `/model` (what upstream's `Model` omits: context window, max
output, vision/tools/reasoning, per-million cost with `cacheRead` and
`cacheWrite` priced apart -- with a built-in Anthropic table guarded by an
exhaustiveness test, `budget`, a compaction budget the model sizes
itself, and `preflight`, an opt-in transform that refuses an image against
a text-only model before the call, naming both); `/export` (JSON envelope + JSONL commit log); `/compaction`
(token policy, checkpoints, controller, events; a `Rollover` checkpoint
beside `Summary` -- the model asks with `new_context`, or a summary that will
not fit falls back to one -- with the instructions kept ahead of every
projection, and four tools the controller builds: `context_remaining`,
`new_context`, `search_context` and `read_context`, the last two over the
canonical history a fold removed from view; + branch carryover:
`BranchSummary` over the tree's seed seam, and `CodingSummary`'s cumulative
file details); `/redaction`; `/budget`;
`/data`; `/hooks`; `/scheduling`; `/connectors` (+ Slack, with a channel
conformance suite); `/plugins`; `/tree` (sessions as a tree: branch, lanes,
divergence, activation); `/web` (+ Brave search, HTTP fetch, and since
2026-09-01 rendered-page capture over Cloudflare Browser Rendering's REST
API with a portable bounded crawler over it, sharing the fetch provider's
target guard); `/openai`
(OpenAI-compatible responses); `/sessions` (`SessionProjection`: a session's
events folded into what is true now -- lifecycle, counts, accumulated usage,
tool outcomes, what is still open -- pure, so a gap is repaired by re-folding
`DeliveryLog.read({ after })` through the same reducer; `SessionDirectory`,
2026-09-02: the management/query model over sessions -- get / list / active /
stats / rename / move / annotate, keyset-paginated, memory or SQL, fed from
`hostEvents` by `follow` -- kept apart from `DurableSessionStore` as
`effect-plan-2.txt` §26 insists).

**Applications.** `apps/tui` (full-screen local coding harness),
`apps/cli` (a client for any mounted HTTP agent), `apps/worker` (the published `/cloudflare` entry with the scripted model:
one DO per session, history in DO SQLite written at every committed turn,
events journaled to the delivery log, resumption across the runtime's
death, and `/scheduling`'s `AgentDispatcher` as logical alarms -- each
proven on workerd via miniflare, the alarm across a runtime restart), `examples/` -- every one typechecked;
`session-tree`, `ref-coding-agent`, `typed-agent` and the worker test also
run. `examples/deploy-cloudflare/` is the Alchemy stack.

## What holds it there

- Contract suites, **shipped from `/testing`** since 2026-09-01 so a client
  or store outside this repository is held to the same rows:
  `AgentClientConformance` (every client), `DeliveryLogConformance`,
  `NodeStoreConformance` and `DurableSessionStoreConformance` (every store),
  beside `SandboxConformance` and `ChannelConformance`; `McpServerConformance`
  and the cross-adapter host matrix stay in `test/`. Each shipped suite has a
  deliberately wrong implementation that fails exactly the promise it breaks
  (`test/ShippedConformance.test.ts`).
- Break-once discipline: a mechanism is not done until its test has been
  broken once and seen to fail. The history records each.
- Falsification: `scripts/falsify.mjs` re-runs the durability harness; the
  matrix rows and conformance suites each carry a deliberately wrong
  implementation.
- A second matrix, cross-cutting concerns against execution contexts
  (in-process, durable, behind a wire, delegated), in
  [conformance-matrix.md](./docs/conformance-matrix.md): every cell is a test
  or a declaration with a reason, and since 2026-09-05 none reads "not
  tested". Every bug the combination pass found had been a blank cell.
- Recorded fixtures for wire and journal changes (`test/fixtures/`): bytes
  recorded from a named commit and asserted identical, or identical plus
  exactly the intended difference, after. Two so far, and the convention is
  written down there.
- Doc claims carry the check that falsifies them
  (`scripts/verify-remaining-work.mjs`), so this file, the live list and the
  ledger cannot quietly disagree with the code.

```text
verify: exists scripts/verify-remaining-work.mjs
verify: exists test/fixtures/README.md
verify: grep "export type Any = AgentDefinition<any, any, any, any, any, any>" src/Agent.ts
verify: grep "RunLedger.record(" src/AgentRun.ts
verify: grep "export interface Inherit" src/subagent/Subagent.ts
```

## Deliberately not done

- **D4b** survives the falsification harness by construction
  (`instance.suspended` carries the correctness); the remaining disjuncts in
  `DurableAgent`'s `catchCause` are defence in depth.
- **`DurableAgent.workflow` requirement erasure** claims `never` while
  resolving `LanguageModel` at runtime.
- **Legacy MCP cancellation id mismatch** is upstream: the official client's
  cancel cannot interrupt the server.
- **The Anthropic example** has never been run live with a key;
  **`ClusterMultiNode`** runs on real time (~15 s).
- **Two decisions recorded, not made.** Whether a persisted key or a wire
  tag should ever derive from the package name (every `affe-agent/...` tag
  and `affe_*` table default does; item 55 says why it matters across two
  versions). And whether an interrupted delegation should say so to its
  parent rather than answer with what it had (item 50): a partial answer may
  genuinely beat none, and nobody has complained.
- **Threading and attachments** in channels wait on a decoder seam
  `/connectors` does not have.
- **Effect Workflow inside a Durable Object** stalls at the first activity
  on workerd (upstream; minimal repro in the history). The DO host uses the
  platform's durability instead; `/durable` runs where its engine runs.
- **The DO worker's model** is the scripted test model until a deployment
  wires a real one; the Alchemy stack is written for the `/cloudflare` entry
  (`nodejs_compat`, compatibility date 2026-08-25) but has not been run
  against a real account -- this container has none, and the owner's
  wrangler login is on their machine.

The larger parked work -- the reference gateway, code mode, filetypes
phase 5, the bridge packages, compaction's overflow *trigger* (the
rollover itself shipped as item 60d) -- is listed with its preconditions in
[remaining-work.md](./docs/remaining-work.md#larger-correctly-parked); what
it has finished is in [the ledger](./docs/remaining-work-closed.md).
