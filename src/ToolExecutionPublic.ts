/**
 * The public `ToolExecution` namespace: strategies, failure policies, the
 * contexts a tool sees, and the decision step.
 *
 * `ToolExecution.ts` also exports `execute`, the engine's own entry point for
 * running one model response's tool calls; `AgentTurn` is its only caller
 * and an application has no use for it. Listed here rather than `export *`
 * so it stays off `@doeixd/effect-agent` (design-assessment rec 2).
 */
export {
  FailRun,
  Parallel,
  ReturnToModel,
  Sequential,
  concurrency,
  decide,
  intrinsicApproval,
  perTool
} from "./ToolExecution.js"
export type {
  AgentContext,
  FailurePolicy,
  PerToolOptions,
  RaisedError,
  SessionContext,
  Strategy,
  TurnContext
} from "./ToolExecution.js"
