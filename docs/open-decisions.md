# Open decisions — 2026-09-11

What is still undecided in this repository, and how to resolve each one. Each
entry sets out the question, the facts checked (with the date checked), the
options, a recommendation, and **who decides**. Once an entry is decided, it
moves to where its decision belongs: the plan's question list, the backlog
item, or a commit. Then it is deleted here. A settled entry left here is noise.

## How to resolve them

The decisions come in three kinds, and each kind is resolved differently:

1. **The owner's alone.** Anything that spends money, holds a credential,
   publishes, or destroys state other people may be relying on. The agent
   prepares these and does not act on them. Examples: pushing, deleting
   remote branches, dropping the stash, the API key, and which *feature* item
   113 becomes.
2. **Delegated.** The owner said "use good judgement, you decide". For design
   questions whose answer is already visible in the code, or that cost little
   to reverse, the agent decides and records the decision where it belongs.
   An objection from the owner reopens it. Examples: Q1, Q4, Q5, and item
   100's scenario design.
3. **Gated on a trigger.** The decision is deliberately "not yet", and the
   entry names the measurement or event that reopens it. This keeps a
   parked item from looking stale and from being started on a hunch.
   Examples: items 102 and 112.

A decision in the first kind can be made in one sitting: each has a
recommended answer and the exact command. The list is at the end.

---

## The owner's

### D1. Push `main`

**Facts.** Before this document, `main` was six commits ahead of `origin/main`: `7760929` (item
104's usage comparison), `35414be` and `b303a24` (the CI flake fix), and
`4020232`, `ba703d2` and `3e35f32` (the item 113 documentation). Each passed
the type check, lint, and the tests it affects. The last CI run failed on a
race that `35414be` fixes.

**Recommendation.** Push, and read the CI result as the check on the flake
fix.

**A standing decision worth making.** Until now every push has been
requested one at a time. The alternative is "push when `npm run check`
passes locally", which keeps CI closer to the tree. Both are reasonable. The
point of deciding once is that the agent then stops asking.

### D2. Delete the three merged remote branches

**Facts (checked 2026-09-11).** None of them has a commit `main` lacks:

| Branch | Commits ahead of `main` | Behind | Last commit |
|---|---|---|---|
| `audit/effect-ecosystem` | 0 | 482 | 2026-08-25 |
| `claude/effect-agent-comparison-uzkn1r` | 0 | 345 | 2026-09-02 |
| `fix/ci-review-findings` | 0 | 136 | 2026-09-08 |

**Recommendation.** Delete all three. Nothing is lost: every tip is an
ancestor of `main`. Command:
`git push origin --delete audit/effect-ecosystem claude/effect-agent-comparison-uzkn1r fix/ci-review-findings`.

### D3. Drop the stash

**Facts (checked 2026-09-11).** `stash@{0}`, "WIP on audit/effect-ecosystem",
is from 2026-08-24 and touches 12 files. It no longer applies in either
direction, because the code has moved on since. Sampling its added lines
against `main` finds its content landed, or was superseded:

* the TUI rewind is on `main`, in 12 places in `App.tsx` alone;
* the `DurableModel` encoded-parameter codec, the `SessionTree` node lookup
  and the `WebDurable` replay test are all present, apart from reformatting;
* its one change with no counterpart is a helper in `web/http.ts` that
  strips credentials from a URL before it enters an error. It is
  superseded: `main` refuses a URL that carries credentials outright
  (`WebToolkit`, "Use a public HTTP(S) URL without credentials").

**Recommendation.** Keep a patch copy, then drop it:
`git stash show -p stash@{0} > ~/stash-2026-08-24.patch && git stash drop stash@{0}`.
This is the owner's call rather than the agent's because the stash is shared
state, and the repository's rules forbid agents from moving it.

### D4. A key for the live runs (items 93 and 100)

**Facts.** Two things wait on a real model:
* item 93's live cost measurement, which checks that progressive exposure
  actually saves input tokens;
* the weekly `continuity-live` workflow, which is present and skips itself
  while the `ANTHROPIC_API_KEY` secret is missing.

Everything else is measured against the scripted model.

**Options.**
* **(a)** A dedicated key, in a workspace with a monthly spend limit, stored
  as a repository secret.
* **(b)** A key used locally, once, for the item 93 run, and never stored.
* **(c)** No key. Item 93's saving stays claimed rather than measured.

**Recommendation.** Option (a), with a low cap: tens of dollars a month
cover both runs comfortably. The weekly workflow is the only continuous
evidence that continuity holds against a real model, and (b) gives it
nothing. Only the owner can create the key or set the cap.

### D5. What item 113 becomes

**Facts (checked 2026-09-11; see item 113 and `DurableToolkit`'s
start-marker comment).**
* A durable parent that delegates with `inherit: { approval: "parent" }`,
  to a child that needs approval, used to hang the process. It is now
  refused by name (`DurableElicitationInToolCallError`).
* The root cause is structural. The child runs *inside the parent's tool
  call*, which is an activity, and an activity cannot park its workflow.
* Handlers suspending in general is unreachable today: a handler's
  requirements are `never`. It was probed, with a cast, in a throwaway test:
  the suspension comes back `Suspended` and is not caught, and a durable
  sleep inside a handler did not resume in the harness within 20 s.
* The engine *does* handle one case properly: a workflow started from inside
  another workflow suspends its parent cleanly (`WorkflowEngine`'s
  parent-instance path).

**Options.**
* **(a) Keep the refusal (status quo).** Document the two workarounds the
  error already names. Either the parent asks before delegating, or the
  child gets its own permission policy. Costs nothing, and it is honest.
* **(b) Durable delegation as a child workflow.** The delegating tool no
  longer runs the child inside its handler. It starts the child's own
  durable submission as a child workflow. The child's approval then parks
  the child, the engine suspends the parent behind it, and the approval is
  answered against the child's execution id. This is the real fix. It
  sidesteps the start-marker problem entirely, because nothing suspends
  inside a handler. Its costs: a parent-to-child link in the journal, an
  approval addressed to a child, a test matrix covering a crash at each
  boundary, and the item 104 equivalence rows. Large.
* **(c) General suspendable handlers.** Give handlers `WorkflowEngine` and
  build the per-attempt marker sketched in item 113. It is the most
  general option, and it puts engine semantics into every tool author's
  hands. No adopter has asked for it.

**Recommendation.** Keep (a) now, and pick (b) as the design of record, to
be built when an adopter needs forwarded approval across a durable
delegation. Rule out (c): what (c) would give a tool author, (b) gives the
one case that needs it, without the hazard. With (b) chosen, the
start-marker concern stays latent by design rather than by accident.

**Why the owner decides.** (b) is a feature investment of a size that
should be chosen, not drifted into. If the owner prefers to leave it to
judgement, the default is exactly the recommendation above.

---

## Delegated: decided here unless the owner objects

### Q1. Visibility: per agent or per session?

**Decided: a rule on the agent, evaluated per caller.** The code already
works this way. `ToolExposure`'s `Visible` is
`(tool, principal) => boolean`, declared on the agent and applied to
`CurrentPrincipal` on every turn. `describe` answers statically which tools
exist; visibility then narrows that list for each caller. Recording it
closes the question in the plan's §13.

### Q4. Can a projected completion fire on a provider-executed tool?

**Decided: no, as the plan leaned.** The answer schema must come from a
result the host controls, and a provider-executed tool's result is shaped
by the provider. Follow-up, not yet checked: `AgentOutput.fromTool` should
refuse a `Tool.providerDefined` tool when the agent is made, with a
named error. A test pins that refusal.

### Q5. Does discovery count toward `maxToolCalls`?

**Decided: yes, as leaned.** It is a tool call, and `pinned` is the escape
hatch. It appears to hold already: `discover_tools` is dispatched as an
ordinary call of the turn, and `AgentRun` adds the turn's `toolCalls` to
`toolCallsTotal`. Follow-up: a test so it stays true.

### Item 100: which durable scenarios to add

**Decided: two scenarios, each with a threshold attached, so the numbers
decide something.**
* **Cold recovery against history length.** Settle N submissions, which
  are 10, 100 and 1000, through the durable client on SQLite. Start a fresh
  process, and time from start until the session is ready for its next
  submission. This is the measurement item 112 is parked on: if cold
  recovery at N = 1000 exceeds about 1 s on this machine, item 112 is
  unparked.
* **SQLite write contention.** One, two and four processes submitting to
  *different* sessions in one database file. Record submissions per
  second, and any `SQLITE_BUSY` that reaches a caller. A caller seeing
  `SQLITE_BUSY` is a bug, not a number: it opens its own backlog item.

### Conformance: the two cases that still race

**Facts.** `35414be` fixed the outcome cases. The lifecycle-order and
deltas cases still fork `events()` and then prompt. Over HTTP, `events()` is
live from the moment it attaches, with no signal saying when that is. The
race is rare, and was never seen before this week. It is also a real
consumer's race, not just a test's.

**Decided.** The `events()` documentation says so: to observe your own
submission, use `stream`, which subscribes before admission. `events()` is
for watching a session you are not driving. Both cases move to a
subscription that is attached before they prompt:
* a client that can resume uses `events({ after })`;
* the others drain a first `stream` submission.

Adding a scoped `subscribe` to the client seam is held back until an adopter
shows a need `stream` does not cover.

---

## Gated on a trigger

| Item | Parked until |
|---|---|
| 102, the Cloudflare AI Gateway option | An adopter asks for it. |
| 112, recovery snapshots | Item 100's cold-recovery scenario exceeds about 1 s at N = 1000. |
| 97 T8.2, busy refusal in the durable client | The other agent's uncommitted edits to `src/durable/DurableAgentClient.ts` (and `src/client/*`) land. They carry no entry in `COLLABORATION.md`, so the next step is an entry there asking about that work, not waiting indefinitely. If it is still unclaimed in a week, ask the owner whether the edits are abandoned. |

---

## For the owner, in one sitting

1. **D1:** push? And should pushing become a standing yes once the full check passes?
2. **D2:** delete the three merged remote branches?
3. **D3:** save a patch copy of the stash, then drop it?
4. **D4:** create a capped key and store it as `ANTHROPIC_API_KEY`? What cap?
5. **D5:** item 113. Keep the refusal, with the child-workflow design (b) as the plan of record?
6. Any objection to Q1, Q4, Q5, item 100's thresholds, or the conformance change?
