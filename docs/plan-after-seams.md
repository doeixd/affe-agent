# Plan: what the seams pass left behind

*2026-09-04, written the evening `plan-seams.md` closed. Each item here is
something that pass tripped over rather than an idea about the design; the
evidence is named, and where it is a test it is in the tree.*

## 1. The ranking

| # | item | why it is here | size |
| --- | --- | --- | --- |
| 1 | **Ids carry their session** | two bugs in one day from ids unique only within a session | small |
| 2 | ~~**Refuse at construction, at the top level too**~~ | **withdrawn**: the premise was wrong, see §2.2 | -- |
| 3 | **Item 46: every agent has an input** | E showed the exact shape of the cost; three inlined helpers, one un-runnable alias | large |
| 4 | **The engine records usage; the loop only decides** | `Budget.charge` is a patch for the loop being per session | medium |
| 5 | ~~**Name what a tool can see of its session**~~ | **shipped**: `guide-sessions.md`, "What a tool can see of its session" | small |
| 6 | **The static toolkit is the common case; say so in the type** | `Declared` reattaches what the lowering erased | medium |
| 7 | ~~A typed child returns its value~~ | **shipped**; the matrix's "text only" cell is a test | small |
| 8 | `remaining-work.md` is 1600 lines | the checker keeps it honest, not readable | small |

Order of work: 1, 2, 3, 4, then the rest. 1 and 2 are cheap and each closes
a class of bug rather than an instance; 3 is the large one everything after
it gets cheaper for; 4 is the redesign that 1 and 3 make clean.

## 2. The items

### 2.1 Ids carry their session

**Evidence.** Both bugs found closing `plan-seams.md` B had one root. Run ids
are `run-N` per session, so a budget shared across sessions dropped the
second session's charges as replays (`Budget.test`, "two sessions sharing one
budget"). Elicitation ids are `submission-N:elicit-M` with both counters per
session, so a child's first forwarded approval had exactly the parent's first
id and the elicitor kept one waiter (`PermissionSubagent`, "distinct ids").
Each was fixed with a local prefix, which means the third one is waiting.

**The inconsistency is already half-resolved.** `DurableSessionStore` mints
`${sessionId}:submission-N`; the in-memory session mints `submission-N`. So
the durable path was never exposed and the in-memory one was, and the fix is
to make the in-memory default match: submission ids and run ids are
qualified by the session that minted them, in `internal/ids.ts`, and
elicitation ids inherit it through the submission. Then the two local
prefixes -- the session in `Budget.occurrence`, the child session on a
forwarded elicitation id -- are deleted, because the ids they were
protecting are unique by construction.

**Not changed:** session ids themselves (`session-N` in process, the caller's
or a UUID under durable), the `submissionIds` override, and the shape of an
elicitation id relative to its submission, which `Ids.elicitationId` promises
to callers who answer without having watched.

**Acceptance.** `Budget.occurrence` is `${runId}:${turnIndex}` again and the
two-session test still passes; `forwarded` in `Subagent` does no id
rewriting and the collision row still passes; every test that pinned
`submission-1` or `run-1` pins the qualified form or a shape.

**Shipped 2026-09-04.** As designed. Six pins moved, and every one now
reads its session from the envelope rather than from the process counter,
which they should have anyway. One thing worth noticing: a durable caller
answering an elicitation "with nothing but the session id" now derives the
id as `elicitationId(submissionName(sessionId, 1), 1)`, which is the claim
that test makes stated exactly.

### 2.2 Refuse at construction, at the top level too

**Evidence.** `AgentSession.make` defaults `elicitation` to `Elicitation.denied`.
An agent holding a `needsApproval` tool and opened without an elicitor is
exactly the child item 53 was about: the tool is refused on every call and
nothing says so until a model reads the refusal. The construction-time check
built for `Subagent` (`unapprovable`, over `declaredTools`) is the same check.

**Design.** `AgentSession.make` refuses, at make time, an agent whose
declared toolkit holds an approval-requiring tool when no `elicitation` was
supplied. The refusal is a typed error rather than a throw, because `make` is
already an Effect and a host wiring a session is the caller who should see
it. Same limits as the subagent check: a per-turn toolkit declares nothing
and keeps the runtime refusal; the MCP-bound agent is that case, and the
answer there is the same -- supply an elicitor.

**The general form.** That is the third construction-time refusal (two
toolkits, duplicate tool names, an unapprovable child). Give it a name: one
internal `wiring.ts` that every construction path calls, so the fourth check
is a line rather than a pattern rediscovered.

**Withdrawn 2026-09-04, before any code.** The premise does not hold. The
`denied` default is documented as fail-closed, and it is *loud*: the run
fails with `ToolApprovalRequiredError` naming the tool, and
`test/Elicitation.test.ts` ("the default refuses, so nothing starts
hanging") pins exactly that. The delegation case was silent for one reason
only -- `Subagent` mapped the child's failure to a string for the parent
model -- and that is what B fixed. Refusing at `AgentSession.make` would
have broken every deliberately fail-closed session to fix a problem the
top level does not have. The `wiring.ts` idea goes with it: a module for
one function is noise. Recorded at length because a plan that overstates a
risk misdirects exactly as one that understates it does.

### 2.3 Item 46, now

**Evidence.** `plan-seams.md` E, in full. `PromptInput<Input>` is conditional
on `Input`, the conditional forces `Input` and `Value` to be invariant,
invariance makes `any` reject `never`, and that is why three test files
inlined helpers, why the conformance harness compiles only through
contextual typing, and why `Agent.Any` is a structural interface that cannot
be run. `plan-input-default.md` has the six steps; nothing in them has moved.

**What E leaves for it.** `Any` and the extractors stay; when the conditional
goes, `Any` can become the alias it was meant to be, and the
`@ts-expect-error` row in `AgentAny.test.ts` is the line that says when.

### 2.4 The engine records usage; the loop only decides

**Evidence.** `Budget.within` charges *and* decides, so a child's spend was
charged to nobody (item 52), the fix is a charge-only combinator wrapped
around the child by `Subagent`, and item 56 (limits across a delegation)
will need the same patch for the same reason. The replay rule the docs state
-- a loop combinator is a pure function of state -- is only true of `Budget`
because of a dedup set keyed on the occurrence.

**Design.** After every turn the engine records the turn's usage against
whatever `Budget` is in context, keyed as it is now, before the loop is
asked. `within` and `cost` become pure decisions over `budget.spent`, the
child charges the parent's counter because it runs under the parent's
context and nothing else, and `Budget.charge` is deleted. Limits get the same
treatment if `AgentLoop.State` grows a cross-session view of turns; that is
the part to decide, and item 56's test is what decides it.

**Rejected:** keeping the loop as the seam and threading the parent's loop
into the child. It makes the child's loop a function of the parent's, which
is the coupling `Subagent` being an ordinary tool avoids.

### 2.5 Name what a tool can see of its session

**Evidence.** `CurrentPrincipal`, `AgentInput.Current`, `Elicitation.Current`,
`Failpoint`. Each is a `Context.Reference` added when a tool needed it, each
documents its own `None`, nothing lists them, and the fourth was added
today. A fifth will be invented differently.

**Design.** The cheap one: a section in `guide-permissions.md` or its own
short guide, "what a tool can see", listing the references, when each is
`None`, and the rule (a `Reference` with a `None` default, provided by the
harness around the handler, never carried by a protocol). Not a
`ToolCallContext` service: it would couple four independent concerns into
one object for the sake of a shorter list.

**Shipped 2026-09-04** as a section of `guide-sessions.md`, with the table
and the three-part rule: set by the harness, never carried by a protocol;
independent, not fields of one object; crossing a delegation as anything on
the fibre does, with `Subagent.Inherit` as the place deliberate forwarding
lives.

### 2.6 The static toolkit is the common case

**Evidence.** `Agent.toolkit`, `tools: [...]`, `withTools` and every preset
lower a static list to an `Effect`, which erased the list until `Declared`
reattached it as a property. The per-turn form is real and rare, and
indistinguishable from the common one in the type.

**Design.** `Agent.toolkit` returns the handled toolkit *value* when the
handlers need nothing from the environment, and the `Effect` form only when
they do or when the caller asked for a per-turn toolkit. `ToolkitInput` stays
a union, `declaredTools` stays the reader, and `Declared` goes when the
static case no longer needs it. Medium because `toLayer` is where handler
requirements are discharged and the split has to follow it.

### 2.7 A typed child returns its value

`Subagent.tool` declares `success: Schema.String` and maps the child's result
to its text. A child that declares an `AgentOutput` should hand its parent
the value, typed by the child's schema: `success` becomes the child's output
schema when it has one, and the matrix's "text only" cell becomes a test.

**Shipped 2026-09-04.** `Subagent.Answer<Value>` is the type; the parent
model is shown the value as JSON; `Tool.Success` of the delegation is the
child's schema, pinned with a type-level `Equal`; and a typed child that
ends without reporting is a child failure on the tool's failure channel
rather than an empty string, which would have been the silent kind of
wrong. Two rows in `test/Subagent.helper.test.ts`.

### 2.8 `remaining-work.md` is a ledger, not a list

Closed items move to `status-history.md` under their closing date, with the
`verify:` lines that pin them as *done*; the live list keeps the open ones
and their `verify:` lines that pin them as *open*. The checker runs over
both files.

## 3. Deliberately not taken

* **Random ids.** They would end the collisions too, and they would end the
  readable event logs and the deterministic assertions the sequential ids
  were chosen for. Qualifying by session keeps both.
* **A warning instead of a refusal in 2.2.** The codebase has no warning
  channel and should not grow one for this: a session that cannot honour an
  approval is misconfigured, and misconfiguration is an error.

## Related

* [plan-seams.md](./plan-seams.md) -- the pass this follows, including the
  two bugs in §3.2 that item 1 generalises.
* [plan-input-default.md](./plan-input-default.md) -- item 46, which 2.3 is.
* [conformance-matrix.md](./conformance-matrix.md) -- items 56–58, the blank
  cells 2.4 and 2.7 close.
