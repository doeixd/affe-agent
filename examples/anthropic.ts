import { Config, Effect, Fiber, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"

/**
 * The v0.1 definition-of-done program, wired to a real provider.
 *
 * This file is typechecked but not executed by the test suite: running it
 * needs an ANTHROPIC_API_KEY and would make live requests. Its job is to prove
 * the layering claim — that an `Agent` carries no model, and provider choice is
 * ordinary Layer wiring that the agent definition never mentions.
 */
const Researcher = Agent.make({
  instructions: "Research carefully and cite evidence.",
  loop: AgentLoop.and(AgentLoop.untilIdle(), AgentLoop.maxTurns(20))
})

const program = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* AgentSession.make(Researcher)

    yield* Effect.forkScoped(
      Stream.runForEach(AgentSession.events(session), (envelope) =>
        Effect.log(`${envelope.sequence} ${envelope.event._tag}`)
      )
    )

    const fiber = yield* Effect.forkChild(
      AgentSession.prompt(session, "Research Effect AI.")
    )

    yield* AgentSession.steer(session, "Focus on runtime semantics.")
    yield* AgentSession.followUp(session, "Then summarize the API.")

    return yield* Fiber.join(fiber)
  })
)

/** The model is chosen here, and nowhere in the agent definition. */
const AnthropicLayer = AnthropicLanguageModel.layer({
  model: "claude-sonnet-4-5"
}).pipe(
  Layer.provide(
    // Read from the environment; the key never appears in the agent or session.
    AnthropicClient.layerConfig({
      apiKey: Config.redacted("ANTHROPIC_API_KEY")
    })
  ),
  Layer.provide(FetchHttpClient.layer)
)

export const main = program.pipe(Effect.provide(AnthropicLayer))
