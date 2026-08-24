import { Effect, Layer, Option } from "effect"
import * as Sandbox from "../sandbox/Sandbox.js"
import * as Skills from "../skills/Skills.js"
import { decodeManifest } from "./internal/manifest.js"
import type { Manifest } from "./internal/manifest.js"
import { decodeMcp } from "./internal/mcp.js"
import type { McpServer } from "./internal/mcp.js"
import { discoverSkills } from "./internal/skills.js"
import { PluginError } from "./internal/types.js"
import type { Warning } from "./internal/types.js"

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
