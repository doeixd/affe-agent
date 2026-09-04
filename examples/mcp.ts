import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Config, Effect, Layer } from "effect"
import { McpProtocol, McpServer } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import * as Agent from "../src/Agent.js"
import { AgentClient, AgentSessionHost } from "../src/client/index.js"
import { AgentMcp } from "../src/mcp/index.js"

/**
 * Expose an agent as an MCP tool, so any MCP client (an IDE, another agent) can
 * call it with `ask_agent`.
 *
 * Typechecked, not executed. `AgentMcp.serverLayer` registers the agent's tools
 * on an Effect `McpServer` over an `AgentSessionHost` -- the same host every
 * other adapter shares, so capacity and authorization are decided once. The
 * agent runs behind an ordinary `AgentClient` backend. Compose it with
 * whichever MCP transport you want -- here stdio, the shape an editor launches. (The reverse direction, consuming an MCP server's tools from
 * an agent, is `affe-agent/mcp`'s `McpClient` / `McpToolkit`.)
 */

const Assistant = Agent.make({ instructions: "You are a helpful assistant." })

const model = AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer)
)

// One host: stdio has one caller, so the principal is a constant and every
// operation is allowed; `maxSessions` is what bounds named conversations.
const Host = AgentSessionHost.Tag<string>("example/mcp/host")
const host = AgentSessionHost.layer(Host, {
  principal: { resolve: () => Effect.succeed("editor") },
  authorization: AgentSessionHost.allowAll(),
  maxSessions: 16,
  maxRequestsPerSession: 16
}).pipe(Layer.provide(AgentClient.layer(Assistant)), Layer.provide(model))

// The MCP server: the agent's tools over stdio, behind the host.
export const main = AgentMcp.serverLayer({ host: Host }).pipe(
  Layer.provide(McpServer.layerStdio({
    name: "example-agent",
    version: "1.0.0",
    protocols: [McpProtocol.v2025_11_25]
  })),
  Layer.provide(host),
  Layer.launch
)
