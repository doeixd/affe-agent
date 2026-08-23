import { Effect } from "effect"
import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Deterministic agent tests with the scripted model.
 *
 * Typechecked, not executed. `TestLanguageModel.script` replays a fixed list of
 * turns in place of a real provider, so loop continuation, tool calls and the
 * final reply are exact assertions rather than observations. A turn can be text,
 * a tool call, or carry hooks (`started`, `during`, `hang`, `fail`, `usage`);
 * `recorder` exposes the model-facing prompts the harness derived. This is the
 * same model the library's own suite runs against -- no network, no flakiness.
 */

const GetWeather = Tool.make("get_weather", {
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.String
})
const weather = Agent.tool(GetWeather, ({ city }) => Effect.succeed(`Sunny in ${city}`))

const Assistant = Agent.make({
  instructions: "Answer weather questions using get_weather.",
  tools: [weather],
  loop: AgentLoop.bounded(4)
})

export const main = Effect.gen(function* () {
  // Turn 1 calls the tool; turn 2 answers. The run drives both deterministically.
  const { layer, recorder } = yield* TestLanguageModel.script([
    { toolCalls: [{ id: "w1", name: "get_weather", params: { city: "Paris" } }] },
    TestLanguageModel.text("It is Sunny in Paris.")
  ])

  return yield* Effect.scoped(
    Effect.flatMap(AgentSession.make(Assistant), (session) =>
      Effect.gen(function* () {
        const result = yield* AgentSession.prompt(session, "weather in Paris?")
        const prompts = yield* recorder.prompts // what the model actually saw, per call
        return { text: result.text, turns: result.turns, modelCalls: prompts.length }
      }))
  ).pipe(Effect.provide(layer))
})
