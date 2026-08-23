import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Tool } from "effect/unstable/ai"
import { Schema } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { Evals } from "../src/evals/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Behavioural evals for an agent, run two ways from one definition.
 *
 * An eval asserts on what the agent *did* -- tools called, turns taken, the
 * reply -- through the public session interface. Because it never touches
 * internals, the same eval runs against a deterministic scripted model (exact,
 * free, CI-friendly) or a real provider (swap the LanguageModel layer). Nothing
 * about the eval changes between the two.
 */

const GetWeather = Tool.make("get_weather", {
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.String
})
const WeatherAgent = Agent.make({
  instructions: "Answer weather questions using get_weather.",
  tools: [Agent.tool(GetWeather, ({ city }) => Effect.succeed(`Sunny in ${city}`))],
  loop: AgentLoop.bounded(4)
})

const reportsWeather = Evals.defineEval({
  name: "reports the weather for the asked city",
  agent: WeatherAgent,
  test: (t) =>
    Effect.gen(function* () {
      yield* t.send("what's the weather in Paris?")
      yield* t.succeeded()
      yield* t.calledTool("get_weather")
      yield* t.reply(Evals.includes("Sunny"))
      yield* t.turns(Evals.atMost(3))
    })
})

const program = Effect.gen(function* () {
  const results = yield* Evals.runAll([reportsWeather])
  yield* Effect.log(Evals.formatText(results))
  return results
})

// Deterministic: a scripted model makes the eval exact and repeatable in CI.
const scripted = Effect.gen(function* () {
  const { layer } = yield* TestLanguageModel.script([
    { toolCalls: [{ id: "w1", name: "get_weather", params: { city: "Paris" } }] },
    TestLanguageModel.text("It is Sunny in Paris.")
  ])
  return yield* program.pipe(Effect.provide(layer))
})

// The same eval against a real provider -- only the layer changes.
const live = program.pipe(
  Effect.provide(
    AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
      Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
      Layer.provide(FetchHttpClient.layer)
    )
  )
)

void scripted
void live
