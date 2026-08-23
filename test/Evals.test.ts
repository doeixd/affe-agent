import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { Evals } from "../src/evals/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Evals run an agent through its public interface and assert on behaviour. All
 * deterministic here: a scripted model stands in for a provider, so every check
 * -- tools called, turns taken, reply shape, even the LLM judge -- is exact.
 */

const GetWeather = Tool.make("get_weather", {
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.String
})
const weather = Agent.tool(GetWeather, ({ city }) => Effect.succeed(`Sunny in ${city}`))

const WeatherAgent = Agent.make({
  instructions: "Answer weather questions using get_weather.",
  tools: [weather],
  loop: AgentLoop.bounded(4)
})

const weatherScript = (): ReadonlyArray<TestLanguageModel.Turn> => [
  { toolCalls: [{ id: "w1", name: "get_weather", params: { city: "Paris" } }] },
  TestLanguageModel.text("It is Sunny in Paris.")
]

const hasCity = (city: string) =>
  Evals.satisfying<unknown>(`city = ${city}`, (params) =>
    typeof params === "object" && params !== null && "city" in params && params.city === city)

describe("Evals", () => {
  it.effect("records every behavioural check and passes when they all hold", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script(weatherScript())
      const evaluation = Evals.defineEval({
        name: "reports the weather",
        agent: WeatherAgent,
        test: (t) =>
          Effect.gen(function* () {
            const result = yield* t.send("what's the weather in Paris?")
            yield* t.succeeded()
            yield* t.calledTool("get_weather")
            yield* t.calledToolWith("get_weather", hasCity("Paris"))
            yield* t.notCalledTool("get_stock")
            yield* t.toolCalls(Evals.equals(1))
            yield* t.reply(Evals.includes("Sunny"))
            yield* t.turns(Evals.atMost(3))
            yield* t.tokens(Evals.atMost(1_000_000))
            yield* t.check("reply length", result.text.length, Evals.atLeast(1))
          })
      })
      const result = yield* Evals.run(evaluation).pipe(Effect.provide(layer))

      assert.isTrue(result.passed)
      assert.isTrue(result.checks.length >= 8)
      assert.isTrue(result.checks.every((check) => check.passed))
    })
  )

  it.effect("a failed check makes the eval fail and carries a detail", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script(weatherScript())
      const evaluation = Evals.defineEval({
        name: "expects rain",
        agent: WeatherAgent,
        test: (t) =>
          Effect.gen(function* () {
            yield* t.send("weather?")
            yield* t.reply(Evals.includes("Rainy")) // it said Sunny
            yield* t.calledTool("get_weather") // this one holds
          })
      })
      const result = yield* Evals.run(evaluation).pipe(Effect.provide(layer))

      assert.isFalse(result.passed)
      const failed = result.checks.find((check) => !check.passed)
      assert.isDefined(failed)
      assert.include(failed?.detail ?? "", "Sunny")
      // The check after the failing one still ran -- recorded, not thrown.
      assert.isTrue(result.checks.some((check) => check.label.startsWith("calledTool") && check.passed))
    })
  )

  it.effect("a check before any send records 'no send yet' rather than throwing", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("unused")])
      const evaluation = Evals.defineEval({
        name: "premature check",
        agent: WeatherAgent,
        test: (t) => t.succeeded()
      })
      const result = yield* Evals.run(evaluation).pipe(Effect.provide(layer))
      assert.isFalse(result.passed)
      assert.include(result.checks[0]?.detail ?? "", "no send yet")
    })
  )

  it.effect("the LLM judge scores the reply through the same model interface", () =>
    Effect.gen(function* () {
      // Turn one answers; the judge's own generateText consumes turn two.
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.text("The answer is 42."),
        TestLanguageModel.text("PASS")
      ])
      const evaluation = Evals.defineEval({
        name: "judged",
        agent: Agent.make({ instructions: "answer", loop: AgentLoop.bounded(2) }),
        test: (t) =>
          Effect.gen(function* () {
            yield* t.send("what is the answer?")
            yield* t.judge("Does the reply contain a number?")
          })
      })
      const result = yield* Evals.run(evaluation).pipe(Effect.provide(layer))
      assert.isTrue(result.passed)
    })
  )

  it.effect("runAll reports each eval independently, and the reporters render them", () =>
    Effect.gen(function* () {
      // One shared, sequentially-consumed script: eval one takes the first pair
      // of turns, eval two the next. runAll defaults to concurrency 1.
      const { layer } = yield* TestLanguageModel.script([...weatherScript(), ...weatherScript()])
      const passing = Evals.defineEval({
        name: "passing",
        agent: WeatherAgent,
        test: (t) => Effect.gen(function* () {
          yield* t.send("weather?")
          yield* t.reply(Evals.includes("Sunny"))
        })
      })
      const failing = Evals.defineEval({
        name: "failing",
        agent: WeatherAgent,
        test: (t) => Effect.gen(function* () {
          yield* t.send("weather?")
          yield* t.reply(Evals.includes("Snow"))
        })
      })
      const results = yield* Evals.runAll([passing, failing]).pipe(Effect.provide(layer))

      assert.deepStrictEqual(results.map((r) => [r.name, r.passed]), [["passing", true], ["failing", false]])
      const text = Evals.formatText(results)
      assert.include(text, "PASS  passing")
      assert.include(text, "FAIL  failing")
      assert.include(text, "1/2 evals passed")
      const junit = Evals.formatJUnit(results)
      assert.include(junit, "<testsuite name=\"evals\"")
      assert.include(junit, "<failure>")
    })
  )
})
