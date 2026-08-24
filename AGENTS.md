# Working in this repository

Effect Harness is an Effect-native agent execution kernel. `PLAN.md` is the
design authority; `STATUS.md` records what is built and why.

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
which routes around it. **Sixteen of those exist, in four files**, and they are
the list below. `test/Casts.test.ts` enforces it: adding one fails the build
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
* merging two handled toolkits by delegation (`mergeHandled`), because Effect
  AI composes toolkits before handlers are bound and a `WithHandler` is a
  closed value;
* **wrapping a service whose method types are closed** — `DurableModel` (5),
  `DurableToolkit` (3) and `TestLanguageModel` (4). Each replaces a method on a
  `LanguageModel.Service` or a `Toolkit.WithHandler` with one that journals,
  counts or replays around it. The value is the original's behaviour plus a
  wrapper; the type cannot say so, because Effect AI's service methods are
  declared with concrete signatures rather than a mappable shape. Confined to
  the wrapper's construction: everything the wrapper is *given* and everything
  it *returns* is typed;
* **widening an error channel to cross an `Activity` boundary**
  (`DurableModel.ts:129`), where a workflow activity's `execute` must be typed
  against the schema the journal declares, and the underlying effect's error is
  the caller's own `E`.

Adding another needs a reason of that kind, and `test/Casts.test.ts` will ask
for it.

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
  (`@doeixd/effect-agent/sandbox/local`) and a line in `HOST_MODULES` in
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

## Scope discipline

* No new exported concept until two independent features need it.
* Do not implement something the plan defers, and do not hide an unresolved
  policy decision behind an arbitrary default. Where a default is chosen,
  document the reasoning.
* If implementation reveals a contradiction in `PLAN.md`, document the exact
  conflict instead of working around it silently.

## Verifying

```
npm run typecheck          # src, test and examples, including the type assertions
npm run lint               # Effect language service diagnostics
npm run lint:portability   # no host coupling outside host modules
npm test
```

All four must pass (`npm run check` runs them). `examples/anthropic.ts` is typechecked but never executed — it
would make live billed requests.
