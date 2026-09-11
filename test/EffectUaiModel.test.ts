import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, ExecutionPlan, Layer, Option, Ref, Schema, Stream } from "effect"
import { IdGenerator, LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai"
import { ContentFiltered, RateLimited, Unavailable } from "@effect-uai/core/AiError"
import type * as UaiAiError from "@effect-uai/core/AiError"
import * as UaiLanguageModel from "@effect-uai/core/LanguageModel"
import type { Turn as UaiTurn, TurnEvent } from "@effect-uai/core/Turn"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Permission from "../src/Permission.js"
import * as Compatibility from "../src/effect-uai/Compatibility.js"
import * as EffectUaiModel from "../src/effect-uai/EffectUaiModel.js"
import * as FakeModel from "./FakeModel.js"

/**
 * These are the conformance rows of
 * `docs/plan-effect-uai-compatibility-contract.md` §4, as tests.
 *
 * Two kinds sit here on purpose. The `required` rows assert that something
 * crosses the boundary intact. The `Unsupported` rows assert that something
 * *fails*, and fails for the stated reason — a bridge that silently dropped a
 * document or a refusal distinction would pass every test of the first kind.
 */

// -------------------------------------------------------------------------------------
// a scripted effect-uai provider
// -------------------------------------------------------------------------------------

const emptyUsage: UaiTurn["usage"] = {}

const turn = (
  items: UaiTurn["items"],
  stop: UaiTurn["stop_reason"] = "stop",
  usage: UaiTurn["usage"] = emptyUsage
): UaiTurn => ({ items, usage, stop_reason: stop })

/** The requests the adapter actually sent, so the request-side rows can assert on them. */
interface Recorder {
  readonly requests: Effect.Effect<ReadonlyArray<UaiLanguageModel.CommonRequest>>
}

const scripted = (events: ReadonlyArray<TurnEvent>) =>
  Effect.gen(function*() {
    const seen = yield* Ref.make<Array<UaiLanguageModel.CommonRequest>>([])
    const streamTurn = (request: UaiLanguageModel.CommonRequest) =>
      Stream.unwrap(
        Effect.as(
          Ref.update(seen, (all) => [...all, request]),
          Stream.fromIterable(events)
        )
      )
    const layer = Layer.succeed(UaiLanguageModel.LanguageModel, {
      streamTurn,
      // Never called by the adapter, and the test asserts that below.
      turn: UaiLanguageModel.turnFromStream(streamTurn)
    })
    const recorder: Recorder = { requests: Ref.get(seen) }
    return { layer, recorder }
  })

/** A collector for degradation notices, so "never silent" is an assertion. */
const collector = Effect.map(
  Ref.make<Array<Compatibility.Degradation>>([]),
  (ref) => ({
    onDegraded: (degradation: Compatibility.Degradation) =>
      Ref.update(ref, (all) => [...all, degradation]),
    recorded: Ref.get(ref)
  })
)

const ids = Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator)

/**
 * Run a program against a scripted effect-uai provider.
 *
 * Returns the adapter's degradation notices alongside the result so a test can
 * assert on both without wiring a layer by hand each time.
 */
const withModel = <A, E>(
  events: ReadonlyArray<TurnEvent>,
  use: (recorder: Recorder) => Effect.Effect<A, E, LanguageModel.LanguageModel>
) =>
  Effect.gen(function*() {
    const { layer, recorder } = yield* scripted(events)
    const degraded = yield* collector
    const model = EffectUaiModel.layer({ model: "test-model", onDegraded: degraded.onDegraded }).pipe(
      Layer.provide(layer)
    )
    const result = yield* Effect.exit(
      use(recorder).pipe(Effect.provide(Layer.mergeAll(model, ids)))
    )
    return { result, degradations: yield* degraded.recorded, recorder }
  })

const text = (value: string): TurnEvent => ({ _tag: "TextDelta", text: value })

const complete = (value: UaiTurn): TurnEvent => ({ _tag: "TurnComplete", turn: value })

const failureText = <A, E>(exit: Exit.Exit<A, E>): string =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "(the effect succeeded)"

const generate = (options?: { readonly prompt?: string }) =>
  LanguageModel.generateText({ prompt: options?.prompt ?? "hello" })

const search = Tool.make("search", {
  description: "search the web",
  parameters: Schema.Struct({ query: Schema.String })
})

const one = Tool.make("one", { parameters: Schema.Struct({}) })
const two = Tool.make("two", { parameters: Schema.Struct({}) })

/**
 * A generation with tools described but resolution off — the same way
 * `AgentTurn` calls the model, because Affe executes tools itself.
 */
const generateWithTools = <Tools extends Record<string, Tool.Any>>(toolkit: Toolkit.Toolkit<Tools>) =>
  LanguageModel.generateText({
    prompt: "hello",
    toolkit,
    disableToolCallResolution: true
  })

/** The one element of a single-element array, asserted rather than indexed blindly. */
const only = <A>(all: ReadonlyArray<A>): A => {
  assert.strictEqual(all.length, 1)
  const first = all[0]
  assert.isDefined(first)
  return first
}


/**
 * A provider whose stream ends the way a real one can: by failing, or by
 * cancelling itself. `scripted` always ends cleanly, which is exactly the case
 * these invariants are not about.
 */
const endingBadly = (events: ReadonlyArray<TurnEvent>, ending: "fail" | "interrupt") =>
  Effect.sync(() => {
    const tail = ending === "fail"
      ? Stream.fail(new Unavailable({ provider: "test", raw: "the provider went away" }))
      : Stream.drain(Stream.fromEffect(Effect.interrupt))
    const streamTurn = () => Stream.concat(Stream.fromIterable(events), tail)
    return Layer.succeed(UaiLanguageModel.LanguageModel, {
      streamTurn,
      turn: UaiLanguageModel.turnFromStream(streamTurn)
    })
  })

const modelOver = (layer: Layer.Layer<UaiLanguageModel.LanguageModel>) =>
  Layer.mergeAll(EffectUaiModel.layer({ model: "test-model" }).pipe(Layer.provide(layer)), ids)

// -------------------------------------------------------------------------------------

describe("EffectUaiModel", () => {
  describe("required rows", () => {
    it.effect("text crosses intact, and the finish reason with it", () =>
      Effect.gen(function*() {
        const { result } = yield* withModel(
          [text("the "), text("answer"), complete(turn([], "stop"))],
          () => generate()
        )
        const response = Exit.isSuccess(result) ? result.value : undefined
        assert.isDefined(response, failureText(result))
        assert.strictEqual(response.text, "the answer")
        assert.strictEqual(response.finishReason, "stop")
      }))

    /**
     * The test that would have caught an adapter built on effect-uai's own
     * `turn`.
     *
     * Reasoning text exists on the effect-uai side only as a `ReasoningDelta`
     * event: the assembled `Turn`'s reasoning item carries `id`, `summary` and
     * `signature`, and no text at all. So an adapter whose `generateText`
     * called `turn` would return a reasoning part with the text missing and
     * look entirely correct doing it.
     */
    it.effect("generateText preserves reasoning text, which only the stream carries", () =>
      Effect.gen(function*() {
        const { result } = yield* withModel(
          [
            { _tag: "ReasoningDelta", text: "step one, ", kind: "trace" },
            { _tag: "ReasoningDelta", text: "step two", kind: "trace" },
            text("done"),
            // Note the assembled turn: a reasoning item with no text on it.
            complete(turn([{ type: "reasoning", signature: "sig-1" }], "stop"))
          ],
          () => generate()
        )
        const response = Exit.isSuccess(result) ? result.value : undefined
        assert.isDefined(response, failureText(result))
        assert.strictEqual(response.reasoningText, "step one, step two")
      }))

    it.effect("a tool call arrives with its id, name and parsed arguments", () =>
      Effect.gen(function*() {
        const { result } = yield* withModel(
          [
            { _tag: "ToolCallStart", call_id: "call-1", name: "search" },
            { _tag: "ToolCallArgsDelta", call_id: "call-1", delta: "{\"query\":" },
            { _tag: "ToolCallArgsDelta", call_id: "call-1", delta: "\"effect\"}" },
            complete(
              turn(
                [{ type: "function_call", call_id: "call-1", name: "search", arguments: "{\"query\":\"effect\"}" }],
                "tool_calls"
              )
            )
          ],
          () => generateWithTools(Toolkit.make(search))
        )
        const response = Exit.isSuccess(result) ? result.value : undefined
        assert.isDefined(response, failureText(result))
        const call = only(response.toolCalls)
        assert.strictEqual(call.id, "call-1")
        assert.strictEqual(call.name, "search")
        assert.deepStrictEqual(call.params, { query: "effect" })
        assert.strictEqual(response.finishReason, "tool-calls")
      }))

    /**
     * The ownership rule, from the plan: the adapter describes tools and Affe
     * executes them.
     *
     * effect-uai's `SignalTool` is "model-visible and decodable but never
     * locally executed", so this holds structurally — there is no handler for
     * effect-uai to call. The assertion is on the kind rather than on
     * behaviour because behaviour cannot regress without the kind changing.
     */
    it.effect("tools are described to the model as descriptors with no executor", () =>
      Effect.gen(function*() {
        const { recorder, result } = yield* withModel(
          [text("ok"), complete(turn([], "stop"))],
          () => generateWithTools(Toolkit.make(search))
        )
        assert.isTrue(Exit.isSuccess(result), failureText(result))
        const tools = only(yield* recorder.requests).tools
        assert.isDefined(tools)
        const tool = tools["search"]
        assert.isDefined(tool)
        assert.strictEqual(tool._tag, "SignalTool")
        assert.isFalse("run" in tool, "a descriptor must not carry an executor")
        assert.strictEqual(tool.description, "search the web")
      }))

    /**
     * Item 89: a dynamic tool -- its parameters a raw JSON Schema, as an MCP
     * source hands over, not an Effect `Schema` -- goes through the same path
     * and had no test. The model must be shown exactly the schema given, and
     * a call to it must arrive with its arguments parsed.
     */
    it.effect("a tool with a raw JSON Schema is described by that schema, and its call's arguments arrive parsed", () =>
      Effect.gen(function*() {
        const parameters = {
          type: "object",
          properties: { path: { type: "string" }, depth: { type: "integer" } },
          required: ["path"]
        }
        const listing = Tool.dynamic("list_files", { description: "list files under a path", parameters })
        const { recorder, result } = yield* withModel(
          [
            { _tag: "ToolCallStart", call_id: "call-d", name: "list_files" },
            { _tag: "ToolCallArgsDelta", call_id: "call-d", delta: "{\"path\":\"src\",\"depth\":2}" },
            complete(
              turn(
                [{ type: "function_call", call_id: "call-d", name: "list_files", arguments: "{\"path\":\"src\",\"depth\":2}" }],
                "tool_calls"
              )
            )
          ],
          () => generateWithTools(Toolkit.make(listing))
        )
        const response = Exit.isSuccess(result) ? result.value : undefined
        assert.isDefined(response, failureText(result))
        const described = only(yield* recorder.requests).tools?.["list_files"]
        assert.isDefined(described)
        assert.strictEqual(described.description, "list files under a path")
        assert.deepStrictEqual(described.inputSchema["~standard"].jsonSchema.input({ target: "draft-07" }), parameters)
        const call = only(response.toolCalls)
        assert.strictEqual(call.name, "list_files")
        assert.deepStrictEqual(call.params, { path: "src", depth: 2 })
      }))

    /**
     * The streaming path, pinned separately.
     *
     * Effect AI assembles a tool call from the streamed `tool-params-*`
     * sequence *and* the adapter emits an explicit `tool-call` part on
     * `TurnComplete`. Both are legitimate; together they are a duplication
     * risk, and the count is the only thing that catches it — a doubled call
     * would run a tool twice, which for a side-effecting tool is the worst
     * kind of bug to find in production.
     */
    it.effect("streaming yields exactly one tool call, not one per source", () =>
      Effect.gen(function*() {
        const { result } = yield* withModel(
          [
            { _tag: "ToolCallStart", call_id: "call-1", name: "search" },
            { _tag: "ToolCallArgsDelta", call_id: "call-1", delta: "{\"query\":\"effect\"}" },
            complete(
              turn(
                [{ type: "function_call", call_id: "call-1", name: "search", arguments: "{\"query\":\"effect\"}" }],
                "tool_calls"
              )
            )
          ],
          () =>
            Stream.runCollect(
              LanguageModel.streamText({
                prompt: "hello",
                toolkit: Toolkit.make(search),
                disableToolCallResolution: true
              })
            )
        )
        const parts = Exit.isSuccess(result) ? result.value : undefined
        assert.isDefined(parts, failureText(result))
        const calls = parts.filter((part) => part.type === "tool-call")
        assert.strictEqual(calls.length, 1, "a tool call must not arrive twice")
        assert.strictEqual(only(calls).id, "call-1")
      }))

    /**
     * A call the provider started streaming and then abandoned.
     *
     * `TurnComplete` is the authority on what the model actually asked for. A
     * fragment that never became a call must not be closed as though it had —
     * Effect AI assembles a call from a completed `tool-params-*` sequence, so
     * closing an abandoned one fabricates a tool call the model never made,
     * and Affe would then execute it.
     */
    it.effect("a tool call abandoned mid-stream is not fabricated into a real one", () =>
      Effect.gen(function*() {
        const { result } = yield* withModel(
          [
            { _tag: "ToolCallStart", call_id: "ghost", name: "search" },
            { _tag: "ToolCallArgsDelta", call_id: "ghost", delta: "{\"query\":" },
            // The provider gave up: no function_call item on the finished turn.
            complete(turn([], "stop"))
          ],
          () =>
            Stream.runCollect(
              LanguageModel.streamText({
                prompt: "hello",
                toolkit: Toolkit.make(search),
                disableToolCallResolution: true
              })
            )
        )
        const parts = Exit.isSuccess(result) ? result.value : undefined
        assert.isDefined(parts, failureText(result))
        assert.deepStrictEqual(
          parts.filter((one) => one.type === "tool-call"),
          [],
          "an abandoned fragment must not become a call"
        )
        // And it is not closed either. Affe rebuilds a call from the params
        // stream itself, so a `tool-params-end` the provider never earned is
        // enough to fabricate one a layer below Effect AI.
        assert.deepStrictEqual(
          parts.filter((one) => one.type === "tool-params-end"),
          [],
          "an abandoned fragment must not be closed"
        )
      }))

    it.effect("interleaved tool calls stay separate", () =>
      Effect.gen(function*() {
        const { result } = yield* withModel(
          [
            { _tag: "ToolCallStart", call_id: "a", name: "one" },
            { _tag: "ToolCallStart", call_id: "b", name: "two" },
            { _tag: "ToolCallArgsDelta", call_id: "a", delta: "{\"x\":1}" },
            { _tag: "ToolCallArgsDelta", call_id: "b", delta: "{\"y\":2}" },
            complete(
              turn(
                [
                  { type: "function_call", call_id: "a", name: "one", arguments: "{\"x\":1}" },
                  { type: "function_call", call_id: "b", name: "two", arguments: "{\"y\":2}" }
                ],
                "tool_calls"
              )
            )
          ],
          () => generateWithTools(Toolkit.make(one, two))
        )
        const response = Exit.isSuccess(result) ? result.value : undefined
        assert.isDefined(response, failureText(result))
        assert.deepStrictEqual(
          response.toolCalls.map((call) => [call.id, call.params]),
          [["a", { x: 1 }], ["b", { y: 2 }]]
        )
      }))

    /**
     * `UsageUpdate` is cumulative and the same numbers arrive again on
     * `TurnComplete`. Adding them is the natural bug, so it gets a row.
     */
    it.effect("mid-stream usage is not added to the final usage", () =>
      Effect.gen(function*() {
        const usage = { input_tokens: 10, output_tokens: 4 }
        const { result } = yield* withModel(
          [
            { _tag: "UsageUpdate", usage: { input_tokens: 10, output_tokens: 2 } },
            text("hi"),
            { _tag: "UsageUpdate", usage },
            complete(turn([], "stop", usage))
          ],
          () => generate()
        )
        const response = Exit.isSuccess(result) ? result.value : undefined
        assert.isDefined(response, failureText(result))
        assert.strictEqual(response.usage.inputTokens.total, 10)
        assert.strictEqual(response.usage.outputTokens.total, 4)
      }))

    /**
     * Item 89's prompt-cache metadata: what a provider says it read from and
     * wrote to its cache, and the reasoning tokens, are what cost accounting
     * and `/budget` read. They crossed already; now a row says so.
     */
    it.effect("cache reads, cache writes and reasoning tokens cross into usage", () =>
      Effect.gen(function*() {
        const usage = {
          input_tokens: 1200,
          output_tokens: 80,
          input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 150 },
          output_tokens_details: { reasoning_tokens: 30 }
        }
        const { result } = yield* withModel([text("ok"), complete(turn([], "stop", usage))], () => generate())
        const response = Exit.isSuccess(result) ? result.value : undefined
        assert.isDefined(response, failureText(result))
        assert.strictEqual(response.usage.inputTokens.cacheRead, 1000)
        assert.strictEqual(response.usage.inputTokens.cacheWrite, 150)
        assert.strictEqual(response.usage.outputTokens.reasoning, 30)
      }))

    /**
     * A refusal must not read as an ordinary answer. `content-filter` is the
     * only Effect AI finish reason that says the model declined rather than
     * finished, and the refusal text is preserved rather than dropped.
     */
    it.effect("a refusal keeps its text and does not finish as an ordinary stop", () =>
      Effect.gen(function*() {
        const { result } = yield* withModel(
          [
            { _tag: "RefusalDelta", text: "I can't help with that." },
            complete(turn([], "refusal"))
          ],
          () => generate()
        )
        const response = Exit.isSuccess(result) ? result.value : undefined
        assert.isDefined(response, failureText(result))
        assert.strictEqual(response.finishReason, "content-filter")
        assert.strictEqual(response.text, "I can't help with that.")
      }))

    /**
     * Anthropic will not continue a reasoning turn without its signature, so
     * losing it is not cosmetic. It rides as part metadata; whether it survives
     * the *rest* of the path is Phase 3's question, and the degradation notice
     * says so rather than implying the round trip is proven.
     */
    it.effect("a reasoning signature survives the boundary as metadata, and says it is unproven beyond it", () =>
      Effect.gen(function*() {
        const { degradations, result } = yield* withModel(
          [
            { _tag: "ReasoningDelta", text: "thinking", kind: "trace" },
            complete(turn([{ type: "reasoning", signature: "sig-xyz" }], "stop"))
          ],
          () => generate()
        )
        assert.isTrue(Exit.isSuccess(result), failureText(result))
        const notices = degradations.filter((one) => one.feature === "reasoning signature")
        // One turn losing one thing is one notice. Both paths ask for the
        // metadata -- the stream for reasoning-end, the batch render again --
        // and a notice per asker would make the log say it happened twice.
        assert.strictEqual(notices.length, 1, "the signature's unproven round trip must be declared exactly once")
        assert.include(only(notices).reason, "Phase 3")
      }))

    it.effect("the request carries the model bound at construction", () =>
      Effect.gen(function*() {
        const { recorder, result } = yield* withModel(
          [text("hi"), complete(turn([], "stop"))],
          () => generate()
        )
        assert.isTrue(Exit.isSuccess(result), failureText(result))
        assert.strictEqual(only(yield* recorder.requests).model, "test-model")
      }))
  })

  describe("unsupported rows — these must fail, and for the stated reason", () => {
    /**
     * Affe shipped end-to-end multimodality, so a document that vanished here
     * would be a live regression rather than a hypothetical one. Dropping it is
     * the failure the canonical-history rule already forbids.
     */
    it.effect("a non-image user file is refused rather than dropped", () =>
      Effect.gen(function*() {
        const { result } = yield* withModel(
          [text("hi"), complete(turn([], "stop"))],
          () =>
            LanguageModel.generateText({
              prompt: Prompt.make([{
                role: "user",
                content: [{ type: "file", mediaType: "application/pdf", data: "JVBERi0=" }]
              }])
            })
        )
        assert.isTrue(Exit.isFailure(result))
        const message = failureText(result)
        assert.include(message, "application/pdf")
        assert.include(message, "input_image")
      }))

    it.effect("a citation that names only a file id is refused, rather than given invented metadata", () =>
      Effect.gen(function*() {
        const { result } = yield* withModel(
          [
            text("grounded"),
            { _tag: "CitationAdded", annotation: { type: "file_citation", file_id: "f-1", index: 0 } },
            complete(turn([], "stop"))
          ],
          () => generate()
        )
        assert.isTrue(Exit.isFailure(result))
        // Effect AI's document source requires a title and a media type; this
        // citation carries neither, and filling them in would put invented
        // metadata into canonical history.
        assert.include(failureText(result), "title and a media type")
      }))

    it.effect("a provider-executed web search is refused, because it would bypass tool execution", () =>
      Effect.gen(function*() {
        const { result } = yield* withModel(
          [{ _tag: "WebSearchCall", status: "started" }, complete(turn([], "stop"))],
          () => generate()
        )
        assert.isTrue(Exit.isFailure(result))
        assert.include(failureText(result), "permission")
      }))

    it.effect("malformed tool arguments fail rather than decoding to an empty object", () =>
      Effect.gen(function*() {
        const { result } = yield* withModel(
          [
            { _tag: "ToolCallStart", call_id: "c", name: "search" },
            complete(
              turn([{ type: "function_call", call_id: "c", name: "search", arguments: "{not json" }], "tool_calls")
            )
          ],
          () => generateWithTools(Toolkit.make(search))
        )
        assert.isTrue(Exit.isFailure(result))
        assert.include(failureText(result), "not JSON")
      }))

    it.effect("a stream that ends without a completed turn is reported, not answered", () =>
      Effect.gen(function*() {
        const { result } = yield* withModel([text("half")], () => generate())
        assert.isTrue(Exit.isFailure(result))
        assert.include(failureText(result), "TurnComplete")
      }))
  })

  describe("degraded rows — these must be observable", () => {
    it.effect("reasoning text replayed into a request declares that it has nowhere to go", () =>
      Effect.gen(function*() {
        const { degradations, result } = yield* withModel(
          [text("ok"), complete(turn([], "stop"))],
          () =>
            LanguageModel.generateText({
              prompt: Prompt.make([{
                role: "assistant",
                content: [{ type: "reasoning", text: "earlier thinking" }]
              }])
            })
        )
        assert.isTrue(Exit.isSuccess(result), failureText(result))
        const notice = degradations.find((one) => one.feature === "reasoning text")
        assert.isDefined(notice, "dropping reasoning text silently is the thing the contract forbids")
        assert.strictEqual(notice.source, "effect-ai")
        assert.strictEqual(notice.target, "effect-uai")
      }))

    /**
     * The `oneOf` subset has no effect-uai counterpart. Describing only the
     * subset leaves the permitted behaviour unchanged, but changes what the
     * model is told about — a real difference, so it is reported.
     */
    it.effect("a tool-choice subset narrows what is described, and says so", () =>
      Effect.gen(function*() {
        const { degradations, recorder, result } = yield* withModel(
          [text("ok"), complete(turn([], "stop"))],
          () =>
            LanguageModel.generateText({
              prompt: "hello",
              toolkit: Toolkit.make(one, two),
              toolChoice: { oneOf: ["one"] },
              disableToolCallResolution: true
            })
        )
        assert.isTrue(Exit.isSuccess(result), failureText(result))
        assert.deepStrictEqual(Object.keys(only(yield* recorder.requests).tools ?? {}), ["one"])
        assert.isDefined(
          degradations.find((one) => one.feature === "tool choice subset (oneOf)"),
          "narrowing what the model is told about is not a free translation"
        )
      }))

    it.effect("a tool call replayed into a request declares the argument re-encode", () =>
      Effect.gen(function*() {
        const { degradations, result } = yield* withModel(
          [text("ok"), complete(turn([], "stop"))],
          () =>
            LanguageModel.generateText({
              prompt: Prompt.make([
                {
                  role: "assistant",
                  content: [{ type: "tool-call", id: "c1", name: "search", params: { query: "effect" } }]
                },
                {
                  role: "tool",
                  content: [{
                    type: "tool-result",
                    id: "c1",
                    name: "search",
                    result: "found",
                    isFailure: false,
                    providerExecuted: false
                  }]
                }
              ])
            })
        )
        assert.isTrue(Exit.isSuccess(result), failureText(result))
        assert.isDefined(
          degradations.find((one) => one.feature === "tool call argument encoding"),
          "the provider's original argument string is not recoverable, and that is worth saying"
        )
      }))
  })

  /**
   * The acceptance that the whole adapter exists for.
   *
   * Everything above tests the translation. These test the claim the plan
   * actually makes: that an effect-uai-backed model changes which provider
   * answers and nothing else — Affe still runs the tool, and Affe's permission
   * policy still decides whether it may.
   */
  describe("through a real AgentSession", () => {
    const Lookup = Tool.make("lookup", {
      description: "look something up",
      parameters: Schema.Struct({ query: Schema.String }),
      success: Schema.String
    })

    const callsLookup: ReadonlyArray<TurnEvent> = [
      { _tag: "ToolCallStart", call_id: "call-1", name: "lookup" },
      { _tag: "ToolCallArgsDelta", call_id: "call-1", delta: "{\"query\":\"effect\"}" },
      complete(
        turn(
          [{ type: "function_call", call_id: "call-1", name: "lookup", arguments: "{\"query\":\"effect\"}" }],
          "tool_calls"
        )
      )
    ]

    it.effect("the tool runs in Affe, not in effect-uai", () =>
      Effect.gen(function*() {
        const ran = yield* Ref.make<Array<string>>([])
        const { layer } = yield* scripted(callsLookup)
        const model = EffectUaiModel.layer({ model: "test-model" }).pipe(Layer.provide(layer))

        const result = yield* Effect.scoped(
          Effect.gen(function*() {
            const session = yield* AgentSession.make(
              Agent.make({
                tools: [
                  Agent.tool(Lookup, (input) =>
                    Effect.as(Ref.update(ran, (all) => [...all, input.query]), "found it"))
                ],
                // One turn: the model asks for the tool, and the script has
                // nothing further to say.
                loop: AgentLoop.bounded(1)
              })
            )
            return yield* AgentSession.prompt(session, "go")
          }).pipe(Effect.provide(Layer.mergeAll(model, ids)))
        )

        // The handler ran, with the arguments that crossed the boundary.
        assert.deepStrictEqual(yield* Ref.get(ran), ["effect"])
        assert.strictEqual(result.status, "completed")
      }))

    it.effect("Affe's permission policy still decides, exactly as with an official provider", () =>
      Effect.gen(function*() {
        const ran = yield* Ref.make<Array<string>>([])
        const { layer } = yield* scripted(callsLookup)
        const model = EffectUaiModel.layer({ model: "test-model" }).pipe(Layer.provide(layer))

        const exit = yield* Effect.exit(
          Effect.scoped(
            Effect.gen(function*() {
              const session = yield* AgentSession.make(
                Agent.make({
                  tools: [
                    Agent.tool(Lookup, (input) =>
                      Effect.as(Ref.update(ran, (all) => [...all, input.query]), "found it"))
                  ],
                  permission: Permission.rules([
                    { tool: "lookup", decision: Permission.deny("not allowed") }
                  ], { otherwise: Permission.allow }),
                  loop: AgentLoop.bounded(1)
                })
              )
              return yield* AgentSession.prompt(session, "go")
            }).pipe(Effect.provide(Layer.mergeAll(model, ids)))
          )
        )

        // The same `ToolPermissionDeniedError` an official provider's call
        // would raise, from the same place: a provider swap must not become a
        // way around the permission boundary.
        assert.match(failureText(exit), /ToolPermissionDenied|not allowed/)
        // And the handler never ran, so the denial preceded the side effect.
        assert.deepStrictEqual(yield* Ref.get(ran), [])
      }))
  })

  /**
   * The two invariants an accumulate-then-synthesise translator is most likely
   * to break.
   *
   * Affe requires that a partial stream never becomes a visible answer and that
   * cancellation never fabricates a completed turn. This adapter builds a turn
   * from state it accumulated across a stream, so both failures are one missing
   * guard away: the batch path reads `state.final`, and its answer to a missing
   * one is to raise "the stream ended without a TurnComplete" -- which would
   * turn a provider outage, or an interruption, into a translation error and
   * hide what actually happened.
   */
  describe("a stream that ends badly", () => {
    it.effect("a provider failure mid-stream stays the provider's failure", () =>
      Effect.gen(function*() {
        const layer = yield* endingBadly([text("half an ans")], "fail")
        const exit = yield* Effect.exit(generate().pipe(Effect.provide(modelOver(layer))))

        assert.isTrue(Exit.isFailure(exit))
        const message = failureText(exit)
        assert.include(message, "unavailable", "the provider's own account of the failure is lost")
        // The tell that the adapter swallowed it: its own complaint about the
        // missing TurnComplete, reported instead of the outage that caused it.
        assert.notInclude(message, "TurnComplete")
      }))

    /**
     * The invariant behind the mapping, and the reason it is not cosmetic.
     *
     * `isRetryable` lives on the *reason*, so an `ExecutionPlan` decides what
     * to do from the class alone. Flattening effect-uai's taxonomy into one
     * reason would make a plan retry a content-filtered request forever and
     * give up on a rate limit — the plan's §9 cross-ecosystem fallback is
     * precisely what would misbehave.
     */
    it.effect("the failure class survives, because retry policy reads it", () =>
      Effect.gen(function*() {
        const classOf = (fail: Stream.Stream<never, UaiAiError.AiError>) =>
          Effect.gen(function*() {
            const streamTurn = () => Stream.concat(Stream.fromIterable([text("part")]), fail)
            const layer = Layer.succeed(UaiLanguageModel.LanguageModel, {
              streamTurn,
              turn: UaiLanguageModel.turnFromStream(streamTurn)
            })
            const exit = yield* Effect.exit(generate().pipe(Effect.provide(modelOver(layer))))
            assert.isTrue(Exit.isFailure(exit))
            if (!Exit.isFailure(exit)) return undefined
            const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
            assert.isDefined(error)
            return { tag: error.reason._tag, retryable: error.isRetryable }
          })

        assert.deepStrictEqual(
          yield* classOf(Stream.fail(new RateLimited({ provider: "test", raw: "slow down" }))),
          { tag: "RateLimitError", retryable: true }
        )
        assert.deepStrictEqual(
          yield* classOf(Stream.fail(new ContentFiltered({ provider: "test", raw: "no" }))),
          { tag: "ContentPolicyError", retryable: false },
          "retrying a content-filtered request just repeats it"
        )
      }))

    it.effect("cancellation stays an interruption and produces no turn", () =>
      Effect.gen(function*() {
        const layer = yield* endingBadly([text("half an ans")], "interrupt")
        const exit = yield* Effect.exit(generate().pipe(Effect.provide(modelOver(layer))))

        assert.isTrue(Exit.isFailure(exit), "an interrupted generation must not succeed")
        if (!Exit.isFailure(exit)) return
        assert.isTrue(
          Cause.hasInterruptsOnly(exit.cause),
          `an interruption must not be reported as a failure: ${failureText(exit)}`
        )
      }))

    /**
     * The streaming half. Whatever the consumer saw before the failure is what
     * the provider actually produced -- but a `finish` part is the adapter
     * saying the turn completed, and it must not appear for a turn that did
     * not.
     */
    it.effect("no finish part is fabricated for a turn that never completed", () =>
      Effect.gen(function*() {
        const layer = yield* endingBadly([text("half an ans")], "fail")
        // The failure is swallowed on purpose: what is under test is the prefix
        // the consumer saw, not that the stream failed (asserted above).
        const seen = yield* Stream.runCollect(
          LanguageModel.streamText({ prompt: "hello" }).pipe(Stream.catchCause(() => Stream.empty))
        ).pipe(Effect.provide(modelOver(layer)))

        assert.deepStrictEqual(seen.filter((part) => part.type === "finish"), [])
        assert.isAbove(seen.length, 0, "the deltas before the failure should still have arrived")
      }))
  })


  /**
   * Phase 2's acceptance list, which the Phase 1 commit deliberately did not
   * claim. Streaming works because `LanguageModel.make` needs both hooks; that
   * is not the same as it being right.
   */
  describe("streaming lifecycle", () => {
    /** Every opened stream is closed: an unmatched start leaves a consumer waiting forever. */
    it.effect("text and reasoning streams are opened and closed in pairs", () =>
      Effect.gen(function*() {
        const { result } = yield* withModel(
          [
            { _tag: "ReasoningDelta", text: "thinking", kind: "trace" },
            text("and "),
            text("answering"),
            complete(turn([], "stop"))
          ],
          () => Stream.runCollect(LanguageModel.streamText({ prompt: "hello" }))
        )
        const parts = Exit.isSuccess(result) ? result.value : undefined
        assert.isDefined(parts, failureText(result))

        const count = (type: string) => parts.filter((part) => part.type === type).length
        assert.strictEqual(count("text-start"), count("text-end"), "a text stream was left open")
        assert.strictEqual(count("reasoning-start"), count("reasoning-end"), "a reasoning stream was left open")
        assert.strictEqual(count("text-start"), 1, "two deltas should share one text stream")
      }))

    /**
     * Interleaved calls, on the streaming path this time. The batch row above
     * proves the assembled calls; this proves the *fragments* stay attached to
     * the right call while both are in flight, which is where a translator
     * that keyed on "the current call" would merge them.
     */
    it.effect("argument fragments keep their call id and order while interleaved", () =>
      Effect.gen(function*() {
        const { result } = yield* withModel(
          [
            { _tag: "ToolCallStart", call_id: "a", name: "one" },
            { _tag: "ToolCallStart", call_id: "b", name: "two" },
            { _tag: "ToolCallArgsDelta", call_id: "a", delta: "{\"x\":" },
            { _tag: "ToolCallArgsDelta", call_id: "b", delta: "{\"y\":" },
            { _tag: "ToolCallArgsDelta", call_id: "a", delta: "1}" },
            { _tag: "ToolCallArgsDelta", call_id: "b", delta: "2}" },
            complete(
              turn(
                [
                  { type: "function_call", call_id: "a", name: "one", arguments: "{\"x\":1}" },
                  { type: "function_call", call_id: "b", name: "two", arguments: "{\"y\":2}" }
                ],
                "tool_calls"
              )
            )
          ],
          () =>
            Stream.runCollect(
              LanguageModel.streamText({
                prompt: "hello",
                toolkit: Toolkit.make(one, two),
                disableToolCallResolution: true
              })
            )
        )
        const parts = Exit.isSuccess(result) ? result.value : undefined
        assert.isDefined(parts, failureText(result))

        // Each fragment carries the id it belongs to, in the order it arrived.
        assert.deepStrictEqual(
          parts.flatMap((part) => part.type === "tool-params-delta" ? [[part.id, part.delta]] : []),
          [["a", "{\"x\":"], ["b", "{\"y\":"], ["a", "1}"], ["b", "2}"]]
        )

        // And the assembled calls say what the fragments spelled, rather than
        // one call wearing the other's arguments.
        assert.deepStrictEqual(
          parts.flatMap((part) => part.type === "tool-call" ? [[part.id, part.params]] : []),
          [["a", { x: 1 }], ["b", { y: 2 }]]
        )
      }))
  })

  /**
   * The plan's §9 claim, exercised: Affe's own `ExecutionPlan` fallback should
   * route between an official provider and an effect-uai-backed one without a
   * new fallback subsystem.
   *
   * The interesting half is the rule it must not break. `AgentTurn` streams
   * with `preventFallbackOnPartialStream`, because a fallback after partial
   * output would leave an observer holding text the transcript will never
   * contain. That guard is Affe's, above the model -- so what is under test is
   * whether an effect-uai step *participates* in it correctly, which it only
   * does if its stream fails the way the guard expects.
   */
  describe("as one step of an execution plan", () => {
    it.effect("a step that emitted nothing falls back, and the run is the fallback's", () =>
      Effect.gen(function*() {
        // Fails before any part: the fallback is invisible to an observer,
        // which is the outcome worth having.
        const failing = yield* endingBadly([], "fail")
        const { layer: fallback } = yield* FakeModel.layer([{ text: "the fallback answered" }])

        const result = yield* Effect.scoped(
          Effect.gen(function*() {
            const session = yield* AgentSession.make(
              Agent.make({ loop: AgentLoop.bounded(2) }).pipe(
                Agent.withExecutionPlan(
                  ExecutionPlan.make(
                    { provide: modelOver(failing) },
                    { provide: fallback }
                  )
                )
              )
            )
            return yield* AgentSession.prompt(session, "go")
          })
        )

        assert.strictEqual(result.text, "the fallback answered")
      }))

    /**
     * Streamed on purpose. The guard is `withPlanStream`, which only applies to
     * the streaming path -- a batch call that fails has emitted nothing to an
     * observer, so falling back is safe and correct there, and the row above
     * shows it happening.
     */
    it.effect("a streamed step that already emitted does not fall back, so no message blends two providers", () =>
      Effect.gen(function*() {
        // Emits text, then dies. The guard must stop the ladder here.
        const failing = yield* endingBadly([text("half an ans")], "fail")
        const { layer: fallback } = yield* FakeModel.layer([{ text: "the fallback answered" }])

        const exit = yield* Effect.exit(
          Effect.scoped(
            Effect.gen(function*() {
              const session = yield* AgentSession.make(
                Agent.make({ loop: AgentLoop.bounded(2) }).pipe(
                  Agent.withExecutionPlan(
                    ExecutionPlan.make(
                      { provide: modelOver(failing) },
                      { provide: fallback }
                    )
                  )
                )
              )
              return yield* AgentSession.prompt(session, "go", { stream: true })
            })
          )
        )

        // The run fails rather than answering. That is the conservative side of
        // the trade and the point of the rule: a viewer shown one message made
        // of two providers' words is a bug in every case, while a provider that
        // died halfway is rarely rescued by starting over.
        assert.isTrue(Exit.isFailure(exit), "the ladder continued past a step that had already emitted")
        const message = failureText(exit)
        assert.notInclude(message, "the fallback answered", "the fallback ran after partial output")
      }))
  })

  /** Phase 3: multimodal output and sources. */
  describe("images and citations", () => {
    it.effect("a finished image crosses as a file part, in both paths", () =>
      Effect.gen(function*() {
        const image = { _tag: "base64", base64: "aGVsbG8=", mimeType: "image/png" } as const
        const events: ReadonlyArray<TurnEvent> = [
          text("here it is"),
          { _tag: "ImageOutput", image },
          complete(turn([], "stop"))
        ]

        const batch = yield* withModel(events, () => generate())
        const batched = Exit.isSuccess(batch.result) ? batch.result.value : undefined
        assert.isDefined(batched, failureText(batch.result))
        const files = batched.content.filter((part) => part.type === "file")
        assert.strictEqual(files.length, 1)

        const streamed = yield* withModel(
          events,
          () => Stream.runCollect(LanguageModel.streamText({ prompt: "hello" }))
        )
        const parts = Exit.isSuccess(streamed.result) ? streamed.result.value : undefined
        assert.isDefined(parts, failureText(streamed.result))
        assert.strictEqual(
          parts.filter((part) => part.type === "file").length,
          1,
          "the two paths must agree about the image"
        )
      }))

    /**
     * A preview frame is dropped rather than emitted: the finished image also
     * arrives, and forwarding both would put the same image into canonical
     * history twice.
     */
    it.effect("a preview frame is dropped, so one image is not two", () =>
      Effect.gen(function*() {
        const image = { _tag: "base64", base64: "aGVsbG8=", mimeType: "image/png" } as const
        const { result } = yield* withModel(
          [
            { _tag: "ImageOutput", image, partialIndex: 0 },
            { _tag: "ImageOutput", image, partialIndex: 1 },
            { _tag: "ImageOutput", image },
            complete(turn([], "stop"))
          ],
          () => generate()
        )
        const response = Exit.isSuccess(result) ? result.value : undefined
        assert.isDefined(response, failureText(result))
        assert.strictEqual(response.content.filter((part) => part.type === "file").length, 1)
      }))

    /**
     * A response file part carries base64 and has no URL form, so an image the
     * provider only pointed at cannot cross without fetching it -- a request
     * this adapter has no business making on the caller's behalf.
     */
    it.effect("an image given only as a URL is refused rather than fetched", () =>
      Effect.gen(function*() {
        const { result } = yield* withModel(
          [
            {
              _tag: "ImageOutput",
              image: { _tag: "url", url: "https://example.com/cat.png", mimeType: "image/png" }
            },
            complete(turn([], "stop"))
          ],
          () => generate()
        )
        assert.isTrue(Exit.isFailure(result))
        assert.include(failureText(result), "URL")
      }))

    it.effect("a url citation crosses as a source, with its url and title", () =>
      Effect.gen(function*() {
        const { result } = yield* withModel(
          [
            text("grounded"),
            {
              _tag: "CitationAdded",
              annotation: { type: "url_citation", url: "https://example.com/a", title: "An example" }
            },
            complete(turn([], "stop"))
          ],
          () => generate()
        )
        const response = Exit.isSuccess(result) ? result.value : undefined
        assert.isDefined(response, failureText(result))

        const sources = response.content.filter((part) => part.type === "source")
        assert.strictEqual(sources.length, 1)
        const source = sources[0]
        assert.isDefined(source)
        if (source?.type !== "source" || source.sourceType !== "url") return
        // Decoded, not encoded: the wire carries a string and the part holds a URL.
        assert.strictEqual(String(source.url), "https://example.com/a")
        assert.strictEqual(source.title, "An example")
        assert.isNotEmpty(source.id, "a source part needs an id, and the citation carried none")
      }))

    it.effect("an assistant image replayed into a request crosses as output_image", () =>
      Effect.gen(function*() {
        const { recorder, result } = yield* withModel(
          [text("ok"), complete(turn([], "stop"))],
          () =>
            LanguageModel.generateText({
              prompt: Prompt.make([{
                role: "assistant",
                content: [{ type: "file", mediaType: "image/png", data: "aGVsbG8=" }]
              }])
            })
        )
        assert.isTrue(Exit.isSuccess(result), failureText(result))

        const history = only(yield* recorder.requests).history
        const blocks = history.flatMap((item) => item.type === "message" ? item.content : [])
        assert.isTrue(
          blocks.some((block) => block.type === "output_image"),
          "an assistant image must survive a replay rather than being refused"
        )
      }))
  })

  /**
   * A tool discovered at runtime, whose parameters are a JSON Schema rather
   * than an Effect `Schema`. This is what `/mcp` builds for every tool a server
   * offers, so it is the shape most tools crossing this boundary will have --
   * and it went untested through Phases 1 to 3 because every row until now
   * declared its tools at compile time.
   */
  describe("a dynamic tool, as MCP discovery produces", () => {
    const discovered = Tool.dynamic("lookup_order", {
      description: "look an order up by id",
      // A server's JSON Schema, verbatim: `Tool.dynamic`'s JSON-Schema mode.
      parameters: {
        type: "object",
        properties: { orderId: { type: "string", description: "the order id" } },
        required: ["orderId"],
        additionalProperties: false
      },
      failure: Schema.Unknown
    })

    it.effect("is described to the model with the server's own schema", () =>
      Effect.gen(function*() {
        const { recorder, result } = yield* withModel(
          [text("ok"), complete(turn([], "stop"))],
          () => generateWithTools(Toolkit.make(discovered))
        )
        assert.isTrue(Exit.isSuccess(result), failureText(result))

        const tools = only(yield* recorder.requests).tools
        assert.isDefined(tools)
        const tool = tools["lookup_order"]
        assert.isDefined(tool)
        assert.strictEqual(tool.description, "look an order up by id")

        // The descriptor carries the server's schema rather than a placeholder:
        // a model told `{}` would be told nothing about the arguments it is
        // meant to produce.
        const rendered = tool.inputSchema["~standard"].jsonSchema.input({ target: "draft-2020-12" })
        assert.deepStrictEqual(rendered["required"], ["orderId"])
        assert.property(rendered["properties"] as Record<string, unknown>, "orderId")
      }))

    it.effect("and its call comes back with arguments Affe can execute", () =>
      Effect.gen(function*() {
        const { result } = yield* withModel(
          [
            { _tag: "ToolCallStart", call_id: "o1", name: "lookup_order" },
            { _tag: "ToolCallArgsDelta", call_id: "o1", delta: "{\"orderId\":\"A-7\"}" },
            complete(
              turn(
                [{
                  type: "function_call",
                  call_id: "o1",
                  name: "lookup_order",
                  arguments: "{\"orderId\":\"A-7\"}"
                }],
                "tool_calls"
              )
            )
          ],
          () => generateWithTools(Toolkit.make(discovered))
        )
        const response = Exit.isSuccess(result) ? result.value : undefined
        assert.isDefined(response, failureText(result))

        const call = only(response.toolCalls)
        assert.strictEqual(call.name, "lookup_order")
        assert.deepStrictEqual(call.params, { orderId: "A-7" })
      }))
  })

  /**
   * §4.6's other half. The signature was proved to survive Affe's own
   * boundaries by `test/ProviderContinuation.test.ts`; this is the narrower
   * question of whether *this adapter* carries provider state across the
   * ecosystem gap, rather than quietly shortening what the provider sent.
   */
  describe("provider options across the boundary", () => {
    const cacheControl = { anthropic: { cacheControl: { type: "ephemeral" } } } as const

    it.effect("a tool call's and a tool result's options ride the item's providerData", () =>
      Effect.gen(function*() {
        const { recorder, result } = yield* withModel(
          [text("ok"), complete(turn([], "stop"))],
          () =>
            LanguageModel.generateText({
              prompt: Prompt.make([
                {
                  role: "assistant",
                  content: [{
                    type: "tool-call",
                    id: "c1",
                    name: "search",
                    params: { query: "effect" },
                    options: cacheControl
                  }]
                },
                {
                  role: "tool",
                  content: [{
                    type: "tool-result",
                    id: "c1",
                    name: "search",
                    result: "found",
                    isFailure: false,
                    providerExecuted: false,
                    options: cacheControl
                  }]
                }
              ])
            })
        )
        assert.isTrue(Exit.isSuccess(result), failureText(result))

        const history = only(yield* recorder.requests).history
        const call = history.find((item) => item.type === "function_call")
        const output = history.find((item) => item.type === "function_call_output")
        assert.isDefined(call)
        assert.isDefined(output)
        assert.deepStrictEqual(call?.providerData, cacheControl)
        assert.deepStrictEqual(output?.providerData, cacheControl)
      }))

    /**
     * The other direction. State that goes into a provider and never comes out
     * reads as a round trip right up until something needs the value, so a
     * returned item's `providerData` becomes part metadata.
     */
    it.effect("what a returned tool call carried comes back as part metadata", () =>
      Effect.gen(function*() {
        const returned = { openai: { responseId: "resp-7" } }
        const { result } = yield* withModel(
          [
            { _tag: "ToolCallStart", call_id: "c1", name: "search" },
            complete(
              turn(
                [{
                  type: "function_call",
                  call_id: "c1",
                  name: "search",
                  arguments: "{\"query\":\"effect\"}",
                  providerData: returned
                }],
                "tool_calls"
              )
            )
          ],
          () => generateWithTools(Toolkit.make(search))
        )
        const response = Exit.isSuccess(result) ? result.value : undefined
        assert.isDefined(response, failureText(result))

        const call = only(response.content.filter((part) => part.type === "tool-call"))
        assert.deepStrictEqual(
          (call.metadata as Record<string, unknown> | undefined)?.["@effect-harness/effect-uai"],
          returned,
          "continuation state went in and never came out"
        )
      }))

    /**
     * The image branch is a message block like any other, and was the one place
     * the slot problem went unsaid.
     */
    it.effect("options on an assistant image are reported too", () =>
      Effect.gen(function*() {
        const { degradations, result } = yield* withModel(
          [text("ok"), complete(turn([], "stop"))],
          () =>
            LanguageModel.generateText({
              prompt: Prompt.make([{
                role: "assistant",
                content: [{
                  type: "file",
                  mediaType: "image/png",
                  data: "aGVsbG8=",
                  options: cacheControl
                }]
              }])
            })
        )
        assert.isTrue(Exit.isSuccess(result), failureText(result))
        assert.isDefined(
          degradations.find((one) => one.feature.includes("assistant image")),
          "an image block lost its options without a word"
        )
      }))

    /**
     * The case that cannot cross, and therefore has to be said out loud: a uai
     * message has one `providerData` slot and many content blocks, so options
     * belonging to one block have nowhere to sit.
     */
    it.effect("options on a message block are reported, not dropped in silence", () =>
      Effect.gen(function*() {
        const { degradations, result } = yield* withModel(
          [text("ok"), complete(turn([], "stop"))],
          () =>
            LanguageModel.generateText({
              prompt: Prompt.make([{
                role: "assistant",
                content: [{ type: "text", text: "cached prefix", options: cacheControl }]
              }])
            })
        )
        assert.isTrue(Exit.isSuccess(result), failureText(result))

        const notice = degradations.find((one) => one.feature.includes("provider options"))
        assert.isDefined(notice, "a provider hint vanished without a word")
        assert.include(notice.reason, "one providerData slot")
      }))
  })
})
