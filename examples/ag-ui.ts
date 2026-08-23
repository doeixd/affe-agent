import { NodeHttpServer } from "@effect/platform-node"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
import { createServer } from "node:http"
import * as Agent from "../src/Agent.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import { AgentAgUi } from "../src/ag-ui/index.js"

/**
 * Serve an agent to an AG-UI front-end (CopilotKit and friends).
 *
 * Typechecked, not executed. Same seam as every transport -- an
 * `AgentSessionHost` over an `AgentClient` backend -- plus one AG-UI-specific
 * decision: `session.resolve` maps an AG-UI *thread* to an agent session, so a
 * thread's turns land on the same session. The adapter translates the session's
 * lifecycle events into the AG-UI SSE event stream.
 */

const Assistant = Agent.make({ instructions: "You are a helpful assistant." })

const model = AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer)
)

const Host = AgentSessionHost.Tag<string>("example/ag-ui/host")

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

const routes = AgentAgUi.serverLayer({
  host: Host,
  // A thread maps to a session, so a conversation stays on one session.
  session: {
    resolve: ({ input }) => Effect.succeed(AgentProtocol.SessionId.make(`ag-ui:${input.threadId}`))
  }
}).pipe(Layer.provide(host))

const server = HttpRouter.serve(routes).pipe(
  Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 3000 }))
)

export const main = Layer.launch(server)
