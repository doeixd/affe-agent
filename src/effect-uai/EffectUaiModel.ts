/**
 * An `effect-uai` provider behind Effect AI's `LanguageModel`.
 *
 * This is the adapter `docs/plan-effect-uai-integration.md` §4.1 recommends
 * building first, and it implements the contract written in
 * `docs/plan-effect-uai-compatibility-contract.md`. Read that contract before
 * changing anything here: most of what looks like an arbitrary choice below is
 * a row in one of its tables, and several of them are load-bearing.
 *
 * The shape:
 *
 * ```text
 * affe-agent  ->  Effect AI LanguageModel  ->  this  ->  @effect-uai/core  ->  providers
 * ```
 *
 * What this adapter deliberately does **not** do is execute tools. It describes
 * them to the model and nothing more; the returned call goes back to Affe's
 * `ToolExecution`, which is what preserves every permission, concurrency,
 * lifecycle, atomicity and replay semantic the kernel owns. That rule is not a
 * convention here — see `toToolkit`, which makes it a type-level property.
 */
import { Effect, Layer, Option, Stream } from "effect"
import { AiError, LanguageModel, Prompt, Response, Tool } from "effect/unstable/ai"
import * as UaiItems from "@effect-uai/core/Items"
import * as UaiLanguageModel from "@effect-uai/core/LanguageModel"
import * as UaiTool from "@effect-uai/core/Tool"
import * as UaiToolkit from "@effect-uai/core/Toolkit"
import type { Turn as UaiTurn, TurnEvent } from "@effect-uai/core/Turn"
import * as Compatibility from "./Compatibility.js"

/** Named in every error this module raises, so a translation failure is never mistaken for a provider failure. */
const MODULE = "@effect-harness/effect-uai"

const EFFECT_AI = "effect-ai"
const EFFECT_UAI = "effect-uai"

/**
 * Options for {@link make}.
 *
 * `model` is here rather than on each request because the two ecosystems
 * disagree about where a model identifier lives: Effect AI binds it when the
 * layer is built and carries none on `ProviderOptions`, while effect-uai
 * requires one on every `CommonRequest`. One adapter instance is therefore one
 * model, which is the shape `ExecutionPlan` fallback already expects.
 */
export interface Options {
  /** The provider's model identifier, passed through to every request. */
  readonly model: string
  /**
   * Called whenever a conversion succeeds but loses information.
   *
   * Defaults to a debug log. A test — or a caller that wants to surface
   * degradation to a user — passes a collector instead.
   */
  readonly onDegraded?: Compatibility.OnDegraded | undefined
  readonly temperature?: number | undefined
  readonly topP?: number | undefined
  readonly maxOutputTokens?: number | undefined
}

const unsupported = (params: {
  readonly feature: string
  readonly source: string
  readonly target: string
  readonly reason: string
}) => new Compatibility.UnsupportedConversion(params)

/**
 * An `UnsupportedConversion` at the hook boundary, where the signature demands
 * an `AiError`.
 *
 * The `module` is ours, so a caller can still tell a translation refusal from a
 * provider refusal — which is the invariant the contract's §6 actually asks
 * for, rather than the particular reason tag.
 */
const asAiError = (
  method: string,
  direction: "request" | "response"
) =>
(error: Compatibility.UnsupportedConversion): AiError.AiError =>
  AiError.make({
    module: MODULE,
    method,
    reason: direction === "request"
      ? new AiError.InvalidRequestError({ description: error.message })
      : new AiError.InvalidOutputError({ description: error.message })
  })

// -------------------------------------------------------------------------------------
// request: Effect AI -> effect-uai
// -------------------------------------------------------------------------------------

const imageSourceFor = (
  part: Prompt.FilePart
): Option.Option<UaiItems.InputImage["source"]> => {
  if (!part.mediaType.startsWith("image/")) return Option.none()
  const mimeType = part.mediaType
  if (part.data instanceof URL) {
    return Option.some({ _tag: "url", url: part.data.toString(), mimeType })
  }
  if (typeof part.data === "string") {
    return Option.some({ _tag: "base64", base64: part.data, mimeType })
  }
  return Option.some({ _tag: "bytes", bytes: part.data, mimeType })
}

/**
 * A user file as an effect-uai content block.
 *
 * effect-uai's user-side block is `input_image` and nothing else, while Effect
 * AI's `FilePart` takes any media type. A PDF has nowhere to go, so this
 * fails rather than dropping it or flattening it into text: Affe shipped
 * multimodality, and a silently missing document in canonical history is
 * exactly the failure the canonical-history rule already forbids.
 */
const fileBlock = (part: Prompt.FilePart) =>
  Option.match(imageSourceFor(part), {
    onNone: () =>
      Effect.fail(unsupported({
        feature: `file of media type ${part.mediaType}`,
        source: EFFECT_AI,
        target: EFFECT_UAI,
        reason: "effect-uai represents user files as input_image only, so a non-image file has no equivalent block"
      })),
    onSome: (source) => Effect.succeed<UaiItems.ContentBlock>({ type: "input_image", source })
  })

/**
 * The prompt as effect-uai history.
 *
 * `providerData` is left off every item: Phase 1 of the plan does not claim the
 * provider round trip, and writing an empty slot would suggest it had been
 * considered and found empty rather than not yet attempted.
 */
export const toHistory = (
  prompt: Prompt.Prompt,
  onDegraded: Compatibility.OnDegraded
): Effect.Effect<ReadonlyArray<UaiItems.HistoryItem>, Compatibility.UnsupportedConversion> =>
  Effect.gen(function*() {
    const items: Array<UaiItems.HistoryItem> = []
    for (const message of prompt.content) {
      switch (message.role) {
        case "system": {
          items.push({
            type: "message",
            role: "system",
            content: [{ type: "input_text", text: message.content }]
          })
          break
        }
        case "user": {
          const content: Array<UaiItems.ContentBlock> = []
          for (const part of message.content) {
            if (part.type === "text") {
              content.push({ type: "input_text", text: part.text })
            } else {
              content.push(yield* fileBlock(part))
            }
          }
          items.push({ type: "message", role: "user", content })
          break
        }
        case "assistant": {
          const content: Array<UaiItems.ContentBlock> = []
          for (const part of message.content) {
            switch (part.type) {
              case "text": {
                content.push({ type: "output_text", text: part.text })
                break
              }
              case "reasoning": {
                // effect-uai's reasoning item has id/summary/signature and no
                // raw text field, so the text itself has nowhere to go. The
                // signature does, and it is the field a provider actually needs
                // to continue the turn -- so carry that and declare the rest.
                const signature = signatureOf(part.options)
                items.push({
                  type: "reasoning",
                  ...(Option.isSome(signature) ? { signature: signature.value } : {})
                })
                yield* onDegraded(
                  new Compatibility.Degradation({
                    feature: "reasoning text",
                    source: EFFECT_AI,
                    target: EFFECT_UAI,
                    reason: "effect-uai's reasoning history item carries id/summary/signature and no raw text"
                  })
                )
                break
              }
              case "tool-call": {
                items.push({
                  type: "function_call",
                  call_id: part.id,
                  name: part.name,
                  arguments: JSON.stringify(part.params)
                })
                yield* onDegraded(
                  new Compatibility.Degradation({
                    feature: "tool call argument encoding",
                    source: EFFECT_AI,
                    target: EFFECT_UAI,
                    reason:
                      "Effect AI keeps parsed params, so the provider's original argument string is re-encoded and its byte form is not recoverable"
                  })
                )
                break
              }
              case "file": {
                return yield* unsupported({
                  feature: `assistant file of media type ${part.mediaType}`,
                  source: EFFECT_AI,
                  target: EFFECT_UAI,
                  reason: "effect-uai represents assistant files as output_image only"
                })
              }
              default: {
                return yield* unsupported({
                  feature: `assistant part "${part.type}"`,
                  source: EFFECT_AI,
                  target: EFFECT_UAI,
                  reason: "effect-uai has no approval-request or approval-response history item"
                })
              }
            }
          }
          if (content.length > 0) {
            items.push({ type: "message", role: "assistant", content })
          }
          break
        }
        case "tool": {
          for (const part of message.content) {
            if (part.type !== "tool-result") {
              return yield* unsupported({
                feature: `tool message part "${part.type}"`,
                source: EFFECT_AI,
                target: EFFECT_UAI,
                reason: "effect-uai has no approval-response history item"
              })
            }
            items.push({
              type: "function_call_output",
              call_id: part.id,
              output: typeof part.result === "string" ? part.result : JSON.stringify(part.result)
            })
          }
          break
        }
      }
    }
    return items
  })

/**
 * The reasoning signature, if the part carries one.
 *
 * Providers put it under their own key, so this reads any string-valued
 * `signature` rather than naming one provider. Anthropic will not continue a
 * reasoning turn without it, which is why it is worth digging for.
 */
const signatureOf = (options: unknown): Option.Option<string> => {
  if (typeof options !== "object" || options === null) return Option.none()
  for (const value of Object.values(options)) {
    if (typeof value === "object" && value !== null && "signature" in value) {
      const signature = (value as { readonly signature: unknown }).signature
      if (typeof signature === "string") return Option.some(signature)
    }
  }
  return Option.none()
}

/**
 * A JSON schema as something effect-uai will accept as a tool input schema.
 *
 * `validate` accepts anything on purpose. This object exists only to carry a
 * JSON schema to the wire: the adapter never decodes a tool's arguments, and
 * Affe validates them against the original Effect `Schema` when it executes the
 * call. A validator here would be a second, weaker copy of a check that already
 * happens in the right place.
 */
const standardSchemaFor = (jsonSchema: Record<string, unknown>): UaiTool.ToolInputSchema<unknown> => ({
  "~standard": {
    version: 1,
    vendor: MODULE,
    validate: (value: unknown) => ({ value }),
    jsonSchema: { input: () => jsonSchema, output: () => jsonSchema }
  }
})

/**
 * The model-visible tools, as descriptors effect-uai cannot execute.
 *
 * Every tool becomes a `SignalTool`, which effect-uai defines as "model-visible
 * and decodable but never locally executed — the loop intercepts the call and
 * acts on it, so there is no fake `run`." Affe *is* that loop. So the ownership
 * rule the plan states as a requirement —
 *
 * > the adapter exposes tool descriptions to the model, but affe-agent
 * > continues to execute the original Effect AI handlers
 *
 * — holds structurally rather than by discipline: there is no handler here for
 * effect-uai to call, and no way to add one without changing the tool kind.
 */
export const toToolkit = (tools: ReadonlyArray<Tool.Any>): UaiToolkit.Toolkit =>
  UaiToolkit.fromArray(
    tools.map((tool) =>
      UaiTool.signal({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: standardSchemaFor(Tool.getJsonSchema(tool))
      })
    )
  )

/**
 * Tool choice, and the tools that survive it.
 *
 * effect-uai can name one function or none; it cannot express "restrict the
 * model to this subset". The honest translation of `oneOf` is to describe only
 * the subset, which leaves the permitted behaviour unchanged — the model could
 * not have called the others either way — but does change what it is told
 * about. That is a real difference, so it is reported rather than assumed
 * harmless.
 */
export const toToolChoice = (
  choice: LanguageModel.ToolChoice<string>,
  tools: ReadonlyArray<Tool.Any>,
  onDegraded: Compatibility.OnDegraded
): Effect.Effect<{
  readonly toolChoice: NonNullable<UaiLanguageModel.CommonRequest["toolChoice"]>
  readonly tools: ReadonlyArray<Tool.Any>
}> => {
  if (choice === "auto" || choice === "none" || choice === "required") {
    return Effect.succeed({ toolChoice: choice, tools })
  }
  if ("tool" in choice) {
    return Effect.succeed({
      toolChoice: { type: "function", name: choice.tool } as const,
      tools
    })
  }
  const allowed = new Set<string>(choice.oneOf)
  return Effect.as(
    onDegraded(
      new Compatibility.Degradation({
        feature: "tool choice subset (oneOf)",
        source: EFFECT_AI,
        target: EFFECT_UAI,
        reason:
          "effect-uai names one function or none, so the subset is applied by describing only those tools to the model"
      })
    ),
    {
      toolChoice: choice.mode === "required" ? ("required" as const) : ("auto" as const),
      tools: tools.filter((tool) => allowed.has(tool.name))
    }
  )
}

/**
 * Structured output.
 *
 * Not deferrable to a later phase: `AgentOutput` rides on `generateObject`,
 * which Effect AI implements over the `generateText` hook. effect-uai's
 * providers constrain the wire themselves, so the schema is handed over as-is
 * and `LanguageModel.make`'s `codecTransformer` is left unset — transforming it
 * on both sides would be doing the work twice.
 */
const toStructured = (
  responseFormat: LanguageModel.ProviderOptions["responseFormat"]
): UaiLanguageModel.CommonRequest["structured"] =>
  responseFormat.type === "text"
    ? undefined
    : {
      name: responseFormat.objectName,
      // Not `StructuredFormat.fromEffectSchema`: that constrains the schema to
      // one with no decoding services, and `responseFormat.schema` is a
      // `Schema.Top` that may have them. The wire only needs the JSON schema —
      // Effect AI decodes the result against the original schema itself.
      schema: standardSchemaFor(Tool.getJsonSchemaFromSchema(responseFormat.schema))
    }

// -------------------------------------------------------------------------------------
// response: effect-uai -> Effect AI
// -------------------------------------------------------------------------------------

const TEXT_ID = "text"
const REASONING_ID = "reasoning"

interface Accumulator {
  text: string
  textOpen: boolean
  reasoning: string
  reasoningOpen: boolean
  summarised: boolean
  signatureReported: boolean
  readonly streamed: Array<{ readonly id: string; readonly name: string }>
  final: UaiTurn | undefined
}

const accumulator = (): Accumulator => ({
  text: "",
  textOpen: false,
  reasoning: "",
  reasoningOpen: false,
  summarised: false,
  signatureReported: false,
  streamed: [],
  final: undefined
})

const finishReasonFor = (
  stop: UaiTurn["stop_reason"]
): Response.FinishReason => {
  switch (stop) {
    case "stop":
      return "stop"
    case "tool_calls":
      return "tool-calls"
    case "max_tokens":
      return "length"
    // A refusal is not an ordinary completion. `content-filter` is the only
    // Effect AI reason that says the model declined rather than finished, and
    // mapping it to `stop` would make a refusal indistinguishable from an
    // answer for every observer and retry policy downstream.
    case "content_filter":
    case "refusal":
      return "content-filter"
    case "max_tool_calls":
      return "other"
  }
}

const usageFor = (usage: UaiTurn["usage"]): Response.FinishPartEncoded["usage"] => ({
  inputTokens: {
    ...(usage.input_tokens === undefined ? {} : { total: usage.input_tokens }),
    ...(usage.input_tokens_details?.cached_tokens === undefined
      ? {}
      : { cacheRead: usage.input_tokens_details.cached_tokens }),
    ...(usage.input_tokens_details?.cache_write_tokens === undefined
      ? {}
      : { cacheWrite: usage.input_tokens_details.cache_write_tokens })
  },
  outputTokens: {
    ...(usage.output_tokens === undefined ? {} : { total: usage.output_tokens }),
    ...(usage.output_tokens_details?.reasoning_tokens === undefined
      ? {}
      : { reasoning: usage.output_tokens_details.reasoning_tokens })
  }
})

const toolCallsOf = (turn: UaiTurn) =>
  turn.items.flatMap((item) => item.type === "function_call" ? [item] : [])

const reasoningOf = (turn: UaiTurn) =>
  turn.items.flatMap((item) => item.type === "reasoning" ? [item] : [])

const parseArguments = (call: { readonly name: string; readonly arguments: string }) =>
  Effect.try({
    try: () => call.arguments === "" ? {} : JSON.parse(call.arguments) as unknown,
    catch: () =>
      AiError.make({
        module: MODULE,
        method: "streamText",
        reason: new AiError.InvalidOutputError({
          description: `tool call "${call.name}" arrived with arguments that are not JSON: ${call.arguments}`
        })
      })
  })

/**
 * One effect-uai turn event, as Effect AI stream parts.
 *
 * The accumulator is threaded through so that the batch and streaming paths see
 * exactly the same semantics: `generateText` drains this and reads the
 * accumulator, `streamText` drains it and forwards the parts.
 */
const handle = (
  event: TurnEvent,
  state: Accumulator,
  onDegraded: Compatibility.OnDegraded
): Effect.Effect<ReadonlyArray<Response.StreamPartEncoded>, AiError.AiError> => {
  switch (event._tag) {
    case "TextDelta":
    case "RefusalDelta": {
      // A refusal's text is preserved as text rather than dropped; the fact
      // that it *was* a refusal is carried by the finish reason.
      const parts: Array<Response.StreamPartEncoded> = []
      if (!state.textOpen) {
        state.textOpen = true
        parts.push({ type: "text-start", id: TEXT_ID })
      }
      state.text += event.text
      parts.push({ type: "text-delta", id: TEXT_ID, delta: event.text })
      return Effect.succeed(parts)
    }
    case "ReasoningDelta": {
      const parts: Array<Response.StreamPartEncoded> = []
      const degrade = event.kind === "summary" && !state.summarised
        ? (() => {
          state.summarised = true
          return onDegraded(
            new Compatibility.Degradation({
              feature: "reasoning summary",
              source: EFFECT_UAI,
              target: EFFECT_AI,
              reason: "Effect AI has one reasoning channel, so a model-written summary is indistinguishable from a trace"
            })
          )
        })()
        : Effect.void
      if (!state.reasoningOpen) {
        state.reasoningOpen = true
        parts.push({ type: "reasoning-start", id: REASONING_ID })
      }
      // Accumulated as well as forwarded: this is the only place reasoning text
      // exists on the effect-uai side, so the batch path has nowhere else to
      // read it from. See the note on `make`.
      state.reasoning += event.text
      parts.push({ type: "reasoning-delta", id: REASONING_ID, delta: event.text })
      return Effect.as(degrade, parts)
    }
    case "ToolCallStart": {
      state.streamed.push({ id: event.call_id, name: event.name })
      return Effect.succeed([{ type: "tool-params-start", id: event.call_id, name: event.name }])
    }
    case "ToolCallArgsDelta": {
      return Effect.succeed([{ type: "tool-params-delta", id: event.call_id, delta: event.delta }])
    }
    case "UsageUpdate": {
      // Cumulative, and the same numbers arrive again on TurnComplete. Emitting
      // them here is how a translator double-counts a turn's usage.
      return Effect.succeed([])
    }
    case "ImageOutput": {
      // A preview frame is dropped rather than degraded: the finished image
      // also arrives on the assembled turn, and forwarding both would put the
      // same image into canonical history twice.
      if (event.partialIndex !== undefined) return Effect.succeed([])
      return Effect.fail(asAiError("streamText", "response")(unsupported({
        feature: "assistant image output",
        source: EFFECT_UAI,
        target: EFFECT_AI,
        reason: "multimodal output is Phase 3 of the integration plan and is not claimed yet"
      })))
    }
    case "CitationAdded": {
      return Effect.fail(asAiError("streamText", "response")(unsupported({
        feature: "citation",
        source: EFFECT_UAI,
        target: EFFECT_AI,
        reason: "citations and sources are Phase 3 of the integration plan and are not claimed yet"
      })))
    }
    case "WebSearchCall": {
      return Effect.fail(asAiError("streamText", "response")(unsupported({
        feature: "provider-executed web search",
        source: EFFECT_UAI,
        target: EFFECT_AI,
        reason: "a provider-executed tool would bypass Affe's tool execution and permission path"
      })))
    }
    case "TurnComplete": {
      return Effect.gen(function*() {
        state.final = event.turn
        const parts: Array<Response.StreamPartEncoded> = []
        if (state.textOpen) {
          state.textOpen = false
          parts.push({ type: "text-end", id: TEXT_ID })
        }
        if (state.reasoningOpen) {
          state.reasoningOpen = false
          parts.push({ type: "reasoning-end", id: REASONING_ID, ...(yield* reasoningMetadata(event.turn, state, onDegraded)) })
        }
        for (const streamed of state.streamed) {
          parts.push({ type: "tool-params-end", id: streamed.id })
        }
        for (const call of toolCallsOf(event.turn)) {
          parts.push({
            type: "tool-call",
            id: call.call_id,
            name: call.name,
            params: yield* parseArguments(call)
          })
        }
        parts.push({
          type: "finish",
          reason: finishReasonFor(event.turn.stop_reason),
          usage: usageFor(event.turn.usage)
        })
        return parts
      })
    }
  }
}

/**
 * The reasoning signature, on its way back.
 *
 * Effect AI's reasoning part has only `text`, but every encoded part carries
 * provider metadata, so the signature survives the boundary rather than being
 * dropped on the floor. Whether it survives the *rest* of the path — canonical
 * history, `PromptWire`, snapshot, durable journal, restore — is Phase 3's
 * question, and this adapter does not claim it.
 */
const reasoningMetadata = (
  turn: UaiTurn,
  state: Accumulator,
  onDegraded: Compatibility.OnDegraded
): Effect.Effect<{ readonly metadata?: Response.ProviderMetadata }> => {
  const signature = reasoningOf(turn).find((item) => item.signature !== undefined)?.signature
  if (signature === undefined) return Effect.succeed({})
  // Both paths ask for this — `streamText` for the reasoning-end part and
  // `generateText` again when it renders the batch parts — but one turn
  // losing one thing is one notice, not two.
  if (state.signatureReported) return Effect.succeed({ metadata: { [MODULE]: { signature } } })
  state.signatureReported = true
  return Effect.as(
    onDegraded(
      new Compatibility.Degradation({
        feature: "reasoning signature",
        source: EFFECT_UAI,
        target: EFFECT_AI,
        reason:
          "carried as part metadata; its survival through history, snapshot and durable replay is not claimed until Phase 3"
      })
    ),
    { metadata: { [MODULE]: { signature } } }
  )
}

/**
 * The accumulated turn, as non-streaming response parts.
 *
 * A turn that never produced a `TurnComplete` is a provider that ended its
 * stream early; saying so beats returning a plausible empty answer.
 */
const batchParts = (
  state: Accumulator,
  onDegraded: Compatibility.OnDegraded
): Effect.Effect<Array<Response.PartEncoded>, AiError.AiError> =>
  Effect.gen(function*() {
    const turn = state.final
    if (turn === undefined) {
      return yield* AiError.make({
        module: MODULE,
        method: "generateText",
        reason: new AiError.InvalidOutputError({
          description: "the effect-uai turn stream ended without a TurnComplete event"
        })
      })
    }
    const parts: Array<Response.PartEncoded> = []
    if (state.reasoning !== "") {
      parts.push({
        type: "reasoning",
        text: state.reasoning,
        ...(yield* reasoningMetadata(turn, state, onDegraded))
      })
    }
    if (state.text !== "") {
      parts.push({ type: "text", text: state.text })
    }
    for (const call of toolCallsOf(turn)) {
      parts.push({
        type: "tool-call",
        id: call.call_id,
        name: call.name,
        params: yield* parseArguments(call)
      })
    }
    parts.push({
      type: "finish",
      reason: finishReasonFor(turn.stop_reason),
      usage: usageFor(turn.usage)
    })
    return parts
  })

// -------------------------------------------------------------------------------------
// the adapter
// -------------------------------------------------------------------------------------

const requestFor = (
  options: LanguageModel.ProviderOptions,
  adapter: Options,
  onDegraded: Compatibility.OnDegraded,
  method: string
): Effect.Effect<UaiLanguageModel.CommonRequest, AiError.AiError> =>
  Effect.gen(function*() {
    // `incrementalPrompt` and `previousResponseId` are ignored, not translated:
    // effect-uai has no counterpart, and the full prompt is always sufficient.
    // The cost is that nothing here can use a provider's incremental endpoint.
    const history = yield* toHistory(options.prompt, onDegraded)
    const { toolChoice, tools } = yield* toToolChoice(options.toolChoice, options.tools, onDegraded)
    const structured = toStructured(options.responseFormat)
    return {
      history,
      model: adapter.model,
      ...(tools.length === 0 ? {} : { tools: toToolkit(tools) }),
      toolChoice,
      ...(structured === undefined ? {} : { structured }),
      ...(adapter.temperature === undefined ? {} : { temperature: adapter.temperature }),
      ...(adapter.topP === undefined ? {} : { topP: adapter.topP }),
      ...(adapter.maxOutputTokens === undefined ? {} : { maxOutputTokens: adapter.maxOutputTokens })
    }
  }).pipe(Effect.catchTag("UnsupportedConversion", (error) => Effect.fail(asAiError(method, "request")(error))))

const uaiError = (method: string) => (error: { readonly message: string }) =>
  AiError.make({
    module: MODULE,
    method,
    reason: new AiError.InternalProviderError({ description: error.message })
  })

/**
 * An Effect AI `LanguageModel` backed by whatever `effect-uai` provider is in
 * the environment.
 *
 * Both hooks go through `streamTurn`, and `generateText` never calls
 * effect-uai's own `turn`. That is not a stylistic preference. `turn` returns
 * only the assembled `Turn`, whose reasoning items carry `id`, `summary` and
 * `signature` — and no raw text. Reasoning text exists on the effect-uai side
 * only as the `ReasoningDelta` event, so an adapter built on `turn` would
 * return reasoning parts with the text missing and look entirely correct while
 * doing it.
 */
export const make = (
  options: Options
): Effect.Effect<LanguageModel.Service, never, UaiLanguageModel.LanguageModel> =>
  Effect.gen(function*() {
    const uai = yield* UaiLanguageModel.LanguageModel
    const onDegraded = options.onDegraded ?? Compatibility.logDegradation

    const events = (
      providerOptions: LanguageModel.ProviderOptions,
      state: Accumulator,
      method: string
    ) =>
      Stream.unwrap(
        Effect.map(
          requestFor(providerOptions, options, onDegraded, method),
          (request) =>
            uai.streamTurn(request).pipe(
              Stream.mapError(uaiError(method)),
              Stream.mapEffect((event) => handle(event, state, onDegraded)),
              Stream.flattenIterable
            )
        )
      )

    return yield* LanguageModel.make({
      generateText: (providerOptions) =>
        // `Stream.suspend` in `events` is unnecessary here because the state is
        // created per call, but the drain is: the parts are discarded and the
        // answer is read from what they accumulated.
        Effect.gen(function*() {
          const state = accumulator()
          yield* Stream.runDrain(events(providerOptions, state, "generateText"))
          return yield* batchParts(state, onDegraded)
        }),
      streamText: (providerOptions) =>
        Stream.suspend(() => events(providerOptions, accumulator(), "streamText"))
    })
  })

/**
 * {@link make} as a layer.
 *
 * The effect-uai provider layer is the requirement, so a caller composes the
 * two and Affe sees an ordinary `LanguageModel`:
 *
 * ```ts
 * const model = EffectUaiModel.layer({ model: "claude-sonnet-4" }).pipe(
 *   Layer.provide(SomeEffectUaiProvider.layer)
 * )
 * ```
 */
export const layer = (
  options: Options
): Layer.Layer<LanguageModel.LanguageModel, never, UaiLanguageModel.LanguageModel> =>
  Layer.effect(LanguageModel.LanguageModel, make(options))
