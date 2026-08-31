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
   claim than one that runs to completion.
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
| 6 | Elicitation inside programs (decline throws) | 5 |

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
