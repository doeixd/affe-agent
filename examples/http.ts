import { NodeHttpServer } from "@effect/platform-node"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
import { createServer } from "node:http"
import * as Agent from "../src/Agent.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import { AgentHttp } from "../src/http/index.js"

/**
 * Serve an agent over HTTP.
 *
 * Typechecked, not executed. The shape is the seam every transport shares: an
 * `AgentClient` backend runs the agent, an `AgentSessionHost` adds
 * authentication, authorization and capacity over it, and `AgentHttp.serverLayer`
 * mounts the routes -- the same host a `/rpc`, `/ag-ui` or `/a2a` adapter would
 * be given. Swap `AgentClient.layer` for the durable client and the agent runs
 * across restarts without the routes changing.
 */

const Assistant = Agent.make({ instructions: "You are a helpful assistant." })

const model = AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer)
)

// The shared host tag. Every adapter given this tag serves the same sessions.
const Host = AgentSessionHost.Tag<string>("example/http/host")

// Backend (runs the agent) -> host (auth + capacity) over it.
const host = AgentSessionHost.layer(Host, {
  // Authenticate: the bearer token is the principal; no header is a 401.
  principal: {
    resolve: ({ headers, operation }) =>
      headers.authorization === undefined
        ? Effect.fail(new AgentProtocol.AgentUnauthorizedError({ operation }))
        : Effect.succeed(headers.authorization)
  },
  // Authorize every operation for any authenticated principal.
  authorization: { authorize: () => Effect.void },
  maxSessions: 100,
  maxRequestsPerSession: 64
}).pipe(Layer.provide(AgentClient.layer(Assistant)), Layer.provide(model))

const routes = AgentHttp.serverLayer({ host: Host }).pipe(Layer.provide(host))

const server = HttpRouter.serve(routes).pipe(
  Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 3000 }))
)

export const main = Layer.launch(server)

// A generated, fully-typed client for the same API, for callers in Effect
// (provide an `HttpClient` such as `FetchHttpClient.layer`):
export const clientLayer = AgentHttp.clientLayer({ baseUrl: "http://localhost:3000" })
