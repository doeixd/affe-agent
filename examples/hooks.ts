import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import { Hooks } from "../src/hooks/index.js"

/**
 * Lifecycle hooks over a run.
 *
 * Typechecked, not executed. `Hooks.on` forks a typed dispatcher over the
 * session's own event stream -- no new bus, no change to the run. Handlers are
 * optional (register only what you care about) and isolated (a hook that fails
 * is logged, never stopping the others or ending the observer). Hooks *observe*;
 * behaviour is changed through the run's own seams (permissions, transforms).
 */

const Assistant = Agent.make({ instructions: "You are helpful." })

const program = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* AgentSession.make(Assistant)

    yield* Effect.forkScoped(Hooks.on(AgentSession.events(session), {
      ToolCallStarted: (event) => Effect.log(`tool started: ${event.name}`),
      ToolCallSucceeded: (event) => Effect.log(`tool ok: ${event.name}`),
      ToolCallFailed: (event) => Effect.logWarning(`tool failed: ${event.name}`),
      RunCompleted: (_event, envelope) => Effect.log(`run done on ${envelope.sessionId}`)
    }))

    return yield* AgentSession.prompt(session, "Summarise the changelog.")
  })
)

export const main = program.pipe(
  Effect.provide(
    AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
      Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
      Layer.provide(FetchHttpClient.layer)
    )
  )
)
