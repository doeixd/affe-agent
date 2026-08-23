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
`/state`, `/skills`, `/memory`, `/evals`, and an end-to-end integration proving
they compose.

### Issue #4 priority tier (P0/P1) — shipped

| # | Item | Status |
|---|---|---|
| 1 | Sandbox + workspace | `/sandbox` |
| 2 | Coding toolkit | `/coding` |
| 3 | Skills | `/skills` |
| 4 | Subagent / delegation | `/subagent` |
| 5 | Persistent typed state | `/state` |
| 6 | Generic interrupt / HITL | `Elicitation` (Deferred local, DurableDeferred durable) + `Permission.ask` |
| 7 | Dynamic capability-set | toolkit-as-Effect, resolved per turn (mechanism exists; undocumented) |
| 8 | Reconnectable streaming | `/durable-streams` + DeliveryLog |
| 11 | Evals | `/evals` |
| 9 | Structured client/UI data | `/data` |
| 10 | Channels | `/channels` |
| 13 | Lifecycle hooks | `/hooks` |
| 12 | Observability | `/observability` |

Issue #1 (items 1–9) is complete; the transports and sandbox it left open have
all since landed.

## Remaining gaps (all P2/P3)

Ranked by value-to-surface for what to build next:

1. **Scheduling / self-dispatch (`#14`)** — an `AgentDispatcher` Service (local
   / Workflow / queue impls) so an agent can enqueue future work without
   learning a scheduling runtime. **Top (last) build pick.**
2. **P3 / ecosystem** — CLI, dev & deployment ergonomics, more
   sandbox/channel/deployment adapters (a real crypto-backed Slack signature
   verifier as a host-flagged sub-entry, more channel platforms).

### Small refinements worth folding in

- **Schema-typed elicitation resolution** — `Elicitation.Response.value` is
  `Schema.Unknown`; validate it against the request's schema, and guard against
  double-resolution with an explicit terminal state.
- **Document the dynamic-capability story** (#7) — the toolkit-as-Effect
  mechanism exists; it needs a short section, not code.
- **Getting-started / package-map** at the top of the README.

## Order of work

1. Update the tracker: mark #4's shipped items, finalize/close #1.
2. Build `/observability`.
3. Then `/data`, then a first `channels` adapter.
