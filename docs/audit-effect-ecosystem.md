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
`Agent` never names a provider. `ExecutionPlan` is the ecosystem's answer to the
question immediately after that one: **which** model, with what retry schedule,
falling back to what when the first is rate-limited or down. Today every user of
this kernel who wants provider failover writes it themselves, and `/budget` has
no principled seam on which to hang "this run has spent enough — step down to a
cheaper model."

It fits the combinator rule exactly (AGENTS.md §42.1): `withExecutionPlan(plan)`
unions its own `E`/`R` onto the definition and `Agent.make` grows no tenth type
parameter.

This deserves its own plan. It is not a refinement of an existing one.

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
attributes carefully and ships essentially no counters or histograms, yet the
four dashboards every agent runtime needs are all derivable from the event
stream it already consumes: turns per run, tokens in/out, tool latency and
failure rate by tool name, and steering/follow-up queue depth.

Small surface, no new API shape, fits inside the existing package.

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

### E10. `Crypto` — closes a flagged entry on our own roadmap

`connectors/slack.ts` uses `node:crypto`'s `createHmac` and `timingSafeEqual`
and is host-flagged in its own entry point for it. ROADMAP names "a real
crypto-backed Slack signature verifier as a host-flagged sub-entry" as remaining
work. Effect's `Crypto` removes the flag and the sub-entry.

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

**Still to do:** `DurableChannels` (8 sites), `DeliveryLog` (7) and
`state/AgentState` (5). The pattern is now established and each is independent;
`DeliveryLog` matters most, because D5 and D6 are claims about it.

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

Measured: **16 cast sites**, distributed as

| File | Sites | On the list? |
|---|---|---|
| `Agent.ts` | 4 (2 `as any` at 391–392, 2 `as unknown as`) | yes — `mergeHandled`, `definition`, `Toolkit.empty` |
| `durable/DurableModel.ts` | 5 | **no** |
| `durable/DurableToolkit.ts` | 3 | **no** |
| `testing/TestLanguageModel.ts` | 4 | **no** |

The twelve unlisted ones are all in library code, so **the user-facing rule is
not violated** — nothing here means a caller needs a cast, and that is the rule
that matters most. But they are a third and fourth *kind* (wrapping a
`LanguageModel.Service` whose method types are closed; widening an error channel
to `unknown` to cross an `Activity` boundary, `DurableModel.ts:129`), and the
enumeration that was supposed to make adding one deliberate has silently stopped
being an enumeration.

Two things to do, both cheap:

1. **Add the missing kinds to AGENTS.md**, or review them and remove what does
   not earn its place. The list is only useful if it is complete.
2. **Make drift a build failure.** The tools port already established this
   technique: `test/CodingPrompts.test.ts` rejects any number in a description
   that no constant holds. The same shape works here — a test that enumerates
   cast sites per file and fails when the set changes, so adding one forces the
   AGENTS.md edit rather than merely inviting it. That converts a convention
   into an invariant, which is the standard the rest of the repository is held
   to.

### E20. `/observability`'s content promise does not cover the span tree

Found while fixing E15, and the most serious finding in the audit — it is a
privacy issue, not an ergonomics one.

`/observability` opens with a promise: *"**Content is opt-in.** By default only
metadata is recorded — ids, event names, tool names. Prompts, tool parameters,
tool results and model output are omitted unless a `RedactionPolicy` turns them
on... Telemetry should not become a PII/secret leak."*

That promise is kept — for the event stream this package maps. It does not, and
structurally cannot, cover the other channel. Effect AI's `Toolkit.handle`
annotates the **current span**:

```ts
// effect/unstable/ai/Toolkit.ts:276
yield* Effect.annotateCurrentSpan({ tool: name, parameters: params })
```

and the current span at that point is the harness's own `ToolExecution.tool`,
because `handle` is `Effect.fnUntraced` and opens none of its own. So **any
application that wires a tracer exports every tool call's raw parameters**,
whatever `RedactionPolicy` it set. `metadataOnly` — the default, chosen to be
safe — does not prevent it.

Nothing here is upstream's bug: annotating the tool call is reasonable, and
`Toolkit` makes no redaction promise. The defect is ours, in that we make a
promise broad enough to be read as covering both channels while owning only one.

Three honest options, and the first is already done:

1. **Say so.** `Observability.ts` now states the limit at the point the promise
   is made, and `examples/tracing.ts` repeats it where a tracer is actually
   wired. Cheapest, and it stops the promise being misleading — but it leaves
   the leak.
2. **Scrub in a tracer layer.** A `Layer` that wraps the configured tracer and
   drops or redacts `parameters` on spans named `ToolExecution.tool`. This
   genuinely closes it, applies to any exporter, and is the kind of thing this
   package is for — but it means `/observability` starts owning tracer wiring,
   which AGENTS.md's *"tracing export is application wiring, never a harness
   dependency"* argues against. Worth the argument.
3. **Open our own span for the handler** so upstream's annotation lands on a
   span we control and can strip. More invasive, changes the trace shape, and
   trades a leak for a structural change users would notice.

**Recommend 1 now (done) and 2 as A-13**, with the AGENTS.md tension resolved
explicitly: a redacting tracer layer the application *opts into* is not a
harness dependency on an exporter, it is a policy value — the same shape as
`RedactionPolicy` itself.

A test pins the current behaviour either way: `test/Tracing.test.ts` asserts
`tool.attributes["tool"] === "echo"`, so if upstream stops annotating our span,
we find out from a failing test rather than from a silently narrower trace.

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
- **A-13 — A redacting tracer layer (E20).** The follow-on that fix surfaced,
  and the one with a real user impact: tool parameters reach any configured
  exporter regardless of `RedactionPolicy`. Documented as a limit for now;
  closing it needs the AGENTS.md argument settled first.
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
  5 tests, falsified. **Remaining:** `DurableChannels` (8), `DeliveryLog` (7),
  `state/AgentState` (5) -- `DeliveryLog` first, since D5/D6 are claims about
  it. Unblocks [plan-durability-hardening.md](./plan-durability-hardening.md)
  H4 for the session store.
- **A-2 — Metrics in `/observability` (E8, E17).** Four instruments over the
  event stream the package already consumes, following the
  `agent_data_dropped_events` counter as the template.
- **A-3 — `ExecutionPlan` combinator (E1).** Needs its own plan; the largest
  capability gap.
- **A-4 — `LayerMap` / `RcMap` in the server and the tree (E4).** Folded into
  [plan-agent-server.md](./plan-agent-server.md) S2 and
  [plan-session-tree.md](./plan-session-tree.md) T3.
- **A-5 — The three evaluations (E2, E5, E9).** Recorded in their plans before
  the milestones that depend on them.
- **A-6 — `PartitionedSemaphore` strategy (E11)** and **`Cache` where the cost
  is real (E12).**
- **A-7 — `Crypto` in `/connectors/slack` (E10)**, un-flagging the entry.
- **A-8 — `Config` and `Redacted` sweep (E13, E16)**, alongside the server and
  CLI, starting with the five hard-coded poll intervals that are policy today.
- **A-9 — `unstable/cli` (E6).** The named roadmap gap, once the tree exists to
  drive it.
- **A-10 — Backoff and jitter on retry schedules (E16).**
  `Schedule.exponential(...).pipe(jittered)` where fixed spacing retries shared
  infrastructure. Pairs with A-8; the interval becomes a floor rather than the
  whole policy.
- **A-11 — Close the cast-inventory drift (E18).** Add the two missing kinds to
  AGENTS.md, then a test that fails when the cast set changes — the
  `CodingPrompts` technique, applied to a convention that has stopped being
  enforced.
- **A-12 — State each unbounded queue's policy (E19).** Documentation, plus a
  bound wherever the writing shows one belongs.

## Success conditions

- **AS1 ✅:** `CodingToolkit`'s lock registry returns to empty after edits drain,
  with no window in which a held lock can be dropped — the test the old comment
  said could not be written. *Met: three tests in `test/CodingToolkit.test.ts`,
  falsified by removing the eviction and by dropping `acquireUseRelease`.*
- **AS2:** `/observability` exposes turn, token, tool-latency and queue-depth
  instruments, asserted from a scripted session.
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
  at the caller, not three defects (E14, D7). *Met for
  `DurableSessionStore` (`test/StorageError.test.ts`); the other three stores
  still answer every fault with a defect.*
- **AS9:** Adding a cast anywhere in `src/` fails the build until AGENTS.md
  records it — falsified by adding one and watching it fail (E18).
- **AS10:** Every retry interval in `src/` is either derived from `Config` or
  documented at its site as deliberately fixed, and no retry against shared
  infrastructure is un-jittered (E16).

## Non-goals

Adopting a module because it exists. A "use more Effect" sweep across files that
have no problem. Replacing `Schema.brand` ids, `AgentEvent.match`, or any other
place where the hand-rolled version was chosen for a documented reason. Any
change to the kernel vocabulary.
