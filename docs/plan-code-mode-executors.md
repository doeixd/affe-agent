# Plan: code-mode executors — suspension, pre-flight, discovery, CallScript

Drafted 2026-09-01, after reading Vercel Labs' CallScript
(<https://www.callscript.dev>, `vercel-labs/callscript`) against the finished
`/code` engine (`plan-code-mode-engine.md`, complete 2026-08-31).

CallScript is the same premise as code mode — one model round-trip authors
many tool calls — reached from the other end. The model writes
JavaScript-shaped source, but **nothing executes it**: it compiles to an inert
JSON *plan* of three verbs (`call`, `let`, `return`) with `if` / `each`+`max` /
`after` / `suspend` modifiers, which an engine walks. Giving up
Turing-completeness buys three things our interpreter cannot have: the whole
program is validated before any call runs, a static upper bound on total calls,
and a run that suspends and resumes across a process boundary because the plan
plus its settled step outputs *is* the state.

That is not a better design than ours; it is a different point on the same
trade. Our interpreter has control flow, real `try`/`catch`, and diagnostics
that name the fix. Neither subsumes the other, which is precisely the case
`CodeExecutor` was introduced for (`plan-code-mode-engine.md` decision 1).

This plan takes what transfers, fixes what the comparison exposed as a defect
in our own surface, and lands a second executor as the proof the seam is one.

## Decisions, made now so implementation does not re-litigate them

1. **The executor outcome set is widened before a second executor exists,
   not after.** `CodeExecutor.run` today returns `{ result, logs }` or fails.
   That encodes "a program either finishes or does not" — true of *our*
   interpreter, and asserted by the interface of *every* engine. Plan
   decision 2 chose the tool-failure shape early on the stated grounds that
   it is near-impossible to change later; the outcome set has exactly the
   same property and did not get the same treatment. One variant now, a
   breaking change to a published entry point later.

2. **Decision 7 is not reopened.** Durable suspension of a *paused owned
   interpreter* stays out of scope, permanently, for the reason it was
   parked: its state is a JS call stack. What step 1 adds is the *ability
   for an executor that has resumable state to say so*. The owned
   interpreter never returns `Suspended`, and that is asserted, not assumed.

3. **Suspension state is opaque to the host and typed `unknown`.** The
   executor owns the shape; the host persists it and hands it back. This is
   not `unknown` in an error channel (which AGENTS.md forbids and means) —
   it is a serialisable payload whose schema belongs to a component the
   kernel does not know. The obligation is stated at the field: an executor
   that returns `Suspended` warrants its state is JSON-serialisable, and the
   `Schema.Unknown` on the wire is the host's storage contract, not a hole
   in a decision path.

4. **Pre-flight validation is additive and reuses the interpreter's own
   tables.** No second grammar. The validator walks the acorn AST with the
   same supported-node knowledge `interpret` has, plus the one fact the
   interpreter deliberately lacks — the toolkit — and collects rather than
   stops. It is a *diagnostic* improvement, never a semantic one: a program
   the validator passes must behave exactly as it does today.

5. **A static call-count bound is not pursued.** CallScript can compute one
   because `each`/`max` declares the fan-out in the plan. `for...of` over a
   model-computed array cannot be bounded before it runs. Our limits stay
   runtime, and stay defaulted-to-nothing (engine plan decision 6: budgets
   are host policy).

6. **CallScript never mounts our tools.** Not `fromAISDKTools`, not
   `fromMCP`. Every tool the adapter mounts is a shim onto our `invoke`
   hook, so a nested call still passes the same `Permission` decision,
   emits the same `AgentEvent`s, and is redacted the same way. Invariant 2
   — *code mode is never a cheaper path to a tool* — is exactly what an
   integration with its own tool-mounting quietly breaks, and it would break
   silently: the program would work.

7. **The adapter is a sub-entry with an optional peer dependency**
   (`@doeixd/effect-agent/code/callscript`, `callscript` in
   `peerDependenciesMeta` as optional), the pattern `/blob/fs`,
   `/sandbox/local` and `/web/brave` already establish and the treatment
   `@modelcontextprotocol/sdk` already gets. `src/code` keeps its single
   pinned `acorn`; a caller who does not want CallScript does not install
   it and does not pay for it.

8. **Host-side typed authoring is out of scope.** CallScript's
   `engine.script()` — a *host* writing a deterministic multi-tool plan in
   real TypeScript, transpiled and never executed — is a workflow, and
   `/durable` serves that properly today with journalling, replay and typed
   errors. Code mode's premise is that the *model* writes the program.
   Adding a host-authoring path here would be a second, weaker workflow
   system in the wrong module.

9. **`onError: "skip"` is not taken.** We have the better version already:
   a declared failure arrives as `{ ok: false, error }` — a value the happy
   path branches on, carrying the tool's own typed error — rather than a
   stringly `$errors.<stepId>` bag consulted after the fact.

## Sequence

| Step | What | Depends on |
| --- | --- | --- |
| 1 | `CodeExecutor` outcome widened to `Completed \| Suspended`; `CodeMode.Outcome` and `CodeTool.Result` gain the variant; resume threaded through `execute` | nothing |
| 2 | `Catalog.searchTool` — `Catalog.search` as a model-facing tool, opt-in from `CodeTool` | nothing |
| 3 | `internal/validate.ts` — collect-all pre-flight; `CodeDiagnostic` gains a plural carrier | 1 (for the reason set) |
| 4 | `code/callscript.ts` — CallScript behind `CodeExecutor`, as the acceptance test for 1 and 3 | 1, 3 |

Steps 1–3 stand on their own merits and ship whether or not step 4 does.
Step 4 is what proves the seam is a seam: a second executor is the only real
evidence, and this repository's habit is to prove things that way.

---

## Step 1 — the executor outcome

### What is wrong now

```ts
export interface CodeExecutor {
  readonly run: <R>(
    code: string,
    hooks: { readonly invoke: Invoke<R> }
  ) => Effect.Effect<
    { readonly result: Option.Option<unknown>; readonly logs: ReadonlyArray<ReadonlyArray<unknown>> },
    ProgramFailure,
    R
  >
}
```

An engine that pauses has nowhere to say so. It must either fail (losing the
settled work) or block the fibre until resumed (losing the process boundary,
which was the entire point).

### The shape

```ts
export type ExecutorOutcome =
  | {
    readonly _tag: "Completed"
    readonly result: Option.Option<unknown>
    readonly logs: ReadonlyArray<ReadonlyArray<unknown>>
  }
  | {
    readonly _tag: "Suspended"
    /**
     * Everything the executor needs to continue, and nothing the host
     * interprets. JSON-serialisable by the executor's warrant (decision 3):
     * persist it, hand it back to `run` unchanged.
     */
    readonly state: unknown
    /** Why, in the model's vocabulary. Names what would resume the run. */
    readonly reason: string
    /** Logs so far. A suspended run has already done work worth showing. */
    readonly logs: ReadonlyArray<ReadonlyArray<unknown>>
  }

export interface CodeExecutor {
  readonly run: <R>(
    code: string,
    hooks: {
      readonly invoke: Invoke<R>
      /** A prior `Suspended.state`. Settled work is the executor's to reuse. */
      readonly resumeFrom?: unknown | undefined
    }
  ) => Effect.Effect<ExecutorOutcome, ProgramFailure, R>
}
```

`Completed` carries the two fields the current return type has, so the owned
interpreter's adaptation is one wrap.

### Propagation

- `CodeMode.Outcome` gains `{ _tag: "Suspended"; state: unknown; reason: string }`
  beside `Returned` / `RanOffTheEnd` / `Threw` / `Refused`. It stays *data*:
  invariant 3 (`execute` succeeds with what happened) is unchanged.
- `CodeMode.ExecuteOptions` gains `resumeFrom?: unknown`. `CodeMode.execute`
  passes it through and otherwise behaves identically — the limits counters,
  the approval prefix and the `calls` array are per-*call*, not per-program,
  and that is worth a comment at the site: a resumed run gets a fresh
  `maxToolCalls` budget unless the host carries its own. **State the choice
  rather than defaulting into it**: a budget that resets on resume is a hole
  if resumption is cheap, so the field says so and the host decides.
- `CodeTool.Result.outcome` gains `"suspended"`, with the state carried
  *out of band*. The model must not receive an opaque blob it will try to
  reason about: the result the model sees is
  `{ outcome: "suspended", fix: <reason> }`, and the state reaches the host
  through a new `ExecuteOptions.onSuspend` hook, the same way `onApproval`
  and `onCall` already reach it. **`CodeTool` never puts executor state in a
  model-visible field.**

### Tests, and the ones to break

`test/CodeExecutors.test.ts` (new):

- The owned interpreter never returns `Suspended`, for a program that
  approves, throws, loops and returns. *Break once:* make `interpreted`
  return `Suspended` and see the assertion fail.
- A stub executor that suspends on its first call and completes on resume:
  `execute` reports `Suspended`, `onSuspend` receives the state, and a second
  `execute` with `resumeFrom` completes. *Break once:* drop `resumeFrom` on
  the way through `CodeMode.execute` and see the second run suspend again.
- `CodeTool` with that stub returns `outcome: "suspended"` and **no field of
  the model-visible result contains the state**. Asserted structurally
  (encode the `Result` and search it), not by reading the mapping.

---

## Step 2 — search as a tool

### What is wrong now

`Catalog.search` exists, is good, and no model can call it. `CodeTool` builds
one tool whose description carries the budgeted catalog; when the catalog is
`PARTIAL` its header says so — we explicitly tell the model *there is more* and
then give it no way to ask. The design answers its own question badly.

CallScript makes this visible by exposing three tools (`execute`, `search`,
`describe`). We do not need `describe` separately: `Catalog.search` already
returns full `Entry` values including the rendered signature, so one tool
covers both.

### The shape

```ts
// src/code/CodeTool.ts
export const searchTool: <Groups extends CodeMode.ToolGroups>(
  options: { readonly tools: Groups; readonly name?: string | undefined; readonly limit?: number | undefined }
) => Tool.Any
```

Not an `Effect`, unlike `tool`: search touches no handler and no policy, so it
has no requirement to discharge. Parameters are `{ query, offset? }`, mapping
onto `search`'s existing `{ offset, limit }` / `next` / `total`, which is
already the right pagination shape.

`CodeTool.Options` gains `search?: boolean | undefined`, and `tool` returns
just the execute tool as it does today. Whether a host mounts both is the
host's business — the same deliberate non-decision `tool`'s doc comment
already makes about replacing versus sitting beside the underlying tools.

**Default off.** A second tool is prompt cost, and for a toolkit whose catalog
is complete it is cost for nothing. The right default is the one that is free.

### The instructions block

`INSTRUCTIONS` in `CodeTool.ts` must gain a line when search is mounted, and
only then — a model told to search for a tool that has no search tool is worse
off than one that was told nothing. Conditional string assembly, tested for
both branches.

---

## Step 3 — pre-flight validation

### What is wrong now

The interpreter fails on the first diagnostic, at the moment it reaches it.
CallScript's line for this is the right one: *arbitrary code can only fail at
runtime, one error at a time*. Concretely, today: a program that makes three
expensive tool calls and then names a fourth tool that does not exist pays for
all three, returns one diagnostic, and the next turn discovers the next
problem. The interpreter cannot do better on its own — the edge-case pass
established that it has never seen the toolkit, which is why `const f =
tools.x.y` could not be diagnosed accurately from inside it.

### The shape

`src/code/internal/validate.ts`, run in `CodeMode.execute` between `parse` and
`executor.run`, over the acorn AST:

- **Unsupported syntax**, every occurrence — the same node kinds `interpret`
  refuses, from one shared table so the two cannot drift. The table moves to
  `internal/supported.ts` and both import it; a node kind added to the
  interpreter and not the table is a test failure.
- **Blocked members**, every occurrence.
- **Unknown tool paths.** Statically resolvable `tools.ns.name` member
  expressions checked against `Catalog.entries`. Conservative by
  construction: a computed access (`tools[ns][name]`) is *not* a finding, it
  is simply not checked. **A false positive here refuses a working program**,
  which is far worse than the round trip it saves, so the rule is that only
  a literal path with a literal name is ever reported.
- **Nothing else.** No arity checking (the schemas do it, better, with their
  own messages), no type inference, no reachability.

### The diagnostic carrier

`CodeDiagnostic` is singular — one `reason`, one `line`, one `fix` — and
`Outcome.Refused` inlines those three fields rather than carrying the error.
Both need to admit several. The design constraint is that the *existing*
single-finding path must not get worse to read, because it remains the common
case (a parse error is one error).

Proposed: `CodeDiagnostic` gains
`more: Schema.optional(Schema.Array(Schema.Struct({ reason, line, fix })))`,
defaulting absent; `message` renders the first finding and, when `more` is
present, appends `(and N more)`. `Outcome.Refused` gains the same optional
array. A single finding encodes exactly as it does today — pinned by a test,
because the encoded form crosses journals.

`CodeTool.Result` renders all findings into `fix` as a numbered list. That is
the one the model reads, and a list of four fixes in one turn is the entire
value of the step.

### Reason-set coupling, noted

`CodeDiagnostic.reason` is interpreter-shaped: `not-iterable`, `call-depth`,
`blocked-member`. A plan-based executor produces `unbound-reference`,
`unknown-tool`, `step-limit`. The literal set is coupled to one executor
inside an interface that claims to be executor-neutral.

**Resolved here rather than in step 4:** add `unknown-tool` (step 3 needs it)
and `plan-invalid` (step 4's catch-all, whose `fix` carries the engine's own
message). An executor does not get to extend the set — a closed union is what
makes a host's `switch` on `reason` exhaustive, and that is worth more than
each engine's exact vocabulary.

### Tests

`test/CodePreflight.test.ts`: a program with four distinct unsupported
constructs reports four; an unknown tool path is reported before any call runs
(*asserted by an `invoke` that fails the test if called*); a computed tool
access is not reported; a valid program's behaviour is byte-identical to
today's. *Break once:* remove the `unknown-tool` check and watch the
never-called `invoke` assertion fail.

---

## Step 4 — CallScript behind `CodeExecutor`

### Entry point

`src/code/callscript.ts` → `@doeixd/effect-agent/code/callscript`, exporting:

```ts
export const executor: (options?: {
  readonly limits?: { /* CallScript's own step / fan-out / total / concurrency */ } | undefined
}) => CodeExecutor
```

`package.json`: a new `exports` entry (which `verify:package` will then check
imports from the packed tarball), `callscript` in `peerDependencies` and in
`peerDependenciesMeta` as optional. It is pure JavaScript, so
`lint:portability` and `verify:workerd` should be unaffected — **verify, do
not assume**, and if the bundle grows in a way the worker cares about, that is
a finding worth recording rather than working around.

### The mapping

| CallScript | Ours |
| --- | --- |
| a mounted tool | a shim over `hooks.invoke(path, input)` — decision 6 |
| tool catalogue for the prompt | `Catalog`, unchanged (it is executor-independent, and CallScript's authored language is JS-shaped) |
| `suspend` modifier / serialisable `state` | `ExecutorOutcome.Suspended` (step 1) |
| pre-execution validation failures | `CodeDiagnostic` with `more` (step 3), reason `plan-invalid` |
| unknown tool at compile time | reason `unknown-tool` |
| `onError: "skip"` | not mapped (decision 9) |
| `fromAISDKTools` / `fromMCP` | **never used** (decision 6) |

Every tool the adapter mounts derives its name and input schema from the
`ToolGroups` the host already passed `CodeMode.make`, so the set of callable
tools is identical between executors. That is the property the seam claims and
the one worth a test: **the same program, the same toolkit, the same
permission policy, both executors, same observed calls.** Where the two
genuinely differ (control flow the plan language does not have) the CallScript
run is refused with a diagnostic, and that difference is enumerated in the
test rather than discovered by a user.

### Casts

The adapter is expected to need none. `callscript`'s own types are its own,
and the shim is a function we write — if a cast turns out to be structurally
necessary it goes in `AGENTS.md` with its reason, and `test/Casts.test.ts`
will ask. **A cast in the adapter is a signal the seam is drawn wrong**, and
should be treated as a finding before it is treated as an entry.

### The claim to substantiate, and the one not to overstate

What lands: a caller who wants inspectable, persistable, resumable
orchestration can have it *through the same `CodeTool`, catalog, permission
policy and event stream* as the owned interpreter, by changing one option.

What does not: this is not durable suspension for code mode generally. It is
durable suspension for programs written in a language that gave up control
flow to get it. Decision 2 stands, and the documentation must say which
executor a suspension claim belongs to every time it makes one.

## Not doing

- A static upper bound on total calls (decision 5).
- Host-side typed authoring (decision 8).
- `onError: "skip"` (decision 9).
- Suspension for the owned interpreter (decision 2) — asserted, not merely
  omitted.
- Any change to the tool-failure split, the data boundary, or `Catalog`'s
  rendering. Step 2 exposes `Catalog.search`; it does not modify it.

## Bookkeeping

Each step appends a dated section to `docs/status-history.md` and edits the
line it affects in `STATUS.md` (the "Code mode" paragraph under *What ships*,
and — for step 4 — the batteries list and the maturity map). `ROADMAP.md`
gains the executor row. `docs/remaining-work.md` item 21 is currently marked
complete; it gets a follow-on line rather than being reopened, because the
engine plan *is* complete and this is work on top of it.
