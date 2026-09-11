# Decisions — 2026-09-11

A record of the decisions that were open on 2026-09-11, what was decided,
by whom, why, and what was done about each. It is kept for posterity: when
one of these is questioned later, this page says what was known at the
time.

The owner delegated all of them ("use good judgement to answer the open
decisions"). The agent decided each one on the evidence below. Where a
decision needed an action, the action was taken and is recorded with the
hashes needed to undo it. The one decision that needed the owner's hands,
creating an API key (D4), the owner then declined.

The decisions were resolved in three different ways, and the reason for
each way:

* **Irreversible or outward-facing** (pushing, deleting branches, dropping
  the stash): acted on only after confirming nothing is lost. Each has an
  undo recorded.
* **Design questions whose answer the code already shows** (Q1, Q5):
  recorded as decided, with a test to follow so the answer stays true.
* **Parked items**: each is given a trigger that reopens it, so "not yet"
  can be told apart from "forgotten".

| # | Question | Decision | Done |
|---|---|---|---|
| D1 | Push `main`? Push on request, or as a standing rule? | Push. Standing rule: push once the full check passes in a clean worktree. | Pushed after the check passed. |
| D2 | Delete the merged remote branches? | Yes. | Deleted; tips recorded below. |
| D3 | Drop the 2026-08-24 stash? | Yes, keeping a copy. | Tagged, patch saved, dropped. |
| D4 | A key for the live runs? | Recommended a dedicated, capped key; **the owner skipped it.** | No key; the live measurements stay open. |
| D5 | What item 113 becomes | Keep the refusal. Child-workflow delegation is the design of record. General suspendable handlers are refused. | Recorded in item 113. |
| Q1 | Visibility per agent or per session? | A rule on the agent, applied per caller. | Recorded in the plan's §13. |
| Q4 | Projected completion from a provider-executed tool? | No. | Recorded; refused by `fromTool` in `e30f31f` (a type error, and a `TypeError` for a widened type). |
| Q5 | Does discovery count toward `maxToolCalls`? | Yes. | Recorded; pinned by a test in `40da7c6`. |
| — | Item 100's scenarios | Cold recovery against history length, and SQLite write contention, each with a threshold. | Recorded in item 100. |
| — | The two conformance cases that still race | Document `stream` for observing your own submission; the lifecycle case moves to `stream`. | Lifecycle case done (`4c5bd83`); `events()` points to `stream` in its doc. |
| — | Items 102, 112, 97 T8.2 | Parked, each with a trigger. | Triggers recorded. T8.2 was unblocked the same day: its "other agent" was orphaned work, now landed. |

---

## D1. Push, and a standing rule for pushing

**Facts.** `main` was seven commits ahead of `origin/main`:
* `7760929`, item 104's usage comparison;
* `35414be` and `b303a24`, a race in the conformance harness that had
  failed CI once on Node 22;
* `4020232`, `ba703d2` and `3e35f32`, the item 113 documentation;
* `dddee0d`, this page's first form.

`origin/main` had not moved in the meantime.

**Decided: push. From now on, push once the full `npm run check` passes in
a clean worktree at the commit being pushed.**

**Why.** Every push so far was requested one at a time, and the only effect
of asking was delay. CI is a second opinion that only helps once the code
reaches it; this week's flake was found by CI and nowhere else. The
condition is a *clean worktree* check, not a check in the shared tree,
because the shared tree holds other agents' unfinished work. A green run
there says nothing about the commits being pushed.

**Guardrails kept.** Never force-push. Never push a commit whose review
findings are still unfixed. If a push is rejected, fetch, confirm the new
commits don't touch the same files, rebase, check again, then push
(COLLABORATION.md's rule).

## D2. The merged remote branches

**Facts (fetched 2026-09-11).** No open pull requests. Each branch had no
commit that `main` lacks:

| Branch | Tip | Commits ahead of `main` |
|---|---|---|
| `audit/effect-ecosystem` | `5bf12e725835fe9739f1ffae4c1ced29b4a3e143` | 0 |
| `claude/effect-agent-comparison-uzkn1r` | `4dc442b48b5167b2401664af552c631cde23d0d1` | 0 |
| `fix/ci-review-findings` | `dc25b1c283c694e62f5c65678f60b6200f69b1e6` | 0 |

**Decided: delete.** Every tip is an ancestor of `main`, so a branch name
is the only thing lost, and a stale branch name misleads readers.
`fix/ci-review-findings` turned out to be gone from the remote already;
only a stale local tracking ref remained, and a prune removed it. The other
two were deleted.

**Undo.** `git push origin <tip>:refs/heads/<branch>`, using the tips above.

## D3. The stash

**Facts.** `stash@{0}`, "WIP on audit/effect-ecosystem", commit
`686594e88c741fbd939db8266de809121917d079`, from 2026-08-24, touching 12
files. The code has moved on too far for it to apply in either direction.
Its added lines were compared against `main`:
* the TUI rewind landed;
* the `DurableModel` encoded-parameter codec landed;
* the `SessionTree.node` lookup landed, now with an error type;
* the `WebDurable` replay test landed.

Its one change with no counterpart was a helper in `web/http.ts` that
stripped credentials from a URL before the URL went into an error. It is
superseded: `main` refuses a URL with credentials outright (`WebToolkit`,
"Use a public HTTP(S) URL without credentials").

**Decided: drop it, keeping two copies.** It is kept as a local tag,
`archive/stash-2026-08-24`, which keeps the commit safe from garbage
collection, and as a patch at
`C:\Users\Patrick\stash-2026-08-24-audit-effect-ecosystem.patch`. A stash
is shared state that every agent's `git stash` touches, and COLLABORATION.md
forbids agents from using the stash. An eighteen-day-old entry whose content
has landed is a trap for the next agent, not a record. The tag is the record.

**Undo.** `git stash store -m "restored" archive/stash-2026-08-24`.

## D4. A key for the live runs

**Facts.** Two things are measured only against a real model:
* item 93's claim that progressive exposure saves input tokens;
* `continuity-live`, a weekly workflow that skips itself while the
  `ANTHROPIC_API_KEY` secret is missing.

Everything else is measured against the scripted model.

**Decided: a dedicated key, in a workspace with a monthly spend limit of
$25, stored as the repository secret `ANTHROPIC_API_KEY`.** The workflow's
model stays `AFFE_EVAL_MODEL`, which defaults to `claude-sonnet-5`.

**Why.** Without a key, item 93's saving is only a claim, and the
continuity evaluation, the only continuous evidence that a real model holds
the thread, never runs. A key used once and never stored (the other
option) would settle item 93 but leave the weekly run with nothing. The cap
bounds the risk of a stored secret: both runs together should cost a few
dollars a week.

**Overruled by the owner, the same day: skipped** ("skip that"). No key is
created. What that leaves: item 93's input-token saving stays a claim
measured only against the scripted model, so the guide does not yet
recommend progressive exposure on cost grounds; `continuity-live` keeps
skipping itself; and item 100's live-cost half stays open. None of it
blocks other work. To reopen: create the key with a cap and run
`gh secret set ANTHROPIC_API_KEY`; the workflow picks it up unchanged.

## D5. Item 113: durable delegation with a forwarded approval

**Facts (item 113, and `DurableToolkit`'s start-marker comment).**
* A durable parent that delegates with `inherit: { approval: "parent" }`,
  to a child that needs approval, used to hang the process. It is now
  refused by name (`DurableElicitationInToolCallError`).
* The cause is structural: the child runs *inside the parent's tool call*,
  which is an activity, and an activity cannot park its workflow.
* General handler suspension is unreachable, because a handler's
  requirements are `never`. A throwaway probe, which needed a cast, showed
  the suspension coming back `Suspended` without being caught, and a
  durable sleep inside a handler not resuming within 20 s.
* The engine *does* handle one case cleanly: a workflow started from inside
  another suspends its parent through the parent-instance path.

**Decided.**
* **Now:** keep the refusal. Its message already names the two
  workarounds: ask in the parent before delegating, or give the child its
  own permission policy.
* **Design of record, built when an adopter needs it:** durable delegation
  as a child workflow. The delegating tool starts the child's own durable
  submission instead of running the child in its handler. The child's
  approval parks the child, the engine suspends the parent behind it, and
  the approval is answered against the child's execution id.
* **Refused:** general suspendable handlers, meaning `WorkflowEngine` in
  handler requirements plus a per-attempt start marker.

**Why.** The refusal is honest and costs nothing, and no adopter is blocked
by it today. Of the two real designs, the child workflow fixes the one case
that needs suspension, and nothing suspends inside a handler under it, so
the start-marker hazard stays unreachable *by design* rather than by
accident. Suspendable handlers would expose engine semantics to every tool
author: replay, attempt markers, and what a re-run handler repeats. That is
a large hazard to buy for one delegation pattern. The child workflow is
large too, so it waits for a real need rather than being started on
speculation.

## Q1, Q4, Q5: the plan's open questions (§13)

* **Q1, visibility: a rule on the agent, applied per caller.** This is what
  the code does: `ToolExposure.Visible` is `(tool, principal) => boolean`,
  declared on the agent and read from `CurrentPrincipal` each turn.
  `describe` stays a static answer about what exists; visibility narrows
  that per caller. Recording the code's answer is better than a design that
  contradicts it.
* **Q4, projected completion from a provider-executed tool: no.** The
  answer's schema has to come from a result the host controls, and a
  provider-executed result is shaped by the provider. **Done in `e30f31f`:**
  `AgentOutput.fromTool` refuses a `Tool.providerDefined` tool with a type
  error (`ProviderDefinedToolCannotProject`), and with a `TypeError` at
  construction for a tool whose type was widened to `Tool.Any`.
* **Q5, discovery counts toward `maxToolCalls`: yes.** It is a tool call,
  and `pinned` is the escape hatch for an agent that can't afford the
  turn. It already holds: `discover_tools` is an ordinary call of the turn,
  and `AgentRun` counts the turn's calls. **Pinned in `40da7c6`:** with
  `maxToolCalls(1)`, a discovery-only turn ends the run.

## Item 100: which durable scenarios to add

**Decided: two scenarios, each with a threshold, so the number decides
something rather than just being recorded.**

* **Cold recovery against history length.** Settle N submissions (N = 10,
  100 and 1000) through the durable client on SQLite. Start a fresh
  process, and time how long it takes the session to accept its next
  submission. **If N = 1000 takes more than about 1 s on this machine, item
  112 (recovery snapshots) is unparked.** Item 112 has been parked on
  exactly this unanswered question.
* **SQLite write contention.** One, two and four processes submitting to
  different sessions in one database file, reporting submissions per
  second. **Any `SQLITE_BUSY` that reaches a caller is a bug**, and gets
  its own backlog item, not a row in a report.

## The conformance cases that still race

**Facts.** `35414be` fixed the two outcome cases. The lifecycle-order and
deltas cases still fork `events()` and then prompt. Over HTTP, `events()`
is live from the moment it attaches, and nothing signals when that is. The
race is rare, but it is a real consumer's race and not just a test's.

**Decided.**
* `events()`'s documentation will say: to observe your own submission, use
  `stream`, which subscribes before admission. `events()` is for watching a
  session you are not driving.
* ~~Both cases move to a subscription that is attached before they prompt: a
  client that can resume uses `events({ after })`, and the others drain a
  first `stream` submission.~~ Corrected the same day: draining a first
  submission does not make a *later* live `events()` attach in time. The
  lifecycle-order case, which timed out in the clean check of `6fac365`,
  now takes its envelopes from `stream` (`4c5bd83`). A client that refuses
  `stream` keeps the old path, bounded by a named timeout. The deltas case
  is left as it is: it tests what an `events()` subscriber receives, and
  only a readiness signal would close its race.
* A scoped `subscribe` on the client seam is held back until an adopter
  needs something `stream` doesn't give.

**Why.** The API already has the race-free path; the gap is that nothing
says to use it. Adding a new seam method is a permanent cost, and it isn't
justified by two test cases.

## Parked items and what reopens them

| Item | Reopened when |
|---|---|
| 102, the Cloudflare AI Gateway option | An adopter asks for it. |
| 112, recovery snapshots | Item 100's cold-recovery scenario exceeds about 1 s at N = 1000. |
| ~~97 T8.2, busy refusal in the durable client~~ | ~~The uncommitted edits to `src/durable/DurableAgentClient.ts` and `src/client/*` land or are abandoned.~~ **Reopened the same day.** The owner said there are no other agents: the edits were orphaned work of 2026-09-08 (a durable `eventLog` read from the `DeliveryLog`, item 88, and a backlog reorganisation). They were reviewed, tested and landed, so T8.2 is unblocked. |
