# Roadmap

Where `@doeixd/effect-agent` stands against the two roadmap issues (#4 Flue-2
parity, #1 streaming + ecosystem), and what is worth doing next. The guiding
rule stays [#4's](https://github.com/doeixd/effect-agent/issues/4): a package
adds a capability, policy, interpreter, or adapter — never a parallel execution
model; reach for an ordinary `Effect` / `Service` / `Layer` / `Stream` /
`Schema` / `Tool` / `ContextTransform` / `AgentLoop` first.

## Done

**Core** — sessions, runs, atomic turns, the loop, Schema events, context
transforms, steering/follow-ups, interruption, model streaming, elicitation
(the generic HITL primitive), permissions, snapshots, compaction.

**Transports & durability** — `/client`, `/rpc`, `/http`, `/ag-ui`, `/a2a`,
`/mcp` (+v1/v2), `/durable`, `/cluster`, `/durable-streams`, `/openai`.

**Higher-level packages** — `/sandbox` (+local), `/coding`, `/subagent`,
`/state`, `/skills`, `/memory`, `/evals`, `/observability`, `/data`, `/connectors`,
`/hooks`, `/scheduling`, `/budget`, `/plugins` (load an Agent Plugins package over /skills + /mcp), and an
end-to-end integration proving they compose.

### Issue #4 priority tier (P0/P1) — shipped

| # | Item | Status |
|---|---|---|
| 1 | Sandbox + workspace | `/sandbox` |
| 2 | Coding toolkit | `/coding` |
| 3 | Skills | `/skills` |
| 4 | Subagent / delegation | `/subagent` |
| 5 | Persistent typed state | `/state` |
| 6 | Generic interrupt / HITL | `Elicitation` (Deferred local, DurableDeferred durable) + `Permission.ask` |
| 7 | Dynamic capability-set | toolkit-as-Effect, resolved per turn (documented: README "Dynamic capabilities", `examples/dynamic-capabilities.ts`) |
| 8 | Reconnectable streaming | `/durable-streams` + DeliveryLog |
| 11 | Evals | `/evals` |
| 9 | Structured client/UI data | `/data` |
| 10 | Channels | `/connectors` |
| 13 | Lifecycle hooks | `/hooks` |
| 14 | Scheduling / self-dispatch | `/scheduling` |
| 12 | Observability | `/observability` |

Issue #1 (items 1–9) is complete; the transports and sandbox it left open have
all since landed.

## Remaining gaps

The issue #4 P0–P3 capability roadmap (items 1–14) is **complete**. What's left
is ecosystem polish, not capability:

1. **P3 / ecosystem** — dev and deployment ergonomics, plus more
   sandbox/channel/deployment adapters (more channel platforms and
   durable/queue implementations of `AgentDispatcher`). The conventional CLI
   and portable crypto-backed Slack verifier now ship in this repository.
2. **Effect modules we are re-deriving** —
   [docs/audit-effect-ecosystem.md](./docs/audit-effect-ecosystem.md) measured
   every `effect` import against the v4 module list. The core is used deeply;
   the gaps clustered around real work, and the audit's actions have now
   landed. `ExecutionPlan` supplies provider fallback and per-model retry
   ladders; `Tx*` closed the coding toolkit's lock leak; `Metric` gave
   `/observability` its instruments; typed `StorageError`s replaced the stores'
   `orDie`; and `Schedule` gained backoff and jitter. `RcMap` owns tree
   sessions; static server mounts use scoped layers because `LayerMap` does not
   fit construction-time routes; Web Crypto verifies Slack HMACs; and
   `apps/cli` uses `unstable/cli` + `Terminal`.

### Small refinements worth folding in

- **Elicitation terminal state** — decoding `Response.value` against the
  request's schema exists; an explicit terminal state guarding against
  double-resolution does not.
- ~~Document the dynamic-capability story~~ — done (README section + example).
- ~~Getting-started / package-map~~ — done: README "Package map" and
  [docs/MODULES.md](./docs/MODULES.md).

## Design threads opened 2026-08-27

Six documents, now partly implemented (see
[docs/remaining-work.md](./docs/remaining-work.md) for exactly which slices), indexed in [docs/README.md](./docs/README.md)
and argued between in
[docs/plan-primitives.md](./docs/plan-primitives.md).

One of them qualifies the assessment above. "Ecosystem polish, not capability"
holds for issue #4's scope, but the **integration axis** — a `ToolSource` seam
over OpenAPI/GraphQL/WebMCP/CLI sources, plus credential resolution per
principal — is capability work by this document's own definition. The seam
and the OpenAPI/GraphQL/MCP sources have since shipped as `/tool-source`;
per-principal credential resolution has not. See
[docs/research-tool-sources.md](./docs/research-tool-sources.md).
The rest of the threads (MCP frontend, code mode, integrations, deployment) are
adapters, batteries and entry points, and do fit "polish".

## Order of work

**Superseded.** The three steps that used to sit here — build `/observability`,
then `/data`, then a first channel adapter — all shipped and are listed under
*Done* above. The live ranking is
[docs/remaining-work.md](./docs/remaining-work.md). #1 is closed; #4 is the
only open issue and stays open as the tracker until its shipped items are
marked off and it is closed.
