import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import { Observability } from "../src/observability/index.js"

/**
 * Tracing an agent with the standard semantic conventions.
 *
 * Typechecked, not executed. `Observability.trace` observes the public event
 * stream and emits one telemetry record per event under stable `agent.*` /
 * `ai.*` attribute names -- no wrapping of the run, and metadata only unless a
 * redaction policy opts content in. Fork it alongside the prompt; the default
 * sink logs structured records that any Effect tracing exporter captures.
 */

const Assistant = Agent.make({ instructions: "You are helpful." })

const program = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* AgentSession.make(Assistant)

    // Observe the whole run: metadata by default, content scrubbed if enabled.
    yield* Effect.forkScoped(
      Observability.trace(AgentSession.events(session), {
        policy: { ...Observability.withContent, redact: (value) => (typeof value === "string" ? value.slice(0, 200) : value) },
        attributes: { [Observability.attributeNames.durable]: false }
      })
    )

    return yield* AgentSession.prompt(session, "Summarise the release notes.")
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
