import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { Hooks } from "../src/hooks/index.js"
import { AgentProbe, TestLanguageModel } from "../src/testing/index.js"

/**
 * Hooks are a typed dispatcher over the session's event stream. Tested against
 * the real events of a real run (collected once via AgentProbe, then dispatched
 * over an in-memory stream -- deterministic): registered handlers fire with
 * typed events, unregistered tags are ignored, and a handler that fails is
 * isolated -- it neither stops the other hooks nor ends the observer.
 */

const GetWeather = Tool.make("get_weather", {
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.String
})
const Weather = Agent.make({
  instructions: "weather",
  tools: [Agent.tool(GetWeather, ({ city }) => Effect.succeed(`Sunny in ${city}`))],
  loop: AgentLoop.bounded(4)
})

// One real run's events.
const collectEnvelopes = Effect.gen(function* () {
  const { layer } = yield* TestLanguageModel.script([
    { toolCalls: [{ id: "w1", name: "get_weather", params: { city: "Paris" } }] },
    TestLanguageModel.text("It is Sunny in Paris.")
  ])
  return yield* Effect.gen(function* () {
    const session = yield* AgentSession.make(Weather)
    const probe = yield* AgentProbe.make(session)
    yield* session.prompt("weather in Paris?")
    return yield* probe.events
  }).pipe(Effect.provide(layer), Effect.scoped)
})

describe("Hooks.on", () => {
  it.effect("dispatches registered tags with typed events and ignores the rest", () =>
    Effect.gen(function* () {
      const envelopes = yield* collectEnvelopes
      const tools = yield* Ref.make<ReadonlyArray<string>>([])
      const completed = yield* Ref.make(0)
      yield* Hooks.on(Stream.fromIterable(envelopes), {
        // `event.name` is available because the tag narrows the event type.
        ToolCallStarted: (event) => Ref.update(tools, (all) => [...all, event.name]),
        RunCompleted: () => Ref.update(completed, (n) => n + 1)
      })

      assert.deepStrictEqual(yield* Ref.get(tools), ["get_weather"])
      assert.strictEqual(yield* Ref.get(completed), 1)
    })
  )

  it.effect("a failing handler is isolated: onError sees it, other hooks still fire, dispatch continues", () =>
    Effect.gen(function* () {
      const envelopes = yield* collectEnvelopes
      const errors = yield* Ref.make(0)
      const others = yield* Ref.make(0)
      // If the failure were not isolated, the failing handler would abort the
      // whole dispatch -- we would never reach the assertions or the sibling.
      yield* Hooks.on(
        Stream.fromIterable(envelopes),
        {
          ToolCallStarted: () => Effect.fail("hook boom" as const),
          ToolCallSucceeded: () => Ref.update(others, (n) => n + 1)
        },
        { onError: () => Ref.update(errors, (n) => n + 1) }
      )

      assert.strictEqual(yield* Ref.get(errors), 1)
      assert.strictEqual(yield* Ref.get(others), 1)
    })
  )
})
