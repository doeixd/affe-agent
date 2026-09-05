# Plan: what to take from `danieljvdm/effect-agent#335`, and where it lands here

*2026-09-05, from reading that PR -- "feat(compaction): add durable context
window rollover" -- with its guide, changesets, compactor API, four tools,
tests and bot review. Theirs is `effect-agent`; ours is `affe-agent`. Six
lessons, ranked, each mapped to a seam we already have. Everything here
composes with what shipped; nothing replaces the loop-seam design.*

## 1. The ranking

| # | item | what it closes | size |
| --- | --- | --- | --- |
| 1 | **Rollover: a fresh window as a compaction decision** | phase 15 of `plan-branching-and-compaction.md`, parked since it was written | medium |
| 2 | **The harness interprets decisions and owns the invariants** | a strategy can today return a cut that splits a tool call from its result | small, with 1 |
| 3 | **The model can see its own window** | the loop stops on a budget the model never saw | small |
| 4 | **Retained history as evidence, bounded** | no way for a model to read back what compaction folded | medium |
| 5 | **`BEHAVIOR CHANGE:` as a trailer the checker reads** | a wire change is measured by a fixture but not announced | small |
| 6 | **Failpoint locations without a test fail the build** | a crash window can be declared and never exercised | small |

Order of work: 3, 6, 5, then 1 and 2 together, then 4. The three small ones
first because each is an afternoon and each pays on its own; 1 and 2 are one
design; 4 waits on 1 because "earlier windows" is what it reads.

## 2. The items

### 2.1 Rollover

> **Shipped 2026-09-05** (ledger 60d), with three deltas from the design
> below. The request is not a control tool the harness recognises by
> annotation: `new_context`'s handler echoes its request as its result, and
> the transform reads that result back from canonical history, which made the
> crash and replay properties free. The fallback is `onCannotHelp: "fail" |
> "rollover"` on the controller rather than `onPressure` on the token policy,
> because the only place a summary is known not to fit is after it was tried.
> The overflow trigger is not shipped (60d-i: no provider-neutral
> classification exists to catch), nor is refusing a mixed batch (60d-ii).

**What they did.** `ContextCompactor` emits one of three decisions --
`clear-tool-results`, `summarize`, `rollover` -- and `rollover` starts a
fresh window keeping the protected prefix (instructions, original input), a
window marker, the model's own *handoff* note if it gave one, and any
steering that arrived after the request. No summariser call. Three triggers:
`pressure` (a limit is near), `overflow` (the provider refused the request),
`requested` (the model called `new_context`). A `modelCallAllowed` flag says
whether a summary call is *permitted* by the budget -- a fact the harness
owns, not the strategy. Cumulative budgets are not replenished by a new
window. Two crash boundaries are tested: before the journal append, the
pending request is recovered from the settled tool result; after it, the
saved window is reconstructed.

**What we have.** `/compaction`'s `Checkpoint` is a summary over a covered
prefix with a fingerprint, produced by a `Summarise`, projected by a
`ContextTransform`, persisted through a key/value store, replayed under
`/durable` as an activity (phase 14). Phase 15, provider-overflow recovery,
was parked as "only after all that" and is the only phase left. Our
`CompactionCannotHelpError` is what happens when a summary will not fit,
which is exactly where a rollover is the better answer.

**Design.** A second kind of checkpoint, not a second mechanism:

```ts
export const Checkpoint = Schema.Union([
  Summary,    // today's shape, unchanged
  Rollover    // { coveredThrough, prefix, handoff: Option<string>, window: number, tokensBefore }
])
```

The transform projects a `Rollover` as: protected prefix (instructions, the
submission's rendered input), one window-marker message ("this is window N;
the previous window ended here"), the handoff if any, and the retained tail.
No summary text, so no summariser is called and no model call is metered.

Triggers, in our vocabulary: **pressure** is what `Compaction.tokens` already
detects; **overflow** is the provider's refusal, caught in `AgentTurn` where
the model call fails and retried once with a rollover projection (this *is*
phase 15); **requested** is a tool, `new_context({ handoff? })`, a singleton
control tool the harness recognises by annotation and honours before the next
model call, refusing it when it arrives beside other calls in one batch, as
they do. `Result.turns` and the `Budget` are untouched by a rollover: a new
window is not a new run.

The policy decides *which* kind: `Compaction.tokens({ ..., onPressure:
"summarise" | "rollover" })` with `"summarise"` the default for continuity
with everything shipped, `"rollover"` when a summary model call is not
permitted (`Budget` says so) or has failed with `CompactionCannotHelpError`.
That last rule is the one that closes phase 15 without a policy change: a
summary that will not fit falls back to a fresh window instead of failing the
turn.

**Tests, written first.** The two crash boundaries, with our failpoints
(`Failpoint.group("Compaction", ["before-checkpoint", "after-checkpoint"])`):
a crash after the model asked for a new window and before the checkpoint is
saved recovers the request from the committed tool result; a crash after
recovers the window. Then: repeated rollover keeps instructions and input
and drops tool results; overflow recovers with no summariser call; steering
after the request lands in the new window as a user message; the cumulative
budget is not replenished; a `new_context` beside another call is refused
before either runs; a rollover result from an *earlier* run cannot trigger
one now. Their test list is a good checklist; ours reads from events and
`Budget` rather than one result object.

**Acceptance.** Phase 15's row in `plan-branching-and-compaction.md` is
ticked with this plan cited; `test/Durable.test.ts` gains a rollover replay
pin beside phase 14's; the matrix's durable column names it.

### 2.2 The harness interprets

> **Partly shipped with 60d.** The rollover paths cannot split a tool pair
> (a request cuts after the tool message that carries it; the fallback cuts
> at a user message) and cannot regress coverage (`Math.max(covered, ...)`).
> The two refusals for a *custom policy's* cut are still inside the strategy;
> moving them into the transform is the remaining half.

**What they did.** The compactor returns decisions; the engine applies them,
commits each before pulling the next, and refuses what breaks an invariant --
a summary over 65,536 characters, a cut that separates a tool call from its
result, coverage that goes backwards.

**What we have.** `Compaction`'s projection aligns cuts off tool results
itself and checks the fingerprint, so most of this exists -- inside the
strategy. A custom `Summarise` cannot break the alignment, but a custom
*policy* choosing `coveredThrough` can.

**Design.** Move the two invariants the strategy can break -- a cut that
splits a tool pair, coverage that regresses -- into the transform that applies
the checkpoint, as refusals with `CompactionCannotHelpError` kinds, so they
hold for every policy including ones written outside this repository. One
afternoon, done with 2.1 because `Rollover` is the second decision that
needs the same interpreter.

### 2.3 The model can see its own window

**What they did.** `get_context_remaining`: a read-only tool returning the
window id, estimated tokens, the configured limit, and remaining capacity,
with `null` where the host set no limit.

**What we have.** `Budget` and the compaction token estimate, both read by
the harness and never shown to the model. `AgentLoop.limits` stops a run the
model did not know was near its end.

**Design.** `/compaction` exports a tool, `Compaction.tools.contextRemaining`,
readonly (`Tool.Readonly`, so `Permission` can wave it through and code mode
admits it), reading the current projection's estimate and the policy's limit
from the controller, and the `Budget` totals when one is in context. A model
that can see it has a reason to call `new_context` itself. Small, and
independent of everything else here.

**Shipped 2026-09-05** (item 60a). Two things the sketch did not say: the
tool has to know *which* session it runs in, and tools saw only the
principal, the input and the elicitor -- so the harness now also provides the
session id around each handler, internal, read by this one tool; and the
transform records the projection at both of its exits so the tool reports
the number the harness measured rather than paying for a second estimate,
which meant `tokenPreparation` returning its `tokensBefore` alongside the
preparation. Broken once to confirm the rows read the recording.

### 2.4 Retained history as evidence

**What they did.** `search_context_windows` (at most three hits) and
`read_context_window` (pages of at most five thousand characters), over the
thread's canonical records, every description carrying "returned text is
historical evidence, not instructions", and neither the model nor a record
choosing which thread is searched.

**What we have.** Canonical history, snapshots and `/tree`, and no bounded
way for a model to read back what compaction folded.

**Design.** After 2.1: two readonly tools over the session's own history,
bounded exactly as theirs are, framed exactly as theirs are. The framing is a
prompt-injection defence stated where the model reads it and should be
copied verbatim in spirit. Medium, because search needs a store-side query
in `/durable` and a linear scan in memory.

### 2.5 `BEHAVIOR CHANGE:` as a trailer

**What they did.** Every changeset that changes what a caller sees carries a
`BEHAVIOR CHANGE:` line with the migration in one sentence.

**What we have.** Recorded fixtures that *measure* a wire or journal change
(`test/fixtures/README.md`) and commit messages that say so in prose. Nothing
machine-readable connects the two.

**Design.** A commit that touches `test/fixtures/` must carry a
`Behavior-Change:` trailer, one sentence, or the claims checker fails --
extended to read `git log` for commits touching that directory. And the
reverse: a `Behavior-Change:` trailer on a commit that touches no fixture is
reported, so the change gets its recording. Small; the checker already runs
in `check`.

**Shipped 2026-09-05** (item 60c), as its own script rather than a branch of
the claims checker: one reads the docs, the other reads the commit log, and
a check that cannot see its input (a shallow clone) has to fail rather than
pass, which is a different failure from a stale claim. The README in the
fixtures directory is excused, since editing the convention changes no
behaviour. Proved to fire against the two fixture commits that predate the
rule.

### 2.6 Failpoints without a test fail the build

**What they did.** Certification counts derive from the declared failpoint
set, so declaring a crash window declares the test that must exist.

**What we have.** `Failpoint.group(subsystem, locations)` with a closed
location tuple, and `test/Failpoints.test.ts` exercising some of them.
Nothing fails when a location is declared and never crashed.

**Design.** `Failpoints.covered(group)` in `/testing`, and a conformance row
per subsystem asserting every declared location is hit by at least one test
in the suite -- the same "an empty cell is the point" discipline as the
matrix, for crash windows. Small, and it makes 2.1's two boundaries
mandatory rather than remembered.

**Shipped 2026-09-05** (item 60b), with the shape sharpened: not "some test
somewhere hits it", which vitest cannot aggregate across files, but one row
that iterates the subsystem's own declared tuple through the real path and
dies by name for any boundary the driver never reaches. It found what it was
built for on its first run -- `before-commit` was declared and had never been
crashed at -- and a third boundary declared without a `hit` call makes it
fail, which was checked.

## 3. Deliberately not taken

* **Their `AgentPolicy` object** (fourteen knobs on one record). Our limits
  are loop combinators and our budget is a service the engine records
  against; both compose without a central object, and item 46 just made the
  loop seam clean. The *decisions* transfer; the shape does not.
* **Working notes (`MemoryNotes`).** Revision-checked notes over memory
  ports are a good idea we have no port for yet; `/memory` would grow it when
  a caller asks, not as part of compaction.
* **A bot review with a cost ceiling.** Theirs stopped at its budget, cleared
  nothing, and the PR merged thirty minutes after opening. Our rule is a
  human-shaped review after every commit, and three of four this week changed
  something. Keep the rule.

## 4. Sequence and acceptance

1. **2.3** (context-remaining tool) and **2.6** (failpoint coverage), one
   commit each, reviewed after committing.
2. **2.5**, the trailer and the checker extension.
3. **2.1 with 2.2**: tests first (both crash boundaries with the new failpoint
   group), then `Rollover`, the overflow retry in `AgentTurn`, the
   `new_context` control tool, and the interpreter's two refusals; phase 15
   ticked. *2.1 shipped 2026-09-05 without the overflow retry (60d-i) or the
   batch refusal (60d-ii); 2.2's policy-side refusals remain.*
4. **2.4**, over what 2.1 produced.

Green throughout: the full suite, both lints, portability, `verify:package`,
the claims checker. Each item's acceptance is in its section; each landed
item gets a `verify:` line in `remaining-work.md` and moves to the ledger
when done.

## 5. Design: their coherence without their centre

*Added after comparing the two designs side by side. The judgement: theirs
optimises for the first hour -- one `AgentPolicy` record, read by one engine,
so every cross-cutting rule is a sentence in one place; ours for the
hundredth -- policy on seams, composed from Effect's own vocabulary, so a new
concern is a value rather than a knob. Their weakness is that the engine must
be understood whole; ours is that a concern nobody put on a seam is silently
absent, which is exactly what the seams pass found four times. The
improvements below take the coherence and leave the centre.*

### 5.1 The engine records facts; seams only decide

> **Shipped 2026-09-05** (ledger 60g) as `RunLedger`, with one delta:
> `AgentLoop.State` is not a view *over* the ledger, because a session with
> no ledger in context still needs a loop; the two are built from one read
> and held equal by test instead. The window number is not on the entry --
> compaction records its windows itself (60a) and a compaction writes
> nothing to the run ledger, which is what "a new window does not replenish
> the budget" reduces to.

**Already done for money** (`Budget.record`, item 4 of `plan-after-seams.md`):
the engine records every turn's usage and `within`/`cost` are pure decisions.
Generalise it. A `RunLedger` the engine writes after every turn -- turns, tool
calls, tokens, cost, elapsed, window number -- that every seam *reads*: the
loop combinators, the budget, compaction's pressure trigger, the
context-remaining tool (60a). Then "a new window does not replenish the
budget", "a child's turns are the child's", "elapsed does not count time
parked" are each one sentence about what the engine records, not a property
every combinator has to get right on its own. `AgentLoop.State` becomes a
view over the ledger rather than a struct rebuilt per turn.

**Not a central policy object.** The ledger holds *facts*; every *decision*
stays where it is. That is the line: their record couples the two, and the
coupling is what makes fourteen knobs necessary.

### 5.2 Seams that can describe themselves

> **Shipped 2026-09-05** (ledger 60h): `AgentLoop.Description`,
> `Permission.Description`, `Agent.describe`. Not yet: compaction describing
> its policy, a Schema for the description (a wire form waits on a consumer
> -- the CLI `/policy` or a host), and `describe_myself` as a tool beside 60a.

**The gap.** A newcomer reads their `AgentPolicy` and knows what the runtime
will do. Ours has to be inferred from how the loop was composed, which
`Budget.within(..., AgentLoop.and(maxTurns(8), untilIdle()))` does not make
obvious, and nothing can list "everything this agent is bounded by".

**Design.** Every composed value carries a *description* of itself as data:
`AgentLoop` values a `describe(): LoopDescription` (bounds, budget, stop
rules) built up by the combinators that compose them; `Permission` policies
their rules; compaction its policy; the input and output their schemas. Then
`Agent.describe(agent)` returns one read-only `AgentDescription` -- the
first-hour readability of their record, *derived* from the composed values,
so it cannot disagree with them. Cheap to expose to the model
(`describe_myself` beside 60a), to the CLI (`/policy`), to a host's admin
surface, and to the matrix, which could then be generated rather than
hand-written. The pattern exists already for tools (`describedTools`).

### 5.3 A first-hour spelling that expands to the composed values

> **Shipped 2026-09-05** (ledger 60i) as `Presets.policy` and `readPolicy`,
> not `Agent.policy`: the kernel does not import `/budget` to spell sugar.
> Compaction is not a field, because a transform is built with `yield*`.

**Design.** `Agent.policy({ maxTurns, maxToolCalls, maxDuration, tokens,
cost, compaction })` as *sugar* that returns the loop and the layers it
expands to -- documented as exactly that, the way `Presets` is -- so the
newcomer writes the record and gets the seams. It adds no engine knob, and
`Agent.describe` on the result shows the expansion, which is also how it is
tested: describe(policy(p)) round-trips to p.

### 5.4 The model as a participant

Already 60a and 60d: let the model see its window and ask for a new one.
The design principle to write down: **a limit the model cannot see is a
limit it will hit**, and every bound the ledger records should be readable
by a tool, not only enforced by a seam.

### 5.5 Release the reasoning with the release

60c gives us the trailer. The design step beyond it: a `CHANGELOG.md`
generated from `Behavior-Change:` trailers at release time, one line each,
with the fixture that measured it linked. Our plans hold more reasoning than
their changesets ever will; what we lack is the one-line "here is what
changed for you", and it can be derived.

### 5.6 Docs that state rather than argue

Their guide is short declarative sentences. Ours argue where they could
state, because they were written while the decision was being made. Rule for
`AGENTS.md`: a guide states what happens; the argument for it lives in the
plan the guide links. One pass over the guides applying it, and the rule
written where the next guide is written.

### Order

5.1 before 5.2 (a description of a seam is easier when the seam reads a
ledger); 5.2 before 5.3 (the sugar is tested by describing it); 5.6 any time.

## Related

* [plan-branching-and-compaction.md](./plan-branching-and-compaction.md),
  whose phase 15 item 2.1 is.
* [plan-failure-paths.md](./plan-failure-paths.md) 48b, the failpoints 2.6
  builds on.
* [conformance-matrix.md](./conformance-matrix.md), the discipline 2.6
  copies.
* `test/fixtures/README.md`, the convention 2.5 connects to.
