import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import type * as DurableAgent from "../durable/DurableAgent.js"
import * as DurableToolkit from "../durable/DurableToolkit.js"

/**
 * Durable delegation: a subagent that runs as a **child workflow**.
 *
 * `Subagent.tool` runs the child inside the parent's tool call, so the parent
 * waits and a crash mid-child is the parent's problem. This is the durable
 * shape: the call is a delegation (`DurableToolkit.delegate`), so it runs in
 * the parent's workflow body, starts the child's own durable submission, and
 * suspends the parent behind it. A restart reconnects to the same child, and
 * the child's approval parks it rather than the parent's process.
 *
 * The child is a durable workflow the caller built — `DurableAgent.workflow`
 * — and both the parent's and the child's layers are provided to the engine by
 * the application, exactly as `DurableAgentClient` does for one agent:
 *
 * ```ts
 * const childWorkflow = DurableAgent.workflow("Research", Researcher, { store })
 * const research = Subagent.durable("research", childWorkflow, {
 *   description: "Research a question and return a short findings summary."
 * })
 * const Lead = Agent.make({ instructions: "Delegate research.", tools: [research] })
 * ```
 *
 * The child's execution id is derived from the parent's execution id and the
 * tool call id, so it is a pure function of the call: a replay after a
 * suspension addresses the same child, and a tool-call id reused by another
 * session cannot reach it.
 */
export interface DurableOptions {
  /** What the tool is for, written for the parent model. */
  readonly description: string
}

const Params = Schema.Struct({ prompt: Schema.String })

export const durable = (
  name: string,
  child: ReturnType<typeof DurableAgent.workflow>,
  options: DurableOptions
) => {
  // Refused at construction, the way `Subagent.tool` refuses an unanswerable
  // approval: a durable child's value is not carried. The workflow's success is
  // its text, so a typed child would hand its parent a closing remark instead
  // of the value it was asked for -- a silent degradation, and one the child's
  // author cannot see. A loud fault before the agent starts beats that.
  if (child.hasOutput) {
    throw new TypeError(
      `Subagent.durable: "${name}" has a child that declares an AgentOutput, ` +
        `and a durable workflow carries only the child's text, not that value. ` +
        `Declare no output for a durable child, or read the value from the child's session.`
    )
  }
  return Agent.tool(
    DurableToolkit.delegate(
      Tool.make(name, {
        description: options.description,
        parameters: Params,
        success: Schema.String,
        failure: Schema.String
      }),
      (params, toolCallId, parentExecutionId) =>
        Effect.gen(function* () {
          const { prompt } = Schema.decodeUnknownSync(Params)(params)
          const admitted = yield* child.admit("submit", prompt)
          const payload = {
            sessionId: `subagent:${parentExecutionId}:${toolCallId}`,
            prompt: admitted.prompt,
            ...(admitted.input === undefined ? {} : { input: admitted.input })
          }
          return yield* child.definition.execute(payload)
        })
    ),
    // The handler is a placeholder: under durability the seam never calls it,
    // and a delegation running without the durable wrapper is a wiring fault.
    () => Effect.die("a durable delegation handler must never run")
  )
}
