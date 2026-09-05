# Plan: two decisions that are the owner's

*2026-09-05. Written because both questions came up twice this week and were
deliberately not decided in passing. Each section states the question, what
turns on it, the options with their costs, and a recommendation. Nothing on
the live list is blocked on either; both get worse the longer they wait,
because more code is written against the current answer.*

---

## 1. Should any wire tag or persisted key derive from the package name?

### The question

Every identifier this package mints that outlives a process or crosses a
wire carries the package name. Measured today:

| kind | count | examples |
| --- | --- | --- |
| error tags, service keys, schema brands | 109 distinct | `affe-agent/relay/RelaySupersededError`, `affe-agent/CurrentPrincipal`, `affe-agent/SessionId` |
| SQL table defaults | 7 | `affe_session`, `affe_delivery`, `affe_elicitation`, `affe_state`, `affe_channel_input`, `affe_session_directory`, `affe_permissions` |
| persisted key prefixes | 1 | `affe-agent:compaction:` |

The package was renamed once already (item 55 is what the rename made
visible). Every one of these identifiers changed with it, and each was
*orphaned* rather than broken: a fresh empty table beside the old one, a
checkpoint that is not found, a relay error the other side does not
recognise. All are overridable at construction, so no migration was owed --
but "point your deployment at its old data by hand" is a cost paid by every
deployment, and it recurs on every rename.

### What turns on it

- **Item 55, second half.** Two nodes on different package names disagree at
  the decode layer before any check runs. The relay's terminal decision now
  follows its error classes, so it cannot desync *within* a version; across
  two versions it cannot work at all until the tag is stable.
- **Every journal, claim and table.** A rename orphans stored data unless the
  table defaults are pinned by the caller.
- **Every consumer that switches on `_tag` over a wire** -- the CLI, the TUI,
  the MCP and A2A adapters' error mapping, `AgentEvent.failureFromCause`.

### The options

**A. Keep deriving from the package name.** Status quo. Mixed-version
deployments are unsupported, and each rename is a documented breaking change
with the override knobs as the migration. *Cost:* the next rename repeats
this week; the theoretical protection against another package's tags
colliding on a shared wire is kept. *Honest about:* pre-release, and renames
are rare.

**B. One stable namespace, chosen once, never renamed.** A single constant in
one module -- say `internal/namespace.ts` exporting `NAMESPACE = "agent"` and
`TABLE_PREFIX = "agent_"` -- from which every tag, key, brand and table
default is built, with a `verify: no-grep` that no literal `"affe-agent/`
remains outside that module. The constant is *not* the package name and is
documented as a wire-level identifier that will not follow a rename. *Cost:*
this is itself a wire and journal change now (109 tags, 7 tables), the last
one of its kind; recorded fixtures before and after, and old data orphaned
one final time. *Buys:* the question never comes back.

**C. B, plus a tolerance window.** Decoders accept the previous namespace for
a deprecation period, so a mixed deployment during the switch keeps working.
*Cost:* every `Schema.TaggedError` and brand gains a second accepted tag, or a
pre-decode rewrite step at each boundary; a real amount of code for a
pre-release package whose users can switch atomically. *Buys:* zero-downtime
switching, which nobody has asked for.

**Rejected outright:** unprefixed tags (`RelaySupersededError` bare). Effect
recommends namespacing precisely because tags meet other packages' tags in a
union on a shared wire; the namespace is the point, only its *source* is the
question.

### Recommendation

**B.** The argument against it is that it is a wire and journal change; the
argument for it is that it is the *last* such change, and the alternative is
one per rename forever. It is cheapest now: no external client exists yet,
the fixtures convention (`test/fixtures/README.md`) is exactly the discipline
for it, and the checker can enforce "no literal package name outside one
module" from the day it lands. If you take A instead, the useful thing to do
is say so in `STATUS.md`'s "deliberately not done", with the override knobs
listed, so the next rename is a documented procedure rather than a
rediscovery.

### Acceptance, if B

- `grep -rn '"affe-agent/\|"affe_\|"affe-agent:' src` finds exactly one file.
- Recorded fixtures: one wire request and response, one durable journal, one
  event log, before and after; each asserted "identical except the namespace".
- `verify: no-grep "\"affe-agent/" src/relay/RelayClient.ts` and its siblings
  in the live list, so a literal that creeps back fails the build.
- Item 55 closes; the relay's cross-version case is a decode fixture with two
  namespaces, one of which is now impossible to produce.

---

## 2. Should an interrupted delegation tell its parent it was cut short?

### The question

A child session absorbs interruption by design: `Agent.run` returns with
whatever was committed before the cut, `Result.status` is `"interrupted"`,
and `Subagent.tool` maps the result to its text (or its declared value). So
when a parent run is interrupted mid-delegation and the interruption reaches
the child, the parent's model is handed the child's *partial* text as the
tool's answer, indistinguishable from a finished one. Recorded as item 50
(`test/SubagentDurable.test.ts`, "an interrupted child answers with what it
had, and the parent is not told"); the matrix's footnote 12 notes the same
absorption is what insulates a delegation from durable reissue.

### What turns on it

- **What the parent's model sees** on a path nobody has complained about.
  Today: a shorter answer. Any change: a failure string, or an annotated
  answer, on every interrupted delegation.
- **Whether a partial answer is ever useful.** A research child cut short
  after two of three lookups has two lookups' worth of findings; a child that
  was mid-sentence has half a sentence.
- **The `onError` contract.** Under `"return"` a child *failure* reaches the
  parent as a string on the tool's failure channel; under `"die"` it kills the
  parent. An interruption is neither today.

### The options

**A. Leave it.** A partial answer may genuinely beat none, the behaviour is
recorded in a test and a matrix footnote, and nothing has asked. *Cost:* the
parent's model reasons over an incomplete answer as if complete. *Honest
about:* when the *parent* was the one interrupted, its own run is ending too,
so the model rarely gets to reason over it at all.

**B. Treat a cut-short child as a child failure.** `Subagent` checks
`result.status === "interrupted"` and, under `onError: "return"`, hands the
parent a failure string ("the delegation was interrupted after N turns; it
had said: ...") that carries the partial text; under `"die"`, dies. *Cost:*
the partial text moves from the success channel to the failure channel, which
is a different tool result part and reads differently to the model. *Buys:*
the parent can tell, and the existing `onError` contract already says what
happens next. Fits the durable story: a reissued delegation is then a retried
failure, which is the shape `DurableToolkit` already handles.

**C. Return the partial answer, marked.** The success value stays a success
and gains a visible marker (a prefix line for text; for a declared output,
the value cannot be marked and B is forced). *Cost:* two behaviours depending
on whether the child declares an output; a marker in prose that a model may
or may not read. *Rejected* for that asymmetry.

**D. Surface it in the event stream only.** `ToolCallSucceeded` cannot say
"but the child was interrupted" without a schema change, and the model would
still not know. *Rejected*: it informs the host and not the party that acts.

### Recommendation

**B, but only when it matters, which is a small fix to state first.** The
case where the parent's model actually reasons over the partial answer is a
*child-only* interruption -- the child's own loop stopping it, or a timeout
on the delegation -- not the parent being interrupted, where the parent is
ending anyway. So: `Subagent` reports a cut-short child as a failure carrying
the partial text, through the `onError` contract that already exists. The
test that records the surprise becomes the test that asserts the decision,
and footnote 12 in the matrix is updated: a cut-short delegation now reaches
`DurableToolkit` as a failure, so the reissue question it was insulated from
is asked -- and answered by `Tool.Idempotent`, as for any tool. If you take A
instead, nothing needs to change; the recording is already honest.

### Acceptance, if B

- `test/SubagentDurable.test.ts`'s item-50 row asserts a failure carrying the
  partial text, in both `onError` modes.
- The matrix's footnote 12 no longer says "structurally insulated"; the
  retry-safety cell for the delegated column names the test that shows a
  cut-short delegation reissued or not according to `Tool.Idempotent`.
- Item 50 moves to the ledger.

---

## Related

- `remaining-work.md` items 55 and 50 point here.
- [plan-after-seams.md](./plan-after-seams.md) 2b.5 and §3, where both were
  first deferred with reasons.
- [test/fixtures/README.md](../test/fixtures/README.md), the discipline
  decision 1B would use.
