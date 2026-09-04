import { Cause, Clock, Context, Duration, Effect, Layer, Ref, Schedule } from "effect"
import { Prompt } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import { LanguageModel } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import type { AgentDefinition } from "../Agent.js"
import * as AgentInput from "../AgentInput.js"
import type * as AgentSession from "../AgentSession.js"
import type { RemoteInput } from "../client/AgentClient.js"
import * as InputBoundary from "../internal/inputBoundary.js"

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
 *   `queued` persists it to a `JobStore` a `worker` drains, so a job survives
 *   the process that dispatched it (durable when the store is). Workflow and
 *   remote implementations are the same interface over `DurableClock` or an
 *   `AgentClient`.
 * - **`recurring`** -- run an agent on a `Schedule`, resiliently (a failing run
 *   is logged and the schedule continues), for "every morning" / "every 5m".
 *
 * Both are ordinary Effects, so they compose and are tested with `TestClock` --
 * no real time passes.
 */

/** A unit of dispatched work: an input to run the dispatcher's agent with, later. */
export interface Dispatched {
  /**
   * A prompt, or `AgentInput.typed(value)` for an agent that declares an
   * input. The dispatcher does not know the agent; whoever runs the job
   * decodes the value with the agent's schema, and a value that does not
   * fit fails that run like any other failure.
   */
  readonly input: RemoteInput
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
}>()("affe-agent/scheduling/AgentDispatcher") {}

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
export const local = <Tools extends Record<string, Tool.Any>, E, R, Value, Input>(
  agent: AgentDefinition<Tools, E, R, LanguageModel.LanguageModel, Value, Input>
): Layer.Layer<AgentDispatcher, never, LanguageModel.LanguageModel | R> =>
  Layer.effect(
    AgentDispatcher,
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const env = yield* Effect.context<LanguageModel.LanguageModel | R>()
      return {
        dispatch: (job) => {
          const run = InputBoundary.run(agent, "submit", job.input)
          const delayed = job.delay === undefined ? run : Effect.delay(run, job.delay)
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

// ---------------------------------------------------------------------------
// Queue-backed dispatch (durable when the store is)
// ---------------------------------------------------------------------------

/**
 * A dispatched job at rest: the input to run, and the wall-clock time it becomes
 * due. `prompt` is a decoded `Prompt`, which carries its own Schema, so a
 * durable store round-trips a multimodal job exactly as a text one.
 *
 * Deliberately carries no id: the `JobStore` owns identity (a SQL primary key, a
 * Redis field), so two dispatchers sharing one store cannot mint colliding ids,
 * and the worker never needs one — `claimDue` hands back the jobs, not handles.
 */
export interface PersistedJob {
  readonly prompt: Prompt.Prompt
  /** A typed input's encoded value; `prompt` is then empty. */
  readonly input?: unknown
  readonly runAfterMillis: number
}

/**
 * Where dispatched jobs live between `dispatch` and the run — the seam that
 * makes `queued` outlast the process that dispatched. Bring a durable backend
 * (a SQL table, a Redis list); `memoryStore` is the in-process one for tests and
 * single-node use, the same bring-your-own-store shape `/memory` and `/state`
 * use. The store assigns and tracks each job's identity internally; nothing
 * outside it needs one.
 *
 * `claimDue` is claim-and-take: it returns the jobs whose time has come and
 * removes them, so no two workers run the same job. Semantics are at-most-once —
 * a worker that crashes after claiming but before running drops that job, which
 * matches `local`'s fire-and-forget stance (a lost run is not retried). A store
 * that needs at-least-once implements `claimDue` with a visibility timeout and
 * re-queues on non-completion, behind this same interface.
 */
export interface JobStore {
  readonly enqueue: (job: PersistedJob) => Effect.Effect<void>
  readonly claimDue: (nowMillis: number) => Effect.Effect<ReadonlyArray<PersistedJob>>
}

/** An in-memory `JobStore`. Durable only for as long as the process lives. */
export const memoryStore: Effect.Effect<JobStore> = Effect.map(
  Ref.make<ReadonlyArray<PersistedJob>>([]),
  (ref): JobStore => ({
    enqueue: (job) => Ref.update(ref, (all) => [...all, job]),
    claimDue: (now) =>
      Ref.modify(ref, (all) => [
        all.filter((job) => job.runAfterMillis <= now),
        all.filter((job) => job.runAfterMillis > now)
      ])
  })
)

/**
 * A dispatcher that persists jobs to a `JobStore` instead of running them
 * itself. `dispatch` records the job and its due time and returns; a `worker`
 * (below), possibly in another process, is what runs it. This is what makes
 * self-dispatch survive a restart: the job outlives the dispatching process
 * exactly as long as the store does.
 *
 * `dispatch` needs no `LanguageModel` — enqueuing is not running — so the
 * dispatcher layer is requirement-free.
 */
export const queued = (store: JobStore): Layer.Layer<AgentDispatcher> =>
  Layer.succeed(AgentDispatcher, {
    dispatch: (job) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const delayMillis = job.delay === undefined ? 0 : Duration.toMillis(job.delay)
        yield* store.enqueue({
          ...(AgentInput.isTyped(job.input)
            ? { prompt: Prompt.empty, input: job.input.value }
            : { prompt: Prompt.make(job.input) }),
          runAfterMillis: now + delayMillis
        })
      })
  })

/**
 * Drain a `JobStore`: claim every due job and run the agent for it, forever.
 * Fork it beside the rest of the program (one or more workers over the same
 * store). Resilient like `recurring`: a run's genuine failure is logged and the
 * worker keeps going; interruption on shutdown stops it without a spurious log.
 *
 * Each claimed job runs in a fibre forked into the worker's scope -- as `local`
 * forks its dispatched runs -- so a slow or hung run never blocks the worker
 * from claiming the next batch, and every in-flight run is interrupted when the
 * worker stops. (The trade is `local`'s: no backpressure, so pair a durable
 * store with bounded producers, or run the loop with a modest `pollInterval`.)
 *
 * ```ts
 * yield* Effect.forkScoped(Scheduling.worker(Assistant, store))
 * ```
 */
export const worker = <Tools extends Record<string, Tool.Any>, E, R, Value, Input>(
  agent: AgentDefinition<Tools, E, R, LanguageModel.LanguageModel, Value, Input>,
  store: JobStore,
  options?: { readonly pollInterval?: Duration.Input | undefined }
): Effect.Effect<never, never, LanguageModel.LanguageModel | R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const poll = options?.pollInterval ?? Duration.seconds(1)
      while (true) {
        const now = yield* Clock.currentTimeMillis
        const due = yield* store.claimDue(now)
        yield* Effect.forEach(
          due,
          (job) =>
            InputBoundary.runRecorded(agent, job).pipe(
              Effect.catchCause((cause): Effect.Effect<void> =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.logError("scheduling: a queued run failed", cause)),
              Effect.forkIn(scope)
            ),
          { discard: true }
        )
        yield* Effect.sleep(poll)
      }
    })
  )

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
export const recurring = <Tools extends Record<string, Tool.Any>, E, R, Value, Input, SO, SE, SR>(
  agent: AgentDefinition<Tools, E, R, LanguageModel.LanguageModel, Value, Input>,
  /** The agent's declared input, or `Prompt.RawInput` for an agent without one. */
  input: NoInfer<AgentSession.PromptInput<Input>>,
  schedule: Schedule.Schedule<SO, unknown, SE, SR>
): Effect.Effect<SO, SE, LanguageModel.LanguageModel | R | SR> =>
  Agent.run(agent, input).pipe(
    Effect.catchCause((cause): Effect.Effect<void> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logError("scheduling: a scheduled run failed", cause)),
    Effect.repeat(schedule)
  )
