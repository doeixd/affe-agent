import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * The library has no retry engine of its own -- retrying a flaky model is
 * ordinary Effect composition (wrap the provider layer in `Effect.retry`). These
 * tests pin that a run recovers from a transient model failure, fails for real
 * when the retry budget is exhausted, and that retry composes across a
 * multi-turn tool loop. All deterministic: `TestLanguageModel.flaky` fails the
 * first N attempts and records every attempt, so the retries are asserted, not
 * assumed.
 */

const Simple = Agent.make({ loop: AgentLoop.bounded(4) })

describe("retry (user-supplied, over a flaky model)", () => {
  it.effect("a run recovers from a transient model failure and completes", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const { layer: base } = yield* TestLanguageModel.script([TestLanguageModel.text("recovered")])
      const model = TestLanguageModel.flaky(base, { failFirst: 2, retries: 3, attempts })

      const result = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(Simple), (session) =>
          AgentSession.prompt(session, "go"))
      ).pipe(Effect.provide(model))

      assert.strictEqual(result.status, "completed")
      assert.strictEqual(result.text, "recovered")
      // Two failures then one success for the single model call this run makes.
      assert.strictEqual(yield* Ref.get(attempts), 3)
    })
  )

  it.effect("the run fails for real once the retry budget is exhausted", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const { layer: base } = yield* TestLanguageModel.script([TestLanguageModel.text("never reached")])
      // 3 transient failures but only 2 retries (3 attempts total) -> exhausted.
      const model = TestLanguageModel.flaky(base, { failFirst: 3, retries: 2, attempts })

      const exit = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(Simple), (session) =>
          AgentSession.prompt(session, "go"))
      ).pipe(Effect.provide(model), Effect.exit)

      assert.isTrue(Exit.isFailure(exit))
      // initial try + 2 retries, all failing, and the scripted turn was never consumed.
      assert.strictEqual(yield* Ref.get(attempts), 3)
    })
  )

  it.effect("retry composes across a multi-turn tool loop", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const Noop = Tool.make("noop", {
        parameters: Schema.Struct({}),
        success: Schema.String
      })
      const noop = Agent.tool(Noop, () => Effect.succeed("ok"))
      const agent = Agent.make({ tools: [noop], loop: AgentLoop.bounded(4) })

      const { layer: base } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "n1", name: "noop", params: {} }] },
        TestLanguageModel.text("done")
      ])
      // The first model attempt fails and is retried; the run still drives both
      // turns of the tool loop to completion.
      const model = TestLanguageModel.flaky(base, { failFirst: 1, retries: 2, attempts })

      const result = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(agent), (session) =>
          AgentSession.prompt(session, "go"))
      ).pipe(Effect.provide(model))

      assert.strictEqual(result.status, "completed")
      assert.strictEqual(result.text, "done")
      assert.strictEqual(result.turns, 2)
    })
  )
})
