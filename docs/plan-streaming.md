# Plan: streaming -- consumable and complete, not "added"

*2026-09-06. The owner asked whether streaming should be added to core. It
already is: a prompt asks for it, the turn joins the provider's stream back
into one response so a streamed turn commits exactly the history a batched one
does, and typed events carry the deltas. What was missing was consumption and
coverage. This plan records the design, decided after a second reviewer
(gpt-6-astra, through the Codex CLI) argued with five proposals with the facts
below inlined; its corrections are marked. P1 shipped the same day.*

## 1. What streaming is here (the facts the design rests on)

- **Request-scoped.** `session.prompt(input, { stream: true })`. The same
  `Agent` serves batch and streaming; streaming is a property of the request.
- **Joined, not forked.** The turn runs `LanguageModel.streamText` through a
  fold over `streamAccumulator`, producing one `GenerateTextResponse`; canonical
  history is atomic per turn either way. Execution plans wrap the stream.
- **Events, in the correlation envelope.** `MessageStarted`, `MessageDelta
  { kind: "text" | "reasoning", delta }`, `MessagePartCompleted`,
  `MessageStreamCompleted` / `MessageInterrupted` / `MessageFailed`; tool
  lifecycle including `ToolCallProgress` (preliminary results); turn and
  submission boundaries. A file part is announced whole.
- **Tolerant wire.** An unknown event tag decodes as `UnknownEvent`; adding a
  tag is additive for older consumers, widening a literal in an existing event
  is not.
- **Partial tool arguments are dropped.** The accumulator ignores
  `tool-params-start/delta/end`: the harness executes the assembled call, never
  a partial one.
- **The bus is unbounded.** A synchronous `eventSink` (the journal, the
  Durable Object host) sees every envelope in order before the prompt reports;
  observational subscribers each get an unbounded queue.
- **Remote:** `events({ after })` over SSE, gapless by journal cursor.
  **Durable:** chunks live from inside the journalled activity; a replay
  re-expresses the journalled response as one delta per part.
- **Subagents:** approvals forward to the parent's bus; a child's deltas and
  tool events do not.

## 2. The framing

Streaming already belongs to the kernel as request-scoped execution with
correlated observations and atomic commits. The remaining work is composable
consumption and event coverage; none of it justifies a streaming mode, a
second agent type, or an engine option. (Reviewer's framing, taken whole.)

## 3. Decisions

### P1 -- one submission as a stream (shipped 2026-09-06)

`AgentSession.stream(session, input, options?)`: submit with `stream: true`,
then that submission's envelopes through its terminal, then end. Derived from
`submit` and the bus; no new event, no new mechanism. Kernel, not a subpath,
because correctness needs the bus's subscription seam: **the subscription is
registered before admission**, so a run that finishes in the same tick cannot
lose its first envelopes. *Departure from the reviewer's "put it under a
streaming subpath, add session sugar later"*: the race it named as the thing a
hand-rolled version gets wrong is only closable with the internal seam, so the
function lives beside `events`.

Decided with the reviewer:

- **The terminal is data.** `SubmissionFailed` and `SubmissionInterrupted`
  are yielded and the stream ends normally: observing the outcome succeeded;
  one outcome has one representation. The error channel carries only what
  `submit`'s does (admission, a typed input's rendering). A caller who wants
  Effect failure semantics uses `prompt`.
- **Envelopes, not a second union.** A "delta | tool | done" sum would
  duplicate the protocol, shed correlation, and need exceptions for
  permissions, elicitation, unknown events and delegation.
- **Cold.** Each evaluation submits once. Ending the consumer releases the
  subscription only; the submission keeps running; `interrupt` stops it. The
  same rule must hold remote, or closing a tab changes execution semantics by
  deployment.
- **Ends free.** The terminal is published before the session releases the
  submission, so the stream ends only once `awaitSubmission` settles: "the
  stream ended" means "the session is free". Found by the row that prompted
  again immediately and was told `Busy`.

Invariants held by `test/Streaming.test.ts`: first envelope
`SubmissionStarted`, last the submission's terminal, one submission id,
strictly increasing sequences (not contiguous: other events are filtered);
exactly the bus's envelopes for that submission and no other's; a failed run is
`SubmissionFailed` then a normal end; two evaluations are two submissions;
admission failure is the error channel. Broken once: removing the terminal cut
hangs every row. Two properties are **by construction and not proved by a
row**, said here rather than claimed: subscribe-before-submit (in-process
scheduling publishes nothing before the receipt returns, so the swapped order
passes too) and the submission filter (nothing of another submission can arrive
inside the window once the terminal cuts it).

*Next slices:* the remote mirror on `RemoteSession` -- a cursor known to
precede the submission, then replay-and-live from that cursor over SSE, with
reconnection that observes without resubmitting and reports expired retention
as an observation error; and a text-only convenience that deliberately
translates an unsuccessful terminal into a failure.

### P2 -- partial tool arguments as an additive event (shipped 2026-09-06)

`ToolCallDelta { id, name?, delta }`, raw argument fragments from the
accumulator's `tool-params-*` branch, in the ordinary envelope. A new tag, not
a new `MessageDelta.kind`. Execution unchanged: the assembled call in
`MessagePartCompleted` is authoritative.

Reviewer's corrections, taken: the invariant "no fragment without a matching
assembled call" is impossible under cancellation. The right ones: every
fragment belongs to an open message attempt and a stable call id; on a
successful message every announced argument stream has an assembled call;
failure or interruption may abandon one and consumers discard its provisional
state; no fragment follows the call's completion or its message's terminal;
fragments never trigger execution, approval, history writes or typed-output
success. Failover must close the abandoned message and open another; provider
ids reused across attempts must never merge -- if the current pairing cannot
express that, fix correlation before shipping this. Partial-JSON parsing stays
out: a later battery may offer an explicitly provisional representation, and
never advertises the final output type for a repaired preview.

*Shipped as:* schema and emission only. `ToolCallDelta { id, name?, delta }`
from the accumulator's `tool-params-*` branch, the name carried from the start
part to its deltas by id and forgotten at the end part; a fragment for an
unannounced stream has no name rather than a wrong one. Rows: fragments in
order before the assembled call, concatenating to its arguments, inside the
message, with the batched run's history and one execution; interleaved streams
kept apart by id; a message failed mid-arguments leaves the fragment, a
`MessageFailed`, no `ToolCallStarted`, no execution, no history; the wire round
trip with and without a name. Broken once by silencing the emission and once by
dropping the name tracking; both bit. The failover gate is met by construction
and was not needed: `withPlanStream` sets `preventFallbackOnPartialStream`, so
a provider that has emitted any part cannot be replaced within the message, and
a reused id across attempts cannot arise; the reviewer's "merge" case is
therefore not a fixture. Durable live streaming carries the fragments
unchanged, because the durable model re-emits raw provider parts; a replay has
none, as it has no live chunking either. No fixture was recorded, so no
`Behavior-Change:` trailer was required; the tolerant decoder's additivity is
already held by its own rows.

### P3 -- a child's events on the parent's stream (shipped 2026-09-06)

Opt-in, as a composable value on the child-construction seam; `Inherit.events:
"parent"` may be shorthand. A wrapper event `DelegatedEvent { tool, toolCallId,
envelope }` carrying the untouched child envelope (the child's session id is
inside it; not duplicated), published through the parent's bus so it gets
parent correlation, a parent sequence, and the journal. Compose the child's
existing sink, do not replace it. Nested delegation wraps per opted-in edge. A
child terminal never terminates the parent submission. Approvals already
forward through elicitation and are not duplicated. Default off until a UI
demonstrates the expectation.

*Shipped as:* `Inherit.events: "parent" | "none"` (default `"none"`). The
harness provides `ParentEvents` around each handler, bound to the parent's
bus, correlation and call, the way it provides `Elicitation.Current`; a child
that forwards is made through the engine constructor with that as its
`eventSink`, so the sink is synchronous and sees the child's `SessionStarted`
onward. `DelegatedEvent` carries the envelope through `Schema.suspend`, which
made the envelope schema recursive; its Type and Encoded are written out as
interfaces and held equal to the schema's own by a row. `toWire` recurses into
the wrapped envelope. Rows: wrapper correlation and sequence, the child's
envelope untouched, inside the call, the parent's one terminal; default and
`"none"` forward nothing; nested wraps per edge across three sessions; a child
made outside any handler forwards nowhere; wire round trip with an unknown
inner tag as `UnknownEvent`; the projection reaching inside. Broken once by
dropping the harness provision and once by dropping the projection's
recursion; both bit. The one identifier added, `internal/ParentEvents`, is in
the namespace manifest; the trailer records that nothing on the wire changed
for a caller who does not opt in.

### P4 -- retention, measured before bounded (item 70)

A real retention risk, not an urgent throughput one: an abandoned subscriber
lives indefinitely. Measure retained bytes, lag and teardown under a
deliberately stalled subscriber. A downstream buffer cannot bound an upstream
unbounded subscription; sliding raw deltas corrupts text and JSON. If bounds
are needed, a bounded observation seam that disconnects a lagging consumer
explicitly and lets it resume from the journal. A demonstrated memory failure
moves this above P2.

### P5 -- adapters (item 71)

A2A: artifact updates with append and final-chunk semantics, mapping
user-visible text into stable artifact identities with explicit replacement
for abandoned attempts. MCP: progress notifications, honestly; incremental
output only under an agreed extension. Both after P1-P3.

## 4. What a streaming design usually gets wrong (kept as rules)

- **Replay identity.** Resumed delivery of recorded envelopes and regenerated
  observations from a journalled response are different promises. Never append
  a replay's whole-part delta onto an already displayed live prefix without
  deduplication or replacement semantics.
- **`MessageStreamCompleted` precedes tool execution and the turn's commit.**
  A UI that shows the message as done is showing provisional work.
- **Sink failure** and **commit-versus-terminal ordering** are specified
  facts, not accidents; P1's "ends free" rule is one of them.

## Related

- `docs/guide-sessions.md`, "Streaming".
- `docs/remaining-work.md`, items 68-72.
- `test/Streaming.test.ts`, "one submission as a stream".
