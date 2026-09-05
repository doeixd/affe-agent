import { Effect, Layer, Option } from "effect"
import type { Tool } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import type { AgentDefinition } from "../Agent.js"
import * as McpClient from "../mcp/McpClient.js"
import * as McpToolkit from "../mcp/McpToolkit.js"
import * as Sandbox from "../sandbox/Sandbox.js"
import * as Skills from "../skills/Skills.js"
import { decodeManifest } from "./internal/manifest.js"
import type { Manifest } from "./internal/manifest.js"
import { decodeMcp } from "./internal/mcp.js"
import type { McpServer } from "./internal/mcp.js"
import { discoverSkills } from "./internal/skills.js"
import { PluginError } from "./internal/types.js"
import type { Warning } from "./internal/types.js"
import * as Namespace from "../internal/namespace.js"

/**
 * Agent Plugins (agent-plugins.org) support.
 *
 * Load a portable plugin directory — a `plugin.json` manifest, `skills/` (Agent
 * Skills), and an `mcp.json` of MCP servers — into an agent. This is an
 * *adapter* over the existing seams: skills become a `Skills.SkillRegistry`,
 * MCP servers become bound toolkits, and the plugin files are read through the
 * `Sandbox` seam, so the loader is portable (point it at a real directory with
 * `sandbox/local`, or at a `MemorySandbox` in tests). No core change, no new
 * host module.
 *
 * The spec's failure model is honoured: only a fatal `plugin.json` problem fails
 * `load`; a bad skill or server is a `Warning` and the rest of the plugin loads.
 */

export { PluginError } from "./internal/types.js"
export type { Warning } from "./internal/types.js"
export type { Manifest } from "./internal/manifest.js"
export type { McpServer, StdioServer, HttpServer } from "./internal/mcp.js"

/** A parsed, validated plugin. Skills are self-contained; MCP servers are decoded configs. */
export interface LoadedPlugin {
  readonly manifest: Manifest
  readonly skills: ReadonlyArray<Skills.Skill>
  /** Decoded, expanded, validated MCP server configs — connect them with `mcpToolkit`. */
  readonly mcpServers: ReadonlyArray<McpServer>
  /** Non-fatal issues found while loading (ignored unknown fields, skipped skills/servers). */
  readonly warnings: ReadonlyArray<Warning>
}

export interface LoadOptions {
  /** Allow stdio (subprocess) MCP servers. Default `true`. */
  readonly allowStdio?: boolean | undefined
  /** Filesystem path to the plugin root, for `${PLUGIN_ROOT}` expansion in stdio servers. */
  readonly pluginRoot?: string | undefined
  /** Client-managed data directory, for `${PLUGIN_DATA}` expansion in stdio servers. */
  readonly pluginData?: string | undefined
}

/**
 * Load the plugin at the ambient `Sandbox`'s workspace root.
 *
 * Fails only when `plugin.json` is missing or fatally invalid; everything else
 * (a missing `skills/` or `mcp.json`, a bad skill, a bad server) is a `Warning`
 * and the plugin still loads.
 */
export const load = (options?: LoadOptions): Effect.Effect<LoadedPlugin, PluginError, Sandbox.Current> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox.Current

    // plugin.json — fatal if missing or invalid.
    const manifestPath = yield* Effect.orDie(Sandbox.path("plugin.json"))
    const manifestText = yield* Sandbox.readText(sandbox)(manifestPath).pipe(
      Effect.mapError(() => new PluginError({ reason: "plugin.json is missing or unreadable" }))
    )
    const manifestResult = yield* decodeManifest(manifestText)

    // skills/ — component-isolated.
    const skillsResult = yield* discoverSkills(sandbox)

    // mcp.json — optional and component-isolated.
    const mcpPath = yield* Effect.orDie(Sandbox.path("mcp.json"))
    const mcpText = yield* Effect.option(Sandbox.readText(sandbox)(mcpPath))
    const mcpResult = Option.isNone(mcpText)
      ? { servers: [] as ReadonlyArray<McpServer>, warnings: [] as ReadonlyArray<Warning> }
      : yield* decodeMcp(mcpText.value, {
        allowStdio: options?.allowStdio ?? true,
        pluginRoot: options?.pluginRoot,
        pluginData: options?.pluginData
      })

    return {
      manifest: manifestResult.manifest,
      skills: skillsResult.skills,
      mcpServers: mcpResult.servers,
      warnings: [...manifestResult.warnings, ...skillsResult.warnings, ...mcpResult.warnings]
    }
  })

/**
 * The plugin's skills as a `SkillRegistry` layer — provide it at the session.
 * Pair with `Skills.install` (or `Plugins.install`) to add the `load_skill` tool
 * and the advertise transform.
 */
export const skillsLayer = (loaded: LoadedPlugin): Layer.Layer<Skills.SkillRegistry> =>
  Skills.layer(loaded.skills)

const connect = (server: McpServer, clientInfo: McpClient.ClientInfo) =>
  server.transport === "stdio"
    ? McpClient.stdio({
      server: {
        command: server.command,
        args: [...server.args],
        env: server.env,
        ...(server.cwd === undefined ? {} : { cwd: server.cwd })
      },
      clientInfo
    })
    : McpClient.streamableHttp({
      url: new URL(server.url),
      clientInfo,
      // Configured headers reach the origin. They were decoded, validated and
      // then dropped, so a plugin naming an authenticated server loaded
      // cleanly and then failed to connect for a reason nothing reported.
      ...(Object.keys(server.headers).length === 0
        ? {}
        : { headers: { ...server.headers } })
    })

/**
 * Connect the plugin's MCP servers and bind their *discovered* tools into one
 * toolkit — pass it to `Agent.make({ toolkit })` or merge it in.
 *
 * Scoped: the connections are acquired once and closed when the scope ends, so
 * resolve it at session setup and pass the value (not per turn). Per the spec,
 * failure is isolated: a server that cannot be reached is logged and skipped;
 * the toolkit binds whatever connected. Discovered tools are `Tool.dynamic`
 * (params validated by the server). Configured HTTP headers are sent with
 * every request, which is what makes an authenticated server usable.
 */
export const mcpToolkit = (
  loaded: LoadedPlugin,
  options?: { readonly clientInfo?: McpClient.ClientInfo | undefined }
) =>
  Effect.gen(function* () {
    const clientInfo = options?.clientInfo ?? { name: Namespace.tag("plugins"), version: "0.0.1" }
    const connections: Array<McpToolkit.Connection> = []
    for (const server of loaded.mcpServers) {
      const connection = yield* Effect.option(connect(server, clientInfo))
      if (Option.isSome(connection)) connections.push(connection.value)
      else yield* Effect.logWarning(`plugins: could not connect to MCP server "${server.name}"`)
    }
    return yield* McpToolkit.bindDiscovered(connections)
  })

/**
 * Install a whole plugin onto an agent in one step: set its MCP tools as the
 * agent's toolkit and add the skills (`load_skill` tool + the advertise
 * transform, via `Skills.install`). Scoped, because the MCP connections are live.
 * Still provide `Plugins.skillsLayer(loaded)` at the session for the skills to
 * resolve.
 *
 * ```ts
 * const agent = yield* Agent.make({ instructions: "…" }).pipe(Plugins.install(loaded))
 * // …then Effect.provide(Plugins.skillsLayer(loaded)) at the session.
 * ```
 *
 * This *sets* the toolkit to the plugin's tools — intended for an agent whose
 * capabilities come from the plugin. An agent that also has its own tools should
 * compose `mcpToolkit` and `skillsLayer` by hand instead.
 */
export const install = (
  loaded: LoadedPlugin,
  options?: { readonly clientInfo?: McpClient.ClientInfo | undefined }
) =>
<Tools extends Record<string, Tool.Any>, E, R>(agent: AgentDefinition<Tools, E, R>) =>
  Effect.map(mcpToolkit(loaded, options), (toolkit) => agent.pipe(Agent.withToolkit(toolkit), Skills.install))
