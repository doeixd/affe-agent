/**
 * Subagent ergonomics: a tool that delegates a prompt to a child agent.
 *
 * A thin, fully-typed convenience over the pattern the library already
 * supports directly -- see `Subagent.tool`. It adds no capability to the
 * engine; it removes the boilerplate of wiring a child session by hand.
 */
export * as Subagent from "./Subagent.js"
