import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { Model, Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { Budget } from "../src/budget/index.js"
import * as ModelCapabilities from "../src/model/ModelCapabilities.js"
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

/**
 * A money ceiling is the same loop seam reading a different unit. What makes
 * it worth its own combinator is that tokens are not fungible: a cache write
 * costs more than an uncached token and a cache read costs less, so the same
 * token count can be three different prices.
 */
describe("Budget.cost", () => {
  // $1 per million uncached input, $10 output, $0.10 cache read, $1.25 cache
  // write -- Anthropic's shape, with round numbers so the arithmetic in each
  // assertion is legible rather than reverse-engineered.
  const priced = ModelCapabilities.fromTable({
    test: {
      "priced-model": {
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        cost: { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1.25 }
      },
      "unpriced-model": { contextWindow: 200_000, maxOutputTokens: 64_000 }
    }
  })

  const withModel = (model: string) =>
    Layer.merge(priced, Model.make("test", model, Layer.empty))

  const costSpent = Effect.flatMap(Budget.Budget, (b) => b.costSpent)

  it.effect("prices a cache write above an uncached token, not below", () =>
    Effect.gen(function*() {
      // The under-count the plan named before this code existed: 1M cache
      // writes cost 1.25, not 1.0 (priced as input) and certainly not 0.
      const { layer: model } = yield* TestLanguageModel.script([
        { usage: { input: 0, output: 0, cacheWrite: 1_000_000 } }
      ])

      yield* Effect.scoped(
        Effect.flatMap(
          AgentSession.make(
            Agent.make({ loop: Budget.cost(1_000_000, AgentLoop.untilIdle()) })
          ),
          (session) => AgentSession.prompt(session, "go")
        )
      ).pipe(Effect.provide(Layer.mergeAll(model, Budget.layer, withModel("priced-model"))))

      assert.strictEqual(yield* costSpent, 1.25)
    }).pipe(Effect.provide(Layer.merge(Budget.layer, withModel("priced-model")))))

  it.effect("prices each class of input token at its own rate", () =>
    Effect.gen(function*() {
      // 1M uncached (1.00) + 1M cacheRead (0.10) + 1M output (10.00) = 11.10.
      // Counted as tokens alone this is 3M identical units; it is not.
      const { layer: model } = yield* TestLanguageModel.script([
        { usage: { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 } }
      ])

      yield* Effect.scoped(
        Effect.flatMap(
          AgentSession.make(
            Agent.make({ loop: Budget.cost(1_000_000, AgentLoop.untilIdle()) })
          ),
          (session) => AgentSession.prompt(session, "go")
        )
      ).pipe(Effect.provide(Layer.mergeAll(model, Budget.layer, withModel("priced-model"))))

      assert.strictEqual(yield* costSpent, 11.1)
    }).pipe(Effect.provide(Layer.merge(Budget.layer, withModel("priced-model")))))

  it.effect("stops the run once cumulative cost reaches the ceiling", () =>
    Effect.gen(function*() {
      // 1.00 per turn against a 2.00 ceiling: turn 1 (1.00) continues, turn 2
      // (2.00) reaches it and is the last. Turn 3 is never asked for.
      const { layer: model, recorder } = yield* TestLanguageModel.script([
        { toolCalls: [call], usage: { input: 1_000_000 } },
        { toolCalls: [call], usage: { input: 1_000_000 } },
        { toolCalls: [call], usage: { input: 1_000_000 } }
      ])

      const result = yield* Effect.scoped(
        Effect.flatMap(
          AgentSession.make(
            Agent.make({ tools: [noop], loop: Budget.cost(2, AgentLoop.untilIdle()) })
          ),
          (session) => AgentSession.prompt(session, "go")
        )
      ).pipe(Effect.provide(Layer.mergeAll(model, Budget.layer, withModel("priced-model"))))

      assert.strictEqual(result.status, "completed")
      assert.strictEqual(result.turns, 2)
      assert.strictEqual(yield* recorder.calls, 2)
    }))

  it.effect("an unpriced model fails the run rather than costing nothing", () =>
    Effect.gen(function*() {
      // The alternative -- charging zero for a model with no prices -- turns a
      // money ceiling into no ceiling at the moment it matters, silently.
      const { layer: model } = yield* TestLanguageModel.script([
        { usage: { input: 1_000_000 } }
      ])

      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.flatMap(
            AgentSession.make(
              Agent.make({ loop: Budget.cost(1, AgentLoop.untilIdle()) })
            ),
            (session) => AgentSession.prompt(session, "go")
          )
        ).pipe(Effect.provide(Layer.mergeAll(model, Budget.layer, withModel("unpriced-model"))))
      )

      assert.isTrue(Exit.isFailure(exit))
      if (!Exit.isFailure(exit)) return
      // Named, not merely "some failure": the message is what tells the caller
      // which model to add prices for.
      assert.match(Cause.pretty(exit.cause), /No cost recorded for test\/unpriced-model/)
    }))

  it.effect("reconstructs uncached input when the provider reports only a total", () =>
    Effect.gen(function*() {
      // §12.1's warning, as a test: every field of the usage struct is
      // optional. Given `total` and the two cache figures but no `uncached`,
      // the remainder is 1M at the input rate -- not zero, and not negative if
      // a provider's numbers disagree.
      const usage = {
        inputTokens: { total: 3_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
        outputTokens: { total: 0 }
      }
      const capabilities = {
        contextWindow: 1,
        maxOutputTokens: 1,
        cost: { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1.25 }
      }

      // 1M uncached (1.00) + 1M read (0.10) + 1M write (1.25) = 2.35
      assert.deepStrictEqual(
        ModelCapabilities.priceOf(capabilities, usage),
        Option.some(2.35)
      )

      // And inconsistent numbers never produce a negative charge.
      assert.deepStrictEqual(
        ModelCapabilities.priceOf(capabilities, {
          inputTokens: { total: 0, cacheRead: 1_000_000 },
          outputTokens: { total: 0 }
        }),
        Option.some(0.1)
      )
    }))

  it.effect("an unrecorded cache rate falls back to the input rate, not to free", () =>
    Effect.gen(function*() {
      // A row that prices input and output but says nothing about caching is
      // incomplete, not a declaration that caching is free.
      assert.deepStrictEqual(
        ModelCapabilities.priceOf(
          { contextWindow: 1, maxOutputTokens: 1, cost: { input: 2, output: 10 } },
          {
            inputTokens: { total: 1_000_000, uncached: 0, cacheWrite: 1_000_000 },
            outputTokens: { total: 0 }
          }
        ),
        Option.some(2)
      )
    }))
})
