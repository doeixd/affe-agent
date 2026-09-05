import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { Budget } from "../src/budget/index.js"
import * as ModelCapabilities from "../src/model/ModelCapabilities.js"
import { Presets } from "../src/presets/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Item 60i: the first-hour spelling expands to the seams.
 *
 * `Presets.policy` is sugar, so the property that matters is that it adds
 * nothing: what it builds is exactly what the seams would describe, and
 * `readPolicy` gets the record back out of that description. The round trip
 * is the test the plan asked for; the run rows check the expansion binds.
 */

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

// The sugar adds no requirement the record did not name. A record with no
// ceiling is as free as `AgentLoop.maxTurns`; one with `cost` needs the
// table and can fail to price. Break by widening `Ceiling` to `Budget.Budget`.
const free = Presets.policy({ maxTurns: 2 })
type _FreeLoop = Assert<Equal<typeof free.loop, AgentLoop.AgentLoop<never, never, any>>>
type _FreeLayer = Assert<Equal<typeof free.layer, Layer.Layer<never>>>
const metered = Presets.policy({ tokens: 10 })
type _MeteredLoop = Assert<Equal<typeof metered.loop, AgentLoop.AgentLoop<never, Budget.Budget, any>>>
type _MeteredLayer = Assert<Equal<typeof metered.layer, Layer.Layer<Budget.Budget>>>
// A record typed wide may carry a cost at runtime, so it is typed as needing
// everything it might: the sound direction. Break by testing for presence.
const wide: Presets.PolicyOptions = { maxTurns: 2 }
const fromWide = Presets.policy(wide)
type _WideLayer = Assert<Equal<typeof fromWide.layer, Layer.Layer<Budget.Budget>>>
const priced = Presets.policy({ cost: 1 })
type _PricedLoop = Assert<
  Equal<
    typeof priced.loop,
    AgentLoop.AgentLoop<
      ModelCapabilities.UnknownModelError | ModelCapabilities.UnknownCurrentModelError | ModelCapabilities.UnpricedModelError,
      Budget.Budget | ModelCapabilities.ModelCapabilities,
      any
    >
  >
>

const Noop = Tool.make("noop", { parameters: Schema.Struct({}), success: Schema.String })
const noop = Agent.tool(Noop, () => Effect.succeed("ok"))
const call = { id: "n", name: "noop", params: {} }

describe("Presets.policy", () => {
  it("describe(policy(p)) reads back as p", () => {
    const records: ReadonlyArray<Presets.PolicyOptions> = [
      {},
      { maxTurns: 8 },
      { maxToolCalls: 20, finalTurn: true },
      { finalTurn: true },
      { tokens: 10 },
      { cost: 2.5 },
      { maxTurns: 8, maxToolCalls: 20, maxDuration: "2 minutes", finalTurn: true, tokens: 50_000, cost: 5 }
    ]
    for (const record of records) {
      const { loop } = Presets.policy(record)
      const read = Presets.readPolicy(Agent.describe(Agent.make({ loop })).loop)
      // A duration comes back in milliseconds, the one normalisation.
      const expected = { ...record, ...(record.maxDuration === undefined ? {} : { maxDuration: 120_000 }) }
      assert.deepStrictEqual(read, Option.some(expected), JSON.stringify(record))
    }
  })

  it("the expansion is the seams' own description, outermost last", () => {
    const { loop, layer } = Presets.policy({ maxTurns: 8, maxDuration: "2 minutes", finalTurn: true, tokens: 50_000, cost: 5 })
    assert.deepStrictEqual(loop.description, {
      _tag: "Custom",
      name: "Budget.cost",
      details: { limit: 5 },
      inner: {
        _tag: "Custom",
        name: "Budget.within",
        details: { limit: 50_000 },
        inner: {
          _tag: "FinalTurn",
          inner: { _tag: "And", loops: [{ _tag: "UntilIdle" }, { _tag: "MaxTurns", max: 8 }, { _tag: "MaxDuration", millis: 120_000 }] }
        }
      }
    })
    assert.notStrictEqual(layer, Layer.empty)
    // No ceiling, no budget to provide: the layer is empty, the loop is idle.
    const plain = Presets.policy({ maxTurns: 3 })
    assert.strictEqual(plain.layer, Layer.empty)
    assert.deepStrictEqual(Presets.policy({}).loop.description, { _tag: "UntilIdle" })
  })

  it("a loop that is not a policy record reads as None rather than as a guess", () => {
    const loops = [
      AgentLoop.or(AgentLoop.maxTurns(3), AgentLoop.untilIdle()),
      AgentLoop.and(AgentLoop.maxTurns(3), AgentLoop.maxTurns(4)),
      AgentLoop.and(AgentLoop.untilIdle(), AgentLoop.maxTurns(3), AgentLoop.maxTurns(4)),
      AgentLoop.make(() => Effect.succeed(AgentLoop.Stop)),
      AgentLoop.withFinalTurn(AgentLoop.withFinalTurn(AgentLoop.untilIdle())),
      // A bare bound is a loop `policy` never builds: it always stands on `untilIdle`.
      AgentLoop.maxTurns(3),
      AgentLoop.and(AgentLoop.maxTurns(3), AgentLoop.untilIdle())
    ]
    for (const loop of loops) {
      assert.deepStrictEqual(Presets.readPolicy(loop.description), Option.none(), JSON.stringify(loop.description))
    }
  })

  it.effect("the expansion binds: a turn ceiling and a token ceiling each end the run where the record says", () =>
    Effect.gen(function* () {
      const run = <L>(bounds: Presets.Policy<never, L, L>, turns: ReadonlyArray<TestLanguageModel.Turn>) =>
        Effect.gen(function* () {
          const { layer: model } = yield* TestLanguageModel.script(turns)
          const result = yield* Effect.scoped(
            Effect.flatMap(
              AgentSession.make(Agent.make({ tools: [noop], loop: bounds.loop })),
              (session) => AgentSession.prompt(session, "go")
            )
          ).pipe(Effect.provide(Layer.merge(model, bounds.layer)))
          return result.turns
        })
      const byTurns = yield* run(
        Presets.policy({ maxTurns: 2 }),
        Array.from({ length: 5 }, () => ({ toolCalls: [call] }))
      )
      assert.strictEqual(byTurns, 2)
      // 30 tokens a turn against 50: turn one is under, turn two reaches it.
      const byTokens = yield* run(
        Presets.policy({ tokens: 50 }),
        Array.from({ length: 5 }, () => ({ toolCalls: [call], usage: { input: 30, output: 0 } }))
      )
      assert.strictEqual(byTokens, 2)
    })
  )
})
