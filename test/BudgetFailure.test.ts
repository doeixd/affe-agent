import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { Model, Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as RunLedger from "../src/RunLedger.js"
import * as ToolExecution from "../src/ToolExecution.js"
import * as Budget from "../src/budget/Budget.js"
import * as ModelCapabilities from "../src/model/ModelCapabilities.js"
import { TestLanguageModel } from "../src/testing/index.js"

const Work = Tool.make("work", { parameters: Schema.Struct({}), success: Schema.String, failure: Schema.String })
const priced = Layer.merge(
  Model.make("test", "priced", Layer.empty),
  ModelCapabilities.fromTable({
    test: { priced: { contextWindow: 4_000_000, maxOutputTokens: 2_000_000, cost: { input: 1, output: 2 } } }
  })
)
const turn = { toolCalls: [{ id: "w1", name: "work", params: {} }], usage: { input: 1_000_000, output: 1_000_000 } }

describe("usage survives an uncommitted turn", () => {
  for (const stream of [false, true]) {
    it.effect(`the model call remains interruptible and charges no absent response (stream=${stream})`, () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const { layer: model } = yield* TestLanguageModel.script([{ started, hang: true }])
        yield* Effect.scoped(Effect.gen(function* () {
          const budget = yield* Budget.Budget
          const session = yield* AgentSession.make(Agent.make({}))
          const running = yield* Effect.forkChild(session.prompt("go", { stream }))
          yield* Deferred.await(started)
          yield* Fiber.interrupt(running)
          assert.strictEqual(yield* budget.spent, 0)
          assert.strictEqual(yield* budget.costSpent, 0)
        })).pipe(Effect.provide(Layer.mergeAll(model, priced, Budget.fresh())))
      }))

    it.effect(`a tool failure retains token and money spend (stream=${stream})`, () =>
      Effect.gen(function* () {
        const { layer: model } = yield* TestLanguageModel.script([turn])
        const agent = Agent.make({
          tools: [Agent.tool(Work, () => Effect.fail("work failed"))],
          toolFailurePolicy: ToolExecution.FailRun
        })
        yield* Effect.scoped(Effect.gen(function* () {
          const budget = yield* Budget.Budget
          const ledger = yield* RunLedger.RunLedger
          const session = yield* AgentSession.make(agent)
          const failure = yield* Effect.flip(session.prompt("go", { stream }))
          assert.strictEqual(failure, "work failed")
          assert.strictEqual(yield* budget.spent, 2_000_000)
          assert.strictEqual(yield* budget.costSpent, 3)
          assert.strictEqual((yield* ledger.totals).turns, 0, "failed turns are not committed ledger entries")
        })).pipe(Effect.provide(Layer.mergeAll(model, priced, Budget.fresh(), RunLedger.fresh())))
      }))

    it.effect(`interrupting a tool retains token and money spend (stream=${stream})`, () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const { layer: model } = yield* TestLanguageModel.script([turn])
        const agent = Agent.make({
          tools: [Agent.tool(Work, () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))]
        })
        yield* Effect.scoped(Effect.gen(function* () {
          const budget = yield* Budget.Budget
          const ledger = yield* RunLedger.RunLedger
          const session = yield* AgentSession.make(agent)
          const running = yield* Effect.forkChild(session.prompt("go", { stream }))
          yield* Deferred.await(started)
          yield* Fiber.interrupt(running)
          assert.strictEqual(yield* budget.spent, 2_000_000)
          assert.strictEqual(yield* budget.costSpent, 3)
          assert.strictEqual((yield* ledger.totals).turns, 0)
        })).pipe(Effect.provide(Layer.mergeAll(model, priced, Budget.fresh(), RunLedger.fresh())))
      }))
  }
})
