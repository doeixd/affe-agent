# Plan: model capabilities — the metadata `Model` omits

**Status: partly implemented; everything below is committed.**
Updated 2026-09-01. Against §8: **M0 done** (both open facts verified, §11),
**M1 done** — `src/model/ModelCapabilities.ts` and `test/ModelCapabilities.test.ts`,
reachable as the `./model` entry point, which `verify:package` imports from the
packed tarball; the exhaustiveness test fails the build when the pinned rc names
a model with no capability row. **M2 done** (`ModelCapabilities.budget`, §8),
**M3 done** (`ContextTransform.cacheBreakpoint`, `test/PromptCache.test.ts`).
**M4 done** (`Budget.cost`, §8). **M5 and M6 are not started.** Everything above is committed, so `STATUS.md`
may claim it.

Drafted 2026-09-01, from a question that arrived as a sketch:
`InferenceProvider<Models, Contract>` — a model carrying its own options
(effort, vision), a contract saying how to turn that model into requests on a
given provider, and an answer for auth and caching.

Most of that sketch already exists, upstream, and this document's first job is
to say which parts so nobody rebuilds them. Its second is to name the one part
that does not exist, is not upstream's to add, and is worth having here: **a
model cannot say what it can do.** Everything downstream that needs to know —
compaction sizing a window, budget capping on money, a fallback ladder that
must not step onto a model that cannot see — currently gets told by a
hand-written number at the call site, or not at all.

The shape of the answer is deliberately small: metadata beside `Model`, read
through the tags upstream already provides, plugged into seams that already
take an Effect. No new kernel noun, no wrapper around `LanguageModel`, and
nothing that puts this library in the business of tracking a provider's option
vocabulary.

## 1. Facts verified in-code, 2026-09-01

Against `effect@4.0.0-rc.111` (`effect/unstable/ai`) and `@effect/ai-anthropic`
/ `@effect/ai-openai@4.0.0-rc.112`, the rcs this repository pins. Each of these
was read, not recalled.

| fact | where |
| --- | --- |
| `Model<Provider, Provides, Requires>` extends `Layer<Provides \| ProviderName \| ModelName, never, Requires>` — a model **is** a layer, tagged with its provider in the type | `unstable/ai/Model.d.ts` |
| `Model.ProviderName` / `Model.ModelName` are `Context.Service` tags over `string`, provided automatically by every `Model` | `unstable/ai/Model.js` |
| `AnthropicLanguageModel.model(...)` returns `Model<"anthropic", LanguageModel, AnthropicClient>`; `OpenAiLanguageModel.model(...)` returns `Model<"openai", ...>` | both packages, `model` export |
| Provider-specific request options are a per-provider `Config` service, scoped per call by `withConfigOverride` | `Anthropic/OpenAiLanguageModel.d.ts` |
| Anthropic's reasoning knob: `thinking: {budget_tokens} \| {type:"adaptive"} \| {type:"disabled"}` **plus** `output_config.effort: "low"\|"medium"\|"high"` | `AnthropicLanguageModel.Config` |
| OpenAI's reasoning knob: `reasoning.effort: "none"\|"minimal"\|"low"\|"medium"\|"high"\|"xhigh"\|"max"`, and `text.verbosity` | `OpenAiLanguageModel.Config` |
| Model ids are literal unions widened with `(string & {})`, so a gateway's namespaced id still typechecks | `Generated.Model` |
| Per-message provider options arrive by **declaration merging** into `Prompt.SystemMessageOptions` and friends — that is how Anthropic's `cacheControl` breakpoint is typed | `AnthropicLanguageModel.d.ts`, `declare module "effect/unstable/ai/Prompt"` |
| `Model` carries **no** capability metadata: no vision, context window, max output, tool support, or cost | `unstable/ai/Model.d.ts`, whole file |
| Nothing in this repository uses `Model`, `ProviderName`, `ModelName`, `withConfigOverride` or `cacheControl` — zero hits across `src`, `examples`, `apps`, `test` | grep |
| `Compaction.tokens` takes `budget: ContextBudget \| ResolveBudget<E, R>`, where `ResolveBudget` is `(context) => Effect<ContextBudget, E, R>` | `src/compaction/Compaction.ts:204` |
| `Compaction`'s own comment: *"Build a context-window policy without coupling an agent to a model"* — the window is a caller-supplied `number` | `src/compaction/Compaction.ts:203` |
| `Budget.within(limit, inner)` caps on **tokens**; `Budget.spend` takes a token count | `src/budget/Budget.ts:78` |
| `executionPlan` is consulted in exactly two places, both in `AgentTurn` | `src/AgentTurn.ts:108,146` |

## 2. The sketch, resolved into four questions

The sketch bundled four things. They separate cleanly, and only one is ours.

| the question | verdict |
| --- | --- |
| **`Contract`** — which provider, and how a model becomes a request on it | **already upstream.** `Model`'s `Provider` type parameter is the contract; each provider package's `make`/`layer` is the translation, over a normalized `LanguageModel.ProviderOptions`. Nothing to add. |
| **`Model.options`** — effort, temperature, thinking | **already upstream, per provider.** `Config` + `withConfigOverride`. Normalizing across providers is a **non-goal** — see §3. |
| **capabilities** — vision, window, cost, tool support | **the gap.** §4. |
| **auth, caching** | auth is settled and correct (§6); caching is two different things, one of which is a cheap win nobody has taken (§7). |

## 3. Why `effort` must not be normalized

This is the trap in the sketch, and it is worth stating as a rule rather than a
preference.

Anthropic's reasoning control is a **token budget** (`thinking.budget_tokens`)
alongside a three-valued `output_config.effort`. OpenAI's is a **seven-valued
enum** including `"none"` and `"max"`. A unified
`effort: "low" | "medium" | "high"` is not an abstraction over those two; it is
a lossy translation whose meaning differs per provider and whose correctness
expires whenever either vendor ships a level. Adopting it puts this library on
the hook for tracking two vendors' option surfaces forever — which is
`ROADMAP.md` §3's *"never a parallel execution model"* failing in its most
tempting form.

Upstream's answer is better and already built: **declaration merging**. A
provider package extends `Prompt`'s options interfaces with a namespaced key
(`anthropic?: { cacheControl }`), so provider-specific options are typed,
discoverable at the call site, and scoped to the provider that understands them
— with no central registry to keep current. Capabilities described here follow
that seam and do not flatten it.

The line: **a capability is a fact about a model that a caller must branch on.
An option is an instruction to a provider.** This plan takes the first and
leaves the second entirely alone.

## 4. Design: `ModelCapabilities`

### 4.1 The value

```ts
export interface Capabilities {
  /** Accepts image parts. */
  readonly vision: boolean
  /** Total input + output the model will hold. */
  readonly contextWindow: number
  /** The most it will emit in one response. */
  readonly maxOutputTokens: number
  /** Accepts tool definitions. */
  readonly tools: boolean
  /** Has a reasoning mode at all — not which knob turns it. */
  readonly reasoning: boolean
  /** Per million tokens, in whatever unit the caller keeps its books in. */
  readonly cost?: {
    readonly input: number
    readonly output: number
    readonly cachedInput?: number
  } | undefined
}
```

`cost` is optional because a self-hosted or gateway-fronted model may have
none, and because a wrong number is worse than an absent one. `reasoning` is a
boolean on purpose: the *knob* stays in the provider's `Config`, per §3.

### 4.2 The service

```ts
export class ModelCapabilities extends Context.Service<ModelCapabilities, {
  /** For the model currently in context. */
  readonly current: Effect<Capabilities, UnknownModelError>
  /** For a named model, ahead of choosing it. */
  readonly of: (
    provider: string,
    model: string
  ) => Effect<Capabilities, UnknownModelError>
}>() {}
```

`current` reads `Model.ProviderName` and `Model.ModelName` from context — the
tags every upstream `Model` already provides — so a caller who wired their
model with `AnthropicLanguageModel.model(...)` gets capabilities with no second
declaration. A caller who wired the bare `layer(...)` has no tags in context;
`current` fails with `UnknownModelError`, which is the honest outcome and is
why the error is typed rather than defaulted away.

### 4.3 Where the table comes from

Three layers, and the ordering matters:

- **`ModelCapabilities.builtin`** — a static table for the models this
  repository's rcs already name in `Generated.Model`. It will be wrong
  eventually. That is acceptable *only* because of the next two.
- **`ModelCapabilities.fromTable(table)`** — the caller's own table, for a
  gateway's namespaced ids, a self-hosted model, or a correction. Ordinary
  data.
- **`ModelCapabilities.layerEffect(...)`** — resolved at runtime, for a
  deployment that fetches a gateway's model list.

`builtin` is a convenience over `fromTable`, not a privileged path, and the
staleness risk is confined by a test: **every model id in the pinned rcs'
`Generated.Model` union must appear in `builtin`, or the build fails.** That
turns a bumped rc into a compile-time prompt to fill in the new row, which is
the only way a table like this survives contact with a vendor's release
cadence. It is the technique `test/Casts.test.ts` uses on the cast inventory,
applied to a different list.

### 4.4 What it plugs into — all existing seams

The design's whole claim is that it adds a service and changes no signature.

**Compaction.** `Compaction.tokens` already accepts a `ResolveBudget`, an
Effect with its own `R`. So:

```ts
Compaction.tokens({
  budget: ModelCapabilities.budget({ reserve: 4096, keepRecent: 8192 }),
  estimate: Compaction.estimate.approximate
})
```

`ModelCapabilities.budget` is a `ResolveBudget<UnknownModelError,
ModelCapabilities>` that reads `contextWindow` from the model in context and
returns the `ContextBudget` the policy already wanted. The
`contextWindow: number` form stays, unchanged; this is a second way to supply
it, not a replacement. **No change to `src/compaction`.**

**Budget.** `Budget.within` caps on tokens. `Budget.cost(limit, inner)` is the
same loop combinator reading `cost` from capabilities and spending money
instead — the `Budget` service grows a second counter, decided at
implementation. This is the one place a genuinely new API appears, and it is a
combinator beside an existing one.

**Pre-flight refusal.** A prompt containing image parts, against a model whose
`vision` is `false`, is a request that will fail at the provider. It already
fails *loudly* — a 400, not silence — so the value here is smaller than it
first looks, and this plan should not overclaim it: what a check buys is
failing **before** the call, with a message naming the model and the
capability, rather than after a fallback ladder has spent three provider
round-trips discovering the same thing three times. Offered as a
`ContextTransform`, which is the existing seam for inspecting what reaches the
model, and **opt-in**.

### 4.5 What it deliberately does not do

It does not route. Capability-driven model *selection* is a pre-call policy
decision, and [plan-execution-plan.md](./plan-execution-plan.md) already
settled the shape of those: an `ExecutionPlan` is failure-driven and is the
wrong mechanism, while a `LanguageModel` layer built from an effect that reads
a service and returns one model or another is `Layer.unwrap` over ordinary
wiring, needs no new API, and belongs in an example. That reasoning was written
for budget-driven selection and applies unchanged here. **An example, not a
feature.**

## 5. Invariants

1. No signature in `src/` changes to accommodate this. Compaction takes the
   capabilities-derived budget through the `ResolveBudget` seam it already has.
2. Capabilities are read through `Model.ProviderName` / `Model.ModelName`. A
   caller who never wired a `Model` is not penalised: they get a typed
   `UnknownModelError` where they ask, and every existing path that does not
   ask keeps working exactly as before.
3. No provider option is normalized. `Capabilities` states facts a caller
   branches on; it never states an instruction to a provider.
4. `builtin` is data, is overridable, and cannot silently drift: a model id in
   the pinned rcs with no row fails the build.
5. `cost` absent beats `cost` wrong. Nothing derives a default.
6. `src/` imports no provider package. Capabilities key on a provider *string*,
   exactly as `Model` does.

## 6. Auth: settled, with one asymmetry worth naming

The current answer is right and this plan does not touch it. A provider client
layer reads `Config.redacted("ANTHROPIC_API_KEY")` and is assembled at the
wiring site; the key appears in no agent, session, or event.

The asymmetry is worth recording because it is invisible until someone asks for
it. This repository already solved the *harder* version of this problem one
layer over: `src/toolSource/Credentials.ts` splits method / binding / provider
precisely because their lifetimes differ, resolves a handle to a `Redacted`
value **per call**, and — with `Principal.CurrentPrincipal` on the acting fibre
— can resolve per tenant. So:

- **tool** credentials: per-principal, per-call, handle-based;
- **model** credentials: a static layer, per process.

That is a real difference in kind. It is also, today, the correct scope:
[plan-primitives.md](./plan-primitives.md) lists *"hosted multi-tenant
proxying, billing, BYOK key custody"* as **not ours**, deliberately, and being
a model gateway is a product rather than a primitive. The note here is only
that if that decision is ever revisited, the machinery to implement per-tenant
model keys already exists and would not need inventing — `Credentials` is not
tool-specific in anything but its current callers.

**No work is proposed. The row exists so the question is answered rather than
re-asked.**

## 7. Caching: two different things

### 7.1 Provider prompt caching — a cheap win, untaken

Anthropic's `cacheControl` breakpoint is typed and reachable today, per
message, through `Prompt.SystemMessageOptions.anthropic.cacheControl`.
**Nothing in this repository sets one.** For an agent with a large stable
system prompt and a large toolkit — which is exactly `Presets.coding` and both
reference agents — a breakpoint after the stable prefix is the largest cost
lever available, and it is configuration rather than architecture.

It interacts with two things already here, and neither interaction is obvious,
which is what makes it worth a slice of its own rather than a line in a README:

- **Compaction moves the boundary.** A breakpoint's value comes from the prefix
  beneath it being byte-identical across turns. Compaction rewrites history, so
  every compaction invalidates the cache below the point it cut. Placing the
  breakpoint above the compacted region — after instructions and tools, before
  conversation — is the placement that survives, and it should be stated as the
  reason rather than discovered as a regression.
- **`cachedInput` is a different rate.** `/budget` counts tokens and cannot
  tell a cache read from a fresh one, so a money ceiling (§4.4) must read
  cache-hit usage from the response or it will overcount, badly, for exactly
  the agents that benefit most. **Answered by M0 — the rc separates them.**

### 7.2 Response caching — not proposed

Deduplicating identical model calls is a different mechanism with the concern
`DurableModel` already documents at length: a model call is billed,
nondeterministic, and may have provider-side effects. `/durable` answers the
replay case correctly by journaling responses as an `Activity`. A general
response cache answers a question nobody in this repository has asked, and is
out of scope until someone does.

## 8. Milestones

- **M0 — Verify the two open facts. ✅ Done 2026-09-01; both clear.** See §11.
  Neither invalidates a milestone below, and M4 in particular is unblocked.
- **M1 — `Capabilities`, the service, `fromTable`, `builtin`, and the
  exhaustiveness test.** Data and a lookup; no consumer yet.
- **M2 — `ModelCapabilities.budget`. ✅ Done 2026-09-01.** A resolver reading
  `contextWindow` from the model in scope; `reserve` and `keepRecent` stay the
  caller's, because they are judgements about the agent rather than facts about
  the model, and `reserve` defaults to the model's own `maxOutputTokens`.
  `src/compaction` did not change, which was the milestone's actual claim --
  pinned by a test that hands the resolver to `Compaction.tokens` and would
  stop compiling if either shape drifted (confirmed by breaking it). Typed
  structurally rather than as `Compaction.ResolveBudget`, so `/model` does not
  depend on `/compaction` to state its own return type.
- **M3 — Prompt caching (§7.1). ✅ Done 2026-09-01.**
  `ContextTransform.cacheBreakpoint` marks the last message of the leading
  system run; `Presets.coding` sets it as a default the caller overrides by
  setting `contextTransform`. `test/PromptCache.test.ts` pins placement,
  option preservation, wire survival and that canonical history is untouched.
  Two findings worth carrying forward:
  - **OpenAI also has a breakpoint**, `openai.promptCacheBreakpoint:
    {mode:"explicit"}`, and its docs say it *"requires GPT-5.6 or later"* and
    that OpenAI "may reject requests that use this option with earlier
    models". So it is opt-in (`providers: ["anthropic","openai"]`) while
    Anthropic's is the default: an unread namespaced key is inert — verified,
    the OpenAI provider reads `options.openai?.*` field by field — but a
    rejected request is not.
  - **A provider package's declaration merging does type-check the values**,
    if the package is in the compilation. `satisfies
    Prompt.SystemMessageOptions` makes a typo in `cacheControl` a compile
    error (TS2561, confirmed by breaking it). Indexing the interface by
    `string` instead checks nothing — it resolves to the index signature's
    `Json | null`. That was the first attempt and it silently passed.
- **M4 — `Budget.cost`. ✅ Done 2026-09-01.** The same loop combinator as
  `within` and the same fail-closed timing, reading money instead of tokens.
  `Capabilities.cost` prices `uncached`, `cacheRead`, `cacheWrite` and output
  separately, because §12.1 established they are separate rates and a cache
  *write* costs more than an uncached token — a ceiling pricing only reads
  would under-count the first turn of every conversation. A test asserts
  exactly that, and fails if the write is priced as a read.
  §12.1's other warning is answered too: `uncached` is reconstructed from
  `total` minus the cache figures when a provider omits it, and never goes
  negative. An unpriced model **fails** the run naming the model rather than
  costing nothing, since charging zero turns a money ceiling into no ceiling
  silently. `Budget` grew a second counter rather than a second service, so one
  layer still decides the scope for both axes, and
  `TestLanguageModel.Turn.usage` grew `cacheRead` / `cacheWrite` so a user can
  script the case at all.
- **M5 — The pre-flight `ContextTransform`, opt-in.**
- **M6 — One example: capability-driven selection as `Layer.unwrap`**, beside
  the budget-driven one `plan-execution-plan.md` already called for.

## 9. Success conditions

- A coding agent sizes compaction from the model's real window without any
  caller writing a context-window number.
- Bumping the pinned `@effect/ai-*` rc to one naming a new model fails the
  build until that model has a capability row.
- An agent given an image and a text-only model is refused before the call,
  with the model and the missing capability named — when the caller opted in.
- `Presets.coding` sets a cache breakpoint, and the reason its placement sits
  above the compacted region is written where the breakpoint is.
- No existing example, preset, or test changes, except to adopt something.

## 10. Non-goals

- A unified cross-provider option vocabulary (§3). Named explicitly, because
  left unstated it becomes a goal by default — the same reasoning
  `plan-primitives.md` applies to model gateways.
- Wrapping, replacing, or re-exporting upstream's `Model`.
- A provider package in `src/`. Capabilities key on a provider string.
- Routing, billing, per-tenant proxying, BYOK custody (§6).
- Response caching (§7.2).
- Pricing accuracy as a maintained product. `builtin` is a starting table,
  `fromTable` is the answer to it being wrong, and that ordering is stated so
  nobody files the staleness as a defect.

## 11. M0 results (2026-09-01)

Both questions were checked before anything below them was designed further.
Both came back clear, and one returned more than was asked.

### 12.1 Usage separates cached from fresh input — yes, and more

`Response.Usage` (`unstable/ai/Response.d.ts:1667`) is:

```ts
inputTokens:  { uncached?, total?, cacheRead?, cacheWrite? }
outputTokens: { total?, text?, reasoning? }
```

So `Budget.cost` can price a cache read at the cached rate, and **`cacheWrite`
is there too** — which matters, because writing a cache entry costs *more* than
an uncached token, not less. A money ceiling that priced only `cacheRead` would
under-count the first turn of every conversation. That is a design constraint on
M4 rather than a blocker, and it is now written down before the code exists.

`outputTokens.reasoning` being separable is a bonus the sketch did not ask for:
reasoning tokens are billable output and a cost model can account for them
distinctly.

One consequence for existing code, noted and **not** acted on here:
`Budget.tokensOf` (`src/budget/Budget.ts:35`) reads `inputTokens.total ?? 0`.
Every field in that struct is `Schema.optional`, so a provider populating
`uncached` / `cacheRead` but not `total` would be counted as zero. Whether any
provider actually does that is unverified, and inventing a fallback for a
hypothetical is worse than leaving it — recorded here so M4 checks it against a
real response rather than rediscovering it.

### 12.2 A `cacheControl` breakpoint survives this repository's boundaries — yes

`Prompt`'s per-message `options` is part of its **schema**, not an in-memory
extra: `Schema.$Record<Schema.String, Schema.NullOr<Schema.Codec<Schema.Json>>>`
with a decoding default. `PromptWire` encodes and decodes through that schema
(`Schema.encodeEffect(AiPrompt.Prompt)`), and its one custom step — rewriting
file-part `data` — spreads the rest of the part (`{ ...part, data }`), so it
carries `options` through untouched.

That single codec is what every boundary here uses: the session snapshot
(`AgentSession.ts:1001`), the client protocol, the cluster entity payload, and
the durable payload all type their prompt as `PromptWire.Prompt`. Verifying the
codec verifies all of them.

Verified by running it, not by reading it. A breakpoint on a system message
round-tripped intact:

```
{"content":[{"options":{"anthropic":{"cacheControl":{"type":"ephemeral"}}},
             "role":"system","content":"stable instructions"}, …]}
```

and the assertion was broken once — expecting `type: "BROKEN"` — to confirm it
was enforced rather than vacuously passing. The scratch test was removed; M3
should land it as a permanent one, since this is exactly the property that
would rot silently.

**The durable journal is not a risk for a different reason:** `DurableModel`
journals *response* parts, never the prompt, so a replayed submission
reconstructs its prompt through the same wire path as a fresh one.

## 12. See also

- [plan-primitives.md](./plan-primitives.md) §"Model gateways — mostly out of
  scope, deliberately" — the scope line §6 leans on.
- [plan-execution-plan.md](./plan-execution-plan.md) §"What this does *not*
  solve" — why capability-driven selection is an example, not a feature.
- [plan-tool-credentials.md](./plan-tool-credentials.md) — the credential
  machinery §6's asymmetry refers to.
- `examples/openrouter.ts` — a gateway as configuration, and the Responses API
  fact that makes "OpenAI-compatible" insufficient on its own.
