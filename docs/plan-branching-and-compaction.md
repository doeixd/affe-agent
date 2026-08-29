Yes. **We already have most of the right primitives**, and in a few places our architecture is actually cleaner than Pi’s for this problem.

Pi’s core idea is that compaction changes what the model sees while preserving the underlying history, and branch summarization carries information from an abandoned branch into a new one. Pi also adds token-budget triggering, retained-tail selection, split-turn handling, cumulative file metadata, manual compaction, usage accounting, and extension hooks. 

Our existing `ContextTransform` is almost exactly the primitive you would want for normal compaction: canonical history stays immutable while the per-turn model prompt is derived from it. The existing `/compaction` package already implements this non-destructively with incremental checkpoints and retained raw history.  And `SessionTree` already exposes `commonAncestor`, `divergence`, `historyOf`, persistent nodes, branching, and activation—the hard structural operations Pi needs for branch summarization.

So I would **improve the current compaction battery rather than redesign the kernel**.

# Compaction + branch context plan

## Architectural position

Keep this invariant:

```text
CANONICAL SESSION HISTORY
        │
        │ immutable / complete
        │
        ▼
ContextTransform
        │
        ├ memory/RAG
        ├ dynamic instructions
        ├ branch carryover
        └ compaction
        │
        ▼
MODEL-FACING PROMPT
```

Normal compaction remains a **projection**.

It must never destructively rewrite:

```text
AgentSession.history
```

That is already the design of our package, and it's better than making summary entries replace old messages. `ContextTransform` explicitly gives every transform both the canonical prompt and the derived prompt-so-far while forbidding mutation of canonical state.

Pi rebuilds the model context from a summary plus messages after a stored boundary; repeated compactions extend the prior summary rather than discarding context.  Our current checkpoint design already has essentially this semantic:

```text
checkpoint summary
covers canonical messages 0..N

next compaction:
previous summary
+
canonical N..M
        ↓
new summary covering 0..M
```

So preserve that.

---

# 1. Replace message-count policy with a real context-budget policy

The main weakness of the current compaction implementation is that it triggers on **message counts**:

```ts
Compaction.whenLongerThan(40, {
  retain: 10
})
```

Pi triggers against actual context pressure:

```text
contextTokens >
contextWindow - reserveTokens
```

and retains a recent tail based on tokens rather than message count. 

We should support that.

But don't bake a model's context size into `Agent`.

The model remains externally supplied.

Add a small injected sizing/budget vocabulary:

```ts
interface ContextBudget {
  readonly contextWindow: number
  readonly reserveTokens: number
  readonly keepRecentTokens: number
}

type ResolveBudget<E = never, R = never> =
  (context: ContextTransform.Context) =>
    Effect.Effect<ContextBudget, E, R>

type EstimateTokens<E = never, R = never> =
  (prompt: Prompt.Prompt) =>
    Effect.Effect<number, E, R>
```

Then:

```ts
const compaction = yield* Compaction.make({
  policy: Compaction.tokens({
    budget: {
      contextWindow: 200_000,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000
    },

    estimate: TokenEstimate.approximate
  }),

  summarise
})
```

Later the model-control-plane work can resolve the budget dynamically:

```text
ExecutionPlan / selected model
             ↓
        Model metadata
             ↓
       ContextBudget
```

No model field enters `Agent`.

Keep today's message-count policy as a cheap/simple option:

```ts
Compaction.messages(...)
```

but make token budgeting the serious/default production path.

---

# 2. Don't invent a tokenizer framework

The estimator should just be an Effect-valued function.

Ship a reasonable approximate implementation:

```ts
Compaction.estimate.approximate
```

and allow exact provider-specific tokenizers:

```ts
Compaction.tokens({
  estimate: AnthropicTokens.count,
  ...
})
```

No:

```text
TokenizerRegistry
TokenizerRuntime
TokenizerProviderFramework
```

unless Effect itself eventually gives us one.

---

# 3. Extract a pure `prepare` phase

Pi has a useful conceptual separation between:

```text
prepareCompaction()
```

and:

```text
generate summary / commit compaction
```

Its preparation computes what gets summarized, what stays, whether a turn is split, previous summary, and token counts. 

We should do the same internally.

Something like:

```ts
interface Preparation<D = never> {
  readonly messagesToSummarise: Prompt.Prompt
  readonly retained: Prompt.Prompt

  readonly previous:
    Option.Option<Checkpoint<D>>

  readonly coveredThrough: number
  readonly firstKept: number

  readonly tokensBefore: number
  readonly tokensRetained: number

  readonly splitTurn: boolean
}
```

Then:

```text
canonical prompt
      ↓
pure preparation
      ↓
Preparation
      ↓
Summarizer
      ↓
Checkpoint
      ↓
projection
```

This makes the tricky cut logic independently testable.

It does **not** need to become a public framework abstraction.

---

# 4. Improve cut-point semantics

The current implementation already protects one important invariant: it refuses to open the retained tail on a tool result because providers can reject a tool result whose corresponding call has been summarized away.

Keep that.

Pi formalizes the same concern by forbidding cuts on tool results. 

The new planner should walk backward by token size, then normalize the boundary.

For our message representation:

```text
allowed retained-tail start
───────────────────────────
user
assistant

not
───────────────────────────
tool result
```

If we later have explicit synthetic/custom history messages, they can declare whether they are safe boundaries.

Do not hardcode coding-specific message types like Pi's `BashExecution`.

---

# 5. Support giant/split turns, but don't copy Pi's two-summary machinery unnecessarily

Pi has special handling when one user turn itself exceeds the retained-tail budget; it can summarize the early portion of the turn while retaining the newest assistant/tool exchanges. 

We need the **semantic capability**, but probably not exactly Pi's implementation.

Our current incremental summarizer can already do:

```text
previous summary
+
early part of giant current turn
        ↓
new summary

+
newest assistant/tool exchanges verbatim
```

So if a single turn is enormous:

```text
USER
  ↓
assistant
tool
assistant
tool
tool
assistant
tool
```

we should be able to produce:

```text
SYSTEM
summary including:
  user's request
  early work
  earlier tools

ASSISTANT
...
TOOL
...
ASSISTANT
...
```

The preparation structure should expose:

```ts
splitTurn: true
```

for custom summarizers and telemetry, but we shouldn't automatically pay for **two separate summarization calls** unless experiments show that Pi's two-summary scheme materially improves fidelity.

Fewer mechanisms, same semantic result.

---

# 6. Turn the in-memory checkpoint cache into an optional persistent checkpoint store

This is the largest robustness gap today.

Current compaction checkpoints live in a `Ref<Map<sessionId, Checkpoint>>`. The code correctly fingerprints the canonical prefix so a checkpoint cannot accidentally apply to an unrelated transcript, but process loss discards the checkpoint.

For local use, that's fine.

For durable sessions, it's wasteful and potentially expensive:

```text
summary generated
      ↓
process crashes
      ↓
checkpoint forgotten
      ↓
same history summarized again
```

We should add a tiny store seam.

Not a new persistence framework.

Use Effect's existing persistence primitives, just as `NodeStore` already wraps `KeyValueStore` for tree-specific queries. The tree package explicitly follows this principle and can run over memory, filesystem, SQL or web-storage-backed Effect persistence.

Something like:

```ts
interface CheckpointStore<D = never> {
  readonly get:
    (sessionId: SessionId) =>
      Effect.Effect<Option.Option<Checkpoint<D>>, StoreError>

  readonly put:
    (
      sessionId: SessionId,
      checkpoint: Checkpoint<D>
    ) => Effect.Effect<void, StoreError>

  readonly remove:
    (sessionId: SessionId) =>
      Effect.Effect<void, StoreError>
}
```

Implementations:

```text
memory
KeyValueStore adapter
```

That's enough.

No compaction-specific SQL client.

---

# 7. Make the checkpoint Schema-defined

Current:

```ts
interface Checkpoint {
  coveredThrough
  summary
  prefix
}
```

should become a Schema value and grow slightly:

```ts
Checkpoint<D> {
  coveredThrough
  prefix

  summary

  tokensBefore
  tokensAfter

  usage?

  details?
}
```

The fundamental identity remains:

```text
coveredThrough
+
prefix hash
```

not merely `sessionId`.

That preserves today's very good defense against restoring stale summary state onto the wrong history.

---

# 8. Generalize `summarise` slightly

Currently the summarizer returns:

```ts
Effect<string>
```

and receives:

```ts
{
  messages,
  previous: Option<string>
}
```

That's almost right.

Make it:

```ts
interface SummaryResult<D = never> {
  readonly text: string
  readonly usage?: ModelUsage
  readonly details?: D
}

interface SummaryContext<D = never> {
  readonly messages: Prompt.Prompt

  readonly previous:
    Option.Option<{
      text: string
      details?: D
    }>

  readonly reason:
    | "threshold"
    | "manual"
    | "branch"

  readonly instructions?: string

  readonly splitTurn: boolean
}
```

Then:

```ts
type Summarise<D, E, R> =
  (input: SummaryContext<D>) =>
    Effect.Effect<SummaryResult<D>, E, R>
```

This buys us several Pi capabilities without adding extension hooks.

---

# 9. This replaces most of Pi's compaction extension API

Pi lets extensions intercept before compaction, cancel it, or provide their own summary. 

We don't need a hook/event framework for this.

Users already directly provide:

```ts
summarise: ...
```

And we can make policy effectful:

```ts
policy: ...
```

So custom behavior is ordinary composition:

```ts
const summarise = ({ messages, previous }) =>
  MySummaryService.summarise(
    messages,
    previous
  )
```

or:

```ts
const policy = Compaction.policyEffect(
  Effect.gen(function* () {
    const preferences = yield* Preferences

    return preferences.compactionEnabled
      ? Compaction.tokens(...)
      : Compaction.disabled
  })
)
```

That is cleaner than:

```ts
pi.on("session_before_compact", ...)
```

We should borrow the **capability**, not the hook system.

---

# 10. Add a default structured summarizer

Pi uses a structured continuation-oriented summary containing:

* goal,
* constraints/preferences,
* progress,
* decisions,
* next steps,
* critical context,
* files read/modified. 

That's a good default.

Ship something like:

```ts
Compaction.summarizer({
  model: ...
})
```

or more likely, because model is a service:

```ts
Compaction.modelSummariser({
  template: Compaction.continuation
})
```

which requires:

```text
LanguageModel
```

normally.

It should produce roughly:

```markdown
## Goal

## Constraints & Preferences

## Progress

### Done

### In Progress

### Blocked

## Key Decisions

## Next Steps

## Critical Context
```

But **do not put coding-specific file sections in the generic template by default**.

effect-agent isn't exclusively a coding agent.

---

# 11. Add a conversation serializer

Pi deliberately serializes the old conversation into text instead of passing it as live conversational messages, so the summarization model understands that it is summarizing a transcript rather than continuing it. 

We should copy that idea.

Add an internal/public utility:

```ts
Compaction.serialize(prompt, options)
```

approximately producing:

```text
[User]
...

[Assistant]
...

[Assistant tool call]
search(...)

[Tool result]
...
```

And configurable truncation:

```ts
{
  maxToolResultChars: 2000
}
```

Pi truncates tool outputs for exactly this reason: tool results often dominate summarization context. 

This helper is also useful for custom summarizers.

---

# 12. Track summary-model usage

Pi counts the summarization model's usage as part of session totals. 

We should too.

This fits perfectly with the broader session-stats plan we just designed.

Compaction should emit its own battery event:

```ts
CompactionCompleted {
  sessionId
  reason

  coveredThrough
  firstKept

  tokensBefore
  tokensAfter

  usage?
}
```

along with:

```ts
CompactionStarted
CompactionFailed
```

Don't put these into canonical history.

They're observational runtime events.

Eventually:

```text
AgentSessionHost.events
ProcessManager.events
Compaction.events
...
        ↓
ServerEvent projection
```

and:

```text
SessionProjection
```

can include summary-model token usage.

---

# 13. Manual compaction requires a controller handle

Pi supports:

```text
/compact [instructions]
```

in addition to automatic triggering. 

We should support the semantic capability without putting `/compact` in the library.

I would evolve the API toward:

```ts
const compaction =
  yield* Compaction.make({
    policy,
    summarise,
    store
  })

const Coder = Agent.make().pipe(
  Agent.withContextTransform(
    compaction.transform
  )
)
```

The returned value is a **runtime/controller handle**, because it owns checkpoint state:

```ts
interface Compaction {
  readonly transform: ContextTransform

  readonly compact: (
    options: {
      sessionId: SessionId
      history: Prompt.Prompt
      instructions?: string
    }
  ) => Effect.Effect<Checkpoint, CompactionError>

  readonly checkpoint: (
    sessionId: SessionId
  ) => Effect.Effect<Option<Checkpoint>>

  readonly clear: (
    sessionId: SessionId
  ) => Effect.Effect<void>

  readonly events:
    Stream.Stream<CompactionEvent>
}
```

Then an application's slash command is simply:

```ts
yield* compaction.compact({
  sessionId: session.id,
  history: yield* session.history,
  instructions: "Focus on the database migration."
})
```

`AgentSession` already exposes lazy canonical `history`, so no new core history operation is required.

---

# 14. Preserve the existing simple API

Don't make everyone manage a controller for the basic case.

We can preserve:

```ts
const transform =
  yield* Compaction.makeTransform({
    policy,
    summarise
  })
```

or keep current `make` as a convenience if compatibility matters.

The richer controller exists when users need:

```text
manual compaction
persistent state
inspection
events
```

The important point is **one implementation underneath**.

---

# 15. Durable compaction: use Effect Workflow Activities, not new durability machinery

The current docs already note the correct solution: a summarizer is an ordinary Effect, so a durable application can wrap the model summary call in an Effect Workflow `Activity`.

Keep that.

```ts
summarise: (input) =>
  Activity.make({
    name: stableCompactionActivityName(...),
    success: SummaryResultSchema,
    execute: modelSummarise(input)
  })
```

Then:

```text
workflow replay
    ↓
same Activity
    ↓
persisted summary returned
```

No duplicate model bill.

Checkpoint persistence and Activity persistence solve different things:

```text
Activity journal
    prevents duplicate summarization side effect during replay

CheckpointStore
    remembers what model projection should be used later
```

Keep them separate.

---

# 16. Branch summarization should reuse the same summarizer

Pi intentionally uses the same structured summary format for compaction and branch carryover. 

We should do the same.

Add:

```text
/compaction
  Compaction
  BranchSummary
  shared summary/serialization internals
```

or export:

```ts
Compaction.Branch
```

I probably prefer:

```ts
BranchSummary
```

as a separate public noun, because it is not actually compaction.

---

# 17. We already have almost everything needed for branch summary preparation

Pi needs to:

1. find common ancestor,
2. collect old-branch entries,
3. fit them to a summary budget,
4. summarize them,
5. carry that summary into the target branch. 

Our `SessionTree` already has:

```ts
tree.commonAncestor(a, b)
tree.divergence(a, b)
tree.path(node)
tree.historyOf(node)
```

and branch nodes are persistent through `NodeStore`.

So preparation is basically:

```ts
const divergence =
  yield* tree.divergence(oldLeaf, target)

const oldHistory =
  yield* tree.historyOf(oldLeaf)

const ancestorHistory =
  divergence.at.pipe(
    Option.map(tree.historyOf)
  )

const abandonedMessages =
  oldHistory - ancestorHistory
```

Then apply a branch-summary token budget newest-first, exactly as Pi does conceptually.

No Agent kernel change.

---

# 18. One small Tree seam is missing: seed a branch with derived carryover context

This is the meaningful architectural gap.

Today:

```ts
tree.branch(node)
```

creates a fresh `AgentSession` from exactly that node's stored history.

For Pi-style branch summarization we need:

```text
target branch history
+
summary of abandoned branch
```

to seed the new branch.

There are two ways to do it.

I prefer a **generic branch-history decoration seam**, not branch-summary logic in `SessionTree`.

Conceptually:

```ts
tree.branch(node, {
  seed: (history) =>
    Prompt.concat(
      history,
      branchSummaryPrompt
    )
})
```

or an internal equivalent exposed through a more carefully named API.

The key property is:

> `/tree` knows how to build a session from a node; it should permit a caller to deliberately decorate that initial history without teaching the tree what a summary is.

Then:

```ts
BranchSummary.branch(tree, {
  from: oldLeaf,
  to: target,
  summarise
})
```

can:

```text
calculate divergence
      ↓
generate abandoned-work summary
      ↓
decorate target's starting history
      ↓
tree creates fresh session
```

That is the **only significant new tree capability** I see.

---

# 19. Branch carryover should become canonical on the new branch

This is one place where I would *not* use normal compaction's ephemeral projection.

The branch summary exists because the user intentionally navigated away from one line of work and chose to carry information from it into another.

It needs to survive:

```text
next turn
next turn
branch descendants
tree persistence
```

Our `ContextTransform` docs make the right distinction:

> information that must survive future turns belongs in committed session history rather than a one-shot model projection.

So seed the target branch with a distinct system/synthetic message such as:

```text
Context carried from another branch:

<summary>
```

That becomes part of that branch's canonical history.

This is not destructive.

The original target history and abandoned branch remain preserved by the tree.

---

# 20. Ideally preserve provenance

Don't inject an opaque summary string if we can cheaply retain:

```ts
interface BranchSummaryMetadata {
  readonly from: NodeId
  readonly to: NodeId
  readonly commonAncestor: Option<NodeId>
}
```

If `Prompt` doesn't support custom message metadata cleanly, keep this in tree/branch-summary storage or node metadata rather than inventing a fake message protocol.

This gives future UI:

```text
"Context imported from branch X"
```

and lets export/audit explain why that system message exists.

---

# 21. File tracking belongs in `/coding`, not generic compaction

Pi accumulates:

```text
readFiles
modifiedFiles
```

through repeated compactions and nested branch summaries. 

That's useful for coding agents.

But it is **not an agent-harness concept**.

This is why `SummaryResult<D>` should permit typed custom details.

Then `/coding` can offer:

```ts
CodingSummary.details
```

or:

```ts
CodingCompaction.summariser(...)
```

whose details are:

```ts
interface CodingSummaryDetails {
  readonly readFiles: ReadonlyArray<SandboxPath>
  readonly modifiedFiles: ReadonlyArray<SandboxPath>
}
```

The summarizer receives:

```ts
previous.details
```

and can union them with tool operations from the new span.

Exactly Pi's cumulative semantics, but as composition.

---

# 22. Don't infer file operations from magic tool names if we can avoid it

Rather than generic compaction knowing:

```text
tool.name === "read"
tool.name === "write"
```

our coding tools should emit semantic annotations or structured events:

```text
FileRead(path)
FileModified(path)
```

Then the coding summarizer can fold those.

That ties nicely into the larger runtime-event/read-model architecture.

If doing that now is too invasive, first version can inspect known `/coding` toolkit definitions because those are ours, but don't make that generic Compaction behavior.

---

# 23. Branch summaries can reuse cumulative details too

Then:

```text
branch A
  read a.ts
  modify b.ts

summary A→B
  details:
    readFiles = [a.ts]
    modifiedFiles = [b.ts]
```

and if that summary is itself later summarized:

```text
previous details
+
new file events
        ↓
union
```

So the details channel supports both:

```text
repeated compaction
branch carryover
nested branch carryover
```

with one mechanism.

---

# 24. Auto-compaction failure should be observable but shouldn't corrupt state

Pi exposes failed/cancelled compaction events. 

Our behavior should be:

```text
prepare
  ↓
summarizer fails
  ↓
DO NOT update checkpoint
  ↓
emit CompactionFailed
  ↓
propagate typed error
```

The prior checkpoint remains valid.

This is another reason the process should be:

```text
prepare
summarize
persist checkpoint
project
```

and not mutate state before summarization finishes.

---

# 25. Custom cancellation doesn't need a hook

If a caller wants policy-driven cancellation:

```ts
policy: Effect<Decision>
```

can return:

```ts
type Decision =
  | { _tag: "Keep" }
  | { _tag: "Compact"; preparation: ... }
```

A manual call can simply decline to execute.

No generic:

```text
session_before_compact
```

event that expects a return value.

Events should remain observational.

Configuration should remain direct.

---

# 26. Overflow recovery should be a later, narrow phase

Pi also compacts reactively after an actual context overflow and can retry the aborted turn. Its hook API even exposes whether the turn will be retried. 

We should support this eventually—but I would **not distort `ContextTransform` to do it now**.

A transform operates before a model call.

It cannot naturally respond to:

```text
model rejected this context as too large
```

because that happens afterward.

First implement reliable preflight budgeting.

Then, if provider mismatches make overflow recovery necessary, add a narrow model-invocation recovery seam:

```text
prepare prompt
    ↓
model call
    ↓
ContextLengthExceeded
    ↓
force compact
    ↓
rebuild prompt
    ↓
retry same turn once
```

This should be a generic enough execution seam that it can be justified independently—not a compaction special case jammed into `AgentSession`.

I would explicitly put automatic overflow retry in **Phase 2** of this work.

---

# 27. Summary generation should not accidentally use the same routing semantics as an agent turn

Pi gives one-off summary calls fresh routing session IDs and avoids cache writes where the provider supports it. 

For us, the principle should be:

> Summarization is an ordinary independent model Effect, not another turn in the session.

So it should not:

```text
run agent tools
mutate agent history
participate in AgentLoop
reuse session conversational state
```

A default summarizer simply calls:

```ts
LanguageModel.generateText(...)
```

with a serialized transcript.

If provider-specific cache flags/session IDs matter, the supplied summarizer Layer/provider options can configure them.

Don't add those provider concepts to generic Compaction.

---

# 28. This also works beautifully with `ExecutionPlan`

The current repo has already moved beyond the older design and `AgentSession` can now run an agent carrying an `ExecutionPlan` instead of requiring one ambient `LanguageModel`.

Compaction should **not automatically use the agent's execution plan**.

Often we want:

```text
main agent
Claude Opus / expensive plan

compaction
small cheap summarization model
```

So `summarise` independently provides/uses whatever model or plan the application chooses.

That separation is valuable.

---

# 29. Public API target

I would aim for something roughly like:

```ts
const compaction = yield* Compaction.make({
  policy: Compaction.tokens({
    budget: {
      contextWindow: 200_000,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000
    },

    estimate: Compaction.estimate.approximate
  }),

  summarise: Compaction.model({
    template: Compaction.continuationSummary,
    maxToolResultChars: 2_000
  }),

  store: CompactionStore.keyValue(kv)
})

const Coder = Agent.make().pipe(
  Agent.withContextTransform(
    compaction.transform
  )
)
```

Manual:

```ts
yield* compaction.compact({
  sessionId: session.id,
  history: yield* session.history,
  instructions:
    "Preserve the current database migration plan."
})
```

Inspection:

```ts
const checkpoint =
  yield* compaction.checkpoint(session.id)
```

And branch use:

```ts
const activation =
  yield* BranchSummary.activate(tree, {
    from: current,
    to: target,

    summarise:
      Compaction.model({
        template:
          Compaction.continuationSummary
      })
  })
```

That last API name/shape can be refined during implementation, but that's the intended semantic level.

---

# 30. Suggested internal organization

I would **not expose all of these as framework nouns**.

Internally:

```text
src/compaction/
  Compaction.ts
      controller + ContextTransform

  prepare.ts
      token planning / safe cut points

  Summary.ts
      shared SummaryResult/Summarise
      default continuation prompt

  serialize.ts
      transcript serialization

  CheckpointStore.ts
      memory + KeyValueStore

  BranchSummary.ts
      SessionTree integration
```

Public exports can remain mostly:

```ts
Compaction
BranchSummary
```

Maybe `CompactionStore` if applications genuinely need to select persistence.

---

# 31. Implementation phases

I would give the coding agent this order:

Implementation note (2026-08-27): phases 1–7 are complete. The existing ten
behavior tests were strong enough to serve as the phase-1 freeze and all stayed
green through the refactor. The cut-point calculation now lives in pure
`internal/prepare.ts`; `Compaction.tokens` supports fixed or Effect-resolved
budgets plus typed Effect-valued estimators; and `Compaction.Checkpoint` is a
Schema value. Token measurements are `Option` because the compatible
message-count policy has no tokenizer. Checkpoints can use a supplied Effect
`KeyValueStore`; a restart test recreates the transform and proves it reuses the
persisted checkpoint. `SummaryResult` carries provider-neutral usage while the
string return remains source-compatible. `Compaction.serialize` renders all
prompt part variants, describes file payloads, and bounds tool-result text.

Two proposed abstractions were deliberately not added. `KeyValueStore` already
has a schema-aware view, so a package-specific `CheckpointStore` would only
rename an existing Effect primitive. `SummaryResult<D>` was narrowed to a
non-generic `SummaryResult` with usage: typed details have only the speculative
branch/coding consumers in phases 12–13, and repository scope discipline says
not to export a concept before two real features need it. Those phases can add
details with their schemas when the use cases are concrete.

| Phase  | Work                                                                   |
| ------ | ---------------------------------------------------------------------- |
| **1** ✅ | Freeze current compaction behavior with regression tests             |
| **2** ✅ | Extract pure preparation/cut-point logic                             |
| **3** ✅ | Add token estimation + `ContextBudget` policy                        |
| **4** ✅ | Convert `Checkpoint` to Schema + token measurements                  |
| **5** ✅ | Add memory/KeyValueStore checkpoint persistence                     |
| **6** ✅ | Enrich `Summarise` with structured text + usage (typed details deferred until consumers exist) |
| **7** ✅ | Add transcript serializer + truncation                              |
| **8** ✅ | Add default continuation-oriented model summarizer (`Compaction.model`, `continuationSummary`, `Template`) |
| **9** ✅ | Add controller/manual `compact()` API (`Compaction.controller`; `make` delegates to it) |
| **10** ✅ | Add `CompactionEvent` stream and usage reporting (controller-scoped Schema, not `AgentEvent`) |
| **11** | Add generic branch-seed decoration seam to `/tree`                     |
| **12** | Implement `BranchSummary` from `tree.divergence`                       |
| **13** | Add `/coding` cumulative file-operation details                        |
| **14** | Durable conformance tests using Activity + persistent checkpoint store |
| **15** | Only after all that, investigate automatic provider-overflow recovery  |

---

# 32. Critical tests

The implementation agent should treat these as acceptance criteria:

| Case                       | Required result                                                                |
| -------------------------- | ------------------------------------------------------------------------------ |
| Canonical preservation     | Compaction never modifies `session.history`                                    |
| Dynamic transforms         | Context injected before compaction is not accidentally discarded               |
| Repeated compaction        | Previous summary + newly foldable span produce correct next summary            |
| Retained tail              | Newest context stays verbatim                                                  |
| Tool pairing               | Retained prompt never begins with an orphaned tool result                      |
| Huge turn                  | Compaction can cut within an agentic turn safely                               |
| Prefix mismatch            | Stale checkpoint is rejected                                                   |
| Durable restart            | Persistent checkpoint prevents unnecessary re-summarization                    |
| Summary failure            | Existing checkpoint remains unchanged                                          |
| Manual instructions ✅     | Manual focus text reaches summarizer (`Summarise` gained `instructions`)      |
| Usage ✅                   | Summarization tokens appear on the checkpoint and `CompactionCompleted`       |
| Tree divergence            | Only abandoned work after common ancestor is summarized                        |
| Target branch              | Original target history remains intact                                         |
| Branch carryover           | Summary persists into descendants of the new branch                            |
| Original branch            | Abandoned branch is unchanged                                                  |
| File details               | read/modified files accumulate across repeated compactions                     |
| Nested summaries           | prior typed details survive branch-summary → later compaction                  |
| Different summarizer model ✅ | `Compaction.model()` requires `LanguageModel`; discharge it with a different layer |
| Durable summary            | Workflow replay does not repeat a completed summary model call                 |
| Storage portability        | Persistent implementation depends on Effect persistence, not a database driver |

---

# 33. The design takeaway

Pi demonstrates several valuable behaviors:

```text
token-aware compaction
retained live tail
incremental summaries
split-turn survival
manual compaction
branch carryover
structured continuation summaries
cumulative coding metadata
custom summarizers
usage accounting
```

We should implement nearly all of those.

But the translation into our architecture is:

```text
Pi extension hooks
        ↓
ordinary Effect functions / strategies

Pi CompactionEntry
        ↓
noncanonical persisted Checkpoint

Pi session rewriting/rebuilding
        ↓
ContextTransform projection

Pi tree traversal
        ↓
existing SessionTree.divergence

Pi extension details
        ↓
typed SummaryResult<D>

Pi file tracking
        ↓
/coding-specific summary details

Pi settings files
        ↓
ordinary typed config / Effect Config

Pi summary call
        ↓
LanguageModel Effect / durable Activity
```

So the answer to the original question is **yes: we already chose the right foundational abstractions**.

The only meaningful architectural additions I see are **persistent compaction state, real token budgeting, a manual controller, and a generic way for `SessionTree` to seed a newly created branch with deliberately derived context**. Almost everything else is functionality built out of primitives that already exist.

That is exactly the outcome we'd want: Pi gives us useful product semantics to borrow, without revealing that our kernel needs to become Pi-shaped.

## Progress: phases 8-10 (2026-08-29)

Landed together. Three decisions worth recording because the sketches above
left them open:

- **Events are not `AgentEvent`s.** §13 sketched `events` on the controller
  and that is where they went. Adding tags to the session union is a wire
  change every transport and client pays for, and compaction is owned by
  whoever built the transform, not by the session. `CompactionEvent` is a
  Schema (`Started` / `Completed` / `Failed`, each with `trigger:
  "automatic" | "manual"`), delivered on a sliding buffer of 64 so a slow
  subscriber loses old events rather than stalling a turn.
- **Manual compaction cuts by message count.** There is no turn in flight,
  so no projection to measure a token budget against, and a `ResolveBudget`
  takes a `ContextTransform.Context` that does not exist outside a turn.
  `compact({ retain })` defaults to the policy's `retain` under
  `whenLongerThan` and to six under `tokens`; the cut is aligned off tool
  results like every other. `compact` therefore never carries the policy's
  error, which the `Controller` type states by giving it its own channel.
- **`model()` takes the model as a requirement.** That is what makes "a
  different summarising model" a one-liner (`Effect.provide` on the
  summariser) instead of a second configuration surface.

`Summarise` gained an `instructions: Option<string>` argument; existing
summarisers that destructure two fields compile unchanged. `make` is now
`controller(...).transform`. Tests: `test/Compaction.test.ts` "compaction
controller (phases 8-10)" -- template content and usage, manual fold and the
next-turn projection, `nothing-to-fold`, the event stream for both triggers
with a JSON round-trip, `clear`, and a summariser on a different model; two
of them broken once (instructions dropped; `clear` a no-op).
