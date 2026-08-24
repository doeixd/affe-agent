import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Sandbox from "../src/sandbox/Sandbox.js"
import * as SandboxLocal from "../src/sandbox/local.js"
import { Plugins } from "../src/plugins/index.js"

/**
 * Load an Agent Plugins (agent-plugins.org) package into an agent.
 *
 * Typechecked, not executed. `Plugins.load` reads a plugin directory — a
 * `plugin.json`, `skills/<name>/SKILL.md` skills, and an `mcp.json` of MCP
 * servers — through the `Sandbox` seam (here `sandbox/local`, pointed at a real
 * directory). `Plugins.install` sets the plugin's MCP tools as the agent's
 * toolkit and adds the skills (advertise + `load_skill`); `skillsLayer` provides
 * the registry. The loader is portable and an adapter over `/skills`, `/mcp`,
 * and `/sandbox` — no core change. Only a fatal `plugin.json` fails the load; a
 * bad skill or server is a warning and the rest loads.
 */

const model = AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer)
)

export const main = Effect.gen(function* () {
  const loaded = yield* Plugins.load()
  yield* Effect.forEach(loaded.warnings, (w) => Effect.logWarning(`plugin ${w.component}: ${w.detail}`))

  const agent = yield* Agent.make({
    instructions: "You are extended by a plugin: use its skills and tools."
  }).pipe(Plugins.install(loaded))

  return yield* Effect.gen(function* () {
    const session = yield* AgentSession.make(agent)
    return yield* AgentSession.prompt(session, "Use the plugin to help with a refund.")
  }).pipe(Effect.provide(Plugins.skillsLayer(loaded)))
}).pipe(
  Effect.scoped,
  Effect.provide(
    Layer.merge(
      model,
      // Point the sandbox at the plugin directory on disk. A MemorySandbox would
      // serve an in-memory plugin the same way.
      Sandbox.currentLayer(Sandbox.workspace("plugin")).pipe(
        Layer.provide(SandboxLocal.layer({ workspaceRoot: "./my-plugin" }))
      )
    )
  )
)
