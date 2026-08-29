# Plan: the MCP frontend

Written 2026-08-27. This plan grows `/mcp`'s outbound half from a single
blocking `ask_agent` tool into a frontend that carries the session model — long
runs, steering, elicitation, event history — to an MCP host such as Claude Code
or Claude Desktop.

**Status: partially implemented.** The additive shared-host path, its full
phase-2 control surface, status/respond and the elicitation bridge are built.
Resources, progress and prompts remain.

### Implementation audit (2026-08-27)

Phase 1 is not the pure, behavior-preserving refactor described below. The two
registries have different, tested capacity policies:

- `AgentMcp.handlers({ maxSessions })` evicts the oldest **idle** named session
  and only refuses when every session is busy;
- `AgentSessionHost` never evicts a live session and always refuses a newcomer
  at `maxSessions`.

Deleting the MCP registry therefore changes observable continuation semantics;
the existing MCP tests correctly catch it. A first implementation attempt also
confirmed a lifetime constraint: constructing a private host inside the
compatibility handler's `Layer.unwrap` can close the host-owned scope before a
forked mutation completes, leaving the request joiner parked. The working tree
was restored rather than masking either finding.

The safe next slice is additive: introduce `AgentMcp.serverLayer({ host })` for
applications that want a shared host, while retaining `handlers`/`layer` as the
legacy one-tool compatibility path. Removing the private registry requires an
explicit choice between the shared host's refuse policy and MCP's idle-eviction
policy (or a separately designed host eviction operation). This plan does not
currently make that choice, so its phase-1 deletion criterion is blocked on its
own contradiction, not on implementation difficulty.

**Landed 2026-08-28.** `AgentMcp.serverLayer({ host })` now registers the
existing `ask_agent` tool over an application-supplied `AgentSessionHost`. The
new path contains no registry, session scope, semaphore or capacity policy;
anonymous calls close their host session in `acquireUseRelease`, while named
calls adopt or create the host-owned session. HTTP MCP requests recover the
current `HttpServerRequest` headers for the host's principal resolver; stdio
honestly supplies empty headers. A real official-v2 MCP client and the typed
Agent HTTP routes prove that a session created through HTTP is prompted through
MCP and its resulting history is visible through HTTP. The host is configured
with capacity one, so this also rules out a second hidden session registry.
The legacy path and its idle-eviction behavior are unchanged.

**Start/await landed 2026-08-28, with two corrections to this plan.** The
shared-host layer now exposes `agent_start`, `agent_await` and `agent_close` in
addition to `ask_agent`. Start transfers the host prompt into the adapter
layer's scope and returns a generated or requested session id plus request id.
Await authenticates again and waits on the adapter-retained `Deferred`; it
never reissues `host.prompt`, whether the host still retains the mutation or
not. This is simpler and makes the duplicate-run hazard impossible instead of
branching around it only after settlement. `agent_close` is necessary because
an anonymous start intentionally outlives the call which created it; without a
close operation, the caller would have no way to release that host session.

The ticket table is private rather than a new host/core primitive. A2A's task
identifier indexes protocol task state and history, while MCP's request id
indexes an adapter-owned await result; those are not yet the same abstraction.
Retention is bounded in both dimensions by the host's declared
`maxSessions` and `maxRequestsPerSession`. The second dimension alone was not
enough: sessions closed through another adapter could otherwise leave one
ticket bucket per historical session id. Admission evicts only settled tickets
or settled session buckets and refuses when all eligible entries are in
flight. Session acquisition happens before ticket eviction, so a host-capacity
failure cannot discard an older valid ticket. The adapter records whether this
call created the session and closes only that newly created session if ticket
admission then fails, so refusal cannot leave an unreachable session either.

**Control tools landed 2026-08-28.** `agent_steer`, `agent_follow_up` and
`agent_interrupt` are thin authenticated host mutations. Their tests do not
stop at `accepted: true`: the scripted provider sees steering in its exact next
model-facing prompt; follow-up produces a second run under the original await
ticket; and interrupt makes that await resolve with `status: "interrupted"`.
The original success criterion asked the event log to prove steering reached
the model. The provider prompt is stronger evidence—`SteeringApplied` proves
the kernel accepted the input, while the recorded prompt proves the model
actually received it—so the criterion was corrected rather than followed
literally.

**Status/respond and elicitation landed 2026-08-28.** `agent_status` returns
the session status and pending questions in one authenticated read;
`agent_respond` answers one exact id and reports whether it was still waiting.
The default unsupported policy is pending, with explicit deny and fail modes.
All three are tested: deny never executes the tool, while fail ends only the
observing await and leaves the run answerable by a later `agent_respond`.

Native MCP form elicitation works over stdio and is exercised end to end by an
official split-v2 client. The bridge eagerly runs the host event stream into a
request-scoped queue *before* reading `pending`; merely obtaining a `Stream`
did not subscribe, and left a real snapshot/subscription gap. The queue is
unbounded only within the lifetime of the blocking request and begins draining
immediately.

Two upstream constraints changed the literal plan. First,
`McpServer.registerToolkit` in Effect rc.111 replaces the invocation context
with its captured handler context, dropping the `McpServerClient` dependency
which reverse calls need. The adapter therefore uses the public lower-level
`McpServer.addTool` only for `ask_agent` and `agent_await`; ordinary tools still
use `registerToolkit`. Second, the pinned Streamable HTTP transport does not
flush a reverse request while the originating tool call remains open. Calling
`McpServer.elicit` there hangs despite an advertised form capability. HTTP is
therefore deliberately manual (`agent_status` + `agent_respond`); native
reverse elicitation is limited to full-duplex stdio until the transport changes.
No timeout guesses and no implicit grants are involved.

## Outcome

An MCP host becomes a usable frontend for an agent:

```text
MCP host (Claude Code / Desktop)
        |  tools, resources, prompts, elicitation
        v
AgentMcp  (protocol adapter -- this plan)
        |
        v
AgentSessionHost  (registry, capacity, principal, request idempotency)
        |
        v
AgentClient  (the transport seam)
        |
        v
AgentSession / the kernel
```

Concretely, when this is done:

- a host can start a long run without holding a tool call open for it;
- it can steer, follow up, and interrupt that run *while it is running*;
- a permission the agent asks for surfaces as a native MCP elicitation, so the
  user is prompted by their own client and the answer flows back to
  `session.respond`;
- transcript, status, pending questions and the event log are readable as MCP
  resources rather than smuggled through tool results;
- the agent's skills appear as MCP prompts.

## Why change it

`src/mcp/AgentMcp.ts` today exposes one tool, `ask_agent`, which blocks for the
whole run. That is a correct one-shot adapter and it should survive. It is not
a frontend, for three structural reasons.

**MCP tool calls are request/response; the agent is a session.** While
`ask_agent` is in flight the client has no channel to send anything, so
`steer`, `followUp`, `interrupt` and `respond` — four of the seven operations on
`RemoteSession` — are unreachable by construction. The seam exposes them; the
adapter does not.

**The run's observable middle is discarded.** `RemotePromptOptions.stream`
exists so `MessageDelta` reaches `events`, and `AgentMcp` never subscribes.
The client sees a long silence and then a string.

**Elicitation is exactly MCP's own concept and is not wired.** `Elicitation.ts`
says so in its own header: "MCP calls this elicitation, which is the closest
existing term." Effect ships `McpServer.elicit`. The two halves have never been
joined, so a run that pauses for tool approval under `/mcp` pauses forever
unless the application configured `Elicitation.denied`.

There is a fourth reason, structural rather than user-facing. `AgentMcp` builds
its own session registry — a `Ref<Map>`, a creation semaphore, LRU eviction that
skips busy entries. `AgentSessionHost` exists precisely because four adapters
had each done that and an application running two of them got two registries and
two capacity limits for the same sessions. `/mcp` is the remaining adapter that
has not moved. Everything this plan wants to add — non-blocking starts, idle
lifetime, per-session request bounds, principals — the host already implements.

## Decisions

### 1. `AgentMcp` moves onto `AgentSessionHost`

The adapter takes a host tag, exactly as `AgentHttp`, `AgentRpc`, `AgentAgUi`
and `AgentA2A` do:

```ts
const Host = AgentSessionHost.Tag<Principal>("app/AgentSessionHost")

AgentMcp.serverLayer({ host: Host }).pipe(
  Layer.provide(HostLive),
  Layer.provide(McpServer.layerStdio({ name: "my-agent", version: "1.0.0" }))
)
```

Deleted from `AgentMcp`: the `sessions` `Ref`, the `creating` semaphore, the
`SessionEntry` / `inFlight` bookkeeping, the eviction scan, the finalizer that
closes every scope, and the `maxSessions` option. Those become
`AgentSessionHost.layer`'s `maxSessions` and `maxRequestsPerSession`.

The existing `AgentMcp.layer` — client-backed, no principal, one tool — is kept
as the zero-configuration path and reimplemented on top of a host built with
`AgentSessionHost.allowAll`, so there is one registry implementation and not
two.

MCP has no headers on a stdio transport, so `PrincipalContext.headers` is empty
there. That is honest rather than a gap: a stdio server is a single-user
process. Over `layerHttp` the request headers are available and the same
`PrincipalResolver` an HTTP deployment already uses applies unchanged.

### 2. Start and await are separate tool calls, joined by the host's request id

This is the crux, and it needs no seam change, because
`AgentSessionHost.mutate` already has the shape:

- the *owner* of a request id runs the mutation forked into the **host's**
  scope, not the caller's;
- the caller merely awaits a `Deferred`;
- a second call with the same `requestId` and an identical fingerprint gets
  `Join` — the same deferred, not a second run;
- a mismatched fingerprint gets `AgentRequestConflictError`.

So:

- **`agent_start`** issues `host.prompt({ requestId, sessionId, input, options })`
  and *forks it into the adapter's layer scope* rather than awaiting it. Because
  the run's owner is already forked into the host scope, interrupting the
  adapter's joiner does not cancel the run. Returns
  `{ sessionId, requestId }` immediately.
- **`agent_await`** authenticates and authorizes access to the ticket's session,
  then awaits the adapter-retained deferred. If the run already finished it
  returns instantly; if it is still going, it blocks until it ends. It never
  re-issues the mutation to the host.

The adapter keeps a small map from `requestId` to the encoded request and its
deferred result. It is bounded by the host's session and per-session request
limits and lives in the adapter's scope.

**The hazard to write down.** The host evicts *completed* request entries when
a session's request table is full. Reissuing an evicted id could reserve it as
`Owner` and **start a second run of the same prompt**. The adapter's local map
prevents this categorically: every await reads its retained deferred and never
reissues the prompt. This has a dedicated official-client test which evicts the
host record and still observes exactly two model calls, not three.

### 3. The tool surface

Seven tools plus the one that already exists.

| tool | maps to | blocking |
| --- | --- | --- |
| `ask_agent` | `prompt` | yes — kept unchanged, one-shot sugar |
| `agent_start` | `prompt`, forked | no |
| `agent_await` | join the same request id | yes, with progress |
| `agent_steer` | `steer` | no |
| `agent_follow_up` | `followUp` | no |
| `agent_interrupt` | `interrupt` | no |
| `agent_respond` | `respond` | no |
| `agent_status` | `status` + `pending` | no |

`ask_agent` stays because it is the right default for a client that will not
orchestrate, and because removing it is a breaking change to a shipped surface.
It is reimplemented as `agent_start` immediately followed by `agent_await`, so
there is one code path and the sugar cannot drift from the primitives.

Every tool takes `sessionId` as an optional parameter with the same meaning it
has today: absent means a fresh session. Unlike today, an anonymous session can
no longer be scoped to the call that made it — `agent_start` returns before the
work ends — so anonymous sessions become host-registered sessions with a
generated id, returned to the caller. Their lifetime is the host's business,
which is the point of moving to the host.

`agent_status` merges `status` and `pending` because a client asking "what is
happening" wants both, and two round trips to learn that a run is blocked on a
question is a bad frontend.

### 4. Streaming becomes resources plus notifications, not tool output

Four resources:

| uri | source |
| --- | --- |
| `agent://sessions` | the host's registry |
| `agent://session/{id}/history` | `host.history` |
| `agent://session/{id}/pending` | `host.pending` |
| `agent://session/{id}/events` | `host.events({ after })` |

`agent://session/{id}/events` is the interesting one. A subscribing client is
sent `ResourceUpdatedNotification` as events arrive and re-reads; the read
honours `after`, which is the same number `Last-Event-ID` and `DeliveryLog.read`
carry. **`after` must never be silently downgraded.** `AgentClient.events`
documents why: a consumer resuming from 41 and handed events from 60 has lost
eighteen and cannot find out. If the underlying client cannot resume, the read
fails; it does not return a live stream wearing a resumption's clothes.

Inside `agent_await`, coarse progress goes out as `ProgressNotification` so a
blocking call is not a silent one. Progress is a courtesy signal, not a
transport: no consumer should be able to reconstruct the run from it, because a
client that tried would be building a second, lossy event log. The event
resource is the event log.

**To verify before building:** whether Effect's `McpServer.registerResource`
supports `subscribe`/`unsubscribe` today, or only list/read. `McpSchema` defines
`Subscribe`, `Unsubscribe` and `ResourceUpdatedNotification`, and `McpServer`
carries a notification client for the last of these, but the registration API in
`McpServer.d.ts` does not obviously expose subscription. If it does not, the
events resource ships as poll-with-`after`, which is correct if less pleasant,
and subscription is added when Effect grows it. **The plan must not assume
this.**

**Read-only templates landed 2026-08-28.** The shared-host server now exposes
authenticated `history` and `pending` templates, and an official v2 HTTP
client reads both after an MCP prompt. The events resource remains poll-with-
`after` work: subscription registration is not exposed by the pinned Effect
MCP server API. The sessions index is also deferred because
`AgentSessionHost` intentionally has no enumeration seam.

Two further constraints make the original events/progress wording
unimplementable as written. An MCP resource read must return one finite value,
while `host.events({ after })` returns a live stream and exposes no finite
snapshot/head operation; taking an arbitrary number would silently lose events
and waiting for completion can hang an idle session. Also, Effect rc.111's
`McpServer.addTool` passes only `call.arguments` to the registered handler and
drops the request `_meta.progressToken`, so the handler cannot emit correlated
progress. The host seam needs a finite event-log read before the events
resource is honest, and Effect must preserve the progress token before
`ProgressNotification` is possible.

### 5. Elicitation bridges through the handler that is live

`McpServer.elicit` requires `McpServerClient`, which is only in context inside a
handler serving that client. There is no way to push an elicitation to a client
that is not currently calling something. That constraint decides the design
rather than fighting it:

- while `agent_await` (or `ask_agent`) is in flight, the adapter forks a
  listener on `host.events` for `ElicitationRequested`, calls
  `McpServer.elicit({ message, schema })` for each, and feeds the answer to
  `host.respond`. `AgentA2A` already does the fork-a-listener-on-events dance
  (`src/a2a/AgentA2A.ts:648`) and the shape should be borrowed, not reinvented.
- when no call is in flight, requests accumulate and are visible through
  `agent_status` and `agent://session/{id}/pending`, answerable with
  `agent_respond`. A client that only ever calls `agent_start` still works; it
  just has to poll.

The schema handed to `McpServer.elicit` is derived from the request's `kind`.
`"tool-approval"` has a built-in form carrying the permission-specific
`remember` answer; unknown kinds get a plain yes/no form. The earlier proposal
for a public `Record<string, Schema>` was not implemented: a schema alone does
not specify how its answer maps to `granted` and `value`, so that API would be
under-specified. A typed mapper can be added when a second concrete kind proves
the shape.

**Capability and transport gating.** `McpServer.clientCapabilities` says
whether the client supports elicitation. The current HTTP transport limitation
above also makes native reverse calls unavailable there. In either case the adapter follows a declared
`onUnsupportedElicitation` policy: `"pending"` (default — leave it for polling),
`"deny"` (respond `granted: false`), or `"fail"` (fail the call with a stated
reason). What it must never do is call `elicit` and hang, and it must never
default to `"grant"`; a frontend that auto-approves a permission the user never
saw is worse than one that cannot ask.

`ElicitationDeclined` from the host maps to `granted: false`. A *cancelled*
elicitation interrupts the effect, which is a different thing and reaches
decision 6.

### 6. Cancellation propagates

An MCP `CancelledNotification` interrupts the handler fiber. For a handler that
merely joins a deferred that is not enough — the run's owner is forked into the
host scope and keeps going, which is deliberate for `agent_start` and wrong for
`ask_agent`.

So the two differ on purpose, and it is stated in each tool's description:

- `ask_agent` is `Effect.onInterrupt(() => host.interrupt(...))`. It presented
  itself as one call; cancelling the call cancels the work.
- `agent_await` does **not** interrupt. It is an observer of a run someone
  started separately, and an observer that kills what it is watching is a trap.
  `agent_interrupt` is how you stop that run, and it exists.

**Transport verification found a gap.** The `ask_agent` handler has the
correct `Effect.onInterrupt` finalizer, but aborting an official split-v2 client
call did not interrupt the handler over either Streamable HTTP or stdio in the
pinned stack; deterministic tests reached the hanging model and then timed out
waiting for its interruption finalizer. `agent_interrupt` is tested and works.
Do not mark request-cancellation propagation complete until the client/server
request-id cancellation path is fixed or replaced.

### 7. Errors stay strings, but useful ones

The current `mapError` to `error.message` is the right boundary — a remote
caller cannot act on `AgentTransportError` and MCP has nowhere to put it — but a
bare message wastes the only channel a model has. Failures become a small
stable text form carrying the tag, the session and whether retrying is
reasonable, e.g.:

```text
AgentRequestConflictError: request id "r-7" was already used for a different
prompt on session "s-2". Use a new request id. (retryable: no)
```

The retryability judgement follows the distinction `AgentTransportError` already
documents: transport failures say nothing about the request and may be retried;
session errors should not be.

**Compatibility decision 2026-08-28.** This proposal conflicts with the success
condition that `ask_agent` keep its observable failure text. The adapter does
not prepend a new tag/retryability wrapper in this release: the exact shared-
host failure text is now pinned through an official client, and matches the
existing `AgentExecutionError.message`. A richer MCP error vocabulary can be
added only as an explicitly versioned behavior change, not smuggled into the
shared-host refactor.

### 8. Skills become MCP prompts

`McpServer.prompt` with completions, one per entry from `/skills`. This is a
thin adapter over a module that exists and it is what makes the server feel
native in a host rather than like a bag of tools. It is last in the sequence
because nothing depends on it.

**Security contradiction found 2026-08-28.** `Skills.load_skill` is permission
annotated, but a prompt registered directly from `SkillRegistry` would load the
same body outside the agent session and bypass that policy. The registry is
also session wiring, while MCP prompt registration happens at server-layer
construction. Prompts therefore remain blocked until there is an authenticated,
permission-aware load seam shared by both paths; exposing skill bodies directly
would not be a thin adapter.

## Invariants

These are the properties the implementation must not break. Each has a test.

1. **MCP is an adapter, never a second entry into the kernel.** `AgentMcp`
   imports `AgentSessionHost`, `AgentClient` and `AgentProtocol` and nothing
   below them. If MCP needs a capability the seam lacks, the seam grows first,
   so every adapter gets it. An `import ... from "../AgentSession.js"` in
   `src/mcp/` is a plan violation.
2. **One registry on the shared-host path.** An application running `AgentMcp`
   and `AgentHttp` against one host tag sees one set of sessions and one
   `maxSessions`. The explicitly separate compatibility layer retains its
   older idle-eviction registry until that policy difference is resolved.
3. **A settled request id is never re-issued to the host.** See decision 2.
   Violating this runs a user's prompt twice.
4. **`after` is honoured or the read fails.** Never silently downgraded to a
   live stream.
5. **No elicitation is auto-granted.** Absent client capability yields pending,
   denied, or a stated failure — never approval.
6. **No call hangs without a bound.** Every blocking handler is either
   interruptible by the client or bounded; `agent_await` on a session that
   never finishes is the client's own choice and is cancellable.
7. **Nothing is unbounded by remote input.** Sessions, request entries, the
   adapter's ticket map and the pending elicitation set all have declared
   limits, and hitting one is a stated failure rather than growth.
8. **The library chooses no transport.** `src/mcp/` exports layers requiring
   `McpServer`; `layerStdio` versus `layerHttp` is the application's call, made
   in `apps/cli`.
9. **`@modelcontextprotocol/sdk` stays an optional peer.** The server direction
   rides Effect's own `McpServer`. This frontend must not make the SDK
   required — `scripts/verify-portability.mjs` covers the import graph.
10. **No casts at the boundary, tests included.** Tool parameters and resource
    payloads are `Schema`. Per `AGENTS.md`, a cast in a test is a library
    defect. `test/Casts.test.ts` enforces the count.

## Success conditions

The work is done when all of these hold. Partial credit is per phase, not per
condition within a phase.

**Functional**

- [x] A host can run: `agent_start` → `agent_steer` → `agent_await`, and the
      steering demonstrably reached the model (asserted from the provider's
      exact next prompt, not inferred from the final text).
- [x] `agent_interrupt` during a started run ends it and `agent_await`
      returns `status: "interrupted"` rather than failing.
- [x] A `tool-approval` elicitation raised mid-run reaches
      `McpServer.elicit` and the answer resumes the run, end to end, against a
      real stdio `McpServer` and official split-v2 client. This replaces the
      proposed in-memory transport with the actual full-duplex boundary.
- [x] Without usable native elicitation, the same run leaves a request in
      `agent_status`, `agent_respond` answers it, and the run resumes. The
      pending resource remains phase 4 rather than being implied here.
- [x] `agent://session/{id}/history` and `/pending` return authenticated JSON
      snapshots through official v2 HTTP resource reads.
- [ ] `agent://session/{id}/events?after=N` returns exactly the envelopes above
      `N`, and fails rather than degrading when the client cannot resume.
- [x] `ask_agent`'s observable behaviour is unchanged from today for a
      single-shot prompt, including its failure text shape for a failing run.

**Structural**

- [x] The additive shared-host path contains no session registry, eviction, or
      semaphore. The compatibility path deliberately retains all three until
      its different idle-eviction policy is resolved.
- [x] `AgentMcp` and `AgentHttp` over one host tag share one registry (proved
      by cross-adapter history with host capacity one).
- [x] Two `agent_await` calls for one ticket produce one run
      (asserted by counting model calls with the `/testing` provider).
- [x] An `agent_await` for a ticket the host has evicted produces one run — the
      original result — and not a second.

**Quality gates**

- [ ] The post-resource/example `npm run check` was green: every typecheck and
      build, 329-file Effect diagnostics at zero, portability and workerd,
      1,389 tests, all 41 packed entry points, and reference/CLI/TUI smoke. A
      later post-lifecycle rerun is currently blocked at typecheck by concurrent
      worktree changes in `test/SessionObserve.test.ts` and `test/ZProbe.test.ts`
      (`Effect.fork` does not exist; requirement channels widen to `unknown`).
      Focused MCP, session, cast, portability and the 1,390-test pre-arrival
      suite are green; do not attribute those two files to this plan.
- [x] `examples/mcp-frontend.ts` is a portable shared-host stdio frontend with
      no casts and no hand-annotated parameters, carrying a compile-time
      assertion that a tool handler's parameters are not `any` — **broken once
      to confirm it is enforced, then restored**, per `AGENTS.md`.
- [x] `STATUS.md` records what was built and, specifically, what was found to be
      wrong along the way.

## Sequence

Each phase is shippable and leaves the tree green.

1. **Shared-host path. ✅** `AgentMcp.serverLayer({ host })` serves the existing
   `ask_agent` through `AgentSessionHost`. The old `handlers`/`layer` path stays
   until idle eviction versus host refusal is an explicit compatibility
   decision; deleting it is not a pure refactor.
2. **Start/await and controls. ✅** The bounded ticket map, eviction guard,
   close, steering, follow-up and interrupt are implemented with semantics
   tests through an official client.
3. **Elicitation bridge and status/respond. ✅** Native form elicitation is
   capability- and transport-gated; manual, deny and fail policies are tested.
4. **Resources, partially complete.** `history` and `pending` are live.
   `sessions` needs an enumeration seam; `events` needs a finite resumable-read
   seam, not merely subscription support.
5. **Cancellation semantics and progress, blocked in the pinned MCP stack.**
   The adapter finalizer exists, but official-client cancellation does not
   interrupt the request handler, and `addTool` drops the progress token.
6. **Skills as prompts, blocked on authorization.** Do not bypass
   `load_skill`'s permission projection.

## Testing

- Effect's real HTTP server and official clients cover tools, manual
  elicitation and policies deterministically. Native reverse elicitation uses
  an official split-v2 client and a child-process stdio server because the
  pinned HTTP transport cannot perform that full-duplex exchange; lifecycle
  synchronization uses file-watch events rather than sleeps.
- `/testing`'s language model for run control — in particular
  `TestLanguageModel.failingAfter` for the failure-mid-run paths, and call
  counting for the double-run invariants.
- A conformance pass shared with the other adapters where one exists: `/mcp`
  should be held to the same host-behaviour tests `AgentHttp` and `AgentRpc`
  are, since after phase 1 they run the same host.
- The four invariants with teeth — 3, 4, 5 and the two-await-one-run condition —
  get named tests whose titles say what they protect.

## Notes and open questions

- **Resource subscription support is absent from the pinned registration API.**
  More importantly, a finite resumable read is absent from the host seam, so a
  resource cannot honestly project the live `Stream` even as polling.
- **`RemotePromptOptions` is thin.** It carries `stream` and nothing else. If
  the frontend wants per-call model or budget overrides, that is a seam change
  benefiting every adapter, and it is out of scope here — noted so it is not
  smuggled in as an MCP-shaped parameter.
- **Multi-client servers.** Over `layerHttp` several clients may address one
  session. The host's principal and authorization answer *who may*; nothing
  answers *what happens when two of them steer at once*. Today the session's own
  semantics decide, which is the correct place, but the frontend should not
  pretend otherwise in its tool descriptions.
- **Durable sessions.** Under `/durable` a session outlives every client handle
  and is reacquired by id from any process. The frontend gets that for free
  through the seam, but the tool descriptions currently imply session lifetime
  is the server's — worth rewording once phase 2 lands.
- **`Prompt.RawInput` versus `Prompt.Prompt`.** The seam takes `RawInput`; the
  protocol takes an encoded `Prompt`. MCP tool parameters must be schema-typed,
  so the adapter accepts a string (and, later, MCP `ContentBlock`s) and builds
  the prompt. Image and audio content from MCP mapping onto prompt parts is a
  real piece of work and is deliberately not in this plan.
- **Code mode is the *other* half of `/mcp`, and does not collide with this.**
  This plan is the outbound direction — the agent exposed to MCP clients.
  [research-code-mode.md](./research-code-mode.md) is about the inbound half,
  `McpToolkit.bind` / `bindDiscovered`, where catalog bloat actually appears.
  The two share a module and nothing else.
- **The `ask_agent` name.** It is the shipped surface and it stays. If the tool
  list ever gets renamed wholesale, that is a major version and a migration
  note, not a quiet change.
