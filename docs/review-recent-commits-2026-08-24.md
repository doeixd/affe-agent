# Review of recent commits — 2026-08-24

## Scope

This is a living correctness review of all changes committed today, currently
`d56c703^..7c07f9f`, plus the explicitly separated uncommitted work that was in
the working tree during the review. The review covers runtime correctness,
type soundness, Effect usage, concurrency/interruption, portability, security,
and package verification.

Severity means:

- **P0** — release/build blocker or an advertised path cannot work.
- **P1** — can violate a security, history, lifecycle, or resource invariant.
- **P2** — real contract/design defect with a narrower trigger.
- **P3** — hardening, misleading API, or missing coverage.

## Confirmed findings

### R1 — P0 — The committed Slack Web Crypto rewrite does not build

**State:** committed in `c573e9d`; reproduced.

`npm run build` fails at `src/connectors/slack.ts:123`: TypeScript infers the
parsed signature as `Uint8Array<ArrayBufferLike>`, which is not assignable to
Web Crypto's `BufferSource` / `ArrayBufferView<ArrayBuffer>` parameter. The
ordinary no-emit typecheck did not catch the declaration-build configuration,
so `npm run check` is insufficient proof that the package can be published.

This blocks `prepublishOnly`, which runs `build` after `check`.

### R2 — P1 — Permission decoding and handler decoding are two separate effects

**State:** committed in `7622988`; confirmed by inspection.

`ToolExecution.decide` decodes encoded parameters at
`src/ToolExecution.ts:170-185` and uses that value for intrinsic approval and
the permission resource. The same encoded parameters are later passed to
`Toolkit.handle` at `src/ToolExecution.ts:401-402`, where Effect AI decodes them
again for the handler.

Schema decoding is an `Effect` with a requirement channel; it is not restricted
to a pure, deterministic function. A service-backed or stateful transform can
therefore produce one decoded value for authorization and another for
execution. Even when it is pure, validation and transformation work happens
twice.

This is a permission TOCTOU defect. The permission decision and handler must
share one decoded value, or the permission contract must explicitly project
from encoded parameters and accept that limitation.

### R3 — P1 — A started tool call can be interrupted before the installed tool finalizer

**State:** committed behavior; confirmed by control-flow inspection; coverage
only exercises interruption after the handler starts.

`ToolCallStarted` is emitted at `src/ToolExecution.ts:263-268`. Parameter
decoding, permission evaluation, and interactive elicitation all happen next.
The `ToolCallInterrupted` finalizer is installed only around the handler at
`src/ToolExecution.ts:400-438`.

If a submission is interrupted while decoding, evaluating policy, or waiting
for approval, the event stream contains `ToolCallStarted` but no terminal tool
event. That contradicts the lifecycle invariant already asserted for
handler-time interruption in `test/AgentSession.test.ts:918-925`.

It also leaks observability bookkeeping and leaves projections free to display
the tool as running forever. The interruption finalizer needs to cover the
whole post-`ToolCallStarted` operation and must still emit exactly once.

### R165 — P1 — `ReturnToModel` can defect while rendering a valid typed tool failure

**State:** committed `ToolExecution` behavior; current coverage uses only a
string failure.

`failureResultPart` renders every non-`Error`, non-string failure with a raw
`JSON.stringify`. Valid Effect AI failure schemas can produce values JSON does
not render safely: `bigint` throws, `undefined`/symbols/functions return
`undefined`, and a hostile or insufficiently constrained object can be cyclic
or contain a throwing getter. This happens after `ToolCallFailed` has already
announced `returnedToModel: true`, so the promised recovery path instead
defects/fails the run and can leave history/events disagreeing about whether a
failure was returned. The comment says the tool failure schema is unavailable,
but `executeOne` has already looked up the concrete tool before this path.

Encode through that tool's declared failure schema where possible, preserving
its encoding-service requirements, then apply a total bounded diagnostic
fallback that cannot throw. If the product contract intentionally sends only
text to the model, make that conversion explicit and total rather than JSON's
partial behavior. Add `Schema.BigIntFromSelf`, `Schema.Undefined`, a tagged
error, an encoding-service-backed failure, cyclic/throwing hostile values, and
oversized failures under both policies, asserting exact terminal events,
canonical history, and whether the next model turn runs.

### R166 — P1 — Failure-to-event projection is not total over the public error channel

**State:** existing core helper, made load-bearing by today's durable audit and
synchronous tree observer.

`AgentEvent.failureFromCause` accepts `Cause<unknown>` and is used specifically
to turn arbitrary typed failures/defects into a wire-safe terminal event, but
its `describe` path can itself throw. Reading `tagged.message` invokes an
arbitrary getter; `Object.entries(error)` invokes enumerable getters and sits
outside `fields`' `try`; a Proxy can throw from enumeration; and the final
`String(error)` can call a throwing coercion. A tool, model, transform, storage
adapter, or user-defined agent error is not required to be a well-behaved
`Error`. If projection defects, the original failure is replaced and terminal
event publication/capture may never occur—the exact path durability and the
TUI rely on for cleanup.

Make the projection genuinely total: guard every reflection/coercion boundary,
use a bounded safe-inspection strategy, and retain at least a stable generic
tag/message when hostile values cannot be inspected. Test throwing
`message`/`toString` getters, enumerable getters, revoked/throwing Proxies,
cycles, bigint/symbol/undefined and deeply nested/oversized fields through real
tool, model and context-transform failures, asserting the original typed exit
and a terminal serializable event.

### R4 — Resolved — The TUI did not handle `ToolCallInterrupted`

**State:** found in committed TUI work; fixed in `ae94e4f`, which marks the
entry failed, clears its saved parameters, and adds a projection test.

Before the fix, `apps/tui/src/harness.ts` handled success and failure but had
no `ToolCallInterrupted` case. A running tool entry therefore kept
`status: "running"`. `drainSettled` only drains entries whose status is not
running, so that entry permanently blocks itself and every later transcript
entry from reaching terminal scrollback.

This occurred for an interrupt during a running handler even when core correctly
emits `ToolCallInterrupted`. R3 makes the approval-wait path worse by omitting
the core event too.

The terminal projection now marks interruption terminal and removes saved
parameters. Approval-wait interruption remains open through R3 and R25.

### R5 — P1 — `AgentSession.snapshot` has a check-then-read race with `prompt`

**State:** pre-existing core behavior, made load-bearing by the recent
`SessionTree` commits.

`AgentSession.snapshot` reads the session state at
`src/AgentSession.ts:756`, verifies it is idle, and only then reads history at
line 765. A concurrent `prompt` can atomically claim the session between those
operations and commit its user input before the history read. The snapshot then
contains the beginning of an in-flight turn even though its contract says this
state must be impossible.

`SessionTree.commit` relies on that contract for every manual node. The idle
check and history snapshot need one synchronization boundary shared with the
prompt claim/history transition; a read followed by a read is not atomic.

### R171 — P1 — Session control calls can act on a different submission than they validated

**State:** committed core behavior; confirmed by control-flow interleavings.

`steer`, `followUp`, and `interrupt` first call `requireRunning`, which reads
the current submission id, and then separately touch process-wide mutable
session resources. Nothing binds the later operation to the id that was read.
If submission A completes and submission B starts in that gap:

- stale `steer(A)` can offer into the shared steering queue after A's release
  drained it, so B consumes A's steering while `SteeringQueued` is correlated
  to A;
- stale `followUp(A)` can acquire `inputGate` after B has set
  `acceptingFollowUps`, offer into B's queue, and emit the queued event for A;
- stale `interrupt(A)` can read B's newly installed `activeFiber` and interrupt
  the wrong submission.

This is the same check-then-act class as R5, with direct cross-request effects.
Make the active-submission identity part of the atomic operation: revalidate
the exact `SubmissionId` under the same synchronization that publishes/replaces
the queues and active fiber, and serialize release/claim with those control
operations. A generation-tagged active execution record is clearer than
independent state and fiber refs. Add latch-driven tests for all three A-end /
B-start interleavings, asserting B's model input, follow-up queue, exit status,
and exact correlation/event sequence. Also test session close in the same gap.

### R6 — P1 — `SessionTree.activate` is serialized but still not interruption-safe

**State:** found across `4834258`, `7622988`, and `82890c7`. Commit `ae94e4f`
adds a semaphore and candidate-scope cleanup, but does not close the whole
interruption window.

Activation creates a manual scope at `src/tree/SessionTree.ts:699`, acquires the
reference-counted branch, attaches two consumers, then separately reads and
writes `currentScope` at lines 716-717 before closing the previous scope.

Two concurrent activations can both read the same previous scope, publish two
new scopes, close the same old scope, and leave one new scope alive and still
forwarding events. Interruption between `Scope.make` and installing the scope
in `currentScope` can likewise strand the acquired branch/subscriptions.

The TUI exposes this race because repeated Ctrl+R presses launch detached
rewind fibers without a gate. Activation needs serialization plus an
`acquireUseRelease`/`ensuring` shape for the candidate scope.

The in-progress semaphore correctly serializes competing activations. Its
`onExit` cleanup is incomplete once installation has begun, however: if the
fiber is interrupted after `currentScope` is set to the candidate but before
the previous scope is closed, the finalizer closes the candidate while leaving
`currentScope` pointing at it and loses the only handle to the still-live
previous scope. `current` may also describe either side depending on the exact
point. The small publish/swap/close commit phase needs to be uninterruptible or
must roll all three pieces back coherently.

The new concurrency test says it passes with serialization removed and then
uses a fixed number of `yieldNow`s. It therefore does not falsify the bug it is
meant to guard and is scheduler-sensitive. A latch/test seam must force the
overlap or assert permit ownership directly; AGENTS.md explicitly says an
assertion that cannot fail proves nothing.

### R178 — P2 — Session-tree tests use a polling helper that silently succeeds on timeout

**State:** committed across today's `SessionTree` test additions.

`test/SessionTree.test.ts:settle` polls `tree.nodes` for 100 `yieldNow`s, then
falls out and returns `void` even when the requested count was never reached.
Its comment says the bound turns a genuine failure into an assertion, but
there is no assertion or failure. The concurrent-forwarding and active-branch
tests similarly wait 40 or 20 yields before inspecting a mutable array, and
busy-session tests use one yield as a proxy for the model's actual `started`
signal. These are scheduler observations, not synchronization on the event the
test names, and violate the repository's deterministic-test rule.

Expose/use a `Deferred` at the capture/forwarding boundary, or consume the
exact number of envelopes through a stream sink and await its completion.
`settle` must fail explicitly if its condition is unmet; model-running tests
should await the fake model's existing `started` latch. Deliberately disable
tree recording/forwarding and confirm each test fails, then restore it. R6's
overlap case additionally needs a latch inside activation rather than any
amount of cooperative yielding.

### R7 — P2 — Custom branch session IDs can still collide

**State:** partially fixed by `ae94e4f`, which adds the branch ordinal to the
callback but still accepts duplicate returned IDs.

`SessionTree.make` accepts `sessionIds?: (node) => string` at
`src/tree/SessionTree.ts:358`, and `branch` uses that value directly at line
548. Branching twice from the same node invokes the callback with the same only
argument, so a natural deterministic callback returns the same session ID.

The tree keys `at` and `laneOf` by session ID. Colliding live sessions then
overwrite each other's cursor/lane state and can parent later commits onto the
wrong branch. Either include the branch ordinal in the callback, reject an ID
already in use, or remove this customization until uniqueness can be enforced.

Supplying the ordinal makes a correct callback possible but does not enforce
the invariant: `sessionIds: () => "same"` remains legal and still corrupts the
maps. The returned ID must be checked against live/known sessions even with the
richer callback.

### R8 — Resolved — `SessionTree.commit` reported a closed session as busy

**State:** fixed in `ae94e4f`, which adds a distinct `SessionClosed` error and
preserves the snapshot distinction.

`AgentSession.snapshot` distinguished `AgentClosedError` from `AgentBusyError`,
but the old `SessionTree.commit` mapped every snapshot error to `SessionBusy`.
The public error said the session was running when it could be permanently
closed, erasing a recovery-relevant distinction. The new typed union preserves
it.

### R9 — P2 — The Brave adapter rejects valid responses and accepts invalid queries

**State:** committed in `b575f6e`; confirmed against Brave's official
[GET](https://api-dashboard.search.brave.com/api-reference/web/search/get) and
[POST](https://api-dashboard.search.brave.com/api-reference/web/search/post)
API references.

There are three related provider-contract mismatches:

1. `WebToolkit` allows 1,000-character queries at
   `src/web/WebToolkit.ts:21-24`; Brave limits `q` to 400 characters and 50
   words. A tool-valid query can therefore receive HTTP 422 and is mapped to a
   generic response failure whose model guidance says to retry later.
2. `BraveResponse` requires a `web` object at `src/web/brave.ts:36-40`, while
   Brave declares `web` nullable. A valid 200 response with no web result set
   becomes `WebSearchDecodeError` instead of `[]`.
3. The adapter uses GET/query parameters at `src/web/brave.ts:153-165` even
   though Brave supports POST. Search queries therefore appear in URLs and
   ordinary HTTP access traces despite the package treating queries as
   sensitive outbound content.

The provider needs its own validated query error (or a stricter shared schema),
a nullable/optional web response mapped to an empty list, and POST unless a
documented compatibility reason prevents it.

### R10 — P2 — Slack freshness can be silently disabled by non-finite configuration

**State:** committed in `c573e9d`; confirmed arithmetically.

`Options.toleranceSeconds` is an unconstrained number. At
`src/connectors/slack.ts:101-103`, `NaN` makes
`Math.abs(nowSeconds - signedAt) > tolerance` false for every timestamp, and
`Infinity` intentionally or accidentally disables the replay window. Negative
values reject everything.

Because this is security configuration, the verifier should validate a finite,
non-negative bounded value when it is constructed (preferably through Config /
Schema at the application boundary).

`Effect.promise` at lines 112-126 also turns Web Crypto rejection into a defect
despite the returned effect advertising no error channel. That should either be
a typed platform/verification error or a deliberate fail-closed `false`, with a
test for a rejecting crypto implementation.

### R169 — P2 — Slack signature parsing has no fixed-size input bound

**State:** committed in `c573e9d`; confirmed by inspection.

`signatureBytes` accepts any non-empty, even-length hexadecimal suffix and
allocates a `Uint8Array` proportional to it before `subtle.verify` rejects the
wrong HMAC length. A normal HTTP server will usually impose a header-size
limit, but this exported verifier does not require such a server and its own
documentation promises ordinary `false` handling for every attacker-controlled
header shape. The HMAC-SHA256 wire format is exactly 64 hexadecimal characters,
so all other lengths can and should be rejected before allocation.

Require exactly `v0=` plus 64 hex digits. Add tests for an extremely long valid-
hex header without allocating proportionally, the exact 300-second past and
future boundaries, 301 seconds in both directions, zero tolerance, and invalid
custom tolerances. This complements R10: construction-time tolerance validation
and input-size validation are both part of keeping the verifier fail-closed.

### R11 — P2 — The span redactor cannot redact attributes supplied at span creation

**State:** committed in `75e8758`; confirmed by wrapper order.

`redactingTracer` calls `underlying.span(options)` first at
`src/observability/Observability.ts:583-585` and only wraps the returned span.
`redactSpan` can intercept later `attribute` and `event` calls, but any dropped
key already present in `options.attributes` has already reached the underlying
tracer and remains visible through the delegated `attributes` getter.

The default Effect AI leak happens to be a later annotation, so the existing
test passes. The exported general `SpanRedaction` contract is broader and is
not met. Sanitize the creation options before calling the underlying tracer and
add a test for an initially populated dropped attribute.

### R12 — Resolved — The TUI extension API made consumers cast tool parameters/results

**State:** found in `a817a76`; fixed in `ae94e4f` with a generic
`withViews(tools, rules)` API that gives rules their tools' encoded parameter
and decoded success types, with no cast in the smoke consumer.

The original `ToolView.title` and `ToolView.body` accepted `unknown`. The
advertised application extension example then used a cast to read its own
tool's `environment` parameter. That violated the repository's strongest rule:
end-user code must not need casts, and tests/examples count as user code.

The replacement registry is generic over the supplied tools, so a view
registered under a known tool name receives that tool's inferred parameter and
result types. Internal narrowing remains at the erased library boundary.

### R180 — P2 — A bound tool named `__proto__` loses its handler and defects on dispatch

**State:** committed in today's bound-tool/`withTool` authoring path.

`Agent.boundToolkit` builds `handlers` as `{}` and assigns
`handlers[tool.name] = handler`. For the special key `__proto__`, that invokes
the legacy prototype setter instead of creating an own property. Effect's
`Toolkit.make` correctly uses a safe property-definition helper for tool names,
but `Toolkit.toHandlers` enumerates the handler object with `Object.entries`;
the `__proto__` handler is absent, so dispatch later finds the tool and then
defects when its handler service is missing. The new regression test covers
`constructor`, which is an ordinary own assignment, and therefore misses the
special setter case.

Build dynamic records with `Object.create(null)` or Effect's safe
`Record.assignProperty`/`Object.defineProperty`, consistently for handlers and
merged records. Add successful `__proto__`, `constructor`, `toString`, and
symbol-looking string tool names through `make({ tools })`, `withTool`, and
`withTools`, plus duplicate detection for each. Assert exact handler inference
and a real tool-call lifecycle, not only construction.

### R13 — Resolved — The TUI recorded prompts that the session rejected as busy

**State:** fixed for the single-submission case in `ae94e4f` by deferring
drawing until `SubmissionStarted`; that implementation introduces the distinct
multi-submission correlation problem in R39.

Previously, the input remained focused while the footer showed `working`, and
`submit` appended a user transcript entry before calling `session.prompt`. If
a submission was already running, the session returned `AgentBusyError`, but
the user line remained in scrollback even though it never entered canonical
history.

The new projection appends only after admission. Its shared FIFO does not
identify which concurrent offer was admitted, which is the separate R39 bug.

### R14 — P1 — Stream failure or interruption leaves the TUI transcript permanently blocked

**State:** fixed for terminalization in `1770ba9`; R141 records the remaining
presentation problem.

The TUI projection handles `MessageDelta` and `MessageCompleted`, but ignores
`MessageFailed` and `MessageInterrupted`. If a streamed response has emitted any
text before failing or being interrupted, its assistant entry remains
`streaming: true`. The later submission terminal event appends a notice/summary,
but `drainSettled` stops at the still-streaming entry, so that entry and every
later one remain in the live render tree forever and never reach terminal
scrollback.

This is the message analogue of R4. Every core terminal message event must make
the projected entry terminal, and the projection needs tests for failure and
interruption after at least one delta.

### R15 — P1 — Ctrl+R is active while a submission is running, despite the UI saying otherwise

**State:** fixed for the Ctrl+R path in `1770ba9`; the broader imperative paths
remain R104/R148 after `759c5cf`.

The footer only advertises rewind while `status === "idle"`, but the keyboard
handler checks the footer kind and depth, not the status. During a running
submission, `tree.active` still points at the last completed boundary, so Ctrl+R
both abandons the in-flight branch and steps back from that older boundary.

The projection then calls `forget` without settling or removing the old
branch's live assistant/tool entries. Those entries can remain
`streaming`/`running` and permanently block scrollback. Rewind should either be
gated to idle as the affordance says, or define and test a complete
interrupt-and-rewind transaction that terminalizes the abandoned projection.

### R16 — P1 — `withExecutionPlan` removes requirements that the plan cannot provide

**State:** committed in `81611f8`; confirmed by the public signature and call
scope.

The combinator returns `Exclude<R, Types["provides"]>`, but the plan is applied
only around `LanguageModel.generateText`. Toolkit resolution, context
transformation, permission evaluation, and tool handling all run outside that
scope. If any of those require a service also listed in a plan step's layer,
the combinator removes it from the session requirement even though it is not
available where it is used.

Only the model-resolution requirement may be discharged by this narrowly
scoped plan. The rest of `R` must remain intact unless the layer is provided
around the corresponding work too.

### R17 — P1 — Execution-plan failures and requirements are missing from public channels

**State:** committed in `81611f8`; TypeScript passes because the implementation
erases the plan behind `ExecutionPlan<any>`.

Effect's `withExecutionPlan` adds the plan's own error and requirement channels.
The harness combinator adds neither `Types["error"]` to the agent error nor
`Types["requirements"]` to its environment. `AgentTurn.withPlan` then declares
the wrapped call has exactly its original `E` and `R`.

A plan whose provider layer can fail or requires configuration/services is
therefore unsoundly advertised as infallible and self-contained. Compile-time
coverage currently uses only `never`-error, requirement-free test layers; it
needs deliberately fallible and service-requiring plans with exact type
assertions.

### R18 — Resolved — A planned agent's public streaming path had no model to run

**State:** present in `81611f8`; resolved by `483203b`, which applies
`Stream.withExecutionPlan` with partial-stream fallback prevention and tests a
pre-output fallback.

`withExecutionPlan` removes the ambient `LanguageModel` requirement from
`AgentSession.make`, but `AgentTurn` applies the plan only to the batch
`generateText` branch. Calling the same planned session with `{ stream: true }`
goes directly to `LanguageModel.streamText`, even though the type system has
just said no `LanguageModel` service is required.

The documentation's “batch only” limitation does not remove the existing
stream option from `AgentSession.prompt`. Until streaming fallback semantics
are implemented, the signature must retain an ambient model for that public
path or reject streaming with a typed error before consulting the environment.

The later streaming implementation removes this immediate runtime blocker;
R17, R19, R28, and R29 cover the remaining plan-channel/composition behavior.

### R19 — P1 — Existing combinators and consumers erase the execution-plan model parameter

**State:** committed in `81611f8`; confirmed by signatures and a separate
compile-time probe.

`AgentSession.make` correctly accepts the new fourth `Model` parameter, but
nearly every pre-existing `Agent` combinator still accepts and returns only
`AgentDefinition<Tools, E, R>`. Therefore order changes the public type:
`withInstructions(withExecutionPlan(agent))` regains the ambient
`LanguageModel` requirement, while applying the plan last removes it, even
though the two runtime definitions carry the same plan.

The same omission appears in `Agent.run`, `SessionTree.make`, client, eval,
memory, plugin, scheduling, skills, and subagent surfaces. A virtual TypeScript
probe confirmed that direct `AgentSession.make(planned)` requires only its
scope, but adding `withInstructions` makes the equality assertion fail, and
`Agent.run(planned, ...)` also fails an assertion that no model is required.

Every definition-preserving combinator and relevant consumer must preserve the
fourth parameter. This breadth is also evidence that a cross-cutting phantom
parameter is a fragile representation: a field or type member that forces
structural preservation may be safer than relying on every signature to
remember it.

### R20 — P1 — Synchronous event observers can deadlock by re-entering the session

**State:** committed in `7622988`; confirmed by the non-reentrant semaphore
scope.

`EventBus.emit` holds the one-permit ordering semaphore while awaiting every
observer. Any public `AgentSession.observe` callback that calls a session
operation which emits an event (for example `prompt`, `close`, or an operation
awaiting either) waits for the same permit that cannot be released until the
observer returns.

The public documentation warns only that a slow observer slows the loop. It
does not state that re-entry deadlocks. Either enforce a non-reentrant observer
contract prominently and keep this seam internal/narrow, or redesign ordering
so observer callbacks cannot wait on the publication lock. A deterministic
re-entry test should guard the chosen contract.

### R156 — P1 — A public synchronous observer defect can fail agent execution after publication

**State:** committed with `AgentSession.observe` in `7622988`.

`EventBus.emit` publishes the envelope to the PubSub and then awaits `sink` and
every observer under the ordering permit. Although an observer's typed error
channel is `never`, a defect or interruption still escapes the callback and
fails `emit`, which then fails the model/tool/submission operation that was
announcing the event. Subscribers may already have received the envelope, later
observers are skipped, and canonical state may or may not already have moved
depending on the event. `SessionTree.capture` explicitly `catchCause`s its
storage write because otherwise an unwritable disk would take down the agent;
that local defense confirms the public seam's default failure coupling.

Decide whether observers are trusted in-transaction participants or
observability consumers. If trusted, make the non-reentrant/defect-propagating
contract explicit and avoid exporting it as the ordinary observation API. If
not, sandbox each observer cause, report it through a separate diagnostic
channel, and continue ordered publication. Add defects and interruption on
`SubmissionStarted`, tool terminal events, `TurnCompleted`, and
`SubmissionCompleted`, asserting exact state/events and that one bad observer
does not silently starve the rest under the chosen contract.

### R21 — P1 — Stateful regular expressions make permission decisions alternate

**State:** existing permission surface, made directly relevant by the new
`net.search` / `net.fetch` rules.

`Permission.Matcher` accepts any `RegExp`, and `matches` calls `.test` on the
same instance without resetting `lastIndex`. JavaScript regular expressions
with the `g` or `y` flag are stateful, so a deny rule such as `/secret/g` can
match the first identical resource and miss the second. With an allow default,
that turns a denied invocation into an allowed one solely because the rule ran
before.

Permission evaluation must be deterministic. Reset `lastIndex` around each
test, clone the expression, or reject stateful flags, and add repeated-call
tests for both `rules` and `except`.

### R164 — P1 — Remembered permission keys are collision-prone for valid strings

**State:** committed permission behavior, made newly reachable by arbitrary
search queries and fetch resources.

`Permission.grantKey` concatenates `action + "\0" + resource`, but neither
field forbids NUL. Two distinct requests such as `{ action: "a", resource:
"b\0c" }` and `{ action: "a\0b", resource: "c" }` produce the same key. Actions
come from tool annotations and resources can be model-controlled strings, so a
remembered approval for one tool/action pair can authorize another pair from a
third-party or application tool without another question. Coding's lock key
uses the same delimiter only after documenting that sandbox paths prohibit it;
Permission has no corresponding invariant.

Store a structured pair (nested maps or a collision-free canonical tuple
encoding) rather than inventing a delimiter. Decide explicitly whether tool
name belongs in the grant identity as defense against unrelated tools sharing
an action/resource vocabulary. Add adversarial NUL/Unicode pairs, same
resource across tools/actions, durable replay, and encode/decode round trips,
asserting only the exact approved semantic key is allowed.

### R22 — P1 — Session-tree recording is a multi-`Ref` check-then-update transaction

**State:** committed across the SessionTree milestones; confirmed by the
`record` implementation.

`record` reads the current session node, reads `held` to deduplicate, allocates
an id, then updates `held`, `at`, and possibly `lanes` through separate effects.
Two concurrent `commit` calls for one idle session can both pass the unchanged-
history check, create sibling nodes holding the same conversation, and race on
which one becomes the session/lane tip. One duplicate is left reachable only
as an orphaned child.

This is exactly the kind of invariant AGENTS.md requires to be atomic. The
tree's related maps need one transactional state transition or an operation
permit; tests should overlap two commits deliberately rather than rely on
scheduler timing.

### R23 — P2 — `SessionTree.summary` mixes canonical and caller-supplied node data

**State:** committed in `d4551c2`.

`summary` first resolves `node.id` through `find`, but computes the parent's
message count from the caller's `node.parent` rather than
`found.node.parent`. `path` correctly follows stored nodes, so a structurally
copied node with the same valid id and a changed parent can report a depth from
one lineage and an `added` count from another.

Once an id is accepted, all metadata should come from the stored node. The
same principle should be applied to callbacks and activation results that
currently retain pieces of the caller's object.

### R24 — P2 — Closed branch sessions leave permanent cursor/lane entries

**State:** committed SessionTree lifetime behavior.

Every created branch session adds entries to the `at` map and sometimes
`laneOf`. Releasing an activated branch through `RcMap`, or closing a caller-
held `branch`, closes the session but never removes either entry. Repeatedly
activating the same node therefore grows tree state even if it creates no new
conversation nodes.

The session/resource scope that owns each branch should remove its ephemeral
cursor and lane association in a finalizer. The intentionally retained node
history is separate from these dead live-session indexes.

### R25 — P1 — Interrupting an approval leaves the TUI stuck on a dead question

**State:** fixed in `1770ba9`; core correctly removes the pending in-memory
elicitation and the TUI now reconciles the footer on submission termination.

The TUI clears its approval footer only on `ElicitationResolved` (or a rewind).
When Ctrl+C interrupts a submission waiting for approval, the elicitor's
`ensuring` removes the request and the submission emits
`SubmissionInterrupted`, but no resolution event occurs. The TUI terminal case
sets status idle and appends a summary without clearing the approval.

The screen is then idle while still showing an unanswerable approval; responding
returns false and produces no event that restores the prompt. Every submission
terminal case must reconcile/clear transient footer state, with an integration
test that interrupts while `AgentSession.pending` is non-empty.

### R26 — P1 — Cross-origin redirect enforcement depends on an untyped `HttpClient` behavior

**State:** committed fetch-provider design; documented as a limitation, but it
is an enforcement gap in the exported “guarded” layer.

`/web/http` requires an abstract `HttpClient` and supplies
`FetchHttpClient.RequestInit { redirect: "manual", credentials: "omit" }` around
execution. That service is consumed by the Fetch-backed implementation, but it
is not part of the `HttpClient` contract and an arbitrary conforming client may
ignore it or follow redirects internally. In that configuration the provider
never sees the 3xx response, cannot validate the redirect target, and can fetch
a second origin without a fresh permission decision.

Documentation makes the dependency honest but does not make the security
property true. The provider needs a capability whose type/constructor
guarantees redirect visibility (or must own the Fetch transport), and its tests
need a client that attempts automatic cross-origin following to prove the
guard cannot be bypassed by wiring.

### R27 — P3 — Literal-IP filtering is narrower than its “non-public” contract

**State:** committed in `7622988`.

The IPv4 table blocks the most important private, loopback, link-local, CGNAT,
benchmark, and multicast ranges, but allows other special-use/non-routable
ranges such as TEST-NET and IETF protocol assignments. The IPv6 table likewise
allows multiple special-purpose prefixes and IPv4-compatible `::/96` forms
other than mapped addresses.

This is not the documented DNS-rebinding limitation: these are literal targets
the portable provider can classify before I/O. Either describe the policy as a
specific denylist, or use complete maintained special-purpose range tables so
the “non-public targets are not allowed” error and provider contract are true.

### R28 — P1 — `withExecutionPlan` does not constrain the plan's failure input to model errors

**State:** committed in `81611f8`; hidden by storing and applying the plan as
`ExecutionPlan<any>`.

Effect's API requires the wrapped effect's error `E` to extend the plan's
`input`, because the plan's predicates and schedules receive those failures.
The harness combinator accepts any `Types["input"]`, then `AgentTurn.withPlan`
erases the relationship and applies it to `LanguageModel.generateText`.

A caller can therefore attach a plan whose `while` callback assumes a narrower,
unrelated error shape. A model `AiError` is passed to it at runtime despite the
callback's static type. The public parameter must constrain the plan input to a
supertype of the model-call error, and a negative compile test should prove an
unrelated input is rejected.

### R29 — P2 — Streaming fallback does not see provider errors represented as stream parts

**State:** committed and explicitly documented in `483203b`, but not covered by
the fallback test.

The execution plan wraps `LanguageModel.streamText`, while the conversion of an
in-band provider error part into `AiError.InternalProviderError` happens later
inside `Stream.runFoldEffect`. The plan therefore sees a successfully emitted
element, not a failed stream, and cannot fall back even if the error part is the
first item and no user-visible output was produced.

The current test covers only a stream that fails as an Effect before output.
Provider error parts are an existing supported failure representation and need
an explicit policy/test. To make fallback consistent, conversion to a typed
stream failure has to occur inside the plan boundary while retaining the
“never mix partial output” rule.

### R30 — P2 — The repository's required verification command does not verify the TUI

**State:** root typecheck/smoke coverage added in `1770ba9`; Effect diagnostics
remain excluded (R142), and the smoke gate is now reproduced flaky (R40).

The root `tsconfig.json` includes only `src`, `test`, and `examples`, and root
`npm run check` never invokes `apps/tui`'s typecheck or smoke script. A commit
can therefore report the repository check green while the newly added TUI does
not compile or while its projection checks fail. Several findings above lived
precisely in that unverified surface.

The app's `npm --prefix apps/tui run typecheck` currently passes. Its smoke run
could not start in this checkout because Bun reports a corrupted/remapped
`node_modules` binary; that environment problem also demonstrates why it must
be an explicit CI job rather than an assumed local check.

### R31 — P2 — TUI work is launched as detached root fibers outside the harness lifetime

**State:** committed in `a817a76` and extended by rewind.

`submit`, `interrupt`, `respond`, and `rewind` all use `Effect.runFork`, while
only the long-lived program fiber is owned and interrupted by `stop`. Closing
the harness can therefore race detached work that still mutates the sink or
tries to activate a branch after the tree/session scope is closing. The single
module-global `disposeFiber` also means starting a second harness overwrites the
only disposer and leaks the first.

The handle should own a scope/runtime for child operations and expose its own
idempotent close, so lifecycle is per harness rather than global. This also
provides the natural serialization point for submit/rewind races.

### R32 — P1 — Replacing one execution plan with another can permanently lose the ambient model

**State:** committed in `81611f8`; a consequence of computing from the already
residual `Model` parameter.

`withExecutionPlan` replaces the runtime plan but computes its result as
`Exclude<Model, NewPlanProvides>`. If the first plan provides
`LanguageModel`, `Model` becomes `never`. Applying the combinator again with a
plan that does not provide `LanguageModel` replaces the working runtime plan
but computes `Exclude<never, ...>`, still `never`.

The resulting agent requires no ambient model and its new plan supplies none,
so model invocation fails at runtime. Either repeated application must be
rejected, or the definition must retain the pre-plan model requirement so a
replacement can recompute rather than only subtract from the previous
residual.

### R33 — P2 — The execution-plan design conflicts with the repository's model-wiring invariant

**State:** architectural conflict introduced by `81611f8`.

AGENTS.md says “The model arrives through the environment. An `Agent` never
names a provider.” `withExecutionPlan` stores an `ExecutionPlan` directly on
`AgentDefinition`, and ordinary plan steps carry the concrete provider Layers.
The resulting agent value therefore does name and retain its model providers;
reusing that definition against a different provider requires rebuilding it.

Calling the plan “supplied at the edge exactly as a layer would be” does not
resolve the distinction: a Layer supplied through the environment is
application wiring, while this Layer graph is a field of the agent definition.
The design authority and implementation now disagree and should be reconciled
explicitly, not hidden behind terminology. If provider fallback is application
wiring, a routing/model service Layer may preserve the original invariant more
cleanly than a new phantom parameter on every agent consumer.

### R34 — P1 — SessionTree identity and dedup rely on caller-controlled session-id strings

**State:** committed SessionTree design; R7 is one way to trigger the broader
problem.

`commit` and `track` accept any structurally compatible `AgentSession`, then
key its cursor/lane solely by `session.id`. `AgentSession.make` explicitly lets
callers choose that string, and `restore` deliberately reuses it. Two distinct
sessions with the same id therefore share one tree cursor even if their
histories or originating agent definitions differ.

The dedup check compounds this by comparing only history length. A restored or
colliding session with a different conversation of the same length is treated
as unchanged and returns the other session's node; a shorter/divergent history
can be parented onto the wrong lineage. The module's claim that owning one
agent makes grafting a session from another agent impossible is not enforced by
the structural `AgentSession<Tools, E>` parameter either.

Track cursor identity by the session handle/resource rather than its display
id, or explicitly register and reject id reuse; dedup must compare a canonical
history identity/content invariant, not length alone.

### R35 — P2 — Packed portability still exempts Slack after the Web Crypto rewrite

**State:** stale verification configuration after `c573e9d`.

The source portability checker removed `connectors/slack.ts` from its host
allowlist, matching the commit's claim that the module is now portable.
`scripts/verify-package.mjs` still lists `./connectors/slack` in `hostEntries`,
so the packed artifact imports that entry without the no-Node-builtins/non-Node-
conditions resolution hook and prints it as `(host)`.

The package verification run passed all 34 entries, but did not actually prove
the new Slack portability claim. Remove the stale exemption once R1 is fixed,
then require the packed entry to pass the portable probe like the source does.

### R36 — P1 — Durable permission replay journals only part of the authorization decision

**State:** existing durable-permission design, made more consequential by
decoded projections and web permissions.

`DurablePermission` journals only `policy.evaluate(request)`. On replay,
`ToolExecution.decide` still decodes parameters, evaluates the tool's dynamic
`needsApproval`, and computes the projection/resource again before retrieving
that old policy answer. The source calls those pure, but Effect AI explicitly
allows `needsApproval` to return an Effect, and synchronous projections and
schema transforms can still close over mutable state.

If intrinsic approval was false on the first run and true on replay, a tool
whose side effect is already journalled can newly pause or deny before reaching
that journal entry. A changed projection can likewise pair the old policy
answer with a different action/resource and show a different approval detail.
That is workflow divergence at the authorization boundary.

Journal the complete decoded authorization outcome/request used for execution,
or make and enforce a genuinely deterministic contract for every pre-journal
step. A comment assigning determinism to the tool author is not enough when the
upstream type permits effects.

### R37 — P1 — Execution-plan provider Layers bypass `DurableModel`

**State:** cross-feature defect between the newly committed execution plan and
the durable interpreter; no composition test exists.

`DurableAgent` wraps the ambient `LanguageModel` with `DurableModel` and
provides that wrapper around the session. `AgentTurn` then applies the agent's
execution-plan steps directly around each model call. Because those steps
provide `LanguageModel` themselves, they shadow the outer durable wrapper and
the actual provider call occurs outside the model activity journal.

A durable agent with fallback can therefore repeat completed/billed model calls
on workflow replay—the main side effect `DurableModel` exists to prevent. Its
types also still demand an ambient model through older three-parameter agent
signatures, so the workflow may wrap a model the plan never consults.

Provider routing must sit *under* the durable model decorator (for example as
the ambient routed `LanguageModel` the durable layer wraps), or the durable
interpreter must explicitly wrap every plan attempt. Add a replay test with a
planned agent that counts both failed and successful provider attempts.

### R38 — P2 — “Fallback cannot repeat side effects” covers only harness-executed tools

**State:** over-broad safety claim in the execution-plan design and tests.

The plan correctly wraps only the model call, so a locally handled tool from a
completed earlier turn is not retried. But model calls can themselves trigger
provider-executed tools or other provider-side work before the request fails.
On the batch path there is no partial-output guard, so a retry/fallback can
repeat that remote work even though no `GenerateTextResponse` reached the
harness to mark it `providerExecuted`.

The model request is also billed/nondeterministic by definition. Fallback may
be the desired trade, but it is not side-effect-safe “by construction” in the
general Effect AI toolkit. Narrow the invariant to harness-owned handlers and
document or restrict provider-executed tools under retrying plans.

### R39 — P1 — The R13 prompt fix can draw one submission's text for another

**State:** introduced by the committed fix `ae94e4f`.

The TUI now pushes prompt “tickets” into a shared array and, on any
`SubmissionStarted`, draws `offered.shift()`. The event carries no reference to
the ticket or input that caused it. If two detached `submit` fibers race, the
second call can win session admission while the projection shifts the first
ticket. The UI then says prompt A entered history when prompt B actually did;
the rejected A cleanup cannot recover the already-shifted ticket and B's ticket
is stranded.

Using ticket identity only in the failure cleanup does not correlate the start
event. Serialize submission at the handle boundary, or carry an admission id /
input through a seam the initiating call can match. The smoke test drives a
synthetic start and never overlaps real submits, so it cannot detect this
misattribution.

### R40 — P2 — The TUI smoke test now polls wall-clock macrotasks

**State:** introduced by `ae94e4f`; reproduced repeatedly after `1770ba9`.
The latest moving smoke also times out on its branch-admission assertion.

`apps/tui/src/smoke.tsx` now retries a predicate up to 4,000 times with
`setTimeout(resolve, 0)`. That is timing-based polling, not synchronization on
the event the test means. It can fail under a loaded runner after an arbitrary
number of event-loop turns, and predicates over transient UI state can miss the
state between polls.

This directly conflicts with the repository rule that tests synchronize with
`Deferred`/latches and never sleeps. The original render-pass wait was the
wrong signal, but replacing it with a wall-clock polling loop preserves the
same class of nondeterminism. Expose completion/approval/rewind latches from
the harness test seam, or have the smoke driver await operations that complete
when those state transitions occur.

### R41 — Resolved — The SessionTree milestones had no public package entry

**State:** present through T4; resolved at the source/manifest level by
`a7c4b9e`, which adds the `./tree` entry and a public-API test. The currently
packed artifact is still stale and fails to import that entry; see R46.

Through T4, the plan called `SessionTree` a public API but the package exported
neither a `./tree` subpath nor the module from its root. Tests and the TUI used
repository-relative imports, so they did not prove an installed consumer could
reach it. The new subpath fixes the manifest surface.

Before `a7c4b9e`, the completed tree/TUI milestones were internal source code
rather than an installable library capability. The new entry closes that gap;
the next packed import run must include it automatically from `package.json`.

### R42 — P1 — Persistent trees reuse node IDs after a real process restart

**State:** committed in `a7c4b9e`; now exercised by the live TUI in `fccecb5`.

T5 still mints IDs from the module-global `trees` counter and a per-tree
`counter`, producing values such as `t1-node-1`. Both counters reset when the
process restarts. Reopening the same key-value namespace and committing another
node can therefore overwrite the old `t1-node-1`, despite IT3 and `NodeStore`
describing ancestors as immutable. Its old index position and child links
remain, now referring to replacement history.

The restart test rebuilds the adapter and tree in one process, so the
module-global counter advances to a different prefix. It then branches from
the stored leaf but never commits the branch. Consequently it cannot reproduce
the collision that an actual restart creates. Use a durable globally unique
ID (or a persisted allocator/tree identity) and test reopening plus committing
in a fresh process or with an injectable allocator reset.

The new TUI persistence smoke test repeats the same false simulation: both
launches share one JavaScript module instance, so `trees` does not reset. In a
real second process, a typical first run has `t1-node-1` as the root and
`t1-node-2` as its first turn. Resuming at node 2 and committing produces
`t1-node-1` again, overwrites the root with a node parented to node 2, and adds
it to node 2's children while the roots index still names it. That is an actual
cycle, not only an overwritten label; current path/export traversal can then
loop forever (R78).

The rebuild also creates fresh in-memory `lanes`, `laneOf`, and session cursor
maps, so named leaves are not restored. If “a tree survives a restart” includes
its public lane API, that metadata must be stored or the narrower survival
contract must be documented.

### R43 — P1 — NodeStore writes and indexes are not atomic under concurrency or interruption

**State:** committed in `a7c4b9e`.

`NodeStore.memory.put` checks existence, updates the node map, and appends to
the order `Ref` in separate operations. Concurrent puts of the same ID can both
observe absence and append it twice. The key-value adapter's `append` is also a
read-modify-write with no lock or transaction, so concurrent different-node
writes can lose one another from the order or children index.

Each key-value `put` additionally writes the node and then its indexes as
separate effects. Failure or interruption between them leaves an orphaned node;
later enumeration cannot find it, and automatic capture swallows the failure
instead of retrying. Writing the node first avoids a dangling index but does
not make the tree durable or consistent.

The repository explicitly requires invariant-bearing state transitions to be
atomic. The memory implementation should use one `Ref.modify` over one state;
the persistent contract needs serialized/transactional index updates or a
single append-log record from which indexes can be rebuilt. Conformance tests
must force overlapping puts and injected failures at every write boundary.

`fccecb5` makes this the default storage path for every live TUI. Two processes
opened on one workspace now combine this lost-update behavior with R42's
identical ID allocators; there is no lock, lease, or single-writer check.

### R44 — P1 — Automatic tree capture catches interruption and defects as storage failures

**State:** committed in `a7c4b9e`.

The `capture` observer uses `Effect.catchCause` around history recording and
converts every cause into a successful log operation. That does not only
isolate the declared store error `SE`: it also swallows interruption and
defects from tree logic, codecs, or the backing implementation.

This breaks structured cancellation and makes programming errors look like an
ordinary missed snapshot. Catch only the typed store failure with
`Effect.catchAll` (and preserve interruption/defects), or model a narrower
store error at the observer boundary. A test should interrupt a tracking scope
while a write is held on a latch and assert that the observer fiber terminates.

For the now-persistent TUI this also means disk-full, permission, torn-index,
and decode failures are reduced to a log line that may not even be visible
behind the full-screen renderer. The UI continues saying the conversation will
survive while later turns are no longer being recorded.

### R45 — P2 — New NodeStore tests require user-side brand casts

**State:** committed in `a7c4b9e`.

`test/NodeStoreContract.ts` and `test/NodeStore.test.ts` repeatedly construct
and query IDs with `as NodeStore.NodeId`. These are checked casts rather than
`any` erasures, but the repository instruction is stricter for callers and
tests: test code is user code and must not need casts.

Decode through the exported `NodeId` schema (or provide a typed constructor
whose validation is part of the public API). That also exercises the validator
and codec that branding was chosen to provide, instead of bypassing both in the
conformance suite.

### R46 — P2 — Package verification can inspect a stale, partially emitted `dist`

**State:** reproduced after `a7c4b9e`.

`scripts/verify-package.mjs` runs `npm pack` against the existing working tree
without first cleaning or building it. After T5 added `./tree`, the source and
manifest contained `src/tree/index.ts`, while `dist/tree` contained files from
an earlier failed/partial build but no `index.js`. `verify:package` therefore
packed a mixture of generations and failed only the new tree entry.

This can also mislead in the other direction: before the export changed, the
same command passed while R1 proved current source could not build. Package
verification should operate on a clean build produced in the same command (or
refuse a dirty/stale output tree), and the publish lifecycle should run it after
that build. Otherwise “all packed entries pass” is not evidence about the
source revision under review.

### R47 — P1 — Plugin stdio command/cwd containment is lexical and the launch paths use the host cwd

**State:** committed in `af8e62c`; confirmed against the Agent Plugins 1.0.0
specification and by control-flow inspection.

`src/plugins/internal/mcp.ts:70-137` validates command and cwd with a `/`-only
segment counter. It accepts absolute commands such as `/usr/bin/server`, accepts
path-bearing commands without the required `./` prefix, and does not recognize
Windows `..\` or drive-qualified forms. It also does not perform the required
filesystem-resolved containment check, so symlink escape is not detected.

More importantly, `src/plugins/Plugins.ts:106-113` passes `./bin/server` and
`./work` directly to `McpClient.stdio`. They are therefore relative to the host
process cwd, not the plugin root; when cwd is omitted, the host cwd is used even
though the specification requires the plugin root. The decode tests only assert
the strings and never launch from a process whose cwd differs from the plugin
root.

Resolve the executable and cwd against an absolute, canonical plugin root at
the host boundary and re-check containment after filesystem resolution. Tests
need Windows separators/drive paths, absolute POSIX paths, missing `./`, symlink
escape, omitted cwd, and a real launch with a deliberately unrelated host cwd.

### R48 — P1 — Plugin stdio processes do not receive the required reserved environment

**State:** committed behavior; confirmed against the Agent Plugins 1.0.0
specification.

The loader accepts optional `pluginRoot` and `pluginData` only to expand values.
`src/plugins/Plugins.ts:106-113` forwards just `server.env` to the subprocess and
never injects `PLUGIN_ROOT` or `PLUGIN_DATA`. The specification requires both
absolute resolved variables on every stdio launch, with reserved values
overwriting configured environment entries.

The launch API should require resolved root/data locations for stdio, inject
both after the configured overlay, and validate their lifecycle and
containment. Until those values exist, stdio should remain disabled rather than
launching a nonconformant plugin. Add an executable fixture that records its
environment instead of testing the decoded config alone.

### R49 — P2 — The MCP decoder accepts documents the closed specification rejects

**State:** committed behavior; confirmed against the Agent Plugins 1.0.0 MCP
schema.

`src/plugins/internal/mcp.ts:165-214` checks selected fields manually and ignores
unknown top-level properties, unknown properties on a server, and fields from
the other transport variant. `decodeHttp` accepts arbitrary header names and
case-insensitive duplicates as long as the JavaScript object values are
strings. The normative schema is closed at the document and server-variant
levels and has additional HTTP-header constraints.

Decode the entire document with a closed schema, then isolate invalid server
entries only where the specification permits per-server isolation. Tests should
cover unknown document fields, cross-variant fields, invalid header names or
values, and duplicate names differing only by case.

### R50 — P1 — Valid MCP HTTP headers are parsed and then silently discarded

**State:** committed behavior; explicitly admitted by the implementation
comment, but incompatible with the declared `HttpServer` capability.

`decodeHttp` retains `headers`, while `src/plugins/Plugins.ts:115` constructs
`McpClient.streamableHttp` with only `url` and `clientInfo`. An authenticated
server can therefore validate and load successfully yet receive a materially
different request and fail to connect. The Agent Plugins specification requires
configured headers to be sent to the origin.

Plumb headers through an Effect MCP transport that supports them. If the
current Effect AI API cannot, reject header-bearing entries with a warning
instead of claiming to support them. Add a local HTTP fixture that asserts the
actual received headers and verifies they are not forwarded across a redirect.

### R51 — P2 — Plugin component I/O failures are indistinguishable from absence

**State:** committed behavior.

`Plugins.load` wraps the `mcp.json` read in `Effect.option`; an unreadable file,
a directory named `mcp.json`, and a missing file all become “no MCP component”
without a warning. `discoverSkills` similarly converts a failed `skills/`
listing to an empty list. This erases actionable configuration and permission
failures and contradicts the loader's own nonfatal-warning model.

Catch typed `FileMissingError` as absence and convert other file errors into a
component warning. Add a fault-injecting sandbox suite for stat, list, and read
failures at each discovery boundary.

### R52 — P2 — SKILL.md frontmatter is not parsed as YAML

**State:** committed behavior; confirmed against the Agent Skills
specification.

`src/plugins/internal/frontmatter.ts` explicitly implements a colon-splitting
subset rather than YAML. Valid YAML quoting, escapes, block/folded scalars and
comments can be decoded incorrectly or rejected, while malformed YAML,
duplicate keys, and unsupported structures are silently reinterpreted. A
plugin can consequently expose different name, description, or metadata from
what its author wrote.

Use a real YAML decoder followed by a strict schema for the supported Agent
Skills version. Tests need valid quoted colon/hash values, folded and literal
descriptions, escapes, duplicate keys, non-scalar values, malformed indentation,
and explicit unknown-field policy.

### R53 — P2 — Plugin skill resources defeat progressive disclosure and are incomplete

**State:** committed behavior.

`src/plugins/internal/skills.ts:19-37` eagerly reads every immediate
`references/*` file while loading a plugin and stores all contents in memory.
The Agent Skills resource model is intended for on-demand loading after the
skill body identifies the relevant resource. The loader also exposes only
immediate reference files; nested references and the standard `scripts/` and
`assets/` resource directories are invisible through the resulting skill
value.

Keep resource descriptors/paths in the skill catalogue and read them through a
scoped sandbox capability on demand, with byte limits and typed failures.
Conformance tests should prove initial discovery does not read resources and
that nested resources cannot escape the skill directory.

The normative references used for R47-R53 are the
[Agent Plugins 1.0.0 specification](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md)
and the [Agent Skills specification](https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx).

### R54 — P1 — Search permission is scoped to the regular expression, not the data being read

**State:** committed in `5efd57a`; a test currently pins the incorrect
projection.

`src/coding/CodingToolkit.ts:223` projects `{ action: "read", resource:
params.pattern }`. The operation actually reads every eligible file below
`params.path ?? "."`; the regex is only the query. A path-scoped policy can
therefore neither authorize nor deny the subtree being disclosed, and an
approval prompt hides the sensitive resource.

Project the search root as the permission resource and keep pattern/include as
non-authorizing detail if the permission vocabulary later gains such metadata.
Replace the existing projection assertion with policy tests that allow one
subtree and deny another while using the same regex.

### R55 — P1 — `write_file` can race `edit_file` despite the advertised per-file write lock

**State:** committed behavior; the concurrency suite covers edit/edit only.

`edit_file` performs its read-modify-write under `withFileLock`, but
`write_file` bypasses that registry. Concurrent tool execution can therefore
let an edit read the old content, a write replace it, and the edit subsequently
overwrite the write with a value derived from stale state. Two writes also have
uncontrolled last-writer behavior.

All first-party mutators of the same sandbox path should share the same lock,
or the sandbox seam should expose an atomic compare-and-swap/versioned write.
Use Deferred-controlled tests for write/edit in both orders, interruption while
queued, and cross-toolkit instances.

### R56 — P1 — Editing malformed or non-UTF-8 text can corrupt bytes outside the edit

**State:** committed behavior.

`readPreservingBom` at `src/coding/CodingToolkit.ts:379-384` uses the default
nonfatal UTF-8 decoder. Invalid byte sequences become U+FFFD; `edit_file` then
writes the entire decoded string back as UTF-8. This contradicts the nearby
claim that nothing outside the selected span is re-encoded and can silently
destroy an otherwise editable legacy/malformed text file. The binary heuristic
does not reliably classify all such files.

Decode edit targets with `fatal: true` and return an actionable unsupported-
encoding failure, or implement a byte-preserving edit. Add fixtures containing
invalid UTF-8 before and after an ASCII target and assert every untouched byte.

### R57 — P1 — Fuzzy edit ambiguity is checked by literal value, not by semantic candidate set

**State:** committed in `5efd57a`; reproduced directly against
`Replace.replace`.

The driver at `src/coding/internal/replace.ts:565-596` considers each yielded
candidate independently and checks only whether that exact candidate string is
unique in the file. If `foo  bar` and `foo\tbar` both match the requested
`foo bar`, each literal is unique and the first one is edited instead of
returning `Ambiguous`. `BlockAnchorReplacer` has the same issue: equal-scoring
blocks are reduced to the first because `best` changes only on `score >
bestScore`.

Collect and de-duplicate candidate locations for a strategy before deciding;
refuse multiple semantic locations and tied best scores. Add distinct-
whitespace, different-indentation, context-aware, and equal-score anchor tests,
including strategy overlap and `replace_all` semantics.

### R58 — P1 — Model-supplied search regexes can block the JavaScript runtime

**State:** committed behavior.

`src/coding/CodingToolkit.ts:599` constructs an arbitrary native `RegExp` and
applies it synchronously to every line. Catastrophic-backtracking patterns can
block the event loop; Effect interruption and timeouts cannot preempt a running
JavaScript regex. Pattern and line length are not bounded before matching. The
`include` glob has a second route: nested brace alternations compile to a native
regex and can backtrack catastrophically too. It is recompiled once per file,
amplifying both ordinary cost and the denial of service; today's checked-in
review measured a 121-character glob taking roughly three seconds for one
filename.

Use a linear-time engine such as RE2, an interruptible/limited subprocess, or a
worker that can be terminated. Compile/validate the glob once and bound brace
nesting. Add adversarial regex and glob refusal tests (not elapsed-time tests)
and prove cancellation releases all search resources.

### R59 — P2 — Search bounds returned matches but first materializes the entire file tree

**State:** committed behavior.

`walk` recursively builds arrays of every file, and only after
`src/coding/CodingToolkit.ts:605` completes does the 100-match stop condition
run. A huge or adversarial tree therefore consumes unbounded traversal time,
stack depth, and memory even when the first file would fill the result budget.
It also combines child arrays with `files.push(...child)`: JavaScript engines
cap function argument counts, so a sufficiently wide subtree throws
`RangeError` before search begins even when memory is available.

Stream traversal and matching together, stop traversal when the result budget
is reached, and impose explicit visited-file/depth/time limits. Tests should use
a lazy instrumented sandbox to prove directories after the limit are never
listed and deeply nested trees do not overflow the stack.

### R163 — P2 — Coding-tool display limits do not bound file bytes read into memory

**State:** committed behavior across the coding-tool port; the design notes
refer to a “read cap mentality,” but no read cap exists.

`read_file` performs `stat`, ignores the entry's available `size`, then calls
`sandbox.read` for the entire file before binary detection, line slicing, and
the default output limit. A request for ten lines of a multi-gigabyte file
therefore allocates/decodes the whole file. `search` likewise loads and decodes
each candidate in full; its 100-match cap and R59's traversal concern bound
neither bytes nor per-file work. `edit_file` necessarily needs a coherent
read-modify-write value but also has no maximum and runs several potentially
expensive matching strategies over it. A model can turn an apparently bounded
read/search/edit into process memory exhaustion or long uninterruptible string
work simply by choosing an existing large workspace artifact.

Define explicit per-file and per-operation byte/work budgets. Use `stat.size`
for an early refusal where available, require a ranged/streaming sandbox
capability before claiming efficient line windows/search, and still enforce an
actual-byte cap because metadata can be absent or stale. Skip/refuse oversized
binary/generated artifacts with actionable model text. Tests should use a
provider that lies about size and returns a large value, cover offset near EOF,
many individually-small files exceeding a total budget, interruption, and
prove the handler never decodes bytes beyond its bound.

### R60 — P2 — Coding tool numeric parameters accept fractions and invalid ranges

**State:** committed behavior.

`read_file.offset`, `read_file.limit`, and `bash.timeout_ms` use unrestricted
`Schema.Number` at `src/coding/CodingToolkit.ts:108-110,240`. Fractional line
numbers produce fractional labels and slicing semantics; zero/negative limits
return surprising empty windows; negative/fractional timeouts are handed to
the provider. The handler's `Math.max(1, offset)` only repairs non-positive
offsets and does not establish the public contract.

Use integer schemas with documented positive bounds (and a maximum timeout),
then test decoding failures through actual tool dispatch, not only direct
handler calls.

### R61 — P2 — Saved shell output paths collide across restarts and processes

**State:** committed behavior and documented as an accepted overwrite.

`src/coding/internal/truncate.ts:91-98` uses a module-global counter beginning at
`tool_0001`. A new process, a second library instance, or independent workers
sharing a workspace can overwrite output named by an earlier tool result. The
model may then read unrelated or attacker-controlled content from the promised
path.

Use a run/session identifier plus collision-resistant suffix and create the
file exclusively, retrying on collision. Add concurrent multi-instance and
simulated-restart tests; do not rely on sequential tests in one module cache.

### R62 — P3 — A malformed search glob silently masquerades as “no matches”

**State:** committed behavior; the test explicitly endorses it.

`Glob.matches` catches regex construction failure separately for every file and
returns false. The final response is therefore indistinguishable from a valid
glob that matched nothing, despite the comment saying the caller can correct
the bad filter. It cannot know that correction is needed, and repeated
construction also wastes work.

Compile/validate the include glob once before traversal and return an actionable
typed tool failure. Test unmatched valid patterns separately from malformed
brace syntax.

### R63 — P3 — `write_file` reports UTF-16 code units as bytes

**State:** committed behavior.

`src/coding/CodingToolkit.ts:511` labels `content.length` as bytes. JavaScript
length counts UTF-16 code units, so Unicode content produces a false audit/model
message. Report `TextEncoder().encode(content).length`, or call the value
characters/code units. Add non-ASCII and astral-character cases.

### R64 — P3 — Sandbox path and workspace constructors do not enforce the lock-key invariant

**State:** committed behavior.

The edit-lock comment says no sandbox path can contain NUL and uses NUL as its
workspace/path separator. `Sandbox.path` does not reject NUL, and `workspace`
is an unchecked brand constructor that accepts it as well. Memory sandboxes can
store such names; local providers fail later with platform-specific errors.
Key collisions cause unrelated paths to serialize under one semaphore and show
that the documented invariant is not encoded by the domain types.

Reject NUL in both constructors (and validate workspace labels rather than
blindly branding them). Add schema/constructor round-trip tests for control
characters and provider-consistent failures.

### R122 — P2 — `bash` performs an unprojected workspace write when output is large

**State:** committed in `5efd57a`.

`Bash` is permissioned only as `shell` on the command. After execution,
`bounded` automatically writes any truncated stdout and stderr in full under
`.effect-agent/tool-output` (`CodingToolkit.ts:415-431, 625-644`). That write
does not receive a separate `write` decision and is not visible in the
approval resource. A policy can therefore allow a known read-only command and
deny filesystem writes, yet the library itself still creates workspace files
when the command is noisy.

Shell authority is necessarily broad when the command itself can redirect or
modify files, but that does not make an unrelated, implicit harness write
visible or independently controllable. It also conflicts with the web design's
correct rule that network access and saving a result are two separately
permissioned calls because the current projection can describe only one
action/resource.

Return only the bounded tail unless the application explicitly installs an
artifact store/sink with its own policy, or add a separately authorized save
step once multi-action semantics exist. At minimum document that `shell`
includes automatic artifact writes and make the behavior configurable. Test a
policy that allows shell and denies write, a read-only sandbox, separate large
stdout/stderr, interruption during saving, and the exact lifecycle events for
any artifact operation.

### R123 — P2 — `read_file` reports every `stat` failure as a missing file

**State:** committed in `5efd57a`.

`read_file` wraps `sandbox.stat` in `Effect.option` and treats `None` as the
missing-file/suggestion path (`CodingToolkit.ts:473-486`). `stat` can also fail
with `PermissionDeniedError`, `ProviderError`, and `InvalidPathError`. A symlink
escape refused by the local provider, a storage outage, or another provider
failure is therefore rewritten as “File not found” (possibly with unrelated
name suggestions), encouraging retries and hiding the security or
infrastructure cause. `suggestFor` appropriately degrades its *secondary*
directory listing, but the primary error was discarded before it was called.

Catch only `FileMissingError` for suggestions and map every other typed error
to its actionable message unchanged. Add injected stat failures for every
`FileError` variant, including a local out-of-workspace symlink, and assert
that only the genuine missing case lists siblings and that `read` is never
attempted after any failed stat.

### R65 — P1 — A failed AgentState save leaves the live value changed and observable

**State:** introduced by today's typed-storage work; confirmed by operation
ordering in `src/state/AgentState.ts:326-350`.

Every persisted mutation first updates the `SubscriptionRef` and only then
calls `persist`. If the store write fails, the operation reports
`StorageError`, but `get` returns the new value, `changes` may already have
published it, and the backing store still contains the old value. The comment
that the semaphore keeps “the ref and the store never diverge” is therefore
false on the exact failure path typed errors were added to expose. A restart
silently rolls state back; a subsequent in-process update builds on a value
that never became durable.

Define and document a failure atomicity contract. At minimum, persist before
publishing the ref under an uninterruptible critical section; for stores that
need compare-and-swap, expose a version/transaction seam. Tests need a store
that fails or blocks each save, a subscriber to `changes`, caller interruption
at both boundaries, and recovery/retry assertions.

### R66 — P1 — Generic SQL stores assume a transaction serializes read-then-write transitions

**State:** committed across today's durability changes; SQLite tests pass but
do not establish the advertised portable SQL semantics.

Several operations wrap multiple statements in `withTransaction` but neither
lock the selected rows nor encode the precondition in the mutation. Under
ordinary read-committed, row-level-concurrency databases:

- `DeliveryLog.append` can let two transactions select no event, allocate the
  same `MAX(sequence) + 1`, and turn the loser into `StorageError` instead of
  the promised duplicate/conflict outcome.
- `DurableChannels.takeAll` can let two drainers select and return the same
  rows; `offerIfOpen` can observe the gate, race its deletion, then accept input
  after admission closed.
- `DurableSessionStore.getOrCreate` can race into a uniqueness failure;
  `addPendingRequest` has the same check-then-insert shape.
- `attachExecution` and `finish` read one claim and then update by session id
  only, so a stale operation can overwrite or clear a newer claim.
- concurrent `answerRequest` calls can both return true and overwrite the
  answer; concurrent `takeAnswer` calls can both return the same response.

The code itself mentions PostgreSQL/read-committed behavior for `claim`, so the
surface is not SQLite-specific. Use conditional single-statement mutations,
affected-row counts, row locks/`SKIP LOCKED`, optimistic versions, or an
explicit serializable isolation contract as appropriate. Run the same
concurrency contract against at least PostgreSQL, with Deferred/barrier-backed
interleavings rather than scheduler luck; add concurrent create, append,
drain/gate-close, attach/finish/new-claim, answer, and take cases.

### R67 — P1 — An interrupted memory DeliveryLog append can commit without publishing forever

**State:** committed behavior.

`memoryLog.append` commits the new entry in `Ref.modify` at
`src/durable/DeliveryLog.ts:189-212`, then separately acquires the bus and
publishes at lines 214-215. Interruption in that gap leaves `read` containing
the event while existing `live` subscribers never see it. Retrying append
returns `Duplicate` and does not republish, so the gap is permanent for the
memory implementation (the SQL implementation's polling happens to heal it).

Make commit-plus-notification uninterruptible or derive live delivery from a
cursor over committed storage with PubSub only as a wake signal. Add an
instrumented latch at the post-commit boundary, interrupt there, retry, and
assert both `read` and an existing `live` subscription converge without a
duplicate.

### R176 — P2 — Delivery-log fan-out permanently retains one PubSub per written session

**State:** committed in `b79296d`.

`makeBuses` keeps a process-lifetime `Map<sessionId, PubSub>`. Both memory and
SQL `append` call `busFor(sessionId)` unconditionally before publishing, so a
bus is allocated and retained for every session that ever records an event,
including sessions with no live subscriber. There is no removal path and no
subscriber refcount. For the SQL implementation this defeats the expectation
that old session data lives in SQL rather than the process heap; a high-churn
service grows one PubSub plus map entry per historical session until restart.

Create fan-out lazily on scoped subscription, refcount it, and remove/shutdown
the bus when the last subscriber leaves. Append should publish only when a bus
is currently registered; SQL polling/read remains the source of truth. If the
memory log intentionally keeps a bus with its in-memory session record, make
that implementation choice separate. Add a churn test that appends to many
never-subscribed sessions and repeatedly opens/closes subscribers, then asserts
the registry returns to zero without sleeps and that an append racing the last
unsubscribe is still visible through the durable cursor.

### R177 — P2 — Delivery-log catch-up materializes an unbounded history in one query/effect

**State:** committed in `b79296d`.

`DeliveryLog.read` promises one array containing every event after a cursor,
and both stores build it eagerly. The SQL `live` poll likewise runs an
unlimited `SELECT ... sequence > cursor`, decodes every row, and returns the
whole batch before advancing. A long-running streamed conversation can record
one `MessageDelta` per provider chunk; a new consumer at offset zero or a slow
poller can therefore force an unbounded database result, decode allocation,
and heap spike. The cursor exists, but the API provides no page size or
continuation contract with which a transport can use it safely.

Add a bounded page API (`limit` plus next cursor) and implement live catch-up as
repeated ordered pages, yielding as it goes. Put an application-level maximum
on a page independent of caller input. Test more than two pages, an append
during pagination, malformed data in a later page, interruption between pages,
and a slow consumer while preserving exact sequence/no duplicates. A large-log
test should assert maximum rows decoded/retained per pull rather than merely
that all rows eventually arrive.

### R68 — P2 — `isStorageError` is an unsound type guard

**State:** committed in today's typed-storage work.

`src/Errors.ts:145-149` recognizes any non-null object with
`_tag === "StorageError"` as the full schema class. It does not validate
`operation`, `detail`, optional `sessionId`, or reconstruct the message getter.
The storage wrappers then pass such a value through unchanged, and
`DurableSubmission.isInfrastructure` changes a submission outcome based on the
same single field. A malformed driver error can therefore be typed and
classified as a valid public error until a later codec boundary fails.

Use `Schema.is(StorageError)` for narrowing and decode when a class instance is
required. Extend the round-trip test with malformed same-tag objects missing or
mis-typing every field.

### R174 — P1 — Remote-error detection can pass an arbitrary agent failure through the wire contract

**State:** committed client behavior, made more consequential by today's
durable/transport integration.

`src/client/AgentClient.ts:isRemote` recognizes only that an object has one of
six `_tag` strings. A tool or context transform may legally fail with, for
example, `{ _tag: "AgentBusyError" }` or the same tag with malformed fields.
`fromSession.prompt` then declines to wrap that failure as
`AgentExecutionError`, even though it is not a valid `RemoteError`; a later RPC
or HTTP schema encoding fails instead of carrying the agent failure. The guard
also examines only `Cause.findErrorOption`, so a composite cause whose first
failure happens to match can let unrelated failures through under the whole
`RemoteError` type.

Build a `Schema.Union` of the six error classes and validate the actual value,
and only preserve a cause when its complete shape is the single declared
remote failure expected from this boundary. Everything else should become one
`AgentExecutionError` through a total failure projection (R166). Add colliding-
tag tool errors with missing/wrong fields, plain lookalike objects, reconstructed
valid schema errors, and parallel/sequential composite causes through the
actual RPC/HTTP codecs. This is the transport analogue of R68's unsound
`StorageError` guard.

### R69 — P2 — The pending-input gauge is not compositional across observers

**State:** committed in `50dfafa`; tests use exactly one observer.

Each `Observability.metrics` invocation maintains its own `outstanding` count
but writes that absolute value to the same global gauge at
`src/observability/Observability.ts:427-434`. With two sessions and no distinct
base attributes, one observer applying its last input writes zero while the
other still has pending input. Interrupting or ending an observer with a
nonzero local count also leaves a stale gauge indefinitely.

Apply deltas to a shared up/down instrument, or require and automatically add a
stable session/deployment dimension and clean up on scope exit. Add two
concurrent streams whose queue transitions interleave, plus interruption and
normal-end cases, all under a fresh metric registry.

### R70 — P2 — Tool-duration correlation assumes tool-call IDs are globally unique

**State:** committed in `50dfafa`.

The `started` map in `Observability.metrics` is keyed only by `event.id`.
Tool-call IDs are provider/model identifiers and can be reused across turns,
runs, sessions, and merged event streams. A second start overwrites the first;
a terminal event can then measure against another call's timestamp and delete
its state. The stored start-side tool name is never checked or used.

Key by the envelope's session/submission/run/turn plus call id, verify the
terminal name, and define behavior for malformed lifecycle sequences. Test a
merged stream containing identical IDs from two sessions with overlapping
lifetimes.

### R175 — P2 — Tool duration metrics use an adjustable wall clock

**State:** committed in `50dfafa`.

`Observability.metrics` records `Clock.currentTimeMillis` at tool start and
terminal events and subtracts the two. Wall time can move backward or jump
forward under NTP/manual correction, so the histogram can receive a negative
duration or attribute a system-clock jump to a tool. Elapsed-time measurement
should use Effect's monotonic `Clock.currentTimeNanos`; convert the delta to
milliseconds only at the metric boundary.

Add a clock implementation whose wall time regresses while monotonic time
advances and assert the exact non-negative duration. Also test a very long
duration/conversion boundary and a terminal event without a start. Keep the
documented caveat that replay timing is meaningless; monotonic measurement
fixes live elapsed time, not replay semantics.

### R71 — P2 — Run-depth metrics omit every failed or interrupted run

**State:** committed in `50dfafa`.

`turnsPerRun` updates only on `RunCompleted`. Failed and interrupted runs have
no `turns` payload, even though preceding `TurnCompleted` envelopes expose
their committed depth. The resulting histogram systematically removes the
runs most relevant to diagnosing loops and reliability while its description
claims to show “turns taken by one run.”

Track completed turns per correlated run in the observer and record the depth
on all three terminal run events, with an outcome attribute. Add failed and
interrupted real-run tests rather than only a successful scripted run.

### R72 — P2 — Retry-schedule tests are deliberately nondeterministic

**State:** committed in `9957dfe`.

`test/Schedules.test.ts` samples real jitter and asserts that two independently
generated sequences differ. This directly violates the repository requirement
that tests be deterministic and can fail probabilistically after duration
rounding. The tests also assert only loose ranges, not the exact scheduling
shape under a controlled random source.

Provide deterministic `Random`/`TestRandom` values and assert exact delays,
including jitter extremes followed by capping. Separately, update
`DurableAgentClient.Options.pollInterval`: it still says “how often” polling
occurs, while the implementation now treats it as the exponential start and
caps it at one second—even when the caller requested an interval greater than
the cap. Validate positive finite durations and document the new semantics.
Finally, pin the call-site wiring: reverting one consumer to `Schedule.spaced`
currently leaves `test/Schedules.test.ts` green because it exercises only the
helper schedules.

### R170 — P1 — The cluster client turns exhausted transport failures into defects

**State:** committed in `1d730cf`/`9957dfe`; confirmed in the current
`src/cluster/EntityClient.ts`.

The public `EntityClient` declares no infrastructure error for `submit`,
`interrupt`, or `respond`, and only `AgentIdleError` for admission. Its
`infrastructural` and `admitting` wrappers retry selected cluster failures 600
times and then call `Effect.die`. A shard outage, mailbox pressure, persistence
failure, or runner failure is therefore reported as a programmer defect after
roughly a minute even though retrying later, routing elsewhere, or surfacing a
503 is normal caller behavior. This conflicts with the repository rule that a
public error channel name what can go wrong and is inconsistent with the
protocol-neutral `AgentClient`, which already exposes `AgentTransportError`.

Preserve a typed transport error after the bounded retry policy (or expose the
raw closed cluster union if this lower-level client is meant to be cluster-
specific). Keep `AgentIdleError` distinct. Add deterministic `TestClock` tests
for every classified transient, an exhausted retry, an immediately
non-transient storage/persistence failure, interruption during backoff, and
the `AlreadyProcessingMessage` idempotency interpretation. The current cluster
tests exercise successful wrapping and the idle domain error only, so neither
the retry budget nor the defect conversion is pinned.

### R172 — P1 — `AgentEntity.submit` can acknowledge work that will never execute

**State:** committed cluster behavior, explicitly exposed by today's E14
triage in `8301cd9`.

The entity handler opens admission, launches workflow dispatch with
`Effect.forkDetach`, and immediately returns the derived execution id. There is
no persisted claim/outbox before that acknowledgement. Process loss after the
RPC returns but before the detached fiber dispatches loses the submission and
can leave the shared admission marker open with no execution that will ever
drain its channels. An in-process dispatch failure is merely logged after the
caller has already been told the submission started.

The same surface also cannot start a second submission for one session. Its
execution id is a pure function of the session, so the workflow engine rejoins
the completed first execution and ignores the new prompt; the handler still
returns success and reopens admission. The source comment acknowledges this
and points callers to `DurableAgentClient`, but `EntityClient.submit` publicly
promises “Start a submission” without a one-shot type or failure.

Either retire/narrow this to an explicitly one-shot dispatch API, or route it
through the durable client's persisted claim-and-reconciliation protocol.
Acknowledgement must follow durable dispatch intent, and repeat submissions
must execute or fail explicitly. Add crash-boundary tests before/after claim,
open, dispatch, and acknowledgement; a dispatch-failure test; and two
sequential submit calls asserting the second prompt actually reaches the
model. Also verify no orphan admission marker accepts work after a lost
dispatch.

### R73 — P2 — The cast inventory does not recognize a direct `as never` escape

**State:** committed in `3919c4a`; current tests contain this escape form.

`castsIn` counts `type === "any"` and a nested assertion whose inner target is
`any | unknown | never`, but not a direct `x as never`. `never` is assignable to
every type, so this is itself a checker escape; tests use it to fabricate event
and identifier shapes, including the newly added synthetic observability
envelope. The inventory also scans only `src/**/*.ts`, although the repository
rule explicitly says test/example code is caller code.

Count direct `never`, inventory erasing assertions in tests/examples as well,
and replace the new observability fabrication with schema constructors or real
event values. Add detector unit cases for direct `as never`, parenthesized and
angle-bracket forms, `.tsx`, and a deliberately broken fixture that proves each
path fails.

### R74 — P2 — Deferred TUI scrollback work outlives the Solid component

**State:** committed TUI behavior; identified using the Solid 1.x lifecycle
rules.

`apps/tui/src/App.tsx:308-316` schedules an untracked `queueMicrotask` from a
`createEffect`, but registers no `onCleanup`. If the app unmounts or rendering
fails before the microtask runs, it still mutates the store and writes through
a renderer belonging to a disposed owner. Multiple queued microtasks also have
no generation/cancellation guard.

Track disposal with `onCleanup` (or use an owner-aware scheduler) and coalesce
pending drains. Add a test that changes entries, disposes before the microtask,
then flushes microtasks and proves neither scrollback nor store changes.

### R75 — P2 — TUI harness shutdown is a process-global single slot and render failure leaks it

**State:** the committed single slot is being replaced by a moving per-handle
set. Render/root-failure cleanup remains open; R149 covers the new non-awaited
close contract. Related to but distinct from R31's detached operation fibers.

Every `start` overwrites module-global `disposeFiber`; `stop` can close only the
most recently started harness, so multiple instances leak earlier scopes.
`main.tsx` calls `stop()` only after `await render`; a thrown/rejected render
skips cleanup. If the root fiber fails after the start promise resolves, its
later `reject` is ignored and the UI retains a handle to a dead session.

Return an instance-scoped `{ handle, close }` acquisition (preferably a scoped
Effect/Layer), put rendering in `try/finally`, and surface post-start root
failure to the UI. Test two simultaneous harnesses, independent close order,
render rejection, and root failure after startup.

The moving `running` set fixes only which fibers can be found. `main.tsx` still
calls the global `stop()` after `await render` rather than in `finally`, and a
root fiber failure after `start` resolves still calls an already-settled
Promise's `reject`. Its disposer remains in the set and the caller retains a
dead handle with no failure signal.

### R76 — P1 — AgentState tags with the same id can return a value of the wrong static type

**State:** committed public API; reproduced without a caller cast.

`AgentState.Tag<A>(id)` allows the same runtime Context key to be created at
incompatible types. Merging `AgentState.layer(Tag<number>("same"), ...)` and
`AgentState.layer(Tag<string>("same"), ...)` typechecks; reading the number tag
can return the string service at runtime because both keys are `"same"`. The
module comment actually promises that same-id tags are the same service, but
the generic factory provides no way to prove their `A` agrees.

Make identity a value created once and carried with its type (for example a
class/tag declaration or a branded key constructor tied to a schema), rather
than reconstructible from an arbitrary string. Add a cast-free negative/positive
type fixture and a runtime merged-layer test with same-text identifiers.

### R77 — P1 — NodeStore's exported “append-only” seam can rewrite ancestors and corrupt indexes

**State:** committed in `a7c4b9e`; the conformance test explicitly permits
replacement by id.

`NodeStore.put` accepts a full node plus full history even when the id already
exists. Both implementations overwrite them, while the existing root/order/
children indexes are left untouched. Although `SessionTree.commit` currently
uses this to change a label/cause, any caller or racing stale write can also
change the parent or history of an ancestor, violating IT3 and leaving indexes
that disagree with `get`.

Separate immutable insertion from a narrowly typed metadata mark, and make
duplicate insertion either idempotent only for byte-identical content or a
typed conflict. Conformance tests must attempt same-id changes to history,
parent, time, label, and cause and assert exactly which mutations are legal.

### R167 — P1 — The memory NodeStore can be rewritten through caller-owned aliases

**State:** committed in `a7c4b9e`; the key-value and memory implementations do
not have equivalent value semantics.

`NodeStore.memory.put` stores the exact `node` and `history` objects it is
handed and `get`/list operations return those same references. TypeScript's
`readonly` does not freeze values: a caller can build an ordinary mutable
object structurally assignable to `Node`, put it, then mutate that original
object without a cast. Prompt/message/content arrays can likewise be retained
and changed through a mutable source alias. The store then silently rewrites an
ancestor/history without another `put`, bypassing even R77's chance to validate
an update and potentially changing parent/root/children answers. The key-value
adapter encodes on set and therefore snapshots the value, so tests against the
default memory store can pass while persistent behavior differs.

Snapshot/freeze inputs at the memory boundary and return immutable snapshots,
or narrow/document the seam as trusted internal ownership and stop exporting
it as a general store. Prefer a schema clone if parity with the persistent
codec is required, while measuring the intentional sharing optimization.
Contract tests should mutate pre-put source objects/arrays and values obtained
from `get`, then assert stored node, history and indexes remain unchanged for
both implementations without using casts.

### R78 — P1 — Tree traversal has no cycle/corruption defense

**State:** committed behavior, made reachable by the public NodeStore seam.

`SessionTree.path` follows parent pointers until `None` without a visited set.
The store interface and implementations accept a self-parent or longer cycle,
so `path`, `summary`, `commonAncestor`, and `divergence` can loop forever on a
corrupt/custom store. The new in-progress subtree traversal has the analogous
problem in the child direction.

Detect repeated node ids and return a typed corruption failure; validate parent
existence/cycle freedom on insertion where the store can. Add self-cycle,
two-node cycle, missing-parent, and repeated-child fixtures to every store/tree
conformance suite, with deterministic termination assertions.

### R87 — P2 — StorageError identifiers are populated inconsistently across stores

**State:** committed in today's typed-storage changes.

`DurableSessionStore` and `DeliveryLog` put the affected session in the public
`sessionId` field. `DurableChannels` instead embeds its session-derived channel
key in `detail`, and `AgentState` does the same with an arbitrary persistence
key. Five near-duplicate error-wrapping helpers now disagree about which part
of the error is structured. A consumer filtering retry/reporting by session
works for half the durable stores and silently misses channel failures.

Use one shared error constructor/wrapper and rename/generalize the identifier
field (`resource`/`id`) so non-session stores can populate it honestly; a
separate optional `sessionId` can remain when known. Fault-inject each store and
assert operation, structured identifier, cause detail, and preservation of an
already-typed `StorageError`.

### R168 — P2 — The new shared storage-error formatter can defect instead of producing StorageError

**State:** introduced in today's typed-storage audit and used by nine error
mapping sites.

`internal/detail.detailOf` promises to turn an `unknown` platform/store cause
into the `detail` string of a typed `StorageError`, but its fallback is an
unguarded `String(cause)`. A null-prototype object already throws “Cannot
convert object to primitive”; a Proxy or object with a throwing primitive/
`toString` hook does the same. Some `instanceof Error` checks can also interact
with hostile proxies. The mapper then defects and replaces the storage failure
instead of returning the typed error the audit was intended to establish.

Make this small boundary total and bounded, using nested guarded fallbacks to a
constant diagnostic when reflection/coercion fails. Reuse that safe inspector
with R166 rather than maintaining two subtly different unknown-error paths.
Inject null-prototype values, throwing coercions/proxies, symbols, bigint,
empty-message errors and oversized messages at every decorated store family;
assert the advertised `StorageError` channel and structured operation/id remain
available.

### R88 — P2 — Three process/durability tests have shown intermittent full-suite failures

**State:** observed in repeated repository review runs and recorded in the
checked-in first-pass review; not reproduced deterministically yet.

The affected tests are the durable fetch replay invariant, MCP stdio
interruption/cleanup, and sandbox descendant-pipe cleanup. Each passed in
isolation and subsequently, which points to load-sensitive synchronization or
process cleanup rather than a stable assertion failure. Re-running is not an
acceptable long-term answer for tests that claim no duplicate durable side
effects or no orphaned subprocesses.

Run each under repeat/full-suite contention, capture open processes/handles and
fiber dumps on timeout, and replace any timing-based readiness with a real
Deferred/IPC latch. Quarantine only with a tracked cause and expiry, never by
loosening timeouts until it usually passes.

### R89 — P3 — The tracer's span-event redaction branch has no coverage

**State:** committed privacy-control branch; attribute redaction alone is
tested.

`redactSpan.event` filters matching keys from event attributes, but the tracing
suite exercises only `span.attribute`. Effect AI currently uses the latter;
an upstream change to events or an application relying on the public wrapper
could regress the untested branch and leak content.

Drive a wrapped span event containing `parameters`, a kept attribute, and a
rewrite hook, then assert the underlying tracer receives exactly the sanitized
event without mutating the caller's attribute object.

### R90 — P3 — The portability/build gate still excludes first-party apps and vendored drift

**State:** committed repository configuration; overlaps R30's TUI check gap.

The root typecheck, Effect diagnostics, portability scan, and Vitest discovery
cover `src`, `test`, and `examples`, not `apps/tui`. The TUI's separate
typecheck currently passes only when invoked manually. Its 4,865-line vendored
OpenCode reference is imported nowhere, checked nowhere, and has no drift rule;
it more than doubles the app's source/licence surface without mechanically
proving the port still corresponds to it.

Put every first-party app's typecheck/tests into `npm run check`. Either retain
only the pinned upstream commit/license or add an explicit provenance/drift
check for the vendored snapshot.

## Findings first observed in the moving working tree

The repository continued committing work during this review. The web-fetch
implementation first seen in progress was bundled into the otherwise named
tree-observer commit `7622988`; those findings are now R113-R120, while some
of its tests/status text remain uncommitted. The export/redaction/tree findings first seen
in progress landed in `d4ed1c8` and `a2e27a9` and are now numbered R79-R86;
the storage-fault findings landed in `c218ee9` and are numbered R91-R93; the
live-TUI findings landed in `1ff95a3` and are numbered R96-R99; and the
palette/history findings landed in `f7dd652` and are numbered R100-R106. The
first TUI terminalization/root-gate fixes landed in `1770ba9`; their remaining
findings are R140-R142.

### W1 — Resolved during review — The in-progress `ExecutionPlan` tests initially failed typecheck

The first in-progress version failed in `test/ExecutionPlan.test.ts` with one
invalid service-method assertion and two invariant `ExecutionPlan` generic
mismatches. Commit `81611f8` made the tree typecheck, so this is no longer a
current build failure. R16-R19 record the remaining contract defects that a
green typecheck does not detect.

### R113 — P1 — The bounded HTTP body fold has quadratic chunk accumulation

**State:** committed in `7622988`.

`src/web/http.ts` retains chunks with `{ chunks: [...current.chunks, chunk] }`
for every streamed piece. The one-MiB byte limit does not bound the number of
chunks: a conforming/custom `HttpClient` can deliver one-byte chunks and force
quadratic array copying and extreme allocation before the byte cap is reached.
Effect interruption cannot help while each synchronous copy runs.

Use a mutable builder scoped inside the fold, a chunk queue with O(1) append,
or preallocate only when a trustworthy declared length exists. Add a 1-byte-
chunk response at the full limit and assert a linear operation/allocation
bound, plus interruption during a high-chunk-count stream.

### R114 — P1 — The guarded fetch layer can inherit and leak ambient HttpClient credentials

**State:** committed in `7622988`.

The provider builds a fresh request with only `Accept`, but executes whatever
abstract `HttpClient` the application supplied. Client middleware can add
`Authorization`, cookies, proxy credentials, or other ambient headers to the
model-selected origin. `FetchHttpClient.RequestInit.credentials = "omit"`
governs Fetch-managed credentials only and, like the manual redirect option in
R26, is not part of the abstract client contract.

Require a dedicated no-ambient-auth client capability/constructor, or sanitize
at a transport boundary whose semantics are typed. Document that applications
must not provide their general authenticated client. Test a client middleware
that attempts to inject authorization and a cookie, including redirects.

### R115 — P2 — The provider-neutral FetchResult schema does not encode its contract

**State:** committed in `7622988`.

`FetchResult` accepts any number for status and arbitrary strings for final URL
and media type. A custom provider can return a negative/fractional status, a
credential-bearing or non-HTTP final URL, or an invalid media type; the web
tool then labels and journals it as a successful guarded fetch. The built-in
provider is stricter, but the service schema is the contract all providers
claim to implement.

Use constrained integer/status schemas and canonical URL/media-type codecs, or
validate provider output at the tool boundary. Add malformed canned/custom
provider results and prove they fail with a typed provider-contract error.

### R116 — P1 — Interactive fetch approval hides the path and query that will leave the machine

**State:** committed in `7622988`.

`WebToolkit.Fetch` projects `net.fetch` to the canonical origin. That is a
reasonable key for origin-scoped remembered authority, but it is also the only
resource placed in `Permission.ApprovalDetail`. The TUI has no web-specific
approval view, so its generic prompt displays only that resource. A call to
`https://example.com/upload?token=<local-secret>` is therefore shown as merely
`https://example.com`; the user cannot see the data the model is about to send.

The policy evaluator does receive the encoded tool parameters, but the human
elicitation boundary deliberately drops them. Separate the *displayed
invocation* from the *remembered permission scope*: show a sanitized canonical
full URL for the current approval while, if origin-wide remembering is an
explicit product choice, key that remembered grant by origin. Add tests for
credentials, sensitive query/path values, and an origin-level remembered grant
so the UI contract and caching scope cannot be confused.

### R117 — P1 — A malformed redirect can put embedded credentials into typed errors and logs

**State:** committed in `7622988`.

Credential scrubbing covers parsed URLs, including the initial target and a
valid credential-bearing redirect. It does not cover a redirect `Location`
that fails URL parsing: the `Effect.try` catch stores the raw header verbatim in
`WebFetchInvalidUrlError.url` (`src/web/http.ts:283`). A target can return a
value such as `https://user:secret@[` and cause the secret to appear in the
error's encoded form, message, durable failure, and any logs that render it.

Do not retain the raw redirect location in a serializable error. Record a
constant/redacted placeholder (or only bounded non-sensitive parse metadata),
and test malformed locations containing user info, query secrets, control
characters, and very long values. The same rule should be applied to every
untrusted header copied into errors.

### R118 — P2 — Unsupported schemes and embedded credentials reach Permission before target validation

**State:** committed in `7622988`.

The tool schema is `Schema.URLFromString`, so it accepts `ftp:`, `mailto:`,
`data:` and credential-bearing HTTP URLs. Permission then projects their
origin (`"null"` for opaque URLs, or a sanitized HTTP origin) and may pause for
human approval. Only after approval does `/web/http` reject the target.

This contradicts the milestone's intended “accept only HTTP(S), reject
credentials, canonicalize before permission” boundary and produces meaningless
or misleading approval prompts. Put the scheme/credential refinement in the
decoded tool-parameter schema (while retaining provider-side validation as
defense in depth), then prove invalid targets invoke neither policy nor
provider. Private-address validation still belongs in the provider because it
is provider/runtime policy rather than URL syntax.

### R119 — P2 — W2 is marked complete without several acceptance tests named by PLAN.md

**State:** implementation committed in `7622988`; completion claim and some
focused tests remain in the moving worktree.

The focused tests cover direct `Ask` projection, and full-agent `Allow` and
`Deny`, but never drive an `Ask` through elicitation to prove provider
invocation exactly once. There is also no fetch-then-`write_file` composition
test, no exact lifecycle-event assertion for fetch, and no explicit TUI generic
fallback test. These are all listed in W2 acceptance, while `STATUS.md` already
states W2 is implemented and verified.

Add the missing behavioral tests before treating the milestone as closed. In
particular, the Ask test should cover approve, reject, remember, and interruption
while waiting; the latter also exercises the still-open R3/R25 lifecycle bugs.

### R120 — P1 — Fetch URL paths and queries bypass the package's metadata-only tracing promise

**State:** committed in `7622988`.

Effect's `HttpClient.make` creates an `http.client GET` span and annotates both
`url.full` and `url.query`. The fetch provider passes the model-selected full
URL to that client without disabling or redacting those attributes. Meanwhile
`Observability.defaultSpanRedaction` drops only `parameters` from
`ToolExecution.tool`. An application following the documented redacting-tracer
wiring therefore still exports credentials/tokens or local data embedded in a
fetch path/query through the nested HTTP span.

Treat the outbound URL as content, not metadata. Extend the application-facing
redaction wiring to cover `http.client GET` URL attributes for web tools, or
disable the generic client span inside the provider and add a provider-owned
span containing only canonical origin/status. Test with a unique secret in
both path and query and scan the entire exported span tree, not just the tool
span. Brave search has the analogous query leak through GET already recorded
in R9; switching that adapter to POST avoids relying on span-name policy.

### R121 — P2 — The committed history and status conceal that `web_fetch` already shipped

**State:** committed in `7622988`; current worktree is trying to reconcile it.

Commit `7622988` is titled only “fix(tree): capture turns from an observer, not
a subscription”, but also adds the exported `/web/http` entry, `WebFetch`
service and errors, the `web_fetch` tool, permission-decoding changes, canned
provider, and roughly a thousand lines of web implementation. At committed
HEAD, `STATUS.md` still says W2 remains unimplemented. The substantive HTTP and
composition test files are only now present as untracked worktree files.

This is more than untidy history: reviewers, release notes, bisect, and a revert
of the apparently tree-only fix will all miss or unintentionally remove a
network capability. It also defeats `STATUS.md`'s role as the record of what is
built and why, and allowed an exported security boundary to exist in committed
code without its milestone acceptance suite.

Keep capability commits reviewable and atomic: split tree observation,
permission decoding, and guarded fetch into separately named commits, with the
fetch tests and STATUS transition in the same commit as its export. Before the
next release, audit the packed diff rather than commit subjects and ensure no
other “unimplemented” capability is already exported.

### R124 — P3 — The HTTP provider accepts malformed Content-Type values as textual

**State:** committed in `7622988`.

`mediaTypeOf` takes everything before the first semicolon and
`textualFormat` accepts any value beginning with `text/`. It does not parse or
validate the HTTP media-type grammar. Values such as `text/`,
`text/plain garbage`, or a comma-joined
`text/html, application/octet-stream` are therefore treated as supported
text and copied into `FetchResult.mediaType`. The charset extractor is another
independent regex rather than parameters from the same parsed value. This is
bounded by the byte limit, so it is hardening rather than an SSRF bypass, but
it weakens the claimed textual-content boundary and feeds invalid metadata to
the model/journal.

Use the platform's structured media-type parser if available, or implement a
small strict token/parameter decoder with duplicate/quoted-parameter policy.
Add malformed type/subtype, comma-joined values, duplicate charset, quoted
escapes, mixed case/whitespace, and valid `+json`/`+xml` fixtures.

### R126 — P2 — Fetched content can forge its own trust-boundary delimiter

**State:** committed in `7622988`.

`WebToolkit.untrustedBody` surrounds the provider body with fixed, public
`BEGIN UNTRUSTED WEB CONTENT` / `END UNTRUSTED WEB CONTENT` strings. The body
is attacker-controlled and is not escaped, so a page can include the exact end
marker, follow it with instructions that visually appear outside the marked
region, and optionally add another begin marker to make the final wrapper look
balanced. The composition test merely checks that both marker substrings occur;
it does not attempt to forge either one. This makes the documented “clearly
delimited” protection weaker than it appears and can increase, rather than
reduce, a model's confidence in the spoofed boundary.

Keep untrusted data in the tool-result structure and make the trust statement
part of the tool/system contract, not syntax controlled by the same text. If a
text framing protocol is still useful, use an unguessable per-result boundary
or a length-prefixed/escaped representation and say explicitly that framing is
an aid rather than a prompt-injection security boundary. Add bodies containing
both markers, nested/partial markers, the source URL, very long lines, and
Unicode lookalikes, then assert the model-facing representation cannot place
attacker text outside the declared data field/frame.

### W13 — Resolved during review — The first palette/branch draft did not typecheck

The first draft reported eight errors: the benchmark `Handle` lacked the
new command/branch members, `views` and `SandboxPath` are unresolved, command
effects are declared infallible/requirement-free while carrying `NodeMissing`
and `unknown`, and related branch/export paths do not satisfy the advertised
signature. Root `npm run check` does not see any of these because the TUI is
still outside it (R90).

The moving worktree subsequently made `npm --prefix apps/tui run typecheck`
green. R102 records that several channels were erased with `Effect.ignore`
rather than handled for the user, so the build blocker is gone while the
failure-semantics concern remains.

### R140 — P2 — The new TUI regression cases fabricate events with `as never`

**State:** committed in `1770ba9`.

The moving smoke suite passes incomplete `{ _tag: ... }` objects through
`terminal as never` and uses three more `as never` casts for elicitation
events. `MessageFailed` is missing its required `failure`; the elicitation
shapes likewise bypass the public event schema. AGENTS.md explicitly says test
code is user code and uses no casts, and this pattern makes future event-schema
changes invisible to the tests that are supposed to guard projection behavior.

Construct complete events with `satisfies AgentEvent.AgentEvent`, use exported
schema constructors/decoders, or give the projection a deliberately narrower
typed test input at its own boundary. Extend `Casts.test.ts` to enforce the
no-cast rule over tests/examples/apps as already recommended by R73/R91.

### R141 — P2 — A failed or interrupted partial assistant message is rendered as ordinary completion

**State:** committed in `1770ba9`.

The moving R14 fix clears `streaming` for `MessageFailed` and
`MessageInterrupted`, but leaves the assistant entry otherwise identical to a
successfully completed message. Core's event contract separates these cases
specifically so consumers can show them differently. In a long transcript the
later generic “interrupted” or `prompt failed` notice can be off-screen, while
the partial text itself looks canonical even though the event docs guarantee
it was never committed to history.

Add an interrupted/failed visual state or append an explicit marker to that
entry, retaining the partial text as observational output. The test must assert
the distinction, not only that `drainSettled` eventually removes the row; also
compare the restored transcript, which correctly has no such canonical
assistant message.

### R142 — P1 — The new root gate still runs zero Effect diagnostics over the TUI

**State:** committed in `1770ba9`; reproduced directly.

The moving `package.json` adds `typecheck:tui` and `smoke:tui` to `npm run
check`, and both pass. `apps/tui/tsconfig.json` does not contain the required
`@effect/language-service` plugin, however, while the root tsconfig excludes
`apps/`. Running
`npx effect-language-service diagnostics --project apps/tui/tsconfig.json`
reports “Checked 0 files out of 13 files.” Thus none of the Effect-heavy
harness/backend code is checked for the repository's mandatory Effect
diagnostics even after the gate change.

Add the plugin to the app tsconfig and an explicit `lint:tui` command to the
root gate, asserting a nonzero checked-file count as well as zero diagnostics.
Keep the clean/frozen app dependency check and vendored-source accounting from
R90/R98; root-hoisted resolution plus a passing runtime smoke does not prove
either one.

### R143 — P1 — Fetch failures serialize path and query secrets in full URLs

**State:** committed in `7622988`; the moving credential scrub fixes only URL
userinfo.

`WebFetchTransportError`, `WebFetchHttpResponseError`,
`WebFetchRedirectLimitError`, `WebFetchUnsupportedContentTypeError`,
`WebFetchResponseTooLargeError`, `WebFetchDecodeError`, and
`WebFetchTimeoutError` all carry `url: Schema.String`, and `/web/http` fills it
with `current.href`. A model-selected URL such as
`https://example.com/private/<secret>?token=<secret>` therefore copies those
values into a serializable tagged error and its derived message. The tool
handler normally maps the failure to safer prose, but direct provider users,
Effect failure tracing/logging, and failures before that mapping boundary can
still retain the complete URL. `safeHref` removes `username:password@` only;
it deliberately leaves path and query intact.

Define one target-redaction policy for every web error and telemetry path,
normally retaining canonical origin plus a bounded/redacted diagnostic path
and never a query. Treat the cross-origin redirect's model-visible destination
as a separate intentional capability result. Add unique secrets in path,
query, fragment and userinfo across transport, HTTP status, timeout, decode,
content-type and size failures, then scan encoded errors, messages and spans.
R117 covers the additional server-controlled header/location inputs, and R120
covers the nested HTTP span leak.

### R144 — P2 — Decoding-service requirements are asserted internally but never proven at the public boundary

**State:** introduced by the decoded-permission prerequisite in `7622988`.

`decodePermissionParameters` correctly spells its requirement as
`Tool.ParametersSchema<T>["DecodingServices"]`, but indexed lookup in
`executeOne` then needs a hand-written requirement-channel assertion to widen
that effect to `Tool.HandlerServices<Tools[keyof Tools]>`. The new Date and URL
tests use transformations with `DecodingServices = never`; they prove decoded
values, but cannot prove that a schema-backed service is required by
`AgentSession.make`, available during permission evaluation, and reused
correctly by handler validation. This is exactly the kind of public signature
change the repository says must receive a break-once inference assertion.

Add a parameter codec whose decode getter requires a dedicated Context service.
Assert without casts that the service appears in the complete agent/session
requirement, deliberately break that assertion once, and run a permission plus
handler call with the Layer supplied. Also exercise missing service at compile
time and interruption/failure during service-backed decoding. R2 remains the
runtime problem that the codec currently executes twice.

### R145 — P2 — The transformed durable-tool codec is covered only on the batch path

**State:** moving change in `src/durable/DurableModel.ts` and
`test/WebDurable.test.ts`.

The new fetch replay test uses `DurableAgent.workflow` with its default
`stream: false`. It proves that a completed batch response containing an
encoded `URLFromString` tool call can be journalled and replayed. It does not
exercise `DurableModel.streamText`, whose replay branch encodes the recovered
parts through the newly asserted `partsSchema`, converts them with
`streamPartsFor`, and exposes them again as stream parts. That branch contains
two closed-method erasures and is precisely where encoded-versus-decoded tool
parameters are easiest to regress independently of batch generation.

Run the same transformed tool call with durable streaming enabled, suspend
after the completed call, resume in a fresh workflow execution, and assert the
exact stream/lifecycle events, canonical history and single provider call.
Include invalid transformed parameters and a result schema with encoding/
decoding services so the constructed toolkit's service channels are proven,
not only asserted.

### R162 — P2 — Durable model streaming removes backpressure with an unbounded queue

**State:** committed durable streaming behavior, made directly relevant by the
moving `DurableModel` codec change; no slow-consumer test covers this wrapper.

`DurableModel.streamText` constructs `Stream.callback` without queue options,
whose Effect v4 default is an infinite-capacity queue. The activity consumes
the provider stream in its own fiber and calls `Queue.offerUnsafe` for every
part, so it can run arbitrarily far ahead of the harness/model-stream consumer.
The ordinary stream's backpressure is replaced by unbounded heap retention of
token, reasoning, tool-call and metadata parts until the consumer catches up.
The tests establish semantic replay but do not hold the consumer while a large
provider burst is produced, so this resource behavior is invisible.

Choose and document the intended coupling. If delivery should backpressure the
provider, use a bounded queue and an effectful `Queue.offer` inside the fold. If
the activity must finish independently, give the buffer a hard budget and
persist/spool beyond it rather than using process memory as the delivery log;
dropping parts is not acceptable because the first-run history would diverge
from the journal. Add a latch-controlled slow/abandoned consumer test with a
large burst, heap/buffer bound, interruption, and exact first-run versus replay
history.

### R146 — P3 — The guarded fetch provider has no explicit destination-port policy

**State:** committed in `7622988`; the design authority names the effective
port as part of permission scope but never decides which ports the provider
may contact.

After scheme/address checks, `/web/http` accepts every explicit TCP port. An
allowed `net.fetch` call can therefore send an HTTP request to administrative
or non-HTTP services such as `:2375`, `:9200`, or `:25`; this expands the
cross-protocol and exposed-control-plane surface beyond ordinary public web
retrieval. Including the port in the approval origin distinguishes grants, but
does not harden applications whose network policy allows fetch broadly.

Make this an explicit provider option/policy rather than an accidental
default: a conservative adapter can allow only 80/443 (possibly an
application-supplied allowlist), while a deliberately general adapter can
document arbitrary-port authority. Test blocked and opted-in ports, redirects
that change port, default-port canonicalization, and IPv4/IPv6 literals. If
arbitrary ports are intentionally in W2, record that decision in `PLAN.md` and
the provider security contract.

### R153 — P2 — Lexically local service-discovery hostnames pass the fetch guard

**State:** committed in `7622988`; distinct from the documented dynamic DNS
resolution/rebinding limitation.

`validateTarget` rejects `localhost`, `.localhost`, `.local`, and four exact
metadata names, but accepts single-label names (`http://kubernetes/`,
`http://redis/`), common private discovery suffixes such as `.internal`,
`.svc`, and `.home.arpa`, and provider-specific internal aliases not in the
small exact set. In a corporate network or cluster those names are designed to
resolve through a search domain/private resolver. The provider cannot verify
the resulting address through abstract `HttpClient`, but it can establish from
the lexical form that these are not ordinary public-web names—the same
baseline heuristic already used for `.local`.

Choose and document a hostname policy: conservatively require a public-looking
FQDN and reject maintained local/reserved suffixes, or require an application
allowlist/egress proxy for environments that need internal-name access. Add
single-label, trailing-dot, search-domain, Kubernetes, home.arpa, internal
metadata aliases, IDNA and mixed-case tables. Strong address enforcement still
requires the R26 runtime/proxy boundary; this finding is about avoidable names
the portable layer currently sends without even that lexical warning.

### R154 — P1 — `web_fetch` has no provider-local concurrency or rate bound

**State:** committed in `7622988`.

Agents default to `ToolExecution.Parallel`, whose implementation uses
unbounded `Effect.all`. Brave search adds a provider semaphore, but `/web/http`
executes every fetch immediately. A single model response containing many
`web_fetch` calls can therefore open all requests concurrently and retain up to
1 MiB of body state plus redirects for each for 20 seconds. An Allow policy is
not a resource limit; even an Ask policy can create a burst after approval.
This exposes the application and target to memory, connection, rate-limit and
request-flood pressure despite each individual call being bounded.

Put a configurable conservative concurrency limit in the live fetch provider,
ideally with a global and per-origin dimension, while preserving interruption
for fibers waiting on the permit. Decide whether a request-rate budget is also
needed before calling the adapter guarded. Add a latch-backed parallel-call
test that proves no more than the limit enters HTTP, interruption removes a
waiter, permits recover after every typed failure/timeout, and same-origin
redirects retain one permit for the whole logical fetch.

### R155 — P1 — The “no automatic retry” guarantee is not enforceable over an arbitrary HttpClient

**State:** committed in `7622988`; the focused test uses only a bare client.

`/web/http` itself does not call `Effect.retry`, and the test returns one 503
from `HttpClient.make` and observes one invocation. But the injected
`HttpClient` is already a fully composed service: application middleware can
retry transport failures/5xx, cache, rewrite requests, or otherwise execute
more than once before `client.execute` returns. Supplying
`FetchHttpClient.RequestInit` cannot remove those behaviors. The adapter
therefore claims a fetch is never retried while its public Layer accepts values
that retry it invisibly—material because a GET can still be externally
observable and W2 explicitly assigns retry policy to the caller/provider.

Require/build a dedicated raw client whose middleware policy is part of the
provider contract, or weaken the promise to “this adapter adds no retries” and
make applications responsible for a no-retry client. Add a deliberately
retrying client wrapper around a failing transport/503 and assert the chosen
boundary prevents or honestly exposes the duplicate. Audit cache, URL rewrite,
redirect and authentication middleware at the same seam; R26 and R114 cover
the security-specific members of that broader composition problem.

### R157 — P2 — The search tool's hard result limit is only a Brave-adapter convention

**State:** committed in `b575f6e`; directly reproducible with the exported
canned/provider-neutral seam.

`WebToolkit` advertises “at most 10 ranked results,” and PLAN.md calls ten a
hard maximum, but `handlers.web_search` returns the injected service's array
unchanged. Its success schema is an unbounded `Schema.Array`, and
`TestWebSearch.layer` ignores both the default and requested limit. Brave slices
its decoded results, but any other provider—including the first-party canned
provider—can return eleven or eleven thousand results through the same tool.
This violates the provider-neutral contract and moves a provider mistake
straight into model context and durable history; the byte limit in the Brave
adapter does not protect other providers or the tool boundary.

Normalize the effective limit once at the model-facing boundary and slice (or
reject) provider output there, while adapters may still ask upstream for that
many results to control cost. Make the canned provider respect the same
contract. Test omitted limit, 1, 10, an over-returning provider, and a very
large returned array, asserting the exact result sent to the model and
journal.

### R179 — P2 — HTTP byte caps are being treated as safe model-context budgets

**State:** committed search and moving fetch behavior.

Both HTTP adapters allow up to 1 MiB of response body. Search then permits up
to ten provider strings whose combined size can approach that cap, and fetch
places the full decoded body directly into the tool result. Those results enter
canonical history, the next model prompt, telemetry when enabled, and durable
journals. One successful request can therefore exceed a model's usable context,
produce a provider-side prompt-size failure on the next turn, and amplify
untrusted prompt-injection text even though the transport correctly avoided an
unbounded read. A network/memory ceiling and a model-context ceiling solve
different problems.

Define a substantially smaller model-facing character/token budget with an
honest truncation representation (`truncated`, original/returned byte counts,
and source URL), plus per-field limits for search results. Apply it at the
provider-neutral handler boundary so custom providers cannot bypass it (as in
R157). Add just-under/at/over-budget ASCII and multibyte bodies, ten oversized
snippets, durable replay, and a real next model call whose prompt size is
asserted. Keep the larger transport cap only if it is needed for parsing or
content conversion before the smaller projection.

### R158 — P1 — Brave redirects can forward the API key to another origin

**State:** committed in `b575f6e`; reproduced against the production transport
semantics.

The Brave request carries `x-subscription-token`, then delegates redirect
policy entirely to the injected `HttpClient`. The documented production wiring
uses Effect's `FetchHttpClient`, which defaults to `globalThis.fetch` and does
not set `redirect: "manual"`. Fetch strips a small standard set of sensitive
headers on a cross-origin redirect, but not this provider-specific header. A
local two-origin reproduction on the current Node runtime sent
`x-subscription-token: secret` to the redirect target. Thus a provider,
compromised endpoint, proxy, or unexpected operational redirect can violate
PLAN.md's guarantee that credentials go only to the provider endpoint. Header
*redaction* affects inspection; it does not prevent transmission.

Force manual redirect handling for the Brave adapter and either reject every
redirect or allow only an explicit provider-owned origin set after a fresh URL
check. Do not rely on ambient client behavior. Add a real Fetch-backed
two-server test that redirects across origins and asserts the second server is
never contacted and never receives the token; also cover same-origin policy,
redirect loops, downgrade, and cleanup of the rejected response body (R95).

### R159 — P1 — Brave's one-retry ceiling is not enforceable over an arbitrary HttpClient

**State:** committed in `b575f6e`; the provider test uses only bare
`HttpClient.make` values.

The adapter adds `Effect.retry({ times: 1 })`, but each logical `attempt` calls
an already-composed `HttpClient`. Middleware on that client can retry transport
failures or statuses any number of times before `execute` returns. Therefore
the public Layer cannot establish PLAN.md's “at most one retry” and “no Effect
HTTP default that can retry forever is accepted” guarantees; it establishes
only that this wrapper invokes its supplied client at most twice. For search,
hidden retries can multiply billed requests and resend the sensitive query and
credential.

As with R155, either construct/require a raw transport whose middleware policy
is controlled, or state the narrower compositional contract and make the
application responsible for supplying a bounded client. Test with a client
wrapper that retries internally and count physical requests, including an
interrupted retry delay and a timeout spanning every physical attempt.

### R160 — P3 — Brave treats an HTTP-date `Retry-After` as an arbitrary two-second delay

**State:** committed in `b575f6e`; missing protocol-form coverage.

`retryDelay` parses `Retry-After` only with `Number(value)`. The HTTP field also
allows an HTTP-date. Every valid date therefore takes the non-finite fallback
and waits exactly two seconds, including a date already in the past or less
than two seconds away. Invalid values are indistinguishable from long future
dates. The retry remains bounded, but it does not implement the server's
standard instruction faithfully and consumes avoidable time inside the shared
15-second budget.

Parse both delta-seconds and HTTP-date relative to Effect's clock, clamp the
result to zero through two seconds, and define the invalid-header fallback.
Use `TestClock` for past, near-future, far-future, malformed, negative and
fractional forms rather than wall time.

### R147 — P3 — Duration formatting can produce an impossible `1m 60s`

**State:** committed TUI helper; boundary coverage is missing.

`apps/tui/src/width.ts` floors whole minutes but rounds the remaining seconds
independently. Values from 119,500 through 119,999 milliseconds therefore
format as `1m 60s` instead of carrying into `2m 00s`. The smoke checks 125,000
milliseconds, safely away from the rollover, so the defect stays hidden.
Clock rollback can also feed a negative elapsed value because projection uses
`Date.now()` rather than Effect's monotonic duration facilities.

Round the total duration once and then divide into minutes/seconds (or use an
Effect Duration formatter), with an explicit policy for sub-second rounding.
Add table-driven cases immediately below/at/above 1s, 59.95s, 60s, 119.5s,
120s, and negative/clock-adjusted input.

### R148 — P1 — The committed idle guard is incomplete and check-then-act

**State:** committed in `759c5cf`.

`whileIdle` now guards `/branch` and `switchTo`, but the `/rewind` dispatcher
and direct `Handle.rewind` are still not routed through it. Ctrl+R happens to
have a renderer-side status check from `1770ba9`; the palette and any other
imperative caller can still rewind while a submission is running. Thus the
commit titled “an idle gate on every branch switch” leaves one of the original
branch-changing operations open.

The two guarded paths also read `session.status` and only then run activation.
Prompt submission, commands, and switching are launched in separate root
fibers, so a prompt can atomically claim the session after the guard reads
`idle` and before activation changes branches. The activation then reproduces
R104 despite the apparently central guard. The new smoke holds a run on
approval and proves only the easy already-running `/branch` case; it does not
exercise the admission race, `switchTo`, either rewind path, or concurrent
branch commands.

Serialize admission and branch changes through one harness command gate, or
add a core atomic “if idle, reserve transition” operation whose release is
finalized. Do not implement an invariant as status read followed by action.
Use a hanging model plus Deferred/explicit started latch to test fork, switch,
rewind, submit, and stop interleavings. The switch path should also remove its
new `Effect.orDie`: typed tree/store errors must become exact notices or remain
failures, not defects in an ignored root fiber.

### R149 — P1 — `Handle.stop()` returns before the harness is closed

**State:** non-awaited close committed in `759c5cf`; the Ctrl+D
`stop(); process.exit(0)` path committed in `7c07f9f`.

The committed shutdown API deletes its disposer from `running`, forks
`Fiber.interrupt(fiber)`, and immediately returns `void`. A caller can submit
or start a replacement harness before session/store/tree finalizers have run;
calling `stop` twice cannot await or retry because the handle has already
forgotten the disposer. The new test does exactly that—`firstHandle.stop()`
followed immediately by `firstHandle.submit(...)`—then waits an arbitrary 60
zero-delay timers. Whether the prompt is refused is scheduler timing, not the
promised postcondition.

The production Ctrl+D path makes the race terminal: `main.tsx` calls `stop()`
and then immediately `process.exit(0)`. The forked interrupt/finalizers are not
awaited, and explicit process exit is free to end the runtime before the
session tree and persistent store close. A graceful-looking keyboard exit can
therefore skip cleanup by construction.

Return an awaitable Effect/Promise close operation, make it idempotent, and
complete only after the owning fiber exits and all scoped finalizers finish.
Keep the handle registered until that completion. Test a finalizer held on a
Deferred, concurrent/repeated close, submit-during-close, and replacement start
against the same persistence store without sleeps.

### R150 — P1 — A smoke assertion failure can hang the new root check indefinitely

**State:** the root wrapper was committed in `1770ba9`; `759c5cf` adds more
long-lived harnesses without adding failure cleanup or a process timeout.

This review first reproduced the following sequence: standalone `smoke:tui`
passed; the same suite inside `npm run check` timed out waiting for `working`.
After the test was changed to hold a run on approval, `npm run smoke:tui`
instead timed out waiting for the refusal to fork before the corresponding
`759c5cf` implementation landed. That particular assertion now passes, but the
failure-cleanup mechanism is unchanged. In both runs Bun printed the thrown
error but did not exit until the parent PTY was interrupted.
The smoke module has already started long-lived harness/render fibers and has no
top-level `try/finally` that calls/awaits shutdown when an assertion or `until`
throws. `scripts/tui-smoke.mjs` uses blocking `spawnSync` with no timeout, so
the root check and CI job can remain stuck after the useful failure is printed.

Run the suite inside an owned scope/finally, make renderer and every harness
close awaitable (R149), and add a bounded child-process timeout that terminates
the child tree while preserving its exit output. Add a deliberate early throw
and a deliberate timeout fixture, asserting the wrapper exits nonzero within a
bounded duration and leaves no child process or session-store lock.

### R151 — P2 — The external SIGINT “shutdown” handler prevents process shutdown

**State:** committed TUI behavior; `7c07f9f` correctly adds a separate raw-mode
Ctrl+C path but does not change signal semantics.

`main.tsx` installs `process.on("SIGINT", () => handle.interrupt())`. Installing
the listener replaces Node/Bun's default SIGINT termination behavior, and the
callback only forks interruption of the current submission. If the process is
idle it effectively does nothing; if it is busy the submission returns to
idle and the renderer remains alive. This contradicts the new comment that the
handler catches a `kill` or parent-process shutdown, and can leave supervisors,
terminals, and CI waiting for a process they explicitly signaled to stop.
There is no SIGTERM/finally path either.

Keep raw keyboard Ctrl+C as “interrupt the turn,” but treat an operating-system
termination signal as graceful application shutdown: await the R149 close,
dispose the renderer, remove handlers, and then preserve the conventional exit
status. If a first-SIGINT-cancels/second-SIGINT-exits UX is desired, specify it
and make idle behavior exit. Test child processes signaled while idle, during a
model call, during approval, and during a blocked store finalizer, with a
bounded escalation to force termination.

### R152 — P2 — The new key smoke knowingly drives a printable key with two focused renderers alive

**State:** committed in `7c07f9f`.

The smoke creates `keyRender` while the original renderer remains alive, then
documents the platform fact that printable input goes to whichever focused
input owns the global keyboard, “not to whichever `mockInput` was called.” It
nevertheless sends `/` through the original renderer's `mockInput` while both
renderers still exist and asserts that the original store opened its palette.
That passed in the latest run, but the test's own stated focus contract says it
is not deterministic. It also dismisses by calling `sink.setPalette(undefined)`
directly, so removal or breakage of `PaletteView`'s Escape binding remains
green. Ctrl+D proves only that a stub callback increments, not that production
awaits shutdown; R149 is untouched.

Use one renderer per keyboard scenario and dispose it before constructing the
next, or drive all keys through one real App with explicit focus transitions.
Assert `/`, Escape, Up/Down and Enter as key sequences against state changes;
test Ctrl+D in a child process with an instrumented finalizer, and Ctrl+C
against a real held submission/event sequence. The test should not encode a
known global-focus race as an accepted platform detail.

### R161 — P2 — Footer setters do not preserve the footer state machine under concurrent transitions

**State:** committed across `f7dd652`, `30e3215`, and `1770ba9`; no transition
test covers overlapping run/UI events.

`FooterView` is a useful discriminated union, but `makeStore` exposes setters
that replace it without checking the state they are leaving. In particular,
`setApproval(undefined)` always writes `{ type: "prompt" }`. Every submission
terminal event calls it, so a user may open the palette or branch selector
while a run is working and have an unrelated `SubmissionCompleted` close that
surface. Conversely, `Handle.command`, `switchTo`, and the shared `dismiss`
unconditionally clear palette/branches; a stale selection or queued Escape can
overwrite an approval that arrived between the rendered interaction and the
setter. The union prevents two surfaces from being stored simultaneously, but
it does not make their transitions valid or ownership-aware.

Model footer changes as compare-and-transition operations: clear an approval
only if the current surface is that approval (ideally the same request id), and
clear a palette/selector only if it is still that surface. Decide whether a
submission terminal event should close user-owned menus at all. Add
latch-controlled tests for completion while palette/branches are open,
approval racing Escape/selection, late resolution of an old approval, and a
new approval following an interrupted one, asserting every intermediate
footer state rather than a late snapshot.

### W20 — Resolved during review — TRACE logging copied prompt input to stderr

One moving `App.onInput` draft contained
`if (process.env.TRACE) console.error("ONINPUT", JSON.stringify(value))`.
That would have copied every changed prompt value—including source snippets or
secrets—to stderr and corrupted the full-screen terminal whenever a commonly
named trace flag was set. It was removed before commit. Keep an explicit
no-content diagnostic logger if keyboard debugging is needed, and add a
secret-sentinel stderr assertion before enabling any input tracing.

### R109 — P1 — The TUI advertises “always” on a policy that cannot remember grants

**State:** committed in `30e3215`.

The approval footer labels `a` as “always” and sends
`{ value: { remember: true } }`, but the TUI's agent is wired directly to
`Permission.rules(...)`. That policy has no `remember` method. `ToolExecution`
therefore honors the current answer and deliberately skips persistence, making
`a` behaviorally identical to `y` for this application. The explanatory
`Handle.respond` comment acknowledges that a policy may decline to remember,
but the user-facing label makes an unconditional promise.

Wrap the rules in `Permission.remembered(...)` (which may require constructing
the policy effectfully in the harness Layer), or expose the key only when the
active policy actually supports persistence and label it “request always” if
that distinction is intentional. Add an end-to-end test that triggers the same
projected action/resource twice: `y` must ask twice, `a` must suppress the
second question, and a refusal must never persist.

### R110 — P1 — `/branch` does not preserve the fork point as a selectable line

**State:** committed in `30e3215`.

`forkHere` activates the current node under a new lane, but `branchItems`
returns only leaf nodes. After the forked session commits its first child, the
fork point is no longer a leaf and disappears from `/branches`; the lane name
advances to the new child. No lane or selectable item retains the original
endpoint, so the notice “the other line is still there” and the command
description “keep this line too” are false from the UI's perspective. The user
can reconstruct it only by rewinding, which is exactly the operation `/branch`
claims to avoid.

The smoke assertion hides the defect: it checks
`afterFork.length >= branchesBeforeFork` immediately before any prompt creates
a child, where activating the same endpoint need not increase the leaf count at
all. The second fork is even invoked while the branch selector remains open and
is synchronized on `entries.length === 0`, an already-true condition covered by
R105.

Represent saved endpoints independently of current leaves (for example, retain
a lane/bookmark for the original node as well as the new advancing lane), or
include named non-leaf nodes in the selector with explicit semantics. Test the
exact branch IDs before forking, submit and complete a turn on the fork, then
prove both the original endpoint and new leaf remain selectable and restore
their exact histories.

### R111 — P1 — Named activation can overwrite a lane before the activation commits

**State:** committed in `30e3215`; extends R6's interruption finding.

The new `activate(node, { lane })` path mutates both `laneOf` and `lanes` in
`install` before publishing `current` and before closing the previous scope.
`activate` closes the candidate scope when installation is interrupted, but it
does not roll back either lane mutation. An interrupted switch can therefore
leave a name pointing at a branch whose activation never succeeded; if the
name already existed, its previous target has already been destroyed. When
activation returns the same RcMap session for the same node, assigning another
lane also overwrites the single `laneOf[session.id]` entry while leaving the
old name behind as a stale alias that no longer advances.

Treat lane registration and activation publication as one commit with explicit
rollback, or move naming after the interruption-safe activation transition and
define whether one live session may own multiple lane aliases. Add deterministic
latches at every point between lane mutation, `currentScope`, `current`, and
old-scope closure; interrupt there and assert the exact old lane/current state
is preserved. Also test reactivating the same node under a second name and
reusing an existing name for a different node.

### R125 — P1 — Interrupted branch construction leaks a session into the caller's scope

**State:** committed across `a5d52ba` and `82890c7`; made more visible by
`30e3215`'s branch UI.

`SessionTree.branch` creates `AgentSession.make` directly in the caller's
ambient `Scope`, then separately updates `at`, `laneOf`, and `lanes` before
returning the handle (`SessionTree.ts:589-611`). If interruption lands after
the session acquisition but before return, the caller never receives the
branch, yet its finalizer remains registered in the long-lived outer scope and
the partial cursor/lane maps are not rolled back. The leaked session can retain
subscriptions, elicitation state, and model/tool environment until the entire
tree or application shuts down. `track(session, { lane })` has the analogous
smaller problem of writing `laneOf` before its observer acquisition completes.

Construct the branch under a private candidate scope, commit all registry
state only after acquisition succeeds, and transfer/retain that scope for the
returned lifetime; close it and roll back state on every non-success exit. Add
the same interruption latches used for activation after session creation and
between every registry mutation, asserting `beforeClose` runs, no lane/cursor
entry survives, and a later branch of the same node behaves as the first.

### R127 — P1 — A committed turn can be interrupted before the tree sees its boundary

**State:** cross-feature defect exposed by `7622988`'s automatic tree capture;
the underlying ordering predates today's tree feature.

`AgentTurn.execute` commits the assistant response and tool results to canonical
history under `Effect.uninterruptible`, then emits `MessageCompleted`, then
emits `TurnCompleted` (`AgentTurn.ts:315-329`). Both event emissions are back in
the interruptible region. `SessionTree.capture` records only when it observes
`TurnCompleted`. An interrupt after the history commit but before or during
those emissions therefore leaves a real committed turn with no tree node. If a
later turn completes, its capture includes both turns in one snapshot, so the
missing rewind boundary cannot be recovered. The submission can also report an
interruption even though its response is already in canonical history.

Treat commit plus the lifecycle events that attest to that commit as one short
uninterruptible publication transaction, or make history commit itself return
an atomic boundary record that the tree consumes independently of the lossy
event path. A deterministic test can attach an observer that signals and blocks
on `MessageCompleted`, interrupt the submission there, and assert exact
history, event sequence, node count, and next-turn parentage. Repeat at every
post-commit boundary and with an observer/store failure; sleeps and state
polling would not prove this race closed.

### R130 — P1 — The active branch scope and tree event feed outlive the tree scope

**State:** committed in `4834258`.

Every activation allocates a standalone closeable scope with `Scope.make()` and
stores it in `currentScope`. Failed candidates and prior activations are closed,
but there is no finalizer linking the *last* successful activation to the scope
that built `SessionTree`. `Scope.make` is explicitly caller-managed; it is not a
child of the ambient scope. Closing the tree therefore need not release that
scope's `RcMap` reference, event subscription, observer registration, or pump
fiber. The aggregate `feed` PubSub is likewise never shut down, so a
`tree.events` consumer in a different scope has no terminal signal after the
tree is gone.

Fork activation scopes from the tree's parent scope (or install one parent
finalizer that atomically takes/closes `currentScope`) and shut down `feed` at
the same lifetime boundary. Be explicit about finalizer order relative to the
`RcMap`. Add a `beforeClose` counter to the active session, close only the tree
scope, and assert the branch finalizes once, its observer/pump fibers terminate,
the reference count drains, and `tree.events` ends. Repeat after several
switches and while a feed subscriber is idle.

### R131 — P1 — Resume does not persist which branch the user actually left active

**State:** committed in `fccecb5`.

Startup chooses the node with the greatest `node.at` from `tree.nodes`
(`harness.ts:424-433`) and calls it where the user was when the process ended.
No activation, rewind, or branch-switch operation persists a checkout pointer,
however. If the user rewinds from a tip and exits before another turn, the tip
still has the newest capture time and restart silently undoes the rewind. The
same happens after switching to an older branch. Clock rollback and
millisecond ties make timestamp order weaker still.

Persist active-tree state as its own atomic record, updated only after a
successful activation transaction, rather than inferring it from immutable
node creation metadata. Decide whether an unclean shutdown should resume the
last committed checkout or ask the user. Test exit immediately after rewind,
switch, fork-without-prompt, equal timestamps, clock rollback, and a failed or
interrupted checkout write.

### R132 — P1 — Restored tool calls can show failures as successes and borrow another call's result

**State:** committed in `fccecb5`.

`restore.resultsById` flattens every tool result in the conversation into one
`Map<string, unknown>`, retaining only `part.result`. It discards
`isFailure`, `preliminary`, tool name, and turn identity. `entriesOf` then marks
every defined result `ok`, so a canonical failed tool result is repainted with
a success checkmark. A valid success whose decoded value is `undefined` is
instead marked failed. If a provider reuses a call id in a later turn, the
later result overwrites the earlier one and both restored calls display it.

Match calls to results within their canonical turn/tool-message structure and
retain the whole typed result part; status must come from `isFailure`, not
value presence. Treat duplicate/missing/final-vs-preliminary results as an
explicit corrupt/incomplete state. Add failed-string, successful `undefined`,
duplicate-id, same-id/different-tool, preliminary/final, and unmatched-result
histories with exact restored entries. R128 covers the analogous live-view
collision.

### R133 — P2 — Repainting changes and reorders canonical message content

**State:** committed in `fccecb5`.

`restore.textOf` concatenates all text parts and calls `.trim()`, then
`entriesOf` draws that merged text before every tool call. Leading/trailing
whitespace and whitespace-only assistant output therefore disappear, and an
assistant message ordered as text / tool call / text is repainted as merged
text / tool. File, image, audio, reasoning, source, and other supported parts
are silently omitted. This contradicts the module's central claim to “paint
what the conversation contains and nothing else” and makes the restored view
materially different from what the live projection showed.

Walk parts in canonical order and define a visible representation or explicit
unsupported marker for every part type; preserve text exactly unless the live
view applies the same normalization. Add mixed/interleaved multimodal parts,
reasoning policy, leading/trailing and whitespace-only text, empty messages,
and compare live-versus-restored semantic entry sequences.

### R134 — P1 — Live mode silently stores plaintext conversation inside the model-visible workspace

**State:** committed in `fccecb5`.

Selecting `--live` now automatically writes complete, unredacted prompt
snapshots under `<workspace>/.effect-agent/session`; there is no persistence
flag, startup disclosure, retention control, or permission decision. Those
snapshots can contain user prompts, source file contents, shell output, tool
arguments/results, and fetched external text. The directory is neither in this
repository's `.gitignore` nor `CodingToolkit`'s ignored search directories, so
it appears in listings, can fill search results, can be read back into model
context, and can be accidentally committed. `write_file`, `edit_file`, and
approved shell commands can also alter/delete the agent's own history and
indexes, turning workspace authority into persistence-metadata authority.

Separate application metadata from the tool-visible workspace through a host
state directory or a reserved sandbox namespace/capability, and make persistence
an explicit, disclosed choice. If workspace-local state is intentional, add it
to search/list policy, document and generate ignore guidance, use restrictive
permissions, and authenticate/version records so tampering is reported rather
than replayed. Test that ordinary coding tools cannot enumerate/read/write the
session store and that unique secrets never enter it when persistence is off.

### R135 — P2 — Persistence failures are erased at startup and hidden after startup

**State:** committed in `fccecb5`; compounds R44 and R97.

Both `Backend.store` and `start({ store })` expose `unknown` errors, the latter
weakens the store to `NodeStore<any>`, and acquisition is immediately
`Effect.orDie(options.store)` (`harness.ts:406`). A missing permission or file
provider failure becomes a defect formatted through a generic Promise
rejection. Once running, typed `StoreError`s from automatic capture are caught
and logged by R44 while the UI continues normally, so the user receives no
indication that promised persistence stopped.

Keep the concrete platform/setup and `StoreError` unions through the backend
and harness, render a pre-UI startup diagnostic deliberately, and move the live
UI into a visible degraded/not-persisting state after a capture failure (or
fail closed if that is the contract). Add acquisition, initial scan/decode,
disk-full, permission-loss, and mid-session write failures, asserting exact
user-visible state and retry/recovery behavior.

### R136 — P2 — Persistence shipped against the plan's explicit deferral and without status/docs updates

**State:** committed in `fccecb5`.

The design authority still lists “No session switching across processes” under
`docs/plan-tui-port.md`'s “Still not implemented,” and the TUI README's “Not
done yet” section still says session switching is absent. `STATUS.md` was not
changed by the commit. Thus a default live-mode disk side effect and recovery
contract shipped while every project record tells reviewers and users it did
not. This also bypassed the repository rule not to implement a deferred item
without resolving its policy decisions.

Authorize the milestone first: specify disclosure/opt-out, active-branch
semantics, corruption/migration, concurrency, privacy, retention, and model or
workspace provenance. Update plan, STATUS, README, and help in the same atomic
capability change; do not treat wiring to an existing store seam as resolving
those product policies.

### R137 — P2 — The persistence smoke test does not exercise persistence lifetimes or a restart

**State:** committed in `fccecb5`.

The smoke suite acquires a memory `KeyValueStore` inside `Effect.scoped`,
returns the service after that scope is closed, wraps it in `Effect.succeed`,
and runs both launches in one process. Memory happens to have no meaningful
finalizer, masking the exact lifetime rule the production comment says is
load-bearing. The shared module counters hide R42, no filesystem codec or path
is exercised, and `stop()` merely forks interruption without awaiting scope
closure before the next `start`. Polling for a summary also proves the event
projection, not a clean store flush/shutdown boundary.

Use a child-process test over a temporary filesystem store: process A commits,
awaits graceful close, process B opens and commits again, and process C verifies
the exact graph/history. Add abrupt termination, corrupt/torn files, two
concurrent processes, read-only directory, restart-after-rewind/switch, and
prove the app's store scope remains live only for the harness lifetime. Keep a
small in-process repaint unit test separately.

### R138 — P2 — The on-disk conversation format has no version, migration, or retention boundary

**State:** exposed by `fccecb5` over the `a7c4b9e` key-value representation.

The filesystem directory contains unversioned `Entry` and index values keyed
directly by the current schemas. Any future `Node`, `Prompt`, Option, or part
codec change can make startup fail with a generic store decode error, with no
way to distinguish an older supported format from corruption. Each turn also
writes the entire growing prompt snapshot into a new node and nothing prunes
old branches, so automatic live-mode persistence has quadratic write/disk
growth with no quota or compaction signal.

Persist a small manifest with format version, tree identity, schema/migration
policy, and application provenance before calling the feature durable. Define
retention/compaction and expose size/failure state to the UI. Test at least one
old-version migration, a future-version refusal, corrupt indexes versus corrupt
entries, quota exhaustion, and a long transcript with an explicit storage-work
bound.

### R139 — P1 — The live backend extracts its KeyValueStore after its provider Layer has closed

**State:** committed in `fccecb5`; the current filesystem implementation masks
the generic lifetime defect.

`Backend.live.store` obtains the service with
`KeyValueStore.KeyValueStore.use(Effect.succeed).pipe(Effect.provide(layer))`
and returns a `NodeStore` closing over it. `Effect.provide(effect, layer)` owns
the supplied Layer only for that inner effect; it does not transfer the Layer
into the caller's ambient scope. A direct probe with an `acquireRelease`
service records its provider finalizer before execution reaches the line after
`yield* Effect.provide(...)`. Thus the comment claiming the store “lives
exactly as long as the tree” describes the opposite of the actual lifetime.
The file/memory stores currently have no meaningful close action, so smoke
passes; a database, pooled, locked, or future scoped filesystem provider is
returned already released.

Expose the store as a `Layer`/scoped acquisition and build it in the harness's
captured scope (`Layer.build`/context extraction under that scope), or keep all
NodeStore use inside the provided effect. Add an instrumented provider with a
finalizer and assert it remains open through writes and closes exactly once
after tree shutdown. The memory test in R137 cannot establish this because its
provider has no observable release.

### R100 — P1 — TUI exports record false provenance

**State:** committed in `f7dd652`.

The new `/export` passes `harnessVersion: "tui"`, although `Provenance` defines
that field as the library version. It derives `tools` from the rendering-view
registry, not from the agent's toolkit, so adding a custom view claims a tool
was available and omitting a view hides a tool that actually was. It also omits
the known live/scripted model entirely. The resulting artifact is described as
self-identifying while its most important identity fields are wrong or absent.

Expose structured provenance from `Backend`, use the package/library version,
and derive tool names from `CodingToolkit.tools` or the actual resolved agent
toolkit. Add an end-to-end TUI export parse test that asserts exact version,
provider/model, tools, lineage, and omission/opt-in of the workspace path.

### R101 — P1 — Branch switching reintroduces casts and can lose the active branch marker

**State:** committed in `f7dd652`.

`BranchItem.id` is flattened to `string`, so `switchTo` converts it back with
`id as never` before calling `tree.node`. This is prohibited caller-side type
erasure and means arbitrary strings enter a branded identity API without
validation. Preserve `NodeId` in the view model (it is still renderable as a
string) or decode at the boundary with a typed invalid-id result.

The selector lists only leaves. Immediately after rewind, the active cursor is
an internal node with existing descendants, so none of the listed leaves is
marked active even though the contract says one item identifies the current
line of work. Include the active node as a selectable row or define the active
lane separately. Tests need rewind-then-open, switch-during-run, stale id,
foreign id, one-node tree, named lanes, and concurrent branch creation.

### R102 — P2 — Palette commands make typed failures disappear silently

**State:** committed in `f7dd652`.

To make the common dispatcher `Effect<void>`, `/branches` and `/rewind` wrap
their `NodeMissing` failures in `Effect.ignore`; `switchTo` also ignores the
whole activation effect. Export uses `catchCause`, which turns expected errors,
defects, and interruption alike into a generic notice. A stale/corrupt tree can
therefore make a known command do nothing, while a programming defect is
misreported as an ordinary export failure. This is exactly the distinction the
typed channels and `Cause` are meant to preserve.

Map expected command errors to explicit notices by tag, let defects terminate
the owning UI fiber, and preserve interruption. Give the dispatcher the honest
union until that mapping boundary. Tests should fault every tree/sandbox/export
operation and assert either an exact notice or a surfaced defect—never silence.

### R103 — P2 — Down-arrow cannot return prompt history to an empty input

**State:** committed in `f7dd652`.

The history cursor uses `-1` to mean the empty prompt, but the non-empty branch
clamps `cursor + 1` with `Math.min(typed.length - 1, ...)`. Once Up selects the
latest entry, Down can advance only as far as that same latest index; it can
never reach `-1`. This contradicts the comment and normal shell behavior.

Represent the empty position as `typed.length` (or handle the last-to-empty
transition explicitly). Add exact key-sequence tests for empty history,
Up/Up/Down/Down, boundaries, a draft restored after browsing, duplicate
commands, and rejected submissions. Also bound the in-memory history so a
long-lived TUI does not grow forever.

### R104 — P1 — Palette branch/rewind commands remain active during a running submission

**State:** introduced in `f7dd652`; `/branch` and `switchTo` received the
partial/racy guard in `759c5cf`, while `/rewind` and direct rewind remain open
(R148).

The prompt input and global `/` handler remain active when `status ===
"working"`; only the footer text changes. The palette then exposes `/rewind`
and `/branches`, and neither `Handle.command` nor `switchTo` checks status.
They could activate another branch or close the current one while its
submission was in flight, reproducing R15's abandoned projection/session state
through a second UI path. The remaining rewind path can still do so directly;
the new branch/switch guard still loses an admission race.

Disable branch-changing commands unless the session is idle, both in the view
and at the imperative handle boundary. A renderer check alone is insufficient
because tests/other callers can invoke the handle directly. Add deterministic
running-turn tests for keyboard and direct calls, and either reject with a
notice or define a complete interrupt-and-switch transaction.

### R105 — P1 — The new command smoke checks race on conditions that are already true

**State:** committed in `f7dd652`; the expanded smoke in `7c07f9f` still uses
late/shared snapshots and global renderer focus (R152).

After `handle.command("help")`, `handle.command("nonsense")`, and
`handle.command("export")`, the test waits for `entries.length === 0`. That is
the state before each detached command fiber starts, so `until` may return
immediately without observing the command or its scrollback commit. Whether the
test passes depends on whether `Effect.runFork` happens to reach the synchronous
append before the JavaScript continuation checks the predicate. This repeats
R40's polling problem and does not establish the new command guarantees.

The moving keybinding smoke made this failure visible again. It snapshots one
late `footerAtEnd` value and uses it to claim both that approval returned to a
prompt and that an earlier branch switch did so. In a review run both checks
failed together even though the transcript showed the switch completed: one
of the detached command fibers was still free to change the footer after the
supposed waits. A final-state snapshot cannot prove either earlier transition,
and reusing it makes two regression labels report one unrelated race.

Synchronize on a monotonic command/notice completion count or a Deferred owned
by the harness test seam, then assert the actual exported file/content rather
than only its notice. Drive `/`, Escape, arrow keys and Enter through the real
component at least once; delegating `<select>` internals to OpenTUI does not test
this app's global-keyboard/focus wiring. Finally, remove the inline
`footer() as { ... }` assertion: smoke/test code is caller code and the
discriminated union already narrows without it.

### R128 — P1 — Reused tool-call IDs patch the wrong TUI entry

**State:** present in the committed TUI; the collision becomes easier to reach
through branch switching in `f7dd652`/`30e3215`.

`project` discards the `AgentEventEnvelope` and receives only `event`, then
uses `tool-${event.id}` as both the row id and the later patch target. Provider
tool-call IDs are correlation within a response/turn, not a documented
session-global identity. If a later turn or branch reuses an id while the older
settled row is still held behind an earlier streaming entry, `Sink.patch` uses
`findIndex` and updates the old row. The new row remains `running` forever and,
because scrollback drains only a settled prefix, blocks the rest of the
transcript. The `params` map has the same collision and can pair one call's
result with another call's arguments.

Pass the whole envelope to the projection and key UI state by
session/submission/run/turn plus call id, or allocate a view id at start and
retain a correlation-to-view-id map that handles repeated provider ids. Add an
exact event-sequence test with the same call id in consecutive turns and on two
branches, deliberately hold the first row behind a streaming entry, and assert
both bodies/statuses and complete prefix drainage.

### R129 — P2 — Scrollback removal happens before rendering succeeds

**State:** committed in `a817a76`; made more exposed by the growing structured
renderers.

The queued microtask first calls `drainSettled`, which splices the whole settled
prefix out of Solid state, and only then renders each returned entry with
`writeSolidToScrollback`. If renderer disposal, a malformed extension view, or
an OpenTUI failure throws on the first or a middle entry, every item in the
batch has already disappeared from live state and the unwritten suffix is lost.
The exception occurs in an unowned microtask, so it also bypasses the harness's
Effect failure handling. Retrying blindly is unsafe because some earlier rows
may already have been irreversibly written.

Make the handoff one entry at a time with an explicit acknowledgement/error
boundary, retaining the current item until the terminal accepts it; isolate a
bad extension view to a fallback row before committing. Tie scheduled work to
component cleanup as in R74. Add a renderer seam that fails before the first
write and after one successful write, asserting no entry vanishes or duplicates
and no unhandled microtask rejection/exception escapes.

### R106 — P2 — Submitting does not clear the real input, and no test types into it

**State:** present in the committed TUI and made more disruptive by `f7dd652`.

OpenTUI's `InputRenderable.submit()` emits the current value but does not clear
it; the Solid `onSubmit` adapter only forwards that event. `App` records the
trimmed text and calls `handle.submit`, but never assigns `input.value = ""`.
After Enter, the sent prompt remains in the box, so typing appends to it, `/`
is no longer at an empty prompt, and the new Up/Down history starts from stale
visible text. The smoke suite calls `handle.submit` directly and therefore
cannot detect any of the actual input behavior it now claims.

Clear the input after recording/submitting (and decide whether a busy rejection
restores it). Drive characters plus Enter through the renderer and assert the
field is empty, slash opens only when empty, mid-line slash remains text, and
history navigation restores the intended draft.

### R107 — P1 — The TUI computes an unbounded quadratic diff before clipping it

**State:** committed in `4023757`.

`apps/tui/src/diff.ts:33-50` allocates and fills a full
`(beforeLines + 1) * (afterLines + 1)` LCS matrix. The justification at lines
27-31 says the input cannot be large because it is the span touched by
`edit_file`, but neither the tool schema nor the file size bounds that span: a
model can replace an entire large file, and `matched` returns that entire text.
The twelve-line display limit is applied only after the matrix has been built.

`Snapshot` then calls `diffOf` independently for the `<For>` list, the `<Show>`
condition, and the hidden-line label (`App.tsx:149-158`). On a reactive render
that can repeat the same quadratic work three times. A large but otherwise
valid edit can therefore freeze the UI or exhaust its heap after the filesystem
change already succeeded.

Put an explicit work/memory budget ahead of the algorithm and fall back to a
bounded head/tail or “diff too large” presentation. Compute the chosen result
once per snapshot (a memo or a child component with one derived value), and use
a linear-space/bounded diff if detailed output is still desired. Add a test
whose line-product exceeds the budget and assert bounded work and a useful
fallback; clipping only the output is not that test.

### R108 — P2 — The diff representation invents an empty line and loses EOF-newline changes

**State:** committed in `4023757`.

`toLines("")` returns `[""]`, so a pure insertion into an empty file is
rendered as a removal of a blank line followed by the addition. The generated
unified header likewise claims the empty side has one line. Conversely,
`toLines` deliberately removes the final split entry, so `Diff.of("a", "a\n")`
is all context and hides the only change; removing a final newline is hidden in
the same way. The tests cover text ending in a newline, but not an empty side
or a change consisting only of the EOF newline.

Represent empty text as zero lines and retain final-newline state separately,
rendering the conventional no-newline marker (or another explicit indicator).
Test empty-to-text, text-to-empty, empty-to-empty, add/remove final newline,
CRLF input, and the exact hunk counts for every zero-line case.

### R112 — P2 — Opening the branch selector is quadratic and decodes persisted histories

**State:** committed across `a7c4b9e` and `30e3215`.

The TUI finds leaves by loading `tree.nodes` and then calling `tree.children`
once for every node (`apps/tui/src/harness.ts:450-456`). The in-memory
`NodeStore.children` rebuilds the complete ordered listing and filters it on
every call, so a linear conversation of `n` nodes performs `n` full scans just
to discover its single leaf. This work runs synchronously enough to stall the
interactive command that opened the selector.

The persistent path also violates the rationale for `Summary`: key-value
`nodesOf` reads each `Entry`, whose schema contains both `node` and the complete
history snapshot, merely to return `entry.node`. Thus listing candidates
decodes every persisted conversation before `summary` separately reads leaf
histories again. Whole-snapshot storage makes the I/O and decoding cost grow
much faster than the bounded metadata the API claims a selector consumes.

Expose a store/tree `leaves` operation backed by a maintained child-count/leaf
index, or compute leaves from one `nodes` pass using a parent-id set. Persist
node metadata separately from history (or add a metadata-only index) so node
queries do not decode prompts. Add operation-count tests for a long chain and a
wide fan-out, plus an instrumented key-value store proving `/branches` reads no
non-leaf history payloads.

### R96 — P1 — The live TUI describes a workspace boundary that does not constrain `bash`

**State:** committed in `1ff95a3`; worsened by `fccecb5`.

The new backend calls `LocalSandbox.layer({ workspaceRoot })` and describes the
argument as “the directory the agent may read and write” and “the whole of what
it can reach.” That is true for the sandbox file methods after their path and
symlink checks. It is false for `exec`: the local provider merely sets the
child's `cwd`; the process retains the TUI's full host privileges and can read
or modify absolute paths, traverse out of the workspace, access credentials,
and use the network. An approved `bash` call is therefore host execution, not
workspace-confined execution.

Change the live-mode warning, help, and footer to say exactly that before this
becomes a user-facing flag. If workspace confinement is intended, select a
real isolated sandbox/container provider and test absolute-file and network
egress. If LocalSandbox remains, require explicit shell approval and consider a
separate no-shell live backend; a disposable working copy does not protect the
rest of the machine.

### R97 — P2 — The TUI backend seam erases its Layer error channel to `unknown`

**State:** committed in `1ff95a3`.

`Backend.layer` is declared as
`Layer<LanguageModel | Sandbox.Current, unknown, Scope>`, despite its comment
claiming the seam is tightly typed. A missing Anthropic key, provider-layer
failure, or future sandbox acquisition error is therefore erased before it
reaches `start`, contrary to the repository's typed-error contract. The Promise
bridge later renders a generic pretty cause, but that is an application-boundary
choice and does not justify losing the error type at the reusable backend seam.

Make `Backend` generic in `E` (or name the finite backend setup error union) and
let `start` map that union to its Promise rejection deliberately. Add exact type
assertions for scripted and live backends and break one once to prove the
assertion sees a widened channel.

### R98 — P2 — The live TUI dependency lock and CLI validation are incomplete

**State:** committed in `1ff95a3`.

`apps/tui/package.json` adds direct `effect`, `@effect/ai-anthropic`, and now
`@effect/platform-node` dependencies, but `apps/tui/bun.lock` contains none of
them. The current typecheck passes by resolving packages from the repository
root; a standalone or frozen app install is not what was tested. In addition,
`--model` uses
`argv[modelAt + 1]!`: `--model` at end of argv or followed by another flag
passes runtime `undefined` into the model layer and footer instead of producing
the clear startup error used for `--workspace`.

Regenerate and verify the lock with a clean/frozen app install, then put that
gate in the root check (R90). Parse both flags through one total decoder and
test missing, repeated, reordered, flag-looking, empty, relative, and
nonexistent values without non-null assertions.

### R99 — P3 — The backend label bypasses the footer's width policy

**State:** committed in `1ff95a3`.

The commit says the backend is the last footer element dropped as the terminal
narrows, but the component renders it for every width whenever it is non-empty.
Unlike hints/counts/rewind, it does not consult `widthPolicy`, truncate, or
wrap deliberately. A live label contains the full model plus workspace path,
so it can exceed even a wide terminal by itself. The smoke test renders only a
100-column `scripted` label and tests the width-policy booleans separately; it
never renders a narrow/long-label frame.

Give the label an explicit compact representation and maximum cell width, then
render at each breakpoint with long Unicode and Windows/POSIX paths. Assert the
footer stays within terminal width. Refresh the README at the same time: its
“two files,” “three handle methods,” and “harness builds the model/sandbox”
descriptions already contradict the backend/tree/rewind implementation.

### R91 — P2 — The new storage-fault tests violate the repository's caller no-cast rule

**State:** committed in `c218ee9`.

`test/DurableStorageFaults.test.ts` constructs branded session ids with
`"s" as never` twice and casts a computed decorator to the whole
`DurableSessionStore` interface. AGENTS.md explicitly says test code is user
code and must contain no casts; these are precisely the sort of missing helper
or awkward public signature the library is supposed to absorb.

Construct ids through their public schema/constructor and provide a typed
fault-injection adapter or per-operation test double that satisfies the
interface without assertion. Expand `Casts.test.ts` so it enforces the stated
test/example rule, not only the smaller `src/` erasing-cast inventory (R73).

### R92 — P1 — The new fault tests do not inject a partial storage failure

**State:** committed in `c218ee9`.

The `failingSessionStore` decorator replaces the selected operation with an
effect that fails *before invoking the real store*. Likewise, the broken
delivery-log append returns a fabricated failure without touching its inner
log. The assertions that no claim/event was left behind are therefore
tautological: the mutation code under test never ran. This does not support the
test's stated “partway” failure claim or the STATUS-level durability invariant.

Inject faults at actual persistence boundaries: after the first statement of
each multi-statement SQL transition, after an in-memory state commit but before
publication, and during transaction commit. Assert the externally visible
state after recovery/retry. These tests should cover the concrete race and
atomicity gaps in R43, R66, and R67 rather than a wrapper that bypasses them.

### R93 — P1 — The durability plan declares H2/D7 closed although D7's mechanism was never broken

**State:** committed in `c218ee9`.

The H2 table explicitly says D7 had “no mechanism to break” and “was not
tested.” The following prose then declares `DurableStorageFaults.test.ts`
closes it, but R92 shows those tests replace operations before the real
mutation path. No production D7 mechanism was disabled, and no test was shown
to fail when the store partially commits or the recorder loses publication.
Nevertheless the commit message says H2 landed and the durability matrix marks
D7 `/durable` as a checked test.

Keep H2 open for D7 until a real invariant-enforcing transaction/publication
mechanism is deliberately broken and the new fault suite fails. The matrix
should distinguish “a pre-operation error is typed” from “a partial write
cannot be reported accepted,” because only the latter is D7. D8 should also
appear in the break table or be explicitly classified as a documentation-only
invariant whose check is a documentation/contract test.

### R173 — P1 — Durable terminalization can wedge the session or permanently lose its terminal event

**State:** committed durable behavior; this is a concrete partial-failure path
missing from R92's fault injection.

`finishProjection` physically clears the admission and interrupt channels and
then calls `sessionStore.finish`; those operations can live in different stores
and are grouped only inside one workflow `Activity`, not one storage
transaction. If either `takeAll` commits and `finish` then fails or the process
dies, the claim remains `running` while admission is closed. Reconciliation
does not inspect a completed workflow to finish that claim, so later prompts
can remain permanently `Busy`.

On the other side, the success path commits `finishProjection` and then calls
`flushTerminal`. `flushTerminal` performs `Ref.getAndSet(held, None)` *before*
the delivery append. If append fails, the session is already idle and the only
copy of its terminal envelope has been removed. The surrounding
`catchCause` calls `finishProjection` and `flushTerminal` again, but the first
is now stale/idempotent and the second sees `None`; the reconnect log can never
acquire the missing terminal event.

Persist one terminalization intent/state machine and make each physical step
reconcilable, or put projection and event/outbox commit in one transactional
store. Do not consume the held event until append succeeds. Add fail-after-
mutation and process-loss latches after each channel clear, after session
finish, after held-event removal, and after delivery append; then reacquire in
a fresh runtime and assert the session becomes idle, admission matches its
claim, history is committed once, and the exact terminal event is readable
once. These tests should be the D7 mechanism-break proof R92/R93 currently
lack.

### R94 — P1 — Brave search has the same quadratic chunk fold as the in-progress fetch provider

**State:** committed in `b575f6e`.

`BraveWebSearch.readBody` appends each stream chunk with
`chunks: [...current.chunks, chunk]`. The one-MiB byte cap does not cap chunk
count, so a one-byte-chunk response performs quadratic array copying and
allocation. The current overflow test builds a Web `Response`, which normally
delivers a small number of large chunks and cannot expose this behavior.

Use the same O(1)-append solution recommended in W2 for both providers, ideally
as one bounded-body helper rather than two copies. Run both provider suites
against a custom stream delivering one-byte chunks up to the limit and assert
an operation/time bound without a wall-clock sleep.

### R95 — P1 — HTTP response bodies are abandoned on every early response path

**State:** committed in Brave search and the baseline fetch provider; confirmed
against Effect's `HttpClient.make` response lifecycle.

Brave returns/retries immediately for 401/403/429/other non-2xx responses.
Fetch does the same for redirects, non-2xx responses, unsupported media types,
and advertised oversize. None consumes or cancels `response.stream`. Effect's
ordinary `HttpClient.make` response wrapper aborts when a consumed stream is
finalized or when the response is eventually garbage-collected; simply dropping
the response is not a deterministic release boundary. Redirect/retry chains can
therefore retain response bodies and connections, and repeated hostile replies
can turn the bounded content API into resource pressure outside its byte cap.

Drain a small bounded error body only when useful; otherwise explicitly cancel
the response stream/controller through a scoped provider helper. Add tests that
capture the request abort signal and prove it is settled on redirect, retry,
authentication, unsupported type, declared overflow, and every terminal status
without relying on garbage collection.

### R79 — P1 — Deep redaction both leaks data keys and can corrupt export structure

**State:** committed in `a2e27a9`; reproduced.

Reproduced against the current in-progress implementation:

- `Redaction.deep({ [secret]: "value" }, literal(secret))` leaves the secret
  verbatim because object keys are never visited. Dynamic tool parameters and
  results can contain user-controlled record keys, so IE3 (“no occurrence
  anywhere”) is false.
- Redacting a structural string value corrupts the schema. For example,
  encoding an ordinary export with `literal("user")` rewrites the Prompt role;
  `Export.parse` then fails as malformed. The current “does not corrupt” test
  uses a secret that happens not to equal a discriminator.

Apply redaction with schema awareness so fixed structural keys/discriminators
remain intact while dynamic keys and content are covered, then decode the
redacted encoded value before returning success. Tests need secrets equal to
every structural literal (`user`, `text`, Option tags, event/part tags), secrets
in record keys, replacement text containing structural literals, and a final
whole-artifact scan.

### R80 — P2 — `Redaction.deep` is not a safe identity on its public `unknown` input

**State:** committed in `a2e27a9`; reproduced with `Date` and the no-op rule.

`asHook` advertises an `(unknown) => unknown` observability hook, but `deep`
treats every non-null object as a plain enumerable record. Even with
`Redaction.none`, a `Date` becomes `{}`, a URL loses its representation, typed
arrays change shape, prototypes/getters disappear, and cyclic objects recurse
forever. Decoded tool results are allowed to be transformed class values, so
this is not limited to hostile callers.

Restrict recursive traversal to JSON records/arrays and define handling for
other supported telemetry attribute values; detect cycles with a `WeakSet`.
Add Date, URL, Uint8Array, Schema class, null-prototype, symbol-keyed, getter,
and cyclic values, proving that the no-op policy is actually observationally
no-op.

### R81 — P2 — Sticky regular expressions violate `Redaction.pattern`'s replace-all promise

**State:** committed in `a2e27a9`; reproduced.

`pattern` preserves every input flag and merely adds `g`. A sticky expression
such as `/token=\w+/y` becomes `gy` and replaces nothing unless a match starts
at offset zero; later occurrences remain even though the API explicitly
promises every occurrence. This was reproduced with `"x token=a token=b"`.

Reject/remove the sticky flag (and document Unicode/indices semantics), or
implement explicit global iteration. Test every stateful flag combination and
zero-length matches.

### R82 — P2 — Export determinism relies on two clock reads landing in one millisecond

**State:** committed in `d4ed1c8`; reproduced by advancing the live clock 5ms.

`Export.of` always writes the current time to `exportedAt`. The determinism test
calls it twice consecutively under the live clock and happened to receive the
same millisecond; inserting a 5ms delay produces different JSON for the same
snapshot. The test is nondeterministic and the plan's byte-identical fixture
invariant does not hold in real use.

Decide whether export time is part of identity. If byte-identical fixtures are
the invariant, accept it from the caller/recorded snapshot or exclude it from
the deterministic artifact; if timestamps should differ, weaken the invariant
and compare normalized content. In either case use `TestClock` and deliberately
advance it to prove the chosen behavior.

### R83 — P1 — Replay cannot reconstruct several histories it claims to reproduce

**State:** committed in `d4ed1c8`.

The current replay extraction silently loses control and content information:

- `promptsOf` returns only concatenated text, dropping images, files, audio,
  and ordering among heterogeneous user parts; a non-text-only prompt vanishes.
- Steering and follow-up messages committed inside a submission are replayed
  as new top-level `session.prompt` submissions, changing run boundaries,
  permission timing, and loop decisions.
- `seedOf` says it removes the assistant side but actually filters system/user
  messages and then keeps only the first message. If that first message is a
  user prompt, combining it with `promptsOf` duplicates the input.
- Empty assistant responses are dropped, shifting every later scripted turn;
  mixed text/tool-part ordering is flattened into one text plus a call list.

Narrow the public claim to model-output extraction, as the plan's original
`turnsOf` milestone did, or export the event/control log needed for faithful
reproduction. Use full `Prompt.RawInput`/message values rather than strings and
define seed/prompt partitioning. Add multimodal, steering, follow-up,
provider-executed tool, empty turn, mixed-part, initial-history, and multi-run
fixtures that compare the model-facing prompts and lifecycle events exactly.

### R84 — P1 — TreeExport trusts caller-supplied node metadata after looking up only its id

**State:** committed in `a2e27a9`.

`TreeExport.path` obtains canonical history through `tree.historyOf(node)`, but
builds snapshot identity and lineage from the caller's `node.id` and
`node.parent`. A forged Node carrying an existing id and a fake parent therefore
exports real history with false lineage. This is the tree-export form of R23's
canonical/caller-node mix; the foreign-tree test covers only an absent id.

Resolve the canonical node once via `tree.node(node.id)`/a held-node operation
and use only that value for metadata. Add a same-id forged-parent/label/cause
test. Also distinguish `Provenance.parent.sessionId` from `nodeId`: the current
code writes the parent NodeId into both fields even though it is not a session
id.

### R85 — P2 — TreeExport breadth-first queues are quadratic and do not detect repeated children

**State:** committed in `a2e27a9`.

Both `subtree` and `leaves` repeatedly call `Array.shift`, making a wide export
quadratic. They also have no visited set, so a corrupt/custom store returning a
self-child or repeated child loops forever or exports duplicates (R78 covers
the committed parent traversal).

Use an index cursor/deque and a visited NodeId set, surfacing typed corruption
on repetition. Test a wide tree operation bound, a deep tree, repeated child,
and a child cycle.

### R86 — P2 — TreeExport weakens the public tool generic to `any`

**State:** committed in `a2e27a9`.

All three exported functions use `Tools extends Record<string, any>` instead of
the tree's `Record<string, Tool.Any>` constraint. It does not currently force a
caller cast, but it introduces an erased public generic at a new package
boundary and makes type regressions in `SessionTree` composition invisible.

Reuse the exact `SessionTree` constraint (or derive it from the interface) and
add cast-free compile assertions for tool names, tree store failures, and the
returned error channel.

### R181 — P1 — Duplicate tool-call ids within one model response alias live and durable invocations

**State:** introduced/exposed by today's durable activity identity and TUI
correlation work; no response-boundary validation exists.

`internal/toolActivity.ts` states the crucial premise that provider call ids are
unique within one response, and `DurableToolkit`/`DurablePermission` use
`(tool name, call id, occurrence)` as replay identity. The harness never checks
that premise: `AgentTurn` filters `response.toolCalls` and passes the array
straight to `ToolExecution.execute`. If one response contains two concurrent
calls with the same name and id, both fibers can read occurrence zero before
either updates its wrapper-local `Ref`, so they request the same workflow
activity name. Depending on workflow semantics this can replay one sibling's
result into the other, suppress one side effect, or conflict nondeterministically.

The same malformed response is already ambiguous outside durability. Both
calls emit indistinguishable lifecycle events and commit two tool results with
the same id. The TUI's `rows: Map<providerId, viewId>` overwrites the first row
on the second `ToolCallStarted`; the first terminal event patches/deletes the
second row and the other running row can remain permanently unsettled. The
sequential reused-id fix in `4000d10` does not cover simultaneous duplicates.
Effect AI's response schemas validate each part but do not impose cross-part
uniqueness.

Validate tool-call identity for each model response before emitting any tool
lifecycle event. A duplicate should become a typed model/protocol failure, not
a handler defect or partial execution. If duplicate ids are intentionally to
be supported, introduce a harness-owned invocation/occurrence id and carry it
through events, permission requests, durability, metrics, AG-UI and view
projection; the provider id alone is then only protocol data. Add deterministic
parallel tests for same-name/same-id and different-name/same-id calls, plus
streamed and generated responses, durable replay, permission/elicitation,
history encoding, metrics, AG-UI projection and the TUI. Also keep the existing
sequential cross-turn reuse test: that case remains valid and distinct.

### R182 — P1 — Scrollback draining does not react to entries becoming settled

**State:** present in the TUI scrollback design and left unresolved by
`b64c18f`'s per-entry commit fix.

`App`'s `createEffect` deliberately reads only `props.entries.length` before
queuing `commitSettled`. A streamed message or running tool is appended while
unsettled, so the append triggers one drain attempt which correctly stops at
that row. Its later `streaming = false` or `status = "ok"`/`"failed"` update is
a nested store mutation and does not change array length, so it does not rerun
the effect. I confirmed the Solid client runtime behavior directly: an effect
subscribed to a store array's `length` ran once and did not run again when a
row's `status` was patched. The settled row (and every row behind it) therefore
stays in the reactive tree until some future append/removal changes length; the
last submission can remain live indefinitely, defeating the stated
write-once/flat-tree invariant.

The new failure handling has the same trigger problem. When
`writeSolidToScrollback` throws, `commitSettled` correctly leaves the entry in
place, but the caught failure changes no reactive value and schedules no retry.
The smoke test invokes `commitSettled` a second time manually; the application
does not. A transient failure can therefore pin the prefix forever. Moreover,
the callback boundary cannot prove exactly-once behavior if a renderer mutates
scrollback and then throws; document whether that API is atomic instead of
claiming that every thrown write displayed nothing.

Drive the drain from a store-owned monotonically increasing revision that
changes on every append/patch affecting settlement (or expose a reactive
`settledPrefix`/notification), and give failed writes an explicit bounded retry
or visible failed state. Avoid a blind microtask retry loop against a disposed
renderer. Add a renderer-level test where a running row survives the first
microtask, is terminalised without another append, and must leave the live
tree; add the same test for `streaming`, multiple rows behind a blocker, one
transient write failure without a later append, permanent failure, and
component disposal.

### R183 — P1 — The diff budget is bypassed by large empty or highly asymmetric edits

**State:** introduced by the R107 fix in `476afe3`.

`Diff.of` gates the LCS only when `left.length * right.length > BUDGET`.
For an empty file replaced by a million-line file (or the reverse), that
product is zero, so the supposedly bounded path constructs/emits a million
`Line` objects before `App.diffOf` clips the result to twelve. A one-line side
also permits almost 250,000 output lines. The quadratic matrix is bounded in
those cases, but the output time and memory are not, so a valid whole-file
creation/deletion can still freeze or exhaust the TUI after the filesystem
operation has already succeeded.

Use two independent limits: one for alignment cells and one for input/output
line count (and preferably source bytes, since a single line may itself be
huge). Produce the summary before constructing the full `Line[]`, and make the
summary report the actual side counts without masquerading as a complete
patch. Add empty-to-huge, huge-to-empty, 1-to-huge, huge single-line and just-
under/over-each-threshold tests; assert an operation/allocation bound rather
than only the two-line summary returned by the symmetric 1200×1200 fixture.

## Accepted limitations / observations (not defects by themselves)

- `web_fetch` correctly remains independent of `Sandbox`; network permission
  and filesystem/process permission compose as separate calls.
- The fetch provider's hostname/IP checks cannot prevent DNS rebinding or prove
  the connected address without an address-aware runtime or outbound proxy.
  The implementation and status documentation state this honestly.
- The DNS/address limitation is distinct from R26: even a client that honors
  manual redirects does not expose the connected address needed to defeat
  rebinding.
- Search/fetch provider failures are mapped to model-facing strings only at the
  tool boundary; the infrastructure services retain typed errors. That split is
  sound.
- The durable encoded-parameter codec fix is directionally correct: the journal
  now describes model tool-call parameters in their encoded representation,
  while live handler execution retains decoded types.

## Verification snapshot

- `npm run build`: **failed**, R1.
- `npm run check`: **currently passed** against `7c07f9f` plus the latest
  web/durability worktree: root and TUI TypeScript, 289/289 root Effect files,
  portability, 112 Vitest files / 965 tests, and the TUI smoke all completed.
  R142 still means the green Effect stage checked no TUI files.
- `npm run typecheck`: **passed** against the latest moving worktree.
- `npm run lint`: **passed**; 289 Effect files produced 0 diagnostics.
- `npx effect-language-service diagnostics --project apps/tui/tsconfig.json`:
  **invalid gate**; it checked 0 of the app's 13 files (R142).
- `npm run lint:portability`: **passed**.
- `npm test -- --run`: **passed**; 112 files / 965 tests passed.
- Focused moving web/durability suites: **passed**; 3 files / 13 tests.
- `npm --prefix apps/tui run typecheck`: **passed**.
- `npm --prefix apps/tui run smoke`: **failed before loading the app** because
  the npm-selected Bun shim cannot remap its binary (R30/R98).
- `npm run smoke:tui`: **currently passed** after `759c5cf` and the latest
  moving keybinding test edits. Earlier review runs timed out and hung before
  the corresponding branch guard landed; another moving run completed with
  three failed footer/escape assertions before the test was revised. The
  wrapper still has no failure timeout or finally cleanup (R40/R105/R150).
- An earlier `npm run check` reached and passed root/TUI typecheck, root Effect
  diagnostics, portability, and all 965 tests, then failed/hung in the TUI
  smoke gate before `759c5cf` (R40/R150). The current pass does not test that
  failure cleanup path.
- `npm run verify:package`: **passed** after the failed build still emitted the
  current tree; all 37 packed entry points imported. This does not clear R1:
  the declaration build exited non-zero, and Slack remains classified as a
  host entry rather than tested portably (R35). R46 was the earlier stale-dist
  snapshot and is resolved by the current emitted tree.
- No implementation files were changed by this review.

## Resolution log — 2026-08-25

Written by the session that acted on this review, so the state of each finding
is recorded beside the finding rather than reconstructed from git log. Every
entry below was fixed *and* falsified: the fix was reverted once and the test
that covers it was confirmed to fail. Where a test could not be made to
discriminate, that is said here and in the test itself.

### Closed

**Build and gates.** R1 (the declaration build has been failing since the Slack
Web Crypto rewrite; `check` now runs `build`). R142 (the Effect diagnostics gate
reported "Checked 0 files out of 14" and exited zero; the plugin entry is
restored and a wrapper fails on incomplete coverage). Turning R142's gate on
found `NodeStore<any>` in the TUI harness seam, which had made every tree
operation's error channel `any`.

**Web.** R94, R95, R113 (one bounded-body helper: O(1) chunk append, and every
early exit releases its response). R114, R26 (`layerFetch` owns its transport;
the abstract layer's two unenforceable promises are written down rather than
implied). R116 (an approval shows the whole URL while remembering the origin).
R117, R120, R143 (one target-redaction policy — origin only — and the client's
own `url.full`/`url.query` span suppressed in favour of a provider-owned one).
R154 (a concurrency bound, one permit per logical fetch). R155, R159 (the
compositional limit of the retry guarantees, stated where the guarantee is
made). R158 (Brave refuses redirects rather than forwarding its API key).
R160 (`Retry-After` as delta-seconds *or* HTTP-date, against the clock).

**Permission.** R21 (stateful regex patterns decided by call order). R164
(grant keys collided across the action/resource boundary; length-prefixed, and
the tool name is part of the identity). R144 (a service-backed parameter codec,
proven at the public boundary without a cast).

**Tree and store.** R22 (commits serialised). R42 (node id prefixes from the
CSPRNG, not a process counter). R43 (atomic memory writes, one writer over a
key-value backing). R44 (capture absorbs the store's failure and nothing else).
R77 (a familiar id may change a mark, never ancestry). R78, R85 (cycle
detection in both directions; index cursors instead of `shift`). R167 (the
memory store snapshots what it is handed).

**Export and replay.** R79 (record keys covered where there is no schema to
break; a redaction that rewrites structure fails instead of shipping). R83
(whole prompts rather than concatenated text, empty turns kept, seed boundary
stated once). R84 (lineage from the tree, not from the caller's node).

**Coding tools.** R54 (search permission scoped to the subtree). R55
(`write_file` and `edit_file` share one lock). R56 (an edit refuses a file that
is not valid UTF-8 rather than rewriting every undecodable byte). R57
(ambiguity decided by distinct locations, and anchor ties yielded rather than
dropped). R58, glob half (compiled once; length and brace-nesting caps; a
refusal is reported).

**Plugins.** R47 (command forms; launch resolved against the plugin root). R48
(`PLUGIN_ROOT`/`PLUGIN_DATA` injected; stdio declined without them). R50
(configured headers reach the origin, proven by a recording server).

**Core session and events.** R3 (a started tool call owes a terminal event
from the moment it is announced, not from when the handler starts -- the gap
covered decoding, policy evaluation, and waiting for a person to answer).
R5 (`snapshot` looks at the state twice, comparing submission count). R20, R156
(an observer is an observability consumer: its defect is isolated and logged, a
re-entrant emit is refused rather than deadlocking, and `eventSink` keeps the
opposite contract on purpose). R165 (a tool failure is rendered totally and
boundedly, after `returnedToModel` has already been promised). R166 (the
failure-to-event projection guards every getter, enumeration and coercion it
performs).

**Execution plan.** R16 (`R` is no longer struck out by a plan applied only
around the model call). R17 (the plan's error and requirements reach the
agent's channels). R32 (the model requirement is recomputed from a constant, so
a replacement plan can restore it).

**TUI.** R148 (one permit across the idle check and the branch change; the
racing-case assertion is labelled as weaker than it looks). R149 (`stop()` is
awaitable and idempotent; the store's finalizer is deliberately slow so the
test can tell an awaited close from a forked one). R150 (the suite exits on any
throw and the wrapper bounds the child). R31, R74 (handle callbacks fork with
the program's services and are interrupted by its scope).

Also fixed: a flaky `DurableStreams` test that asserted a timing coincidence —
two concurrent appends of one event are both told `Appended` only when they
genuinely overlap, and `Duplicate` is correct when they do not.

**Durable, cluster and state.** R65 (a failed save no longer leaves the live
value ahead of the stored one; ephemeral state keeps its atomic
read-modify-write, which the first attempt at this broke). R67 (a delivery-log
append commits and publishes as one step). R76 (a state tag's id is claimed
once, so two tags cannot name one service at different types). R170 (the
cluster client reports a typed transport error after its bounded retry instead
of dying). R174 (remote errors are validated against a `Schema.Union`, and a
composite cause is judged by all of its failures rather than the first).

**Tree and turn atomicity.** R6, R111 (the activation commit -- lane names,
scope swap, publication, closing the predecessor -- is one uninterruptible
step, after the acquisition). R125 (`branch`'s bookkeeping and hand-over
likewise; `track` takes its observer before its name). R127 (a turn's history
commit and the events announcing it are one step, so a committed turn is always
one the tree saw). R130 (the tree's scope owns the last activation's scope and
shuts down the feed). R181 (a response naming one call id twice is refused
rather than aliased into one durable activity).

**TUI.** R101 (`BranchItem` carries a `NodeId`; the selector reads by position,
so the `as never` is gone, and the smoke narrows rather than asserts). R110
(leaves, plus named lanes, plus the cursor -- so a fork point survives its first
child and one row always says where you are). R131 (a checkout pointer, written
after a successful activation, so a rewind survives a restart). R134 (the
transcript lives outside the workspace, where the agent cannot list, search,
edit or commit it, and the path is disclosed). R182 (the drain is triggered by
the settled prefix rather than the entry count, with a bounded retry for a
failed write).

**Core control and identity.** R34 (a tree cursor's "unchanged" is the same
conversation, not the same length -- the old check handed one session another's
node, which the falsification demonstrated). R39 (a submission that will be
refused never enqueues a transcript line). R58's regex half (a conservative
refusal for the patterns that stop the event loop, explicitly not a decision
procedure). R105 (the command smoke waits for what a command produced rather
than for the state it began in). R171 (`steer`, `followUp` and `interrupt`
re-check their submission id under the input gate that the release contends
for).

**Execution plan, continued.** R19 (`Model` threaded through every combinator,
so applying a plan first or last gives the same agent). R28 (the plan's `input`
must accept the model call's `AiError`, stated as a conditional return type
because a parameter constraint destroys the inference). R37 (a durable agent
carrying a plan is refused, because the plan's layer shadows `DurableModel` and
a replay would repeat a billed call).

**Fault injection.** R92, R93 (faults injected where the mutation is, which
immediately showed that a store committing *before* it fails leaves a claim
behind -- so the D7 row now reads "partial" and the test asserts the real
behaviour with a note saying what closing it looks like).

### Open, with what is known

- **R2** needs an entry point in Effect AI's `Toolkit` that takes an
  already-decoded value; until then the codec runs twice per call. The count is
  pinned by a test and the constraint it implies — a parameter codec used with
  permission must be deterministic and side-effect-free — is documented where a
  tool author will read it.
- **R58, the regex half.** Bounding a model-supplied `RegExp` needs a
  linear-time engine or a killable worker. A limit does not help: a
  catastrophic pattern is short.
- **R83's run boundaries.** A history records messages, not which arrived as a
  fresh submission and which were steered into a run already going. Reproducing
  that needs the event log, not the transcript.
- **R19, R28, R37.** The rest of the execution-plan cluster. R19 is a wide
  signature change across every combinator and consumer; R28 needs the plan's
  `input` constrained to a supertype of the model call's error without
  destroying inference; R37 is a runtime composition defect where a plan's
  provider layer shadows `DurableModel`, so a durable agent with fallback can
  repeat a billed call on replay.
- **R20's forked re-entry.** The guard compares fibres, so an observer that
  *forks* a re-entrant call gets a new fibre id, blocks on the permit, and
  deadlocks exactly as before. That is the boundary of what a fibre comparison
  can see, and it is documented on `AgentSession.observe`.
- **R5's window.** The fix is structural; no test here drives the interleaving,
  and the test says so rather than implying coverage it does not have.
- **Windows that cannot be driven from outside.** R5, R67 and R127 are all
  fixed structurally, and in each case the test says plainly that it does not
  reproduce the interleaving and passes without the fix. The gaps are a handful
  of instructions with no suspension point, so an interrupt or a concurrent
  call issued from a test lands before or after rather than inside. Driving
  them would mean adding a seam to production code for a test to hold open.
- **R66.** A transaction gives atomicity, not serialisability, and these
  transitions are select-then-write. The suite runs against SQLite, which
  serialises writers at the file level and therefore cannot exhibit the race --
  so passing tests are not evidence for the portable claim. The requirement is
  now stated on `sqlStore` itself: run at `SERIALIZABLE`, or encode the
  precondition in the mutation. Both are engine-specific, which is why a
  portable module states it rather than guessing at a dialect.
- **R172.** The entity acknowledges a submission before anything durable
  exists. Awaiting the dispatch instead was tried and deadlocks: `execute`
  routes back through the same runner, so the handler would wait on work only
  the handler can process. Closing it needs a persisted claim drained by a
  reconciler -- a new mechanism, not a reordering. The window is now recorded
  in the code.
- **R173.** Half fixed: a terminal event is recorded before it is forgotten.
  The other half is an ordering with no safe choice -- clearing before
  `finish` can strand a claim, finishing before clearing can wipe the *next*
  submission's admission marker, and the second corrupts work happening now.
  The reversal was tried and reverted when the existing ordering test caught
  it. Closing it needs one transaction or reconciliation.
- **R36.** Durable permission replay journals the policy answer but recomputes
  the projection and `needsApproval`, which Effect AI allows to be effectful.
  The same class of problem as R2 and with the same shape of fix.
- Everything not listed above remains as this review recorded it.
