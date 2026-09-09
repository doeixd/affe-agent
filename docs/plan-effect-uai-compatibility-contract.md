# effect-uai compatibility contract (Phase 0)

**Status: Phase 0 written 2026-09-08; Phase 1 implemented the same day** as
`src/effect-uai` (`affe-agent/effect-uai`), with `@effect-uai/core` as an
optional peer dependency and the §4 rows as `test/EffectUaiModel.test.ts`. §9
records what writing and then reviewing the adapter changed about this
document. This is Phase 0 of
[plan-effect-uai-integration.md](./plan-effect-uai-integration.md) §11, which
asks for the translation contract to be written and reviewable *before* an
adapter exists, so that "reviewers can identify exactly what is unsupported
before reading implementation."

**Read:** 2026-09-08, against `@effect-uai/core@0.14.0` (unpacked from the npm
tarball; **not** added to `package.json`) and `effect@4.0.0-rc.112`'s
`unstable/ai/{LanguageModel,Prompt,Response}`.

The subject is the one adapter §4.1 recommends first:

```text
affe-agent  ->  Effect AI LanguageModel.make  ->  @effect-uai/core LanguageModel  ->  providers
```

Nothing here proposes a kernel change. `src/` is untouched by Phase 0.

---

## 1. The two SPIs, as they actually are

Effect AI's provider seam is `LanguageModel.make`, which asks for two hooks:

```ts
generateText: (options: ProviderOptions) =>
  Effect.Effect<Array<Response.PartEncoded>, AiError.AiError, IdGenerator>
streamText: (options: ProviderOptions) =>
  Stream.Stream<Response.StreamPartEncoded, AiError.AiError, IdGenerator>
```

`ProviderOptions` carries `prompt`, `tools`, `responseFormat`, `toolChoice`,
`span`, `previousResponseId` and `incrementalPrompt`.

effect-uai's service is:

```ts
streamTurn: (request: CommonRequest) => Stream.Stream<TurnEvent, AiError>
turn:       (request: CommonRequest) => Effect.Effect<Turn, AiError>
```

`CommonRequest` carries `history`, `model`, `tools`, `toolChoice`,
`temperature`, `topP`, `maxOutputTokens` and `structured`.

The shapes correspond closely enough for the adapter to be practical. The rest
of this document is the places where they do not.

---

## 2. Four findings that change the adapter's design

These were not visible from the shape of the two APIs; they came out of reading
the declarations. Each one decides something before implementation starts.

### 2.1 The model identifier is bound at construction, not per request

Effect AI does not put a model id in `ProviderOptions` at all — on our side the
model is fixed when the layer is built. effect-uai does the opposite: `model` is
a required field of every `CommonRequest`, deliberately, so that "models are not
bound at layer construction."

**Decision.** The adapter constructor takes the model id (and any provider-typed
narrowing) and closes over it. This is `Exact` — no information is lost — but it
means one adapter instance is one model, which is the shape Affe's
`ExecutionPlan` fallback already expects (§9 of the plan). Do not try to read a
model id out of `ProviderOptions`; there is none.

### 2.2 A batch turn silently loses reasoning text — so `generateText` must drain the stream

This is the sharpest mismatch in the contract.

Effect AI's `ReasoningPartEncoded` has a **required** `text`. effect-uai's
`Reasoning` history item has `id`, `summary`, `signature` and `providerData` —
and **no raw text field**. Reasoning text exists on the effect-uai side only as
the `ReasoningDelta` *event*, never as an item on the assembled `Turn`.

So `LanguageModel.turn(...)`, which returns only the assembled `Turn`, cannot
produce Effect AI reasoning parts with their text. An adapter that implemented
`generateText` by calling `turn` would emit reasoning parts with empty or
summary-only text and look correct.

**Decision.** The adapter implements **both** hooks over `streamTurn`, and
`generateText` accumulates the stream to a part array. It must not call
effect-uai's `turn`, and the reason must be a comment at the call site, because
`turn` is otherwise the obvious choice and the loss is invisible in types.

This also means the batch and streaming paths share one translator, which is
what §6's mutation tests want anyway.

### 2.3 Effect AI's incremental-request fields have no counterpart

`ProviderOptions.previousResponseId` and `ProviderOptions.incrementalPrompt`
exist so a provider can send only the messages it has not seen. `CommonRequest`
has no equivalent: every effect-uai call carries its whole `history`.

**Decision.** `Unsupported`, handled by *ignoring the optimisation, not the
data*. The adapter always translates the full `prompt` and never
`incrementalPrompt`, and never reports a `previousResponseId` back. That is
correct but not cheap, and it must be documented as a cost rather than left for
someone to discover from a bill. It is not a semantic loss: the full prompt is
always sufficient.

The related question — whether a provider-side cache key or continuation token
could ride in `providerData` — is Phase 3 work (§4.6 below), not Phase 1.

### 2.4 Files are images-only on the effect-uai side, in both directions

Affe shipped end-to-end multimodality (`plan-filetypes.txt` phases 1–5), so this
is a live regression risk rather than a hypothetical.

* **Request side.** Effect AI's `Prompt.FilePartEncoded` is any `mediaType` with
  `data: string | Uint8Array | URL` — PDFs and arbitrary documents included.
  effect-uai's user-side content block is `input_image`, whose source is an
  `ImageSource` (`url` / `base64` / `bytes`, image MIME types).
* **Response side.** Effect AI's `Response.FilePartEncoded` is any `mediaType`
  base64. effect-uai's assistant-side block is `output_image`, again images.

**Decision.** An image file maps `Exact` in both directions (the three
`ImageSource` variants cover Effect AI's three `data` representations). A
**non-image** file is `Unsupported` and must **fail before the request is
issued** — not be dropped, and not be flattened into text. Affe already learned
this invariant once, in the canonical-history rule that a returned file must not
vanish through a convenience conversion; the adapter inherits it.

---

## 3. Supported surface, Phase 1

Phase 1 is text and tool calls. The adapter accepts exactly this and rejects the
rest explicitly.

**Prompt in:** system / user / assistant text; assistant reasoning; tool calls;
tool results; user images.

**Response out:** text; reasoning; tool calls; finish reason; usage.

**Request options in:** tool choice, and structured output — the latter because
`AgentOutput` needs it, not because it is easy (§4.0).

Everything in §4 that is not marked *required* is out of scope for Phase 1 and
must produce an `Unsupported` failure rather than a best effort.

---

## 4. Conformance rows

The policy column is the contract. `required` rows must have tests before the
adapter ships; `Unsupported` rows must have a test proving they *fail*.

### 4.0 Request options, Effect AI -> effect-uai

Easy to skip, because the two `CommonRequest` fields look like the two
`ProviderOptions` fields. Two of the four rows are not.

| Effect AI | effect-uai | fidelity | policy |
| --- | --- | --- | --- |
| `toolChoice` `"auto"` / `"none"` / `"required"` | same three literals | Exact | required |
| `toolChoice` `{ tool }` | `{ type: "function", name }` | Exact | required |
| `toolChoice` `{ mode?, oneOf }` | — | Degraded | required |
| `responseFormat: { type: "text" }` | `structured` omitted | Exact | required |
| `responseFormat: { type: "json", objectName, schema }` | `structured` via `fromEffectSchema` | Exact | required |

**`oneOf` has no counterpart.** effect-uai's `toolChoice` can name one function
or none; it cannot express "restrict the model to this subset." The honest
translation is to *render only the subset* into the effect-uai `Toolkit` and map
`mode` to `auto` / `required`. The model could not have called the excluded
tools either way, so the permitted behaviour is unchanged — but the excluded
tools are no longer *described* to the model, and a description can change what
the model does with the tools it kept. That is why this is `Degraded` and not
`Exact`, and it is the kind of difference that is invisible unless someone
writes it down first.

**Structured output is Phase 1, not Phase 3.** Affe's `AgentOutput` rides on
`generateObject`, which Effect AI implements over the *`generateText` hook* plus
a `codecTransformer`. So the adapter cannot defer structured output and still
claim "an existing `AgentSession` runs unchanged" (§7.1). The bridge exists and
is theirs: `StructuredFormat.fromEffectSchema` wraps an Effect `Schema` as the
Standard Schema / Standard JSON Schema pair effect-uai wants, which is exactly
the `Schema.Top` that `responseFormat` carries. `objectName` maps to `name`.

Because effect-uai's providers constrain the wire themselves, the adapter should
pass `structured` through and leave `LanguageModel.make`'s `codecTransformer`
unset rather than transforming the schema twice. That is an assumption, so it is
a test: a structured request must decode to the same value it would have from an
official provider.

### 4.1 History, Effect AI -> effect-uai

| Effect AI | effect-uai | fidelity | policy |
| --- | --- | --- | --- |
| system message text | `Message` role `system` + `input_text` | Exact | required |
| user text | `Message` role `user` + `input_text` | Exact | required |
| assistant text | `Message` role `assistant` + `output_text` | Exact | required |
| assistant reasoning `text` | `Reasoning` — **no text field** | Degraded | required, §4.6 |
| reasoning signature (metadata) | `Reasoning.signature` | Exact | required |
| tool call `id` / `name` | `function_call` `call_id` / `name` | Exact | required |
| tool call `params` | `function_call.arguments` | Degraded | required |
| tool result | `function_call_output` `call_id` / `output` | Exact | required |
| user file, `image/*` | `input_image` + `ImageSource` | Exact | required |
| user file, non-image | — | Unsupported | required (must fail) |
| `ToolApprovalRequestPart` / `ToolApprovalResponsePart` | — | Unsupported | required (must fail) |
| `previousResponseId` / `incrementalPrompt` | — | Unsupported | ignored, full history sent (§2.3) |

**Tool arguments cannot cross without a re-encode, and that is a real loss.**
effect-uai's `function_call.arguments` is a `string`. Effect AI's `params` is
`unknown` — a *parsed* value, on both the prompt and the response side. Effect
AI never retains the argument string the provider actually produced, so:

* **uai -> Effect AI** is `JSON.parse(arguments)`. The value survives; the exact
  bytes do not. A model that emits malformed JSON produces a translation
  failure, not a silent empty object, and that is a `required` test (§6).
* **Effect AI -> uai** is `JSON.stringify(params)`. Key order and whitespace are
  whatever `JSON.stringify` chooses, and the provider's original string is
  unrecoverable.

This matters when a prior tool call is replayed into a later request: a provider
that hashes or signs the argument string sees a different string than it sent.
No re-encode is available that would avoid it, because the original was already
discarded upstream of the adapter — so this is `Degraded` and declared, not a
defect to fix here. If a provider is found that actually breaks on it, the fix
belongs in Effect AI's prompt representation, not in this adapter.

### 4.2 Tools

effect-uai renders a `Toolkit` to wire descriptors itself. The adapter needs
name, description and JSON parameter schema per tool, and nothing else.

| property | policy |
| --- | --- |
| the adapter builds descriptor-only effect-uai tools | required |
| the adapter never gives effect-uai a handler | required |
| the original Effect AI toolkit stays on the Affe side | required |
| a returned call is executed by Affe `ToolExecution` | required |

This is the ownership rule from §4.1 of the plan, and it is what preserves every
Affe permission, concurrency, lifecycle and replay semantic.

**It turned out to be structural rather than a matter of discipline.** effect-uai
has four tool kinds, and one of them — `SignalTool` — is defined as
"model-visible and decodable but never locally executed: the loop intercepts the
call and acts on it, so there is no fake `run`." Affe *is* that loop. Rendering
every Effect AI tool as a `SignalTool` means there is no handler for effect-uai
to call and no way to add one without changing the tool kind, so the rule cannot
be violated by a later edit that merely looks reasonable.

That is a better outcome than the one this contract originally planned for,
which was a `Tool.make` carrying a `run` that dies if reached — a fake handler
whose only job is to be unreachable. Plan §8 warns against exactly that shape in
the other direction ("do not fabricate a local handler that throws merely to fit
the type"), and it was just as wrong here.

### 4.3 Responses, effect-uai -> Effect AI

| effect-uai | Effect AI | fidelity | policy |
| --- | --- | --- | --- |
| `TextDelta` | text start / delta / end | Exact | required |
| `ReasoningDelta` (`trace`) | reasoning start / delta / end | Exact | required |
| `ReasoningDelta` (`summary`) | reasoning parts, marked in metadata | Degraded | required |
| `ToolCallStart` + `ToolCallArgsDelta` | tool-params start / delta / end, then `tool-call` | Exact | required |
| a streamed call absent from `TurnComplete` | nothing — not started-and-closed | Exact | required |
| `UsageUpdate` | cumulative; **not** added to the finish usage | Exact | required |
| `TurnComplete.turn.usage` | `FinishPart.usage` | Exact | required |
| `RefusalDelta` / `stop_reason: "refusal"` | see §4.5 | Degraded | required |
| `CitationAdded` / `url_citation` | `UrlSourcePart` | Exact | required |
| `file_citation` | — | Unsupported | required (must fail) |
| `container_file_citation`, `file_path` | — | Unsupported | required (must fail) |
| `ImageOutput` (finished, base64 or bytes) | `FilePartEncoded` | Exact | required |
| `ImageOutput` (finished, url) | — | Unsupported | required (must fail) |
| `ImageOutput` (`partialIndex` set) | — | dropped, deliberately | required |
| `WebSearchCall` | — | Unsupported | Phase 3 |

**`file_citation` was `Degraded` in the first draft and is `Unsupported`.**
Effect AI's `DocumentSourcePart` *requires* a title and a media type.
effect-uai's file citation carries a file id and an index and nothing else, so
the only way to produce that part is to invent both. Invented metadata in
canonical history is worse than a citation that does not cross: the second is
visible and the first is not. `container_file_citation` and `file_path` are the
same case.

**An image the provider only pointed at cannot cross either.** Effect AI's
*prompt* file part accepts a URL; its *response* file part carries base64 and
has no URL form. Fetching it here would be a network request the caller never
asked for, made by a translation layer, so a URL image is `Unsupported` and
base64 and bytes are `Exact`.

`ImageOutput` preview frames are dropped rather than degraded because the
finished image also arrives on `TurnComplete.turn`; emitting both would put the
same image in canonical history twice. That is a decision, so it gets a test.

`UsageUpdate` is cumulative, and `TurnComplete` carries the final usage. Adding
them is the natural bug and the plan names it ("usage/finish metadata is not
double-counted"), so it is a required row.

**`TurnComplete` is the authority on which calls exist.** A provider may start
streaming a call and abandon it, leaving fragments with no `function_call` item
on the finished turn. Those fragments must not be closed. This is sharper than
it looks: Affe reconstructs a tool call from the params stream itself, so a
`tool-params-end` the provider never earned is enough to fabricate a call the
model never made — and Affe would then execute it, with permissions and
canonical history recording a call that did not happen. Emitting `tool-call`
only for completed calls is not sufficient on its own; the close has to be
withheld too.

Effect AI's `Usage` is the richer of the two — `inputTokens` with `uncached`,
`cacheRead`, `cacheWrite`, and `outputTokens` with `text` and `reasoning` — and
effect-uai's `input_tokens_details.cached_tokens` / `cache_write_tokens` and
`output_tokens_details.reasoning_tokens` land in it without loss. The unmapped
Effect AI fields are left absent, not zeroed; a zero would read as measured.

### 4.4 Finish reasons

| effect-uai `stop_reason` | Effect AI `FinishReason` | fidelity |
| --- | --- | --- |
| `stop` | `stop` | Exact |
| `tool_calls` | `tool-calls` | Exact |
| `max_tokens` | `length` | Exact |
| `content_filter` | `content-filter` | Exact |
| `refusal` | `content-filter` (§4.5) | Degraded |
| `max_tool_calls` | `other`, reason in metadata | Degraded |

Effect AI's `pause`, `error` and `unknown` have no effect-uai source and are
never produced by this adapter.

### 4.5 Refusal — decided

The plan asks for this to be decided before release, so: **a refusal maps to
`content-filter` and its text is emitted as a text part, never silently as an
ordinary successful answer.**

The reasoning is that Affe observers and retry policies care about the
*distinction*, and `content-filter` is the only Effect AI finish reason that
carries "the model declined" rather than "the model finished." Mapping to `stop`
would make a refusal indistinguishable from an answer, which is exactly the
class of silent lie §12 forbids.

Note the asymmetry effect-uai documents: only OpenAI Responses emits a
`RefusalDelta`; Anthropic and Gemini signal refusal through `stop_reason` and
`finishReason: SAFETY` respectively. So the adapter must derive refusal from
`stop_reason` as well as from the event, or it will be right for one provider
and wrong for two.

### 4.6 Provider data — the round trip to prove

effect-uai puts an opaque `providerData` slot on every history item
(`Message`, `function_call`, `function_call_output`, `Reasoning`). Effect AI
carries the equivalent as part metadata.

Plan §3.3 is explicit that we must not add an Affe `providerData` field just
because effect-uai has one, and must first prove whether Effect AI's existing
metadata survives every Affe boundary. That proof is the Phase 3 gate, and the
property is:

```text
provider response -> canonical Affe history -> PromptWire
    -> snapshot / durable journal / transport -> restore -> next request
```

The field that makes this urgent rather than theoretical is the reasoning
signature (§2.2, §4.1). Anthropic will not continue a reasoning turn without it,
so if the signature does not survive that path, cross-provider fallback (§9 of
the plan) is not merely degraded — it fails.

**Audited 2026-09-08, and it holds** (`test/ProviderContinuation.test.ts`).
Every hop the property names preserves a reasoning signature: response ->
canonical history -> next request, `PromptWire` encode/decode, snapshot ->
restore -> next request, and durable replay across a suspension. Each of the
end-to-end tests fails when the signature is removed from the script, so they
are measuring the thing rather than agreeing with it.

Two things that audit is worth knowing for:

* **It is not an effect-uai question.** The tests use the ordinary scripted
  model and no adapter. Had it failed, snapshot/restore and durable replay
  would silently break reasoning continuation for the *official* Anthropic
  provider today.
* **The durable hop had no coverage.** `DurableReplayHistory.test.ts` asserts
  that a replayed submission rebuilds the same conversation, but the shape it
  compares renders every reasoning part as an empty detail — so a replay that
  dropped every signature would have passed it while handing the next turn a
  conversation the provider refuses to continue.

The audit also corrected an assumption in this document. Effect AI does not
treat provider metadata as an opaque bag: it is **typed per provider through
module augmentation**, and Anthropic's reasoning signature lives at
`options.anthropic.info.signature` inside a discriminated thinking block. A
flatter invented shape type-errors, which is how the first draft of the audit
was caught testing a field no provider writes.

That has one consequence for cross-ecosystem work. The adapter writes the
signature under its own namespaced key, which an *official* Anthropic adapter
would not read — fine while a conversation stays on one provider, and exactly
the mixed-provider question plan §9 defers until the conformance suite covers
mixed histories. The adapter's request-side reader is deliberately generic (it
looks for a nested `signature` anywhere in the options) so it tolerates either
shape on the way back in.

**Phase 3 carries provider options across the gap where the two shapes line up**
(2026-09-08). effect-uai gives each history item an opaque `providerData` slot
and Effect AI carries the same thing as a part's `options`, so a tool call, a
tool result and a reasoning block each cross verbatim -- beside the signature
rather than instead of it.

**And they come back.** A returned item's `providerData` becomes part metadata,
because state that goes into a provider and never comes out reads as a round
trip right up until something needs the value. The first version of this only
did the outbound half and the commit message called it a round trip anyway.

**A message's content blocks cannot.** A uai `Message` has one `providerData`
slot and many blocks, so options belonging to one block have nowhere to sit.
Nothing can be done about that here; what is done is saying so, because the
first version dropped them without a word, which is precisely the failure §5
exists to prevent. It was my own rule broken in my own adapter, and it was
invisible -- a prompt-cache hint that quietly stops crossing costs money and
changes nothing observable.

What remains unproven is per-provider rather than structural: that a *given*
provider reads back what it wrote. The transport is measured by
`test/ProviderContinuation.test.ts` for Affe's own boundaries and by the rows
above for this one; whether Anthropic's cache control still applies after a
round trip through effect-uai is a question only a network test answers, and
§9's cross-ecosystem note still stands: this adapter writes its signature under
its own namespaced key, which an official Anthropic adapter would not read.

* **Dynamic tools are untested.*** **Dynamic tools are untested.** Tools whose parameters are a raw JSON schema
  rather than an Effect `Schema` go through the same path, but no `toolSource`
  test covers them yet.
