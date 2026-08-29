# Plan: `AgentServer`

Sixth in the series. A response to: *"an AgentServer primitive that uses Effect
HTTP / HttpApi to serve multiple agents at specified endpoints, with middleware,
cookies, auth, OTel, backup, management, and maybe agents on different infra."*

## The short answer

**Most of this exists. What is missing is composition, not authority.**

There is already an HTTP surface (`AgentHttp.Api`, a real `HttpApi` with a full
session group, `serverLayer`, and a schema-generated `clientLayer`), and there
is already a thing that owns registry, capacity, authentication and
authorization for every adapter: `AgentSessionHost`. What does not exist is a
way to say *"serve these four agents, at these paths, behind this middleware"*
without hand-wiring it and hitting a trap (below).

So `AgentServer` should be **a composition layer over hosts**, not a new
authority. The moment it grows its own auth or its own registry it is competing
with `AgentSessionHost`, and we have two answers to one question.

## What already exists

| Need | Where it lives today |
| --- | --- |
| HTTP endpoints for a session | `AgentHttp.Api` — `HttpApi` with `sessions`: create / close / get / prompt / steer / follow-up / interrupt / respond / pending |
| Serving it | `AgentHttp.serverLayer({ host })` |
| A typed client | `AgentHttp.clientLayer({ baseUrl })`, schema-generated |
| **Authentication** | `AgentSessionHost.Options.principal: PrincipalResolver` — `headers -> Principal` or `AgentUnauthorizedError` |
| **Authorization** | `AgentSessionHost.Options.authorization` — per operation and session |
| Capacity | `maxSessions`, `maxRequestsPerSession` on the host |
| Shared state across adapters | One host tag serves *"the same registry, the same capacity, and the same authentication"* — HTTP, RPC, A2A, AG-UI and MCP all sit on it |
| Tracing | The host annotates every span with `agent.operation` and `agent.session.id` so *"every adapter's traces read the same"* |
| **Agents elsewhere** | A host is backed by an `AgentClient`, not an `AgentDefinition` |

That last row is the one that answers the hardest question in the request, and
it is worth stating plainly.

## "Agents on different infra — like a front end? Or maybe not?"

**This is already solved, and it should not become a mode.**

`AgentSessionHost.layer` requires `AgentClient.AgentClient`. `AgentClient` is
the abstraction whose own docstring says: *"an application that runs its agent
locally today and remotely tomorrow writes the same code either way."*
Implementations are checked against a shared `AgentClientContract`, and there
are already several — in-process (`AgentClient.layer(agent)`), durable
(`DurableAgentClient`), and remote over the HTTP client.

So:

- **Hosting** an agent in-process is `AgentClient.layer(myAgent)`.
- **Fronting** an agent that runs elsewhere is a remote client layer.
- **Fronting a durable, clustered agent** is `DurableAgentClient`.

`AgentServer` never learns which. There is no "gateway mode" to build, because
gateway-ness is a layer the application chooses per agent — and one server can
mix them: two local agents and one remote, behind the same auth, in the same
process. Building a separate proxy concept would throw that away and add a
second code path to keep honest.

## The one real gap, and a trap in it

Serving several agents needs each to have its own host (its own registry and
capacity) and its own path. The obvious approach — prefix the API and combine —
**silently loses agents**. Tested:

```ts
AgentHttp.Api.prefix("/agents/alpha").addHttpApi(AgentHttp.Api.prefix("/agents/beta"))
// => no error, and exactly one group: ["sessions"]
```

Both copies carry the group id `sessions`, so the second replaces the first with
no complaint. Anyone wiring multiple agents by hand will hit this, and will hit
it as *"my second agent 404s"* rather than as an error. Two ways out:

**A. Name the group per agent.** `AgentHttp.api({ name })` produces a group id
derived from the name and a prefixed path. Each agent gets a distinct group, its
own typed client, and its own middleware. Costs a change to `/http`: today
`Api` and its group are consts.

**B. Make the agent a path parameter.** One group, `/agents/:agent/sessions/...`,
and the server resolves the host by name at request time. Simpler, one uniform
surface, no duplication — but middleware is then per-server rather than
per-agent, and the agent name is a runtime value rather than part of the type.

**Recommendation: A, with B available.** Per-agent groups keep the typed client
per agent and let one agent carry stricter middleware than another, which is the
common real requirement (an internal admin agent and a public support agent do
not share an auth policy). B is a legitimate shape for a uniform fleet and falls
out of the same registry, so it can come later if wanted.

## Design

```ts
AgentServer.make({
  agents: [
    AgentServer.mount("support", { path: "/agents/support", host: SupportHost }),
    AgentServer.mount("internal", { path: "/agents/internal", host: InternalHost })
  ],
  middleware: [...]        // applied to all; per-mount middleware also allowed
})
```

Properties it must have, all of which follow from the library's existing style:

- **It returns an `HttpApi`, not a server.** The application composes it with
  its own API, adds its own routes, applies its own middleware, and serves it
  however it likes. A primitive that owns `listen()` is a framework; a
  primitive that hands back an `HttpApi` is a value.
- **A mount is a value.** `AgentServer.mount(...)` is data, so a server can be
  assembled from configuration, filtered, or extended by an application.
- **Auth stays on the host.** Cookies are read in a `PrincipalResolver` like any
  other header; there is nothing cookie-specific to add. What we should add is
  an example, because "where does auth go" is the question this API will be
  asked most.
- **No new type parameters on `Agent.make`.** AGENTS.md §42.1: a cross-cutting
  concern is a combinator, not a tenth parameter. The same applies here — the
  server composes, it does not thread.

### Mount lifetimes are `LayerMap`, and live sessions are `RcMap`

The half of this design that is easy to get wrong, and the ecosystem already
answers it — see [audit-effect-ecosystem.md](./audit-effect-ecosystem.md) E4.

A mount owns a wiring (its host, its registry, its capacity) whose lifetime is
"as long as somebody is using this agent." Built eagerly for every mount, a
fleet pays for agents nobody has called; built ad hoc and cached in a `Map`, it
never releases. **`LayerMap` is exactly a keyed, ref-counted, scoped layer per
key** — built on first use, released when the last user goes — so a mount
becomes a key rather than a lifecycle we manage.

The same shape one level down: live sessions are keyed, scoped resources with
several concurrent readers (an SSE consumer, an RPC caller, the run fibre).
**`RcMap`** releases an entry when its last reader leaves. Hand-rolling that
is the standard way an agent server leaks sessions, and it leaks the way that
shows up an hour into production rather than in a test — which is why AS6 below
asserts it by count rather than by inspection.

Neither changes the public API: `AgentServer.mount(...)` stays a value, and
both are wiring behind it.

- **Configuration arrives through `Config`.** Ports, capacities, per-mount
  limits and provider credentials are `Config`, and credentials stay `Redacted`
  from arrival to use (audit E13). `/observability` already owns a redaction
  policy for telemetry; a server that reads secrets some other way gives us two
  answers to one question.

## On the rest of the list

**OTel: emit, never export.** AGENTS.md is explicit — *"Tracing export is
application wiring, never a harness dependency."* `AgentServer` should produce
well-named spans and attributes (the host already annotates `agent.operation`
and `agent.session.id`) and must not import an exporter or take an OTLP
endpoint. "Supports OTel" is then true in the way that matters: spans exist,
the application points them wherever it wants. `/observability` already covers
the event-stream half.

**"Backup" needs defining, and probably is not a server concern.** If it means
sessions surviving a crash, that is `/durable` and it is chosen by which
`AgentClient` a host is given — nothing for the server to do. If it means
exporting transcripts, that is
[plan-snapshot-export.md](./plan-snapshot-export.md). If it means backing up a
database, it belongs to the operator. **A server that owns backups owns state
it should not own**, and would quietly become the thing that must be running for
your data to be safe. Recommend: no backup feature; document which of the three
meanings maps where.

**Management: read-only, and small.** An inventory endpoint (which agents are
mounted, how many sessions, capacity remaining, health) is genuinely useful and
cheap, because the host already knows all of it. A *mutating* admin API —
evicting sessions, changing limits, hot-mounting agents — is where scope creep
lives, and every one of those is an ordinary `HttpApi` an application can write
against the host it already has. Ship the read-only view; do not ship the
console.

## Invariants

**AS1 — Mounting N agents serves N agents.** No mount silently replaces
another; a duplicate name or path is an error at construction, not a 404 at
runtime. (This is the tested trap above.)

**AS2 — The server owns no policy.** Authentication, authorization and capacity
remain the host's. The server routes; it does not decide.

**AS3 — Local and remote are indistinguishable to the server.** A mount backed
by an in-process agent and one backed by a remote client differ only in the
layer supplied, and the same tests pass against both.

**AS4 — It returns a value, not a running process.** The result composes with an
application's own `HttpApi`; nothing here binds a port.

**AS5 — No exporter dependency.** The package imports no telemetry backend;
spans and attributes only.

**AS6 — Mounting is reversible.** After N mounts are used and released, no
session and no mount layer stays live. A server that has served and gone quiet
holds nothing.

## Milestones

- **S1 — Named API.** `AgentHttp.api({ name })` with a per-name group id and
  prefix; the current `Api` const stays as the single-agent case. Test AS1,
  including that a duplicate name fails loudly.

  **S1: landed (2026-08-26).** `AgentHttp.api({ name, path? })`. Prefixing
  `Api` twice still silently keeps one group — pinned as the trap. Named
  groups both survive. `serverLayer` takes an optional `path` so the router
  matches the schema.
- **S2 — `AgentServer.make` / `mount`.** Composition to an `HttpApi`, per-mount
  and shared middleware, with mount wiring on `LayerMap` and live sessions on
  `RcMap`. Tests AS2, AS4, AS6.

  **S2: landed (2026-08-26), with one recorded substitution.** `mount` /
  `make` / `DuplicateMountError` / `serverLayer`. Duplicate name or path
  fails at construction. Two mounts are reachable on their own paths; after
  the server scope closes, separate counters prove both hosted sessions and
  mount layers are gone (AS6).

  `LayerMap` is not used for route registration: `HttpRouter.use` binds
  paths when the layer is built, not on first request, so lazy mount
  construction does not fit option A (per-agent prefix). Host lifetime stays
  on `AgentSessionHost`, which already owns the session registry. Revisit
  `LayerMap` if option B (agent as a path parameter) is built.
- **S3 — Mixed backing.** One server with a local agent and a remote one,
  asserting identical behaviour through both (AS3) — reusing
  `AgentClientContract` rather than writing new assertions.

  **S3: landed (2026-08-26).** `AgentHttp.fromGenerated` / `agentClientLayer` /
  `agentClientFromServer` wrap the schema-generated HTTP client as
  `AgentClient`. `test/AgentHttpClient.test.ts` runs the shared contract
  against that adapter (stream-delta observation is opted out: SSE needs a
  connection latch the contract's one `yieldNow` is not). 
  `test/AgentServer.test.ts` mounts a local `AgentClient.layer` and a
  remote HTTP-backed client on one `AgentServer` and prompts both.
- **S4 — Inventory.** Read-only mounts/sessions/capacity/health endpoint.

  **S4: landed (2026-08-26).** `/inventory` returns Schema-typed mount
  snapshots. Coverage reads it before and after creating a session.
- **S5 — The auth example.** Cookie and bearer `PrincipalResolver`s, per-mount
  authorization, in `examples/`. This is documentation that compiles, and it is
  what makes the feature usable.

  **S5: landed (2026-08-27).** `examples/agent-server-auth.ts` mounts a bearer-
  authenticated support agent and a cookie-authenticated admin agent on one
  server. Authentication stays in each host's `PrincipalResolver`; independent
  role policies return the existing typed 403 when an authenticated principal
  crosses mount authority. Credentials come from `Config.redacted`, captured
  when the host layers are built. `test/AgentServerAuthExample.test.ts` imports
  the example itself and covers valid, missing and malformed bearer headers,
  named cookie decoding among unrelated cookies, malformed encoding, and the
  per-mount authorization boundary. No server-owned auth concept was added.

## Success conditions

- **SS1:** Two agents mounted, both reachable, each with its own typed client;
  a duplicate mount fails at construction with a message naming the collision.
- **SS2:** The same suite passes against a mount backed by `AgentClient.layer`
  and one backed by a remote client, unchanged.
- **SS3:** An application composes `AgentServer`'s API with its own routes and
  middleware, typechecked in an example.
- **SS4:** `npm run lint:portability` still passes — the server is
  capability-requiring, not host-coupled, and imports no exporter.
- **SS5:** After a fleet of mounts is exercised and released, live sessions and
  live mount layers both count zero (AS6), asserted rather than inspected.

## Non-goals

Owning authentication, a session console, backups, a telemetry exporter, a
`listen()` call, or a bespoke proxy concept for remote agents. Rate limiting and
quotas beyond the host's existing capacity bounds. A second answer to any
question `AgentSessionHost` already answers.
