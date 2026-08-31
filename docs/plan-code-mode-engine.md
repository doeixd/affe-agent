# Plan: the code-mode engine

Drafted 2026-08-31, condensing `research-code-mode.md` §5–6 into decisions.
Step 1 (Catalog: signatures, budgeted catalog, search) landed the same day;
this plan covers §5.4 steps 2–6. The catalog is useful without any of this;
nothing below is needed to keep it.

## Decisions, made now so implementation does not re-litigate them

1. **The engine sits behind a `CodeExecutor` seam from day one** (§6.9.1).
   Two interfaces bought executor four runtimes; here it is what later
   allows a `node:vm` or QuickJS engine behind its own package entry — the
   `SandboxProvider` / `sandbox/local` shape this repo already has twice.
   The owned tree-walking interpreter is the portable default, not the only
   possibility.
2. **Tool-failure shape: executor's split** (§6.9.3, decided early because
   it is near-impossible to change later). A tool's *declared* failure is a
   value the program can branch on (`{ ok: false, error }`); a **declined
   approval throws** into the program (a policy refusal must not be
   ignorable on the happy path); an unknown host failure is **opaque** — a
   correlation id and a safe message, never the cause. This maps cleanly
   onto the existing distinction between a tool's declared failure type and
   an `AiError`.
3. **Code recovery is v1** (§6.9.2): strip fences, `export default` and a
   bare arrow before parsing; TS type syntax is stripped in step 4 by the
   parser, never by regex (see the step-3 row for why). Rejecting a
   model's first attempt because it wrapped the answer in a fence is a
   wasted turn, and executor has the 180-second production failure to
   prove it.
4. **Diagnostics name the fix** (invariant 6). The whole value of owning
   the language over embedding an engine is `UnsupportedSyntax: use
   for...of` instead of an iteration that silently runs zero times.
5. **A nested call is a tool call** (invariant 2): same `Permission`
   policy from the existing annotations, same `AgentEvent` envelopes (the
   event log is the streaming answer, §5.6), same redaction. Code mode must
   never be a cheaper path to a tool than calling it directly.
6. **Limits have no defaults** (`timeoutMs`, `maxToolCalls`,
   `maxOutputBytes`) — budgets are host policy, and cancellation already
   flows through the session.
7. **Elicitation inside programs is step 6; durable suspension is out of
   scope** for v1 and recorded as a design target only (§5.3): an
   interpreter whose state survives a process boundary is a far stronger
   claim than one that runs to completion. Step 6 landed 2026-08-31 with
   that boundary stated at the `elicitor` option: with a durable elicitor
   the workflow suspends and the program re-executes from the top on
   resume, so only journalled tool calls are replay-safe.
8. **Resolved 2026-08-31: acorn approved and pinned** (`acorn@8.18.0`,
   exact). The "faster" alternatives were considered and rejected: meriyah
   trades size for parse speed that is irrelevant on KB-sized model
   programs; oxc/swc are native binaries the portability gate forbids.
   Corollary decided with it: **v1 programs are plain JavaScript** — acorn
   does not parse TS, so TS syntax is a dedicated parse diagnostic
   ("write plain JavaScript…", heuristically detected) rather than a
   second dependency, answering §5.6's open question by prompting.

## Sequence

| Step | What | Depends on |
| --- | --- | --- |
| 2 | `internal/data.ts` — the plain-data boundary: depth bound, cycle refusal, blocked prototype members dropped, Date/URL serialised, promises and functions refused with the fix named | nothing |
| 3 | `internal/recover.ts` — fence/`export default`/bare-arrow recovery, pure string-to-string. TS-syntax stripping deliberately moved to step 4: without a parser, a regex stripper produces wrong programs that still run — the silent-corruption class step 2 exists to prevent — so until the parser lands, TS syntax is an `UnsupportedSyntax` diagnostic, not a guess | nothing |
| 4 | `internal/parse.ts` + `internal/interpret.ts` — acorn + the §5.4 minimal subset; every absence an `UnsupportedSyntax` naming the feature | acorn approval |
| 5 | ✅ 2026-08-31. `CodeMode.ts` (`make`/`execute` behind `CodeExecutor`; per-nested-call `ToolExecution.decide`, the executor failure split, limits, `CurrentPrincipal` on the calling fibre, an `onCall` hook) and `CodeTool.ts` (the model-facing `execute` tool: the budgeted catalog rides its description, nested calls surface as preliminary results the kernel already projects as `ToolCallProgress`, refusals reach the model as a `fix`). `tool` is an `Effect` for the same reason `Agent.toolkit` is: the handler must carry no requirement, so the policy's and handlers' services are discharged at build time | 2–4 |
| 6 | ✅ 2026-08-31. Elicitation inside programs: the host supplies the elicitor (usually its session's own, so the question lands in `session.pending`), an `Ask` pauses the program on a `tool-approval` request built from the tool's own projection, a grant proceeds and a **refusal throws** into the program. No elicitor means an `Ask` throws saying so -- fail-closed. The question reaches a renderer through the progress channel, since a handler cannot reach the event bus. Durable suspension of a paused program stays out of scope (decision 7) and is documented at the option | 5 |

## The data boundary's contract (step 2, implemented with this plan)

Everything that crosses between host and program — tool results in, tool
arguments and the final result out — passes `toData`:

- Own enumerable string-keyed members only; `__proto__`, `constructor` and
  `prototype` are dropped, so a crafted result cannot pollute a prototype
  on either side.
- Plain objects and arrays are rebuilt (no foreign prototypes cross);
  `Date` becomes its ISO string, `URL` its href, `Uint8Array` a copy;
  `undefined` in an array becomes `null`, an `undefined` property is
  dropped — JSON semantics, stated.
- A `Promise` is refused with "await it before it crosses"; a function
  with "return data, not behaviour"; a `Map`/`Set`/class instance with
  "use plain objects and arrays"; a cycle and the depth bound (default 64,
  host-overridable) are refused naming the path.
- Refusals are values (`Result`), not exceptions: the caller decides
  whether a violation is a diagnostic to the model or a defect.

## Hardening pass (2026-08-31, after step 6)

An audit of the finished engine against its own invariants, with each
finding proved by a failing test before it was fixed
(`test/CodeHardening.test.ts`).

Three real defects, all in the same class -- a model-written program
being able to do something to the *host* that it should only be able to
do to itself:

1. **A throwing host builtin was a defect, not a catchable error.**
   `JSON.parse("{oops")` inside a program failed the whole agent run,
   and the program could not even `try`/`catch` it. Native calls are now
   guarded and become `ProgramThrow`, carrying `{ name, message }` --
   plain data, never the thrown object with its stack. The message
   survives on purpose: it describes the program's own mistake, which is
   exactly what the model needs to fix it. A *handler* defect is a
   different thing and stays opaque.
2. **`maxOutputBytes` counted UTF-16 units.** A budget could be overrun
   threefold by non-ASCII text alone. It counts UTF-8 bytes now, as the
   name always claimed.
3. **`Promise.all` had unbounded tool-call concurrency.** One program
   could open as many upstream connections as it had array elements.
   `maxConcurrentCalls` bounds in-flight nested calls at the *host*
   boundary (a semaphore around the whole call, approval wait included),
   so every executor obeys it rather than only the owned interpreter. No
   default: budgets are host policy.

One guard is kept as **defence in depth with no reachable case**: a
defect escaping the executor becomes an `internal` refusal rather than
failing the run. Every route tried lands elsewhere first -- pathological
nesting is refused by acorn as a parse error (measured: "Not enough
stack space to parse input"), runaway recursion by `maxCallDepth`, a
throwing builtin by the fix above, a handler defect per call. It is
recorded as unreachable at the site so nobody mistakes it for tested
behaviour.

**Performance**, measured rather than assumed. At 200 tools across 10
namespaces, `Catalog.search` cost ~11ms per query -- it re-derived every
tool's JSON Schema twice per query, and search runs per model request.
Derived facts (schema, search text, rendered entry) are now memoised on
the tool object by identity in a `WeakMap`, keyed per namespace where
the namespace matters: **0.7ms per query, a 16x improvement**, with the
catalog's own behaviour pinned unchanged and the namespace key pinned by
its own test (a tool under two namespaces must render two paths).

## Edge-case and type-UX pass (2026-08-31)

Written by asking "what would a model plausibly type?" rather than by
reading the interpreter, which is how all four of these were found
(`test/CodeEdges.test.ts`).

1. **A parameterless tool could not be called with no arguments.**
   `tools.x.count()` -- the obvious thing for a tool whose schema has no
   properties -- decoded `undefined` against a struct and came back as a
   failure. Absent input is now an empty object. A tool that *does* need
   arguments still refuses, with its own schema's message.
2. **Internal class names leaked into model-visible diagnostics.**
   Returning a closure said "a ProgramFunction instance cannot cross",
   which describes our implementation rather than the model's mistake.
   `toData` gained a `describe` hook -- the caller names foreign values in
   its own vocabulary -- so the same case now reads "the program returned
   a function; return plain data instead", nested cases included.
3. **A tool held in a variable got a wrong message.** `const f =
   tools.x.y; await f()` said "is a namespace, not a tool", which is a
   guess the interpreter cannot make (it has never seen the toolkit). It
   now names the form that works.
4. **A returned promise is awaited** and a bare `return` is
   distinguishable from running off the end -- both were already correct
   and are now pinned.

**Type UX** (`test/CodeTypes.test.ts`), because the groups constraint is
`WithHandler<any>` and that is exactly the kind of `any` that silently
swallows a requirement. Pinned at the type level and broken once from
the library side to prove the pins are not vacuous: a tool's declared
`dependencies` reach `execute`'s requirement (making `ServicesOf` return
`never` fails the pin), the requirement is not `any` (making it `any`
fails a second pin), a toolkit needing nothing requires nothing, and a
permission policy's own `R` propagates. `examples/code-mode.ts` is the
same claim at usage level: it runs, and asserts that its requirements
are `never` and its inference is not `any` -- with no cast anywhere.

