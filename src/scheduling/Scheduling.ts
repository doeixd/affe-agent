import { Cause, Context, Duration, Effect, Layer, Schedule } from "effect"
import type { Prompt } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import { LanguageModel } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import type { AgentDefinition } from "../Agent.js"

/**
 * Scheduling and self-dispatch (issue #4 §14).
 *
 * There is no scheduler runtime here, on purpose. Effect already schedules:
 * `Effect.repeat`/`Effect.schedule` over a `Schedule` (including `Schedule.cron`)
 * for recurrence, `Effect.sleep`/`Effect.delay` for one-off delays, and under
 * durability the workflow's `DurableClock`/`ClusterCron` (which
 * `cluster/ScheduledAgent` already wraps for durable, cluster-wide cron). This
 * package is two thin things over those:
 *
 * - **`AgentDispatcher`** -- the "enqueue future work" seam. An agent's tool
 *   dispatches a follow-up run without touching timers or infrastructure; a
 *   layer decides where it goes. `local` runs it in-process after a delay;
 *   Workflow, queue and remote implementations are the same interface over
 *   `DurableClock`, a durable queue, or an `AgentClient`.
 * - **`recurring`** -- run an agent on a `Schedule`, resiliently (a failing run
 *   is logged and the schedule continues), for "every morning" / "every 5m".
 *
 * Both are ordinary Effects, so they compose and are tested with `TestClock` --
 * no real time passes.
 */

/** A unit of dispatched work: an input to run the dispatcher's agent with, later. */
export interface Dispatched {
  readonly input: Prompt.RawInput
  /** How long to wait before running. Omit to run as soon as possible. */
  readonly delay?: Duration.Input | undefined
}

/**
 * The destination for future agent work. A tool depends on this and calls
 * `dispatch`; the application's layer decides where the work runs. `dispatch`
 * returns once the work is enqueued, not when it completes.
 */
export class AgentDispatcher extends Context.Service<AgentDispatcher, {
  readonly dispatch: (job: Dispatched) => Effect.Effect<void>
}>()("@doeixd/effect-agent/scheduling/AgentDispatcher") {}

/**
 * An in-process dispatcher: each job runs the agent, after its delay, in a
 * fibre forked into the layer's scope -- so it outlives the `dispatch` call and
 * is interrupted when the layer closes. A dispatched run's genuine failure is
 * logged, never propagated to the dispatcher; interruption on layer close is
 * not a failure and is not logged. The job runs in the layer's context: the
 * agent's `LanguageModel | R` is captured at layer build (making `dispatch`
 * itself requirement-free), and time comes from that same context's `Clock`.
 *
 * For durability, provide a Workflow/queue implementation of `AgentDispatcher`
 * instead; the tool that calls `dispatch` does not change.
 */
export const local = <Tools extends Record<string, Tool.Any>, E, R>(
  agent: AgentDefinition<Tools, E, R>
): Layer.Layer<AgentDispatcher, never, LanguageModel.LanguageModel | R> =>
  Layer.effect(
    AgentDispatcher,
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const env = yield* Effect.context<LanguageModel.LanguageModel | R>()
      return {
        dispatch: (job) => {
          const delayed = job.delay === undefined
            ? Agent.run(agent, job.input)
            : Effect.delay(Agent.run(agent, job.input), job.delay)
          return delayed.pipe(
            Effect.provide(env),
            Effect.catchCause((cause): Effect.Effect<void> =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logError("scheduling: a dispatched run failed", cause)),
            Effect.forkIn(scope),
            Effect.asVoid
          )
        }
      }
    })
  )

/** Enqueue a job through the ambient dispatcher. */
export const dispatch = (job: Dispatched): Effect.Effect<void, never, AgentDispatcher> =>
  Effect.flatMap(AgentDispatcher, (dispatcher) => dispatcher.dispatch(job))

/**
 * Run an agent on a schedule, forever, resiliently: each run's failure is
 * logged and the schedule continues (so one bad run never stops the cadence).
 * Fork it beside the rest of the program.
 *
 * ```ts
 * yield* Effect.forkScoped(Scheduling.recurring(Digest, "summarise today", Schedule.cron("0 9 * * *")))
 * ```
 *
 * `SE` carries the schedule's own error -- `Schedule.cron` fails with a
 * `CronParseError` if its expression is invalid, and that surfaces here rather
 * than being swallowed.
 */
export const recurring = <Tools extends Record<string, Tool.Any>, E, R, SO, SE, SR>(
  agent: AgentDefinition<Tools, E, R>,
  input: Prompt.RawInput,
  schedule: Schedule.Schedule<SO, unknown, SE, SR>
): Effect.Effect<SO, SE, LanguageModel.LanguageModel | R | SR> =>
  Agent.run(agent, input).pipe(
    Effect.catchCause((cause): Effect.Effect<void> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logError("scheduling: a scheduled run failed", cause)),
    Effect.repeat(schedule)
  )
