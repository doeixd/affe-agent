import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Agent from "../src/Agent.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import { AgentRpc } from "../src/rpc/index.js"

/**
 * Serve an agent over Effect RPC.
 *
 * Typechecked, not executed. Like every transport, it is an adapter over an
 * `AgentSessionHost`: `AgentRpc.serverLayer({ host })` produces the typed RPC
 * handlers and `AgentRpc.clientLayer` a schema-aware client. The RPC *transport*
 * (HTTP, WebSocket, socket, worker) is the application's choice -- serve the
 * handlers with an `RpcServer` layer and give the client an `RpcClient.Protocol`
 * -- so the same agent runs over whichever wire the deployment wants.
 */

const Assistant = Agent.make({ instructions: "You are a helpful assistant." })

const model = AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer)
)

const Host = AgentSessionHost.Tag<string>("example/rpc/host")

const host = AgentSessionHost.layer(Host, {
  principal: {
    resolve: ({ headers, operation }) =>
      headers.authorization === undefined
        ? Effect.fail(new AgentProtocol.AgentUnauthorizedError({ operation }))
        : Effect.succeed(headers.authorization)
  },
  authorization: { authorize: () => Effect.void },
  maxSessions: 100,
  maxRequestsPerSession: 64
}).pipe(Layer.provide(AgentClient.layer(Assistant)), Layer.provide(model))

// The RPC handlers for the agent session API. Serve these with an `RpcServer`
// transport of your choosing.
export const handlers = AgentRpc.serverLayer({ host: Host }).pipe(Layer.provide(host))

// The typed client. Provide an `RpcClient.Protocol` (the matching transport).
export const client = AgentRpc.clientLayer
