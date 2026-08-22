import { Effect, Ref } from "effect"
import { Activity, WorkflowEngine } from "effect/unstable/workflow"
import * as Permission from "../Permission.js"
import { nextOccurrence } from "../internal/toolActivity.js"

/**
 * Makes every permission decision a durable `Activity`.
 *
 * A decision is part of what happened, not a function that can be re-run.
 * Without this, a workflow replayed after process loss would consult the
 * policy again before reaching the journalled tool call: a policy tightened
 * overnight would *deny* a call whose side effect already happened, and the
 * replay would diverge from the history it is supposed to reconstruct. An
 * `Ask` whose `DurableDeferred` was answered yesterday would be asked -- or
 * refused -- again for the same reason.
 *
 * Journalling the decision by the call's identity (the same occurrence
 * scheme as `DurableToolkit`) means a replay sees the decision it made.
 *
 * What is journalled is the *policy's* answer. The tool's own
 * `needsApproval` and its projection are re-evaluated on replay, as pure
 * functions of the call's parameters; a `needsApproval` that consults the
 * world is the tool author's to keep deterministic. The harness then applies
 * the floor again, which is idempotent.
 *
 * `remember` is passed through: a grant is the policy's state, and whether
 * it survives the process is that policy's business.
 */
export const wrap = <R>(
  policy: Permission.Policy<R>,
  options?: { readonly prefix?: string | undefined }
): Effect.Effect<
  Permission.Policy<R>,
  never,
  WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function* () {
    const workflowContext = yield* Effect.context<
      WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
    >()
    const prefix = options?.prefix ?? ""
    const seen = yield* Ref.make(new Map<string, number>())
    return {
      evaluate: (request) =>
        Effect.gen(function* () {
          const index = yield* Ref.modify(
            seen,
            nextOccurrence(request.tool.name, request.toolCallId)
          )
          return yield* Activity.make({
            name: `${prefix}permission-${index}-${request.tool.name}-${request.toolCallId}`,
            success: Permission.Decision,
            // The policy cannot fail, so the activity cannot either; a
            // defect in the policy is a bug and dies as one.
            execute: policy.evaluate(request)
          }).pipe(Effect.provide(workflowContext))
        }),
      ...(policy.remember === undefined ? {} : { remember: policy.remember })
    }
  })
