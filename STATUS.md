# Status — what is true now

Last regenerated 2026-08-30. This is the short document: what ships, what
holds it there, and what is deliberately not done. The chronology -- every
finding, every falsification, every "what the second subscriber found" --
moved to [docs/status-history.md](./docs/status-history.md) and keeps growing
there; new work appends a dated section *there*, and edits the line here it
changes. [docs/remaining-work.md](./docs/remaining-work.md) is the ranked
list of what is next; `ROADMAP.md` the capability view; `PLAN.md` the design
authority.

## The gates

Regenerate these from the commands; do not hand-edit the numbers.

| gate | command | now |
| --- | --- | --- |
| tests | `npm test` | 1580 passing in 139 files (`McpServerConformance` runs separately while under edit) |
| Effect diagnostics | `npm run lint` (+ `lint:cli`, `lint:tui`) | 0 errors, 0 warnings, 0 messages |
| types | `npm run typecheck` (+ `:cli`, `:tui`, `:worker`) | clean, examples included |
| casts | `test/Casts.test.ts` | every erasing cast in `src/` is inventoried in `AGENTS.md` with its reason (six files) |
| portability | `npm run lint:portability`, `verify:workerd` | no host coupling outside host modules; the worker bundle builds |
| package | `npm run verify:package` | every published entry point imports from the packed tarball |
| durability | `npm run verify:durability` | D1–D7 bite when broken; D4b survives by construction |
| smoke | `smoke:ref-coding`, `smoke:cli`, `smoke:tui` | the reference coding agent, the CLI and the TUI run end to end |

Built on **Effect v4 (`effect@4.0.0-rc.111`)**; the AI modules are the in-tree
`effect/unstable/ai`. Node 22.5+ only for the host entries.

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
`Elicitation`, `InputChannel`) has not grown since `0.0.1`. Everything else is
built *from* it: a Service, a Layer, a toolkit, a transform, an adapter.

## What ships

One line per surface; the maturity label is the README's
([Maturity map](./README.md#maturity-map)). The plan that specified each is in
[remaining-work.md](./docs/remaining-work.md#already-done--do-not-restart).

**Core.** Sessions with prompt / submit + awaitSubmission / steer / follow-up
/ interrupt / respond; bounded retention of settled outcomes with idempotency
keys; typed tool execution with strategies and failure policies; permission
policy with projections, rules and remembered grants; elicitation with a
terminal state; snapshots and restore; execution plans; the event ADT with
the correlation envelope; `PromptWire` so files cross every boundary intact.

**Transports.** `/client` is the protocol-neutral seam (`AgentClient`,
`AgentSessionHost` with capacity, per-session request buckets, authorization,
idempotent mutations, enumeration and a bounded event tail). Over it: HTTP +
SSE (resumable from `Last-Event-ID` on a durable backing), Effect RPC (HTTP
and WebSocket), AG-UI (official client, elicitation through interrupt input),
A2A v1 (REST and JSON-RPC, official client, tasks, cancel, push configs, a
remote peer as a tool), MCP (nine tools, history / pending / sessions /
event-log resources, both official client generations, stdio elicitation).
The [cross-adapter matrix](./docs/conformance-matrix.md) holds all five to the
same rows.

**Durability and scale.** `/durable` runs the same agent inside a Workflow
with journaled events, typed `StorageError`s at every store, a delivery log
that makes resumption a property of the backing, and a durable client that
survives the process; `/cluster` makes a session an entity (typed
`StorageError` on the wire) and adds scheduled agents; `/durable-streams`
delivers events across nodes.

**Principal.** `Principal.CurrentPrincipal` (root): the caller's subject on
the fibre that acts -- a `Context.Reference` the host sets per request
(`AgentSessionHost.Options.subject`), `None` outside any host, carried on
the durable claim/payload so replays see what the claimer saw.

**Reference implementations.** `examples/ref-coding-agent.ts` and
`examples/ref-gateway.ts` (`plan-primitives.md` §4) are built only from the
public surface, carry compile-time assertions that inference stayed
precise, and run in CI. What `ref-gateway` found, which is the point of
the exercise:

- **Nothing was missing.** Sources, the three credential layers,
  per-principal bindings, per-tool policy and the host all composed from
  `@doeixd/effect-agent/*` with no cast and no private import. That is the
  integration axis' acceptance test passing.
- **A write is refused twice, independently** -- and the second guard is
  the one nobody would notice losing. The operator's `Permission` policy
  denies it, *and* the OpenAPI source's own non-GET annotation is floored
  by `ToolSource.bind` into the tool's `needsApproval`, which asks; an
  agent with no elicitor fails closed. A gateway whose policy is
  misconfigured still does not silently write. Both are asserted, and
  disabling the floor fails the smoke.
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
host's elicitor and throws into it when refused. Durable suspension of a
paused program is deliberately not offered.

**Batteries.** `/blob` (+ `/blob/fs`): content-addressed blob storage with
size/MIME policy and `BlobWire` externalize/resolve over the encoded
prompt form; `/sandbox` (+ `/sandbox/local`) with a conformance suite and
tier-0/1 derivation (`Sandbox.fromExec` / `fromOperations`: any host that
can run a command is a sandbox, shell-derived operations reported as such);
`/coding` and `/pi` tool batteries over it; `/shell` with construction-time
dialects; `/tool-source` (OpenAPI, GraphQL, MCP; approval hints become
`needsApproval`; `Credentials` -- method, binding, provider -- `Redacted`
until the header is written); `/subagent`; `/state`; `/skills`; `/memory`; `/evals`;
`/observability`; `/export` (JSON envelope + JSONL commit log); `/compaction`
(+ branch carryover: `BranchSummary` over the tree's seed seam, and
`CodingSummary`'s cumulative file details);
(token policy, checkpoints, controller, events); `/redaction`; `/budget`;
`/data`; `/hooks`; `/scheduling`; `/connectors` (+ Slack, with a channel
conformance suite); `/plugins`; `/tree` (sessions as a tree: branch, lanes,
divergence, activation); `/web` (+ Brave, HTTP fetch); `/openai`
(OpenAI-compatible responses).

**Applications.** `apps/tui` (full-screen local coding harness),
`apps/cli` (a client for any mounted HTTP agent), `apps/worker` (a real
Durable Object host: one DO per session, history in DO SQLite, events
journaled to the delivery log, resumption across the runtime's death --
proven on workerd via miniflare), `examples/` -- every one typechecked;
`session-tree`, `ref-coding-agent`, `typed-agent` and the worker test also
run. `examples/deploy-cloudflare/` is the Alchemy stack.

## What holds it there

- Contract suites: `AgentClientContract` (every client), `DeliveryLogContract`
  and `NodeStoreContract` (every store), `McpServerConformance`,
  `SandboxConformance`, `ChannelConformance`, and the cross-adapter host
  matrix.
- Break-once discipline: a mechanism is not done until its test has been
  broken once and seen to fail. The history records each.
- Falsification: `scripts/falsify.mjs` re-runs the durability harness; the
  matrix rows and conformance suites each carry a deliberately wrong
  implementation.

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
- **Per-principal credential resolution.** The contract is
  `docs/plan-tool-credentials.md` and its single-user slice ships
  (`Credentials` in `/tool-source`); the multi-user half waits on one
  kernel decision -- the principal reaching the tool fibre.
- **Threading and attachments** in channels wait on a decoder seam
  `/connectors` does not have.
- **Effect Workflow inside a Durable Object** stalls at the first activity
  on workerd (upstream; minimal repro in the history). The DO host uses the
  platform's durability instead; `/durable` runs where its engine runs.
- **The DO worker's model** is the scripted test model until a deployment
  wires a real one; the Alchemy stack is written but has not been run
  against a real account.

The larger parked work -- the reference gateway, code mode, filetypes
phase 5, the relay and bridge packages, compaction's overflow-recovery
phase 15 -- is listed with its preconditions in
[remaining-work.md](./docs/remaining-work.md#larger-correctly-parked).
