import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Config, Layer } from "effect"
import { McpProtocol, McpServer } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import * as Agent from "../src/Agent.js"
import { AgentClient } from "../src/client/index.js"
import { AgentMcp } from "../src/mcp/index.js"

/**
 * Expose an agent as an MCP tool, so any MCP client (an IDE, another agent) can
 * call it with `ask_agent`.
 *
 * Typechecked, not executed. `AgentMcp.layer` registers the agent as a tool on
 * an Effect `McpServer`; the agent runs behind an ordinary `AgentClient` backend.
 * Compose it with whichever MCP transport you want -- here stdio, the shape an
 * editor launches. (The reverse direction, consuming an MCP server's tools from
 * an agent, is `@doeixd/effect-agent/mcp`'s `McpClient` / `McpToolkit`.)
 */

const Assistant = Agent.make({ instructions: "You are a helpful assistant." })

const model = AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer)
)

// The MCP server: the agent as a tool, over stdio, backed by the in-process client.
export const main = AgentMcp.layer.pipe(
  Layer.provide(McpServer.layerStdio({
    name: "example-agent",
    version: "1.0.0",
    protocols: [McpProtocol.v2025_11_25]
  })),
  Layer.provide(AgentClient.layer(Assistant)),
  Layer.provide(model),
  Layer.launch
)
