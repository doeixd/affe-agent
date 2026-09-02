# Plan: effect-cf and effect-webtransport — what to take, what to read, what to refuse

**Status: §3 revised and implemented 2026-09-01.** The owner's decision
reversed item 3 below for one place: `effect-cf` is adopted *at the host
boundary* -- `@doeixd/effect-agent/cloudflare`, `src/cloudflare/index.ts`,
an optional peer -- and nowhere else. See §3a. Written 2026-09-01 from a
research pass over [danieljvdm/effect-cf](https://github.com/danieljvdm/effect-cf)
and its `packages/effect-webtransport`, prompted by the question "should we
integrate this". The short answer is **one yes, one no, and one hole to close
either way**; §3 states it and the rest is why.

This plan decides a category, not just two packages: **when does a third-party
Effect package get to sit at our host boundary?** `plan-deployment.md` §8 answers
the deployment-tool half (never in `src/`, meet in the application). It does not
answer the runtime-binding half, because until now there was nothing to answer
it about.

---

## 1. What was read, and when

Read 2026-09-01. Both packages are MIT. Treat the version numbers as dated: the
Cloudflare one has shipped 50+ releases and moves fast.

| fact | where |
| --- | --- |
| `effect-cf` is "Effect-native primitives for Cloudflare Workers and bindings"; v0.38.0, 72 stars, ~134 commits, changesets. Effectively one maintainer: 100 of the 102 human commits are `danieljvdm`, the other two a drive-by | repo root, npm registry, GitHub contributors API |
| Its modules: `DurableObject` (+ `Alarm`, `Definition`, `Namespace`, `RpcWebSocket`, `Sqlite`, `State`, `Storage`, `WebSocket`), `D1`, `Kv`, `R2`, `Queue`, `Workflow`, `Vectorize`, `Hyperdrive`, `Sandbox`, `Mcp`, `Email`, `Images`, `WorkersAi`, `CloudflareOtlp`, `CloudflareTracer`, `Vitest`, `WebTransport`, `Worker` — ~35 in all | `packages/effect-cf/src` |
| Worker entry is `Worker.make(layer, { fetch })`; a DO is `DurableObject.make(layer, { fetch, alarm, webSocketMessage, webSocketClose, webSocketError, rpc })` | `Worker.ts`, `DurableObject.ts` |
| `effect-cf@0.38.0` peer-deps `effect ^4.0.0-rc.110`, `@effect/sql-sqlite-do`, `@effect/sql-d1`, `@cloudflare/workers-types ^5.20260825.1` | npm `latest` manifest |
| `effect-webtransport@0.3.0`'s **only** peer dependency is `effect ^4.0.0-rc.110` | npm `latest` manifest |
| `WebTransportSocket` imports `Socket` from `effect/unstable/socket` and returns `Socket.Socket`: `makeSocket(options?): Effect<Socket.Socket, never, WebTransport.WebTransport>`, plus `layerSocket` and `layerSocketWebTransport(url, options?)` | `WebTransportSocket.ts` |
| Its RPC note: "RPC needs self-delimiting serialization such as `RpcSerialization.layerNdjson` or `layerMsgPack`, not `layerJson`" | `effect-webtransport` README |
| Its `Fallback` module "selects WebTransport or WebSocket before application traffic" and "never replays requests or switches an active session to another transport" | same |
| **workerd has no WebTransport server support**, is not on the roadmap: no QUIC/HTTP-3 stack, and "the semantics of WebTransport do not fit naturally into the workers invocation model" | [workerd#6451](https://github.com/cloudflare/workerd/issues/6451) |
| `effect-cf`'s own `WebTransport.ts` is a "truthful WebTransport / HTTP/3 boundary": `capabilities` (feature detection), `inboundTransport(request)` (HTTP/3 metadata off `request.cf`), and `inboundSessionsUnsupported`, which **fails** rather than emulating | `packages/effect-cf/src/WebTransport.ts` |

Two facts verified against *this* repository the same day:

- We are on `effect@4.0.0-rc.112`, so `^4.0.0-rc.110` is satisfied by both, and
  `@cloudflare/workers-types@^5.20260830.1` satisfies theirs. **There is no
  version obstacle to either package.** "Could we" is settled; the rest of this
  plan is "should we".
- Our WebSocket RPC path is already `Socket.Socket` → `RpcClient.makeProtocolSocket()`
  (`test/AgentRpc.test.ts:681`), and our RPC tests already run NDJSON. Both of
  `effect-webtransport`'s preconditions are met by code that exists.

## 2. The two packages point in opposite directions

This is the whole finding, and it is not what the question assumed.

**The WebTransport package cannot run on our primary deployment target.**
Cloudflare terminates HTTP/3 at the edge but exposes no inbound WebTransport
API to a Worker. So the package is a client-and-non-Cloudflare-server story.
`effect-cf` says exactly this in its own types rather than papering over it,
which is a good signal about the author but does not make the gap smaller.

**The Cloudflare package is where the real overlap is**, and it overlaps with
the one part of this repository that is deliberately supposed to stay thin.

So the interesting answers are crossed: the package that *fits our seam
perfectly* has no use where we deploy, and the package that *does* have use is
the one we should mostly not depend on.

## 3. Decision

1. **Neither package enters `src/`.** `effect-cf` is host coupling by
   definition; `effect-webtransport` is a transport an application selects.
   `plan-deployment.md` §8 invariants 2 and 3 already cover this — adapters do
   not learn about platforms, and host coupling lives behind its own entry
   point. Nothing about being written in Effect earns an exemption.
2. **`effect-webtransport`: take it as a test, not as a dependency.** One
   example plus one test in `examples/` / `test/`, devDependency only, proving
   `AgentRpc` runs unchanged over a `Socket` we did not write. See §4.
3. **`effect-cf`: read it and mine it; do not adopt it.** With one exception
   worth a prototype — WebSocket hibernation, §5.2 — and one shopping list,
   §5.3.

And, independent of all three, §6: close the guardrail hole this research
exposed.

### 3a. Revised 2026-09-01: adopted at the host boundary, and only there

The owner decided to utilise `effect-cf` where appropriate, and "where
appropriate" has exactly one answer under §3's own reasoning: the Cloudflare
host entry. Item 1 stands -- host coupling lives behind its own entry point
-- and that entry *is* the Cloudflare host, so the package that makes
Cloudflare's primitives Effect services is what it should be built on rather
than re-derived. Item 3 is therefore reversed for `src/cloudflare/` and for
nothing else:

- `@doeixd/effect-agent/cloudflare` is built on `DurableObject.make`,
  `DurableObjectSqlite`, `DurableObjectAlarm`, `DurableObjectNamespace` and
  `Worker.make`. `effect-cf` is an **optional peer** (`>=0.39.0 <1.0.0`):
  a consumer who never imports the entry never installs it.
- The portable core is unchanged and `verify-portability` still rejects
  `effect-cf` outside `cloudflare/index.ts` (a named host module, as
  `sandbox/local.ts` is). `verify-package` resolves the entry through
  `exports` but does not import it on Node -- it imports
  `cloudflare:workers`, which only workerd provides -- and
  `test/WorkerDurableObject.test.ts` is where it is imported, on workerd.
- The entry compiles under `tsconfig.cloudflare.json`: `effect-cf`'s types
  reach the Workers globals, which collide with the DOM lib the main build
  uses, so it is its own program with the same `outDir`.
- What §5.3 called the shopping list is now simply used: logical alarms
  over the one platform alarm (`DurableObjectAlarm`, at-least-once with
  retry, reconciled in the same transaction as the schedule) replaced the
  hand-rolled jobs table and `setAlarm` of `apps/worker`. §5.2's WebSocket
  hibernation prototype stays open.

Item 2 (`effect-webtransport` as a falsification test) is unchanged and
still not done.

## 4. Track A — WebTransport as a falsification of the RPC seam

### What the value actually is

Not WebTransport. We should be honest that head-of-line-blocking avoidance and
unreliable datagrams solve no problem we have: event resumption is already
transport-independent, by `DeliveryLog` sequence rather than by socket
liveness, which is the entire argument of `transport.md` §7. A new socket type
does not improve it.

The value is **evidence for a claim we currently only assert**. `transport.md`
§3 says the RPC layer "is transport-agnostic by Effect's design: the
application picks the protocol". Every protocol we have demonstrated that
against is one we chose and wired ourselves. A third-party `Socket`
implementation, written without knowledge of this repository, is the first
independent test of that sentence. This repository's habit is to prove things
that way — `plan-code-mode-executors.md` step 4 exists for exactly the same
reason ("a second executor is the only real evidence").

### The shape

The swap is one line. Today (`test/AgentRpc.test.ts:681`):

```ts
const socket = yield* Socket.makeWebSocket(url, ...)
const protocol = yield* RpcClient.makeProtocolSocket().pipe(
  Effect.provideService(Socket.Socket, socket)
)
```

With WebTransport, `Socket.makeWebSocket` becomes
`WebTransportSocket.makeSocket()` (or the whole thing becomes
`WebTransportSocket.layerSocketWebTransport(url)`), and **nothing else moves** —
not `AgentRpc`, not `AgentSessionHost`, not the protocol schemas. If anything
else *does* have to move, that is the finding, and it is worth more than the
feature.

### Constraints to respect

- **NDJSON or MsgPack, never `layerJson`.** A WebTransport bidirectional stream
  is a byte stream with no message framing, so the serialization has to
  self-delimit. We already default to NDJSON in the RPC tests; a plain
  `layerJson` run would fail in a way that looks like corruption rather than
  like misconfiguration, so the example should say why in a comment.
- **A server is needed that Cloudflare cannot be.** The test needs a Node-side
  WebTransport server, which Node does not ship. That is the real cost of this
  track, and it is why §8 ranks it as *optional* rather than *next*.
- **`Fallback` is not ours to use.** Its promise — never replay a request,
  never migrate an active session — is a promise our request-id table already
  makes at a different layer (`transport.md` §1, "Request identity"). Two
  mechanisms making overlapping idempotency guarantees is how you get a bug
  neither one owns. If `Fallback` is used at all, it is in the application,
  above `AgentClient`, and `AgentRpc` must not learn about it.

### What this must not become

A supported transport in the maturity map. It is an example and a test. If it
ever ships as a subpath, that is a separate decision with a real caller behind
it, not a consequence of this plan.

## 5. Track B — effect-cf: read, mine, do not adopt

### 5.1 Why not adopt it wholesale

Three reasons, in order of weight.

1. **`apps/worker` is a test before it is a feature.** That framing is
   `plan-deployment.md` §7's, and §8 invariant 8 sharpens it: each target is
   proven by running an agent, not by compiling. The worker's job is to
   demonstrate that *our* layers run on a bare platform without reaching for
   `node:*`. Wrapping it in someone else's Worker/DO framework does not make
   that claim more true; it makes it untestable, because a failure could then
   belong to either party. The guardrail found nothing to loosen when the
   worker was written (§9 of that plan) — that result is only meaningful
   because the worker was thin.
2. **The dependency is 0.x, effectively single-maintainer, and tracks `effect`
   rc's.** 50+ releases, currently 0.38.0; 100 of 102 human commits are one
   person. Our worker is ~280 lines that work and are proven on real workerd
   through miniflare. Trading verified code for ergonomics, and taking on a
   version-coupling to a second rc-tracking package, is a bad trade at this
   size. Note this cuts both ways: the bus factor is an argument against
   depending on it *and* an argument for reading it, since reading costs
   nothing if it is abandoned.
3. **We would gain ergonomics, not capability**, for what the worker does
   today. `DurableObject.make` is nicer than a hand-written class; it does not
   let us do anything we cannot do.

None of this is a criticism of the package. It looks well made, and its
`WebTransport.ts` shows the author refusing to fake a capability, which is the
behaviour we would want from a dependency. The argument is about what
`apps/worker` is *for*.

### 5.2 The one real gap: WebSocket hibernation

This is the part worth acting on.

Our worker serves HTTP + SSE. On a hibernating Durable Object a dropped
connection is not an exceptional event — `plan-deployment.md` §11 already
wrote it down: "on a hibernating DO it is the normal case, several times an
hour. Any looseness in resumption becomes a daily bug." We answer that with
resumption (`events?after=N` over the `DeliveryLog`), which is correct and is
tested across the runtime's death.

But resumption is the recovery path, and Cloudflare offers a way to *not need
it as often*: the Hibernatable WebSockets API keeps sockets connected while the
DO itself is evicted from memory. We use none of it — verified 2026-09-01,
there is no hibernation handling anywhere in `src/` or `apps/`.
`effect-cf` has `DurableObject.WebSocket` and `DurableObject.RpcWebSocket`.

Two things follow, and they are separable:

- **The interesting question is ours, not theirs**: does a hibernatable
  WebSocket carrying `AgentRpc` preserve our resumption contract across
  eviction, or does it merely move where the gap appears? A socket that
  survives eviction still has a cursor problem the moment it *doesn't*. We
  should be able to answer that before deciding whether to depend on anything.
- **Their implementation is the prior art to read first**, because the
  hibernation API's constraint (handlers are re-entered on a fresh instance
  with only serialized attachment state) is exactly the kind of thing where
  reading a working version saves a day.

So: read it, prototype the question, and only then ask whether the answer wants
a dependency. A prototype that borrows the *shape* and imports nothing is a
perfectly good outcome.

### 5.3 The shopping list — `plan-deployment.md` §7 item 2

That plan asks for "store layers for the platform — D1 via `@effect/sql-d1`,
and a DO-storage `KeyValueStore` for `/tree`'s `NodeStore`", and
`remaining-work.md` item 19 records that neither was built, because DO SQLite
covered history and the delivery log on its own. `effect-cf` has `D1`, `Kv`,
`Storage` and `Sqlite` modules.

This does not change the ranking — those layers are still not blocking
anything. It changes what building them would cost if a caller ever wants them,
and it is worth recording that the prior art exists so the next person does not
start from the Cloudflare docs.

## 6. The guardrail hole, which stands regardless

`scripts/verify-portability.mjs` rejects host packages by a hardcoded pattern:

```js
const hostPackages =
  /^@effect\/(platform-node|platform-bun|platform-deno|sql-sqlite-node|sql-sqlite-bun|sql-pg|sql-mysql2|sql-d1|sql-libsql)/
```

That is an allowlist of known-bad, so it does not catch **`effect-cf`**,
**`@cloudflare/*`**, or — note — **`@effect/sql-sqlite-do`**, which is a
concrete platform package that `apps/worker` already uses. Anything in that set
imported into `src/` today passes a check whose entire purpose is to stop it.

Verified 2026-09-01: none of those are in `src/`, so **adding them to the
pattern is safe and changes no current result.** That is the argument for doing
it now rather than when it is load-bearing — a guardrail extended while it is
still green is a cheap edit; one extended after a violation is a debate.

This is the only item here that should happen whether or not either package is
ever used, and it is the only one with no design question in it.

## 7. Invariants

1. **No third-party host package in `src/`, in any language or ecosystem.**
   Being written in Effect is not a qualification. `plan-deployment.md` §8's
   invariants 2 and 3 are extended, not amended: they said "deployment tool"
   and "platform"; they mean **any dependency whose presence assumes a host**.
2. **A transport is selected by the application, above `AgentClient`.** If
   adopting a socket implementation requires an edit inside `AgentRpc`, the
   seam is wrong and that is the finding.
3. **One idempotency mechanism per request.** Our request-id table owns
   join-or-conflict. A transport's own replay logic must not be layered on top
   of it (§4, `Fallback`).
4. **`apps/worker` stays thin enough to be evidence.** Anything that makes a
   failure ambiguous between us and a dependency defeats its purpose.
5. **Reading a dependency is free; depending on it is not.** Prior art may be
   read and its shape borrowed without an entry in `package.json`.

## 8. Milestones

Ordered by value per unit of work. Only C1 is unconditional.

| # | What | Depends on | Cost |
| --- | --- | --- | --- |
| **C1** | Extend `verify-portability.mjs`'s `hostPackages` pattern to cover `effect-cf`, `@cloudflare/*` and `@effect/sql-sqlite-do`; add a test that a violation is caught (break it once) | nothing | minutes |
| **C2** | Read `effect-cf`'s `DurableObject.WebSocket` / `RpcWebSocket`; write up how hibernatable sockets re-enter handlers and what state survives | nothing | a sitting |
| **C3** | Answer the §5.2 question: does a hibernatable WebSocket carrying `AgentRpc` preserve the resumption contract across eviction, or relocate the gap? A miniflare test, importing nothing new | C2 | a day |
| **C4** | *If* C3 says the mechanism is worth having: implement it in `apps/worker`, borrowing shape, importing `effect-cf` only if C3 showed a reason | C3 | open |
| **W1** | `AgentRpc` over `effect-webtransport`'s `Socket` as an example + test, devDependency only, NDJSON, with the Node-side server it needs | a Node WebTransport server | a day |
| **W2** | Record the result in `transport.md` §3 — either "an independently written `Socket` runs unchanged", or the finding if it does not | W1 | minutes |

C1 should just be done. C2 is cheap and informs a gap we have already written
down twice. W1 is genuinely optional and is ranked last on purpose: its cost is
mostly the server it needs, and its payoff is confidence in a sentence rather
than a capability.

## 9. Success conditions

- [ ] A `src/` file importing `effect-cf` fails `npm run lint:portability`, and
      the check was broken once to prove it (C1).
- [ ] The repository can state, from a test rather than from reasoning, whether
      hibernatable WebSockets change our resumption contract (C3).
- [ ] `apps/worker` still contains no dependency whose failure could be
      confused with ours — or, if it does, `plan-deployment.md` §9's portability
      condition is re-argued rather than quietly amended.
- [ ] If W1 is built: `AgentRpc`, `AgentSessionHost` and the protocol schemas
      are byte-identical before and after, and the diff is confined to one
      example and one test.

## 10. Non-goals

- **A Cloudflare framework dependency for `apps/worker`.** §5.1.
- **WebTransport as a supported transport** in the maturity map. §4.
- **Wrapping, re-exporting or vendoring either package.** If we want a shape,
  we write it; if we want the package, we depend on it in an application.
- **A `Fallback`-style transport negotiation inside the library.** §7
  invariant 3.
- **Revisiting `/durable` on workerd.** Unrelated and already decided by
  measurement (`plan-deployment.md` §3.2 item 2); nothing in `effect-cf`
  changes the Effect Workflow stall.

## 11. Risks

- **`effect-cf` moves fast.** 0.38.0 after 50+ releases. Anything C2 records is
  dated the day it is read, per this directory's research convention.
- **The hibernation answer may be "no change".** C3 can conclude that a
  hibernatable socket relocates the gap rather than closing it, and that the
  `DeliveryLog` cursor is still the only thing that makes resumption honest.
  That is a good outcome and should be written down as one, not treated as a
  failed milestone.
- **W1's server dependency could grow.** If standing up a Node WebTransport
  server costs more than a day, drop W1; the sentence in `transport.md` §3 is
  well-reasoned even unproven, and there are cheaper things to prove.

## Related

- [plan-deployment.md](./plan-deployment.md) — §3 the DO mapping, §7 item 2 the
  store layers, §8 the invariants this plan extends, §11 hibernation as the
  reason resumption is load-bearing.
- [transport.md](./transport.md) — §1 request identity, §3 the
  transport-agnosticism claim W1 would test, §7 why resumption does not depend
  on the socket.
- [remaining-work.md](./remaining-work.md) — where these land in the ranking.

## Sources

- [danieljvdm/effect-cf](https://github.com/danieljvdm/effect-cf) — repo,
  `packages/effect-cf/src`, `Worker.ts`, `DurableObject.ts`, `WebTransport.ts`.
  Read 2026-09-01.
- [effect-webtransport](https://github.com/danieljvdm/effect-cf/tree/main/packages/effect-webtransport)
  — README and `WebTransportSocket.ts`. Read 2026-09-01.
- npm `latest` manifests for `effect-cf` (0.38.0) and `effect-webtransport`
  (0.3.0). Read 2026-09-01.
- [workerd#6451](https://github.com/cloudflare/workerd/issues/6451) — WebTransport
  in workerd, tracking issue. Read 2026-09-01.
- [Cloudflare Workers protocols](https://developers.cloudflare.com/workers/reference/protocols/)
  and [Durable Objects docs](https://developers.cloudflare.com/durable-objects/)
  — HTTP/3 termination, Hibernatable WebSockets. Read 2026-09-01.
- This repo: `test/AgentRpc.test.ts:681` (the `Socket` → `makeProtocolSocket`
  path), `scripts/verify-portability.mjs` (the pattern in §6),
  `apps/worker/src/index.ts`.
