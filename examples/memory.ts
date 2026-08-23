import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import { Memory } from "../src/memory/index.js"

/**
 * An assistant with long-term memory.
 *
 * Typechecked, not executed. The point is that memory is a service, so the
 * agent is written against `Memory` and never against a particular store: the
 * built-in keyword memory here, a real embeddings backend, or a hosted system
 * all provide the same `Memory` layer, and the agent is untouched when you swap
 * one for another.
 *
 * `Memory.recall` injects what is relevant before each model call; the model
 * saves durable facts through `Memory.rememberTool`. The scope ("user-42") is a
 * trusted id, never taken from model output.
 */

const scope = "user-42"

const Assistant = Agent.make({
  instructions: "You are a helpful assistant. Remember durable facts about the user.",
  tools: [Memory.rememberTool(scope)],
  contextTransform: Memory.recall(scope)
})

const program = Effect.scoped(
  Effect.flatMap(AgentSession.make(Assistant), (session) =>
    AgentSession.prompt(session, "Remember that I prefer trains over planes, then suggest a trip."))
)

const model = AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer)
)

// The built-in, keyword-matching, in-process memory.
const withBuiltIn = program.pipe(Effect.provide(Layer.merge(Memory.layer(), model)))

// Bring your own: the agent above does not change. A custom backend just
// implements the two-method `Memory` contract and is provided as a layer --
// here a sketch that would call out to an embeddings store.
const embeddingsMemory = Layer.effect(
  Memory.Memory,
  Effect.succeed<Memory.MemoryShape>({
    recall: (scope, query) =>
      // ...embed `query`, search the vector store scoped to `scope`, rank...
      Effect.succeed({ entries: [] }).pipe(
        Effect.mapError(() => new Memory.MemoryError({ reason: `recall failed for ${scope}: ${query}` }))
      ),
    remember: (scope, entry) =>
      // ...embed `entry.content` and upsert it under `scope`...
      Effect.void.pipe(
        Effect.mapError(() => new Memory.MemoryError({ reason: `remember of "${entry.content}" failed for ${scope}` }))
      )
  })
)

const withCustom = program.pipe(Effect.provide(Layer.merge(embeddingsMemory, model)))

void withBuiltIn
void withCustom
