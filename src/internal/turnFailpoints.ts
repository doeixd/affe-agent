import * as Failpoint from "./failpoint.js"

/**
 * The boundaries *inside* a turn where a durable pass can be made to stop.
 *
 * The other groups sit at storage and delivery boundaries; none sat between
 * the model call, the tool calls and the commit, which is where a process
 * dying mid-turn actually leaves a journal half-written. Item 104's
 * equivalence oracle crashes at each of these and asks whether the recovered
 * run is indistinguishable from one that never stopped.
 *
 * Its own module rather than a member of `AgentTurn`, because `ToolExecution`
 * hits one of them and `AgentTurn` already imports `ToolExecution`.
 *
 * - `after-model-response`: the model has answered (under `/durable`, the
 *   response is journalled) and no tool has started.
 * - `after-tool-call`: one tool call has settled, each time one does -- so
 *   `occurrence: 1` stops after the first of several.
 * - `before-commit`: every call has settled; nothing of the turn is canonical.
 * - `after-commit`: the turn is canonical; the loop has not decided.
 */
export const turnFailpoints = Failpoint.group("AgentTurn", [
  "after-model-response",
  "after-tool-call",
  "before-commit",
  "after-commit"
])
