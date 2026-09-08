import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Ref, Schema, Stream } from "effect"
import { IdGenerator, LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai"
import * as UaiLanguageModel from "@effect-uai/core/LanguageModel"
import type { Turn as UaiTurn, TurnEvent } from "@effect-uai/core/Turn"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Permission from "../src/Permission.js"
import * as Compatibility from "../src/effect-uai/Compatibility.js"
import * as EffectUaiModel from "../src/effect-uai/EffectUaiModel.js"

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

    it.effect("a citation is refused, because Phase 1 does not claim sources", () =>
      Effect.gen(function*() {
        const { result } = yield* withModel(
          [
            text("grounded"),
            {
              _tag: "CitationAdded",
              annotation: { type: "url_citation", url: "https://example.com", title: "Example" }
            },
            complete(turn([], "stop"))
          ],
          () => generate()
        )
        assert.isTrue(Exit.isFailure(result))
        assert.include(failureText(result), "citation")
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
})
