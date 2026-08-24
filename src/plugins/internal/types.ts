import { Schema } from "effect"

/**
 * A fatal problem loading a plugin: the manifest itself is invalid, so there is
 * no plugin to load. Component-level problems (a bad skill, a bad server) are
 * *not* fatal — they surface as `Warning`s and the rest of the plugin loads.
 */
export class PluginError extends Schema.TaggedError<PluginError>()(
  "@doeixd/effect-agent/plugins/PluginError",
  { reason: Schema.String }
) {
  override get message() {
    return `Agent Plugins: ${this.reason}`
  }
}

/**
 * A non-fatal issue found while loading: an unknown manifest field that was
 * ignored, a skill that was skipped, a server entry that was dropped. The spec
 * requires clients to *report* these and continue; `LoadedPlugin.warnings`
 * carries them so a caller can log or surface them.
 */
export interface Warning {
  /** Which part of the plugin the issue is about. */
  readonly component: "manifest" | "skill" | "mcp"
  /** What was wrong, and what the loader did about it. */
  readonly detail: string
}

/** Build a `manifest`/`skill`/`mcp` warning. */
export const warn = (component: Warning["component"], detail: string): Warning => ({ component, detail })
