/**
 * Agent Plugins (agent-plugins.org) support: load a portable plugin directory
 * (plugin.json + skills/ + mcp.json) into an agent, as an adapter over the
 * existing /skills, /mcp, and /sandbox seams. Portable; no core change. See
 * `Plugins`.
 */
export * as Plugins from "./Plugins.js"
