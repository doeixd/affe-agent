# Cross-adapter conformance matrix

`test/HostConformance.ts` and `test/HostConformance.test.ts` (2026-08-30),
design-assessment recommendation 4. One shared `AgentSessionHost` over one
real client; one list of rows; one driver per adapter that drives each row
through *its own wire* -- the official MCP v2 client, raw A2A REST, raw AG-UI
SSE, `HttpApiClient`, `RpcClient` -- or declares, with a reason, that its
protocol has no vocabulary for it. A declaration is a row in this table, not a
skipped test: the point is that the five adapters answer the same questions,
including where the answer is "cannot be asked here".

The rows are phrased in the host's vocabulary. A driver translates a refusal
(capacity, forbidden, busy) out of whatever its protocol does -- an HTTP
status, a JSON-RPC error, a failed task, a tool result with `isError` -- into
the matrix's words, so the table compares *what happened*, not how it was
spelled.

| row | HTTP | RPC | MCP | A2A | AG-UI |
| --- | --- | --- | --- | --- | --- |
| creation | ✓ | ✓ | ✓ | ✓ | ✓ |
| continuation (the model sees the earlier exchange) | ✓ | ✓ | ✓ | ✓ | ✓ |
| capacity (`maxSessions` reached → refused as capacity) | ✓ | ✓ | ✓ ¹ | ✓ ² | ✓ |
| authorization (`Bearer forbidden` → refused as forbidden) | ✓ | ✓ | ✓ ¹ | ✓ ² | ✓ |
| interruption (a held run, interrupted, reports `interrupted`) | ✓ | ✓ | ✓ | ✓ (cancel) | declared ³ |
| idempotency (one request id twice → one run, same answer) | ✓ | ✓ | declared ⁴ | declared ⁵ | declared ⁶ |
| resumption (events after a cursor: exactly the rest, in order) | ✓ ⁷ | ✓ ⁷ | ✓ (`agent://session/{id}/events/after/{n}`) | declared ⁸ | declared ⁹ |

¹ **Found by the matrix, fixed the same day.** Every agent tool declared
`failure: Schema.String`, and Effect's `McpServer` renders a declared failure's
text only when the value is an `Error` -- so a capacity or authorization
refusal reached the client as "Tool execution failed due to an internal server
error", indistinguishable from a crash. `AgentMcp.ToolFailure` (a
`Schema.TaggedError` whose message is the reason) is now the declared failure
of all nine tools; the wire is unchanged (`isError: true`, the reason as text).

² A2A reports a host refusal as a **failed task** with the reason in
`status.message` -- the `message:send` request itself is 200. That is the
protocol's shape, not a defect; the driver classifies from the text.

³ AG-UI has no cancel. A client disconnect is the only signal, and it is not
an answer the run reports.

⁴ MCP request ids are minted by `agent_start`, not chosen by the caller; the
idempotent form is awaiting one ticket twice, covered by
`McpServerConformance`.

⁵ An A2A message id identifies a message, not a submission; a resent message
is a new task.

⁶ A `runId` names a run for the event stream; AG-UI defines no retry-safe
resubmission.

⁷ A cursor is a property of the backing: the in-process client has no journal
and refuses `after` outright, so this row runs on the durable client, where
the delivery log answers it. Every other row runs on the in-process client.

⁸ A2A streams are per task (`tasks/{id}:subscribe`); the session-wide event
cursor has no A2A form.

⁹ One AG-UI run is one SSE response; there is no session-wide cursor.

## Reading the table

- A ✓ is a test that ran the row through that adapter's wire and held.
- "declared" is a test that passed by declaration and printed the reason;
  the reason is the adapter's own limitation, stated where a reader will find
  it rather than a silently absent test.
- Two boundary properties fell out of writing the drivers and are now pinned:
  a server with a stream still open at teardown reports "All fibers
  interrupted" as the test's failure unless it drains rather than pre-empts
  (`disablePreemptiveShutdown`), and two prompts racing to open one session
  must treat `AgentSessionAlreadyExistsError` as success.


# Cross-cutting concerns against execution contexts

*Added 2026-09-04 (`plan-seams.md` item D), after a pass of tests that combine
features rather than exercise them one at a time. Every bug that pass found was
a blank cell in this table before the table existed.*

The matrix above compares five adapters answering the same questions. This one
asks a different thing: a concern that is *cross-cutting* -- a ceiling, a
policy, an identity, a lifetime -- has to keep meaning the same when the run it
governs is replayed, carried over a wire, or handed to another agent. It
usually does not, and it fails silently: the submission settles, the text reads
correctly, and the number is wrong.

Same discipline as above. A cell is a test, or it is a declaration with a
reason. **"Not tested" is written as such and is the point of the table** --
the empty cells are its output, not its incompleteness.

| concern | in-process | durable (replay) | behind a wire | delegated (subagent) |
| --- | --- | --- | --- | --- |
| token / cost ceiling | `Budget` | `BudgetCombinations` ¹ | n/a ² | `BudgetCombinations` ³ |
| run limits (turns, calls, duration) | `AgentLoop` | `LimitsUnderDurability` ⁴ | n/a ² | `LimitsAcrossDelegation` ⁵ |
| tool approval | `Permission` | `DurablePermission` | contract row | `PermissionSubagent` ⁶ |
| elicitation (a paused run answered) | `Elicitation` | `Durable` | contract row | `PermissionSubagent` ⁶ |
| principal | `Principal` | `Principal` | `PrincipalOverWire` ⁷ | `SubagentPrincipal` ⁸ |
| declared output (`Value`) | `TypedOutputRemote` | `TypedOutputRemote` | contract row | `Subagent.helper` ⁹ |
| typed input | `AgentInput` | `Durable` | contract row | `Subagent.helper` |
| cleanup on interrupt | `ToolCleanup` | `ToolCleanup` | **not tested** ¹⁰ | `Subagent.helper`, `ToolCleanup` |
| tool retry safety | n/a ¹¹ | `DurableToolRetry` | n/a ¹¹ | `SubagentDurable` ¹² |
| events resumption | n/a ¹³ | contract row | contract row | n/a ¹⁴ |
| idempotent mutation | contract row | contract row | contract row | n/a ¹⁵ |

¹ **Found here, fixed here.** A two-turn script that suspended once made two
model calls and recorded three turns of spend: the journal replayed the call
correctly, but the *loop* ran again and charged a response already paid for.
Fixed by keying each charge on `(runId, turnIndex)`; the test asserted the
wrong number until the fix landed, deliberately, so the suite stayed green
while recording a bug it could not yet fix.

² A ceiling is a property of the loop, not of the transport. No wire carries or
enforces one, and a host that wanted to would be imposing its own.

³ **Was item 52; crosses by default now.** `Budget.within` is a loop
combinator and a child agent has its own loop, so an unbudgeted child spent
through a model and was charged to nobody -- a parent capped at N could spend
without limit by delegating. the engine now records every turn against the
`Budget` in context (`Budget.record`), a child runs under its parent's unless
`inherit.budget` is `false`, and the parent's ceiling
sees the spend when the delegating turn ends. Closing it exposed a second
bug: the occurrence key omitted the session, so *any* two sessions sharing a
budget dropped the second's charges as replays. Fixed and pinned in `Budget`.

⁴ The rule the budget broke, verified positively here: `maxTurns` and
`maxToolCalls` read derived state and are replay-safe, and `maxDuration` does
**not** count the time a run spent parked. Had it, the runs a duration limit
killed would have been exactly the ones durability exists for -- parked on an
approval, or on a human who went home.

⁵ **Was "not tested"; measured, and decided the other way from money.** A
parent's `maxTurns` counts the parent's turns and `maxToolCalls` counts the
delegation as one call, however many turns or calls the child took; and a
child's own bound holds under a delegation. That is the decision, not a gap:
a turn is a fact about one run and is not fungible across agents the way a
token is, so the bound that means "this child may take at most N turns" is
on the child's loop, where it means the same thing whoever calls it. Item 56.

⁶ **Was item 53; crosses when asked to, and is loud when not.** A tool
marked `needsApproval` asks through the session's elicitation seam, and a
delegated child had no elicitor, so the request was refused and the tool never
ran -- marking a tool as needing approval disabled it, silently. Two answers
now, both tested here. Default: `Subagent.tool` refuses such a child at
construction, so the fault is found before the agent starts. Opt-in,
`inherit: { approval: "parent" }`: the child's approval is forwarded to the
parent's elicitor, announced on the parent's event stream, answered with
`AgentSession.respond` on the parent, and `detail.via` names the delegating
tool so the person is told who is asking. A child whose toolkit is resolved
per turn (an MCP-bound child, typically) declares nothing up front, so the
construction check cannot see it; forwarding is the answer for that child too.

⁷ **Was "not tested", caught reviewing this table; now a test, in both
directions.** A real agent behind a real HTTP server: the host's `subject`
mapping of its own authentication reaches the tool as `CurrentPrincipal`, a
header the client invents to assert an identity does not, and a host that
maps no subject puts nothing on the fibre however the client authenticated.
So the claim that a principal is never carried by the wire, only established
by the serving host, is read from a test rather than from the design note.
Item 58.

⁸ Verified rather than assumed. `plan-seams.md` claimed principal crosses a
delegation because a `Context.Reference` on the fibre crosses; that was read
from the mechanism, and is now read from a test.

⁹ **Was "text only"; crosses now.** `Subagent.tool` declared
`success: Schema.String` and mapped the child's result to its text, so a
child's declared `Value` reached its parent as prose. The tool's `success`
is now the child's output schema when it declares one, the parent model is
shown the value as JSON, the parent's tool record is typed by it, and a
typed child that ends without reporting is a child failure rather than an
empty answer (`plan-after-seams.md` 2.7).

¹⁰ A tool holding a process or a lock when the *connection* dies, rather than
when the run is interrupted, is a different question from the one `ToolCleanup`
answers, and nobody has asked it.

¹¹ Reissue is a property of replay. Without a journal there is nothing to
replay and nothing to reissue.

¹² Structurally insulated, and not by anyone's design: a child session absorbs
interruption, so an interrupted delegation returns partial text rather than
raising, and nothing interrupt-shaped reaches `DurableToolkit`. The corollary
is item 50 -- a parent cannot tell a cut-short delegation from a finished one.

¹³ The in-process client has no delivery log, so it **must refuse** a cursor
rather than quietly returning a live stream. That refusal is itself a contract
row, in both directions.

¹⁴ A child has no event stream of its own that a caller can subscribe to; its
events are the parent's tool call.

¹⁵ A delegation is a tool call, and tool calls are made idempotent by the
journal rather than by a request id.
