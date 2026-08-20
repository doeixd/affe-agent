import { Cause, Duration, Effect, Exit, Option, Schedule, Schema } from "effect"
import { Toolkit } from "effect/unstable/ai"
import { Prompt } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import { Workflow, WorkflowEngine } from "effect/unstable/workflow"
import * as AgentEvent from "../AgentEvent.js"
import type { AgentDefinition } from "../Agent.js"
import * as AgentSession from "../AgentSession.js"
import { AgentIdleError } from "../Errors.js"
import * as Ids from "../internal/ids.js"
import * as DurableChannels from "./DurableChannels.js"
import * as DurableModel from "./DurableModel.js"
import * as DurableToolkit from "./DurableToolkit.js"

/**
 * A submission, interpreted as a durable workflow.
 *
 * The agent definition is the same value the embedded runtime uses. Nothing
 * here reaches into the harness: the model becomes an activity by replacing a
 * Layer, tools by wrapping handlers, and out-of-band input by supplying an
 * `InputChannel.Factory`. Canonical history is not persisted — it is rebuilt
 * from replayed activity results, which is why this package needs no store.
 */

export interface Options {
  /**
   * Where out-of-band steering and follow-up input is held, and where the
   * submission's admission marker lives.
   */
  readonly store: DurableChannels.Store
  /**
   * Resolved toolkit. Handlers are wrapped as activities, so a tool that
   * already ran is never executed twice.
   */
  readonly toolkit?: Toolkit.WithHandler<any> | undefined
}

/**
 * Define the workflow for an agent.
 *
 * The returned value is an ordinary `Workflow`, so its `execute`, `poll`,
 * `resume` and `interrupt` are available directly.
 */
export const workflow = <Tools extends Record<string, Tool.Any>>(
  name: string,
  agent: AgentDefinition<Tools, any, any>,
  options: Options
) => {
  const definition = Workflow.make(name, {
    // `Prompt` carries its own Schema, so a multimodal submission survives the
    // journal exactly as a text one does.
    payload: { sessionId: Schema.String, prompt: Prompt.Prompt },
    idempotencyKey: (payload) => `${name}:${payload.sessionId}`,
    success: Schema.String
    // NOTE: no `error` schema yet. Declaring one and mapping agent failures
    // into it — the obvious way to stop `orDie` flattening typed failures into
    // defects — currently ends in a `SchemaError` defect when a tool fails,
    // and the encoding that rejects it has not been isolated. Shipping a
    // half-working error channel would be worse than an honest defect, so the
    // failure still crosses as a defect and the gap is recorded in
    // WORKFLOW_CLUSTER_PLAN.
  })

  const layer = definition.toLayer((payload) =>
    Effect.gen(function* () {
      // Built inside the workflow body: activities need the workflow context,
      // and `LanguageModel.make` pins its provider's requirements, so the
      // context cannot be threaded in from outside.
      const toolkit =
        options.toolkit ?? ((yield* Toolkit.empty) as Toolkit.WithHandler<any>)
      const durableTools = yield* DurableToolkit.wrap(toolkit)
      const modelLayer = yield* DurableModel.wrap(durableTools)
      const channels = yield* DurableChannels.factory(options.store)
      const store = options.store

      // Suspension is signalled by interrupting the running fiber and setting
      // a flag on the instance. A session absorbs interruption by design — a
      // run that is cut short still ends tidily — so by the time control gets
      // back here, a suspended workflow looks exactly like a submission that
      // simply produced no text. Reading the flag is the only way to tell the
      // two apart, and returning normally in the suspended case is what makes
      // a lost runner commit an empty success instead of leaving the execution
      // resumable.
      const instance = yield* WorkflowEngine.WorkflowInstance

      const durableAgent = {
        ...agent,
        toolkit: durableTools
      } as AgentDefinition<Tools, any, any>

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(durableAgent, {
            channels,
            sessionId: payload.sessionId
          })
          const result = yield* AgentSession.prompt(session, payload.prompt)
          return result.text
        })
      ).pipe(
        Effect.provide(modelLayer),
        Effect.orDie,
        Effect.flatMap((text) =>
          instance.suspended
            ? Workflow.suspend(instance)
            : Effect.succeed(text)
        ),
        // The marker says "this session is still accepting input", which a
        // suspended submission very much is — it is waiting to be resumed.
        // Clearing it on suspension would make `steer` and `followUp` reject
        // work for a run that is about to continue.
        Effect.onExit(() =>
          instance.suspended
            ? Effect.void
            : Effect.asVoid(store.takeAll(openKey(payload.sessionId)))
        )
      )
    })
  )

  return { definition, layer } as const
}

/**
 * Cluster conditions that mean "ask again", not "this failed".
 *
 * When a runner dies, its shards stay leased until `shardLockExpiration`
 * elapses, and are then reassigned. Every call routed through a shard —
 * dispatching a submission, offering steering, polling a result — can land in
 * that window and be rejected because no runner currently owns the shard.
 *
 * These arrive as *defects*, not typed errors, so nothing downstream can
 * recover from them by accident: a caller polling for a result would die on a
 * reassignment that is about to resolve on its own. Treating them as transient
 * here is what makes a submission survive the loss of the process running it.
 */
const TRANSIENT = new Set([
  "~effect/cluster/ClusterError/EntityNotAssignedToRunner",
  "~effect/cluster/ClusterError/RunnerNotRegistered",
  "~effect/cluster/ClusterError/RunnerUnavailable"
])

const isTransient = (defect: unknown): boolean =>
  typeof defect === "object" &&
  defect !== null &&
  "name" in defect &&
  typeof (defect as { name: unknown }).name === "string" &&
  TRANSIENT.has((defect as { name: string }).name)

/**
 * Retry through shard reassignment.
 *
 * The window is bounded by the shard lock expiration — 35s by default — so the
 * schedule must outlast it, or a caller gives up moments before the shard it
 * was waiting for becomes available. A non-transient defect is re-raised
 * untouched: this widens *when* an operation succeeds, never *what* it hides.
 */
const throughReassignment = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.catchDefect(effect, (defect) =>
    isTransient(defect)
      ? Effect.fail(new Reassigning({ defect }))
      : Effect.die(defect)
  ).pipe(
    Effect.retry({
      while: (error: E | Reassigning) => error instanceof Reassigning,
      times: 600,
      schedule: Schedule.spaced(Duration.millis(100))
    }),
    Effect.catchIf(
      (error: E | Reassigning): error is Reassigning =>
        error instanceof Reassigning,
      (error) => Effect.die(error.defect)
    )
  ) as Effect.Effect<A, E, R>

/** Internal: never escapes `throughReassignment`. */
class Reassigning {
  constructor(readonly options: { readonly defect: unknown }) {}
  get defect() {
    return this.options.defect
  }
}

/**
 * Start a submission without waiting for it.
 *
 * `discard` is required rather than incidental: a submission that suspends —
 * awaiting approval, or simply outliving the process — never produces the
 * result a plain `execute` waits for.
 *
 * The idempotency key is the **session**, not the input. Retrying a submit is
 * therefore safe, but a second submit with *different* input for the same
 * session rejoins the live execution rather than starting a new one — the new
 * input is not processed. That upholds PLAN §11's one-submission-per-session
 * rule; queue further work with `followUp` instead.
 */
export const submit = <W extends ReturnType<typeof workflow>>(
  agent: W,
  store: DurableChannels.Store,
  sessionId: string,
  input: Prompt.RawInput
): Effect.Effect<string, never, WorkflowEngine.WorkflowEngine> =>
  Effect.gen(function* () {
    const prompt = Prompt.make(input)
    const executionId = yield* agent.definition.executionId({
      sessionId,
      prompt
    })
    // Opened here rather than inside the workflow body: `submit` has accepted
    // the submission by the time it returns, so steering must be admissible
    // from that moment. Marking it in the body instead leaves a window where a
    // caller holding an execution id is told the session is idle.
    yield* throughReassignment(store.offer(openKey(sessionId), "open"))
    yield* throughReassignment(
      agent.definition.execute({ sessionId, prompt }, { discard: true })
    )
    return executionId
  })

/** Queue steering for a running submission. It is applied at a turn boundary. */
/**
 * Queue steering for a running submission.
 *
 * Admission is enforced the same way core enforces it: input for a submission
 * that has already finished is rejected rather than written to a store nobody
 * will drain. Without this the durable API would be a weaker sibling of the
 * core one — accepting work that silently never runs.
 */
export const steer = (
  store: DurableChannels.Store,
  sessionId: string,
  input: Prompt.RawInput
): Effect.Effect<void, AgentIdleError> =>
  admit(store, sessionId, "steer").pipe(
    Effect.andThen(DurableChannels.offer(store, sessionId, "steering", input)),
    throughReassignment
  )

/** Queue a follow-up, extending the submission rather than the current run. */
/** Queue a follow-up, extending the submission rather than the current run. */
export const followUp = (
  store: DurableChannels.Store,
  sessionId: string,
  input: Prompt.RawInput
): Effect.Effect<void, AgentIdleError> =>
  admit(store, sessionId, "followUp").pipe(
    Effect.andThen(DurableChannels.offer(store, sessionId, "followUps", input)),
    throughReassignment
  )

/**
 * The durable analogue of core's "is this session still running".
 *
 * `Workflow.poll` cannot answer it: a suspended execution and a finished one
 * are not reliably distinguishable from outside, and polling races a submission
 * that has been dispatched but not yet begun.
 *
 * Instead the submission owns a marker in the same store the channels use — the
 * durable counterpart of core's `acceptingFollowUps`. It is written when the
 * submission starts and cleared however it ends, so an out-of-band sender sees
 * the same admission contract a local caller would.
 */
const openKey = (sessionId: string) => `${sessionId}:open`

const admit = (
  store: DurableChannels.Store,
  sessionId: string,
  operation: "steer" | "followUp"
): Effect.Effect<void, AgentIdleError> =>
  Effect.flatMap(store.size(openKey(sessionId)), (open) =>
    open > 0
      ? Effect.void
      : Effect.fail(
          new AgentIdleError({
            sessionId: Ids.sessionId(sessionId),
            operation
          })
        )
  )

/**
 * Await a terminal result.
 *
 * A resumed execution continues in the background, so this polls rather than
 * blocking on a fiber that may not exist in this process.
 *
 * The returned `Exit` is where success and failure live: a failed submission is
 * still a *completed* workflow. Its failure currently crosses as a defect
 * rather than a typed error — see the note on the workflow definition.
 */
export const result = <W extends ReturnType<typeof workflow>>(
  agent: W,
  executionId: string,
  options?: { readonly interval?: Duration.Duration | undefined }
): Effect.Effect<
  Exit.Exit<string, never>,
  "pending",
  WorkflowEngine.WorkflowEngine
> =>
  Effect.retry(
    Effect.flatMap(throughReassignment(agent.definition.poll(executionId)), (polled) =>
      Option.isSome(polled) && polled.value._tag === "Complete"
        ? Effect.succeed(
            (polled.value as Workflow.Complete<string, never>).exit
          )
        : Effect.fail("pending" as const)
    ),
    {
      times: 600,
      schedule: Schedule.spaced(options?.interval ?? Duration.millis(10))
    }
  )

export { DurableChannels, DurableModel, DurableToolkit }
