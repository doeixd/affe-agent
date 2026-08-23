import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Permission from "../src/Permission.js"
import { Skills } from "../src/skills/index.js"

/**
 * A support agent with skills it loads on demand.
 *
 * Typechecked, not executed. The point is the loading strategy: the agent is
 * told only the one-line description of each skill (via `Skills.advertise`),
 * and pulls a full body into context only when it decides it needs one (via the
 * `load_skill` tool). A hundred skills would cost a hundred descriptions in the
 * prompt, not a hundred documents -- and nothing here touches the engine.
 */

const registry = Skills.layer([
  Skills.skill({
    id: "refunds",
    name: "Issuing refunds",
    description: "How to issue a refund and the policy limits on doing so.",
    body: [
      "1. Verify the order id and that it is within 30 days.",
      "2. Refunds up to $500 may be issued directly.",
      "3. Anything over $500 needs a manager's approval first."
    ].join("\n"),
    resources: {
      policy: "Full refund policy: ...long-form document the model reads only if it needs the detail..."
    }
  }),
  Skills.skill({
    id: "escalation",
    name: "Escalating to a human",
    description: "When and how to hand a conversation to a human agent.",
    body: "Escalate when the customer is angry, the amount is over $1000, or you are unsure."
  })
])

const Support = Agent.make({
  instructions: "You are a support agent. Load a skill before acting on it.",
  tools: [Skills.loadTool],
  contextTransform: Skills.advertise,
  // Catalogue visibility and execution authorization are separate: every skill
  // is advertised, but a policy decides which may actually be loaded. Here the
  // refund skill needs a human's approval to load.
  permission: Permission.rules(
    [{ action: "skill", resource: "refunds", decision: Permission.ask("loading refund procedures") }],
    { otherwise: Permission.allow }
  )
})

const program = Effect.scoped(
  Effect.flatMap(AgentSession.make(Support), (session) =>
    AgentSession.prompt(session, "A customer wants a $200 refund on order 12345."))
)

const model = AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer)
)

export const main = program.pipe(Effect.provide(Layer.merge(registry, model)))
