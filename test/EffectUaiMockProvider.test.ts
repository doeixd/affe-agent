import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Ref, Schema } from "effect"
import { IdGenerator, LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import type { Turn as UaiTurn } from "@effect-uai/core/Turn"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Compatibility from "../src/effect-uai/Compatibility.js"
import * as EffectUaiModel from "../src/effect-uai/EffectUaiModel.js"

/**
 * The adapter against **effect-uai's own** provider fixture.
 *
 * `test/EffectUaiModel.test.ts` drives a scripted provider written here, from
 * the same type declarations the adapter was written from. That makes it a good
 * test of the translation and a poor test of one thing: whether those
 * declarations were read correctly. A misunderstanding of the event protocol —
 * what order deltas arrive in, when `ToolCallStart` fires relative to its
 * arguments, what `TurnComplete` repeats — would be baked into the fake and the
 * adapter alike, and every row would still pass.
 *
 * `MockProvider` is their code deriving the deltas from a scripted `Turn`, so
 * these tests fail if that reading was wrong. They are deliberately few: this
 * is a check on the protocol, not a second copy of the conformance rows.
 *
 * It is still not a real provider. No HTTP, no provider quirks, and their mock
 * could share a misconception with their providers. That evidence needs a
 * network test with a key, and does not exist yet.
 */

const ids = Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator)

const modelOver = (
  turns: ReadonlyArray<UaiTurn>,
  onDegraded?: Compatibility.OnDegraded
) =>
  EffectUaiModel.layer({
    model: "mock-model",
    ...(onDegraded === undefined ? {} : { onDegraded })
  }).pipe(Layer.provide(MockProvider.layer(turns)))

const assistant = (text: string): UaiTurn => ({
  items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  usage: { input_tokens: 3, output_tokens: 5 },
  stop_reason: "stop"
})

const search = Tool.make("search", {
  description: "search the web",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String
})

describe("EffectUaiModel against effect-uai's own MockProvider", () => {
  it.effect("text and usage arrive as the adapter expects", () =>
    Effect.gen(function*() {
      const response = yield* LanguageModel.generateText({ prompt: "hello" }).pipe(
        Effect.provide(Layer.mergeAll(modelOver([assistant("mocked answer")]), ids))
      )
      assert.strictEqual(response.text, "mocked answer")
      assert.strictEqual(response.finishReason, "stop")
      assert.strictEqual(response.usage.inputTokens.total, 3)
      assert.strictEqual(response.usage.outputTokens.total, 5)
    }))

  /**
   * The ordering claim, checked against their generator rather than mine.
   *
   * Their mock emits `ToolCallStart` then a single `ToolCallArgsDelta` carrying
   * the whole argument string, then `TurnComplete`. The adapter has to assemble
   * a call from that and hand Effect AI exactly one.
   */
  it.effect("a scripted tool call assembles into exactly one call", () =>
    Effect.gen(function*() {
      const turn: UaiTurn = {
        items: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "looking" }] },
          { type: "function_call", call_id: "c1", name: "search", arguments: "{\"query\":\"effect\"}" }
        ],
        usage: {},
        stop_reason: "tool_calls"
      }
      const response = yield* LanguageModel.generateText({
        prompt: "hello",
        toolkit: Toolkit.make(search),
        disableToolCallResolution: true
      }).pipe(Effect.provide(Layer.mergeAll(modelOver([turn]), ids)))

      assert.strictEqual(response.text, "looking")
      assert.strictEqual(response.toolCalls.length, 1)
      const call = response.toolCalls[0]
      assert.isDefined(call)
      assert.strictEqual(call.id, "c1")
      assert.strictEqual(call.name, "search")
      assert.deepStrictEqual(call.params, { query: "effect" })
      assert.strictEqual(response.finishReason, "tool-calls")
    }))

  /**
   * Their mock only ever emits reasoning as `kind: "summary"`, which is the
   * degraded row: Effect AI has one reasoning channel, so a model-written
   * summary is indistinguishable from a trace once it crosses. Worth pinning
   * against their generator, because it is the case our own fake had to be
   * told to produce.
   */
  it.effect("a summary-kind reasoning delta crosses and is reported as degraded", () =>
    Effect.gen(function*() {
      const collected = yield* Ref.make<Array<Compatibility.Degradation>>([])
      const turn: UaiTurn = {
        items: [
          { type: "reasoning", summary: "thought about it", signature: "sig-1" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }
        ],
        usage: {},
        stop_reason: "stop"
      }
      const response = yield* LanguageModel.generateText({ prompt: "hello" }).pipe(
        Effect.provide(Layer.mergeAll(
          modelOver([turn], (one) => Ref.update(collected, (all) => [...all, one])),
          ids
        ))
      )

      assert.strictEqual(response.reasoningText, "thought about it")
      assert.strictEqual(response.text, "answer")
      const degradations = yield* Ref.get(collected)
      assert.isDefined(
        degradations.find((one) => one.feature === "reasoning summary"),
        "a summary arriving as an indistinguishable trace is a loss worth reporting"
      )
    }))

  /**
   * The acceptance, once more, with their provider underneath: a tool call
   * crosses the boundary and Affe executes it.
   */
  it.effect("an AgentSession runs the tool, driven by their provider", () =>
    Effect.gen(function*() {
      const ran = yield* Ref.make<Array<string>>([])
      const turn: UaiTurn = {
        items: [{ type: "function_call", call_id: "c1", name: "search", arguments: "{\"query\":\"effect\"}" }],
        usage: {},
        stop_reason: "tool_calls"
      }

      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* AgentSession.make(
            Agent.make({
              tools: [
                Agent.tool(search, (input) =>
                  Effect.as(Ref.update(ran, (all) => [...all, input.query]), "found it"))
              ],
              loop: AgentLoop.bounded(1)
            })
          )
          return yield* AgentSession.prompt(session, "go")
        }).pipe(Effect.provide(Layer.mergeAll(modelOver([turn]), ids)))
      )

      assert.deepStrictEqual(yield* Ref.get(ran), ["effect"])
      assert.strictEqual(result.status, "completed")
    }))

  /**
   * Their mock fails the *stream* once the script runs out, rather than
   * returning an empty turn. That reaches the adapter as a provider error mid
   * stream, and it must stay a failure rather than becoming an answer with no
   * text — the shape a retry or fallback policy has to be able to see.
   */
  it.effect("an exhausted script surfaces as a provider failure, not an empty answer", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        LanguageModel.generateText({ prompt: "hello" }).pipe(
          Effect.provide(Layer.mergeAll(modelOver([]), ids))
        )
      )
      assert.isTrue(Exit.isFailure(exit))
    }))
})
