/**
 * Lifecycle hooks: run typed side effects at points in a run, over the session's
 * existing event stream, with optional handlers and isolated failures. A thin
 * convenience over AgentEvent.match; it adds nothing to the engine. See `Hooks`.
 */
export * as Hooks from "./Hooks.js"
