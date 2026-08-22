/**
 * An agent behind an OpenAI-compatible endpoint.
 *
 * Any OpenAI SDK pointed at `http://localhost:3000/v1` with `model:
 * "researcher"` talks to this agent. Strict mode is the default; send
 * `x-agent-session-id` to keep one persistent session, `idempotency-key` to
 * make retries safe.
 *
 * Run: `npx tsx examples/openai-compat.ts`, then e.g.
 *   curl localhost:3000/v1/chat/completions -H 'content-type: application/json' \
 *     -d '{"model":"researcher","messages":[{"role":"user","content":"hi"}],"stream":true}'
 */
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { LanguageModel, Tool } from "effect/unstable/ai"
import { HttpRouter } from "effect/unstable/http"
import { createServer } from "node:http"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient } from "../src/client/index.js"
import { OpenAiAgent } from "../src/openai/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

const Search = Tool.make("search", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String
})

const researcher = Agent.make({
  instructions: "You research questions and answer briefly.",
  toolkit: Agent.toolkit([Search], {
    search: ({ query }) => Effect.succeed(`results for ${query}`)
  }),
  loop: AgentLoop.bounded(6)
})

// A scripted model stands in for a real provider; swap in e.g.
// `AnthropicLanguageModel` from `@effect/ai-anthropic` for the real thing.
const Model: Layer.Layer<LanguageModel.LanguageModel> = Layer.unwrap(
  Effect.map(
    TestLanguageModel.script([
      { toolCalls: [{ id: "t1", name: "search", params: { query: "effect" } }] },
      { text: "Effect is a TypeScript library.", chunks: ["Effect is ", "a TypeScript ", "library."] }
    ]),
    ({ layer }) => layer
  )
)

const OpenAiLive = OpenAiAgent.serverLayer({ model: "researcher" }).pipe(
  Layer.provide(AgentClient.layer(researcher)),
  Layer.provide(Model)
)

HttpRouter.serve(OpenAiLive).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })),
  Layer.launch,
  NodeRuntime.runMain
)
