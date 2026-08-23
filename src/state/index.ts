/**
 * Persistent, typed agent state: a typed value a tool handler reads and writes,
 * optionally surfaced into the prompt and persisted through a store.
 *
 * A battery over ordinary Effect services and the context-transform seam -- see
 * `AgentState`. It adds no capability to the engine.
 */
export * as AgentState from "./AgentState.js"
