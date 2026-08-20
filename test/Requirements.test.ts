import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as ContextTransform from "../src/ContextTransform.js"
import * as FakeModel from "./FakeModel.js"
import { echoToolkit } from "./helpers.js"

/**
 * PLAN §33: a loop and a context transform preserve their own errors and
 * requirements, so a higher-level feature expresses dependencies through the
 * Effect type system rather than a capability registry the harness owns.
 */
class TurnBudget extends Context.Service<TurnBudget>()("TurnBudget", {
  make: Effect.succeed({ maxTurns: 2 })
}) {}

class Workspace extends Context.Service<Workspace>()("Workspace", {
  make: Effect.succeed({ name: "acme" })
}) {}

class BudgetExceeded extends Schema.TaggedError<BudgetExceeded>()(
  "BudgetExceeded",
  { turnIndex: Schema.Number }
) {}

describe("typed requirements", () => {
  it.effect("a loop may depend on a service and fail with its own error", () =>
    Effect.gen(function* () {
      const budgeted = AgentLoop.make((state) =>
        Effect.gen(function* () {
          const budget = yield* TurnBudget
          if (state.turnIndex > budget.maxTurns) {
            return yield* new BudgetExceeded({ turnIndex: state.turnIndex })
          }
          return state.toolCalls.length > 0
            ? AgentLoop.Continue
            : AgentLoop.Stop
        })
      )

      const toolTurn = {
        toolCalls: [{ id: "t", name: "echo", params: { value: "x" } }]
      }
      const { layer } = yield* FakeModel.layer([
        toolTurn,
        toolTurn,
        toolTurn,
        { text: "unreachable" }
      ])

      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({ toolkit: echoToolkit, loop: budgeted })
          )
          // The loop's own failure reaches the caller as a typed error, so it
          // is catchable by tag rather than arriving as an opaque defect.
          return yield* AgentSession.prompt(session, "go").pipe(
            Effect.catchTag("BudgetExceeded", (error) =>
              Effect.succeed(error.turnIndex)
            )
          )
        }).pipe(
          Effect.provide(
            Layer.mergeAll(layer, Layer.succeed(TurnBudget)({ maxTurns: 2 }))
          )
        )
      )

      assert.strictEqual(outcome, 3)
    })
  )

  it.effect("a context transform may depend on a service", () =>
    Effect.gen(function* () {
      const injectWorkspace = ContextTransform.make((context) =>
        Effect.gen(function* () {
          const workspace = yield* Workspace
          // Derivation may consult the correlation metadata as well.
          assert.strictEqual(context.turnIndex, 1)
          assert.strictEqual(context.sessionId.startsWith("session-"), true)
          return Prompt.concat(
            context.canonicalPrompt,
            Prompt.fromMessages([
              Prompt.systemMessage({ content: `workspace: ${workspace.name}` })
            ])
          )
        })
      )

      const { layer, recorder } = yield* FakeModel.layer([{ text: "ok" }])

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({ contextTransform: injectWorkspace })
          )
          yield* AgentSession.prompt(session, "go")
        }).pipe(
          Effect.provide(
            Layer.mergeAll(layer, Layer.succeed(Workspace)({ name: "acme" }))
          )
        )
      )

      // The service-derived content reached the model but not canonical history.
      const prompts = yield* recorder.prompts
      assert.strictEqual(prompts.length, 1)
      assert.deepStrictEqual(FakeModel.roles(prompts[0]!), ["user", "system"])
    })
  )
})
