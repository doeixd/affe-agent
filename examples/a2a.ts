import { NodeHttpServer } from "@effect/platform-node"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
import { createServer } from "node:http"
import * as Agent from "../src/Agent.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import { AgentA2A } from "../src/a2a/index.js"

/**
 * Serve an agent over A2A (Agent-to-Agent), so other agents can call this one.
 *
 * Typechecked, not executed. The transport publishes an Agent Card at the
 * well-known path and a JSON-RPC endpoint, both over the shared
 * `AgentSessionHost`. Two A2A-specific decisions: `principal.subject` names the
 * caller, and `session.resolve` maps an A2A context to an agent session. The
 * principal here is `{ subject }` rather than a bare string, because A2A callers
 * are identified subjects.
 */

const Assistant = Agent.make({ instructions: "You are a helpful assistant." })

const model = AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer)
)

const Host = AgentSessionHost.Tag<{ readonly subject: string }>("example/a2a/host")

const host = AgentSessionHost.layer(Host, {
  principal: {
    resolve: ({ headers }) => Effect.succeed({ subject: headers.authorization ?? "anonymous" })
  },
  authorization: { authorize: () => Effect.void },
  maxSessions: 100,
  maxRequestsPerSession: 64
}).pipe(Layer.provide(AgentClient.layer(Assistant)), Layer.provide(model))

const routes = AgentA2A.serverLayer({
  host: Host,
  card: {
    name: "Example assistant",
    description: "A text-only assistant reachable over A2A",
    version: "1.0.0",
    skills: [{
      id: "prompt",
      name: "Prompt",
      description: "Send a text prompt and get a reply",
      tags: ["text"],
      examples: ["summarise this incident"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"]
    }]
  },
  principal: { subject: (principal) => principal.subject },
  session: {
    resolve: ({ contextId, principal }) =>
      Effect.succeed(AgentProtocol.SessionId.make(`a2a:${principal.subject}:${contextId}`))
  }
}).pipe(Layer.provide(host))

const server = HttpRouter.serve(routes).pipe(
  Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 3000 }))
)

export const main = Layer.launch(server)
