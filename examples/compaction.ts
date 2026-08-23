import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import { Compaction } from "../src/compaction/index.js"

/**
 * Compaction as a pure `ContextTransform`.
 *
 * Typechecked, not executed. Compaction is the proof of the canonical/derived
 * split: it shrinks what the *model* sees without touching what the *session*
 * recorded. `Compaction.make` yields a context transform; a policy decides when
 * to fold older turns into a summary, and `summarise` produces that summary
 * (here with a model call, but it is an ordinary Effect). Canonical history
 * stays complete; only the derived prompt is compacted.
 */

const model = AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer)
)

export const main = Effect.gen(function* () {
  const compaction = yield* Compaction.make({
    // Once the transcript passes 20 messages, summarise all but the last 6.
    policy: Compaction.whenLongerThan(20, { retain: 6 }),
    summarise: ({ messages }) =>
      Effect.succeed(`Summary of ${messages.content.length} earlier messages.`)
  })

  const Assistant = Agent.make({
    instructions: "You are a long-running assistant.",
    contextTransform: compaction
  })

  return yield* Effect.scoped(
    Effect.flatMap(AgentSession.make(Assistant), (session) =>
      Effect.gen(function* () {
        yield* AgentSession.prompt(session, "Let's start planning the migration.")
        // The full transcript is always in canonical history, however long it grows.
        return yield* AgentSession.history(session)
      }))
  )
}).pipe(Effect.provide(model))
