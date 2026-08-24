# Audit: are we using the Effect ecosystem to its potential?

Seventh in the series, and the only one that ports nothing and builds nothing on
its own. It answers one question — *where is this library re-inventing something
the ecosystem already ships?* — and then pushes each answer into the plan that
should act on it.

The method was measurement, not reading. Every `effect` import in `src/` was
tallied and compared against the full v4 module list.

**Two rounds.** Round one (E1–E13) asked *which modules are missing*. Round two
(E14–E19) asked the harder question — *are the modules we do import used to
their depth?* — and found more actionable defects than round one did, including
two that contradict claims we make in our own documentation. Round two also
records what it checked and found **clean**, so that ground is not re-walked.

## Status: acted on

This is no longer a proposal. Eight of its milestones landed, and the findings
below carry their outcomes inline — what was built, what was falsified, and
where a finding turned out to be wrong.

| | Milestone | What it fixed |
|---|---|---|
| ✅ | A-0 (E15) | Spans and events used different attribute keys, so a trace could not be joined to the events about the same run |
| ✅ | A-1 (E7) | The coding toolkit's lock registry leaked an entry per file, and the code said the leak was unfixable |
| ✅ | A-1b (E14) | Four stores declared *empty* error channels while sitting on a database |
| ✅ | A-2 (E8, E17) | `/observability` standardised span names and shipped no instruments |
| ✅ | A-7 (E10) | `/connectors/slack` was host-coupled; it is out of `HOST_MODULES` |
| ✅ | A-10 (E16) | An unbounded 10ms poll, under a comment saying the wait could be days |
| ✅ | A-11 (E18) | The documented cast inventory had drifted from 5 to 16 |
| ✅ | A-13 (E20) | Tool arguments reached any exporter regardless of `RedactionPolicy` |
| ◑ | A-3 (E1) | Planned in [plan-execution-plan.md](./plan-execution-plan.md); not built |
| ○ | A-4/5/6/8/9/12 | Open. None blocks anything; several are gated on unbuilt plans |

**The audit was wrong four times, and each correction is recorded next to the
finding rather than quietly dropped:**

- **E1** claimed `/budget` gains a seam for "step down to a cheaper model".
  `ExecutionPlan` is failure-driven; budget-driven selection is a decision taken
  before anything fails.
- **E7** proposed `Tx*` for `AgentState`'s swap-and-persist. STM commits by
  retrying, and that critical section contains a store write (**E7b**).
- **E8** listed token metrics. No event carries usage, so that instrument would
  have to be invented rather than observed.
- **E10** said `effect/Crypto` would un-flag the Slack verifier. It has neither
  HMAC nor a constant-time compare. The goal was reached through Web Crypto's
  `subtle.verify` instead — which is also a *better* guarantee than the
  `timingSafeEqual` it replaced.

The pattern is worth naming: every one of those was a finding written from
knowing a module *exists* rather than from reading what it does. The measurement
half of this audit held up; the recommendation half needed checking.

**What it cost elsewhere.** Two findings changed public API — `StorageError`
moved into `Errors.ts` and `AgentState`'s mutations now declare it, which
reaches user code. The `/state` case was settled the harder way: a first design
made the error depend on whether persistence was configured, which is more
precise and makes it impossible to run the same agent ephemerally in development
and persisted in production. `examples/state.ts` does exactly that, so the
precise design was reverted.

## The headline

**The core is used deeply and idiomatically.** `Ref`, `SubscriptionRef`,
`Stream`, `PubSub`, `Queue`, `Deferred`, `Semaphore`, `Scope`, `Fiber`,
`Schedule`, `Cause`, `Exit`, `Layer`, `Context` and `Schema` are all present and
load-bearing rather than decorative, which is the part that is hard to retrofit
and the part we got right. The AI modules are used harder than anything else in
the repository (137 imports of `effect/unstable/ai`).

**The gaps are not scattered.** They cluster in three groups, and nearly every
item in the first group is a primitive that one of our own unbuilt plans
proposes to hand-roll. That is the finding worth acting on: we are about to
write code the ecosystem already has.

## The measurement

Named imports from the `effect` barrel in `src/`:

| Count | Module |
|---|---|
| 70 | `Effect` |
| 43 | `Option` |
| 36 | `Schema` |
| 32 | `Ref` |
| 28 | `Stream` |
| 22 | `Layer` |
| 15 | `Cause` |
| 13 | `Context` |
| 11 | `Exit` |
| 9 | `Semaphore` |
| 8 | `Scope`, `Deferred` |
| 7 | `Duration` |
| 6 | `Schedule`, `Queue` |
| 5 | `PubSub`, `Clock` |
| 4 | `SubscriptionRef` |
| 3 | `Predicate`, `Config`, `Match` |
| 2 | `Fiber` |
| 1 | `Redacted`, `Metric`, `FiberSet`, `Cron`, `Data`, `JsonSchema` |

Subpath imports across `src/`, `test/` and `examples/`: `ai` 137, `http` 43,
`cluster` 19, `workflow` 14, `httpapi` 6, `sql` 5, `encoding` 4, `rpc` 3,
`socket` 1, `observability` 1.

**Zero uses anywhere:** `ExecutionPlan`, `LayerMap`, `RcMap`, `RcRef`, `Cache`,
`ScopedCache`, `Pool`, every `Tx*` module, `Graph`, `Optic`, `JsonPatch`,
`JsonPointer`, `PartitionedSemaphore`, `Request`, `RequestResolver`, `Tracer`,
`Terminal`, `FileSystem`, `Path`, `Crypto`, `HashRing`, `Newtype`, `Brand`, and
the subpaths `cli`, `devtools`, `eventlog`, `persistence`, `process`,
`reactivity`, `workers`.

## Group 1 — primitives our own plans propose to hand-roll

### E1. `ExecutionPlan` — the largest single omission

Zero uses, and it is the one gap that is a *missing kernel capability* rather
than a missing convenience.

Our stated invariant is that the model arrives through the environment and an
`Agent` never names a provider. `AgentSession.make` requires
`LanguageModel.LanguageModel` and gets it from the context it was built in,
which answers exactly one question: **which** model. It does not answer the one
immediately after — what to do when that model is rate-limited or down. Today
the answer is "the run fails", and anyone who wants better writes the ladder
themselves, outside the harness.

It fits the combinator rule exactly (AGENTS.md §42.1): `withExecutionPlan(plan)`
returns a definition and `Agent.make` grows no tenth type parameter.

**One claim here was wrong.** This finding said `/budget` gains "a principled
seam on which to hang *this run has spent enough — step down to a cheaper
model*." It does not. An `ExecutionPlan` is **failure-driven**: it moves to the
next step because the current one failed. Budget-driven selection is a policy
decision taken *before* the call, when nothing has failed, and the `while`
predicate does not reach it — that decides whether to keep trying after an
error. The budget case is a `LanguageModel` layer built from an effect that
reads `Budget`, which is `Layer.unwrap` over ordinary wiring and needs no new
API at all.

Written up as [plan-execution-plan.md](./plan-execution-plan.md), which also
records the constraint that decides the design: **a plan must wrap the model
call and nothing wider**, because a turn is a model call *and its tool calls*,
and retrying a turn would re-run side effects on the world.

### E2. `unstable/eventlog` — evaluate before building H5/H6

The kernel is already event-sourced: `AgentEvent` envelopes carrying
session-local sequence numbers, a canonical history committed per turn,
snapshots, and a `DeliveryLog` with `read({ after })`.
[plan-durability-hardening.md](./plan-durability-hardening.md)'s promise 3 —
*clients reconnect without starting over* — is, restated, exactly what an event
log module exists to provide, and its W5 (cross-node live delivery
unimplemented) is the classic reason people reach for one.

The action here is **an evaluation, not an adoption**. Before H5 and H6 are
built, answer in writing: does `eventlog` subsume `DeliveryLog`, part of
`/durable-streams`, or neither? Either answer is defensible. Not asking, and
then shipping a second hand-rolled log, is not.

### E3. `unstable/persistence` — we have two hand-rolled `Store` seams

`state/AgentState.ts:129` defines `interface Store`. `durable/DurableChannels.ts:32`
defines another `interface Store`. `/memory` will want a third. These are
key/value persistence seams, which is precisely the module's subject, and
adopting it also inherits its backings instead of us writing a SQL adapter per
package.

The interfaces themselves are small and good; the cost of the mistake is not the
interface, it is the N adapters behind it.

### E4. `LayerMap` + `RcMap` / `RcRef` — the agent server's missing half

[plan-agent-server.md](./plan-agent-server.md) mounts several agents, possibly
on different infrastructure, each with its own registry and capacity.

- `LayerMap` is a keyed, ref-counted, scoped layer per key — one agent's wiring
  per mount, built on first use and released when the last user goes.
- `RcMap` is a keyed, ref-counted, scoped *resource* map — a live-session
  registry whose entries release on last reader.

Hand-rolling that pair is the standard way an agent server leaks sessions, and
it is the kind of leak that shows up an hour into production rather than in a
test. The session tree wants the same primitive for a different reason (E7).

### E5. `Graph` — the session tree is a graph

[plan-session-tree.md](./plan-session-tree.md) is a branch-and-rewind DAG with
parent pointers, `commonAncestor`, divergence and subtree queries — T4 is a list
of graph algorithms. `Graph` provides the structure and its traversals typed,
instead of a hand-rolled parent-pointer map plus five ad-hoc walks.

Caveat worth stating: if `Graph` does not carry the incremental, persistent
shape the tree needs, keep the hand-rolled map and say why in T1. This is a
recommendation to *check*, not to adopt unseen.

### E6. `unstable/cli` + `Terminal` — the named P3 gap

ROADMAP lists CLI as the top remaining ecosystem gap, and `apps/tui/` is
currently a `package.json` and a lockfile. `unstable/cli` and `Terminal` are the
ecosystem's answer, and a CLI is also the fastest way to make the coding toolkit
and the session tree usable by a human rather than only by a test.

`unstable/reactivity` is *not* recommended for the TUI: OpenTUI/Solid brings its
own reactive system, and running two is worse than running either.

## Group 2 — hardening what already ships

### E7. `Tx*` — extend our own atomicity rule past one ref

AGENTS.md makes atomicity a rule: *"`SubscriptionRef.modify`, not
read-then-write."* That rule is real and it is followed — but it only reaches as
far as **one** ref. Where an invariant spans two pieces of state, we currently
fall back to a semaphore, and that is visible in the code:

- `state/AgentState.ts:262` documents that persistence runs after the ref swap,
  so a permit serialises swap-and-persist into one critical section. Correct, and
  coarser than it needs to be — every mutation now serialises, including ones
  touching unrelated state.
- `coding/CodingToolkit.ts:252` holds a module-global
  `Map<string, Semaphore.Semaphore>` of per-file write locks, with a comment at
  line 249 explaining that entries are never removed *because dropping a lock
  somebody holds would silently end the mutual exclusion*. That is exactly the
  problem [plan-pi-toolkit.md](./plan-pi-toolkit.md) P1 sets out to fix, and it
  is unfixable with a plain `Map` for the reason the comment gives.

A transactional registry makes "drain the queue and remove the entry" a single
commit — the drain and the delete cannot interleave, so the leak closes without
the hazard. This is the highest-value correctness item in the audit, and it is a
fix to a limitation we documented ourselves.

**What landed (A-1), and two corrections to this finding.**

*The registry is a `TxRef<HashMap<string, LockEntry>>`, not a `TxHashMap`.*
`TxHashMap` is itself a `TxRef` holding a `HashMap` (`TxHashMap.ts:294`), and
the operation needed here — read the entry, decide, write the map back, as one
commit — is exactly `TxRef.modify`. Going through `TxHashMap` would have added a
layer without adding an operation. `TxRef` also has `makeUnsafe`, which matters:
the registry is module-level, so it must be constructible without an `Effect`,
the same way the semaphores it holds already were.

*`TxReentrantLock` was not needed.* The entry keeps its `Semaphore` and gains a
holder count; the transaction protects the *registry*, not the critical section.
Mutual exclusion was never the broken part.

The count is incremented before the permit is acquired and decremented after it
is released, so an entry outlives everyone holding it or queued behind it —
which is the invariant that makes removal safe. `Effect.acquireUseRelease`, not
a bare `withPermit`, so an interrupted edit still decrements; a leaked count
would pin the entry forever and reintroduce the leak in a subtler form.

Three tests in `test/CodingToolkit.test.ts` assert what could not be asserted
before — the registry drains, a waiter arriving *as* the lock drains still gets
exclusion, and an interrupted edit does not pin its entry. Falsified twice:
removing the eviction fails two of them, and replacing `acquireUseRelease` with
a plain `withPermit` fails all three.

**The `AgentState` half of A-1 is withdrawn — see the decision below.**

### E7b. `AgentState`'s semaphore is correct, and `Tx*` cannot replace it

*Recorded under A3, because this audit proposed the change and was wrong.*

`state/AgentState.ts:262` serialises swap-and-persist under a permit, and this
audit filed that as a coarse workaround `Tx*` would improve. It would not.

An STM transaction commits by retrying on conflict, so everything inside it must
be safe to run more than once. The critical section here is not two ref writes —
it is a ref write **and an encode-and-store**, which is I/O. Putting that inside
`Effect.tx` would re-issue a store write on every retry. A transaction cannot
contain the thing that makes this section critical.

So the semaphore stays, and it is the right primitive: the invariant spans a ref
and an external system, which is the case STM explicitly does not cover. The
coarseness is real but it is the price of correctness, and the honest
improvement — if the serialisation ever shows up in a profile — is a finer key,
not a different concurrency primitive.

The general lesson, worth keeping: `Tx*` applies where an invariant spans two
pieces of *in-memory* state. The lock registry qualified; this does not.

### E8. `Metric` — `/observability` has spans and almost no metrics

One import in the whole repository. `/observability` standardises span names and
attributes carefully and ships essentially no counters or histograms, yet most
of what an operator asks is derivable from the event stream it already consumes.

**One correction to this finding.** It listed *tokens in/out* among them. No
event carries model usage, so a token metric would have to be **invented rather
than observed** -- adding usage to the event stream is a change to the kernel's
vocabulary and deserves its own decision, not a smuggled dependency inside a
metrics change. Dropped, and said so in the module.

**What landed (A-2).** `Observability.metrics(events)` -- the sibling of
`trace`, forked the same way, kept separate because the two have different costs
and different reasons to be switched off. Five instruments, all three shapes:

| Instrument | Shape | From |
|---|---|---|
| `agent_turns` | counter | `TurnCompleted` |
| `agent_turns_per_run` | histogram | `RunCompleted.turns` |
| `agent_tool_calls` | counter, by `tool` + `outcome` | the three terminal tool events |
| `agent_tool_duration_ms` | histogram, by `tool` | `ToolCallStarted` paired with its terminal event |
| `agent_pending_input` | gauge | queued minus applied, for steering and follow-ups |

Two decisions worth recording. **No redaction policy here, on purpose**: a
metric dimension must be low-cardinality to be useful, so nothing user-supplied
is ever an attribute -- tool *names* are, parameters and results are not -- and
no metric can become the leak `RedactionPolicy` exists to prevent. And the
duration histogram is measured **as the observer sees the events**, because no
event carries a timestamp; on a live stream that is the tool's duration plus
stream latency, and on a replayed stream it is meaningless. Stated in the
module rather than left to be discovered.

The instruments are **exported**, which the existing counter's test argued for:
a metric's identity is its name *and* its description, so `test/AgentData.test.ts`
restates the description verbatim to read it back -- a duplicated string waiting
to drift, the same failure the toolkit's prompt rendering exists to prevent.
Handing out the instrument removes the duplication, and lets an application read
its own health numbers without going through an exporter.

Two tests, falsified twice (drop the turn count; stop decrementing the gauge).

### E9. `FileSystem` / `Path` / `unstable/process` / `Stdio`

`sandbox/local.ts` imports `node:child_process`, `node:fs`, `node:fs/promises`,
`node:os` and `node:path` directly. That is defensible in an adapter named
*local* — and `src/sandbox/index.ts` is explicit that the host-coupled part
lives there.

Two things make it worth revisiting anyway. `apps/tui` runs on **bun**, so
portability stopped being hypothetical. And Effect's process abstraction gives
`Scope`-bound spawn and interruption for free, which the `bash` tool currently
manages by hand.

Recommendation: keep `local` as the host-coupled adapter, but check what a
`FileSystem`/`Process`-backed sandbox costs — it may be a second adapter behind
the same seam rather than a rewrite, which is the cheapest possible answer.

### E10. `Crypto` — the goal was right, the mechanism was wrong

`connectors/slack.ts` used `node:crypto`'s `createHmac` and `timingSafeEqual`
and was host-flagged in `scripts/verify-portability.mjs` for it. ROADMAP names
"a real crypto-backed Slack signature verifier as a host-flagged sub-entry" as
remaining work. This finding said Effect's `Crypto` "removes the flag".

**It cannot.** `effect/Crypto` offers random bytes, random numbers, UUIDv4/v7
and SHA message digests — and neither **HMAC** nor a **constant-time compare**,
which are the only two things this verifier needs. Checked by reading the
module and grepping the whole of `effect/src` for `hmac`: no hits.

**What landed (A-7)** is the goal by a better route. The Web Crypto API
(`globalThis.crypto.subtle`) is implemented by Node, Bun, Deno and edge
runtimes, so it carries no host dependency — and it turns out to be a *stronger*
answer than the code it replaced, not merely a portable one.

The interesting part is the comparison. Verifying by computing the expected
signature and comparing strings needs that compare to be constant-time, or its
duration leaks how much of a forged signature was correct. `node:crypto` gives
that as `timingSafeEqual`; Web Crypto has no equivalent, and hand-rolling one in
JavaScript is a promise the language cannot keep — a JIT is free to optimise it.

So the comparison is not done in our code at all. **`subtle.verify` takes the
signature and the data and answers directly**, comparing inside an
implementation built for it. Portability and the timing guarantee both improve;
the tempting middle option — Web Crypto plus a hand-written XOR loop — would
have traded the second for the first, and is exactly what this finding would
have produced if it had been implemented as written.

`connectors/slack.ts` is **removed from `HOST_MODULES`**, which is the only
proof that matters: `npm run lint:portability` now passes without an exemption
for it, and would fail if the host coupling came back. Two new tests cover the
paths the rewrite introduced — `subtle.verify` takes bytes, so the `v0=<hex>`
header must be parsed, and every malformed shape an attacker can send is an
ordinary `false`. The suite still signs with `node:crypto` and verifies with Web
Crypto, so a pass proves the two agree rather than that our code is
self-consistent. Falsified by removing the freshness check and by verifying the
wrong bytes.

### E11. `PartitionedSemaphore` — per-tool concurrency

`ToolExecution` offers a single global concurrency number
(`ToolExecution.concurrency(n)`, rendered into one `{ concurrency }` option at
`ToolExecution.ts:498`). The real requirement is per-key: one `bash` at a time,
ten concurrent `read_file`s. `PartitionedSemaphore` is that primitive exactly,
and this is a `Strategy` variant rather than new API surface.

### E12. `Cache` / `ScopedCache`

Zero uses. Skills load lazily on every request, MCP tool discovery re-queries,
subagent definitions rebuild, and the coding toolkit re-reads files it has
already read within a turn. `ScopedCache` in particular matches the MCP case,
where the cached thing owns a connection.

### E13. `Config` / `ConfigProvider`, and `Redacted` end to end

Three `Config` imports and one `Redacted`. For a library about to grow a server
and a CLI, limits, capacities, budgets and provider credentials should arrive
through `Config`, and credentials should be `Redacted` from arrival to use.
`/observability` already has a redaction policy for telemetry; the two halves
should meet rather than solve the same problem twice.

## Group 3 — situational, listed so they are not rediscovered

- **`JsonPatch` / `JsonPointer`** — snapshot deltas, session-tree divergence
  rendering, and `/ag-ui` incremental state sync. Relevant to
  [plan-snapshot-export.md](./plan-snapshot-export.md) §4.
- **`Optic`** — deep updates in `/state` without spread chains, once user state
  is nested enough to hurt.
- **`unstable/workers`** — a real isolation boundary for `/subagent` and
  `/sandbox`, if isolation ever needs to be more than a convention.
- **`unstable/devtools`** — the dev-ergonomics half of the P3 gap.
- **`Pool`** — sandbox and process reuse, once spawn cost matters.
- **`Request` / `RequestResolver`** — dedupe and batch tool calls that hit the
  same backend within a turn.
- **`HashRing`** — only if `/cluster` ever routes by itself rather than
  delegating.

## Round two — how we use what we already import

A module can be imported everywhere and still be used at a tenth of its depth.
These findings are all about modules already in the dependency list, and three
of them are places where the code and our own prose disagree.

### E14. `Effect.orDie` has quietly emptied the storage error channel

**58 `Effect.orDie` in `src/`, 33 of them in `durable/`** — 17 in
`DurableSessionStore.ts` alone, 8 in `DurableChannels.ts`, 7 in `DeliveryLog.ts`,
5 in `state/AgentState.ts`.

AGENTS.md is unambiguous: *"A public function's error channel must name what can
go wrong. `unknown` in an error channel is a bug: it erases exactly the
information Effect exists to carry."* An `orDie`d channel is not `unknown` — it
is **empty**, which is a stronger claim than `unknown` and a false one. The
signatures say these operations cannot fail:

```ts
// DurableSessionStore.ts:242
): Effect.Effect<string> => Schema.encodeEffect(Prompt.Prompt)(prompt).pipe(..., Effect.orDie)

// DurableSessionStore.ts:248
export const decodeHistory = (encoded: string): Effect.Effect<Prompt.Prompt> =>
  Effect.try(() => JSON.parse(encoded) as unknown).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Prompt.Prompt)),
    Effect.orDie
  )
```

Encoding a `Prompt` we just built is arguably infallible. **Decoding one we read
back is not** — a truncated write, a row from an older schema version, a
half-committed transaction and a corrupted blob all land here, and all become
defects. The `sql` operations at lines 574, 600, 648 and 670 do the same to
database failures.

This collides directly with
[plan-durability-hardening.md](./plan-durability-hardening.md):

- **D7 says** *"Storage failure degrades, it does not corrupt. A store that
  fails a write causes the caller to see a failure."* A defect is not a failure
  the caller sees; it is a fiber death.
- **H4 proposes** running the durable suites under a store that fails, duplicates
  and half-commits. Against an `orDie`d store, every one of those faults produces
  the same observation — a defect — so H4 can assert *that* it broke and never
  *how it degraded*. **H4 cannot be written meaningfully until this is fixed**,
  which promotes E14 from cleanup to a prerequisite.

The work is not "remove `orDie`." It is to triage the 58 sites into three
groups: genuinely impossible (keep, with a comment saying why), a real failure
the caller must see (give it a typed error), and a real failure the caller
cannot act on (still a defect, but say so at the site). The count going down is
not the goal; the count being *justified* is.

**What landed (A-1b), for `DurableSessionStore`.**

`src/durable/StorageError.ts` is a `Schema.TaggedError` carrying the operation,
the session where one applies, and a detail — so it crosses a workflow journal
like any other declared failure. The triage came out:

| Bucket | Sites | Treatment |
|---|---|---|
| Genuinely impossible | `encodeHistory`, `encodeJson` | stays `orDie`, with the reason at the site: the value was assembled by this process, so a schema that cannot encode it is a bug in this library |
| The caller must see it | `decodeHistory`, `decodeJson`, and all 11 SQL operations | typed `StorageError` |
| The caller cannot act | the elicitation projection (3 sites), the two `CREATE TABLE` statements | stays a defect, now with a recorded reason |

The third bucket is the interesting one. `Elicitation.Elicitor` is a **core**
seam whose methods declare no error, because a local elicitor genuinely cannot
fail. Widening it so the durable implementation could report a store failure
would push durability's concerns into the kernel — the one thing every package
here is forbidden to do — and there is no useful answer at that depth anyway: a
run whose elicitation projection is unwritable cannot ask its question, so it
cannot continue. The `orDie` stays; what changed is that it is now a considered
choice with the argument written down, rather than the default.

**The interface was the real defect, not the calls.** Every
`DurableSessionStore` method read `Effect.Effect<X>` — an *empty* error channel,
which claims more than `unknown` does and claims it falsely. The methods now
declare `StorageError`. The ripple was smaller than feared and landed exactly
where it should: `DurableAgentClient` folds it into the existing
`AgentTransportError` at the client boundary, so **`RemoteError` gains no
variant and the wire protocol is unchanged**. That is the right fold — a client
needs one bit (can retrying work?) and `AgentTransportError` already is that bit,
while the finer distinction survives where it is acted on.

**It deleted the code it was supposed to.** `DurableSubmission.isInfrastructure`
existed to tell infrastructure failure from agent failure, and with the error
channel emptied its only evidence was the shape of thrown objects — matching
`_tag === "SqlError"` and then asking whether a `name` string merely *contained*
`"SqlError"`. A store returning a differently named driver error was silently
reported to the caller as its *agent* failing. It now checks the typed error
first; the defect walk survives only for the elicitation seam above, which
genuinely still arrives that way.

`test/StorageError.test.ts` (5 tests) pins that a corrupt history is a failure
rather than a defect, that a schema mismatch is too, that the happy path still
round-trips, that distinct faults produce **distinct, inspectable** observations
(the H4 prerequisite), and that a `StorageError` decoded from JSON is still
recognised — which `isInfrastructure` depends on. Falsified by restoring
`Effect.orDie` on `decodeHistory`: three of the five fail.

**`DeliveryLog` followed**, and it is the one where the emptied channel hid the
most. D5 says *a consumer that disconnects and reconnects from its saved offset
sees every event it had not seen, in order, with no gap.* A row that cannot be
decoded **is** that gap -- and while `decodeEnvelope` was `orDie`, a reconnecting
consumer met it as a dead fibre. The failure mode D5 exists to forbid was also
the one hardest to observe. `append`, `live` and `read` now declare
`StorageError`, and the client's `events` stream ends with an
`AgentTransportError` rather than a defect, so a consumer can reconnect from its
last sequence -- which is the entire point of a log readable from an offset.

That triage surfaced a third instance of the same core-seam constraint.
`AgentSession.MakeOptions.eventSink` declares `Effect<void>`, so
`DurableSubmission`'s recorder cannot report a failed append through it. The
`orDie` stays -- and here it is also the *outcome we want*: a submission whose
events cannot be recorded has a gap in the client's reconnect stream, so it must
not be reported as having completed normally, and `isInfrastructure` turns
exactly this into an `Infrastructure` outcome the client reports as retryable.
What the typed error bought is the **reliability of that classification**: the
defect used to be whatever the driver threw, recognised by matching `"SqlError"`
against its `name`; it is now a `StorageError` matched by tag, whether it
arrives as a failure or as a defect.

**`DurableChannels` and `state/AgentState` finished it**, and the first was
mis-scoped above: `offerIfOpen` *is* the admission gate, so D1 (*work reported
as accepted is executed exactly once, or the failure is reported to the caller*)
runs straight through it. A defect during admission is neither of D1's two
allowed outcomes.

`StorageError` moved to `Errors.ts` in the process. It was never
durability-specific -- `/state` persists through a `Store` too -- and a second
error meaning the same thing is the duplication this audit exists to remove.
`detailOf` stayed internal: it fills in a `detail` and is not vocabulary a
caller needs.

**The `/state` design question, and how it was settled.** Typing the store's
failure means `AgentState`'s mutations declare it, which reaches user code: a
tool writing persisted state must now decide what to tell the model. The
obvious refinement was to make the error depend on whether `persistence` was
supplied -- `AgentState<A, E = never>`, so ephemeral state acknowledges nothing.

That was built, and then reverted, because `examples/state.ts` proves it wrong:
it runs **the same agent** ephemerally in development and persisted in
production. Two types make that swap impossible. So there is one type, its
mutations declare `StorageError`, and ephemeral state simply never raises it --
a deliberate overstatement, chosen because interchangeability is worth more
than a `never` the ephemeral case would have enjoyed. A caller with no store
writes `Effect.orDie`; a caller with one now learns its write failed.

The examples were updated to *handle* it rather than to suppress it, which is
the honest demonstration: a tool that could not save a step tells the model so,
and the model can retry or carry on.

**A mistake worth recording.** `AgentEntity`'s Rpc handlers declare
`AgentIdleError` and cannot grow a variant without a protocol change, so a
store failure dies there. The first version used `Effect.orDie`, which took
`AgentIdleError` with it -- the one error the Rpc *does* declare and the only
one a caller can act on. `test/Cluster.test.ts` caught it
(*"steering an idle session fails as a typed error, not a defect"*). It is now
`catchTag("StorageError", Effect.die)`, which dies for exactly one reason.

### E15. Two telemetry vocabularies for the same facts — **fixed, A-0**

*Resolved. Kept here as the record of what was wrong and what the fix asserts;
see the A-0 entry under Milestones for what landed.*

The span tree is real, and better than round one assumed. `Effect.fn` supplies
the names and the nesting is genuine — `AgentSession.prompt` →
`AgentSubmission.execute` → `AgentRun.execute` → `AgentTurn.execute` →
`ToolExecution.tool` — and each annotates its ids:

```ts
AgentRun.ts:39        Effect.annotateCurrentSpan({ runId, submissionId })
AgentSubmission.ts:53 Effect.annotateCurrentSpan({ submissionId })
AgentTurn.ts:178      Effect.annotateCurrentSpan({ runId, turn })
```

Meanwhile `/observability` defines the vocabulary it says the runtime already
uses:

```ts
attributeNames = { session: "agent.session.id", run: "agent.run.id",
                   submission: "agent.submission.id", turn: "agent.turn.index", ... }
```

**These do not meet.** The spans say `runId`; the package says `agent.run.id`.
An exporter therefore cannot join a trace to the events `/observability` emits
about that same run — the correlation exists in the system and not in the
telemetry, which is the one thing this package exists to provide. Two smaller
consequences fall out of the same gap:

- **No kernel span carries `sessionId`.** Only `client/internal/sessionHost.ts`
  annotates it. Filtering a trace view by session — the first thing anyone does —
  does not work below the host boundary.
- **`Observability.ts`'s own doc comment describes the tree as
  `agent.session → submission → run → turn → {ai.model, ai.tool}`**, which is
  the shape but not the names.

One sub-point in the first draft of this finding was **wrong** and is corrected
here: `ai.model` *does* have a span. `LanguageModel.generateText` opens it with
GenAI-convention attributes from Effect AI itself, as `examples/tracing.ts`
already documented. The harness supplies the structure above it and should not
add one of its own.

**What landed (A-0).** The definition moved *below* both halves rather than into
either: `src/internal/telemetry.ts` owns `attributeNames` and a small set of
`annotate*` helpers, `/observability` re-exports it as the unchanged public
`Observability.attributeNames`, and the kernel annotates through the helpers.
Neither half writes a key literal any more. The layering matters — putting the
source in `/observability` would have made the kernel depend on a battery built
over it.

Every kernel span now also carries `agent.session.id`, which is what makes a
trace filterable by session below the host boundary.

Asserted by `test/Tracing.test.ts` — *"spans and events share one attribute
vocabulary"* — which checks the standard keys are present, the old bare ones are
gone, and, the point of the exercise, that `Observability.describe` of a
`ToolCallStarted` event and the `AgentRun.execute` span agree on
`agent.run.id` by key *and* value. Falsified by reverting `AgentRun`'s
annotation to `{ runId, submissionId }`: the test fails on the missing
`agent.session.id`, then passes again when restored.

### E16. `Schedule` is imported and barely composed

Every `Schedule` use in `src/`:

```
6 Schedule.spaced   3 Schedule.cron   2 Schedule.recurs
```

No `exponential`, no `jittered`, no `union`/`intersect`, no `addDelay`. Fixed
intervals only — and the intervals are five separately-chosen constants across
five files: 250ms (`DeliveryLog.ts:243`), 100ms (`EntityClient.ts:122,151`,
`DurableAgent.ts:281`), 25ms (`DurableSubmission.ts:580`), 10ms
(`DurableAgent.ts:493`, `DurableAgentClient.ts:161`).

Two problems, one per half of that sentence.

**Fixed-interval retry against shared infrastructure is a thundering herd.** When
a SQL store or a cluster node recovers, every waiting client retries at the same
spacing and hits it simultaneously. `Schedule.exponential(...).pipe(jittered)`
is the standard answer, it composes with what is already written, and it is one
of the modules AGENTS.md names as preferable to an agent-specific invention
(*"`Schedule` for retries"*).

**Polling intervals are policy and should be `Config`.** These are the numbers an
operator tunes under load, and four of the five are hard-coded rather than
merely defaulted. This is the concrete half of E13 — a place where `Config` has
an obvious job today rather than when the server lands. It also connects to
[plan-durability-hardening.md](./plan-durability-hardening.md) H7, which brings
the 25ms poll under `TestClock`: a value that is configurable is also trivially
testable.

**What landed (A-10), and the pathology it found.** `src/internal/schedules.ts`
holds the two shapes, because they are genuinely different and were being
re-derived as the same constant:

- **`steady(interval)`** — jittered, not exponential, for retrying shared
  infrastructure where the wait is bounded by an attempt count
  (`EntityClient` ×2, `DurableAgent`'s shard-reassignment retry). Growing the
  delay would silently turn those sites' one-minute ceiling into a
  twenty-minute one, so removing the herd and changing the timing envelope are
  kept as separate decisions.
- **`backoff({ start, cap })`** — capped exponential with jitter, for polling
  for a state change.

The second exists because of a real defect. `DurableAgentClient.awaitOutcome`
polled at a fixed 10ms with **no upper bound**, directly under a comment reading
*"Unbounded by design: a submission parked for a human may take days."* Those two
facts together are roughly **8.6 million polls per waiting client per day**, for
an answer that is not arriving until somebody wakes up. Capped exponential keeps
the fast path fast — the first retry is still `start` — while a long wait costs
one poll per second instead of a hundred.

**A second bug, caught by asserting the thing rather than assuming it.**
`Schedule.jittered` multiplies by a factor in `[0.8, 1.2]`, so it can make a
delay *longer*. The first version of `backoff` capped and then jittered, which
let delays exceed the cap by 20% — the test failed with *"expected 223ms to be
at most 200"*. Jitter now comes first and the cap last, so the cap is a ceiling
rather than a suggestion. The same discovery corrected `steady`'s doc, which
claimed the interval was an upper bound when it is a mean.

Three tests, falsified twice: swapping the cap and jitter back reproduces the
223ms overshoot, and removing jitter fails the desynchronisation assertion.

**Still open:** the intervals themselves are still literals. Turning them into
`Config` is A-8, and unchanged by this.

### E17. `Metric` has exactly one instance, and it is the right one

Refining E8 with the specific. The single `Metric` use in the repository:

```ts
// data/AgentData.ts:9
const droppedEvents = Metric.counter("agent_data_dropped_events", { ... })
// :116  Metric.withAttributes(droppedEvents, { channel: name })
```

That is a good instrument — a counter for a real failure mode, attributed by
channel. It is also the template, which makes E8 cheaper than it looked: the
pattern is established and the work is applying it four more times over an event
stream `/observability` already consumes. Nothing new needs designing.

### E18. The documented cast inventory has drifted from the code

AGENTS.md states that *"The casts that exist in `src/` are structural, and each
is documented at the site,"* then enumerates five: the phantom `Tools` field,
the `Toolkit.empty` default, `Agent.ts`'s `definition`, `mergeHandled`, and
`Permission.annotate`. It closes with the rule that matters: *"Adding another
needs a reason of that kind."*

Measured, and the measurement had to be redone properly. A `grep " as any"`
reports **17**, and one of them is the phrase *"survives for as long as anyone
holds it"* in a comment — `as anyone` contains `as any`. Casts are syntax, so
they must be found by parsing.

Parsing `src/` gives **112 `as` expressions**, which is the more interesting
number, because it shows the original finding was measuring the wrong thing.
Two categories:

- **A plain `x as T`** — around a hundred of them. TypeScript still checks these
  for overlap; they narrow, they cannot claim a string is a number. Ordinary.
- **The erasing forms** — `x as any`, which turns the checker off, and
  `x as unknown as T`, which routes around it. **Sixteen, in four files.**

| File | Erasing casts | On the list? |
|---|---|---|
| `Agent.ts` | 4 | yes — phantom `Tools`, `Toolkit.empty`, `definition`, `mergeHandled` |
| `durable/DurableModel.ts` | 5 | **no** |
| `durable/DurableToolkit.ts` | 3 | **no** |
| `testing/TestLanguageModel.ts` | 4 | **no** |

A bare `JSON.parse(x) as unknown` is deliberately not counted: that is the
*safe* direction, taking `any` down to `unknown` so the value must be decoded
before use. Counting it would punish the defensive idiom, and it appears in five
files that do exactly the right thing.

The twelve unlisted ones are all in library code, so **the user-facing rule is
not violated** — nothing here means a caller needs a cast, and that is the rule
that matters most. But they are two further *kinds*, and the enumeration that
was supposed to make adding one deliberate had stopped being an enumeration.

**One list entry is not an erasure at all.** `Permission.annotate` is a plain
`as T`; the projection is typed against `Tool.Parameters<T>` before the cast, so
a wrong resource function still fails to compile. It stays documented, but as
what it is.

**What landed (A-11).** `test/Casts.test.ts` walks the TypeScript AST of every
file in `src/`, counts erasing casts per file, and compares against an inventory
that mirrors AGENTS.md. Adding one fails the build with a message naming the
file and the reasons its existing casts are allowed — so the next author sees
what kind of argument a new one has to make. AGENTS.md gained the two missing
kinds and the distinction above.

A second test asserts the detector is falsifiable in both directions: it sees
`y as unknown as string` (two nested `as` nodes) and does **not** see the
`as anyone` comment that fooled the grep. Falsified by adding one erasing cast
to `AgentLoop.ts` — the suite fails naming that file — then removing it.

This is the technique `test/CodingPrompts.test.ts` already established for
prompt constants: a convention nobody can drift away from is one the build
checks. It would have caught the two casts this audit's own `A-2` work nearly
shipped in a `Metric.withAttributes` helper.

### E19. Unbounded queues, without a stated policy

Four `Queue.unbounded` — `InputChannel.ts:78`, `testing/AgentProbe.ts:57`,
`ag-ui/AgentAgUi.ts:1017`, `a2a/AgentA2A.ts:880`. Unbounded is very likely
correct for at least the first two: `InputChannel` is the durable seam where
dropping accepted input would violate D1, and a test probe that drops events is
useless.

The finding is not "these are wrong," it is that **the choice is unstated** in
three of the four, while the fourth kind of decision — dropping — is elsewhere
made explicitly and even instrumented (E17's counter exists precisely because
`/data` drops). A queue with no bound is a memory-growth decision, and a slow
SSE consumer on the `/ag-ui` queue is the realistic way it bites. Write the
policy down per queue; change only the ones the writing shows to be wrong.

## What round two checked and found clean

Recorded so it is not re-audited, and because it is the larger part of the
result:

- **No runtime escapes.** Zero `Effect.runPromise`, `runSync` or `runFork` in
  `src/`. Everything composes as an `Effect` to the boundary.
- **No `unknown` error channels** in any public signature (`Effect.Effect<A,
  unknown>` appears once, internally, at an `Activity` boundary — E18).
- **Determinism hygiene.** Zero `Math.random`. One `Date.now`, in
  `a2a/AgentA2A.ts`, at a protocol boundary. `Clock` is used where time matters.
- **No stray timers in the kernel.** The five `setTimeout` sites are in
  `sandbox/local.ts` (a host-coupled adapter, where process signalling requires
  them) and one in `durable-streams`. None in the agent core.
- **One piece of mutable module state**, `CodingToolkit.ts:252` — already
  E7/A-1. Every other module-level `Map`/`Set` is a frozen lookup table.
- **`Effect.fn` is used as the definition form**, not retrofitted, and 70 sites
  carry real `Module.operation` names. The absence of `withSpan` is correct
  rather than a gap — `Effect.fn` already opens the span.
- **Atomicity is respected.** 31 `Ref.modify`, 37 `Ref.update`, 5
  `updateAndGet`, 3 `getAndUpdate` — the read-then-write shape AGENTS.md
  prohibits was not found. E7 remains about invariants spanning *two* refs,
  which is a different problem.

## What to refuse

**`Brand` / `Newtype` for ids.** `internal/ids.ts` uses `Schema.brand` with
namespaced brands and documents why: the ids carry a codec and a validator, not
only a compile-time tag, and anything serialising a session decodes through
them. That is better than either alternative. Leave it.

**`Match` beyond its current three uses.** `AgentEvent.match` is deliberately
hand-rolled for exhaustive dispatch with narrowed payloads, and STATUS.md
justifies it. There is no problem here.

**`Trie`, `BigDecimal`, `Differ`, `HKT`, `Unify`, `Channel`/`Sink` directly.**
No use in this domain. A module being unused is not a defect.

**`unstable/reactivity`** in the TUI — see E6.

## Invariants this audit imposes on the work it recommends

**A1 — Adoption must delete code.** Each item lands only if it removes a
hand-rolled equivalent or a documented limitation. Adding an ecosystem module
alongside the thing it was meant to replace is a net loss.

**A2 — No adoption changes the kernel vocabulary.** Every item here is a
capability, policy, interpreter or adapter — the same bar as any other package
(issue #4). `ExecutionPlan` arrives as a combinator, not a parameter.

**A3 — Every "check whether X fits" ends in writing.** E2, E5 and E9 are
evaluations. Each closes with a recorded answer in its plan, including a "no,
because" — an unanswered evaluation is worse than an unasked one, because it
looks decided.

**A4 — Portability holds.** `npm run lint:portability` still passes after each
item; the point of E9 and E10 is to widen it, never to narrow it.

## Milestones

Ordered by value over cost, not by group. Round two reordered this list: E15 is
a bug in shipped behaviour and E14 blocks a milestone in another plan, so both
outrank most of round one.

- **A-0 — One telemetry vocabulary (E15). ✅ Done.**
  `src/internal/telemetry.ts` owns `attributeNames` and the `annotate*` helpers;
  `/observability` re-exports it unchanged as public API; `AgentSession`,
  `AgentSubmission`, `AgentRun`, `AgentTurn` and `ToolExecution` annotate through
  it, and every kernel span now carries `agent.session.id`. Asserted and
  falsified in `test/Tracing.test.ts`; `examples/tracing.ts` updated, since it
  documented the old keys. Typecheck, 0 Effect diagnostics, 829 tests green.
- **A-13 — A redacting tracer layer (E20). ✅ Done.**
  `Observability.redactingTracer` wraps whichever tracer is configured and drops
  `parameters` from `ToolExecution.tool` before export. The AGENTS.md rule is
  respected, not bent: no exporter is imported, no backend named, nothing about
  where spans go is decided, and it is opt-in -- a policy value, like
  `RedactionPolicy`. Two tests, falsified twice.
- **A-1 — `Tx*` for the lock registry (E7). ✅ Done.**
  `CodingToolkit`'s registry is now a `TxRef<HashMap<string, LockEntry>>` with a
  holder count, evicting on the last release inside one commit. Three new tests,
  falsified twice. Closes a leak the code documented as unfixable, and satisfies
  [plan-pi-toolkit.md](./plan-pi-toolkit.md) P1's cleanup half — P1's remaining
  work is canonical-path keying, which needs a sandbox seam and is unrelated.
  **The `AgentState` half was withdrawn**: STM retries, so a critical section
  containing a store write cannot be a transaction (E7b).
- **A-1b — Triage the 58 `orDie` sites (E14). ◑ `DurableSessionStore` done.**
  `StorageError` introduced; the store interface now declares it; the client
  folds it into `AgentTransportError` so `RemoteError` and the wire are
  unchanged; `isInfrastructure`'s defect-sniffing replaced with a typed check.
  7 tests, falsified twice. `DeliveryLog` followed: `append`/`live`/`read`
  declare it, and the client's event stream fails rather than dying, so a
  consumer can reconnect from its last sequence (D5).
  `DurableChannels` and `state/AgentState` completed it. **H4 is unblocked
  across every store.** `StorageError` now lives in `Errors.ts`, since it was
  never durability-specific. The open half is `AgentEntity`'s Rpc error schema:
  widening it is a wire change and belongs with whoever owns the protocol.
- **A-2 — Metrics in `/observability` (E8, E17). ✅ Done.** Five instruments
  over the event stream the package already consumes -- turns, turns-per-run,
  tool calls by tool and outcome, tool duration, pending input -- exported so
  nothing has to restate a description to read one. Tokens dropped from the
  original list: no event carries usage, so that instrument would have to be
  invented rather than observed.
- **A-3 — `ExecutionPlan` combinator (E1). ◑ Planned.**
  [plan-execution-plan.md](./plan-execution-plan.md) written: the combinator
  shape, the model-call-only scope and why, the streaming problem and three
  options for it, the `/durable` replay interaction, five invariants and P0's
  two open questions (can `LanguageModel` be discharged without a cast; which
  streaming policy). Corrects this finding's `/budget` claim. No code yet.
- **A-4 — `LayerMap` / `RcMap` in the server and the tree (E4).** Folded into
  [plan-agent-server.md](./plan-agent-server.md) S2 and
  [plan-session-tree.md](./plan-session-tree.md) T3.
- **A-5 — The three evaluations (E2, E5, E9).** Recorded in their plans before
  the milestones that depend on them.
- **A-6 — `PartitionedSemaphore` strategy (E11)** and **`Cache` where the cost
  is real (E12).**
- **A-7 — Un-flag `/connectors/slack` (E10). ✅ Done.** Not with `effect/Crypto`,
  which has neither HMAC nor a constant-time compare: with Web Crypto's
  `subtle.verify`, which does the comparison natively and is therefore both more
  portable *and* a better guarantee than the `timingSafeEqual` it replaces.
  `HOST_MODULES` is one entry shorter, which is the proof.
- **A-8 — `Config` and `Redacted` sweep (E13, E16)**, alongside the server and
  CLI, starting with the five hard-coded poll intervals that are policy today.
- **A-9 — `unstable/cli` (E6).** The named roadmap gap, once the tree exists to
  drive it.
- **A-10 — Backoff and jitter on retry schedules (E16). ✅ Done.**
  `internal/schedules.ts` supplies `steady` (jittered, for count-bounded
  retries against shared infrastructure) and `backoff` (capped exponential, for
  polls). Fixes an unbounded 10ms poll that cost millions of queries a day for
  a submission parked on a human. Three tests, falsified twice — one of which
  caught that `jittered` can *exceed* its base delay, so a cap applied before
  it is not a cap. The intervals are still literals; making them `Config` is
  A-8.
- **A-11 — Close the cast-inventory drift (E18). ✅ Done.**
  `test/Casts.test.ts` counts erasing casts per file from the AST and fails when
  the set changes; AGENTS.md gained the two missing kinds and the
  erasing-vs-narrowing distinction. Falsified by adding a cast.
- **A-12 — State each unbounded queue's policy (E19).** Documentation, plus a
  bound wherever the writing shows one belongs.

## Success conditions

- **AS1 ✅:** `CodingToolkit`'s lock registry returns to empty after edits drain,
  with no window in which a held lock can be dropped — the test the old comment
  said could not be written. *Met: three tests in `test/CodingToolkit.test.ts`,
  falsified by removing the eviction and by dropping `acquireUseRelease`.*
- **AS2 ✅:** `/observability` exposes turn, run-depth, tool-outcome,
  tool-latency and queue-depth instruments, asserted from a scripted session
  (`test/Observability.test.ts`). *Token instruments are excluded by decision,
  not omission -- the event stream carries no usage.*
- **AS3:** An agent falls back from a failing model to a second one without the
  `Agent` naming either, and `Agent.make` still carries nine type parameters.
- **AS4:** Mounting and unmounting N agents leaves no live sessions and no live
  layers, asserted by count.
- **AS5:** E2, E5 and E9 each have a recorded decision with a reason.
- **AS6:** `npm run check` and `npm run lint:portability` unchanged in status.
- **AS7 ✅:** A trace exported from a real run can be joined to the events
  `/observability` emits for the same run **by attribute key**, with no
  translation table — and a session id filter selects spans below the host
  boundary (E15). *Met: `test/Tracing.test.ts`, "spans and events share one
  attribute vocabulary".*
- **AS11:** With `metadataOnly`, no tool parameter reaches an exporter through
  either channel (E20). *Not met — currently documented rather than enforced.*
- **AS8 ◑:** Under H4's fault injection, a failed store write, a duplicated
  record and a corrupt stored history are **three distinguishable observations**
  at the caller, not three defects (E14, D7). *Met across all four stores
  (`test/StorageError.test.ts`, 8 tests).*
- **AS9 ✅:** Adding an *erasing* cast anywhere in `src/` fails the build until
  AGENTS.md records it — falsified by adding one to `AgentLoop.ts` and watching
  the suite name that file (E18). *Plain narrowings are deliberately out of
  scope; see the finding for why.*
- **AS10:** Every retry interval in `src/` is either derived from `Config` or
  documented at its site as deliberately fixed, and no retry against shared
  infrastructure is un-jittered (E16).

## Non-goals

Adopting a module because it exists. A "use more Effect" sweep across files that
have no problem. Replacing `Schema.brand` ids, `AgentEvent.match`, or any other
place where the hand-rolled version was chosen for a documented reason. Any
change to the kernel vocabulary.
