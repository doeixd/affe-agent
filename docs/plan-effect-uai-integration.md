# effect-uai comparison and interoperability plan

**Status:** research + design proposal; **not implemented** unless a later status/ledger entry says otherwise.

**Read:** 2026-09-08, against `doeixd/affe-agent` and `betalyra/effect-uai` main.

This note asks three questions:

1. What should `affe-agent` learn from `effect-uai`?
2. What should we reuse rather than rebuild?
3. Can `affe-agent` use `effect-uai` providers and capabilities without giving up the execution model that makes `affe-agent` distinct?

The short answer is **yes**, but the right boundary is narrower than “make all of `effect/unstable/ai` replaceable.”

The recommended direction is:

> Keep `affe-agent`'s session / submission / run / turn semantics and keep Effect AI as the canonical in-kernel AI vocabulary for now. Add optional compatibility packages that adapt other AI ecosystems into that boundary, beginning with an `effect-uai -> Effect AI LanguageModel` adapter.

That gets the provider breadth and capability ecosystem of `effect-uai` while preserving the part `affe-agent` actually owns: durable agent execution semantics.

---

## 1. Where the projects sit

The projects overlap, but they are not the same layer.

`effect-uai` is primarily a **provider-neutral AI primitive layer**:

- its own `LanguageModel` service;
- its own `Turn`, `TurnEvent`, history items, tools, and toolkits;
- provider packages for OpenAI, Anthropic, Google, Mistral, and others;
- adjacent services for embeddings, reranking, chunking, search, web reading, browsers, sandboxes, transcription, speech, image generation, music, and research;
- recipes that leave application state and orchestration to the caller.

`affe-agent` is primarily an **agent execution kernel above an AI model/tool vocabulary**:

- `AgentSession`;
- submissions, runs, turns;
- steering, follow-ups, interruption, elicitation;
- canonical history and atomic turn commit;
- permissions and tool execution policy;
- typed lifecycle events;
- snapshots / restore;
- durable execution, cluster execution, durable streams;
- protocol-neutral clients and multiple transports.

Today `affe-agent` imports `LanguageModel`, `Prompt`, `Response`, `Tool`, and `Toolkit` from `effect/unstable/ai`. It deliberately calls models with `disableToolCallResolution: true`; the harness owns tool execution because tool execution is where permissions, concurrency, lifecycle events, atomic commit, durability, and replay semantics live.

That is the key compatibility fact.

The stack today is approximately:

```text
application
    |
    v
affe-agent
    |
    | session / submission / run / turn semantics
    v
effect/unstable/ai
    |
    | LanguageModel / Prompt / Tool / Toolkit / Response
    v
Effect AI provider layers
```

`effect-uai` instead looks like:

```text
application-owned orchestration
    |
    v
@effect-uai/core
    |
    | LanguageModel / Turn / Tool / Toolkit / capabilities
    v
@effect-uai/* providers
```

The projects therefore have a natural composition point instead of requiring one to replace the other.

---

## 2. The strategic distinction to preserve

The most important lesson is not a feature. It is a boundary.

`effect-uai` deliberately keeps the core thin and pushes orchestration upward. Its generic `loop` is a state-threaded pull-based `Stream` primitive: the application owns state, history, continuation, tool flow, and higher-level policy.

`affe-agent` makes a different claim:

> Some choices that look like application policy in a local loop become runtime semantics once multiple clients, transports, processes, durable replays, and observers must agree about them.

Examples:

- when steering becomes visible;
- whether a follow-up belongs to the current run or a later one;
- what counts as committed history;
- what interruption means;
- whether two runs may own a session simultaneously;
- what lifecycle event closes an opened message/tool/elicitation;
- what snapshot/restore preserves;
- which state is replay-stable;
- when a tool side effect is permitted to execute;
- whether a partially streamed fallback can be shown and then abandoned.

Those should not be independently reinvented by every application using `affe-agent`.

So the correct lesson from `effect-uai` is **not** “make Affe thinner until it is a generic loop.” The correct lesson is:

> Use `effect-uai` as a pressure test. Every new Affe kernel concept must prove it is a cross-runtime semantic rather than merely a useful feature.

A useful review question for every proposed root noun is:

> Must this have the same meaning in-process, over a remote client, after snapshot/restore, and under durable replay?

If yes, it may belong in the kernel.

If no, prefer an existing seam, service, battery, adapter, or recipe.

This heuristic should be kept even if no direct `effect-uai` integration ships.

---

## 3. Things to learn or take inspiration from

### 3.1 Compatibility packages, not ownership

`effect-uai` ships compatibility packages such as its Vercel AI SDK bridge. The compatibility package translates at an edge and does not force the core to become the union of both systems.

Affe should copy that pattern.

Instead of putting `effect-uai` conditionals inside `AgentTurn`, prefer an optional package such as:

```text
@affe-agent/effect-uai
```

or, if this repository continues publishing one package, an optional subpath whose dependency remains isolated from the default graph.

The core invariant is:

```text
affe-agent core has no required dependency on @effect-uai/core
```

The compatibility layer owns translation.

### 3.2 Explicit capability loss

Cross-provider normalization is never perfectly lossless.

`effect-uai` handles this explicitly: when a provider cannot express a capability, it distinguishes cases that should fail from cases that may continue with a warning. It also warns about provider-incompatible history blocks rather than silently pretending they survived.

Affe should adopt the same discipline for every translation package.

A compatibility adapter should classify a conversion as:

```ts
type Compatibility =
  | { readonly _tag: "Exact" }
  | {
      readonly _tag: "Degraded"
      readonly feature: string
      readonly source: string
      readonly target: string
      readonly reason: string
    }
  | {
      readonly _tag: "Unsupported"
      readonly feature: string
      readonly source: string
      readonly target: string
      readonly reason: string
    }
```

The exact API can differ. The invariant matters more:

- **Exact:** preserve meaning.
- **Degraded:** output remains valid but loses information or a hint; make that observable.
- **Unsupported:** continuing would lie about semantics; fail before issuing the model request or before committing the result.

Never silently drop a semantic field in a compatibility adapter.

This aligns with an invariant Affe already discovered independently: canonical history must not silently lose a returned file merely because an upstream response-to-prompt convenience conversion lacks a case for it.

### 3.3 Opaque provider round-trip data

`effect-uai` gives portable history items an opaque provider-data slot. That allows provider-specific continuation information to survive a generic history representation without forcing the generic domain to understand it.

Affe should audit the equivalent property across Effect AI metadata, `PromptWire`, snapshots, durable journals, clients, and model fallback.

The property to prove is:

```text
provider response
    -> canonical Affe history
    -> snapshot / durable journal / transport
    -> restore
    -> next provider request
```

must preserve every provider-specific datum necessary to continue correctly.

Important candidates include:

- reasoning signatures;
- encrypted reasoning state;
- provider response IDs;
- provider tool-call IDs;
- prompt-cache metadata;
- provider-defined tool metadata;
- source / citation metadata;
- any opaque continuation token used for incremental requests.

Do not add a new Affe `providerData` field merely because `effect-uai` has one. First prove whether Effect AI's existing metadata facilities survive every Affe boundary. If they do, keep them. If they do not, fix the narrowest Affe wire/history boundary that loses them.

### 3.4 Tool composition ergonomics

`effect-uai`'s Toolkit work is worth studying independently of integration:

- name-indexed tool records;
- compile-time duplicate-name rejection for static tools;
- runtime duplicate rejection for dynamic composition;
- namespacing;
- toolkit middleware;
- precise propagation of tool requirements/errors;
- explicit distinction between local, provider, signal, and interaction tools.

Affe already has strong tool execution semantics and duplicate-name protection, so this is not a recommendation to replace Effect AI `Toolkit`.

It is a recommendation to compare authoring ergonomics and identify any functionality that belongs upstream in Effect AI or in an Affe helper rather than duplicating it ad hoc.

Particularly interesting questions:

1. Would namespacing help discovered tool sources before they enter `ToolSource.bind`?
2. Is there a useful toolkit-wide middleware combinator that preserves precise requirements without becoming a second permission system?
3. Can collision diagnostics name both sources rather than only the final duplicate name?
4. Can dynamic tool composition stay explicit about the point at which static precision necessarily becomes `string` / `unknown`?

### 3.5 Model-visible capability is not the same as local executable tool

`effect-uai` distinguishes four concepts:

```text
LocalTool
ProviderTool
SignalTool
InteractionTool
```

Affe has independently accumulated related cases:

- ordinary local tools;
- provider-executed tools;
- `AgentOutput`;
- elicitation;
- delegation/control-flow tools;
- tools synthesized from external sources.

Do **not** introduce a new four-way Affe ADT just to mirror `effect-uai`.

But perform a reification audit with this question:

> Are there current Affe special cases that exist only because “model-visible capability” and “locally executed handler” are represented as one concept?

If a new primitive removes multiple real special cases while preserving Effect AI compatibility, consider it. Otherwise leave the distinction at the adapter/battery level.

### 3.6 Recipe-first onboarding

`effect-uai` has a strong recipe culture: small runnable programs for one concept at a time.

Affe has stronger conformance/reference applications in several areas, but onboarding would benefit from more examples shaped like:

```text
one problem
one public seam
one small complete program
one smoke/typecheck
```

Good candidates:

- minimal streaming chat;
- steering while a run is active;
- follow-up vs steer;
- approval + resume;
- provider fallback;
- one durable resume walkthrough;
- one remote `AgentClient`;
- one effect-uai-backed model once the adapter exists.

Reference agents should remain acceptance tests for whole axes. Recipes answer a different question: “How do I do one thing?”

### 3.7 Workspace/release structure

`effect-uai` uses a real pnpm workspace with separate core, provider, compatibility, recipe, web, and integration-test packages.

Affe does not need to become dozens of published packages, but the repository should strongly consider a real workspace so that:

- `apps/cli`;
- `apps/tui`;
- worker examples;
- compatibility packages;
- docs/examples;
- future web/workbench apps

share reproducible dependency installation and CI.

This directly addresses the class of failure where the root CI invokes nested-app checks after installing only root dependencies.

A workspace is a repository/build decision, not a commitment to publish every folder separately.

---

## 4. Recommended interoperability architecture

### 4.1 First integration: make effect-uai look like an Effect AI provider

This is the highest-value and lowest-risk integration.

Effect AI exposes `LanguageModel.make(...)` as the provider SPI. It accepts normalized provider options and asks an adapter for batch and streaming response parts.

Affe already depends on that `LanguageModel` contract, and the actual model calls are concentrated in `AgentTurn`:

```text
batch      -> LanguageModel.generateText(...)
streaming  -> LanguageModel.streamText(...)
```

with tool auto-resolution disabled.

Therefore the adapter can be outside the kernel:

```text
                         affe-agent
                   session/run/turn kernel
                           |
                           | Effect AI LanguageModel
                           v
                 @affe-agent/effect-uai
                           |
               Effect AI <-> effect-uai
                           |
                 @effect-uai/core
                           |
          +----------------+----------------+
          |                |                |
          v                v                v
      Anthropic          Gemini          Mistral ...
```

The adapter should:

1. receive Effect AI `LanguageModel.ProviderOptions`;
2. translate the prompt/history into `effect-uai` history items;
3. translate model-visible Effect AI tools into descriptor-only effect-uai tools;
4. choose/use an `effect-uai` model/provider service;
5. call `turn` or `streamTurn`;
6. translate effect-uai output back to Effect AI encoded response parts;
7. surface any degradation/unsupported conversion explicitly;
8. never execute local tools itself.

The critical ownership rule is:

> The adapter exposes tool descriptions to the model, but `affe-agent` continues to execute the original Effect AI handlers.

That preserves all Affe permission, concurrency, lifecycle, atomicity, replay, and durability semantics.

### 4.2 Why this is better than making the kernel generic over an AI substrate

A tempting abstraction is:

```ts
interface AgentModel<Prompt, Tools, Response, ...> { ... }
```

and then parameterize the entire kernel over it.

Do not start there.

Today Effect AI provides much more than the final model call:

- `Prompt`;
- `Tool`;
- `Toolkit`;
- `Response`;
- `LanguageModel`;
- `AiError`;
- finish reasons;
- file/source representations;
- provider-defined tools;
- typed tool-call parameter handling.

Affe public and internal types legitimately depend on several of those.

Making all of that generic now would force Affe to invent and maintain its own canonical equivalents:

```text
AffePrompt
AffeTool
AffeToolkit
AffeResponse
AffeLanguageModel
AffeProviderMetadata
...
```

That would make Affe another provider abstraction library, exactly where it has the least differentiation.

Use this rule instead:

> **Do not abstract Effect AI out of Affe until an adapter demonstrates a concrete impedance mismatch that cannot be solved cleanly at the provider boundary.**

`LanguageModel.make` is already the seam we would otherwise invent.

If the effect-uai adapter eventually requires pervasive lies, casts, or loss of semantics, that becomes evidence for a deeper Affe `AgentModel` substrate. Until then, do less.

---

## 5. Translation surface for the LanguageModel adapter

The mapping is close enough to be practical, but it must be tested rather than assumed.

### 5.1 Requests / history

| Effect AI | effect-uai | expected fidelity |
| --- | --- | --- |
| system message | system `Message` / system text item | exact |
| user text | user `Message` + `input_text` | exact |
| assistant text | assistant `Message` + `output_text` | exact |
| reasoning | `Reasoning` | exact or provider-dependent |
| tool call | `function_call` | exact if IDs/encoded args survive |
| tool result | `function_call_output` | exact if output encoding survives |
| user image | `input_image` | exact where the source representation maps |
| assistant image/file | `output_image` or unsupported/degraded | media-type dependent |
| arbitrary file/document | no universal 1:1 history block | likely unsupported/degraded |
| provider metadata | `providerData` | requires explicit round-trip policy |

Do not reduce this to text-only history.

### 5.2 Tools

Effect AI provider options expose the tools the model should see. For each tool, the adapter needs at least:

- name;
- description;
- encoded/JSON parameter schema;
- strictness/provider tool information where representable.

The effect-uai side does **not** need to own the original handler. It only needs a model-visible descriptor.

The adapter must preserve the original Affe/Effect AI toolkit on the Affe side so a returned tool call is resolved by `ToolExecution` as usual.

### 5.3 Batch responses

Likely mappings include:

| effect-uai | Effect AI response part |
| --- | --- |
| output text | text part |
| reasoning | reasoning part |
| function call | tool-call part |
| output image | file/image representation where possible |
| citation | URL/document source or provider metadata |
| usage | finish/metadata fields as supported |
| stop reason | finish part |
| refusal | error/metadata/text policy; must be decided explicitly |

Refusal deserves a specific test. Do not silently map “provider refused” to an ordinary successful assistant text if that destroys a distinction an Affe observer or retry policy may care about.

### 5.4 Streaming responses

The adapter must translate event-by-event without weakening Affe's streaming invariant.

Potential mappings:

```text
effect-uai TextDelta
    -> Effect AI text start/delta/end protocol

effect-uai ReasoningDelta
    -> reasoning start/delta/end

effect-uai ToolCallStart + ToolCallArgsDelta
    -> tool params start/delta/end + assembled tool call

effect-uai ImageOutput
    -> file part where possible

effect-uai CitationAdded
    -> source/metadata event if Effect AI can represent it incrementally,
       otherwise final-response metadata with an explicit degradation notice

effect-uai TurnComplete
    -> any missing settled parts + finish
```

A streamed adapter must prove:

- every opened text/reasoning/tool-params stream is closed;
- tool argument fragments preserve call ID and order;
- interleaved tool calls do not merge;
- final assembled tool calls match the streamed fragments;
- a provider failure after partial output follows Affe's no-mixed-fallback rule;
- cancellation does not fabricate a completed turn;
- usage/finish metadata is not double-counted.

---

## 6. Compatibility loss must be a first-class test concern

Before supporting a feature, maintain a conformance table such as:

| feature | Effect AI -> effect-uai | effect-uai -> Effect AI | policy |
| --- | --- | --- | --- |
| text | exact | exact | required |
| system prompts | exact | exact | required |
| reasoning text | exact | exact | required |
| opaque reasoning signature | prove | prove | required for provider continuation |
| local tool descriptors | exact | n/a | required |
| tool call IDs | exact | exact | required |
| encoded tool args | exact | exact | required |
| tool results | exact | exact | required |
| user images | exact where supported | exact where supported | supported |
| arbitrary files | provider-dependent | provider-dependent | unsupported/degraded explicitly |
| citations | provider-dependent | provider-dependent | no silent loss |
| midstream usage | provider-dependent | provider-dependent | degraded allowed if final exact |
| refusal | semantic mismatch | semantic mismatch | decide before release |
| provider-specific metadata | prove round trip | prove round trip | required where continuation depends on it |

The adapter should ship only after the required rows have tests.

---

## 7. Second integration axis: use effect-uai capabilities behind Affe batteries/services

The model adapter is only one opportunity.

`effect-uai` has a broad capability/provider ecosystem that Affe should reuse where it already has an appropriate seam.

### 7.1 Web search/read

Potential integrations:

```text
affe /web or research battery
    <- effect-uai WebSearch
    <- effect-uai WebRead
```

This could expose Exa, Tavily, Perplexity, Firecrawl, or future providers without Affe writing provider SDK integrations itself.

The Affe layer should translate those services into the existing Affe tool/service contracts rather than making the kernel understand provider-specific search APIs.

### 7.2 Memory / RAG

Potential integrations:

```text
affe memory / ingestion
    <- effect-uai EmbeddingModel
    <- effect-uai Reranker
    <- effect-uai Chunker
```

This is a particularly good fit because embeddings/reranking are environmental services, not session semantics.

### 7.3 Browser/research

Potential integrations:

```text
research/coding battery
    <- effect-uai Browser
    <- effect-uai DeepResearch
```

Treat these as replaceable capability services, not root Affe nouns.

### 7.4 Sandbox

Potential integrations:

```text
affe /sandbox implementation
    <- effect-uai Microsandbox
    <- effect-uai Deno sandbox
```

Do not weaken Affe's workspace lifetime or sandbox conformance semantics merely to mirror effect-uai. An adapter is acceptable only if it implements the Affe seam honestly.

### 7.5 Voice / media

Potential application-level integrations:

```text
voice app
    <- effect-uai Transcriber
    <- effect-uai SpeechSynthesizer

media tool
    <- effect-uai ImageGenerator
    <- effect-uai MusicGenerator
```

These should usually enter Affe as services/tools/batteries. They do not need kernel support simply because effect-uai exposes them.

---

## 8. Tool interoperability: useful, but phase two

A second compatibility direction is importing an effect-uai Toolkit into an Affe agent.

A possible API shape:

```ts
const affeTools = EffectUaiTools.fromToolkit(uaiToolkit)
```

This is attractive because it would let applications reuse effect-uai's provider/tool ecosystem directly.

However, it is harder than the LanguageModel adapter because schema/type systems differ.

`effect-uai` intentionally accepts tools backed by Standard Schema + Standard JSON Schema. That includes Effect Schema but also Zod, Valibot, ArkType, and other compatible libraries.

Effect AI tools are centered on Effect `Schema` and use those schemas for typed parameters/results/failures.

Therefore classify tool bridges:

### Tier A — lossless/typed

The effect-uai tool was originally built from Effect Schema and exposes enough information to reconstruct an Effect AI tool with exact parameter/output types.

This is the ideal path.

### Tier B — validated but type-erased

A Standard Schema tool can preserve runtime validation and JSON Schema, but an Effect AI boundary may only know the decoded value as `unknown` without a corresponding Effect Schema type.

That can still be useful for dynamic/discovered tools, but the API must say that precision was lost.

### Tier C — descriptor only

A provider/signal/interaction tool may be model-visible but intentionally not locally executable.

Map it only if Affe has an honest equivalent disposition. Do not fabricate a local handler that throws merely to fit the type.

Do not advertise bidirectional “seamless tools” until these tiers have compile-time and runtime tests.

---

## 9. Provider fallback across ecosystems

Once `effect-uai` can provide an Effect AI `LanguageModel`, Affe's existing execution-plan/fallback machinery can potentially route between official Effect AI providers and effect-uai-backed providers.

Conceptually:

```text
ExecutionPlan
    |
    +-- official Effect AI Anthropic
    |
    +-- effect-uai Mistral adapter
    |
    +-- effect-uai enterprise gateway
```

This is valuable because it means Affe does **not** need a new cross-ecosystem fallback subsystem.

But provider metadata and history portability become critical. A fallback must not resend provider-specific assistant content in a form that changes meaning or drops required continuation state.

The compatibility conformance suite must include mixed-provider histories before cross-ecosystem fallback is documented as supported.

---

## 10. Packaging recommendation

A real workspace would make optional compatibility code much cleaner.

Recommended repository shape (illustrative, not mandatory naming):

```text
packages/
  affe-agent/                 # existing package, or root package remains here
  effect-uai-compat/          # optional adapter package

apps/
  cli/
  tui/

recipes/
  effect-uai-model/
  effect-uai-web-search/
```

If moving the root package is too disruptive, the repository can still become a workspace while keeping the main package at `.`:

```yaml
packages:
  - "."
  - "packages/*"
  - "apps/*"
  - "recipes/*"
```

The important properties are:

- one reproducible install for CI;
- optional compatibility dependencies do not pollute the main runtime;
- compatibility package has its own tests;
- peer-version ranges are explicit;
- recipes compile against packed/published surfaces, not private imports.

Do not make a workspace migration contingent on the effect-uai adapter. It is independently useful.

---

## 11. Proposed implementation sequence

### Phase 0 — write the compatibility contract

No production code.

Define:

- supported Effect AI prompt parts;
- supported effect-uai history items;
- translation loss policy;
- error mapping;
- provider metadata policy;
- refusal policy;
- streaming lifecycle mapping;
- required conformance rows.

Acceptance: reviewers can identify exactly what is unsupported before reading implementation.

### Phase 1 — batch `LanguageModel` adapter, text only + tool calls

Implement an optional adapter backed by `LanguageModel.make`.

Support only:

- system/user/assistant text;
- reasoning if directly representable;
- local tool descriptors;
- returned tool calls;
- tool result history;
- final usage/finish reason.

No local tool execution inside the adapter.

Acceptance:

- existing Affe `AgentSession` runs unchanged;
- a tool call passes through the adapter and is executed by Affe `ToolExecution`;
- permission/approval behavior is identical to an official Effect AI provider;
- canonical history contains the same semantic turn.

### Phase 2 — streaming

Map `TurnEvent` to Effect AI streaming response parts.

Acceptance:

- text/reasoning/tool-argument deltas render through existing Affe events;
- interleaved tool calls remain separate;
- interruption closes the Affe observation lifecycle correctly;
- partial-stream failure does not allow a fallback to produce a mixed visible message.

### Phase 3 — multimodal + metadata

Add:

- images;
- representable files;
- citations/sources;
- provider-specific metadata round trips;
- explicit degradation for remaining mismatches.

Acceptance:

- snapshot/restore preserves provider continuation data;
- durable replay does not change the translated request;
- unsupported media fails or warns according to the published table.

### Phase 4 — non-model capability adapters

Pick only integrations that satisfy a real Affe seam, likely in this order:

1. `WebSearch` / `WebRead`;
2. embedding/reranker services;
3. sandbox provider;
4. browser/research;
5. voice/media as demand appears.

Each gets conformance tests against the Affe seam rather than special cases in the kernel.

### Phase 5 — effect-uai Toolkit import experiment

Prototype tool translation after the model adapter is stable.

Prove the three schema/type tiers above.

If the bridge cannot preserve Affe's no-user-casts rule for the typed tier, do not promote it to a normal authoring path.

### Phase 6 — evaluate whether a deeper model substrate is justified

Only now ask whether `effect/unstable/ai` should become replaceable inside the kernel.

Evidence that would justify it:

- important effect-uai capabilities cannot be expressed through Effect AI's provider SPI;
- the adapter requires repeated semantic reconstruction in multiple Affe modules;
- provider metadata cannot survive the canonical Effect AI representation;
- supporting a second ecosystem causes pervasive unsafe casts or `unknown` in ordinary Affe user code;
- Effect AI instability creates repeated kernel-wide breakage that a narrow Affe substrate would actually contain.

Without such evidence, stop at the adapter.

---

## 12. What not to copy

### Do not replace the Affe execution kernel with a generic loop

The generic loop is a good primitive for effect-uai's layer. It would erase the cross-client/durable semantics Affe is designed to own.

### Do not duplicate provider SDKs in Affe

Do not build parallel OpenAI/Anthropic/Gemini/Mistral wrappers merely for provider breadth. Use Effect AI and/or effect-uai adapters.

### Do not invent a new universal AI vocabulary prematurely

Avoid `AffePrompt`, `AffeTool`, `AffeResponse`, etc. until a real incompatibility proves the need.

### Do not import all effect-uai capabilities into core

Search, embedding, reranking, browser, speech, image, and sandbox services belong behind batteries/services/adapters unless they change session semantics.

### Do not promise lossless translation where it is not lossless

A bridge that silently drops files, provider metadata, refusal distinctions, or reasoning continuation state is worse than no bridge because durable history will look authoritative while being false.

---

## 13. Acceptance tests worth adding even before integration

Studying effect-uai suggests several useful Affe tests independent of any adapter.

### Provider continuation round trip

For every provider-specific metadata field Affe accepts:

```text
response -> history -> PromptWire -> snapshot/export -> decode -> next request
```

must preserve it.

### Mixed-provider history

A turn produced by provider A can be replayed to provider B with every unsupported field either:

- translated;
- explicitly degraded;
- explicitly rejected.

No silent omission.

### Tool disposition audit

Every model-visible tool/capability is classified by who executes it:

- provider;
- Affe/local;
- external actor;
- harness/control flow.

No code path accidentally executes a provider-executed tool locally.

### Compatibility mutation tests

For the eventual adapter, deliberately break:

- tool-call ID preservation;
- argument-fragment association;
- reasoning metadata preservation;
- finish reason mapping;
- file mapping;
- provider metadata round trip.

The conformance tests must fail for the intended reason.

---

## 14. Ranked recommendations

### P0 — do regardless of direct integration

1. Use effect-uai's minimalism as a kernel-scope review rule.
2. Audit provider-specific continuation metadata across Affe history/durability boundaries.
3. Adopt an explicit exact/degraded/unsupported policy for cross-representation adapters.
4. Move toward a real workspace/reproducible nested-app install.
5. Expand small typed recipes without replacing reference agents.

### P1 — high-value integration

6. Build an optional `effect-uai -> Effect AI LanguageModel` adapter.
7. Build a translation conformance matrix before adding multimodal claims.
8. Prove an effect-uai-backed model executes tools through Affe, not through effect-uai.
9. Use Affe `ExecutionPlan` for fallback across official and adapted model providers.

### P2 — reuse their capability ecosystem

10. Add effect-uai-backed implementations for Affe web/search and memory/RAG seams.
11. Evaluate effect-uai sandbox providers against Affe sandbox conformance.
12. Add browser/research and voice/media adapters only where a real application needs them.

### P3 — experimental

13. Prototype typed effect-uai Toolkit import.
14. Consider upstreaming a compatibility package to the `effect-uai` project if the maintainers want it.
15. Revisit an Affe-owned model substrate only if adapter evidence demands it.

---

## 15. Decision

The desired end state is not:

```text
affe-agent replaces Effect AI with effect-uai
```

and not:

```text
affe-agent reimplements effect-uai
```

It is:

```text
                         affe-agent
                 execution/session semantics
                           |
                           | canonical Effect AI boundary
                           |
             +-------------+-------------+
             |                           |
             v                           v
     Effect AI providers       optional effect-uai adapter
                                         |
                                         v
                               effect-uai provider ecosystem
```

with orthogonal capability adapters:

```text
affe web/search   <- effect-uai WebSearch / WebRead
affe memory/RAG   <- effect-uai Embedding / Reranker / Chunker
affe sandbox      <- effect-uai sandbox implementations
research battery  <- effect-uai Browser / DeepResearch
voice/media app   <- effect-uai STT / TTS / image / music
```

This keeps the responsibilities clean:

- **Effect AI / effect-uai:** provider and AI capability ecosystems.
- **Affe adapters/batteries:** translation and optional capability implementations.
- **Affe kernel:** durable, observable, permissioned agent execution semantics.

The design rule is:

> **Adapt other AI ecosystems into the narrow Effect AI boundary first. Abstract Effect AI out of Affe only after a real adapter proves the boundary is insufficient.**

That is the path most likely to get the best of both projects without turning `affe-agent` into the layer it currently benefits from delegating.