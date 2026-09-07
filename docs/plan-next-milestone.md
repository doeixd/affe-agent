# Plan: the next milestone is someone using it again

*2026-09-06. Written when the live list ran out of work one maintainer can do
alone. The question -- what should a pre-release project do next when its
backlog is empty of such work -- was put to a second reviewer (gpt-6-astra,
through the Codex CLI) with `STATUS.md`, the README's maturity map, the live
list, the dependency table and the repository's size inlined. Its answer is
taken nearly whole; where this plan departs, it says so. The plan states
decisions; the argument is in §2.*

## 1. The decision

**The next milestone is not a feature. It is one person choosing to use
`affe-agent` again after their first task.** The gates -- 2219 tests in 214
files, five typecheck configs, lint, portability, mutation checks, package
checks, smoke runs -- establish internal discipline. They do not establish
that the harness earns its complexity for a caller. An empty solo backlog is a
reasonable stopping point for implementation; it is not evidence that another
backlog needs inventing.

So: **feature expansion is frozen** until the three items below have produced
an observation, and the operating rhythm changes from closing implementation
items to reviewing one observation from actual use per week. Every proposed
addition names the caller, the observed obstacle, and the outcome that would
justify keeping it.

## 2. The three items, ranked

### 2.1 A daily consumer, and recruitment around that exact job (item 63)

Build the maintainer's own **post-commit review assistant** as a separate
consumer of the packed library. The job already exists in this repository's
workflow -- every commit is reviewed after it lands -- so usefulness has a
baseline to compare against. It is given a commit and review instructions;
it inspects the diff, reads the source and tests it needs, and returns
findings with evidence; the maintainer can challenge a finding through a
follow-up and interrupt a bad investigation. Application policy stays in the
consumer; the reference coding agent is reused where it fits.

What it exposes: whether sessions, tool failures, context management, typed
results, permissions and spend limits compose in ordinary work -- and the
thing no smoke run can show, whether the maintainer keeps reaching for it.

*Measure:* reviewed commits, setup interventions, accepted findings, false
positives, and the times the maintainer abandons it for the old way. Not tool
calls, not features exercised.

*In parallel:* invite five Effect users who maintain repositories and already
use coding agents, with a specific trial -- review one of their commits, then
adapt one tool or policy themselves. A Cloudflare account is a prerequisite
only for someone whose job needs Cloudflare.

*First slice:* one commit adding the review consumer with one complete
diff-to-findings path on an available provider. Its observable is a review of
the next real commit beside the current review. *Wrong if* it merely
duplicates the existing agent workflow without saving effort or improving the
review; then pick another recurring task or stop, and do not build a review
platform to compensate.

### 2.2 Observe a newcomer before touching the docs (item 64)

Recruit someone comfortable with TypeScript, preferably Effect, who has never
seen the repository. Start at the README; run an agent; add one tool; handle
one failure. The maintainer watches silently until the participant asks.
Record time to first result, every detour, every unexplained term, every
install failure, every rescue. Keep provider-account friction separate from
library friction but record both: the newcomer experiences the whole journey.

Seven guides and forty plans are not excessive in themselves; placement is
what matters. A newcomer should not need the project's history to find the
supported path. The README keeps one obvious route to a working agent with
exact dependencies, expected output and a next step; the package map stays
as reference.

*First slice:* one commit making that single route explicit and adding a
short audit checklist to the getting-started material. *Wrong if* the
participant completes the existing route easily -- then the "documentation
wall" was speculation, and restructuring stops. If nobody can be recruited,
that is recorded as missing evidence, not filled in with a fresh AI context.

### 2.3 Review the public promises, the broken one first (item 65, done)

Forty-five subpaths are a warning to inspect ownership and obligations, not a
number to reduce. Optional transports and host dependencies have reasons to be
separate; merging them would undermine the design stance. The review is
timeboxed: for each entry point, the caller's job, the dependency boundary,
the maturity, the evidence of intended use; accidental exports and duplicate
spellings go, coherent optional batteries stay provisional.

The sharper finding the reviewer pulled out of the evidence was the one
promise already known to be broken: `DurableAgent.workflow(...).layer` typed
its requirement as `never` while resolving `LanguageModel` at runtime, and
`STATUS.md` had carried that as "known, deliberately left" for a week. **Fixed
2026-09-06**: the layer is annotated with the requirement the runtime has
(`WorkflowEngine | LanguageModel`), and `test/DurableTypes.test.ts` holds it by
assignability -- a layer requiring nothing is assignable to anything, so
removing the annotation flips the first assertion. The rest of the review is
item 65's remainder, run only after 2.1 has a caller to say which promises
matter.

## 3. Decided beside the three

- **Dependency risk (item 66, done).** Effect's own guidance is that
  ecosystem packages share coordinated versions and `unstable` modules can
  break in minor releases, so the exposure is every unstable module used, not
  the AI ones alone, and waiting for Effect 4 GA does not remove it. The
  README already tells a consumer to pin exact versions; the published peer
  range for `effect` admitted every 4.x, which said the opposite. **Narrowed
  2026-09-06 to the release-candidate line the repository is tested against**
  (`>=4.0.0-rc.111 <4.0.0`); GA is admitted when it has been tested, by a
  deliberate change, not by the range. Upstream is upgraded deliberately, with
  the consumer and the fixtures as acceptance; a project to insulate the
  library from Effect is refused unless breakage becomes repeated and costly.
- **Hardening.** Targeted, after 2.1 has defined a realistic workload:
  cancellation during outstanding tools, memory after settled work, oversized
  tool output, provider throttling and stream interruption, retries around
  side effects. A broad stress campaign is refused now; a demonstrated leak,
  duplicate effect or corruption moves the relevant hardening to first place.
- **Journal compatibility (item 67).** A `Behavior-Change:` trailer records
  intent; it does not establish compatibility. Before a new version is
  consumed by anyone, the project states whether cross-version replay of a
  durable journal is supported. If it is, a prior-version journal is a
  recorded fixture replayed against the candidate; if not, an incompatible
  journal is detected and refused clearly. Decided when 2.1 produces a journal
  worth keeping.
- **Release.** "Still version zero" is not a release criterion, and the
  project already has a tag. The owner's "not yet" changes when: one outsider
  has completed installation and a modification, the daily consumer has
  survived a working week, dependency versions are reproducible, and the
  journal promise above is explicit. None of that needs every battery to have
  a caller. A stability claim waits for repeated outside use.

## 4. What stops

Importing peer projects' feature lists. Expanding callerless batteries.
Reopening closed items without their written trigger. Adding gates without a
concrete failure hypothesis. The existing checks stay. A quiet list while
recruitment is pending is the correct state, not a problem to fill.

## Related

- `docs/plan-two-decisions.md` §4, the consultation that closed the parked
  list and named this as the question after it.
- `docs/remaining-work.md`, items 63-67.
- `STATUS.md`, whose "known, deliberately left" list lost the erasure entry.
