import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { Budget } from "../src/budget/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * A budget is enforced through the loop seam: the run stops once cumulative
 * token usage reaches the ceiling. Deterministic -- each scripted turn declares
 * its own `usage`, so the exact turn the ceiling bites is an assertion.
 */

const Noop = Tool.make("noop", { parameters: Schema.Struct({}), success: Schema.String })
const noop = Agent.tool(Noop, () => Effect.succeed("ok"))
const call = { id: "n", name: "noop", params: {} }

const spent = Effect.flatMap(Budget.Budget, (b) => b.spent)

describe("Budget.within", () => {
  it.effect("stops the run once cumulative token usage reaches the ceiling", () =>
    Effect.gen(function* () {
      // 50 tokens per turn; a 100-token ceiling permits turn 1 (50) and is
      // reached at turn 2 (100), which becomes the last turn.
      const { layer: model } = yield* TestLanguageModel.script([
        { toolCalls: [call], usage: { input: 30, output: 20 } },
        { toolCalls: [call], usage: { input: 30, output: 20 } },
        { toolCalls: [call], usage: { input: 30, output: 20 } }
      ])
      const agent = Agent.make({
        tools: [noop],
        loop: Budget.within(100, AgentLoop.untilIdle())
      })

      const result = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(agent), (session) =>
          AgentSession.prompt(session, "go"))
      ).pipe(Effect.provide(Layer.merge(model, Budget.layer)))

      assert.strictEqual(result.status, "completed")
      assert.strictEqual(result.turns, 2) // stopped at the ceiling, not turn 3
    })
  )

  it.effect("does not stop a run that stays under the ceiling", () =>
    Effect.gen(function* () {
      // Turn 1 calls a tool (untilIdle continues), turn 2 answers (untilIdle
      // stops). Total 100 tokens, well under the 1000 ceiling.
      const { layer: model } = yield* TestLanguageModel.script([
        { toolCalls: [call], usage: { input: 30, output: 20 } },
        { text: "done", usage: { input: 30, output: 20 } }
      ])
      const agent = Agent.make({
        tools: [noop],
        loop: Budget.within(1000, AgentLoop.untilIdle())
      })

      const outcome = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(agent), (session) =>
          Effect.gen(function* () {
            const result = yield* AgentSession.prompt(session, "go")
            return { result, spent: yield* spent }
          }))
      ).pipe(Effect.provide(Layer.merge(model, Budget.layer)))

      assert.strictEqual(outcome.result.status, "completed")
      assert.strictEqual(outcome.result.text, "done")
      assert.strictEqual(outcome.result.turns, 2)
      assert.strictEqual(outcome.spent, 100) // recorded every turn's usage
    })
  )

  it.effect("a budget shared across a session caps its whole conversation", () =>
    Effect.gen(function* () {
      // One budget layer, one session: usage accumulates across the follow-up
      // run too, so the ceiling caps the conversation, not just the first run.
      const { layer: model } = yield* TestLanguageModel.script([
        { text: "one", usage: { input: 40, output: 40 } },
        { text: "two", usage: { input: 40, output: 40 } }
      ])
      const agent = Agent.make({
        loop: Budget.within(1000, AgentLoop.untilIdle())
      })

      const total = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(agent), (session) =>
          Effect.gen(function* () {
            yield* AgentSession.prompt(session, "first")
            yield* AgentSession.prompt(session, "second")
            return yield* spent
          }))
      ).pipe(Effect.provide(Layer.merge(model, Budget.layer)))

      assert.strictEqual(total, 160) // 80 + 80 across two runs of one session
    })
  )
})
