# Design Review — Remediation Plan

A concrete plan to address the findings from the 2026-08-23 design review (core
architecture, batteries, and engineering-discipline passes). Each item states
the problem, the fix, the files, and an acceptance criterion. Ordered by
leverage: highest impact-per-effort first.

The guiding rule from [AGENTS.md](./AGENTS.md) still binds every change: a fix
adds a capability, policy, interpreter, or adapter over an existing seam — never
a parallel execution model — and end-user *and* test code must never need a
cast. Where a fix changes an inferred type, assert the inference in a test and
break the assertion once to confirm it is enforced.

Legend: **P0** = do first (cheap, high leverage), **P1** = real defect / soon,
**P2** = worthwhile, **P3** = nice-to-have. Effort in half-day units (½, 1, 2…).

---

## Workstream A — Legibility (make the design's quality visible)

The design is strong; it is not *discoverable*. This is the highest-leverage
work and it is almost entirely documentation.

### A1 — README package-map + seam table `P0` · effort 1 · ✅ DONE
- **Problem:** 28 entry points, a 1,641-line README with no table of contents
  and no package map. The "small kernel, everything composes over a seam" model
  is buried in linear prose (self-identified in ROADMAP.md:62).
- **Fix:** Add, at the top of the README (after the one-paragraph pitch, before
  Quickstart):
  1. A **table of contents**.
  2. A **seam table**: the ~8 kernel seams (`toolkit`, `loop`,
     `contextTransform`, `permission`, `toolExecution`/failure/denial,
     `elicitation`, `channels`/`InputChannel`, `eventSink`) down one axis; for
     each, one line on what it swaps and which battery plugs into it.
  3. A **package map**: the 28 entry points grouped (core · transports &
     durability · batteries · host), one line each, linking to the section.
- **Files:** `README.md` (new top matter). Source the content from the internal
  seam table in the core-architecture review and `package.json` `exports`.
- **Acceptance:** A newcomer can, from the first screen, name every seam and find
  the battery that uses it without scrolling into prose.

### A2 — Fix doc/count drift `P0` · effort ½ · ✅ DONE
- **Problem:** STATUS.md titled "v0.1" while package is `0.0.1`; STATUS/CHANGELOG
  cite "23 entries" where `package.json` now declares 28; the review counted
  621 tests where STATUS says ~586.
- **Fix:** Reconcile every count/version string against ground truth. Add a
  one-line note in STATUS.md that `verify:package` is the source of truth for the
  entry-point count, and regenerate the number from it.
- **Files:** `STATUS.md`, `CHANGELOG.md`.
- **Acceptance:** `grep` for `23 ` entries / `v0.1` / stale test counts returns
  nothing; numbers match `npm run verify:package` and `npm run test` output.

### A3 — RC / unstable-substrate disclaimer `P1` · effort ½ · ✅ DONE
- **Problem:** The library rides `effect@>=4.0.0-rc.111` (a release candidate)
  and `effect/unstable/ai`. That is the dominant adopter risk and it is nowhere
  stated for a reader deciding whether to depend on this.
- **Fix:** A short "Stability" section in the README: the *design* is stable, the
  *substrate* is a pre-1.0 Effect RC + explicitly-unstable AI modules; pin
  guidance; expect upstream churn until Effect 4 GA.
- **Files:** `README.md`.
- **Acceptance:** The stability posture is stated above the fold, not implied by
  the version number alone.

### A4 — Examples for the un-exampled entry points `P2` · effort 2
- **Problem:** ~7 entry points (`/rpc`, `/http`, `/ag-ui`, `/a2a`, `/mcp*`,
  `/compaction`, `/testing`) have no dedicated example; examples are the
  typechecked, trustworthy documentation.
- **Fix:** One minimal, typechecked example per missing entry point, following
  the existing `examples/` conventions (compiled by `tsconfig`, not executed).
- **Files:** `examples/*.ts`.
- **Acceptance:** Every public entry point has at least one example; `tsc`
  includes them and passes.

---

## Workstream B — Kill the hand-maintained couplings (prevent future bugs)

Two places in the kernel stay correct only by human vigilance. Make the compiler
or a test hold the invariant instead.

### B1 — Derive `PromptError` from `ToolExecution`'s raised errors `P1` · effort 1 · ✅ DONE
- **Problem:** `AgentSession.PromptError` (`AgentSession.ts:353-370`) manually
  re-lists `ToolApprovalRequiredError` and `ToolPermissionDeniedError`, which are
  raised by `ToolExecution`, not by any tool — with a comment admitting they are
  "easy to miss." Adding a new harness-raised tool error silently requires
  widening a type three files away.
- **Fix:** Express the harness-raised error set **once** (a type alias exported
  from `ToolExecution.ts`, e.g. `ToolExecution.RaisedError`) and have
  `PromptError` reference that alias instead of restating its members. If a value
  is needed, derive from `ToolExecution.execute`'s own signature.
- **Files:** `src/ToolExecution.ts` (export the alias), `src/AgentSession.ts`
  (consume it).
- **Acceptance:** A type-level test asserts `PromptError` includes every member
  of `ToolExecution.RaisedError`; deleting one member from the alias breaks the
  test (falsify once). No behavior change; full gate green.

### B2 — Pin the out-of-band input-gating invariants with a model/property test `P1` · effort 2 · ✅ DONE
- **Problem:** The follow-up/steering admission machinery (`AgentSubmission.execute`
  drain→check→`admit(false)`→re-drain, plus the `inputGate` semaphore held across
  check-and-offer in three files) is correct but sustained by prose comments. It
  is the kernel's accidental-complexity hotspot and the part most likely to grow
  a bug under change.
- **Fix:** Add a focused test that drives the gate through its race windows using
  the existing deterministic harness (`TestLanguageModel` `during` hook +
  `Deferred` latches): offer a follow-up exactly as the submission begins its
  closing drain; assert the "anything offered while the gate read open is drained
  before close concludes" invariant holds. Cover the durable stale-admission
  window explicitly since the in-memory default cannot hit it.
- **Files:** `test/` (new `SteeringAdmission.test.ts` or extend
  `AgentSession.test.ts`).
- **Acceptance:** A test names each invariant and fails if the gate ordering is
  perturbed (verify by temporarily reordering the check/offer and watching it go
  red). No `sleep`-based synchronization.

---

## Workstream C — Battery fixes (the surfaces users judge quality by)

### C1 — `Evals.judge` substring scoring `P1` · effort ½ · ✅ DONE
- **Problem:** `Evals.ts:237` scores a judge by `response.text.toUpperCase().includes("PASS")`.
  "This does not PASS the bar" scores as a pass.
- **Fix:** Make the judge return a **structured verdict** — a tool/Schema
  (`{ pass: boolean, reason: string }`) the judge model must call — instead of
  substring-sniffing free text. Keep a strict, anchored fallback only if a
  structured verdict is unavailable, and document its limits.
- **Files:** `src/evals/Evals.ts`, `test/Evals.test.ts`.
- **Acceptance:** A test with a judge reply containing the word "PASS" inside a
  failing verdict scores as a fail. Scored via the structured field, not the
  prose.

### C2 — `Evals.Eval.test` `unknown` error channel `P1` · effort ½ · ✅ DONE
- **Problem:** `Evals.ts:159` types the public surface `Effect<void, unknown, TR>`.
  AGENTS.md:65-70 explicitly calls an `unknown` error channel a bug.
- **Fix:** Give it a precise error type (the union the eval body can actually
  raise). If the intent is "any assertion failure," define a named
  `EvalFailure` error and channel through it; keep the catch-and-record at
  `Evals.ts:243-245` but over a typed cause.
- **Files:** `src/evals/Evals.ts`, `test/Evals.test.ts`.
- **Acceptance:** No `unknown` in a public `Evals` signature; a type-level
  assertion pins the error channel and is falsified once.

### C3 — Untyped "wiring triples" (`skills`, `memory`) `P2` · effort 1
- **Problem:** `skills` needs three independent pieces in agreement —
  `tools:[loadTool]`, `contextTransform: advertise`, `Effect.provide(layer)` —
  and nothing type-checks the pairing; omit the transform and the model never
  learns the catalogue exists. `memory` has the same latent footgun (recall
  transform + remember tool + layer are independent).
- **Fix:** Add a per-battery **install helper** that returns the trio as one unit
  so they cannot drift — e.g. `Skills.install(registry)` yielding
  `{ tools, contextTransform, layer }`, or an `Agent`-pipeable
  `Skills.with(registry)` combinator. Keep the primitives public; make the
  bundle the documented default path.
- **Files:** `src/skills/Skills.ts`, `src/memory/Memory.ts`, their examples and
  tests.
- **Acceptance:** The example wires skills/memory through one call; a test proves
  the advertised catalogue and the load tool always agree (dropping the transform
  is no longer expressible in the happy path).

### C4 — `data` channel name collision `P2` · effort 1 · ✅ DONE (renamed the platform battery to /connectors instead)
- **Problem:** The `channels` battery (platform front-ends) and `data`'s
  `channel()` (typed output buses) are unrelated concepts sharing a word in
  sibling packages. Cheap now, expensive after adoption.
- **Fix:** Rename the `data` concept away from "channel" (candidate: **stream** /
  `AgentData.stream()` / "outputs"). Update the entry name only if warranted;
  keep a deprecated alias for one release if anything already depends on it.
- **Files:** `src/data/AgentData.ts`, `src/data/index.ts`, README, example, test.
- **Acceptance:** "channel" refers to exactly one concept across the tree;
  `channels` and `data` no longer collide.

### C5 — `data` silent drop of undecodable events `P3` · effort ½
- **Problem:** `AgentData.ts:103-116` drops schema-undecodable events with only a
  `logWarning`; a writer/reader schema skew becomes invisible data loss.
- **Fix:** Make the drop observable — a metrics counter and/or an optional
  dead-letter sink the consumer can opt into. Keep the default non-fatal.
- **Files:** `src/data/AgentData.ts`, `test/`.
- **Acceptance:** A test induces a decode skew and asserts the drop is counted /
  surfaced, not silent.

---

## Workstream D — Kernel polish (smaller, real)

### D1 — Interrupted `Result` is lossy `P2` · effort 1 · ✅ DONE
- **Problem:** `AgentSession.ts:518-525` returns `text:"", response:none,
  turns:0, runs:0` on interrupt even when completed turns produced text and usage
  before the interrupt. A caller interrupting mid-run learns nothing about work
  already done.
- **Fix:** Populate the interrupted `Result` from the committed canonical
  history at interrupt time — the text/usage/turn counts that *did* land — rather
  than zeroing them. (Canonical history is exactly the reliable source here.)
- **Files:** `src/AgentSession.ts`.
- **Acceptance:** A test that interrupts after N committed turns sees `turns===N`
  and the accumulated text/usage, not zeros.

### D2 — De-dup `resolveToolkit` `P3` · effort ½
- **Problem:** `Agent.ts:397-400` and `AgentTurn.ts:60-66` implement the same
  `isEffect ? run : succeed` toolkit resolution.
- **Fix:** One shared helper; both call sites use it.
- **Files:** `src/Agent.ts`, `src/AgentTurn.ts`.
- **Acceptance:** One implementation; gate green.

### D3 — `Correlation` `undefined` vs `Option` inconsistency `P3` · effort ½
- **Problem:** `Correlation` (`AgentEvent.ts:318-322`) expresses absence with
  `undefined` optionals while the envelope (`:335-344`) uses `Option`, bridged by
  `Option.fromUndefinedOr`. AGENTS.md mandates `Option` for domain absence.
- **Fix:** Either make `Correlation` use `Option` end-to-end, or document
  explicitly (at the type) that it is an argument bag, not a domain value, and
  why the boundary is where it is. Prefer the former unless it costs ergonomics
  at every emit site.
- **Files:** `src/AgentEvent.ts`.
- **Acceptance:** One representation, or a written, sound rationale at the seam.

### D4 — Retry-policy test coverage `P2` · effort 1 · ✅ DONE
- **Problem:** The one real hole in an otherwise thorough suite. No dedicated
  test asserts fail-turn-N-then-succeed under a retry policy, nor its interaction
  with `maxTurns`, interruption, and event emission — central behavior for a
  library whose domain is loops over flaky models.
- **Fix:** Add retry tests on the deterministic harness: a scripted model that
  fails turn 1 then succeeds; assert the policy retries, the run completes, the
  event stream reflects it, and the interaction with `maxTurns`/interrupt is as
  specified.
- **Files:** `test/` (new `Retry.test.ts`).
- **Acceptance:** Retry behavior is asserted structurally, deterministically (no
  `sleep`).

### D5 — Reduce `sleep`-based settling in durable-SQL integration tests `P3` · effort 1
- **Problem:** Real `sleep`/`setTimeout` settling margins survive in the
  durable-SQL integration tests (`DurableAgentClientSql.test.ts` and siblings) —
  a latent CI-flakiness surface.
- **Fix:** Replace settling sleeps with predicate polling / latches where the
  durable harness allows; keep a sleep only where an external store genuinely
  needs wall-clock settle, and comment why.
- **Files:** `test/DurableAgentClient*Sql*.test.ts`.
- **Acceptance:** No unconditional `sleep` as the primary synchronization in
  these tests; flakiness surface reduced.

---

## Workstream E — New capability (the obvious missing battery)

### E1 — `/budget` — token/turn/cost enforcement `P2` · effort 2 · ✅ DONE
- **Problem:** Token/turn ceilings exist only as eval *assertions* and
  `AgentLoop.bounded`, not as an enforcement capability — despite usage data
  living on `Result` and the loop seam being right there. Budget enforcement is a
  common production requirement.
- **Fix:** A `budget` battery that plugs the existing seams (no new runtime): an
  `AgentLoop` that stops when a token/turn/cost ceiling is reached, reading usage
  off the run state, fail-closed, with the ceiling configurable per session.
  Compose with existing loops via `and`/`or`.
- **Files:** `src/budget/` (new battery, following the established shape:
  `index.ts` + impl + example + test + a `"./budget"` export), README, ROADMAP.
- **Acceptance:** An agent given a token ceiling stops at the ceiling; a
  deterministic test drives scripted usage past the limit and asserts the run
  stops with a budget-exhausted outcome. Core still depends on no battery.

---

## Suggested order of execution

1. **A1, A2, A3** — legibility, one sitting; highest leverage, lowest risk.
2. **C1, C2** — the two `Evals` defects; cheap, and they're on a quality-signal
   surface.
3. **B1** — derive `PromptError`; removes a standing footgun.
4. **D1, D4** — lossy interrupt result + retry tests; real behavior gaps.
5. **B2** — pin the gating invariants; the highest-value hardening.
6. **C3, C4** — wiring bundles + the `channel` rename; do the rename before wider
   adoption.
7. **E1** — the `/budget` battery.
8. **A4, C5, D2, D3, D5** — polish, as capacity allows.

None of these require a core execution-model change. Every item is a seam-level
fix, a type made honest, a test that pins an invariant, or a doc that makes the
existing design legible.
