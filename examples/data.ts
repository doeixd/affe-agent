import { Config, Effect, Layer, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import { AgentData } from "../src/data/index.js"

/**
 * Structured output alongside the reply.
 *
 * Typechecked, not executed. An agent's tool writes typed records to a named
 * channel; a UI reads a typed stream of just that channel. The payload is
 * Schema-typed on both ends, and writing to the channel never touches canonical
 * conversation history -- rendering a card is not the same as saying it.
 */

interface Order {
  readonly id: string
  readonly total: number
}
const Orders = AgentData.channel("orders", Schema.Struct({ id: Schema.String, total: Schema.Number }))

// A tool that both acts and emits a structured record for the UI. It requires
// DataChannels through the ordinary requirement channel.
const PlaceOrder = Tool.make("place_order", {
  parameters: Schema.Struct({ id: Schema.String, total: Schema.Number }),
  success: Schema.String,
  dependencies: [AgentData.DataChannels]
})
const Shop = Agent.make({
  instructions: "Place orders the user asks for.",
  tools: [
    Agent.tool(PlaceOrder, (order) => Orders.write(order).pipe(Effect.as(`placed ${order.id}`)))
  ]
})

const program = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* AgentSession.make(Shop)

    // A UI would render each order as it is placed -- a typed stream, not the transcript.
    yield* Effect.forkScoped(
      Stream.runForEach(Orders.stream, (order: Order) => Effect.log(`order card: ${order.id} ($${order.total})`))
    )

    return yield* AgentSession.prompt(session, "Order two coffees for $8.")
  })
)

export const main = program.pipe(
  Effect.provide(Layer.mergeAll(
    AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
      Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
      Layer.provide(FetchHttpClient.layer)
    ),
    AgentData.layer
  ))
)
