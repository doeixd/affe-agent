import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient } from "../src/client/index.js"
import { AgentMcp } from "../src/mcp/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * The MCP adapter is tested at its handler rather than through a protocol
 * transport. The transport is Effect's code; what belongs to this project is
 * the mapping from an MCP tool call onto a session — in particular whether
 * `sessionId` really continues a conversation, which is the part a client can
 * observe and the part that is easy to get subtly wrong.
 */
const withAgent = <A, E>(
  turns: ReadonlyArray<TestLanguageModel.Turn>,
  use: (
    ask: (params: {
      readonly prompt: string
      readonly sessionId?: string
    }) => Effect.Effect<string, unknown>,
    recorder: TestLanguageModel.Recorder
  ) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const { layer: model, recorder } = yield* TestLanguageModel.script(turns)

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const bound = yield* AgentMcp.AgentToolkit.pipe(
          Effect.provide(Layer.unwrap(AgentMcp.handlers))
        )

        // A tool handler returns a stream of results; the final one is the
        // answer, exactly as `ToolExecution` treats it.
        const ask = (params: {
          readonly prompt: string
          readonly sessionId?: string
        }) =>
          bound.handle("ask_agent", params).pipe(
            Effect.flatMap(Stream.runCollect),
            Effect.map((results) => String(results[results.length - 1]?.result))
          )

        return yield* use(ask, recorder)
      })
    ).pipe(
      Effect.provide(
        AgentClient.layer(Agent.make({ loop: AgentLoop.bounded(2) })).pipe(
          Layer.provide(model)
        )
      )
    )
  })

describe("agent over MCP", () => {
  it.effect("answers a one-shot question", () =>
    withAgent([TestLanguageModel.text("the answer is 42")], (ask) =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* ask({ prompt: "what is the answer?" }),
          "the answer is 42"
        )
      })
    )
  )

  it.effect("continues a conversation when given the same session id", () =>
    withAgent(
      [TestLanguageModel.text("noted"), TestLanguageModel.text("you said 41")],
      (ask, recorder) =>
        Effect.gen(function* () {
          yield* ask({ prompt: "remember 41", sessionId: "chat-1" })
          yield* ask({ prompt: "what did I say?", sessionId: "chat-1" })

          // Asserting the *answer* proves nothing: a scripted model returns
          // turn 2's text whether or not the session was reused. What
          // discriminates is the prompt the model was given -- the second call
          // must have carried the first exchange.
          const second = (yield* recorder.prompts)[1]
          assert.isDefined(second)
          assert.deepStrictEqual(TestLanguageModel.userTexts(second), [
            "remember 41",
            "what did I say?"
          ])
        })
    )
  )

  it.effect("gives an unnamed call its own session", () =>
    withAgent(
      [TestLanguageModel.text("first"), TestLanguageModel.text("second")],
      (ask, recorder) =>
        Effect.gen(function* () {
          // Omitting `sessionId` is the one-shot case: two calls must not see
          // each other, or an MCP client asking unrelated questions would
          // accumulate a conversation it never asked for.
          yield* ask({ prompt: "unrelated one" })
          yield* ask({ prompt: "unrelated two" })

          const second = (yield* recorder.prompts)[1]
          assert.isDefined(second)
          assert.deepStrictEqual(TestLanguageModel.userTexts(second), [
            "unrelated two"
          ])
        })
    )
  )
})
