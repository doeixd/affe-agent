import { Effect, Schema } from "effect"
import { DurableDeferred, WorkflowEngine } from "effect/unstable/workflow"
import type { Workflow } from "effect/unstable/workflow"
import * as Elicitation from "../Elicitation.js"

/**
 * A paused run that survives the process it paused in.
 *
 * The local elicitor is a `Deferred`: a fibre parked in memory, gone when the
 * process is. That is the wrong lifetime for the thing elicitation is *for* —
 * an answer from a human arrives in minutes or days, not milliseconds, and a
 * deployment that restarts in between should not lose the run.
 *
 * `DurableDeferred` has exactly the right lifetime. Awaiting one **suspends the
 * workflow**, so a submission waiting for approval stops consuming anything at
 * all and resumes when answered, in whatever process happens to be running
 * then. The agent is unchanged; only the seam is substituted.
 */

/**
 * The deferred a request waits on.
 *
 * Named from the request id, which is session-local and sequential, so a
 * replayed submission waits on the same deferred it waited on the first time —
 * and an answer given before a restart is still the answer afterwards.
 *
 * That determinism is also how a caller *learns* the id. A suspended workflow
 * emits its `ElicitationRequested` inside the run, where no other process can
 * see it, so there is nothing to observe from outside. The ids are
 * `${submissionId}:elicit-1`, `${submissionId}:elicit-2`, … in the order the
 * run asked (`Ids.elicitationId`) — which is enough to answer the first
 * outstanding request without having watched it being asked, given the
 * submission id the caller already holds. Namespacing by submission is what
 * stops an id held from one submission from answering a question in the next.
 * A deployment that wants richer context should record the events from within
 * the workflow, the same way it would to show streaming output.
 *
 * Exported because the client-facing interpreter must name the *same*
 * deferred this module awaits — an answer completes the deferred by name, and
 * two spellings of that name would strand every answer in flight.
 */
export const deferredFor = (id: string) =>
  DurableDeferred.make(`effect-agent/elicitation/${id}`, {
    success: Elicitation.Response
  })

/**
 * Elicitation backed by the workflow engine.
 *
 * Built inside the workflow body, like the durable channels, because awaiting
 * needs the workflow context and the context cannot be threaded in from
 * outside.
 */
export const factory: Effect.Effect<
  Elicitation.Factory,
  never,
  WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> = Effect.gen(function* () {
  const workflowContext = yield* Effect.context<
    WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
  >()

  return {
    make: () =>
      Effect.succeed<Elicitation.Elicitor>({
        elicit: (request, announce) =>
          // Announced before awaiting, as the local elicitor is. The ordering
          // is easier here — the deferred exists by name whether or not anyone
          // is waiting on it, so an answer cannot arrive "too early" — but
          // announcing after suspending would mean never announcing at all.
          Effect.andThen(
            announce,
            DurableDeferred.await(deferredFor(request.id)).pipe(
              Effect.provide(workflowContext)
            )
          ),
        respond: () =>
          // Answering happens from outside the workflow, through `respond`
          // below, because the token is derived from the execution rather than
          // held in memory. A suspended run has no memory to hold it in.
          Effect.succeed(false),
        // Nothing to enumerate: a suspended workflow is not running, so there
        // is no process holding a list of what it is waiting for. A deployment
        // discovers outstanding requests from the `ElicitationRequested`
        // events it recorded, which is the only source that survives the
        // suspension.
        pending: Effect.succeed([])
      })
  }
})

/**
 * Answer a request a durable submission is waiting on.
 *
 * Callable from anywhere with the workflow engine — an HTTP handler, a cluster
 * entity, an operator script — because the token is *derived* from the workflow
 * and execution rather than stored. That is what makes this usable at all: the
 * process that asked the question is typically gone.
 */
/**
 * Terminal state, durably: the deferred is completed by name against the
 * execution. `WorkflowEngine` keeps the completion pending until the run's
 * replay observes it, and the observation is journaled -- so once the run
 * has seen an answer, a later `respond` for the same id is a no-op for that
 * run. Before it has (the window between an answer landing and the
 * suspended run replaying), a second answer overwrites the pending value
 * and the run sees the last one. That window is the engine's, not this
 * module's, and it does not survive the run observing the answer. The
 * in-memory elicitor's terminal state is the `Deferred` itself, where the
 * first answer wins; `test/Elicitation.test.ts` pins both halves of that.
 */
export const respond = (options: {
  readonly workflow: Workflow.Any
  readonly executionId: string
  readonly response: Elicitation.Response
}): Effect.Effect<void, never, WorkflowEngine.WorkflowEngine> => {
  const deferred = deferredFor(options.response.id)
  return DurableDeferred.succeed(deferred, {
    token: DurableDeferred.tokenFromExecutionId(deferred, {
      workflow: options.workflow,
      executionId: options.executionId
    }),
    value: options.response
  })
}

/** The schema an answer crosses a process boundary as. */
export const Response = Elicitation.Response
export type Response = Schema.Schema.Type<typeof Elicitation.Response>
