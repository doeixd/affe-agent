# Plan: deployment — Node, Durable Objects, Rivet actors, Alchemy, and fronting

Written 2026-08-27. Where an agent built on this package can actually run, how a
public server delegates work to it, and why the answer is entry points and
Layers rather than a deployment system.

**Status: in progress.** Sequence step 1 landed 2026-08-27. `apps/worker` is
typechecked without Node types, checked by the portability scanner, and bundled
for the browser/workerd resolution path by `verify:workerd` in `npm run check`.
It needed no portability exception. No real Worker or Durable Object host exists
yet; steps 2 onward remain design.

## 1. The three targets are one shape

A Durable Object, a Rivet actor, and a `/cluster` entity are the same thing: a
**single-owner, addressable, persistent process per session**. `AgentEntity`
already says so:

> PLAN §11's "at most one run per session" is exactly an entity invariant, and
> `AgentSession.Id` is exactly a routing key.

On these platforms that invariant is enforced *by the platform* rather than by
sharding we arrange. So this is one adapter shape parameterised three ways, not
three ports — and on Cloudflare or Rivet, `/cluster` may be unnecessary rather
than required.

The second unifying fact: **every protocol adapter already speaks
`AgentSessionHost`**, so `/http`, `/rpc`, `/mcp`, `/ag-ui` and `/a2a` work
unchanged inside a Durable Object or an actor. The host runs with capacity 1;
the platform does the routing. Nothing in the transports needs to know.

## 2. Node — works today

`apps/cli` and `apps/tui` run. `/sandbox/local` is the Node provider,
`@effect/platform-node` supplies the platform layers, `@effect/sql-sqlite-node`
backs the stores. Nothing to plan.

## 3. Cloudflare Durable Objects

### 3.1 The mapping

| harness | Durable Objects |
| --- | --- |
| a session, single-owner | one DO per `AgentSession.Id` — the platform *is* the sharding |
| `AgentSessionHost` | runs inside the DO, `maxSessions: 1`; the Worker routes by id |
| `/http` router | `HttpEffect.toWebHandlerLayer` — Effect ships the `Request → Promise<Response>` adapter, so the Worker `fetch` handler is a stock function, no Node shim |
| session / tree / state stores | DO storage, or `@effect/sql-d1` (ships at `4.0.0-rc.112`) |
| `/scheduling`'s `AgentDispatcher` | DO alarms |
| `events({ after })` | WebSocket hibernation plus `/durable-streams`' `DeliveryLog` — hibernation is precisely why resumption-by-sequence exists rather than a live stream |
| `/cluster` | **probably not needed.** A DO is the entity. |

The portability guardrail was built for this: `verify-portability.mjs` rejects
`node:*`, bare built-ins, concrete platform packages and host globals in every
module except `sandbox/local.ts`. If the guardrail is honest, the portable core
already loads on `workerd`.

### 3.2 Blockers

1. **No sandbox provider.** `local` is Node-only, `memory` has no shell. A
   Worker needs a remote one — Cloudflare Containers, or E2B/Daytona. This is
   exactly [plan-integrations.md](./plan-integrations.md) §6.2's `fromExec`:
   one function, and the whole `Sandbox` surface derives.
2. **`/durable` needs a `WorkflowEngine`.** *Decided 2026-08-30, by
   measurement rather than argument.* `SingleRunner` over
   `@effect/sql-sqlite-do` builds and migrates inside a DO (after two real
   findings: the DO driver needs the whole `DurableObjectStorage`, not just
   `.sql`, and the engine's own sqlite migration nests a transaction the DO
   driver refuses -- worked around with a re-entrant wrapper). But a bare
   two-activity workflow then **times out on workerd** where the identical
   program completes in ~140ms on Node -- the suspend/resume machinery does
   not progress there. So: **a Durable Object is the durable execution**;
   `apps/worker` persists history to DO SQLite per completed submission and
   journals events to the ordinary `DeliveryLog`, and `/durable` stays on
   hosts whose engine runs. Full detail in `docs/status-history.md`.
3. **CPU metering.** A long run is mostly waiting on the model, which DOs bill
   as wall-clock rather than CPU. Compaction, large-transcript JSON and
   `/export` are genuinely CPU-bound and will meter. Measure before assuming.
4. **DO storage limits** apply to the transcript. `/compaction` changes the
   projection, not canonical history, so the stored transcript grows without
   bound. `/export` plus eviction is the answer, and it is not currently wired.
5. `apps/cli`, `apps/tui` and `/sandbox/local` do not travel, by design.

## 4. Rivet actors

`rivet-dev/actors` — 6k stars, Apache-licensed, and explicitly *"built for AI
agents"*. RivetKit is a portable TypeScript library that runs on Node, Bun,
Cloudflare, Vercel or self-hosted, so an adapter here is **not** a Cloudflare
bet.

### 4.1 The mapping, and one exact match

| harness | Rivet |
| --- | --- |
| a session | one actor per session — their own first-listed use case |
| **`InputChannel`** | **the actor's durable queue** |
| `AgentEvent` stream | `c.broadcast(...)` to connected clients |
| `AgentDispatcher` | actor timers and cron |
| resumption | hibernation plus persisted state |
| stores | in-memory state with automatic persistence; SQLite or BYO |

The queue match is the interesting one. `InputChannel` exists as a substitutable
seam for one reason, stated in its own header: a durable interpreter must record
the drained batch alongside the turn that consumed it, or replay derives a
different prompt than the journal recorded. Rivet's durable queue is exactly
that primitive, already persisted, already ordered. **An `InputChannel.Factory`
over a Rivet queue is a small adapter that either validates the seam or exposes
a flaw in it** — which makes it worth building for reasons beyond Rivet.

### 4.2 Frictions

- Their API is imperative and Promise-shaped (`c.state.messages.push(...)`), so
  the adapter is a bridge rather than a natural fit.
- Their `run` model wants to own the loop; the harness owns its own. The
  relationship is **an actor hosts a session**, not an actor replacing one —
  the same relationship `/cluster` already has, so the shape is known.

## 5. Alchemy

### 5.1 What it is now

`alchemy-run/alchemy` — Apache-2.0, ~1.1k stars, pushed today — has been
rewritten as **"Infrastructure as Effects": cloud infrastructure and application
logic as a single, type-safe Effect program.** Its install line is
`bun add alchemy@latest effect@rc` — **the same Effect v4 rc line this repo
targets.** (The older `alchemy-run/alchemy-async`, "Infrastructure as
TypeScript", is the pre-Effect line; it is not the one to build against.)

A stack is an Effect program:

```ts
export default Alchemy.Stack("Stack", {
  providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
  state: Cloudflare.state(),
}, Effect.gen(function* () { … }).pipe(Effect.provide(SomethingLive)))
```

Resources are `Effect`s, bindings are typed and wire the IAM policy, env var and
client in one call, and cloud failures are tagged errors. It covers Cloudflare
Workers, D1, R2, **Durable Objects and Containers**, plus AWS.

Two of their examples are close enough to be worth reading before writing
anything: `cloudflare-agent`, and `cloudflare-microvm-shell` — "Browser terminal
→ Cloudflare Worker → Durable Object → AWS Lambda MicroVM", a per-session DO
streaming exec against a remote VM. That is very nearly this project's
deployment topology, already written down by someone else.

### 5.2 Why it fits, and the line not to cross

It fits because it is the same substrate: Layers compose with Layers, tagged
errors with tagged errors, and there is no YAML or second runtime to bridge. The
D1 client, the DO binding and the Container are all provisioned in the same
program that provides our store and sandbox layers.

**But the library must never depend on Alchemy.** Alchemy is a *deployment-time*
dependency of an *application*; this package ships Layers and knows nothing
about how they were provisioned. Coupling the library to an IaC tool would
violate the portability guardrail in spirit and make one deployment story
mandatory. They meet in the application's `alchemy.run.ts`, and nowhere else.

So what we ship is an **example stack**, not an integration package:
`examples/deploy-cloudflare/` with an `alchemy.run.ts` that provisions a Worker,
a DO namespace, D1 and a Container, and wires our layers into them. Copyable,
verifiable, and deletable without touching `src/`.

## 6. Fronting and delegation

The question this section answers: can a public server that people connect to
delegate the actual work to Workers, to Durable Objects, or to machines
elsewhere?

**Yes, and the architecture already says so in one line.** `AgentServer`'s
header:

> `AgentServer` returns an `HttpApi` (a value) and a layer that registers the
> prefixed routes. Auth stays on the host. **Local vs remote is whichever
> `AgentClient` the host was given.**

A mount is *data*. A host is built over some `AgentClient`. Whether that client
is in-process, HTTP to another server, RPC over a socket, or a relay to a
machine behind NAT is a Layer choice the caller cannot observe. `AgentHttp`
already ships the pieces — `fromGenerated`, `agentClientLayer`,
`agentClientFromServer` — and one server serving a local mount beside a
remote-backed mount is already tested (`docs/remaining-work.md` S3).

So there are three delegation topologies, and they are not the same thing.

### 6.1 Ingress Worker → per-session Durable Object

```text
client ──HTTPS──> Worker (stateless ingress, routes by session id)
                     │  env.SESSIONS.idFromName(sessionId)
                     ▼
                  Durable Object ── AgentSessionHost (maxSessions: 1) ── Agent
```

This is **platform routing, not delegation**. The Worker holds no session state
and makes no `AgentClient` decision; the DO *is* the session, and everything in
§3 applies. Relay is irrelevant here — the platform already provides
single-owner addressing, which is the entire problem relay solves.

This is the default shape for "a server people connect to" on Cloudflare.

### 6.2 Front server → agents reachable by URL

```text
client ──> gateway (AgentServer, several mounts)
                     ├── mount "local"   → in-process AgentClient
                     ├── mount "billing" → agentClientLayer → https://…workers.dev
                     └── mount "research"→ agentClientLayer → another region/account
```

A gateway composing mounts whose clients are HTTP-backed. Works today, needs no
new mechanism, and is how you put one public endpoint in front of many Workers,
regions or tenants. Authentication and authorization stay on the gateway's host;
the downstream agent authenticates the gateway separately.

Worth being precise: **a Worker has a public URL, so relay adds nothing here.**
Reaching for relay in this topology would be building a tunnel to a host that is
already reachable.

### 6.3 Front server → peers that cannot accept inbound connections

This is where [plan-relay.txt](./plan-relay.txt) earns its place. Its own
framing:

> Relay is not an agent runtime. It is a secure, addressable transport that lets
> Effect services running on machines behind NAT/firewalls communicate through
> one public endpoint.

A laptop, an on-prem VPS, a Raspberry Pi, a machine inside a customer's network
dials **outbound** to the relay over WSS; the relay routes by `PeerId`; nothing
opens an inbound port. The plan's central discovery is that this needs no change
to the agent layer at all — `AgentRpc` stops at Effect RPC's protocol boundary,
and a relay is an `RpcClient.Protocol` implementation:

```text
AgentClient → AgentRpc → RpcClient → RelayRpc Protocol → RelayClient
                                          │  WSS
                                    RelayServer  (route by PeerId)
                                          │  WSS
                    RelayNode → RpcServer → AgentRpc → AgentSessionHost → Agent
```

So a relay-backed mount is just another `AgentClient` in §6.2's table, and
`AgentRpc` runs unchanged on both ends.

**The hybrid is the interesting case for this plan**: a public Cloudflare Worker
as the front door, some sessions handled by Durable Objects in the same account,
and others relayed to an agent running on the user's own hardware — with a real
sandbox, real files and real credentials that never leave their machine. That is
one `AgentServer` with two kinds of mount, and the caller cannot tell which is
which.

### 6.4 The relay server is itself a good Durable Object

An observation, not something plan-relay.txt says — it predates the deployment
work and never mentions Cloudflare.

`RelayServer` needs exactly what a DO provides: a single owner per routing key,
long-lived WebSocket connections that can hibernate, and a small amount of
durable state for the peer registry, leases and the durable mailbox. The plan's
own split between **live** traffic (`prompt`, `events`, process output — fails
fast with `PeerOffline`) and **durable** traffic (deliver when the peer returns)
maps onto DO storage plus alarms directly.

If relay is built, running it on Cloudflare is a natural first deployment rather
than a later port — but the relay protocol should not learn about Cloudflare to
make that true. It is an `RpcServer` over WebSockets; the DO is one host for it.

### 6.5 Which to reach for

| you want | use | new work |
| --- | --- | --- |
| one endpoint, sessions on the platform | §6.1 ingress Worker + DO | Worker entry point (§7) |
| one endpoint in front of many reachable agents | §6.2 `AgentServer` mounts | **none — ships today** |
| one endpoint in front of agents you cannot dial | §6.3 relay | the relay transport |
| a relay of your own | §6.4 relay on a DO | relay, then a DO host |

The rule underneath all four: **`AgentClient` is the seam, and delegation is a
Layer choice.** Any design that makes the gateway know *how* a downstream agent
is reached has put the decision in the wrong place.

## 7. What we would actually build

Four things, none of them a deployment system.

1. **A Worker entry point** (`apps/worker`), using
   `HttpEffect.toWebHandlerLayer` over `/http`, with `AgentSessionHost` inside a
   DO class and the Worker routing by session id.
2. **Store layers for the platform** — D1 via `@effect/sql-d1`, and a DO-storage
   `KeyValueStore` for `/tree`'s `NodeStore`.
3. **A hostless sandbox provider** via `fromExec`, against Cloudflare Containers
   first because Alchemy provisions them in the same stack.
4. **A Rivet `InputChannel.Factory` and actor host**, portable across
   everything Rivet runs on.

5. **A relay `RpcClient.Protocol`**, if and when §6.3's topology is wanted —
   the transport, not an agent concept. `AgentRpc` runs unchanged on both ends.

Plus the example Alchemy stack from §5.2. Note what is **not** on this list:
nothing for §6.2. A gateway fronting reachable agents ships today.

**The Worker entry point is a test before it is a feature.** Both
[plan-primitives.md](./plan-primitives.md) and
[plan-integrations.md](./plan-integrations.md) §8 already frame it that way: if
a host entry cannot be written without reaching into `node:*`, the portability
guardrail has found something real, and that finding is worth more than the
deployment.

## 8. Invariants

1. **The library never depends on a deployment tool.** No `alchemy` import in
   `src/`. Layers meet infrastructure in the application.
2. **Host coupling lives behind its own entry point**, as `sandbox/local.ts`
   does, and is listed in `verify-portability.mjs`'s `HOST_MODULES`.
3. **Adapters do not learn about platforms.** A DO or an actor hosts an
   `AgentSessionHost`; `/http`, `/mcp` and the rest stay unchanged. If a
   transport needs to know it is inside a DO, the seam is wrong.
4. **Resumption stays honest across hibernation.** `after` is honoured or the
   read fails — hibernation makes this load-bearing rather than theoretical.
5. **No hosted control plane.** Per plan-primitives.md §2, entry points and
   configuration; not a deploy command that provisions infrastructure.
6. **Delegation is a Layer choice, and the gateway must not know.** A mount is
   backed by *an* `AgentClient`; whether that is in-process, HTTP, RPC or relay
   is invisible above the seam. A design where the front server branches on how
   a downstream agent is reached has put the decision in the wrong place.
7. **Relay stays a transport.** It routes `source peer / destination peer /
   endpoint / message` and knows nothing about agents — and it must not learn
   about Cloudflare in order to run on it.
8. **Each target is proven by running an agent, not by compiling.**

## 9. Success conditions

- [~] A Cloudflare Worker serves `/http` and runs a full submission with the
      session living in a Durable Object (`apps/worker`,
      `test/WorkerDurableObject.test.ts`, on real workerd via miniflare). The
      model is the scripted test model -- CI has no key; the real-model half
      belongs to the deployment stack (`examples/deploy-cloudflare/`).
- [x] The same agent reconnects after the *runtime's death* -- a stronger
      event than hibernation -- and receives every event above the last
      sequence it saw, asserted against the log: a second miniflare over the
      same persisted DO storage continues the conversation, and the resumed
      stream begins exactly after the cursor with no gaps
      (2026-08-30). Sequences continue across lives because the worker
      shifts each life's events by the journal's last sequence.
- [ ] A shell tool runs inside that Worker through a `fromExec` provider, and
      passes `SandboxConformance`.
- [ ] Either the Worker entry needs no portability exception, **or** the
      exceptions it needs are written down as findings against the guardrail.
- [ ] A Rivet actor hosts a session with `InputChannel` backed by its queue, and
      steering arriving mid-run reaches the model — the same assertion
      `/cluster` makes.
- [ ] `examples/deploy-cloudflare/alchemy.run.ts` deploys the above from a clean
      account, and its README states the cost.
- [ ] One `AgentServer` serves a DO-backed mount **and** an HTTP-backed remote
      mount, and a client cannot tell them apart from the outside — the §6.2
      claim, exercised rather than asserted.
- [x] A decision is recorded on whether `/durable` runs inside a DO: it does
      not, until the engine's resume machinery runs on workerd (measured;
      see §3.2 item 2). The DO is the durability.
- [ ] `npm run check` stays green; `lint:portability` unchanged, or changed with
      a written reason.

## 10. Sequence

1. ✅ **Compile the portable core for `workerd`.** No entry point, no deployment —
   just a bundle. This is the cheapest possible test of the guardrail and it
   either passes or produces the findings that shape everything after it.
2. **Worker entry point + DO host**, in-memory stores, no sandbox. Prove a
   submission end to end.
3. **D1 and DO-storage layers**, then the hibernation resumption assertion.
4. **`fromExec` against Cloudflare Containers** — depends on
   plan-integrations.md steps 1–2 existing first.
5. **The Alchemy example stack**, once there is something worth provisioning.
6. **The mixed gateway** (§6.2 + §6.1): one server, a DO-backed mount beside a
   remote-backed one. Mostly an assembly and a test, since `agentClientLayer`
   already exists — which is exactly why it is worth doing early as a check on
   that claim.
7. **Rivet**: `InputChannel` over the queue first, because that is the part that
   tests the seam; the actor host after.
8. **Relay**, only if §6.3's topology is actually wanted. It is a substantial
   transport, and §6.1 and §6.2 cover the Cloudflare-only cases without it.

Step 1 is worth doing on its own even if nothing else follows.

## 11. Notes and open questions

- **`/durable` versus the platform.** Both Durable Objects and Rivet actors
  offer durability directly. Running Effect Workflow *inside* one may be
  redundant, or may be the right way to get replay semantics the platform does
  not give. This is the largest open design question here and it deserves its
  own answer rather than a default.
- **Transcript growth is the unglamorous blocker.** Compaction changes the
  projection; canonical history keeps growing, and DO storage is finite. Export
  plus eviction is the missing piece, and it will surface on the first
  long-lived deployment rather than in a test.
- **Hibernation makes `DeliveryLog` load-bearing.** On Node a dropped connection
  is rare; on a hibernating DO it is the normal case, several times an hour. Any
  looseness in resumption becomes a daily bug.
- **Rivet is a smaller bet than it looks**, because RivetKit runs on Node too.
  The adapter can be developed and tested locally without adopting a platform.
- **Alchemy is moving fast** — pushed the day this was written, still on beta
  release notes. Pin a version in the example and expect to update it; do not
  build anything in `src/` that assumes its API.
- **Relay is easy to reach for too early.** It solves inbound unreachability.
  A Worker, a Rivet actor and a VPS with a public name are all reachable, so
  relay buys nothing for them. Its value appears exactly once: an agent on
  hardware you cannot dial — a laptop, a machine inside a customer's network —
  fronted by a public endpoint. That case is real and valuable; it is also
  narrower than it first looks.
- **The relay's own durable/live split is a deployment decision in disguise.**
  plan-relay.txt separates live traffic (fails fast with `PeerOffline`) from
  durable traffic (delivered when the peer returns). On a DO those are storage
  plus alarms; elsewhere they are a mailbox somebody has to build. Whoever
  implements relay should pick the host before designing the mailbox.
- **Cost belongs in the example's README.** A per-session Durable Object plus a
  Container is not free, and a deployment example that does not say so is
  setting someone up.

## Related

- [plan-primitives.md](./plan-primitives.md) — why hosted products are out of
  scope, and reference implementations as acceptance criteria.
- [plan-integrations.md](./plan-integrations.md) — `fromExec`, the conformance
  suite, and §8 on deployment not being an adapter.
- [plan-relay.txt](./plan-relay.txt) — the relay transport: peer addressing,
  device authentication, the live/durable split, and why `AgentRpc` runs
  unchanged over it.
- [transport.md](./transport.md) — the transport seam these all sit on.
- [MODULES.md](./MODULES.md) — `/cluster`, `/durable`, `/durable-streams`,
  `/sandbox`, `AgentSessionHost`, `AgentServer`.

## Sources

- [rivet-dev/actors](https://github.com/rivet-dev/actors) — README: actor shape,
  queues, scheduling, hibernation, use cases. Read 2026-08-27.
- [alchemy-run/alchemy](https://github.com/alchemy-run/alchemy) — README
  ("Infrastructure as Effects", `bun add alchemy@latest effect@rc`, the
  Cloudflare resource list) and `examples/cloudflare-agent`,
  `examples/cloudflare-microvm-shell`, `examples/cloudflare-effect-sql-d1`. Read
  2026-08-27. Docs: [alchemy.run](https://alchemy.run).
- `effect` `4.0.0-rc.111` — `unstable/http/HttpEffect.toWebHandlerLayer`,
  `unstable/cluster` (`SingleRunner`, `SqlMessageStorage`, `SqlRunnerStorage`),
  `unstable/workflow`, `unstable/persistence`. npm: `@effect/sql-d1` at
  `4.0.0-rc.112`.
- This repo: `src/http/AgentServer.ts` (mounts as data; "local vs remote is
  whichever `AgentClient` the host was given"), `docs/plan-relay.txt`,
  `docs/remaining-work.md` S3 (mixed local/remote backing, landed),
  `src/cluster/AgentEntity.ts`, `src/client/AgentSessionHost.ts`,
  `src/InputChannel.ts`, `src/durable-streams/`, `scripts/verify-portability.mjs`.
