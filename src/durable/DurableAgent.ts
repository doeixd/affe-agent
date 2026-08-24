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
import * as DurableElicitation from "./DurableElicitation.js"
import * as DurableModel from "./DurableModel.js"
import * as DurablePermission from "./DurablePermission.js"
import * as DurableToolkit from "./DurableToolkit.js"
import * as Schedules from "../internal/schedules.js"

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
   * Override for the agent's own toolkit.
   *
   * Normally omitted: the toolkit is taken from the agent, and its handlers are
   * wrapped as activities so a tool that already ran is never executed twice.
   * Supply one only to substitute a different resolved toolkit than the agent
   * carries.
   */
  readonly toolkit?: Toolkit.WithHandler<any> | undefined
  /**
   * Stream the model calls of this workflow's submissions.
   *
   * Part of the workflow definition rather than the payload, so replay makes
   * the same choice the original run did.
   *
   * Worth being precise about what this does and does not give you. The
   * journal holds one entry per model call, containing the completed response
   * — never the individual deltas, which would put a delivery concern in the
   * computation journal and make replay depend on a provider's chunking. So
   * `MessageDelta` is emitted, but whole, and it is emitted *inside* the
   * workflow, where a consumer in another process cannot see it. Live
   * streaming to a remote consumer needs a delivery log, which this library
   * does not have. This is useful when something in the same process is
   * watching the session's events.
   */
  readonly stream?: boolean | undefined
}

/**
 * Define the workflow for an agent.
 *
 * The returned value is an ordinary `Workflow`, so its `execute`, `poll`,
 * `resume` and `interrupt` are available directly.
 */
/**
 * A submission that failed, projected onto something a journal can hold.
 *
 * A durable submission's failure has to survive being written to storage and
 * read back in another process, and the agent's own error type cannot: it is
 * `PromptError<Tools, E>`, parameterised by whatever the caller's tools and
 * transforms fail with. There is no schema for an arbitrary `E`.
 *
 * So the workflow's declared error is this lossy-but-encodable projection. It
 * is strictly better than the alternative it replaces — flattening every
 * failure into a defect, which told a caller only that *something* went wrong.
 * The full `Cause` is still available in-process, on `AgentSession.prompt`.
 */
export class DurableAgentFailure extends Schema.TaggedError<DurableAgentFailure>()(
  "DurableAgentFailure",
  {
    /** The originating error's `_tag`, or a generic label. */
    tag: Schema.String,
    detail: Schema.String,
    /** A defect is a bug; a non-defect is an anticipated failure. */
    isDefect: Schema.Boolean
  }
) {
  override get message() {
    return `${this.isDefect ? "Defect" : "Failure"} in durable submission: ${
      this.tag
    }: ${this.detail}`
  }
}

/**
 * A toolkit may be given directly or as an Effect producing one; the harness
 * resolves it per turn, and so must this.
 */
export const resolveToolkit = (
  input: AgentDefinition<any, any, any>["toolkit"]
  // The resolution may fail, and that failure is the agent's own: it joins the
  // submission's error channel like any other.
): Effect.Effect<Toolkit.WithHandler<any>, any, any> =>
  Effect.isEffect(input) ? input : Effect.succeed(input)

/** The wire-safe projection of a submission's cause. */
export const durableFailure = (cause: Cause.Cause<unknown>): DurableAgentFailure => {
  const failure = AgentEvent.failureFromCause(cause)
  return new DurableAgentFailure({
    tag: failure.tag,
    detail: failure.message,
    isDefect: failure.isDefect
  })
}

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
    success: Schema.String,
    // A submission's failure is declared, not flattened into a defect.
    //
    // It cannot be the agent's own error type: that is
    // `PromptError<Tools, E>`, parameterised by whatever the caller's tools and
    // transforms fail with, and there is no schema for an arbitrary `E`. So the
    // journal holds the projection in `DurableAgentFailure` — tag, detail, and
    // whether it was a defect — which is enough for a caller in another process
    // to branch on, and far more than "something died" was.
    error: DurableAgentFailure
  })

  const layer = definition.toLayer((payload) =>
    Effect.gen(function* () {
      // Built inside the workflow body: activities need the workflow context,
      // and `LanguageModel.make` pins its provider's requirements, so the
      // context cannot be threaded in from outside.
      // Resolved from the agent, not defaulted to empty.
      //
      // This silently broke every durable submission whose model called a
      // tool. `DurableModel` builds its parts schema with
      // `Response.Part(toolkit)`, so an empty toolkit yields a union with no
      // `tool-call` variant — and the first response containing a tool call
      // failed to encode, reported as a model failure with no hint that the
      // toolkit was the cause. The old signature required passing the toolkit
      // *twice*, to `Agent.make` and again here, and every existing test
      // happened to do so, which is why it went unnoticed.
      const toolkit = options.toolkit ?? (yield* resolveToolkit(agent.toolkit))
      const durableTools = yield* DurableToolkit.wrap(toolkit)
      const modelLayer = yield* DurableModel.wrap(durableTools)
      const channels = yield* DurableChannels.factory(options.store)
      // Substituted, not defaulted: a paused run under durability suspends the
      // workflow rather than parking a fibre, so a submission waiting on a
      // human survives the process that asked.
      const elicitation = yield* DurableElicitation.factory
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

      // Decisions are journalled like tool calls: see `DurablePermission`.
      const durablePermission = yield* DurablePermission.wrap(agent.permission)
      const durableAgent = {
        ...agent,
        toolkit: durableTools,
        permission: durablePermission
      } as AgentDefinition<Tools, any, any>

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(durableAgent, {
            channels,
            elicitation,
            sessionId: payload.sessionId
          })
          const result = yield* AgentSession.prompt(session, payload.prompt, {
            stream: options.stream === true
          })
          return result.text
        })
      ).pipe(
        Effect.provide(modelLayer),
        // Interruption is deliberately not converted into a failure.
        // Suspension is signalled by interrupting the fiber, so projecting it
        // would turn every parked submission into a permanently failed one.
        //
        // The instance flags are consulted first because they are the precise
        // signal; `hasInterruptsOnly` is the fallback for an interrupt this
        // workflow did not ask for, such as its runner shutting down. A cause
        // holding *both* a failure and an interrupt is projected rather than
        // re-raised: re-raising it would record neither outcome, leaving the
        // execution non-terminal with nothing left to resume it, and any
        // caller polling for a result would simply hang.
        Effect.catchCause((cause) =>
          instance.suspended ||
            instance.interrupted ||
            Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.fail(durableFailure(cause))
        ),
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
      schedule: Schedules.steady(Duration.millis(100))
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
 * The execution id for a session, derived without dispatching anything.
 *
 * A workflow's execution id is a hash of its idempotency key, and this
 * package's key is `${name}:${sessionId}` — the prompt is deliberately not part
 * of it, because PLAN §11 allows a session at most one live submission. So the
 * id is a pure function of the session, and callers that hold only a session id
 * (a cluster entity, an operator, an HTTP route) can address its submission
 * without inventing a prompt to hash.
 *
 * The empty prompt below is never sent anywhere; it exists only because
 * `executionId` takes the full payload.
 */
export const executionIdFor = <W extends ReturnType<typeof workflow>>(
  agent: W,
  sessionId: string
): Effect.Effect<string> =>
  agent.definition.executionId({
    sessionId,
    prompt: Prompt.make([])
  })

/**
 * Retry an operation through shard reassignment.
 *
 * Exposed for adapters that route their own calls through the cluster — the
 * entity layer, chiefly — so they inherit the same tolerance the durable API
 * has rather than reinventing it.
 */
export const throughShardReassignment: <A, E, R>(
  effect: Effect.Effect<A, E, R>
) => Effect.Effect<A, E, R> = throughReassignment

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
 * rule; queue further work with `followUp` instead. A submit against a
 * session whose execution has already *completed* returns that execution's
 * id without reopening admission: a conversation that continues across
 * submissions is what `DurableAgentClient` provides.
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
    // The key is the session, so the engine answers a second submit with the
    // execution it already has -- including a *finished* one. Opening
    // admission for that would accept steering and follow-ups into channels
    // nothing will ever drain, and `result` would hand back the earlier
    // submission's text as if it were this one's. A completed execution is
    // therefore recognised and returned as it is, with nothing opened.
    const existing = yield* throughReassignment(
      agent.definition.poll(executionId)
    )
    if (Option.isSome(existing) && existing.value._tag === "Complete") {
      return executionId
    }
    // Opened here rather than inside the workflow body: `submit` has accepted
    // the submission by the time it returns, so steering must be admissible
    // from that moment. Marking it in the body instead leaves a window where a
    // caller holding an execution id is told the session is idle.
    yield* open(store, sessionId)
    yield* throughReassignment(
      agent.definition.execute({ sessionId, prompt }, { discard: true })
    )
    return executionId
  })

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
  DurableChannels.offerIfAdmitting(store, sessionId, "steering", input).pipe(
    Effect.flatMap((admitted) =>
      admitted
        ? Effect.void
        : Effect.fail(
            new AgentIdleError({
              sessionId: Ids.sessionId(sessionId),
              operation: "steer"
            })
          )
    ),
    throughReassignment
  )

/** Queue a follow-up, extending the submission rather than the current run. */
export const followUp = (
  store: DurableChannels.Store,
  sessionId: string,
  input: Prompt.RawInput
): Effect.Effect<void, AgentIdleError> =>
  DurableChannels.offerIfAdmitting(store, sessionId, "followUps", input).pipe(
    Effect.flatMap((admitted) =>
      admitted
        ? Effect.void
        : Effect.fail(
            new AgentIdleError({
              sessionId: Ids.sessionId(sessionId),
              operation: "followUp"
            })
          )
    ),
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
const openKey = DurableChannels.openKey

/**
 * Mark a session as accepting out-of-band input.
 *
 * Exported so an adapter that dispatches a submission its own way — the cluster
 * entity forks, to avoid deadlocking against its own mailbox — opens admission
 * through the same function the submission path uses. It previously rewrote the
 * key as a string literal, which would have silently broken `steer` and
 * `followUp` the moment the key changed: every call would report an idle
 * session for a submission that was running perfectly well.
 *
 * Ordering matters. Admission must be open *before* the submission is
 * dispatched, or a client that steers immediately after submitting is told the
 * session is idle.
 */
export const open = (
  store: DurableChannels.Store,
  sessionId: string
): Effect.Effect<void> =>
  throughReassignment(store.offer(openKey(sessionId), "open"))

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
  Exit.Exit<string, DurableAgentFailure>,
  "pending",
  WorkflowEngine.WorkflowEngine
> =>
  Effect.retry(
    Effect.flatMap(throughReassignment(agent.definition.poll(executionId)), (polled) =>
      Option.isSome(polled) && polled.value._tag === "Complete"
        ? Effect.succeed(
            (polled.value as Workflow.Complete<string, DurableAgentFailure>)
              .exit
          )
        : Effect.fail("pending" as const)
    ),
    {
      times: 600,
      schedule: Schedule.spaced(options?.interval ?? Duration.millis(10))
    }
  )

export { DurableChannels, DurableModel, DurableToolkit }
