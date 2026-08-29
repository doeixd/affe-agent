# Research: code mode, and how opencode2 implements it

Research notes on "code mode" — giving the model one `execute` tool over a
confined interpreter instead of N tool definitions — with the primary source
being opencode's own implementation, which is Effect-native and therefore
directly transplantable.

- **Primary source:** `sst/opencode`, branch `dev`,
  `packages/codemode/` (the engine, ~200 KB of source) and
  `packages/opencode/src/tool/code-mode.ts` (the host adapter, ~330 lines).
- **Package:** `@opencode-ai/codemode` — "Effect-native confined code execution
  over explicit, schema-described tools". Private to their workspace, MIT,
  version 1.18.23. Dependencies: **`acorn` and `effect`. That is the whole
  list.**
- **Secondary source:** `UsefulSoftwareCo/executor` (3.3k stars, MIT, actively
  pushed) — an MCP gateway that treats code mode as *one surface among several*
  and takes the opposite position on several boundaries. Useful as a contrast,
  not as an implementation model.

---

## 1. What code mode is for

Four goals, stated plainly in `packages/codemode/codemode.md`:

- reduce model context consumed by large tool catalogs;
- avoid an agent round-trip between every *dependent* tool call;
- keep large intermediate results inside the program rather than in context;
- give generated code only the authority the host explicitly supplied.

The third is the one that is easy to miss and probably the most valuable. A
model that must `list_issues` → read 400 issues through its own context →
`get_issue` on three of them pays for all 400. A program that filters in-loop
returns three. Code mode is as much a *context* mechanism as a latency one.

Their own framing, worth keeping: **"CodeMode is an orchestration language, not
a general JavaScript runtime."** Every boundary below follows from that.

## 2. The engine

### The interpreter is theirs, and it is not a sandbox in the OS sense

The pipeline is:

```text
TypeScript source from the model
  -> TS syntax transpiled away
  -> acorn parses the resulting JavaScript
  -> an owned tree-walking interpreter evaluates the AST, without eval
```

`src/interpreter/runtime.ts` is **141 KB**; `src/interpreter/model.ts` defines
the AST/binding/`StatementResult` types and a `CodeModeFunction` class. There is
no V8 isolate, no QuickJS, no worker, no subprocess. Confinement is by
*construction* — the interpreter simply has no node type that reaches a host
global — rather than by a membrane around a real engine.

Their stated rationale: "The product need is bounded tool orchestration, not
arbitrary JavaScript. Owning the language surface keeps authority and behavior
explicit."

The cost is that they had to hand-write a large and surprisingly complete
JavaScript subset, and the README spends thousands of words specifying exactly
which JS semantics they matched and which they deliberately diverged from.

### The language subset

Supported: data literals, destructuring, `if`/`switch`/`for`/`for...of`/
`for...in`/`while`/`do...while`, arrow and declared functions with closures and
rest/defaults, optional chaining, nullish coalescing, templates, spread,
`try`/`catch`, `throw`, real `Error` subclasses with working `instanceof`,
`Date`, `RegExp` (with `lastIndex` statefulness and function replacers that may
`await` tool calls), `Map`, `Set`, `URL`/`URLSearchParams`, and a curated
`Object`/`Math`/`JSON`/array/string/number stdlib (`src/stdlib/`, twelve small
files).

Not supported: `eval`, imports, modules, classes, generators, timers, host
globals, prototype mutation, `new Promise`, and `.then`/`.catch`/`.finally`
(`await` + `try`/`catch` is the only supported style).

Several deliberate divergences from real JS are the interesting part, because
each one trades fidelity for a model-friendlier failure:

- `Map`/`Set`/array `keys`/`values`/`entries` return **arrays, not iterators** —
  one convention, spreadable, no iterator protocol to implement.
- `for...in` over a Map or Set is an **error that suggests `for...of`**, rather
  than JS's genuinely surprising zero iterations.
- `Object.values(tools)` **fails with a pointer at `Object.keys(tools)` and
  `tools.$codemode.search`**.
- An un-awaited promise reaching a result or tool argument produces a
  **diagnostic that says to await it**, instead of serializing to `{}`.

The pattern: where real JS would silently do something useless, they raise a
catchable error whose message is the fix. Same philosophy as their tool errors.

### Concurrency is Effect fibers

`tools.ns.tool(...)` **starts eagerly on a supervised fiber** and returns a
run-once promise value. `Promise.all` / `allSettled` / `race` work over mixed
arrays; `race` interrupts its losers. At most **8 tool calls run concurrently**
(a fixed constant, explicitly not part of the public contract). Un-awaited calls
are drained before the program completes, and a failure from a never-awaited
call becomes an unhandled-rejection diagnostic.

The interpreter **yields cooperatively between steps**, so a configured timeout
interrupts `while (true) {}` — there is no separate work/step budget.

### The tool contract

```ts
Tool.make({
  description,
  input,          // validating Effect Schema OR render-only JSON Schema
  output,         // optional, same choice
  run: (input) => Effect<encodedOutput, unknown, R>
})
```

The dual schema type is the load-bearing design decision for anyone wiring MCP
in: **Effect Schema validates; JSON Schema only renders the signature.** MCP
tool definitions arrive as JSON Schema, so they go in as-is, shape the
model-visible TypeScript signature, and pass values through unvalidated — while
still crossing the plain-data boundary. No schema conversion layer, no lossy
JSON-Schema-to-Effect-Schema translation.

`CodeMode.make` / `execute` are generic over the tool tree and **do not erase
the tools' `R`** — `Services<Tools>` propagates the union of tool requirements
into the execution's environment. That is the Effect-native part that matters.

### Results are data, not failures

```ts
type Result = Success | Failure
// Success: { ok: true, value, logs?, truncated?, toolCalls }
// Failure: { ok: false, error: Diagnostic, logs?, truncated?, toolCalls }
```

Ten diagnostic kinds: `ParseError`, `UnsupportedSyntax`, `UnknownTool`,
`InvalidToolInput`, `InvalidToolOutput`, `InvalidDataValue`,
`ToolCallLimitExceeded`, `TimeoutExceeded`, `ToolFailure`, `ExecutionFailure`.
Each carries `message`, optional source `location`, and optional `suggestions`.

`toolCalls` is retained **on failure**, so a host can audit partial execution.

The two laws worth stealing verbatim:

- **Unknown host failures never become model-visible diagnostics.** `toolError`
  is the explicit safe-message channel; its optional `cause` is never returned.
- **Host interruption remains interruption**, not a `Failure`.

### Limits: three knobs, no defaults

`timeoutMs`, `maxToolCalls`, `maxOutputBytes` — all absent by default, on
purpose: "execution budgets are host policy, not library policy." A host that
can interrupt the fiber (as opencode does on cancel) needs no timeout; a host
with its own output truncation needs no `maxOutputBytes`. Invalid values throw
`RangeError` at construction, not at execution.

Exceeding `maxOutputBytes` never fails the run: the value is replaced by
truncated text plus a marker, logs are kept from the start until the budget runs
out, and `truncated: true` is set.

### Discovery — the part most implementations get wrong

Code mode's whole premise is that a large catalog should not sit in the prompt,
which is only true if the model can still *find* tools. Their answer:

- A **token-budgeted catalog** (default 2000 tokens, `chars/4`, the same
  heuristic opencode uses elsewhere).
- **Every namespace is always listed with its tool count**, regardless of
  budget. Only full signatures are budgeted.
- Signature selection is **round-robin across namespaces**: each round, every
  namespace with un-inlined tools tries to place its next-cheapest signature; a
  namespace whose next signature doesn't fit drops out while others continue. So
  every namespace gets some representation before any gets everything.
- The instructions **state their own completeness**: `COMPLETE list` vs
  `PARTIAL - N of M shown`, and per namespace `(3 tools, 1 shown)`.
- `tools.$codemode.search` is **always registered even when the catalog is fully
  inlined**, so a speculative search call never fails as an unknown tool — but
  it is only *advertised* when the catalog is partial.

Search is deterministic additive field-weighted scoring — exact path or path
segment 20, path substring 8, description substring 4, searchable-text substring
2 — with camelCase tokenization, naive singular variants (`issues` matches
`issue`), input property names and their descriptions included in the searchable
text, and offset/limit pagination whose `next` spreads back into the original
request. Results carry the **same generated TypeScript signature** as the inline
catalog, so no second lookup is needed. No embeddings, no model call.

Signatures are JSDoc-annotated, with constraints TypeScript can't express riding
along as tags:

```ts
tools.github.list_issues(input: {
  /** Repository owner */
  owner: string,
  /**
   * Results per page
   * @default 30
   */
  perPage?: number,
}): Promise<unknown>
```

Paths render as usable JavaScript expressions — `tools.orders.lookup`, or
`tools.context7["resolve-library-id"]` for non-identifier segments.

### There is also an OpenAPI adapter

`OpenAPI.fromSpec` turns an OpenAPI 3.x document into a tool subtree, one tool
per operation, dotted `operationId`s becoming namespaces. Its governing rule is
the same one their tool docs state everywhere: **skip what you cannot represent
accurately** — unsupported encodings, non-JSON bodies, binary and streaming
responses land in `skipped` rather than producing a broken tool. Auth is
resolved host-side and never model-visible.

## 3. The opencode host adapter

`packages/opencode/src/tool/code-mode.ts` is the whole integration, and it is
small. What it does that the engine deliberately does not:

- **Names the tool `execute`**, description: "Run a confined orchestration
  script with access to connected MCP tools." One parameter: `code: string`.
- **Builds the tool tree from MCP servers only.** `groupByServer` splits
  opencode's flat `server_toolname` keys back into `server.toolname` namespaces
  by longest-prefix match against the known server list. Native opencode tools
  (`edit`, `read`, `bash`) stay **direct** and are explicitly *not* ambient
  globals inside code mode.
- **Applies permission visibility first**: `Permission.visibleTools(tools,
  Permission.merge(agent.permission, session.permission))`. Catalog visibility
  is filtered *before* the tree is built — and their docs are careful that
  "catalog visibility is not execution authorization".
- **Asks for permission per nested call**, inside `invokeChildTool`, via
  `ctx.ask({ permission: entry.key, patterns: ["*"], always: ["*"] })`.
- **Runs plugin hooks per nested call** — `tool.execute.before` /
  `tool.execute.after` — and opens a `Tool.execute` span per child with tool
  name, call id, session id, message id. Child call ids are
  `${parentCallID}/${n}`.
- **Streams live progress to the TUI** through `onToolCallStart` /
  `onToolCallEnd`, maintaining a `CallEntry[]` of
  `{ tool, status: running|completed|error, input? }` and republishing metadata
  on every transition.
- **Projects MCP `CallToolResult` into plain data** (`projectMcpResult`):
  `structuredContent` wins if present, else joined text; image/audio/blob
  resources are **pulled out as host-side attachments** on the outer result and
  the program sees only `"[2 images attached to the result]"`; `resource_link`
  becomes text because a link is a reference, not fetchable media.
- **Races execution against the abort signal**, and maps
  `Cause.hasInterruptsOnly` back to `Effect.interrupt` rather than to a
  diagnostic.
- **Sets no limits at all** — no timeout, no `maxToolCalls` — relying on user
  cancel interrupting the outer fiber and on core's existing output-retention
  policy.

Design notes that go with it (`codemode.md`):

- `execute` is **the** model-facing invocation boundary. Nested calls reuse its
  context, do not independently bound model output, and do not get durable
  child-call identities — which is what keeps complete intermediate values
  available for in-program filtering. The outer settlement is the single
  output-bounding point.
- MCP tools are registered as **grouped, deferred** tools; core materializes one
  `execute` tool when visible deferred tools exist. Grouping is what preserves
  namespaces instead of flattened names.
- Each nested call re-checks that its captured registration is still current
  before dispatching.

## 4. Executor, as a contrast

`UsefulSoftwareCo/executor` is a different animal — an MCP gateway that
aggregates MCP/OpenAPI/GraphQL/Google Discovery integrations behind one catalog
with per-tool policy and shared credentials — but it takes explicit positions on
the same questions, and it disagrees in three places worth noting.

Its own framing is the first one: **"It is not code-mode-specific. Code mode is
one way to call tools; it isn't the point."** Its default MCP surface is a set
of meta-tools — `search` + `describe` + `execute` + `run_code` — so code mode is
*one of four*, with a direct-tools opt-out.

| question | opencode codemode | executor |
| --- | --- | --- |
| confinement | owned tree-walking interpreter, no engine | V8 isolate locally, Cloudflare Dynamic Worker in cloud, plus quickjs / deno-subprocess runtimes |
| approval | non-goal; host's job | first-class: MCP elicitation, a gated `resume` tool, a resume URL, or an MCP channel talking back mid-call |
| durable pause/resume | explicit non-goal | first-class: every execution is a `Run` record; a gated call returns a *pending* Run with a resume reference |
| credentials | host's job, never in the sandbox | same conclusion — behind a tool-proxy, "no escape hatch" |
| authority | confined to the supplied tool tree | a `scope()`-narrowed executor as a capability membrane that strictly intersects and never widens |

Executor's `Run` record is the idea most worth borrowing conceptually: one
record that "collapses four features into views over it — audit log,
human-in-the-loop approvals, workflow runs, and resumability/debugging."

Note the honest caveat: an isolate or Worker is a *stronger* boundary than a
tree-walking interpreter for arbitrary code, but it is also a much bigger
operational dependency, and it does not by itself restrict *authority* — both
projects still end up saying the tool tree is the only authority that exists.

## 5. How this would fit effect-agent

Code mode is about the **outbound** half of `/mcp` — `McpToolkit.bind` /
`bindDiscovered` handing an agent many tools — and is orthogonal to
`docs/plan-mcp-frontend.md`, which is the inbound half. The two do not collide;
`/plugins` loading an Agent Plugins package over `/skills` + `/mcp` is the case
that most needs it.

Four pieces already exist and would carry most of the design:

- **`Toolkit` is already the universal tool container.** Code mode needs a tree
  of schema-described tools; a `Toolkit.WithHandler` is exactly that, minus the
  namespacing.
- **`Tool.dynamic`'s JSON-Schema mode is codemode's "render-only schema".**
  `bindDiscovered` already builds tools whose parameters are the server's raw
  JSON Schema (`McpToolkit.ts:180`). No conversion layer is needed for the same
  reason opencode needs none.
- **`Elicitation`** is the approval channel codemode declares a non-goal and
  executor makes first-class.
- **`/sandbox`** already owns "confined execution with declared authority" for
  argv, with a `SandboxProvider` seam and host implementations behind their own
  entry point.

### 5.1 The decision that is actually forced: an owned interpreter

Reaching for `node:vm`, `isolated-vm` or a QuickJS build would be the obvious
shortcut and **this repo cannot take it in portable source**.
`scripts/verify-portability.mjs` rejects `node:*` imports, bare Node built-ins,
and host globals in every module except a short explicit list — currently just
`sandbox/local.ts`. An engine-backed interpreter would have to live behind its
own package entry, be unavailable on every non-Node runtime, and make code mode
a host-coupled feature rather than a portable one.

A tree-walking interpreter over `acorn` is pure portable JavaScript. So the
constraint that makes opencode's choice look expensive in the abstract makes it
the *only* choice here — which is a good outcome, because it is also the choice
that keeps authority explicit.

`acorn` would be a new runtime dependency (~120 KB, no transitive deps, MIT).
That is the cost line, and it belongs in an optional export so the core entry
never pulls it.

### 5.2 Shape

A new `/code` module, exported as `@doeixd/effect-agent/code`, with the engine
split from the agent-facing tool:

```text
src/code/
  CodeMode.ts        make / execute / Result / Diagnostic  (the host API)
  CodeTool.ts        the model-facing `execute` tool over a Toolkit
  Catalog.ts         signatures, budgeted catalog, search
  internal/
    parse.ts         acorn + the TS-syntax strip
    interpret.ts     the tree-walking evaluator
    data.ts          the plain-data boundary
    stdlib/          the curated globals
```

The engine takes a **toolkit and a namespacing**, not an MCP connection:

```ts
const runtime = CodeMode.make({
  tools: { github: githubToolkit, linear: linearToolkit },
  limits: { maxToolCalls: 40 }
})
```

This is the one place worth diverging from opencode outright. They reconstruct
namespaces by longest-prefix-matching `server_toolname` strings against a server
list (`groupByServer` in `code-mode.ts`) because the names were flattened
earlier in their pipeline. Here the grouping is given, so the heuristic — and
its collision failure mode — never exists. It also means code mode works over
*any* toolkit: MCP-bound, local, `/coding`, `/web`, plugin-loaded.

Tool `R` propagates rather than being erased, exactly as in their
`Services<Tools>`. Per `AGENTS.md`, the whole thing has to infer without a cast
at the call site, and the example carries a compile-time assertion proving the
program's tool set is not `any`.

### 5.3 What we would do that neither project does

**Nested calls raise elicitations.** Codemode calls approval a non-goal.
Executor *does* do this — see §6.5; a nested call inside a running program can
raise an MCP elicitation, and a decline throws into the sandbox. So this is not
novel, it is proven, and the design to copy already exists.

What nobody does is **durable** suspension: executor's approval blocks a live
QuickJS context, and its `resume` restarts at the Run level rather than
reviving a half-executed program. Here `Elicitation` is a `DurableDeferred`
under `/durable`, so a program paused mid-run for a human could in principle
survive the process. That is the genuinely novel piece and also the riskiest —
an interpreter whose state can be suspended across a process boundary is a much
stronger claim than one that merely runs to completion. It should be
**explicitly out of scope for a first version** and stated as a design target,
not a promise.

**Nested calls are agent events.** `onToolCallStart`/`onToolCallEnd` become
`AgentEvent` envelopes rather than a bespoke callback pair, so `apps/tui`,
`/observability`, `/export` and the MCP frontend's event resource all see nested
calls for free. Opencode pipes these straight into TUI metadata; here the event
log already exists and is the right destination.

**Permission runs per nested call, from the existing annotation.**
`Permission.annotate` already projects a tool's parameters into a permission
resource. A nested call inside a program is still a tool call and answers to the
same policy — which is what stops code mode from becoming a permission bypass,
the failure mode that matters most.

### 5.4 Sequence, and where the value actually is

The interpreter is the biggest piece and the *last* one that pays off. The
ordering below front-loads the parts that are useful on their own.

1. **Catalog and signatures** (`Catalog.ts`), with no interpreter at all.
   Generating JSDoc-annotated TypeScript signatures from a toolkit, the
   round-robin budgeted catalog, and deterministic search are independently
   useful — they are the fix for prompt bloat whether or not a program ever
   runs, and `bindDiscovered` over a large plugin set needs them today.
2. **The data boundary** (`internal/data.ts`): depth limit, blocked prototype
   members, Date/URL serialization, the "promises never cross" rule. Small,
   testable in isolation, and the source of silent corruption if deferred.
3. **A minimal interpreter**: literals, member access, destructuring, `if`,
   `for...of`, `while`, arrow functions, `await`, `try`/`catch`, `throw`,
   `Promise.all`, and array/object/string basics. **No** RegExp, Map/Set, URL,
   or Date in v1 — each is a self-contained addition later, and their absence is
   an `UnsupportedSyntax` diagnostic that names the missing feature rather than
   a wrong answer.
4. **The `execute` tool** over `/mcp`-bound toolkits, with per-call permission
   and events.
5. **Limits**: `timeoutMs`, `maxToolCalls`, `maxOutputBytes`, no defaults, for
   the reason they give — budgets are host policy. This repo has cancellation
   through the session already, so the timeout is genuinely optional.
6. **Elicitation inside programs**, then durability, as separate work with its
   own plan.

A v1 that stops after step 4 is a real feature. A v1 that starts at step 3 is
six weeks before anything is usable.

### 5.5 Invariants

1. **The engine confines a program to the supplied tools and decides nothing
   about what those tools may do.** Authority is chosen by the host, per tool,
   before the program runs. Their formulation is the right one to quote in the
   source: *"Do not expose a broad tool and expect the prompt to restrict it."*
2. **A nested call is a tool call.** Same permission policy, same events, same
   redaction. Code mode must never be a cheaper path to a tool than calling it
   directly.
3. **Program failures are data; host interruption stays interruption.** A
   `Result` is returned, not failed; `Effect` interruption propagates.
4. **Unknown host failures are never model-visible.** One explicit safe-message
   channel, and its cause never crosses.
5. **Portable source only.** No `node:*`, no host globals — enforced by
   `lint:portability`, which is what makes the owned interpreter mandatory
   rather than merely preferable.
6. **Every diagnostic names the fix.** The interpreter's value over a real
   engine is that it can say "use `for...of`" instead of iterating zero times. A
   diagnostic that only reports a failure has thrown away the reason for owning
   the language.
7. **No casts at the call site**, including in tests, and an example that
   asserts inference is precise.

### 5.6 Open questions

- **Does `Toolkit` carry enough description metadata** to generate good
  signatures, or does the catalog need per-field descriptions that `Tool.make`
  callers do not currently supply? Opencode leans hard on Effect Schema
  `.annotate({ description })` per field; if this repo's tools do not annotate,
  the generated signatures will be accurate and useless.
- **Where does streaming output go?** A long program produces no visible
  progress today. Their answer is a metadata republish per nested call; the
  event log is the better answer here, but the *agent* still sees one tool
  result at the end.
- **Should `execute` replace the direct tools or sit beside them?** Opencode
  defers MCP tools into code mode while keeping native tools direct. That split
  looks right, but it is a policy decision that belongs to the application, not
  to `/code`.
- **`acorn` as a dependency.** Worth checking whether the TS-syntax strip can be
  avoided entirely by telling the model to write plain JavaScript — opencode
  transpiles because models emit TypeScript unprompted, which may simply be
  true and unfixable by prompting.

## 6. How executor implements it

Read after §4's summary table. Everything below is from the source, branch
`main`, read 2026-08-27.

### 6.1 A contract package with swappable engines

Where opencode owns one interpreter, executor owns a **contract** —
`@executor-js/codemode-core` (`packages/kernel/core/`, ~11 small files) — and
four independent engines behind it:

```text
packages/kernel/
  core/                       the contract: CodeExecutor, SandboxToolInvoker, Tool
  ir/                         serialization
  runtime-quickjs/            QuickJS via quickjs-emscripten (the reference)
  runtime-dynamic-worker/     Cloudflare Dynamic Workers (the cloud path)
  runtime-workerd-subprocess/ workerd as a local subprocess
  runtime-deno-subprocess/    deno as a local subprocess
```

The contract is two interfaces and a result type:

```ts
interface SandboxToolInvoker {
  invoke(input: { path: string; args: unknown }): Effect.Effect<unknown, unknown, never>
}

interface CodeExecutor<E extends Cause.YieldableError = CodeExecutionError> {
  execute(code: string, toolInvoker: SandboxToolInvoker): Effect.Effect<ExecuteResult, E>
  readonly timeoutMs?: number
}
```

Two details in that signature are deliberate and worth noting. The error channel
is constrained to `Cause.YieldableError` so a runtime can parameterize with its
own `Data.TaggedError` subclass but can never return untyped `unknown`. And
`timeoutMs` is **exposed so the host can build an outer backstop** — "for the
case where the in-sandbox timer itself is defeated by a wedged isolate." There
is a `wedge-repro.test.ts` in the dynamic-worker package; this is a bug they hit.

Schemas are **Standard Schema** (`@standard-schema/spec`), not Effect Schema —
an interop choice that lets zod/valibot/arktype/effect all describe a tool. The
Effect dependency is for the effect layer, not the schema layer.

### 6.2 The sandbox surface: a lazy proxy, not a materialized catalog

`runtime-quickjs/src/index.ts` builds one source string and evaluates it. The
interesting parts of that preamble:

**`tools` is a recursive `Proxy` over a function.** Any dotted path is
constructible and callable; nothing is enumerated and no catalog exists inside
the sandbox at all:

```js
const __makeToolsProxy = (path = []) => new Proxy(() => undefined, {
  get(_t, prop) {
    if (prop === 'then' || typeof prop === 'symbol') return undefined
    return __makeToolsProxy([...path, String(prop)])
  },
  ownKeys() { throw __toolsEnumerationError(path) },
  apply(_t, _this, args) {
    return Promise.resolve(__invokeTool(path.join('.'), args[0]))
      .then((raw) => raw === undefined ? undefined : JSON.parse(raw))
  },
})
```

Three details earn their place. `then` returns `undefined` so `await tools.x`
does not treat the proxy as a thenable. `ownKeys` **throws a message naming the
fix** — "is a lazy proxy and cannot be enumerated. Use `tools.search({ query:
"..." })` …" — which is the same instinct as opencode's `Object.values(tools)`
error, arrived at independently. And values cross the boundary as **JSON
strings**, parsed on the sandbox side.

**The bridges are captured and then deleted.** `__executor_invokeTool` and
`__executor_log` are copied into consts and `delete globalThis.…`'d before user
code runs, so a program cannot reach the raw bridge.

**`fetch` is defined to throw** — `"fetch is disabled in QuickJS executor"` —
rather than merely being absent, so the failure names the policy.

**`emit(value)` is a user-visible output channel.** It structurally recognizes
`ToolFile` and MCP content blocks (text/image/audio/resource/resource_link) and
stringifies anything else into a text block. This is exactly the `output.*`
channel opencode's `AGENTS.md` records as *removed from v1* and possibly
returning — the two projects diverge on whether a program may address the user's
conversation directly.

### 6.3 Timeouts, limits, and the clock that pauses

QuickJS gets `setMemoryLimit` (64 MB default), `setMaxStackSize` (1 MB) and an
interrupt handler polling a deadline. The default timeout is **five minutes**,
with a comment explaining why: large OpenAPI specs are slow to parse *inside*
QuickJS.

The deadline tracker is the clever bit:

```ts
deadlineMs: () => (inFlight > 0 ? null : Math.max(start, lastReturnedAt) + timeoutMs)
```

While any tool dispatch is in flight the deadline is `null` — **the clock stops
during tool waits and resumes when the last one returns.** So the timeout bounds
*interpreter* time, not the wall-clock of the program including its I/O. That is
a materially different meaning from opencode's `timeoutMs`, which is wall-clock
and interrupts in-flight tool Effects. Neither is wrong; they answer different
questions ("is this program looping?" vs "has this taken too long?").

Async is drained manually: `runtime.executePendingJobs()` in a loop interleaved
with waiting on the host-side deferreds, re-checking the deadline each pass.

### 6.4 They recover the model's code instead of rejecting it

This is the feature opencode has no counterpart to, and it is a direct response
to what models actually emit. `kernel/core/src/code-recovery.ts` babel-parses
the submission and unwraps, in order:

- a fenced ```` ``` ```` code block, if the whole thing is one;
- `export default function foo() {…}` → append `return await foo()`;
- `export default async () => {…}` → wrap and invoke, with a
  `typeof __fn !== "function"` guard that throws "Code must evaluate to a
  function";
- `TSAsExpression` / `TSSatisfiesExpression` / `TSNonNullExpression` /
  parenthesized wrappers, unwrapped recursively.

Then `strip-types.ts` removes TypeScript syntax with **sucrase**
(`transforms: ["typescript"], disableESTransforms: true`). Its comment names the
symptom that motivated it: the `execute` description tells callers to write
TypeScript and `describe` hands them TypeScript shapes, so without stripping "a
single `: number` annotation throws `Unexpected token ':'` inside the sandbox,
which used to surface as a 180s client-side timeout." They explicitly refuse to
fall back to the raw input on a parse failure — "a clean error here for an opaque
one downstream" is the trade they decline.

Both projects therefore transpile TypeScript away. Opencode does it silently;
executor also normalizes the *shape* of the submission. That second half is
worth copying regardless of which engine one picks.

### 6.5 Tool results are a union, and approval throws

`makeExecutorToolInvoker` (`packages/core/execution/src/tool-invoker.ts`) bridges
sandbox paths to `executor.execute(address, args)`. What it hands back is not
raw data:

```ts
{ ok: true; data: T; http?: { status; headers } } | { ok: false; error: ToolError }
//                     ToolError = { code, message, status?, details?, retryable? }
```

So an **expected** tool failure is a value the program can branch on, not a
throw — the opposite of opencode, where a tool failure is catchable and becomes
a `ToolFailure` diagnostic. HTTP metadata rides beside the payload rather than
wrapping it, "so callers can read pagination/rate-limit headers without the
payload being wrapped in an envelope."

Three failure classes are kept distinct, and the distinctions are the design:

- **Expected failure** → `ToolResult.fail(...)`, i.e. `ok: false`. Includes
  `tool_not_found` (with **suggestions**, capped at 5), `tool_blocked`
  ("Tool blocked by policy: …"), `invalid_tool_arguments` (with schema issues),
  and credential/reauth failures.
- **Approval declined** → **throws** into the sandbox:
  `Tool "x.y.z" requires approval but the request was declined by the user.`
  This is MCP elicitation raised from inside a nested call of a *running*
  program. A declined approval is deliberately not an `ok: false` the program
  can shrug off and route around.
- **Anything else** → an infra/plugin defect: the sandbox sees
  `Internal tool error [<correlationId>]` and the full cause is logged under the
  same id. The comment names what it is protecting against — "URLs with tokens,
  DB connection strings, file paths in stacks."

Same conclusion as opencode's `toolError`, reached with more machinery: the
model-visible channel is explicit and narrow, and unknown host failures never
cross it. Executor adds the correlation id, which is the piece opencode lacks
and which anyone running this in production will want.

Telemetry gets a separate enumerable `ExecuteErrorKind`
(`syntax_error | type_error | reference_error | range_error | tool_error |
timeout | resource_limit | serialization_error | thrown`), classified from the
thrown error's `name`, explicitly "beside the descriptive `error` string so
telemetry can count failure classes as identifiers without ever recording
message content."

Signatures also carry an `/* observed; may be incomplete */` marker on types
inferred from observed responses rather than from a declared schema — an honesty
device opencode does not need because it always has a schema.

### 6.6 Discovery: no catalog at all

Executor's answer to prompt bloat is the opposite of opencode's budgeted
catalog. `buildExecuteDescription` produces:

1. `"Execute TypeScript in a sandboxed runtime."`
2. `` Before writing code, call `skills({ name: "execute" })` for the workflow. ``
3. `## Available integrations` — the connected integration **slugs only**,
   deduped, sorted, capped at 50 with a `... N more` overflow line.

No signatures, no tool names, no descriptions. The model gets namespaces, a
pointer to a skill holding the how-to, and `tools.search(...)` at runtime inside
the sandbox. The inventory is parsed back out of the built description
(`parseIntegrationInventory`) rather than re-queried, explicitly so a second
`connections.list()` "could disagree with what the model reads."

The trade against opencode: executor spends near-zero prompt tokens and pays a
round trip whenever the model must search; opencode spends ~2000 tokens to make
the common case a direct call. Opencode's is better for a fixed medium catalog;
executor's is better for a gateway fronting hundreds of integrations, which is
what it is.

### 6.7 The narrowed grammar for untrusted callers

Worth reading even though it is not code mode proper.
`hosts/mcp/src/tool-call-code.ts` handles `execute-action`, the channel a
rendered UI artifact uses to reach an integration. It used to accept arbitrary
code — the same surface as `execute`. They narrowed it to one regex-checked
grammar:

```text
return await tools.<ident>("<role>")?(.<ident>)*(<JSON>)
```

One awaited call, one JSON-literal argument, no statements, no loops. And the
server **never executes the string the iframe sent**: it parses it into a path,
rewrites that path through the artifact's stored bindings, and re-emits resolved
source itself. A pinned test keeps the producing proxy and this parser in sync.

The principle generalizes past their architecture: *the surface a caller needs
is often far narrower than the surface it was given, and "wider than necessary
is also wider than safe."* Any code-mode implementation that later grows a
second, less-trusted caller should expect to need this.

### 6.8 Summary of the divergences

| | opencode codemode | executor |
| --- | --- | --- |
| engine | owned tree-walking interpreter over acorn | QuickJS / Cloudflare Dynamic Worker / workerd / deno, behind one `CodeExecutor` contract |
| schemas | Effect Schema (validating) or JSON Schema (render-only) | Standard Schema |
| tool surface | materialized tool tree, unknown paths are `UnknownTool` | lazy recursive `Proxy`, any path callable, resolved host-side |
| discovery | budgeted round-robin catalog + `$codemode.search` | integration slugs only + a skill + runtime `tools.search` |
| tool failure | catchable error / `ToolFailure` diagnostic | `{ ok: false, error }` union value |
| approval | non-goal | MCP elicitation mid-program; decline **throws** |
| timeout | wall-clock, interrupts in-flight tool Effects | interpreter-time; **clock pauses during tool dispatch** |
| bad model output | `ParseError` / `UnsupportedSyntax` | babel-based recovery of fences, `export default`, arrows, then sucrase |
| defect hygiene | sanitized, `toolError` is the safe channel | same, plus correlation id + enumerable `ExecuteErrorKind` for telemetry |
| user-visible output | files collected host-side; program sees structured data only | in-sandbox `emit()` for `ToolFile` and MCP content blocks |

### 6.9 What this changes for §5

Three amendments to the proposal above, now that the second implementation is in
view:

1. **The `CodeExecutor` seam is worth having even with one engine.** Executor's
   contract is two interfaces, and it bought them four runtimes. Splitting
   `/code`'s engine behind an interface costs almost nothing at v1 and is what
   would later allow a `node:vm` or QuickJS engine behind its own package entry
   — the same shape `SandboxProvider` and `sandbox/local.ts` already have here.
   The owned interpreter stays the portable default; it stops being the only
   possibility.
2. **Code recovery belongs in v1.** Both projects transpile TypeScript;
   executor's comment records a real 180-second failure caused by not doing so,
   and its shape-recovery (fenced blocks, `export default`, bare arrow) is
   cheap and independent of the engine. Rejecting a model's first attempt
   because it wrapped the answer in a code fence is a wasted turn.
3. **Decide the tool-failure shape deliberately, and early.** `ok: false` union
   versus catchable throw is not cosmetic: it decides whether a program's happy
   path can ignore failures, and it is very hard to change later. Executor's
   split — expected failures are values, declined approvals throw, defects are
   opaque — is the most defensible of the three positions, and it maps cleanly
   onto this repo's existing distinction between a tool's declared failure type
   and an `AiError`.

## Sources

- [sst/opencode](https://github.com/sst/opencode) — `packages/codemode/`
  (`README.md`, `codemode.md`, `AGENTS.md`, `src/`) and
  `packages/opencode/src/tool/code-mode.ts`, branch `dev`, read 2026-08-27.
- [UsefulSoftwareCo/executor](https://github.com/UsefulSoftwareCo/executor) —
  `README.md`, `vision.md`, `packages/kernel/core/src/{types,error-kind,
  code-recovery,strip-types,validation}.ts`,
  `packages/kernel/runtime-quickjs/src/index.ts`,
  `packages/core/execution/src/{description,tool-invoker}.ts`,
  `packages/hosts/mcp/src/tool-call-code.ts`, branch `main`, read 2026-08-27.
- [Code Mode | TanStack AI Docs](https://tanstack.com/ai/latest/docs/code-mode/code-mode)
- [Code Mode | OpenClaw](https://docs.openclaw.ai/tools/code-mode)
- [OpenCode custom tools](https://opencode.ai/docs/custom-tools/)
