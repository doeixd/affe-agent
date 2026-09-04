# Plan: deciding what happens at the seams

*2026-09-04, from a day of writing tests that combine features rather than
exercise them one at a time. Every finding below is a test in the tree, not an
impression.*

The parts of this system are well built and unusually well explained. What is
missing is a *decision* about what happens between them. Because each
cross-cutting concern reaches a boundary through a different mechanism, the
current answers are inconsistent in ways nobody chose and nothing reports.

## 1. The evidence

Four bugs and one fatal defect, found in one pass, all at composition
boundaries:

| found | what | where |
| --- | --- | --- |
| fatal | a durable agent with a declared output could not run at all | `da4fba6` |
| bug | a replayed turn is charged to the budget twice | item 51 |
| bug | a child's tokens are charged to nobody | item 52 |
| bug | a child's approval-requiring tool cannot be approved by anyone | item 53 |
| surprise | an interrupted child returns partial text as an answer | item 50 |

None is a defect *inside* a module. Each is a place where one feature's
assumption does not hold in another's context, and in every case the failure is
silent: the submission settles, the text reads correctly, and the number is
wrong.

**The delegation boundary is the sharpest example**, because the answers are
not merely absent, they disagree:

| concern | crosses a delegation? | by what mechanism |
| --- | --- | --- |
| principal | **yes** | a `Context.Reference` on the fibre, so the child inherits it |
| budget | **no** | a loop combinator, and the child has its own loop |
| approval | **no** | a session-construction option, and the child gets the default |
| declared output | **no** | mapped to `result.text` |

Three mechanisms, three answers, none decided. `Subagent.tool` being "just an
ordinary tool" is elegant, and is exactly why nobody ever had to choose.

## 2. The ranking

1. **A. The budget is wrong under replay** — a live bug, and the only one here
   that silently terminates correct work.
2. **B. Decide the delegation boundary** — the structural item; A, item 52 and
   item 53 are all instances of it.
3. **C. One accessor for an agent's effective tools** — the fatal bug was one
   caller of a set that has no single definition.
4. **D. A combination matrix** — so the next gap is a blank cell rather than an
   outage.
5. **E. `Agent.Any`, extracted from item 46** — cheap, and users hit it.
6. **F. Make `remaining-work.md` unable to lie** — it misdirected twice today.

## 3. The items

### 3.1 (A) The budget is wrong under replay

**Measured.** A two-turn script that suspends once makes **two** model calls and
records **three** turns of spend (`test/BudgetCombinations.test.ts`, pinned at
the wrong number so the suite stays honest). The journal is fine; the *loop*
runs again on replay and `Budget.within` charges a response already paid for.

**The rule this breaks, which the codebase follows elsewhere and states
nowhere:** *a loop combinator must be a pure function of the state it is
handed.* `maxTurns` reads `state.turnIndex` and `maxToolCalls` reads
`state.toolCallsTotal`, so both are replay-safe — verified in
`test/LimitsUnderDurability.test.ts`, along with `maxDuration` not counting
parked time. `Budget` reads the state but *accumulates outside it*, and that is
the whole difference.

**Design.** Make the spend idempotent per turn rather than moving where the
budget lives:

```ts
readonly spend: (tokens: number, occurrence: string) => Effect.Effect<number>
```

where `occurrence` is derived from `(runId, turnIndex)` — the same reasoning as
`DeliveryLog`'s key, which is deliberately a semantic coordinate rather than a
counter *because a counter is not stable under replay*. A second charge for a
coordinate already seen is dropped.

Rejected: journalling the spend as an activity. It is the durable-shaped
answer, and it makes `Budget` require a workflow engine, which a non-durable
caller should not have to have.

**Acceptance.** The pinned `3_000` becomes `2_000` and the comment naming item
51 is deleted. `guide-durable.md` gains the loop rule with the two examples.

**Size.** Small in `Budget`, a signature change, and a paragraph.

### 3.2 (B) Decide the delegation boundary

**The gap.** See the table in §1. Three concerns, three answers, none chosen.

**Design.** `Subagent.Options` gains an `inherit` record, and the default is
argued for rather than inherited from implementation accident:

```ts
readonly inherit?: {
  /** Default true: money is the parent's, whoever spends it. */
  readonly budget?: boolean
  /** Default "refuse": see below. */
  readonly approval?: "parent" | "refuse"
}
```

`budget: true` makes `Subagent.tool` wrap the child's loop with the parent's
`Budget` when one is in context — which closes item 52, and is the answer a
caller expects when they capped an agent *because* it delegates.

**`approval` is the hard one and deserves its own paragraph.** Today a child's
approval-requiring tool is silently dead: no elicitor reaches the child, the
request is refused, and marking a tool as needing approval *disables* it rather
than protecting it (item 53, isolated with a control). Passing the parent's
elicitor down is the obvious fix and has a real problem inside it — the
parent's user is asked to approve a tool call from an agent they cannot see,
named by a tool they did not choose.

So the recommendation is **not** to decide the policy question here, but to
stop it being silent:

* `refuse` (default) keeps today's behaviour and **fails at construction**
  rather than at runtime: `Subagent.tool` inspects the child's toolkit, and a
  child holding a tool with `needsApproval` under `refuse` is a wiring fault
  reported where `toolScoped` already reports wiring faults — before the agent
  starts, not in the middle of a run.
* `parent` forwards the elicitor, and the request carries the child's agent
  name so a human is at least told who is asking.

That converts a silent denial into either a loud one or a considered one, which
is the part that is indefensible today.

**Principal is left alone**, and the plan says so explicitly: it crosses
because a fibre reference crosses, that is the behaviour a caller wants, and
the only defect is that nothing says it.

**Tests.** The three rows in `test/PermissionSubagent.test.ts` and the two in
`test/BudgetCombinations.test.ts` already describe today's behaviour; each
becomes an assertion of the decided behaviour, and the "recorded rather than
asserted" comments come out.

**Size.** Medium. The construction-time check is the fiddly part, because it
means reaching into a child's resolved toolkit before the child has run.

### 3.3 (C) One accessor for an agent's effective tools

**The gap.** An agent that declares an `AgentOutput` has its output tool
injected per turn by `AgentTurn` and it deliberately never enters
`agent.toolkit`. Anything enumerating "the agent's tools" is therefore wrong,
and one such caller made durable agents with a declared output **fatally
broken** — the journal's response-part schema had no member for the call the
model makes, so encoding failed and the submission died with a `SchemaError`
naming a union that omits it.

I fixed that caller by threading `alsoDescribing` into `DurableModel`. That is
a patch: the set has no single definition, so the next caller will get it wrong
the same way.

**Design.** `Agent.effectiveTools(agent)` — the agent's own tools plus whatever
the harness injects — and every enumerating caller uses it. `DurableModel`'s
`alsoDescribing` becomes internal or disappears.

**First audit, before writing any code:** `grep -rn "toolkit.tools\|Object.values(.*tools)" src/`, and check each hit against the question "does this need the injected ones?". MCP tool listing and the permission projection are the two I would expect to be wrong.

**Size.** Small, plus however many callers the audit turns up.

### 3.4 (D) A combination matrix

**The gap.** Tests are organised by module, so pairs are untested *by
construction*. Every bug in §1 would have been a blank cell.

**Design.** `docs/conformance-matrix.md` already does exactly this for
adapters, including the discipline that matters most — a cell reading *"not
expressible"* with a reason is a real answer. Add a second table: cross-cutting
concern against execution context.

| | in-process | durable | behind a wire | delegated |
| --- | --- | --- | --- | --- |
| budget | ✓ | **item 51** | | **item 52** |
| approval | ✓ | ✓ | ✓ | **item 53** |
| declared output | ✓ | ✓ | ✓ | text only |
| typed input | ✓ | ✓ | ✓ | ✓ |
| cleanup on interrupt | ✓ | ✓ | | ✓ |
| retry safety | n/a | ✓ | n/a | ✓ |

Cells name the test or the item. Filling it in is the work; the empty cells are
the point.

**Size.** The table is an afternoon. The missing cells are the backlog it
generates, which is the value.

### 3.5 (E) `Agent.Any`, extracted from item 46

**Evidence, from today rather than from theory.** I could not write a test
helper over "some agent" three separate times: the conformance harness needed
`Options.agent` widened and leaked `any` into every harness's requirements when
I widened the wrong parameter; `PermissionSubagent` and `ToolCleanup` both
ended up with the helper inlined because naming the type meant writing `any`
through an invariant parameter, which erases the agent's requirements.

That is not internal tidiness. A user cannot write a function over their own
agents either.

Item 46 removes the cause and is the right fix. `Agent.Any` — an alias with
variance that actually admits the agents people have — is the part that can
land first and independently.

### 3.6 (F) Make `remaining-work.md` unable to lie

**The gap.** It calls itself the live list and misdirected twice in one day:
item 25 was fully built while its own text said four things were "still
queued", and H7's recorded fix for `ClusterMultiNode` is architecturally
impossible. Acting on either would have cost a session.

**Design.** An entry that makes a claim about code carries the check that
falsifies it, in a fenced block the doc already has room for:

```text
verify: grep -q "resolveFor" src/toolSource/Credentials.ts && exit 1
```

and `scripts/verify-remaining-work.mjs` runs every `verify:` line in `check`.
An item whose claim has gone stale fails the build that is already run.

**Size.** Small script; the work is writing the checks for the entries that
have claims, which is a minority of them.

## 4. Deliberately not taken

* **Making `Subagent` something other than a tool.** Its being an ordinary tool
  is why delegation composes with everything else for free, including the
  journal replaying a delegation as one activity. The problem is the undecided
  boundary, not the shape.
* **A global "ambient concerns" mechanism.** Tempting, and it would make every
  future concern cross by default — which is wrong at least as often as it is
  right. Approval is the counterexample: crossing silently is the current bug.
* **Fixing item 50** (an interrupted child returns partial text as an answer).
  It is a real surprise and is recorded, but a partial answer may genuinely be
  better than none, and changing it alters what a parent's model sees on a path
  nobody has complained about.

## 5. Sequence

Each step compiles, tests green, committed on its own, reviewed after
committing per `CLAUDE.md`.

1. **A**, because it is a live bug that terminates correct work.
2. **C**, because it is small and the audit may find more instances of a fatal
   class.
3. **D**, the table only — before B, so B's decisions are made against a
   visible picture rather than three remembered anecdotes.
4. **B**, the boundary decision, in two commits: the construction-time refusal
   first (loud beats silent, and needs no policy decision), then `inherit`.
5. **E**, then **F**.

## 6. Acceptance

* `test/BudgetCombinations.test.ts` asserts `2_000`, and items 51–53 are closed
  by tests that assert the decided behaviour rather than describe the current
  one.
* `grep -rn "alsoDescribing" src/` finds nothing outside `Agent.effectiveTools`'
  callers.
* The matrix has no blank cell without either a test name or a reason.
* A stale claim in `remaining-work.md` fails `npm run check`.
* The full suite, `lint`, `lint:portability` green.

## Related

* [plan-failure-paths.md](./plan-failure-paths.md) — the previous pass, whose
  48a and 48b are what made several of these findings reachable.
* [plan-input-default.md](./plan-input-default.md) — item 46, which E is the
  extractable front of.
* [conformance-matrix.md](./conformance-matrix.md) — the table D copies,
  including its "not expressible" discipline.
