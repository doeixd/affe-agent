import { Effect, Layer, Schema } from "effect"
import { McpProtocol, McpServer, Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient, AgentSessionHost } from "../src/client/index.js"
import { AgentMcp } from "../src/mcp/index.js"

/**
 * A portable MCP frontend over the same application-owned session host used by
 * the HTTP, RPC, AG-UI and A2A adapters. The application chooses stdio here;
 * changing to `McpServer.layerHttp` does not change the agent or host.
 *
 * Typechecked, not executed: provide a `LanguageModel` layer when launching
 * `frontend`.
 */

const Summarize = Tool.make("summarize", {
  description: "Summarize text using the requested maximum number of words.",
  parameters: Schema.Struct({
    text: Schema.String,
    maxWords: Schema.Number
  }),
  success: Schema.Struct({ summary: Schema.String })
})

// The parameters are inferred from `Summarize`; callers and tests need no cast
// or hand-written handler annotation.
const summarize = Agent.tool(Summarize, ({ maxWords, text }) =>
  Effect.succeed({
    summary: text.split(/\s+/).slice(0, maxWords).join(" ")
  }))

const assistant = Agent.make({
  instructions: "Use tools when they make the answer more precise.",
  tools: [summarize],
  loop: AgentLoop.maxTurns(4)
})

const Host = AgentSessionHost.Tag<string>("example/mcp/session-host")

const host = AgentSessionHost.layer(Host, {
  // Stdio is a single-user process transport, so its principal is application
  // wiring rather than an invented bearer token.
  principal: { resolve: () => Effect.succeed("local-user") },
  authorization: AgentSessionHost.allowAll(),
  maxSessions: 32,
  maxRequestsPerSession: 64
}).pipe(Layer.provide(AgentClient.layer(assistant)))

const transport = McpServer.layerStdio({
  name: "effect-harness-example",
  version: "1.0.0",
  protocols: [
    McpProtocol.v2025_11_25,
    McpProtocol.v2025_06_18,
    McpProtocol.v2025_03_26,
    McpProtocol.v2024_11_05
  ]
})

export const frontend = AgentMcp.serverLayer({ host: Host }).pipe(
  Layer.provide(host),
  Layer.provide(transport)
)

// Compile-time only. This was deliberately inverted once while authoring and
// failed, proving it checks inference rather than merely documenting intent.
type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T
type HandlerParameters = Parameters<typeof summarize.handler>[0]

export type _HandlerParametersNotAny = Assert<
  IsAny<HandlerParameters> extends false ? true : false
>
