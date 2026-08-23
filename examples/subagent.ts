import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import { Subagent } from "../src/subagent/index.js"

/**
 * A lead agent that delegates research to a child running under its own model.
 *
 * Typechecked, not executed (running it needs an ANTHROPIC_API_KEY). Its job
 * is to show that a subagent is not a new concept: `Subagent.tool` returns an
 * ordinary bound tool, and the child's model is chosen by the layer passed to
 * `provide` -- here a cheaper model for the narrow research subtask, while the
 * lead reasons with a stronger one. Neither agent definition mentions a model.
 */

const Researcher = Agent.make({
  instructions: "Research the question and return a short, cited summary."
})

// A cheaper model for the child. The lead never sees this layer; the child
// never sees the lead's. That is what keeps the two conversations apart.
const childModel = AnthropicLanguageModel.layer({ model: "claude-haiku-4-5" }).pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer)
)

const research = Subagent.tool("research", Researcher, {
  description: "Research a question and return a short findings summary.",
  provide: childModel
})

const Lead = Agent.make({
  instructions: "Break the task down, delegate research when useful, then decide.",
  tools: [research]
})

const program = Effect.scoped(
  Effect.flatMap(AgentSession.make(Lead), (session) =>
    AgentSession.prompt(session, "Should we adopt Effect for our next service?")
  )
)

// The lead's model is chosen here; the child's was chosen at `provide` above.
const leadModel = AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer)
)

export const main = program.pipe(Effect.provide(leadModel))
