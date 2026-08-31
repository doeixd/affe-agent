# Plan: primitives sufficient to build the ecosystem on

Written 2026-08-27. The goal is that building opencode, t3code, executor,
OpenRouter, Pi or Flue on top of this package is straightforward. This plan
says which of those need new primitives, which need something that is not a
primitive at all, and how we would know we had succeeded.

**Status: in progress.** Step 1 landed 2026-08-27: the public-surface-only
`examples/ref-coding-agent.ts` runs in CI and exposed the missing Elicitation
export, which is now fixed. Step 2 has its first slice: `/tool-source` provides
the seam plus MCP, OpenAPI and GraphQL sources; credential/auth layers remain.

## The thesis, and its caveat

`flue.md` already states both halves, and the caveat is the part this plan
exists to act on:

> Flue gives you that power as a cohesive framework today. Effect Harness would
> give you the primitives from which that power can be constructed.
>
> So "same power" does not mean "same amount of code for the user" unless you
> also build the higher-level packages.

Capability and ergonomics are different axes. The capability roadmap (issue #4,
P0–P3) is complete; `ROADMAP.md` says so and a pass over `src/` agrees. So the
remaining distance between "possible" and "straightforward" is mostly **not**
more modules.

## 1. The six targets are three axes

They are not the same kind of thing, and treating them as one list is how a
kernel acquires goals that distort it.

| axis | targets | what it demands |
| --- | --- | --- |
| **coding agent** | opencode, Pi, t3code | sessions, turns, tools, permissions, compaction, sandbox, TUI/CLI |
| **integration gateway** | executor | tool sources, auth, connections, per-principal policy, protocol surfaces |
| **model gateway** | OpenRouter | provider routing, fallback, accounting, billing, multi-tenant proxying |
| **framework ergonomics** | Flue | cohesion — one declarative way to say what an agent is |

(t3code is treated here as coding-agent-shaped. If it is something else, this
row is the one to revisit.)

## 2. Gap table against what ships today

### Coding agents — substantially done

| need | state |
| --- | --- |
| sessions, runs, turns, steering, interruption | core |
| tools, permissions, HITL | `Toolkit`, `Permission`, `Elicitation` |
| coding batteries | `/coding` (OpenCode contracts), `/pi` (Pi contracts) |
| execution substrate | `/sandbox` (+`local`), `/shell` (8 dialects) |
| skills, subagents, session tree | `/skills`, `/subagent`, `/tree` |
| context management | `/compaction`, `ContextTransform` |
| persistence, export | `/state`, `/memory`, `/export` |
| front ends | `apps/cli`, `apps/tui`, `/http`, `/rpc`, `/ag-ui`, `/a2a`, `/mcp` |
| **LSP** | **absent** — nothing in `src/` references it |
| **truncation as a shared service** | partial: `coding/internal/truncate.ts` is internal to one toolkit |
| **rendered prompts** | partial: `coding/internal/prompts.ts` is static text |
| **code mode** | **absent** — see [research-code-mode.md](./research-code-mode.md) |
| `question` / `plan` pseudo-tools | absent |

Everything absent here is **battery work, not primitive work**. It is worth
doing, and none of it changes the kernel. LSP is the largest single item and the
one opencode leans on hardest (edits and writes return diagnostics immediately;
reads pre-warm servers).

### Integration gateways — the real gap

| need | state |
| --- | --- |
| principal, per-operation authorization | `AgentSessionHost` (`PrincipalResolver`, `Authorization<Principal>`) |
| per-tool policy | `Permission`, `Permission.annotate` |
| MCP as a source | `/mcp` — both doors (`bind`, `bindDiscovered`) |
| plugin loading | `/plugins` |
| **a source seam** | **absent** — every source is bespoke |
| **OpenAPI / GraphQL / WebMCP / CLI sources** | **absent** |
| **auth: method / binding / store** | **absent** |
| **credential providers** | **absent** |
| **connection bindings, owner/tenant partitioning** | **absent** |
| **derived policy annotations** | **absent** |

This is one coherent body of work, already designed across
[research-tool-sources.md](./research-tool-sources.md) §6 and §7. It is
genuinely primitive work: a `ToolSource` seam and a credential seam are the kind
of thing everything else composes against.

The *infrastructure* half of the same axis — sandboxes, channels, stores,
deployment providers — is [plan-integrations.md](./plan-integrations.md). It
reaches a matching conclusion by a different route: a conformance suite plus two
lifts, and no code generation.

### Model gateways — mostly out of scope, deliberately

| need | state |
| --- | --- |
| provider seam | Effect AI `LanguageModel` |
| routing, fallback, retry ladders | `ExecutionPlan` (audit action landed) |
| usage accounting, budgets | `/budget`, model usage events |
| OpenAI-compatible surface | `/openai` |
| hosted multi-tenant proxying, billing, BYOK key custody | **not ours** |
| where an agent runs at all | [plan-deployment.md](./plan-deployment.md) — entry points and Layers, not a control plane |

`ROADMAP.md`'s own rule decides this: *a package adds a capability, policy,
interpreter, or adapter — never a parallel execution model.* An **adapter to**
OpenRouter passes that test and is a small piece of work. **Being** OpenRouter
does not: it is a hosted product whose hard parts (billing, key custody,
per-tenant rate limiting, provider contract management) are operations, not
primitives, and pursuing them would bend the kernel toward a shape nothing else
needs.

**Stating this as a non-goal is the point of the row.** Left unstated it becomes
a goal by default.

### Framework ergonomics — not a capability gap

`flue.md` already maps every Flue concept onto an existing Effect or harness
primitive, and its conclusion is that the difference is cohesion, not power.
Nothing in that table is missing. What is missing is that a user must assemble
fifteen pieces correctly to get what Flue hands them in one declaration.

## 3. So the work is three things, and only one is a module

**A. The integration axis.** `ToolSource` + the three auth layers. Real
primitives, already designed, largest single body of work. See
research-tool-sources.md §6–§7.

**B. Assembly.** Thirty-plus modules with no recipe means each of the six
targets re-derives the same wiring, and the ones that get it subtly wrong do not
find out. The missing artifact is a small set of opinionated **presets** — a
coding agent, a gateway, a chat agent — each a short assembly over the
primitives with an escape hatch back down to them.

A preset must obey the same rule the packages do: it composes existing layers
and adds no execution model, no new type parameter on `Agent.make`, and nothing
a caller cannot reach past. If a preset needs a capability the primitives lack,
that is a finding about the primitives, not a licence to add it to the preset.

**C. Proof by construction.** The only way to know the primitives suffice is to
build the targets. This has happened twice already and it worked: `/coding`
carries OpenCode's contracts and `/pi` carries Pi's, both ports that would have
exposed a missing primitive had one been missing. Make it the method rather than
an accident.

## 4. Reference implementations as acceptance criteria

The proposal, and the part worth arguing about.

Three miniature targets live in the repo, each built **only** from the public
surface — the same import paths a user gets — and each carrying compile-time
assertions that inference stayed precise:

| name | mirrors | proves |
| --- | --- | --- |
| `examples/ref-coding-agent.ts` | opencode / Pi | sessions, tools, permissions, sandbox, compaction, a front end |
| `examples/ref-gateway.ts` | executor | sources, auth, principals, per-tool policy, an MCP surface |
| `examples/ref-declarative.ts` | Flue | dynamic capability resolution, state, hooks — the ergonomics claim |

Rules that make them worth the maintenance:

1. **Public surface only.** No `../src/internal`, no reaching past an export
   map. A reference implementation that cheats proves nothing.
2. **No casts.** `AGENTS.md` already says test code counts as user code; these
   count double. Each carries an assertion that a tool call, its result and the
   error channel are not `any`, **broken once to confirm it is enforced**.
3. **Miniature, not a fork.** Enough to exercise the seams; not a competing
   product. `examples/full-stack-agent.ts` is roughly the right size and already
   does part of this job.
4. **A missing primitive is a finding, and gets written down** — in
   `STATUS.md`, with what was missing and what was added. That log is the real
   output of this exercise.
5. **They run in CI.** An example that only compiles is half a test.

## 5. Invariants

1. **A package adds a capability, policy, interpreter, or adapter — never a
   parallel execution model.** Already the rule; this plan does not weaken it.
2. **Presets compose, never extend.** A preset is layer composition plus
   defaults. If it needs new behaviour, the behaviour belongs in a package.
3. **`Agent.make` does not grow type parameters.** New cross-cutting concerns
   are combinators. Unchanged by anything here.
4. **Reference implementations use only the public surface, and carry no casts.**
5. **Being a hosted product is out of scope.** Adapters to OpenRouter, to a
   secret backend, to a channel — yes. Billing, key custody, tenant rate
   limiting — no.
6. **Nothing here justifies breaking the portability guardrail.** Sources needing
   a filesystem, a subprocess or a browser go behind their own entry point, as
   `sandbox/local.ts` does.

## 6. Success conditions

- [x] `examples/ref-coding-agent.ts` runs an edit/search/shell loop with
      permission prompts and compaction, over the public surface, with no casts.
- [ ] `examples/ref-gateway.ts` serves an MCP endpoint over tools extracted from
      at least two source kinds, resolves a credential per principal, and denies
      a tool by policy — with the credential provably absent from every event and
      export.
- [ ] `examples/ref-declarative.ts` resolves its capability set per turn from
      state, and is shorter than the equivalent hand-assembly by a margin worth
      quoting in the README.
- [ ] All three run in CI, not merely typecheck.
- [ ] Each compile-time assertion has been broken once and restored. *(The
      coding reference and ToolSource assertions have been; future references
      still need their own falsification.)*
- [ ] `STATUS.md` records every primitive the three exposed as missing, and what
      happened to it.
- [ ] The README's package map lets a reader answer "which module do I need for
      X" without reading `src/`.
- [ ] `npm run check` stays green throughout.

## 7. Sequence

1. **`ref-coding-agent`, against today's surface.** Cheapest, and it measures
   the claim that this axis is done. Whatever it exposes is the real coding-agent
   gap list, replacing the guesses in §2.
2. **The integration axis** — `ToolSource`, then OpenAPI and GraphQL sources,
   then the three auth layers (research-tool-sources.md §6–§7).
3. ~~**`ref-gateway`**~~ — written 2026-08-31, against the finished
   integration axis. `examples/ref-gateway.ts` runs in CI
   (`npm run smoke:ref-gateway`) and enforces its claims rather than
   printing them. Findings in `STATUS.md`; the headline is that nothing
   was missing -- it composes from the public surface with no cast -- and
   the surprise is that a write is refused *twice*, independently.
4. ~~**Presets**~~ — landed 2026-08-31 as `@doeixd/effect-agent/presets`,
   derived from what steps 1 and 3 had written by hand. `Presets.coding`
   and `Presets.gateway`; both references were rewritten on top of them,
   which is the acceptance test. A chat preset is deliberately absent:
   the plan names one, but nothing calls it yet, and that is the guess
   this rule exists to prevent.
5. ~~**`ref-declarative`**~~ — written 2026-08-31. State, how state
   reaches the model, which capabilities apply, and what reacts to what
   are each declared as data; the harness assembles them. Runs in CI
   (`npm run smoke:ref-declarative`) and enforces its claims. Findings in
   `STATUS.md`: nothing was missing, and the ergonomics claim holds with
   one caveat worth stating -- a *toolkit* is fixed at construction, so
   "dynamic capability resolution" here means the policy resolving
   against live state per call, not the tool list changing under the
   model.
6. **Batteries** — LSP, truncation as a service, rendered prompts, code mode —
   in whatever order step 1's findings rank them.

Steps 1 and 2 are independent and can run in parallel.

## 8. Notes

- **The cheapest step is first on purpose.** §2's coding-agent row is a claim
  based on reading `src/`, not on having built one recently. Step 1 either
  confirms it in a few days or replaces it with facts.
- **Presets are the piece most likely to go wrong.** They attract scope: a
  default becomes a policy, a policy becomes a mechanism, and the mechanism is
  suddenly a second way to run an agent. Invariant 2 is the guard, and it should
  be enforced by review rather than hoped for.
- **Three reference implementations is a real maintenance cost.** They will
  break on every public-surface change, which is the point — that is the signal
  they exist to produce — but it should be a deliberate acceptance rather than a
  surprise.
- **`examples/` already has 33 entries** and one of them,
  `full-stack-agent.ts`, is most of `ref-coding-agent`. Start by seeing what it
  is missing rather than from a blank file.
- **The ecosystem targets are moving.** opencode's v2 rewrite, executor and
  WebMCP all changed during the week these documents were written. The reference
  implementations should mirror *shapes* — a coding loop, a gateway — not track
  any specific project's API, or they become a maintenance treadmill against
  someone else's release schedule.

## Related

- [research-code-mode.md](./research-code-mode.md) — code mode, the two
  implementations, and how it would fit here.
- [research-tool-sources.md](./research-tool-sources.md) — the integration axis:
  sources, laziness, tiers of type safety, and auth.
- [plan-mcp-frontend.md](./plan-mcp-frontend.md) — the MCP surface a gateway
  would serve from.
- [plan-integrations.md](./plan-integrations.md) — the infrastructure half of
  the integration axis, and why it needs no generator.
- [plan-deployment.md](./plan-deployment.md) — Node, Durable Objects, Rivet,
  Alchemy, and fronting; the Worker entry point as a portability test.
- [MODULES.md](./MODULES.md) — the inventory §2's gap tables are measured
  against.
- `flue.md` — the capability correspondence this plan takes as settled.
- `ROADMAP.md` — the rule in §3, and the completed capability roadmap.
