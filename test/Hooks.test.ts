import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Ref, Schema, Stream } from "effect"
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

class Tracker extends Context.Service<Tracker, { readonly bump: Effect.Effect<void> }>()("test/Hooks/Tracker") {}

describe("Hooks.on isolation and inference", () => {
  it.effect("without onError, a failing handler is swallowed and dispatch continues", () =>
    Effect.gen(function* () {
      const envelopes = yield* collectEnvelopes
      const others = yield* Ref.make(0)
      // No onError: the default path must swallow-and-log, not abort the stream.
      yield* Hooks.on(Stream.fromIterable(envelopes), {
        ToolCallStarted: () => Effect.fail("boom" as const),
        ToolCallSucceeded: () => Ref.update(others, (n) => n + 1)
      })
      assert.strictEqual(yield* Ref.get(others), 1)
    })
  )

  it.effect("a synchronous throw in a handler is isolated, not only a failed Effect", () =>
    Effect.gen(function* () {
      const envelopes = yield* collectEnvelopes
      const ran = yield* Ref.make(0)
      // Throws before returning its Effect -- only caught because the call is
      // deferred inside the isolation boundary.
      yield* Hooks.on(Stream.fromIterable(envelopes), {
        // Annotated so the throwing handler's type stays an Effect (a bare
        // `() => { throw }` infers `never`, which is a separate typing concern).
        ToolCallStarted: (): Effect.Effect<void> => {
          throw new Error("sync boom")
        },
        RunCompleted: () => Ref.update(ran, (n) => n + 1)
      })
      // RunCompleted still fired -> the sync throw did not tear down the stream.
      assert.strictEqual(yield* Ref.get(ran), 1)
    })
  )

  it.effect("a failing onError does not end the observer", () =>
    Effect.gen(function* () {
      const envelopes = yield* collectEnvelopes
      const ran = yield* Ref.make(0)
      yield* Hooks.on(
        Stream.fromIterable(envelopes),
        {
          ToolCallStarted: () => Effect.fail("boom" as const),
          RunCompleted: () => Ref.update(ran, (n) => n + 1)
        },
        { onError: () => Effect.fail("onError boom" as const) }
      )
      // Even though both the hook and onError failed, the stream ran to the end.
      assert.strictEqual(yield* Ref.get(ran), 1)
    })
  )

  it.effect("a handler's service requirement surfaces in the requirements and is provided", () =>
    Effect.gen(function* () {
      const envelopes = yield* collectEnvelopes
      const count = yield* Ref.make(0)
      // The annotation asserts inference: R is Tracker, not never/unknown.
      const program: Effect.Effect<void, never, Tracker> = Hooks.on(Stream.fromIterable(envelopes), {
        RunCompleted: () => Effect.flatMap(Tracker, (t) => t.bump)
      })
      yield* program.pipe(Effect.provide(Layer.succeed(Tracker, { bump: Ref.update(count, (n) => n + 1) })))
      assert.strictEqual(yield* Ref.get(count), 1)
    })
  )

  it.effect("an unregistered tag never fires", () =>
    Effect.gen(function* () {
      const envelopes = yield* collectEnvelopes
      const elicits = yield* Ref.make(0)
      const completed = yield* Ref.make(0)
      yield* Hooks.on(Stream.fromIterable(envelopes), {
        ElicitationRequested: () => Ref.update(elicits, (n) => n + 1), // no elicitation in this run
        RunCompleted: () => Ref.update(completed, (n) => n + 1)
      })
      assert.strictEqual(yield* Ref.get(elicits), 0)
      assert.strictEqual(yield* Ref.get(completed), 1)
    })
  )

  it.effect("dispatches over a live session's event stream when forked beside the run", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "w1", name: "get_weather", params: { city: "Paris" } }] },
        TestLanguageModel.text("done")
      ])
      const seen = yield* Effect.gen(function* () {
        const tools = yield* Ref.make<ReadonlyArray<string>>([])
        const session = yield* AgentSession.make(Weather)
        yield* Effect.forkScoped(Hooks.on(AgentSession.events(session), {
          ToolCallStarted: (event) => Ref.update(tools, (all) => [...all, event.name])
        }))
        yield* Effect.yieldNow
        yield* session.prompt("weather?")
        yield* Effect.yieldNow
        return yield* Ref.get(tools)
      }).pipe(Effect.provide(layer), Effect.scoped)
      assert.deepStrictEqual([...seen], ["get_weather"])
    })
  )
})
