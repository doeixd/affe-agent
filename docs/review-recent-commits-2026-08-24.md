# Review of recent commits — 2026-08-24

## Scope

This is a living correctness review of all changes committed today, currently
`d56c703^..af07b9a`, plus the explicitly separated uncommitted work that was in
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

**State:** committed in `b575f6e`; confirmed against Brave's official API
reference.

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

**State:** committed in `a817a76`; exposed more clearly by the later rewind UI.

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

**State:** committed in `82890c7`; confirmed by keyboard and projection control
flow.

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

**State:** committed TUI behavior; core correctly removes the pending in-memory
elicitation but does not emit `ElicitationResolved` for interruption.

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

**State:** introduced with `a817a76`.

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

**State:** introduced by `ae94e4f` while replacing the renderer-based wait.

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

**State:** committed in `a7c4b9e`.

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

**State:** committed behavior; related to but distinct from R31's detached
operation fibers.

Every `start` overwrites module-global `disposeFiber`; `stop` can close only the
most recently started harness, so multiple instances leak earlier scopes.
`main.tsx` calls `stop()` only after `await render`; a thrown/rejected render
skips cleanup. If the root fiber fails after the start promise resolves, its
later `reject` is ignored and the UI retains a handle to a dead session.

Return an instance-scoped `{ handle, close }` acquisition (preferably a scoped
Effect/Layer), put rendering in `try/finally`, and surface post-start root
failure to the UI. Test two simultaneous harnesses, independent close order,
render rejection, and root failure after startup.

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

The repository continued committing work during this review. W2-W4 remain
uncommitted web-fetch findings. The export/redaction/tree findings first seen
in progress landed in `d4ed1c8` and `a2e27a9` and are now numbered R79-R86.

### W1 — Resolved during review — The in-progress `ExecutionPlan` tests initially failed typecheck

The first in-progress version failed in `test/ExecutionPlan.test.ts` with one
invalid service-method assertion and two invariant `ExecutionPlan` generic
mismatches. Commit `81611f8` made the tree typecheck, so this is no longer a
current build failure. R16-R19 record the remaining contract defects that a
green typecheck does not detect.

### W2 — P1 — The bounded HTTP body fold has quadratic chunk accumulation

`src/web/http.ts` retains chunks with `{ chunks: [...current.chunks, chunk] }`
for every streamed piece. The one-MiB byte limit does not bound the number of
chunks: a conforming/custom `HttpClient` can deliver one-byte chunks and force
quadratic array copying and extreme allocation before the byte cap is reached.
Effect interruption cannot help while each synchronous copy runs.

Use a mutable builder scoped inside the fold, a chunk queue with O(1) append,
or preallocate only when a trustworthy declared length exists. Add a 1-byte-
chunk response at the full limit and assert a linear operation/allocation
bound, plus interruption during a high-chunk-count stream.

### W3 — P1 — The guarded fetch layer can inherit and leak ambient HttpClient credentials

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

### W4 — P2 — The provider-neutral FetchResult schema does not encode its contract

`FetchResult` accepts any number for status and arbitrary strings for final URL
and media type. A custom provider can return a negative/fractional status, a
credential-bearing or non-HTTP final URL, or an invalid media type; the web
tool then labels and journals it as a successful guarded fetch. The built-in
provider is stricter, but the service schema is the contract all providers
claim to implement.

Use constrained integer/status schemas and canonical URL/media-type codecs, or
validate provider output at the tool boundary. Add malformed canned/custom
provider results and prove they fail with a typed provider-contract error.

### W5 — P1 — Interactive fetch approval hides the path and query that will leave the machine

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

### W6 — P1 — A malformed redirect can put embedded credentials into typed errors and logs

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

### W7 — P2 — Unsupported schemes and embedded credentials reach Permission before target validation

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

### W8 — P2 — W2 is marked complete without several acceptance tests named by PLAN.md

The focused tests cover direct `Ask` projection, and full-agent `Allow` and
`Deny`, but never drive an `Ask` through elicitation to prove provider
invocation exactly once. There is also no fetch-then-`write_file` composition
test, no exact lifecycle-event assertion for fetch, and no explicit TUI generic
fallback test. These are all listed in W2 acceptance, while `STATUS.md` already
states W2 is implemented and verified.

Add the missing behavioral tests before treating the milestone as closed. In
particular, the Ask test should cover approve, reject, remember, and interruption
while waiting; the latter also exercises the still-open R3/R25 lifecycle bugs.

### W9 — P2 — The new storage-fault tests violate the repository's caller no-cast rule

`test/DurableStorageFaults.test.ts` constructs branded session ids with
`"s" as never` twice and casts a computed decorator to the whole
`DurableSessionStore` interface. AGENTS.md explicitly says test code is user
code and must contain no casts; these are precisely the sort of missing helper
or awkward public signature the library is supposed to absorb.

Construct ids through their public schema/constructor and provide a typed
fault-injection adapter or per-operation test double that satisfies the
interface without assertion. Expand `Casts.test.ts` so it enforces the stated
test/example rule, not only the smaller `src/` erasing-cast inventory (R73).

### W10 — P1 — The new fault tests do not inject a partial storage failure

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
- `npm run typecheck`: **passed** against the latest moving worktree.
- `npm run lint`: **passed**; 289 Effect files produced 0 diagnostics.
- `npm run lint:portability`: **passed**.
- `npm test -- --run`: **passed**; 112 files / 965 tests passed.
- `npm --prefix apps/tui run typecheck`: **passed**.
- `npm --prefix apps/tui run smoke`: **not run**; Bun failed before loading the
  app because its local binary remap/node_modules installation is corrupt (R30).
- `npm run verify:package`: **passed** after the failed build still emitted the
  current tree; all 37 packed entry points imported. This does not clear R1:
  the declaration build exited non-zero, and Slack remains classified as a
  host entry rather than tested portably (R35). R46 was the earlier stale-dist
  snapshot and is resolved by the current emitted tree.
- No implementation files were changed by this review.
