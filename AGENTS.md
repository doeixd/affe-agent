# Working in this repository

Effect Harness is an Effect-native agent execution kernel. `PLAN.md` is the
design authority; `STATUS.md` is the short statement of what is true now, and
`docs/status-history.md` the chronology of how it got there -- a change
appends a dated section to the history and edits the line in `STATUS.md` it
affects.

## The rule that matters most

**End-user code must never need a type cast.**

No `as any`, no `as unknown as`, and no hand-annotated parameters that the
compiler should have inferred. If using this library requires a cast, that is a
defect in the library, not in the user's code — fix the signature.

The library absorbs type friction so callers never see it. Where the engine's
erased internals meet the generic public API, the assertion belongs *inside*
`src/`, confined to one place and commented with why it is sound.

Two kinds of `as` are worth telling apart, because only one is a hole.

A plain `x as T` is still checked for overlap — it can narrow, it cannot claim a
string is a number. `src/` has around a hundred of those and they are ordinary.
What erases is `x as any`, which turns the checker off, and `x as unknown as T`,
which routes around it. A third form erases too, from the other end: `x as never`, since `never` is
assignable to everything. **Twenty-four erasing casts exist, in seven files**, and they
are the list below. `test/Casts.test.ts` enforces it: adding one fails the build
until it is written down here, with its reason.

(The test parses rather than greps, because `grep " as any"` matches the phrase
*"survives for as long as anyone holds it"* in a real comment. That is how it
came to be written that way.)

The erasing casts in `src/` are structural, and each is documented at the site:

* constructing the phantom `Tools` field on `AgentSession`, which has no runtime
  counterpart;
* defaulting an absent toolkit to `Toolkit.empty`, where the safety follows from
  an inference fact the compiler cannot restate;
* assembling an `AgentDefinition` in `Agent.ts`'s one internal `definition`
  function, where the loop's invariant `Tools` slot keeps the compiler from
  relating a field typed for one agent to the next agent's parameters even
  when the value is exactly right -- every combinator states its precise result
  type, and the erasure is confined to that one place;
* merging two handled toolkits by delegation (`internal/toolkit.ts`'s
  `mergeHandled`, two), because Effect AI composes toolkits before handlers are
  bound and a `WithHandler` is a closed value;
* **merging the output tool into the agent's toolkit, and withholding it**
  (`AgentTurn.ts`, two). An agent that declares an `AgentOutput` has one extra
  tool injected per turn, whose handler closes over that session's staged
  value. `Toolkit.WithHandler` is invariant in its tools, so the merged union
  is not `WithHandler<Tools>` -- which is honest, and also not something a
  caller ever sees: the injected tool is the harness's own and never enters
  the agent's tool record. The second is its mirror: on the one turn an
  `AgentLoop.Final` decision asks for, the agent's tools are withheld and
  `Toolkit.empty` stands in for them, which the same invariance keeps from
  being a `WithHandler<Tools>`. The turn's result stays typed by the agent's
  tools, of which that turn can have called none;
* **mapping a declared tool tuple element-wise** through a function that
  returns each element's own type -- `McpToolkit.bind` (1) and
  `ToolSource.bind` (1) raise a declared tool's approval floor from the
  source's hints. `Array.map` widens the tuple `Tools` to `Tool.Any[]`, and
  nothing but an erasure restores the tuple the elements never left;
* **wrapping a service whose method types are closed** — `DurableModel` (5),
  `DurableToolkit` (3) and `TestLanguageModel` (6). Each replaces a method on a
  `LanguageModel.Service` or a `Toolkit.WithHandler` with one that journals,
  counts or replays around it. The value is the original's behaviour plus a
  wrapper; the type cannot say so, because Effect AI's service methods are
  declared with concrete signatures rather than a mappable shape. Confined to
  the wrapper's construction: everything the wrapper is *given* and everything
  it *returns* is typed. `TestLanguageModel.failingAfter` is the newest, and it
  is in `src/` for a reason worth stating: a test needed a provider that fails
  after answering once, and **test code counts as user code**, so the cast lives
  in the one place licensed to hold it rather than in the test that wanted it
  (two of them -- one per entry point, because a streamed run must see the same
  provider as a batch one);
* **restating a wrapper-erased requirement** (`code/CodeMode.ts`, two):
  `Toolkit.WithHandler` is invariant in its tools, so code mode's groups are
  constrained as `WithHandler<any>` and `handle`'s services surface as
  `unknown` — the truth, restated by the cast, is `ServicesOf<Groups>`,
  which `execute` declares and the caller provides; and
  `ToolExecution.decide` is an `Effect.fn` whose generic requirement
  collapses to `unknown` under code mode's instantiation — the truth is the
  policy's own `R`, its only requirement-carrying input;
* **satisfying an unreduced conditional return type** (`Agent.ts`'s
  `withExecutionPlan`, the one `as never` in `src/`). The signature states the
  plan/error compatibility check as a conditional on the *return* type, so with
  the type parameter still unresolved the compiler cannot reduce it and accepts
  nothing but `never`. Stating it as a constraint on the parameter was tried
  first and is worse: it destroys the inference that makes
  `ExecutionPlan.make(...)` assignable, and buries the diagnostic inside the
  plan's type instead of putting the message at the call site;
* **widening an error channel to cross an `Activity` boundary**
  (`DurableModel.ts:129`), where a workflow activity's `execute` must be typed
  against the schema the journal declares, and the underlying effect's error is
  the caller's own `E`.

Adding another needs a reason of that kind, and `test/Casts.test.ts` will ask
for it.

### One erasure that is not a cast

`Permission.ProjectionKey` is `Context.Service<ProjectionKey, Projection<any>>`
(`src/Permission.ts`). The `any` is in *type* position, so it is not a cast and
`test/Casts.test.ts` cannot see it -- which is why it is written down here
instead.

It is a variance escape, and deliberate. `Projection<Params>.resource` is
`(params: Params) => string`, so under `strictFunctionTypes` a
`Projection<{ city: string }>` is not assignable to `Projection<unknown>`, while
`annotate` has to accept every tool's own parameter type. `Projection<never>`
accepts each concrete projection contravariantly, but `projectionOf` reads the
annotation back and would then need a cast of its own -- moving the hole rather
than closing it. The safety is at the edges: `annotate` types the projection
against `Tool.Parameters<T>` before it is stored, and the reader applies it to
that same tool's decoded parameters.

One entry that is **not** in that list, because it does not erase: returning the
caller's exact tool type from `Permission.annotate` is a plain `as T`. Effect
AI's `Tool.annotate` widens to the structural `Tool<Name, Config, R>` and the
annotation changes nothing about the type -- the projection is typed against
`Tool.Parameters<T>` before the cast, so a wrong resource function still fails
to compile.

### `Agent.make` does not grow new type parameters

`Agent.make` already carries nine (`Tools`, the loop's and transform's and
toolkit's `E`/`R`, `Bound`, `PR`); each cross-cutting concern that added one
brought the signature closer to unreadable. A new cross-cutting concern is a
**combinator**, not a tenth parameter: `withX` unions its own `E`/`R` onto the
definition, and the recommended authoring path is
`Agent.make({ toolkit, loop }).pipe(withPermission(p), withContextTransform(t))`
where the requirements accumulate through the pipe. `Config` stops growing for
the same reason. The object form of `make` stays for the common one-shot case;
it is not where new capability goes.

### Compiling is not proof

`any` compiles. When you change a public signature, assert that inference stayed
precise rather than assuming it. `examples/typed-agent.ts` is the reference: a
full typed agent written with no casts and no annotations, carrying
compile-time assertions that tool calls, results and the error channel are not
`any`.

When you add such an assertion, **break it once** to confirm it is enforced,
then restore it. An assertion that cannot fail proves nothing.

### Typed errors are part of the contract

A public function's error channel must name what can go wrong. `unknown` in an
error channel is a bug: it erases exactly the information Effect exists to
carry. `AgentSession.prompt` returns `PromptError<Tools>`, which includes each
tool's own declared failure type.

## Toolchain

The Effect language service is required, not optional:

```json
{ "compilerOptions": { "plugins": [{ "name": "@effect/language-service" }] } }
```

```bash
npx effect-language-service diagnostics --project tsconfig.json
```

It finds Effect-specific problems `tsc` cannot. A green typecheck is not
evidence that Effect is being used correctly — treat a non-empty diagnostic list
as a build failure. It must stay at zero.

## Effect usage

**Load the `effect-best-practices` skill before writing or reviewing Effect
code** (`Effect.Service`, `Schema.TaggedError`, `Layer` composition, atoms).
The bullets below are this repository's specifics; the skill is the baseline
they sit on, and the post-commit review checks the commit against both.

* Prefer an existing Effect primitive to an agent-specific invention. Fibers for
  cancellation, `Layer` for wiring, `Schedule` for retries, `Stream`/`PubSub`
  for events.
* Interruption is structured concurrency. There is no cancellation token.
* Anything that must survive a caller being interrupted belongs in
  `Effect.ensuring` — a lost race or a `timeout` is ordinary usage, not an edge
  case.
* State transitions that guard an invariant must be atomic. `SubscriptionRef.
  modify`, not read-then-write: correctness must not depend on where the runtime
  happens to yield.
* The model arrives through the environment. An `Agent` never names a provider.
* Use `Effect.fn("Module.operation")` as the **function definition**, taking the
  operation's real parameters — not as a wrapper around a zero-argument
  generator that is then invoked. Both trace; only the first carries argument
  capture and stack-trace information, and the language service flags the
  second. Never annotate the generator's return type to steer inference: it
  collapses the error and requirement channels to `unknown`.
* A generic type parameter is **not inferred through `Effect.fn`'s wrapper
  when it is itself a type parameter of the caller**; it falls to its
  default, silently. `AgentSession.prompt(session, input)` inside a helper
  generic over `Value` or `Input` returns `Result<Tools, string>`, not
  `Result<Tools, Value>`, and the error reads as a variance problem three
  calls away. Pass explicit type arguments at that call site
  (`prompt<Tools, E, Value, Input>(...)`). A direct call on a concrete
  session infers fine, and `test/AgentOutput.test.ts` pins that it does;
  this bit twice in one day while the defaults were `never`, which is
  assignable to everything and hid it.
* Annotate spans with `Effect.annotateCurrentSpan` inside the function.
* Errors are `Schema.TaggedError`. Define `message` as a **getter, never a
  schema field**: the error still reads well in logs and stack traces, but the
  string is derived, so it cannot drift from the fields it describes and never
  enters the encoded form. Decoding reconstructs the class, so the getter works
  on the far side of a boundary too. Entity ids are `Schema.brand`ed and
  namespaced
  (`@effect-harness/RunId`), so they carry a validator and a codec rather than a
  compile-time tag.
* Domain types express absence with `Option`, never `null` or `undefined`.
  Options records — the argument object describing what a caller may omit — keep
  optional properties, because that is how Effect's own APIs express arguments.
  A serialization boundary may project `Option` to `null`; that is the wire
  format's business, not the domain's.
* **A module-level layer constant is one instance under one memo map.**
  `Effect.provide(layer)` builds a layer in the fibre's inherited memo map,
  so providing the same `Layer` value again inside a scope that already
  provided it hands back the *same* built services -- right for sharing a
  pool, wrong for a counter that must be private. `Budget.layer` was handed
  to a delegated child that way and charged the parent. A fresh instance
  needs a fresh layer *value* (`Budget.fresh()` is the pattern: `Layer.effect`
  called anew), not a second `provide`. Any `Layer.effect` constant that
  closes over a `Ref` has this property.
* Tracing export is application wiring, never a harness dependency. v4 ships an
  OTLP exporter at `effect/unstable/observability`; `@effect/opentelemetry` is
  only for interop with an existing OTel SDK. See `examples/tracing.ts`.

## Testing

* Tests are deterministic. Synchronise with `Deferred`/latches, never sleeps.
* Synchronise on the event you actually mean. Waiting for "a run is active" and
  then interrupting is a race: the run becomes active slightly before it reaches
  the model. `FakeModel`'s `started` deferred exists for this.
* Assert exact event sequences, not that an event exists somewhere.
* Test code is user code: it obeys the no-casts rule too.
* Assert span structure. The trace nesting is the cheapest proof that execution
  is shaped the way the design claims.

## Portability

The library is portable across Effect-supported runtimes, and that is a
checked invariant, not a convention.

* Whenever code needs an operating-system or network capability, require the
  corresponding Effect platform service — `SqlClient`, `HttpServer`,
  `HttpClient`, `FileSystem`, `Path` — and let the application supply the
  concrete Layer. Never import `node:*`, `@effect/platform-node` (or `-bun`,
  `-deno`), or a concrete SQL driver from a portable module; never read
  `process.*` or use `Buffer`. Web-standard globals (`globalThis.crypto`,
  `TextEncoder`, `fetch`) are fine: every supported runtime has them.
* Three levels, with dependencies pointing one way only:

  ```
  host implementation  ->  capability-requiring  ->  portable/domain
  sandbox/local            durable SQL stores,       core, client, compaction,
  (Node)                   http, mcp, a2a, ...       testing, sandbox surface
  ```

  A genuine host implementation gets its own package entry
  (`affe-agent/sandbox/local`) and a line in `HOST_MODULES` in
  `scripts/verify-portability.mjs`, so importing a portable entry never loads
  it. A transport that merely *can* use a host facility (MCP over stdio)
  loads that facility on demand, inside the operation that needs it.
* Do not duplicate platform error hierarchies. Wrap a platform failure in an
  agent error only when the agent domain adds an invariant
  (`PermissionDeniedError` for a workspace escape is one; a generic
  `AgentFileReadError` would not be).
* `npm run lint:portability` checks the source; `npm run verify:package`
  imports every entry of the packed artifact under a resolution hook that
  refuses Node built-ins and resolves without the `node` export condition —
  the way Bun, Deno and edge runtimes would see the package.

## Identifiers that outlive a process

Every `_tag`, service key, brand, table default and persisted key prefix is
built from `src/internal/namespace.ts`, never spelled as a literal. The roots
there are frozen wire and storage identifiers, not the package name, and they
do not follow a rename (`docs/plan-two-decisions.md`, decision 1). A new
identifier is a new entry in `test/fixtures/namespace-manifest.json`, added
by hand; `test/Namespace.test.ts` fails on a literal outside the module and on
any difference between the manifest and what the code builds.

**Error classes are tagged bare** (`"AgentBusyError"`), as Effect's own are
(`HttpClientError`, `ParseError`, `SqlError`): the tag is what a caller
catches by, and a plain identifier is what Effect's ecosystem expects there.
Namespacing is for things named across parties -- service keys, brands,
peers, tables. The bare set is frozen too, in
`test/fixtures/error-tags-manifest.json`; a new error class is a new entry,
added by hand, and the same test fails on a tag that is not in either
manifest or is shared by two classes. The few namespaced error tags that
predate this rule stay as decision 1 froze them (`docs/plan-two-decisions.md`,
decision 3).

## Scope discipline

* No new exported concept until two independent features need it.
* Do not implement something the plan defers, and do not hide an unresolved
  policy decision behind an arbitrary default. Where a default is chosen,
  document the reasoning.
* If implementation reveals a contradiction in `PLAN.md`, document the exact
  conflict instead of working around it silently.

## Writing docs

**Guides state; plans argue.** A guide (`docs/guide-*.md`, the README) says
what happens, in declarative sentences, and links the plan that holds the
argument. A plan (`docs/plan-*.md`) weighs the options and records the
decision and its reasons. The ledger (`docs/remaining-work-closed.md`) records
what landed and what was found on the way. A sentence that argues in a guide
belongs in a plan; a sentence that only states in a plan is probably a guide's.
The test of a guide paragraph is that a reader who disagrees with the design
still learns exactly what the code does.

## Verifying

```
npm run typecheck          # src, test and examples, including the type assertions
npm run lint               # Effect language service diagnostics
npm run lint:portability   # no host coupling outside host modules
npm run verify:remaining-work  # every `verify:` claim in docs/remaining-work.md still holds
npm run verify:behavior-change # a fixture change carries a `Behavior-Change:` trailer
npm run verify:changelog       # CHANGELOG.md lists every such trailer since the last tag
npm test
```

All of these must pass (`npm run check` runs them). `verify:remaining-work` is
how the live list stays live: an entry that makes a claim about the code
carries a `verify:` line that falsifies it, and a stale claim fails the build
rather than misdirecting the next reader. The two after it are how a wire or
journal change reaches the changelog: the trailer is required by the fixture
it touched, and `npm run changelog:behavior-changes` regenerates the
changelog's block from the trailers. `examples/anthropic.ts` is typechecked but never executed — it
would make live billed requests.

## Reviewing

**Always review your code after committing.** A double check, on the commit you
just made: correctness, edge cases addressed, TypeScript DX, performance, anti
AI slop patterns, hardening, adherence to the `effect-best-practices` skill and the
"Effect usage" section above, and that the tests are robust, well designed,
correct, and will actually find bugs. Fix what it finds in a follow-up commit
rather than leaving it.

If you ever have an issue or suggestion with the design of the project, please
let me know.

There may be other agents working in this project. Try your best to work around
each other. If you need to communicate, leave messages in
[COLLABORATION.md](./COLLABORATION.md) — claim what you are touching, and delete
your entry when the work lands, because a stale claim is worse than no claim.

Three habits follow from that, because the working tree may hold someone else's
unfinished work:

* **stage your own paths** — `git add <specific files>`, never `git add -A`;
* **do not use `git stash` to get a clean baseline.** It moves everyone's
  changes, and a concurrent commit in that window makes `stash pop` refuse.
  Compare against a specific commit instead (`git diff <sha>`,
  `git show <sha>:<path>`);
* **a failure in a file you did not touch is probably not yours.** Check whether
  it fails at `HEAD` before spending time on it, and say so rather than fixing
  it silently — someone may be mid-edit.
