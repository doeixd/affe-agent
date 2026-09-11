import { Effect, Option, Ref, Schema } from "effect"
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

/** JSON with object keys sorted at every depth, so equal descriptions render equal. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === "object" && value !== null
    ? Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])])
    )
    : value

/**
 * A recovered attempt's policy differs from the one its submission was
 * admitted with, and the recorded one cannot be re-created to combine with
 * it (item 105, I17.3; plan Q6) -- it was `Custom`, or had a function
 * matcher. See `effective`.
 */
export class PermissionPolicyChangedError extends Schema.TaggedError<PermissionPolicyChangedError>()(
  "PermissionPolicyChangedError",
  { recorded: Schema.String, current: Schema.String }
) {
  override get message() {
    return (
      "This submission was admitted under a different permission policy that cannot be re-created from its " +
      `description, so it cannot be recovered here: recorded ${this.recorded}, now ${this.current}. ` +
      "Restore the recorded policy to finish it, or let it fail."
    )
  }
}

/**
 * The policy an attempt's undecided calls run under (item 105, I17.3).
 *
 * Decisions already made are journalled and replay as they were. A call not
 * yet decided used to consult the *running* policy -- so a process deployed
 * with a wider one could authorise, retroactively, a call its run was
 * admitted without. Now the policy's description is journalled at the
 * submission's first execution, and on a replay:
 *
 * - **Unchanged**: the running policy, as before.
 * - **Changed, and the recorded one re-creatable from its description**
 *   (`Permission.fromDescription`): both, combined conservatively
 *   (`Permission.all`) -- the stricter of the two for every call. A
 *   revocation since the crash still applies; a grant since does not reach
 *   back.
 * - **Changed, and not re-creatable** (a `Custom` policy, a function
 *   matcher): refused with `PermissionPolicyChangedError`, since "stricter"
 *   cannot be computed and guessing could widen.
 *
 * Compares what policies say they are: a change *inside* a function matcher,
 * or a `Custom` policy's rules under the same name, is not seen -- give a
 * custom policy a name that changes when its rules do.
 */
export const effective = <R>(
  policy: Permission.Policy<R>,
  prefix: string
): Effect.Effect<
  Permission.Policy<R>,
  PermissionPolicyChangedError,
  WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function*() {
    const current = JSON.stringify(canonical(Permission.describe(policy)))
    // Not `permission-<n>-…`: that shape names per-call decisions in the
    // SD3 census.
    const recorded = yield* Activity.make({
      name: `${prefix}permission-policy`,
      success: Schema.String,
      execute: Effect.succeed(current)
    })
    if (recorded === current) return policy
    // A journal is data from another process and version: one that does
    // not re-create is the same "cannot compute stricter" as a Custom
    // policy, not a defect.
    const admitted = Permission.fromRecorded(recorded)
    if (Option.isNone(admitted)) return yield* new PermissionPolicyChangedError({ recorded, current })
    return Permission.all<R>(admitted.value, policy)
  })

/**
 * A policy whose every call goes to what `ref` holds -- so the durable agent
 * can be built before `effective` has decided which policy that is.
 */
export const delegating = <R>(ref: Ref.Ref<Permission.Policy<R>>, description: Permission.Description): Permission.Policy<R> => ({
  description,
  evaluate: (request) => Effect.flatMap(Ref.get(ref), (policy) => policy.evaluate(request)),
  remember: (request) =>
    Effect.flatMap(Ref.get(ref), (policy) => policy.remember === undefined ? Effect.void : policy.remember(request))
})
