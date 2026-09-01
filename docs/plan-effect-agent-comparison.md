# Plan: what to take from `effect-agent.com`, and what to leave

**Status: in progress.** Items 1 (§3.0), 2 (§3.1), 3 (§3.2), 4 (§3.3 a–b),
5 (§3.5, the documentation half), 6 (§3.4, phase 1: in-process) and 10
(§3.7) landed 2026-09-01; the rest is as proposed. Written 2026-09-01 from a
read of [effect-agent.com](https://effect-agent.com/) — the documentation
site for `danieljvdm/effect-agent`, the same author as `effect-cf`, which
[plan-effect-cf-and-webtransport.md](./plan-effect-cf-and-webtransport.md)
already read the same day. This plan is the comparison's actionable half:
each item names the gap it closes, the seam it lands on, its acceptance
test, and what it deliberately does not do. §2 is the ranking; the rest is
why.

The governing rule does not change: **a package adds a capability, policy,
interpreter, or adapter — never a parallel execution model.** Every item
below is checked against it, and two of the other project's ideas are
refused on it (§4).

---

## 1. What was read, and what it found

Read 2026-09-01: the home page and the twelve pages in its navigation
(`/guide/introduction`, `getting-started`, `agents`, `run-agents`,
`testing`, `code-mode`, `sandbox`, `browser`; `/concepts/durability`,
`effect-native`; `/platforms/`; `/reference/packages`). Its GitHub
repository was not read — the docs are the contract it publishes, and the
comparison is against that. Treat the version facts as dated: it is
`effect-agent@beta`, on `effect@^4.0.0-rc.111`, the same substrate as ours.

**The two designs converge more than either author would expect.** Its
documented turn sequence — prepare context, stream and reduce the model
response, decode the tool batch, execute bounded handlers, commit in
declaration order, drain steering, evaluate the stop policy, drain follow-up
when complete — is `AgentTurn` and `AgentRun` step for step. Both keep an
append-only canonical history rebuilt by replay; both distinguish "history
persists" from "work survives the process"; both refuse to claim
exactly-once execution of external effects; both have subagents, approvals,
a scripted test model, and a per-thread SQLite ledger. A reader of both
sites will assume one copied the other.

Where they differ, measured against what ships here (`STATUS.md`,
2026-09-01):

| axis | theirs | ours | verdict |
| --- | --- | --- | --- |
| run policy | one `AgentPolicy` object: `maxTurns`, `maxToolCalls`, `maxDuration`, `tokenBudget`, cost, concurrency, `onExhaustion: "final-answer" \| "fail"` | `AgentLoop.maxTurns` / `bounded`, `Budget.within` (tokens) and `Budget.cost` (money), `ToolExecution.perTool` concurrency | **gap**: no tool-call ceiling, no duration ceiling as policy, no constrained final turn (§3.1) |
| typed input | `input` schema plus `inputPrompt` projection: the full value is stored and reaches tool authorization, the model sees a rendering | `Prompt.RawInput`; output is typed (`AgentOutput`), input is not | **gap**, medium (§3.4) |
| transports | none documented | `/client` behind HTTP+SSE, RPC, AG-UI, A2A, MCP, OpenAI-compatible, Slack; a cross-adapter matrix | ours ahead; nothing to take |
| Cloudflare | a first-class `platform-cloudflare` package: one Durable Object per thread, alarms, RPC, Dynamic Workers, Browser Rendering | `apps/worker`, a reference host: DO SQLite history per completed submission, delivery-log journal, scripted model, Effect Workflow stalls on workerd (upstream) | **gap**, the largest (§3.3) |
| Node durability | `platform-node`: SQLite ledger, worker pool, wake notifications, a recovery classifier | `/durable` over Effect Workflow (model and tools as activities), `/cluster` with shard failover, `/durable-streams`, a four-process resume demo | ours ahead; their recovery classifier is what the workflow engine does for us |
| code mode | readonly tools only, no approvals, sequential inner calls, a fresh Dynamic Worker with `globalOutbound: null` per program | any tool, every nested call through `Permission` including `Ask`, an owned acorn interpreter in-process, a `Catalog` with search | different threat models; theirs is safer, ours more capable, and ours does not say so (§3.5) |
| sandbox | a trusted-process runner with request markers, explicitly unisolated | typed file operations plus `exec` / `execStream`, `MemorySandbox`, the local provider, tier-0/1 derivation, a conformance suite | ours ahead |
| browser | page capture, bounded same-host crawl, screenshots, an interactive browser with action/size/time caps | Brave search and guarded HTTP fetch | **gap** (§3.6) |
| testing | `ScriptedModel`, adapter certification, seeded chaos plans, store failpoints, fixtures | `TestLanguageModel`, `AgentProbe`, `verify:durability`, `Export`/`Replay`; the store contracts (`AgentClientContract`, `DeliveryLogContract`, `NodeStoreContract`) live in `test/` and do not ship | **gap**: our certification suites are internal (§3.2) |
| packaging | ~15 packages under `@effect-agent/*` plus an umbrella | one package, ~50 subpaths, boundaries enforced by `lint:portability` | refused (§4) |
| onboarding | a docs site; getting-started runs a bug classifier in one screen | a 2,300-line README that is mostly design rationale, and `docs/` plans that read as internal records | **gap**, cheapest to close (§3.0) |
| naming | owns `effect-agent.com` and the bare `effect-agent` npm name | `@doeixd/effect-agent` | a positioning problem, not a code one (§3.0) |

Two things the read confirmed rather than found. `effect-cf` stays out of
`src/` (that plan's §3 decision holds; their package is the evidence of what
sitting on it looks like). And the `AgentLoop` seam is the right place for
run policy: everything their policy object expresses is a stopping rule or a
concurrency strategy, and both seams exist.

## 2. The ranking

Ordered by user-visible value per unit of work, easiest first within a tier.
Each row names its section; the sections carry the acceptance tests.

| # | item | seam | size | section |
| --- | --- | --- | --- | --- |
| 1 | getting-started page, lineage note, platforms table | docs | S | §3.0 |
| 2 | `AgentLoop.maxToolCalls`, `maxDuration`, `limits`, and the `Final` decision | `AgentLoop`, `AgentRun` | M | §3.1 |
| 3 | ship the store and client contracts from `/testing` | `/testing` | M | §3.2 |
| 4 | DO host: history at turn boundaries, alarms as an `AgentDispatcher` | `apps/worker`, `/scheduling` | M | §3.3 a–b |
| 5 | code mode: state the threat model, name the readonly policy | `/code` docs | S | §3.5 |
| 6 | typed input with a model-facing projection | `Agent`, `AgentSession`, `/durable` | L | §3.4 |
| 7 | `WebCapture` and `WebCrawl` over a provider seam | `/web` | M | §3.6 |
| 8 | a published Cloudflare host entry; a real deployment | host module, `lint:portability` | L, needs an account | §3.3 c–d |
| 9 | an isolate executor behind `CodeExecutor` on workerd | `/code`, host module | M, after 8 | §3.5 |
| 10 | `examples/pr-review.ts` | reference | S | §3.7 |

Items 1, 2, 3 and 5 need no decision from anyone and can start in any
order. Item 6 changes a kernel signature and wants a design pass first.
Item 8 is the category decision `plan-effect-cf-and-webtransport.md` §3
already made, applied to our own code; it needs an account before its
acceptance test can run.

## 3. The items

### 3.0 Onboarding and positioning (item 1)

**Why.** Their getting-started page gets a typed agent running in one
screen. Ours exists (README "Quickstart") but sits inside a document whose
job is to be right, not to be first. And the name collision is real: two
projects called effect-agent on the same substrate with the same turn model,
one of which owns the domain and the bare npm name.

**What.**

- `docs/getting-started.md`: install, one typed agent with an
  `AgentOutput`, run it against `TestLanguageModel` with no key, then the
  one-line swap to a provider layer. Under sixty lines of prose. The README
  links to it above the quickstart. The example is `examples/getting-started.ts`
  so it typechecks with the rest and carries the same compile-time inference
  assertions `typed-agent.ts` does — a getting-started example that needed
  a cast would be the worst place to hide one.
- `docs/platforms.md`: one table. Node 22.5+ (every entry), workerd
  (`apps/worker`, what is and is not durable there, in the words of its
  header comment), Bun (**untested**; say so rather than guess). Their
  platforms page is the model: which package, execution model, storage,
  scheduling, recovery, one row each.
- A README section, "Relation to effect-agent.com", four sentences: a
  distinct project, the same substrate, a convergent turn model, and where
  the designs part (transports, typed input, code-mode isolation). No
  ranking, no adjectives.

**Acceptance.** `npm run typecheck` includes the new example; the
getting-started snippet is the example verbatim, checked by a new test
that reads both files — no such docs-vs-source pin exists yet, and this is
the first place one earns its keep. Break it once by editing the doc.

### 3.1 Run policy completeness (item 2)

**Why.** A user reaches for a tool-call cap, a duration cap and a "finish
with an answer" mode before they reach for anything else in a policy, and
we have none of the three as policy. All three fit `AgentLoop` without a
new concept, and one of them needs a small kernel change that also improves
`AgentOutput`.

**a. `State` gains what a policy needs.** Two additive fields on
`AgentLoop.State`, accumulated by `AgentRun`, which already knows both:

```ts
/** Tool calls executed by this run so far, this turn included. */
readonly toolCallsTotal: number
/** Wall-clock time since the run started, read from `Clock`. */
readonly elapsed: Duration.Duration
```

Both are facts the engine owns; a loop that kept its own `Ref` would be
re-deriving them and would not survive `/durable`'s replay, where the loop
runs again from the journal. Additive, so every existing loop compiles.

**b. Three constructors, in the shape of `maxTurns`.**

```ts
AgentLoop.maxToolCalls(n)        // Stop once toolCallsTotal >= n
AgentLoop.maxDuration(duration)  // Stop once elapsed >= duration
AgentLoop.limits({ maxTurns?, maxToolCalls?, maxDuration?, finalTurn? })
```

`limits` is `and(untilIdle(), ...)` over whichever bounds are given, the
way `bounded` is `and(untilIdle(), maxTurns(n))`; it exists because the
other project's one-object policy is a genuinely better first encounter,
and it lowers into the combinators rather than adding a second policy
language. Tokens and cost stay in `/budget`, because they need a `Layer`
for their scope (per session or per application) and a pure loop cannot
carry one — say that in `limits`' JSDoc so nobody looks for `tokenBudget`
there.

The ceilings are checked **after** the turn, exactly as `Budget.within` is,
and for the same reason: no turn is interrupted mid-flight, so the turn
that crosses the ceiling is the last one. `maxToolCalls(3)` on a turn that
requested five calls runs all five and then stops. That is the honest
semantics of a loop-seam bound, and the JSDoc states it. A per-call
refusal ("the fourth call is denied and the model is told") is a
`Permission` policy, not a loop, and is not this item.

`maxDuration` versus `Effect.timeout(prompt)`: the timeout interrupts the
run and the caller gets `status: "interrupted"`; the loop bound lets the
current turn finish and stops cleanly. Both are valid; the JSDoc names the
difference once so it is not asked in an issue.

**c. The `Final` decision.** Their `onExhaustion: "final-answer"` — one
more turn with no tools, so the run ends in an answer rather than
mid-thought — is the one piece that is not expressible today, because a
loop can only say `Continue` or `Stop`. So:

```ts
export type Decision = Continue | Stop | Final
/** Take exactly one more turn with tools withheld, then stop. */
export interface Final { readonly _tag: "Final" }
```

`AgentRun` on `Final`: run one more turn with the toolkit replaced by the
empty toolkit — or, for an agent with an `AgentOutput`, by a toolkit
holding only the output tool, so the final answer is *typed* — then stop
without consulting the loop again. Withholding is by toolkit, not by a
provider `toolChoice` option, because it must work on every provider and
under `/durable`'s replay identically; `node_modules` was not installed
when this was written, so whether upstream exposes `toolChoice` at all is
unverified and does not matter.

`and` and `or` learn the third value with the obvious ordering: for `and`,
`Stop` beats `Final` beats `Continue`; for `or`, the reverse. Pinned by a
truth-table test.

The combinator that produces it:

```ts
/** When the inner policy stops while the model still wanted tools, take one final turn. */
AgentLoop.withFinalTurn(inner)
```

It maps `Stop` to `Final` only when `state.toolCalls.length > 0` — the
model was cut off, not done — and leaves an idle stop alone. That is
exactly their "exhausted" case derived from `State` alone, with no
constraint bookkeeping. `limits({ finalTurn: true })` is this applied to
the composed bounds.

**d. Say why it stopped.** Their result carries `exhausted` naming the
constraint. Ours: `Stop` and `Final` become constructible with an optional
reason (`AgentLoop.stop("max turns")`; the constants stay), `RunCompleted`
gains an optional `stopReason: Schema.String`, and `AgentSubmission.Result`
carries the last run's. Optional and additive, so journals decode and
every existing event consumer compiles.

**Acceptance.** `test/AgentLoop.test.ts` (new; `Budget.test.ts` is the
model): each constructor at the boundary and one past it; the truth tables
for `and`/`or` over three values; `withFinalTurn` on an idle stop is a
plain stop; a `Final` turn sees an empty toolkit, and with an `AgentOutput` sees
only the output tool and the result's `value` is `Some` — which needs
`TestLanguageModel` to record the tool names offered on each call beside
the `prompts` it already records, a small additive change to `/testing`
made in the same pass; `stopReason` crosses HTTP and the durable journal. Each broken
once. Type-level: `limits({})` is a compile error (an empty bound is the
`and([])` footgun again), and a loop reading `elapsed` needs nothing in
`R`.

**Not this item.** A tool-call ceiling enforced at `ToolExecution` (a
policy, above); a token ceiling outside `/budget`.

### 3.2 Ship the contracts (item 3)

**Why.** `SandboxConformance` and `ChannelConformance` ship from
`/testing`, and a user with a custom sandbox or channel can certify it.
`AgentClientContract`, `DeliveryLogContract` and `NodeStoreContract` do the
same job for a custom client, delivery log or tree store — the three things
a deployment is most likely to write — and they live in `test/`. Their
"certification" package is this, published.

**What.** Move the three to `src/testing/` in the shape the two shipped
suites already have: `cases(options)` as named Effects over the service,
`run(layer, options)` returning a report, no `vitest` import (it is a dev
dependency; the runner wiring is one line in the caller's file). `test/`
keeps thin wrappers so nothing moves in CI. The `DurableSessionStore`
contract, which does not exist as a separate file, is written in the same
pass — the durable client has two SQL stores and one in-memory store, and
"they pass the same suite" is currently a sentence, not a test.

**Acceptance.** Each suite runs against every in-tree implementation from
its published entry; a deliberately wrong implementation (one per suite,
the falsification discipline) fails exactly the promise it breaks, and the
report names it. `verify:package` sees the new exports. Test code counts
as user code: no cast in the wrappers.

**Not this item.** Failpoints as a public service. `verify:durability`
already injects faults from the outside, and a failpoint API inside the
stores is a second mechanism for one job.

### 3.3 The Cloudflare host (items 4 and 8)

**Why.** This is the largest real gap and the one they lead with. Ours is
a reference app with the scripted model, durable per completed submission,
and no scheduling. Theirs is a package with a DO per thread, alarms, RPC
and a real deployment story. Two of the four steps need no account and no
category decision.

**a. History at turn boundaries.** Today the DO writes history after each
completed *submission*, so a mid-run eviction loses the run. The session's
synchronous `eventSink` already sees `TurnCompleted`, and a turn commits
atomically, so persisting at that boundary is a change of *when*, not
*what*: a lost process now costs at most the turn in flight, and the
restored session resumes a submission's history from its last committed
turn. The header comment's "mid-run process loss loses the run" becomes
"loses the turn". This does not make a run durable — the submission is
still gone and the client sees it fail — and the comment keeps saying so;
`/durable` on workerd waits on the upstream stall
(`docs/upstream/effect-workflow-on-workerd.md`).

**b. Alarms as an `AgentDispatcher`.** `/scheduling` defines the seam and
`/cluster` has the distributed implementation; a Durable Object alarm is
the natural third: `dispatch(at, input)` persists the intent to DO SQLite
and sets the alarm, `alarm()` prompts the session. One implementation of an
existing seam, in `apps/worker`, tested on workerd through miniflare as the
rest of the worker is.

**c. A published host entry — the decision.** `apps/worker` is
"reference: read it, copy it, do not import it". That is the right label
while its model is the test double. Once (a) and (b) land, the DO session
class, the router and the dispatcher are a host module a user should be
able to import rather than copy, and `/sandbox/local` is the precedent: a
host entry with its own exemption in `verify-portability.mjs`, importing
`@effect/sql-sqlite-do` and `@cloudflare/workers-types` there and nowhere
else. The lint was widened 2026-09-01 to *reject* both outside host modules,
which is exactly the machinery that lets one host module hold them. This
is the same category decision `plan-effect-cf-and-webtransport.md` §3
made ("never in `src/` — except at a named host boundary"), and it should
be made in that document's terms, not silently here. **Recommendation:**
yes, as `@doeixd/effect-agent/cloudflare`, after (a) and (b), and still
without `effect-cf`.

**d. A real deployment.** `examples/deploy-cloudflare/` is the Alchemy
stack, written and never run. Wire a real model through it and deploy from
a clean account; item 19 of `remaining-work.md` already names this and
this plan does not re-plan it, only re-ranks it behind (c), because
deploying the reference app proves less than deploying the entry.

**Acceptance.** (a) `test/WorkerDurableObject.test.ts` gains a case: kill
the runtime after turn two of a three-turn scripted submission, wake it,
and the restored history holds exactly two turns; broken once by
persisting per submission again. (b) a dispatched prompt fires after the
alarm across a runtime restart. (c) `verify:package` imports the entry
from the tarball; `lint:portability` still fails on `@cloudflare/*`
anywhere else, proved by a deliberate import. (d) the smoke that item 19
describes.

### 3.4 Typed input (item 6)

**Why.** We type the *output* of an agent and leave the input as
`Prompt.RawInput`. Their split — a full typed input that is stored and
reaches tool authorization, and an `inputPrompt` projection that is all
the model sees — is a good idea we do not have, and it is the natural
mirror of `AgentOutput`: an agent defined by the shape it must answer in
is usually also defined by the shape it is asked in.

**What.** `AgentInput.make(schema, render)` declared on the agent as
`output` is: `schema` for the value, `render: (input) => Prompt.RawInput`
(or an `Effect` of one, joining the agent's `E`/`R`) for what the model
sees. With an input declared, `session.prompt` and `Agent.run` take
`Schema.Type<I>` instead of `Prompt.RawInput`; without one, nothing
changes. The full value is exposed to tools for the life of the submission
as `AgentInput.Current`, a `Context.Reference` in the shape of
`Principal.CurrentPrincipal` — that is the "reaches authorization" half,
and it is what a `Permission` policy reads to decide by tenant or by
document rather than by the model's rendering of them. Canonical history
records the rendering; the input value is a submission-level fact,
carried on `SubmissionStarted` in its encoded form so `/export` and
`/durable` see it.

`Agent.make` grows one type parameter for it, as it did for `Value`. The
seam that does not change: `AgentClient`. A remote caller sends JSON, and
the host decodes it with the agent's input schema at the boundary
(`promptUnknown` is what their surface calls this; ours does not need a
second name, because the host is the only place that ever holds `unknown`).
Phase 1 is local (`AgentSession`, `Agent.run`); phase 2 is the host
decode; `/durable` journals the encoded value and re-renders on replay,
which is only sound if `render` is deterministic — an Effect-valued
`render` becomes an activity, and the plan says so before someone
discovers it.

**Acceptance.** `examples/typed-agent.ts` gains an input and keeps its
zero-cast, zero-annotation property, with a compile-time assertion that
`prompt`'s parameter is the schema's type; a permission rule reads
`AgentInput.Current` and refuses a call the rendering alone would have
allowed (broken once by rendering the field into the prompt); a durable
replay re-renders the journaled value and commits identical history.

**Not this item.** A per-`prompt` input schema. `AgentOutput` is on the
agent because the instructions and the schema are written together; the
same argument holds here.

### 3.5 Code mode: say what the boundary is (items 5 and 9)

**Why.** Their code mode is narrower (readonly tools, no approvals) and
safer (a fresh isolate per program, no outbound network). Ours is broader
(any tool, an `Ask` pauses the program) and runs the owned interpreter in
the host process. Both are defensible; ours does not currently tell a
reader which threat model it answers, and a reader coming from their docs
will assume the worse one.

**What, now (item 5).** A section in `/code`'s module header and the
README: the interpreter confines by *construction of the language* (a
tree-walking evaluator over a subset, no host globals, no `Function`, no
prototype access — whichever of those the interpreter actually enforces,
each pinned by an existing test; list them from the tests, not from
memory), and the *authority* boundary is `Permission`, the same decision a
direct call gets. It is not an OS or isolate boundary, and a program that
finds an interpreter bug is in the host process. Then the readonly
recipe, which needs no code: `Permission.rules([...read actions...],
{ otherwise: Permission.deny() })` on the code-mode agent gives exactly
their default, and the doc shows it.

**What, later (item 9).** The `CodeExecutor` seam was built to admit a
second engine and has been proved by one (CallScript). An executor that
runs the program in a Dynamic Worker with `globalOutbound: null`, tool
calls returning over RPC to the host's broker, is a host module in the
Cloudflare entry of §3.3c — it cannot exist before that entry does, and it
should not be the reason the entry exists. On Node there is no honest
equivalent (`vm` is not a security boundary and its documentation says
so), and this plan does not pretend one.

**Acceptance.** (5) the listed confinements each cite a test by name, and
one is broken to show the citation is live. (9) `CodeMode.test.ts`'s
executor conformance passes against the isolate executor on miniflare; a
program that reaches for `fetch` fails with the executor's own error, not
the interpreter's.

### 3.6 Rendered pages (item 7)

**Why.** `/web` gives the model search and a guarded fetch of raw bytes.
A rendered page — JavaScript run, content as Markdown, links extracted —
is what most research agents actually want, and their capture/crawl
services are the shape of it. The interactive browser is a much larger
surface and is parked (below).

**What.** Two capabilities beside `WebSearch` and `WebFetch`, provider
neutral, in `/web`:

```ts
WebCapture.capture(url, { format: "markdown" | "links" | "text", selector? })
WebCrawl.crawl(url, { maxPages, maxDepth, sameHost: true })
```

with the same bounds discipline the README's limits table already holds
`/web` to (bytes per page, total bytes, pages, depth, deadline, concurrency
— theirs caps at 100 pages, depth 10, 8 MiB per page, 64 MiB total, ten
minutes; ours states its own in JSDoc and the table). The first provider is
Cloudflare Browser Rendering's REST API — it is HTTP, so it is portable and
lives at `/web/cloudflare` with no host coupling. A local Playwright
provider is **not** in this item: it is a host module with a heavy
dependency, and `evaluation-sandbox-effect-platform.md`'s "one narrow
adapter, not a second" applies. `TestWebCapture` and `TestWebCrawl` join
`/testing`; `WebToolkit` gains the two tools with `Permission`
projections (`action: "web"`, resource the host).

**Parked: the interactive browser.** Navigate, click, fill, screenshot,
with a session handle and action caps. It is a real capability and a
large one — its own conformance suite, an elicitation story for
"uncertain outcome after a boundary" (theirs explicitly does not replay
such actions), and a provider that exists only as a host binding. Its
precondition is §3.3c; until then it would be a seam with no
implementation, which is a plan, not a package.

**Acceptance.** Both capabilities against the test doubles and against a
scripted `HttpClient`, as `test/BraveWebSearch.test.ts` does today (there
is no env-gated live test in the suite, and this item does not add one);
every bound in the table has a test at the boundary; a redirect off
the allowed host is refused. Broken once each.

### 3.7 A review example (item 10)

Their `pr-review` package is a schema-validated review with token usage
reported. Ours is an afternoon over what exists: `Presets.coding` for the
workspace, an `AgentOutput` for the review schema, `Budget.within` for the
ceiling, `Evals.tokens` to report spend, run against a scripted model in
CI. `examples/pr-review.ts`, typechecked with the rest. A package would be
a dependency on a reference, which the maturity map says not to create.

## 4. Deliberately not taken

- **The multi-package split.** Their ~15 packages enforce dependency
  boundaries by package; ours are enforced by `lint:portability` and
  `verify:package`, and a user pays one install. Splitting before 1.0
  multiplies version skew (the README's "pin everything together" warning)
  for no user-visible gain. Revisit if a host entry needs a dependency the
  root must not carry — §3.3c is the first candidate, and the answer there
  is still one package.
- **`effect-cf`.** Decided in `plan-effect-cf-and-webtransport.md` §3;
  reading their platform package changes nothing about it.
- **A required agent `id`.** Ours are values; a name attaches where
  identity matters (`DurableAgent.workflow("Support", ...)`, a host mount).
  An id on every `Agent.make` would be a string nobody reads on the
  ninety percent of agents that never leave a process.
- **`AgentRuntime.start` / `DetachedRun`.** `submit` + `awaitSubmission`
  is the detached run, and `AgentProbe` is the complete trace; adding a
  third spelling of "run without waiting" would be the "second execution
  model" the roadmap forbids.
- **Readonly-only code mode as the *only* mode.** `Permission` already
  expresses it as a policy (§3.5); making it the ceiling would remove the
  `Ask` pause, which is the feature.
- **A recovery classifier.** Theirs classifies the last committed boundary
  to pick a remediation; the Effect Workflow engine's replay is that
  classification, done by the journal. Ours has nothing to build here, and
  the DO host's non-workflow durability is stated as a limitation rather
  than papered over with a classifier of its own.

## 5. What this changes in the four root documents

Nothing until an item lands. Then, per the convention: the item's dated
section in `docs/status-history.md`, its line in `STATUS.md`'s "What
ships", its row struck through in `remaining-work.md`, and — for §3.1 and
§3.4, which touch the kernel vocabulary — a note in `STATUS.md`'s "The
kernel vocabulary has not grown since `0.0.1`" line, which stops being
true at §3.1c and should say so.

## Related

- [plan-effect-cf-and-webtransport.md](./plan-effect-cf-and-webtransport.md) — the host-boundary category decision §3.3c applies.
- [plan-deployment.md](./plan-deployment.md) §3, §7 — the Durable Object mapping and what was built of it.
- [plan-structured-output.md](./plan-structured-output.md) — `AgentOutput`, the mirror of §3.4.
- [plan-code-mode-engine.md](./plan-code-mode-engine.md) · [plan-code-mode-executors.md](./plan-code-mode-executors.md) — the interpreter and the executor seam §3.5 builds on.
- [remaining-work.md](./remaining-work.md) — where the items above are ranked against everything else.
