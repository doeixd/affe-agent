# Post-Roadmap Plan — production readiness & ecosystem

The issue #4 capability roadmap (1–14) and the design-review remediation
([DESIGN-REVIEW-PLAN.md](./DESIGN-REVIEW-PLAN.md), 17/17) are done. What remains
is not capability but **making the batteries deployable, sharpening one core
primitive, documenting an existing mechanism, and readying a release**. This plan
covers all four, ordered so the cheap guards land first.

Same rules as before: a package adds a capability, policy, interpreter, or
adapter — never a parallel execution model; core depends on no battery; end-user
*and* test code never needs a cast; assert every inference and break it once.

Priority: **P0** cheap/high-leverage · **P1** real value · **P2** worthwhile ·
**P3** nice-to-have. Effort in half-day units.

---

## Workstream R — Release & CI hardening

CI already exists (`.github/workflows/ci.yml`: `npm run check` + `build` +
`verify:package` on Node 22/24, plus an mcp-v1 floor job). So this is *audit and
extend*, not *create*.

### R1 — Audit and close CI gaps `P0` · effort ½ · ✅ DONE
- **Audit result:** `npm run check` already chains
  `typecheck && lint && lint:portability && test` (package.json), so CI *does*
  run the portability gate — the premise that it was missing was wrong. The one
  real gap was that nothing asserted the build has no tracked side effects.
- **Done:** added a `git diff --exit-code` step after `npm run build`, so a
  generated file written into a tracked path fails CI (`dist/` is gitignored, so
  a clean build leaves the tree clean).
- **Files:** `.github/workflows/ci.yml`.
- **Acceptance:** CI already runs tsc + lint + portability + test + build +
  verify:package on every push/PR (Node 22/24); now also fails if the build
  dirties a tracked file.

### R2 — Publish dry-run + pinning guidance `P2` · effort ½
- **Do:** a `npm pack` dry-run check (the tarball contains `dist`, `README`,
  `CHANGELOG`, `LICENSE` and nothing stray); document exact-version pinning of
  `effect` + `@effect/ai-*` + this package, and the peer-dep matrix, in a short
  “Installing” subsection (complements the Stability section already in the
  README). **No real publish** — that stays blocked on Effect 4 GA.
- **Files:** `README.md`, optionally a `scripts/pack-check.mjs`.
- **Acceptance:** the packed tarball's file list is asserted; pinning guidance is
  written; nothing is published.

---

## Workstream E — Elicitation refinement (sharpen the core HITL primitive)

### E1 — Schema-typed elicitation resolution + terminal state `P1` · effort 1½
- **Problem:** `Elicitation.Response.value` is `Schema.optional(Schema.Unknown)`
  (`src/Elicitation.ts:47`) and the `Request` carries only `id`/`kind`/`detail`
  — there is no declared schema for the answer, so a resolver can hand back a
  value of the wrong shape and the run decodes garbage. Double-resolution is
  currently prevented only incidentally by `Deferred.succeed` returning `false`;
  there is no explicit, observable terminal state (a concern the durable path
  makes real).
- **Fix:**
  1. Let a `Request` optionally declare the schema its answer must satisfy (e.g.
     an `answer` codec carried by the elicitor when it creates the request, or a
     typed `request<A>` constructor). `respond` decodes `value` against it and
     fails with a typed decode error on mismatch, rather than accepting unknown.
  2. Give each pending elicitation an explicit terminal state (`pending →
     answered | withdrawn`) so a second `respond` is refused deterministically
     and observably, on both the `Deferred` and `DurableDeferred` paths.
- **Files:** `src/Elicitation.ts`, `test/Elicitation*.test.ts`, and a check that
  `Permission.ask` (its main consumer) still type-checks.
- **Acceptance:** resolving with a value that violates the request's schema is a
  typed failure (tested); a second resolution returns the terminal-state refusal
  (tested); a type-level assertion pins that `value` is no longer `unknown` at
  the typed-request boundary, falsified once. No cast at any call site.
- **Note:** this touches a core seam and the durable interpreter — do it behind
  the existing `Elicitation.Factory` so the durable path stays in step.

---

## Workstream D — Document the dynamic-capability story (#7)

### D1 — Toolkit-as-Effect section + example `P2` · effort 1 · ✅ DONE
- **Problem:** the mechanism for per-turn capability resolution — a `toolkit`
  that is an `Effect`, re-resolved each turn so tools can vary with runtime state
  (per-tenant MCP, credentials, feature flags) — exists and is tested, but is
  undocumented, so nobody knows to reach for it. (Issue #4 item 7.)
- **Fix:** a short README section under the tools material explaining the
  Effect-valued `toolkit`, when it re-resolves, and the requirement/error
  implications; plus a typechecked `examples/dynamic-capabilities.ts` that
  resolves a per-tenant toolkit from a service read at turn time.
- **Files:** `README.md`, `examples/dynamic-capabilities.ts`.
- **Acceptance:** the example typechecks under the examples tsconfig; the section
  states precisely when the toolkit Effect runs (per turn) and how its `R`/`E`
  reach the agent. No new library code.

---

## Workstream P — Production adapters (prototype → deployable)

Two batteries ship built-ins explicitly scoped to “tests / single-node”. Give
each a production-grade implementation of the *same* interface, so the agent code
does not change.

### P1 — Durable / queue `AgentDispatcher` for `/scheduling` `P1` · effort 2
- **Problem:** `/scheduling` ships only `Scheduling.local` (in-process, dies with
  the process). The `AgentDispatcher` seam was built so a durable implementation
  is a drop-in, and `cluster/ScheduledAgent` already wraps `ClusterCron` for
  durable recurrence — but there is no durable *dispatcher* for one-off
  self-dispatch that survives a restart.
- **Fix:** an `AgentDispatcher` implementation whose `dispatch(job)` enqueues
  durably — over a durable queue and/or `DurableClock.sleep` (the delayed form)
  under the `/durable` machinery — so a scheduled follow-up run survives the
  process that scheduled it. Same `AgentDispatcher` tag; the tool that calls
  `dispatch` is unchanged. Likely a `scheduling/durable` sub-entry (host-neutral;
  the durable backend is provided as a layer).
- **Files:** `src/scheduling/` (new impl + export), example, test.
- **Acceptance:** a durable dispatcher runs a *delayed* job across a simulated
  restart, driven by `TestClock` + a durable store, deterministically — the job
  fires after the delay even though the “first process” is gone. Interface parity
  with `local` is type-asserted.

### P2 — Crypto-backed Slack signature verifier for `/connectors` `P1` · effort 1
- **Problem:** the `/connectors` webhook example leaves signature verification to
  the application's `decode`; there is no shipped, correct verifier, so every
  adopter re-implements Slack's HMAC and risks getting timestamp-freshness or
  constant-time comparison wrong.
- **Fix:** a **host-flagged** sub-entry `connectors/slack` (uses `node:crypto`,
  so it belongs in `HOST_MODULES` beside `sandbox/local`, kept out of the
  portable surface) that verifies Slack's `v0=` HMAC-SHA256 over
  `v0:{timestamp}:{body}` with the signing secret, rejects stale timestamps
  (replay window), and compares in constant time. It plugs into a `decode` as a
  guard.
- **Files:** `src/connectors/slack.ts` (host), `package.json` export
  `./connectors/slack`, `HOST_MODULES` += `connectors/slack.ts` in
  `scripts/verify-portability.mjs`, example wiring, test.
- **Acceptance:** the verifier accepts a correctly-signed request, rejects a
  tampered body, a wrong secret, and an expired timestamp (all tested with known
  vectors); `lint:portability` still passes (crypto isolated to the host entry);
  `verify:package` counts the new entry.

---

## Order of work

1. **R1** — close the CI portability gap (cheap; guards everything below).
2. **E1** — schema-typed elicitation + terminal state (sharpens a core primitive;
   do it while the interrupt/HITL paths are fresh).
3. **D1** — document toolkit-as-Effect (no code; unblocks users on an existing
   feature).
4. **P2** — the Slack verifier (self-contained, high adopter value).
5. **P1** — the durable dispatcher (the largest; makes `/scheduling` deployable).
6. **R2** — pack-check + pinning guidance (last, once the surface is settled).

None of this is a core execution-model change. E1 is the only item that touches a
core seam, and it stays behind the existing `Elicitation.Factory`. Everything
else is a battery adapter, a doc, or CI.
