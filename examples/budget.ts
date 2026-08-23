import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { Budget } from "../src/budget/index.js"

/**
 * A token budget enforced through the loop seam.
 *
 * Typechecked, not executed. `Budget.within` wraps the ordinary loop with a
 * ceiling: it records each turn's usage against the `Budget` service and stops
 * the run once the cumulative total is reached -- fail-closed, without a new
 * runtime. Where you provide `Budget.layer` decides the scope: per session (an
 * independent cap per conversation) or once for the whole app (a shared pool).
 */

const Assistant = Agent.make({
  instructions: "Answer concisely.",
  // Run until the model stops calling tools, but never spend past 50k tokens.
  loop: Budget.within(50_000, AgentLoop.untilIdle())
})

const model = AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer)
)

// A fresh budget per session: each conversation gets its own 50k ceiling.
export const main = Effect.scoped(
  Effect.flatMap(AgentSession.make(Assistant), (session) =>
    Effect.gen(function* () {
      const result = yield* AgentSession.prompt(session, "Summarise today's incidents.")
      const spent = yield* Effect.flatMap(Budget.Budget, (budget) => budget.spent)
      yield* Effect.log(`status=${result.status} tokens=${spent}`)
    }))
).pipe(Effect.provide(Layer.merge(model, Budget.layer)))
