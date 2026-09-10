# Plan: tool exposure, terminal work, and failure routes — lessons from `effect-agent`, 2026-09-08..10

**Status: proposal, nothing started.** Written 2026-09-10 from a read of
`danieljvdm/effect-agent` PRs #395, #397, #401, #405, #407, #413, #417–#419,
#421, #423 and #424 (merged 2026-09-08..10). **Part II** (§15–§24), added
the same day, folds in a deeper pass over #376, #378, #379, #380, #387,
#389 and #391 — durability and correctness rather than features — each
checked against this tree by a read-only audit before it was written.

**Tracked as [remaining-work.md](./remaining-work.md) items 91–112**
(E1–E10 are 91–102, E11–E20 are 103–112). When an item lands, update this
plan's section and move its entry, `verify:` lines flipped to pin the work
as done, into [remaining-work-closed.md](./remaining-work-closed.md). The earlier read of that
project's documentation ([plan-effect-agent-comparison.md](./plan-effect-agent-comparison.md),
2026-09-01) and of #335 ([plan-context-lessons.md](./plan-context-lessons.md))
are the predecessors; three things that plan's successor
([plan-run-stream-start.md](./plan-run-stream-start.md)) took from his docs —
`start`, bounded progress, structured exhaustion — have already landed here.

This plan is the actionable half: each item names the gap, the seam it lands
on, its todos, its invariants and its acceptance tests. The governing rule is
unchanged: **a package adds a capability, policy, interpreter, or adapter —
never a parallel execution model.** Every item is checked against it.

## 0. The pattern behind the PRs

The recent work treats five things as distinct layers:

1. **what the model sees** (exposure),
2. **what is authorized** (visibility and per-call permission),
3. **what actually executed** (application vs provider vs never started),
4. **what durably happened** (persisted vs accepted vs settled),
5. **what the caller can safely conclude** (outcome and failure route).

Affe already separates 3–5 around history, events and durability. The work
below extends the same discipline to **tool exposure** (1–2) and to
**terminal and action semantics** (3, 5), where the other project has gone
further. `effect-uai` pushed in the same direction from the other side
(model-visible capability ≠ locally executable action), so this is the second
independent source for it.

## 1. What the code says today (verified 2026-09-10)

Claims in the source read, checked against this tree before writing, so the
todos start from the right place:

| claim | what is actually here | consequence |
| --- | --- | --- |
| "we already have catalog/search machinery" | `src/code/Catalog.ts`: `catalog()` places signatures round-robin under a token budget and reports `complete`; `search()` is deterministic, field-weighted, paged (`next.offset`), no model call. Keyed on Code Mode's `ToolGroup` namespaces, not on a toolkit. | Reusable as the ranking/rendering core; needs a toolkit-level (not namespace-level) entry point. |
| "hidden tools shouldn't reach discovery" | **There is no pre-model visibility stage.** `Permission` decides per call (`ToolExecution.ts`), after the model has seen every schema. The only exposure control is `AgentTurn.resolveToolkit`'s all-or-nothing `withholdTools` for a `Final` turn. | Visibility is a *new* stage, not a filter over an existing one (§3, T1). |
| "our output tool is an ordinary injected tool; two calls race" | True: `AgentTurn.ts` `outputToolkit` stages into `session.pendingOutput`; its doc says the last *finisher* wins, deliberately. | §5. |
| "stronger than our `ToolExecution.Alone`" | `Alone` exists (`ToolExecution.ts:915`), is applied to compaction's `new_context` only, and refuses **only the `Alone` call** — its siblings run. The output tool is **not** annotated `Alone`. | Today `create_invoice + submit_final_answer` runs `create_invoice` and records the answer. §5 fixes this. |
| "don't count `toolCalls.length`" | Already right by construction: `AgentTurn.ts:454` filters `providerExecuted` calls out before `ToolExecution.execute`, so `Alone`'s `calls.length < 2` counts application calls only. | #419's lesson is satisfied *incidentally*. Pin it with a test so it stays true (§5, T5.6). |
| "`returnedToModel: boolean`" | `AgentEvent.ts:433`; set at `ToolExecution.ts:547, 763, 799, 947`. Consumed by AG-UI, `SessionProjection` (counts it), `SessionDirectory`, the client conformance suite. | Widening it is a wire change across five consumers (§6). |
| "Effect AI `Tool.failureMode` vs our policy" | `/tool-source` pins discovered tools to `failureMode: "error"` (`ToolSource.ts:124`). Hand-written tools may set `"return"`, in which case a handler failure arrives as a success value with `isFailure` and is committed as `returnedToModel: true` **regardless of `toolFailurePolicy`** (`ToolExecution.ts:788–800`). | The two notions can disagree today, silently (§6, T6.1). |
| "`Agent.describe()`" | `Agent.ts:365`: tools are `{ name, description }` only; policies are agent-level. | Extend it (§6, T6.4); no second inspection API. |
| "Code Mode outcomes are succeeded/failed/refused" | `CodeMode.ts:121`, `CodeTool.ts:32`. `limits.maxConcurrentCalls` exists (`CodeMode.ts:85`). Owned interpreter never suspends; suspending executors persist state. | §7. |

## 2. Ranking

| # | item | priority | seam | size | section |
| --- | --- | --- | --- | --- | --- |
| E1 | Exclusive-batch preflight for terminal tools | P0 | `ToolExecution` annotation | S | §5 |
| E2 | Completion from ordinary tool results | P0 | `AgentOutput` | M | §4 |
| E3 | Visibility stage + progressive exposure + discovery | P0 | new `ToolExposure`, `Catalog` | L | §3 |
| E4 | Failure disposition in events and `describe` | P1 | `AgentEvent`, `Agent.describe` | M | §6 |
| E5 | Delivery acknowledgement vocabulary + audit | P1 | per battery | M | §8 |
| E6 | Code Mode `uncertain` / `not-started` | P1 | `/code` | M | §7 |
| E7 | Budget topology, stated per battery | P1 | docs + `Budget` | S–M | §9 |
| E8 | Matched release→main benchmark suite | P2 | `bench/` | M | §10 |
| E9 | Cache stability as a `ContextTransform` concern | P2 | docs + a probe | S | §11 |
| E10 | Cloudflare AI Gateway | P3 | `/cloudflare` | S | §12 |

Part II adds:

| # | item | priority | seam | size | section |
| --- | --- | --- | --- | --- | --- |
| E11 | Exact model response across recovery (streaming drops metadata) | P0 | `streamAccumulator`, `DurableModel` | S–M | §15 |
| E12 | Crash/no-crash canonical equivalence oracle (incl. declaration order) | P0 | `testing/`, failpoints | M | §16 |
| E13 | Host scheduling, captured per durable attempt | P0 | new `ToolScheduling`, `DurableSubmission` | M | §17 |
| E14 | Long-lifetime continuity evaluation | P0 | `evals`, `bench/` tier | M–L | §18 |
| E15 | Durable tool contracts are versioned | P1 | `DurableSubmission` payload | M | §19 |
| E16 | Checkpoints as disposable caches | P1 | `Compaction`, docs | S–M | §20 |
| E17 | Cursors, and incomplete ≠ empty | P1 | `Catalog`, `Memory`, `search_context` | S–M | §21 |
| E18 | Operational defaults audit | P1 | hosts, `Agent` | S–M | §22 |
| E19 | Reservation-time admission limits | P2 | `/scheduling`, `/subagent` | M | §23 |
| E20 | Recovery snapshots (O(suffix) cold recovery) | P3 | `/durable` | L | §24 |

**The near-term priorities are five:** progressive exposure (E3), terminal
completion with whole-batch preflight (E1+E2), exact-response recovery with
the equivalence oracle (E11+E12), host scheduling and authority capture
across attempts (E13), and a real continuity evaluation (E14). The first two
are features; the other three make Affe hard to break in production.

**Order of work differs from priority.** E1 first: it is small, closes a
real side-effect hazard in shipped code, and E2 depends on its
classification. E11 alongside it: it is a live fidelity bug with a
contained fix. Then E12's oracle, because every later durability item
(E13, E15, E16) wants it as its acceptance test. E2 next (one design
problem with E1: *what is terminal work?*). E3 after — the largest and the
most valuable, but it needs E8's harness to be judged (§3.7), so start E8's
skeleton alongside it. E14's deterministic tier can start any time; its
live tier waits on E8's reporting.

---

## 3. E3 — Progressive tool exposure and discovery

### 3.1 The layers

```text
registered           everything the toolkit / tool sources can resolve
  ↓ visibility        tenant, principal, delegation grant — static per run
eligible
  ↓ exposure          pinned ∪ selected ∪ mandatory, under byte/count caps
exposed               the schemas on this model request
  ↓ model
  ↓ Permission        per call, unchanged
  ↓ handler
```

**Discovery changes exposure, never authority.** It searches `eligible`,
never `registered`.

### 3.2 Surface (sketch; names open)

```ts
Agent.make({
  toolkit,
  toolVisibility: ToolVisibility.fromPermission(permission) // or .grant([...]) / custom
  toolExposure: ToolExposure.progressive({
    pinned: ["read_file"],
    maxTools: 16,
    maxSchemaBytes: 64 * 1024,
    discovery: ToolDiscovery.make({ maxResults: 8, maxResultBytes: 32 * 1024 })
  })
})
```

`ToolExposure.eager` is the default and is today's behaviour exactly.

### 3.3 Invariants

* **I3.1 Authority is monotone under exposure.** For every run, the set of
  calls that can reach a handler under `progressive` is a subset of those
  under `eager` with the same visibility and `Permission`. Pinning a tool that
  visibility hides does not expose it (#407).
* **I3.2 Hidden means absent.** A tool outside `eligible` contributes nothing
  to any model request or discovery result: not its schema, name,
  description, or a count that includes it. (The `Catalog` header's
  "N of M shown" must count `eligible`, not `registered`.)
* **I3.3 Exposure changes only at a batch boundary.** A selection made by a
  discovery call takes effect on the *next* model request, after the whole
  current tool batch has committed. No mid-batch toolkit mutation.
* **I3.4 Selection replaces.** The selected set is bounded by `maxTools` and
  a new selection replaces the previous one (pinned and mandatory are always
  kept); it does not accumulate across the run.
* **I3.5 Selection is canonical state.** It is derived from committed
  history (the discovery call's result), so replay, `/durable` recovery,
  branching and `Export`/`Replay` reconstruct it without re-running
  discovery. No side-channel `Ref` that a restore could miss.
* **I3.6 Mandatory tools fail closed.** A protocol tool (the `AgentOutput`
  tool, `new_context`) is always exposed when the protocol needs it; if
  visibility would hide it, agent construction (or the first turn, for a
  per-turn toolkit) fails with a typed error — it does not silently drop.
* **I3.7 Exposed ≠ callable, and the model is told.** A call to a tool that
  is eligible but not currently exposed is refused with a typed, model-visible
  `ToolNotExposedError` naming discovery — not executed, not a defect.
  (Providers occasionally hallucinate names they saw earlier.)
* **I3.8 Bounded.** Discovery results respect `maxResults` and
  `maxResultBytes`; the exposed set respects `maxTools` and `maxSchemaBytes`.
  A single tool whose schema alone exceeds `maxSchemaBytes` is reported, not
  truncated into an invalid schema.
* **I3.9 Deterministic.** Same eligible set + same query → same results and
  same order (inherits `Catalog.search`'s tie-break by path).
* **I3.10 No cast at the call site.** The agent's `Tools` type stays the full
  registered record; exposure is a runtime subset. Handlers and `Permission`
  rules stay typed over the full record.

### 3.4 Todos

* **T3.1 Visibility stage.** Introduce `ToolVisibility` resolved once per run
  from the principal/delegation context: `all`, `grant(names)`,
  `fromPermission` (derive "unconditionally denied for this principal" from
  `Permission.describe` where the rules make that decidable; otherwise the
  tool stays eligible and per-call `Permission` still governs). Subagent
  delegation grants narrow it. Decide whether visibility belongs on `Agent`
  or on the session (principal is per session). *Open question Q1.*
* **T3.2 Toolkit-level catalog.** Lift `Catalog.entries/catalog/search` from
  `ToolGroup` namespaces to any `Record<string, Tool.Any>`; keep the Code
  Mode entry point as a thin wrapper so `/code` is unchanged. Tool-source
  mounts supply the namespace (`github/`, `notion/`…) so 300 tools rank by
  source as well as name. Byte-size in addition to the existing token
  estimate.
* **T3.3 Exposure in `resolveToolkit`.** `AgentTurn.resolveToolkit` already
  builds each turn's toolkit (and withholds for `Final`); exposure becomes a
  second input there. One code path: `Final` withholding is exposure = ∅ ∪
  mandatory.
* **T3.4 `discover_tools` battery.** A tool whose handler searches `eligible`
  and returns bounded docs (signature, description, namespace) plus the
  selection it will apply. Annotated so it is always exposed when
  `progressive` is on. Result schema is the canonical record for I3.5.
* **T3.5 Selection replay.** Derive the current selection by folding
  committed discovery results in history (last one wins, pinned ∪ mandatory
  always). Test under `/durable` replay and under `SessionTree` branching.
* **T3.6 `ToolNotExposedError`** (I3.7), added to
  `test/fixtures/error-tags-manifest.json`.
* **T3.7 `/tool-source` composition.** Mount several sources (MCP, OpenAPI),
  confirm eligibility filtering happens before the catalog is built, and that
  a source added mid-session (dynamic toolkit) enters `eligible` without
  entering `exposed` unless pinned.
* **T3.8 Describe.** `Agent.describe()` reports exposure mode, pinned,
  bounds; for a declared toolkit, the eligible count.
* **T3.9 Events.** A `ToolExposureChanged { exposed: names, reason }` event
  at the batch boundary, so a UI and a trace can show why a tool appeared.
* **T3.10 Docs.** `guide-batteries.md` section; `limits.md` rows for the four
  bounds.

### 3.5 Acceptance

* **A3.1** 310 registered tools across five mounted sources, 8 exposed: the
  first model request's tool list has exactly `pinned ∪ discover_tools ∪
  mandatory`, and its serialized size is under `maxSchemaBytes`. Asserted on
  the request the `TestLanguageModel` received, not on internal state.
* **A3.2** A tool hidden by visibility and also listed in `pinned`: absent
  from every request, absent from every discovery result, absent from the
  catalog counts (I3.1, I3.2). Mutation check: remove the visibility filter
  from discovery → test fails.
* **A3.3** Discovery in turn *n* selects `stripe/create_refund`; turn *n*'s
  sibling calls cannot call it (I3.3); turn *n+1*'s request includes it.
* **A3.4** A model call to an eligible-but-unexposed tool gets
  `ToolNotExposedError`, the handler's call count stays 0.
* **A3.5** Kill and recover a `/durable` run after a discovery turn: the
  recovered run's next request has the same exposed set, and
  `discover_tools`' handler ran once total (I3.5).
* **A3.6** Visibility hides the output tool → typed construction failure
  (I3.6), not a run that can never finish.
* **A3.7** Type-level: a `Permission` rule and a handler for a non-pinned
  tool typecheck with no annotation; `expectTypeOf` on the agent's tool
  record shows all 310 names (I3.10).
* **A3.8** Benchmarked per §10 (eager 100 vs 10 pinned + discovery) before
  the guide recommends it. The guide states the result either way.

### 3.6 Deliberately not

* No embeddings or model-backed ranking in discovery; `Catalog.search`'s
  deterministic scoring is the default and a custom ranker is an option.
* No accumulation mode.
* No change to `Permission`'s semantics.

### 3.7 The cost caveat

Progressive exposure is **not automatically a win**: one extra discovery turn
plus a tool list that changes between requests (which can invalidate provider
prompt caches — §11) may cost more than an eager toolkit. The acceptance bar
is §10's measurements, not prompt-token count.

---

## 4. E2 — Completion from an ordinary tool result

### 4.1 Shape

```ts
AgentOutput.make(Output).pipe(
  AgentOutput.fromTool(CreateProject, ({ params, result }) =>
    result.created ? Option.some({ projectId: result.id, url: result.href }) : Option.none()
  )
)
```

The model-called output tool remains the general case. `fromTool` adds a
second way to finish: a successful, committed result of a named tool is
projected by a **pure** function; `Some(value)` completes the submission with
that value, `None` continues the run.

### 4.2 Invariants

* **I4.1 Only committed success projects.** The projector sees a
  `ToolCallSucceeded` result after the turn commits — never a failed result,
  a `returnedToModel` failure, a refused call, or an in-flight value.
* **I4.2 Pure and total.** The projector is `(input) => Option<Output>`, no
  Effect, no services. A throw is a defect that fails the run (not a silent
  `None`). Recovery re-evaluates it from stored params/result, so it must not
  read the clock or anything outside its argument.
* **I4.3 The value is the output schema's.** A projected value is validated
  against `AgentOutput`'s schema exactly as a model-submitted one is; a value
  that does not decode is a defect in the projector (the model cannot fix
  it), reported as such.
* **I4.4 Precedence is fixed and documented.** If one committed batch yields
  both a projected completion and a model-submitted output (or two
  projections), the rule is deterministic by response order — *and* E1 should
  make it unreachable for the model-submitted case (the output tool is
  exclusive). Two projecting tools in one batch: first in response order
  wins; state it.
* **I4.5 Replay-stable.** Under `/durable`, recovery reaches the same output
  without a model call and without re-running the tool (the result is
  journalled).
* **I4.6 Typed end to end.** `fromTool(CreateProject, f)` infers `params`
  and `result` from `CreateProject`'s schemas and checks `f`'s return against
  `Output`. No annotations at the call site; a tool not in the agent's
  toolkit is a type error where decidable.

### 4.3 Todos

* **T4.1** `AgentOutput.fromTool` combinator; `AgentOutput` gains a list of
  projectors (data, so `describe` can list them).
* **T4.2** In `AgentTurn`, after commit and before the loop decides, apply
  projectors to the committed batch's successes in response order; set
  `pendingOutput` through the same path the output tool uses, so everything
  downstream (submission result, `Agent.start`, transports) is untouched.
* **T4.3** An event field or tag saying *how* the run completed
  (`completion: "output-tool" | "projected" { tool, callId }`) — a UI must be
  able to say "finished from `create_project`".
* **T4.4** `Agent.describe().output` lists projecting tool names.
* **T4.5** Guide section with the "create and give me the URL" example.

### 4.4 Acceptance

* **A4.1** Scripted model calls `create_project` once; the submission
  completes with the projected value and the model was called **once**
  (count requests).
* **A4.2** Projector returns `None` → run continues to a second model call.
* **A4.3** Tool fails under `ReturnToModel` → projector not invoked (spy),
  run continues.
* **A4.4** Projector throws → run fails with a defect naming the projector.
* **A4.5** `/durable` crash after the tool commits, before completion is
  observed → recovery completes with the same value, tool handler count 1,
  model request count 1.
* **A4.6** `expectTypeOf` on the projector's argument; a projector returning
  a field the output schema lacks is a compile error (break it once to
  confirm).

---

## 5. E1 — Exclusive batches for terminal tools

**Landed 2026-09-10 (item 91, ledger).** `Alone` was strengthened rather than
joined by a second annotation (Q2); siblings get `ToolBatchRejectedError`
(T5.3). One thing the plan did not foresee: the output stop rule fired on the
output call's *presence*, so a refused answer ended the run with no value. It
now stops on `AgentLoop.State.outputReported`, a committed value. T5.6's
provider-executed case is pinned by "a call the provider already executed is
not company" in `test/AgentOutput.test.ts`.

### 5.1 The defect

A response `create_invoice(...) + submit_final_answer(...)` today runs
`create_invoice` (a side effect) and records the answer, because the output
tool is not `Alone`; and even for `Alone` tools the siblings run. A terminal
tool is one whose meaning is "the model is done acting"; a sibling action in
the same breath is a protocol violation the model should correct *before*
anything happens.

### 5.2 Semantics

`ToolExecution.Exclusive` (annotation; name open — `ExclusiveBatch`):

```text
response complete
→ drop providerExecuted calls (already settled; cannot be undone)
→ application calls = the rest
→ if any application call is Exclusive and application calls > 1:
     run NONE of them
     commit a failed result for EVERY application call
       (ToolBatchRejectedError: which exclusive tool, which siblings)
     count the attempt against turns / tool-call budgets
     let the model correct within the remaining budget
  else: execute normally
```

### 5.3 Invariants

* **I5.1 No sibling side effect.** When a batch is rejected, zero handlers
  start — not the exclusive one, not the siblings. Permission is not asked
  either (asking would be a side effect on the user).
* **I5.2 Provider-executed calls don't count** (#419). A settled
  provider-hosted search beside the output call is allowed; the rule counts
  executable application calls.
* **I5.3 Every call gets a result.** Rejected batches still commit one
  failed `ToolResultPart` per call, so history is well-formed for every
  provider.
* **I5.4 Budgeted.** A rejected batch is a turn and its calls count toward
  `maxToolCalls`; a model that loops on the violation exhausts normally
  (`onExhaustion`) rather than spinning.
* **I5.5 Policy-independent.** Returned to the model regardless of
  `toolFailurePolicy`/`toolDenialPolicy` (same reasoning as `Alone`: the
  model's own recoverable mistake).
* **I5.6 Durable.** The rejection is decided from the response alone, so
  replay re-derives it identically; nothing is journalled as an activity.

### 5.4 Todos

* **T5.1** Decide: new annotation, or strengthen `Alone` to reject the whole
  batch. Recommendation: **strengthen `Alone`**. Its only user is
  `new_context`, whose own doc says a sibling "would run and then have its
  result folded away with everything else, silently" — the current
  behaviour lets that sibling's side effect happen, which is exactly the
  hazard. One annotation, one meaning. Record in `status-history.md` as a
  behaviour change.
* **T5.2** Annotate the `AgentOutput` tool `Alone`. This also resolves the
  documented two-output-calls race in `AgentTurn.ts:137` (the batch is
  rejected, the model resubmits one answer); update that comment.
* **T5.3** `ToolBatchRejectedError` (or reuse/extend `ToolNotAloneError` with
  a `role: "exclusive" | "sibling"` field); error-tags manifest.
* **T5.4** Move the check ahead of `Permission` and ahead of `executePerTool`
  / `Effect.all` in `ToolExecution.execute`.
* **T5.5** Budget accounting for rejected calls (I5.4).
* **T5.6** Test that pins I5.2 via the existing `providerExecuted` filter in
  `AgentTurn.ts:454`, so a refactor that moves the filter cannot silently
  change the count.
* **T5.7** Interaction with E2: a projecting tool is *not* exclusive (it is an
  ordinary action); document why.

### 5.5 Acceptance

* **A5.1** `create_invoice + output` in one response: `create_invoice`
  handler count 0, output not recorded, two failed results committed, model
  called again, second response with only `output` completes.
* **A5.2** Same with `new_context` + a write: the write does not happen
  (behaviour change from today — the existing `Alone` test must be updated,
  and the diff says so).
* **A5.3** Provider-executed web search + output in one response: completes
  on the first response.
* **A5.4** A model that always emits the violating pair: the run ends by
  `onExhaustion`, not by hang, and the tool-call counter includes the
  rejected calls.
* **A5.5** `Permission` spy: not consulted for a rejected batch.
* **A5.6** Mutation: revert to per-call refusal → A5.1 fails.

---

## 6. E4 — Failure disposition

### 6.1 Design

Two questions, two fields:

* **configured** — how is this tool's failure path set up?
  (Effect AI `Tool.failureMode: "error" | "return"`, plus the agent's
  `toolFailurePolicy`/`toolDenialPolicy`). Answered by `describe`.
* **actual** — what happened to *this* failure at this boundary?
  `failureHandling: "returned-to-model" | "propagated" | "returned-to-program"`
  (the last for a nested Code Mode call, whose failure goes to the program,
  not the model). Answered by `ToolCallFailed`.

Keep per-agent policy as the architecture (it composes); do **not** adopt a
per-tool failure-policy system.

### 6.2 Todos

* **T6.1 Audit `failureMode: "return"` vs `toolFailurePolicy`.** Today a
  `"return"` tool's failure is committed as `returnedToModel: true` even
  under `FailRun` (`ToolExecution.ts:788–800`). Decide and document: either
  (a) `"return"` is the tool author's explicit statement and wins — then
  `describe` must show it per tool so the agent-level `FailRun` is not a lie;
  or (b) `FailRun` wins and `"return"` failures propagate. Recommendation:
  (a), made visible, because the tool author chose to make failure a value.
  Add a test either way; there is none for this interaction.
* **T6.2** Add `failureHandling` to `ToolCallFailed` alongside
  `returnedToModel`; derive `returnedToModel` from it for one release, then
  deprecate. Schema change: bump the event schema per the wire-freeze policy
  in [plan-two-decisions.md](./plan-two-decisions.md).
* **T6.3** Update the five consumers: AG-UI, `SessionProjection` (count by
  handling), `SessionDirectory`, `AgentClientConformance`, `ToolExecution`'s
  own emit sites (four).
* **T6.4** Extend `Agent.describe().tools` entries with `failureMode`,
  `alone`/exclusive, `idempotent`, `providerExecuted`/`provider-defined`,
  source namespace. No `Agent.inspectTools()`.
* **T6.5** Nested Code Mode calls emit `"returned-to-program"`.

### 6.3 Invariants and acceptance

* **I6.1** For every `ToolCallFailed`, `failureHandling === "returned-to-model"`
  iff a failed `ToolResultPart` for that call id is committed to history.
  **A6.1**: a property test over the outcome matrix (policy × failureMode ×
  defect × engine-limit × denial) asserting I6.1 against committed history.
* **A6.2** `describe` on a `"return"` tool under `FailRun` shows both, and the
  run behaves as described (T6.1).
* **A6.3** Old consumers reading `returnedToModel` see unchanged values across
  the matrix.

---

## 7. E6 — Code Mode partial and uncertain outcomes

### 7.1 Design

Widen the observed call outcome:

```ts
type CallOutcome = "succeeded" | "failed" | "refused" | "uncertain" | "not-started"
```

* `uncertain` — the call started and the program was interrupted or the
  process died before its result was observed; its side effect may or may
  not have happened.
* `not-started` — the program ended (failure, interruption, limit) before
  this call's turn in a `Promise.all` or sequence.

### 7.2 Invariants

* **I7.1** Every nested call the program *issued* has exactly one outcome.
  A call in flight at interruption is `uncertain`, never `failed`.
* **I7.2** Under durable recovery, a program whose calls include any
  non-idempotent tool with an `uncertain` outcome is **not blindly re-run**.
  The owned interpreter (never suspends) reports the program as `uncertain`
  and returns that to the model; suspending executors resume from persisted
  state as today.
* **I7.3** `maxConcurrentCalls` bounds in-flight calls; the report
  distinguishes queued-then-cancelled (`not-started`) from started.

### 7.3 Todos and acceptance

* **T7.1** Outcome literal in `CodeMode.ts:121` and `CodeTool.ts:32`; the
  `observed` helper records `uncertain` from an interruption finalizer.
* **T7.2** Track issued-but-unstarted calls under the semaphore for
  `not-started`.
* **T7.3** Recovery rule I7.2 using `Tool.Idempotent`.
* **A7.1** `Promise.all([a, b, c, d])` with `maxConcurrentCalls: 2`, `c`
  hangs, program interrupted: report is `a, b` succeeded, `c` uncertain, `d`
  not-started.
* **A7.2** Durable crash mid-program with a non-idempotent write in flight:
  recovery does not re-issue the write (handler count 1), and the model sees
  `uncertain`.

---

## 8. E5 — Delivery acknowledgement vocabulary

### 8.1 Vocabulary

```text
Persisted        the exact request is durably retained
DeliveryPending  persisted; another attempt owns delivery; keep the same
                 idempotency key, do not launch replacement work
Accepted         the destination took it
Running          the destination started it
Settled          it finished (with its result)
```

Not one ADT everywhere — but **no API may return a generic success that a
caller could read as a stronger state than it is.**

### 8.2 Audit

Audited 2026-09-10. "Means" is what the code guarantees on success, not
what the name suggests.

| API | returns | success means | verdict |
| --- | --- | --- | --- |
| `Subagent.tool` (`src/subagent/Subagent.ts:241,491`) | `Answer<Value>` | **Settled**: the child runs inside the handler | fine. **There is no background subagent mode**, so the source's "subagent background calls" has nothing to audit yet; any future one must adopt §8.1 from day one. |
| `Scheduling.local` `dispatch` (`src/scheduling/Scheduling.ts:55–95`) | `Effect<void>` | **Forked** into the layer scope; nothing persisted; failures only logged | **ambiguous** — `void` reads as "scheduled". Document as "Running, not persisted"; a crash loses it. |
| `Scheduling.queued` `dispatch` → `JobStore.enqueue` (`:136–177`) | `Effect<void>` | **Persisted**; no receipt | **ambiguous, documented trade-off**: `claimDue` claims *and removes*, and its doc states at-most-once on purpose (`:129–134`) — a crash after the claim drops the job — and says an at-least-once store implements a visibility timeout behind the same interface. No such store ships, so the only durable option is at-most-once. A held lease would be exactly `DeliveryPending`. |
| `RelayClient.send` (`src/relay/RelayClient.ts:23`) | `Effect<void, …>` | **Offered to a live peer's in-memory queue** (`RelayServer.ts:223`); offline peers refused | fine by design ("live traffic is never queued", `Relay.ts:89`) but `void` should be documented as "handed to the peer's queue", not delivered or accepted. |
| `Connector.deliver` (`src/connectors/Connectors.ts:71–118`) | `RemoteResult` | **Settled and replied**; redelivery rejoins via request-id dedupe | fine. |
| `Connector.serverLayer` webhook (`:164–196`) | HTTP 200 | **Forked, not persisted**: answers 200 then forks `deliver`; failures only logged | **ambiguous, the worst row**: acking early is deliberate (platform webhook timeouts, `:157–172`), but the doc does not say that a crash between the 200 and the run loses the message, and the sender will not retry. Either persist before 200 (then 200 = Persisted, e.g. through `SessionInbox`) or state the loss window. |
| `SessionInbox.enqueue` / `deliver` (`src/sessions/SessionInbox.ts:131–259`) | `void` / `Delivered \| Undeliverable` | `enqueue` = **Persisted** (idempotent on `item.id`); `Delivered` = **Admitted** (not settled) | mostly fine. A busy session is a retried `SessionBusyError` that only surfaces after `maxAttempts`; that is `DeliveryPending` in all but name. Rename `Delivered` → `Accepted` or document it. |
| `RemoteSession.submit` (`src/client/AgentClient.ts:309–351`) | `SubmissionReceipt` | **Accepted** ("return at admission") | fine. |
| `DurableAgentClient.submit` (`src/durable/DurableAgentClient.ts:434–630`) | `SubmissionReceipt` | **Persisted claim + dispatched** as one uninterruptible step; same key rejoins; mismatched request → `AgentRequestConflictError` | closest to #413 already. One gap: a claim held by another attempt **with no or a different key** returns `Busy` → `AgentBusyError`, and the incumbent claim is dropped rather than surfaced. With the *same* key it rejoins correctly. `StorageError` from `claim` already means "unknown", not "did not happen" (`:177–185`) — keep that. |
| `SessionDirectory` | — | no submit path | n/a |

### 8.3 Todos and acceptance

* **T8.0** Decide the two rows that can lose work, before any renaming: the
  connector webhook's 200-before-persist (undocumented loss window), and
  `queued` scheduling's claim-and-remove (documented at-most-once, with no
  at-least-once store shipped). Filed as their own `remaining-work.md` items.
* **T8.1** For each row marked *ambiguous* above: rename or retype the
  success value to the strongest state it actually guarantees.
* **T8.2** Where a claim can be held by a concurrent attempt, return
  `DeliveryPending` (with the idempotency key) instead of success or a
  retryable error.
* **T8.3** `guide-durable.md` table: each API → the state its success means.
* **A8.1** For each audited API, a test that stops the destination after
  persistence and asserts the returned state is not `Accepted`.
* **A8.2** Two concurrent submits with one idempotency key: exactly one
  delivery, the other returns `DeliveryPending` (or the settled result), and
  neither launches a second destination run.

---

## 9. E7 — Budget topology

### 9.1 The question

For every model-like auxiliary: *does it consume the current run's budget, a
child budget, an application budget, or only report its usage?* The other
project's answer for a separately configured web-search model is "reported,
not charged"; native provider search in the primary request is charged
because it is part of that call.

### 9.2 Current state

Audited 2026-09-10. **How it counts:** `Budget.within` only checks
`spent >= limit` (`src/budget/Budget.ts:237`). Counting is `Budget.record`
(`:283`), called only by `RunLedger.record` (`src/RunLedger.ts:200`) once per
engine turn (`AgentRun.ts:119`), from the turn's `GenerateTextResponse`
tokens; cost only when `ModelCapabilities` prices the model; deduped by
`runId:turnIndex` so replay is charged once. **Anything that calls a model
outside an engine turn is invisible to it.**

| source | today | note |
| --- | --- | --- |
| primary model turns (incl. via `EffectUaiModel`) | **charged** | the only path that reaches `Budget.record` |
| provider-native tools in the primary request | **charged** | inside the turn's usage |
| subagents, `inherit.budget: true` (default) | **charged to the parent, not reserved** | the child shares the counter; the parent's ceiling is only checked after the delegating turn ends, so one delegation can overshoot by a whole child run. Documented as intended — "counted, not capped, within one delegation" (`Subagent.ts:113–125`) — with `Budget.within` in the child as the opt-in cap |
| subagents, `inherit.budget: false` | **untracked** | `Budget.fresh()` — documented as "a budget of its own that nobody reads" (`Subagent.ts:122`, `Budget.ts:154`); no usage surfaces anywhere |
| compaction summariser | **reported only** | `usage` on `SummaryResult` / `CompactionCompleted` (`Compaction.ts:810, 819`) |
| `BranchSummary`, `CodingSummary` | **reported only** | on the result (`src/tree/BranchSummary.ts:144`, `src/coding/CodingSummary.ts:140`) |
| auxiliary model calls through `EffectUaiModel` outside a turn | **untracked** | e.g. as a compaction model — reported only if the caller reports |
| memory extraction | n/a | a pure function; no model (`src/memory/Memory.ts:265`) |
| embeddings, reranking, search models | n/a | do not exist in `src` |
| `WebSearch` / Brave | n/a | HTTP, not a model; its "budget" is bytes/time |

So the source's list overstates what exists (no embeddings, reranking or
search model yet). The two sharp edges — **child overshoot** and
**`inherit.budget: false` leaving usage nowhere** — are documented choices,
not bugs; what is open is whether they are the right defaults.

### 9.3 Todos and acceptance

* **T9.0** Revisit the documented "counted, not capped" subagent default:
  either check the parent's remaining budget per child turn (the child sees
  the shared counter already — make the parent's `within` apply inside the
  child), or reserve a slice up front. A decision, not a bug fix. Acceptance:
  a parent at 90% of its limit delegating to a child that would spend 50%
  stops within one child turn of the limit, not after the child finishes.
* **T9.1** Decide the rule per row; write it in `limits.md` as one table.
  Any future model-backed battery (embeddings, reranking, a search model)
  must declare its row before it lands.
* **T9.2** Every auxiliary that is not charged still **reports** usage on an
  event with a `scope` (`"run" | "child" | "auxiliary"`), so nothing is
  untracked. Untracked rows are bugs.
* **T9.3** `Budget.within` documents which events it sums; a test per
  auxiliary asserts whether the parent's remaining budget moved.
* **A9.1** A run with compaction, memory extraction and a subagent: parent
  budget delta equals exactly the rows declared "charged" in the table.

---

## 10. E8 — Matched performance suite

Methodology to copy: **latest published release vs current `main`**, both
freshly built, same machine, same lockfile policy; median + IQR; raw samples
and exact build/lock identities kept; percentage deltas suppressed when the
compiled artifacts and lockfiles are identical; timings are observations, not
confidence intervals and not a merge gate.

* **T10.1** `bench/` with a runner that builds both refs into temp dirs and
  runs each scenario N times interleaved.
* **T10.2** Scenarios: one-turn run; stream 1 / 64 / 1024 chunks; large
  canonical history; 8 parallel tools; 4 tool rounds; `Agent.start` replay;
  eager vs progressive exposure (E3, with the §3.7 metrics: latency, model
  calls, input tokens, cache reads/writes, cost, success rate, tool-selection
  errors); durable settlement replay; `DeliveryLog` catch-up; SQLite
  contention; effect-uai native vs adapter-backed model.
* **T10.3** Report to `docs/reports/bench-<date>.json` + a markdown summary.
* **T10.4** Respect `vitest.config.ts`'s `maxWorkers` lesson: benchmarks run
  alone, and the report records machine load at start.
* **A10.1** Two runs of the same ref report "identical artifacts, no
  comparison" rather than a spurious delta.
* Informational only until variance is characterised (≥ 2 weeks of runs).

## 11. E9 — Prompt-cache stability

Affe's `ContextTransform` does not append changing run counters by default,
which is already the right default (#405). What is new is that E3 changes the
tool list between requests.

* **T11.1** `guide-sessions.md`: a "cache stability" note on
  `ContextTransform` — changing content after the last stable boundary
  defeats provider prefix caching.
* **T11.2** E3's exposed set is emitted in a stable order (pinned first, then
  selection by path) so an unchanged selection yields a byte-identical tool
  list.
* **T11.3** A probe: `TestLanguageModel` records serialized requests; assert
  two consecutive requests with no new selection share their tool-list bytes.

## 12. E10 — Cloudflare AI Gateway (P3)

An optional model-layer option in `/cloudflare` (gateway URL, cache/metadata
headers). Not kernel architecture. Only on an adopter asking.

---

## 13. Open questions

* **Q1** Is visibility per agent or per session? Principal and delegation
  grants are per session, which argues for the session; `describe` wants a
  static answer, which argues for the agent with a session-level narrowing.
* **Q2** ~~Strengthen `Alone` (recommended) or add a second annotation?~~
  Strengthened, 2026-09-10 (§5).
* **Q3** `failureMode: "return"` vs `FailRun` — which wins (§6, T6.1)?
* **Q4** Should a projected completion (E2) be able to fire on a
  provider-executed tool's result? Leaning no: the output schema should come
  from an application result the host controls.
* **Q5** Does discovery itself count as a tool call for `maxToolCalls`?
  Leaning yes — it is one — with `pinned` as the escape hatch for agents that
  cannot afford the turn.

## 14. Refused

* A per-tool failure-policy architecture (§6.1).
* A separate `Agent.inspectTools()` beside `Agent.describe()`.
* `toolCalls.length === 1` as the exclusivity rule (§5.3, I5.2).
* Making benchmark timings a merge gate before variance is known (§10).

---

# Part II — durability and correctness

The second pass was over #376 (canonical-anchor pagination), #378 (live
context-continuity suite), #379 (defaulted `Context.Reference` trap;
reservation-time concurrency), #380 (recovery checkpoints as disposable
caches), #387 (exact model response across recovery), #389 (host
scheduling) and #391 (crash/no-crash canonical equivalence), plus the
frozen legacy `new_context` definition and a subagent-suspension ordering
fix. Three read-only audits checked each against this tree on 2026-09-10;
their findings are the "today" paragraphs below, cited to file and line.

One rule runs through all of it:

```text
canonical state             = truth
recovery snapshot           = optimization          (disposable)
context/compaction checkpoint = derived model context (disposable)
index                       = candidate lookup      (disposable)
```

None may silently become truth because replaying truth is expensive, and a
recovered execution must be **observationally equivalent** to the one that
never crashed.

## 15. E11 — The exact model response survives recovery

**Landed 2026-09-10 (item 103, ledger).** T15.1–T15.4 as written, with the
merge rule taken from Effect AI's own `Prompt.fromResponseParts`. The rich
fixture found a second bug the plan did not name: the streamed replay built
its parts from *encoded* values behind a cast, so a file's bytes came back as
their base64 string. The replay now works on decoded parts.

**Today.** The batch path is right: the model activity journals the full
`Response.Part[]` (`DurableModel.ts:149–170`) and the assistant message is
rebuilt from those parts (`AgentTurn.ts:514–526`), not from tool-call
records. **The streaming path is lossy**: the accumulator closes a text or
reasoning chunk as `Response.makePart("text" | "reasoning", { text })`
(`internal/streamAccumulator.ts:147–150`, and `flushOpen` at `:192–196`), so
start/delta/end `metadata` — including Anthropic reasoning signatures — never
reaches the canonical message. Durable replay re-emits the stream with no
metadata either (`DurableModel.ts:83–88`), so first run and replay agree, and
both are wrong. The local (non-durable) streaming path has the same loss.
`ProviderContinuation.test.ts`'s signature test is batch-only.

**Invariant I15.1.** For any provider response, the canonical assistant
message is the same whether the turn streamed or not, and after a crash and
restore it is the *same message* — never one reconstructed from less.

**Todos.**
* **T15.1** Carry chunk metadata through the accumulator: merge start, delta
  and end `metadata` onto the assembled part (define the merge — last write
  per provider key — and document it; reasoning signatures typically arrive
  on the end or last delta).
* **T15.2** Durable streaming replay re-emits the journalled parts'
  metadata on the synthesized start/end parts.
* **T15.3** The "nasty" fixture: one response with text + reasoning (with
  signature) + a file part + provider options/metadata on several parts +
  three tool calls, in batch and streaming, local and durable.
* **T15.4** Fix the two replay tests that claim to gate "between the turns"
  but suspend in the first `ContextTransform` call, before `model-0` runs
  (`DurableReplayHistory.test.ts:65–72`, `ProviderContinuation.test.ts:218–226`)
  — gate on `turnIndex`, so a journalled model response is actually replayed.
  Their `shape()` also renders reasoning and files as `""`; compare the
  encoded `PromptWire` instead.

**Acceptance.**
* **A15.1** For T15.3's fixture, crash between the model activity and tool
  settlement, recover, and assert the next model request's history is
  deep-equal (encoded `PromptWire`) to the uninterrupted run's — batch and
  streaming.
* **A15.2** Mutation: drop metadata in `text-end` again → A15.1 fails in
  the streaming variant.

## 16. E12 — Crash/no-crash canonical equivalence as the durability oracle

**First slice landed 2026-09-10 (item 104 stays open).** T16.1 and T16.4 as
written. T16.2 landed in `test/`, not `src/testing/`: a real crash needs a
journal that outlives the process, which here is SQLite, and a shipped harness
cannot depend on it -- it wants a portable seam for "build a process over this
store" first. T16.3 covers plain parallel tools, batch and streamed; the other
scenarios are open. Two design points on the way: a crash is simulated as a
process dying (parked, then its scope closed), not as an interrupt raised
inside the turn -- an in-turn interrupt is the in-workflow session's own
interruption path, so it risks being recorded as a user interrupt rather than
a crash (reasoned from the code, not run) -- and after a takeover the
scripted model must answer by conversation, not by call count, or the
replacement answers the wrong turn (`TestLanguageModel`'s `select: "history"`).

**Today.** No test compares a crashed run with an uncrashed one on full
history, events or usage. Existing failpoint tests compare narrower things —
`DeliveryLog` rows (`Failpoints.test.ts:87–195`), the last prompt's texts
(`ContextRollover.test.ts:464–518`), run-once counts
(`WorkerDispatchIntents.test.ts`, `DurableAgentClient.test.ts:1355–1410`).
**There is no failpoint inside a turn** (between the model activity, the
tool activities, and commit). Tool-result order is declaration order by
construction (`ToolExecution.ts:894–898, 978–981, 994–999`; the calls come
from the journalled response) but is tested only without durability
(`ToolProgress.test.ts:132–195`); `DurableAudit.test.ts:297–370` sorts what
ran and never inspects history.

**The oracle.**

```ts
normalize(runWithoutCrash(scenario)) deepEquals normalize(runWithCrashAt(scenario, boundary))
// for every boundary in Failpoints.covered
```

compared over: canonical history (encoded), event identities and payloads
(minus timestamps), tool results, usage and `RunLedger` accounting, output,
submission disposition, idempotency/claim state after settlement, and the
next model context. `normalize` removes only what is documented as
nondeterministic (wall-clock, generated ids that are not canonical); every
field it strips is listed and justified, and a new field is compared by
default.

**Invariants.**
* **I16.1** Recovery is observationally equivalent to uninterrupted
  execution on every compared field.
* **I16.2** Canonical tool-result order = model declaration order, after
  parallel execution, crash, partial settlement, subagent or elicitation
  suspension, and restore. Execution, completion and event-arrival order may
  vary; history may not.
* **I16.3** An absent field and an empty one are not both acceptable
  spellings (#391's `uncommittedModelUsage: []` vs omitted): the encoder
  picks one.

**Todos.**
* **T16.1** In-turn failpoints: after the model activity, between tool
  activities (after the first of N settles), after all tools settle and
  before commit, after commit and before the loop decision.
* **T16.2** `AgentConformance`-style harness in `src/testing/` (ships, like
  the client suite): `equivalence(scenario, boundaries)`.
* **T16.3** Scenarios: plain tools; parallel tools with reversed completion
  order; `Alone`/E1 rejection; output tool; compaction fold and rollover;
  subagent with a suspended child elicitation; Code Mode with a suspending
  executor; E11's nasty response.
* **T16.4** Add the oracle to `scripts/falsify.mjs` as D8 with a break that
  omits a field on one path, confirming it bites.

**Acceptance.** A16.1: every scenario × every covered boundary passes.
A16.2: the D8 break is caught. A16.3: reversing completion order under a
crash leaves history in declaration order.

## 17. E13 — Host scheduling, and authority captured per attempt

**Today.** No host scheduling layer exists: the only strategy is the
agent's (`Sequential`/`Parallel`/`perTool`, `ToolExecution.ts:39–51`),
scoped to one response, and `ToolExecution.ts:95–108` says so and leaves
process-wide exclusion to semaphores inside handlers (`coding/internal/fileLock.ts`,
the `web/*` `MAX_CONCURRENT`s). Under `/durable`, recovery rebuilds the
agent from **the replacement process's definition**
(`DurableSubmission.ts:687–692`): the tool strategy is not captured per run.
Permission is captured **per decision** — each answer is a journalled
activity (`DurablePermission.ts:44–56`) — so replayed decisions stand, but a
call not yet decided consults the replacement process's current policy, and
`needsApproval` is re-evaluated (`:20–24`).

**Design.**

```ts
ToolScheduling (host-provided service)
  sequential(call): Option<ResourceKey>   // calls sharing a key serialize
  maxConcurrency?: number                  // host ceiling
```

Actual execution = the **intersection** of agent policy and host policy.

**Invariants.**
* **I17.1 Tighten, never widen.** Host scheduling can only reduce
  concurrency relative to the agent's strategy.
* **I17.2 Captured at admission.** The effective strategy and host
  scheduling descriptor are recorded in the submission payload; a recovered
  attempt uses the captured one, not the replacement process's ambient
  configuration.
* **I17.3 Authority capture may tighten, never widen, on recovery.** For an
  undecided call on a recovered attempt, the effective permission is the
  *stricter* of the captured and the current policy — so a revocation
  between crash and recovery still applies, and a newly granted permission
  does not retroactively authorize an old run. (This is why capture is not
  simply "use the old policy".) Journalled decisions stand as today.

**Todos.** T17.1 `ToolScheduling` service and the intersection in
`ToolExecution.execute`; T17.2 a serializable description of strategy +
scheduling in `DurableSubmission`'s payload (additive, optional field); T17.3
decide how "stricter of captured and current" is computed for
`Permission` — probably journal the policy's *description*
(`Permission.describe`) and evaluate both, requiring both to allow; T17.4
docs in `guide-durable.md`.

**Acceptance.** A17.1 agent `Parallel`, host serializes `book_room`: two
`book_room` calls never overlap (instrumented), reads around them do. A17.2
crash, recover in a process whose agent is configured `Parallel` where the
original was `Sequential`: the recovered attempt runs sequentially. A17.3
revoke a tool between crash and recovery: its undecided call is denied; grant
a new one: an old run does not gain it.

## 18. E14 — Long-lifetime continuity evaluation

**Today.** Nothing combines many turns, repeated compaction/rollover,
process death and a deterministic recall check. Pieces are tested alone:
`Compaction.test.ts`, `ContextRollover.test.ts` (one or two windows),
`ContextEvidence.test.ts`, `Durable.test.ts:1111–1345`, `Memory.test.ts:185`,
`DurabilitySoak.test.ts` (durability guarantees, not recall). `Evals`
(`src/evals/Evals.ts`) runs one in-memory `AgentSession` per eval, has no
datasets, and offers an optional LLM judge. There is no live-model test
tier and no scheduled CI job.

**Design.** A scenario is data: an evolving project over 15–30 user turns,
with conflicting corrections injected, compaction forced repeatedly
(`Compaction.whenLongerThan`, `new_context`), and process death at selected
boundaries (the SQLite setup of `examples/durable-resume.ts`, `Failpoints`).
Later turns ask for:

* the original exact fact (now outside the active window),
* the latest corrected decision (not the superseded one),
* the unfinished task,
* provenance — which canonical message the fact came from, via
  `search_context`/`read_context`.

Scored **programmatically** against the scenario's ground truth and
canonical provenance; **no LLM judge**.

**Todos.**
* **T18.1** `Evals.run` variant over a restorable/durable session and
  multi-process steps.
* **T18.2** A deterministic tier with `TestLanguageModel` scripts that
  exercises the machinery (folds, rollovers, restarts, retrieval tool calls)
  and runs in `npm run check`.
* **T18.3** A live tier behind an env var and `npm run eval:continuity`,
  release/nightly only, reports into `docs/reports/` in E8's format.
* **T18.4** Record rollover count, kills, retrieval calls and per-question
  pass/fail with the canonical message cited.

**Acceptance.** A18.1 the deterministic tier forces ≥ 12 rollovers and ≥ 3
kills and passes. A18.2 mutation: drop the rollover checkpoint's carried
summary → the "original fact" question fails. A18.3 the live tier's report
cites a canonical message index for every provenance answer.

## 19. E15 — A durable tool contract is part of the persisted program

**Today.** No tool-definition digest or version is persisted. Replay
decodes journalled model parts and tool results against the **current**
toolkit's schemas (`DurableModel.ts:149–163`, `DurableToolkit.ts:109–123`);
an incompatible change is a `SchemaError` or an "unknown tool" defect
(`DurableToolkit.ts:201–206`). Worst case: a `new_context` request is
re-read with `decodeUnknownOption(RolloverRequest)` (`Compaction.ts:555`),
so a schema mismatch is **silently treated as no request**. Payload and
claim fields evolve by optional additions only; Code Mode's run state is
the one explicit version (`callscript.ts:186–193`).

**Invariants.**
* **I19.1** Upgrading the library or app does not make a recorded run obey
  a different contract silently. Either it replays under the definition it
  was recorded with, or it is refused with a typed error naming the tool
  and both digests.
* **I19.2** Control tools (`AgentOutput`, `new_context`, delegation,
  elicitation, Code Mode suspension, E3's discovery) keep frozen legacy
  definitions for as long as recorded runs may reference them.
* **I19.3** No `decodeUnknownOption` over persisted control data: a
  mismatch is an error, not an absence.

**Todos.** T19.1 a canonical digest of each tool's name + encoded parameter,
success and failure schemas + execution-relevant annotations, persisted in
the submission payload at admission; T19.2 compare on replay, typed
`ToolContractChangedError`; T19.3 legacy definition registry for control
tools; T19.4 replace the silent decode at `Compaction.ts:555`. Feeds item 67
(the journal compatibility promise).

**Acceptance.** A19.1 record a run, change the tool's parameter schema,
recover → typed refusal, not a defect or silent success. A19.2 a recorded
`new_context` under V1 still rolls over after `new_context` becomes V2.
A19.3 mutation: restore `decodeUnknownOption` → a test fails.

## 20. E16 — Checkpoints are disposable caches

**Today.** Compaction checkpoints are already treated as projections of
history: a missing one falls back to the full transcript, and a stale one
(`coveredThrough > length` or prefix fingerprint mismatch) is discarded
(`Compaction.ts:1370–1379`, `Compaction.test.ts:463`). Two gaps: a
**corrupt** checkpoint **fails the turn** with a `PersistenceError` rather
than being discarded (`Compaction.ts:1158–1161, 1318–1326`), and the
fingerprint is FNV-1a **32-bit** over the prefix JSON (`:470–487`), which can
collide. `AgentSession.Snapshot` and `DurableSessionStore` history are truth,
unversioned (`AgentSession.ts:1114–1117`).

**Todos.** T20.1 decode failure of a checkpoint → discard, rebuild from
history, emit an event saying so; T20.2 a stronger portable fingerprint
(≥ 64-bit, plus length and `coveredThrough`); T20.3 write the four-role
vocabulary (above) into `guide-durable.md`, naming each artifact's role;
T20.4 version tag on `Snapshot`.

**Acceptance.** A20.1 corrupt the stored checkpoint bytes → the turn
succeeds with the same model context as a fresh rebuild. A20.2 checkpoint
attached to a different canonical tail (same length, different content) →
discarded.

## 21. E17 — Cursors over mutable sets; incomplete ≠ empty

**Rule.** When a collection can change between pages, page by a stable
canonical anchor (`before`/`after` an opaque id), not a numeric offset. When
a scan or work bound is hit, say so — a short result must not read as a
complete one.

**Today.**

| API | cursor | at the bound |
| --- | --- | --- |
| `Catalog.search` / Code Mode search (`Catalog.ts:362–406`, `CodeTool.ts:372`) | positional offset into a re-scored list; the comment calls it safe because scoring is deterministic, which holds only while the namespaces don't change — a tool-source refresh shifts pages | explicit `next`, `total` |
| `Memory.recall` (`Memory.ts:116–124`) | none; top `limit` | **looks complete**: no total, no truncation flag |
| `search_context` (`Compaction.ts:1742–1763`) | stable message index | **looks complete**: stops at 3 hits and reports `searched: messages.length` (history length, not what was scanned) |
| `read_context` | stable index + char offset | explicit `hasMore`, `totalChars` |
| `SessionDirectory` list | stable keyset | explicit `next` |
| `DeliveryLog.read({ after })` | stable per-session sequence | **no limit at all** — an unbounded read |
| MCP `tools/list` | server cursor, drained | explicit |

**Todos.** T21.1 Catalog search pages by `after: path` (the tie-break key)
rather than offset — required before E3's discovery reuses it; T21.2
`Memory.recall` and `search_context` return `truncated`/`moreAvailable` and
an honest `scanned`; a scan bound that stops early is a typed
`SearchLimitExceeded` or flagged partial, never a clean empty; T21.3 a
`limit` on `DeliveryLog.read`, with `next`.

**Acceptance.** A21.1 a tool source refreshes between page 1 and page 2 →
no tool skipped or repeated. A21.2 `search_context` over a history with 10
matches reports that more exist. A21.3 a bound hit with zero matches so far
is distinguishable from "no matches".

## 22. E18 — Operational defaults audit

**Today.** All seven defaulted `Context.Reference`s are **safe** — absence
means "no feature" (`AgentInput.Current`, `Elicitation.Current`,
`CurrentSessionId`, `ParentEvents`, `Failpoint`, `CurrentPrincipal`,
`ToolExecution.Alone`). #379's trap does not bite through a Reference here.
The operational defaults are ordinary `??` fallbacks in options:

| default | where | class |
| --- | --- | --- |
| `Permission.allowAll` | `Agent.ts:477`, `code/CodeMode.ts:413` | security; documented |
| host authorization `allowAll`, principal `"anonymous"` | `cloudflare/index.ts:485–487` | **security, network-facing** |
| relay authorization `allowAll` | `relay/RelayServer.ts:135` | **security, network-facing** |
| input channels `InputChannel.memory` | `AgentSession.ts:357` | durability |
| A2A `InMemoryTaskStore` | `a2a/AgentA2A.ts:1181` | durability |
| OpenAI-compatible idempotency in memory | `openai/OpenAiAgent.ts:441` | dedup lost on restart |
| `Shell.current` → host `bash` | `shell/Shell.ts:152–153` | no sandbox unless provided |

`AgentSessionHost` already requires authorization with no default
(`client/AgentSessionHost.ts:69`) — the right shape.

**Rule.** A default whose absence disables correctness or security must be
explicit at a network-facing or durable boundary: required, or an explicit
`allowAll()`/`memory()` value the caller writes. In-process quickstart
defaults may stay, documented.

**Todos.** T22.1 make the Cloudflare host and relay server authorization
required (as `AgentSessionHost`); T22.2 `Agent.describe()` reports whether
permission is the default `allowAll`; T22.3 durable-sounding adapters (A2A,
OpenAI idempotency) name their in-memory default in `describe`/docs, or
require the store; T22.4 a "defaults" table in `limits.md`; T22.5 a lint-like
test listing every `Context.Reference` with its class, so a new operational
Reference must be classified to pass.

**Acceptance.** A22.1 constructing the Cloudflare host or relay without
authorization is a type error. A22.2 T22.5's inventory test fails when an
unclassified Reference is added (break it once).

## 23. E19 — Admission limits decided at the reservation

**Rule.** Quota inspection and reservation are one atomic operation;
retries reuse the owner that won the reservation; lowering a limit blocks
new reservations and never retroactively invalidates admitted work.

**Today.** `DurableSessionStore.claim` is a real atomic reservation
(conditional `UPDATE … WHERE claim IS NULL` in a transaction, read back,
`DurableSessionStore.ts:787–845`). `SessionInbox.deliver` is check-then-act
made safe by `submit`'s claim and idempotency key. **Gaps:** the scheduling
worker forks every due job with **no concurrency limit** (`Scheduling.ts:185–189`);
subagents have **no concurrency or depth limit**; `Budget` is checked after
the turn (post-hoc, not a reservation).

**Todos.** T23.1 worker concurrency limit taken inside `claimDue` (claim at
most the free slots), not by a semaphore after claiming; T23.2 subagent
depth and concurrency limits, reserved at delegation; T23.3 state the
lowering rule in the guides.

**Acceptance.** A23.1 100 due jobs, limit 4: never more than 4 running and
no job claimed that could not start. A23.2 recursive delegation stops at the
depth limit with a typed error the model sees.

## 24. E20 — Recovery snapshots (parked)

**Today.** Cold recovery is O(total history): each submission's payload
carries the full `initialHistory` (`DurableSubmission.ts:66–73`), the
compaction fingerprint re-hashes the covered prefix every turn
(`Compaction.ts:1376`), and `DurableStreams.fold` replays the whole stream.

A `RecoverySnapshot { canonicalTail, runAccounting, contextProjection,
lastSettledToolBatch, durableStepEvidence }`, validated by canonical
fingerprint and replaying only the suffix, is how a session with hundreds of
thousands of records recovers cheaply. It is a cache under §Part II's rule:
missing, corrupt, stale, incompatible or attached to the wrong tail → thrown
away, rebuild from truth. **Parked until E8 measures a session where cold
recovery cost matters**; E12's oracle is its acceptance test when it comes.

## 25. Open questions (Part II)

* **Q6** E13's "stricter of captured and current" permission: is journalling
  `Permission.describe` enough, or does a policy with closures need its own
  capture form?
* **Q7** E15: refuse on any digest change, or allow declared-compatible
  changes (additive optional fields)? Leaning: refuse by default, with an
  explicit compatibility declaration per tool.
* **Q8** E18: making Cloudflare/relay authorization required is a breaking
  change to two entry points; acceptable pre-1.0?
