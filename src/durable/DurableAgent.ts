import { Cause, Config, Deferred, Duration, Effect, Exit, Option, Schedule, Schema } from "effect"
import { Toolkit } from "effect/unstable/ai"
import { Prompt } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import { Workflow, WorkflowEngine } from "effect/unstable/workflow"
import * as AgentEvent from "../AgentEvent.js"
import type { AgentDefinition } from "../Agent.js"
import * as AgentSession from "../AgentSession.js"
import { AgentClosedError, AgentIdleError } from "../Errors.js"
import * as PromptWire from "../PromptWire.js"
import * as Ids from "../internal/ids.js"
import * as DurableChannels from "./DurableChannels.js"
import * as DurableElicitation from "./DurableElicitation.js"
import * as DurableModel from "./DurableModel.js"
import * as DurablePermission from "./DurablePermission.js"
import * as DurablePolling from "./DurablePolling.js"
import * as DurableToolkit from "./DurableToolkit.js"
import * as Schedules from "../internal/schedules.js"
import type { StorageError } from "../Errors.js"

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
  /**
   * How often the submission checks for an externally recorded interrupt.
   * Default: `DurablePolling.defaults.workflowInterrupt`.
   */
  readonly interruptPollInterval?: Duration.Duration | undefined
}

/**
 * The channels-store key holding this session's interrupt intent.
 *
 * Per *session*, not per submission, because this module's idempotency key is
 * the session: a session has at most one execution here, so its id names the
 * submission unambiguously.
 */
const interruptSignalName = (sessionId: string): string =>
  `${sessionId}:interrupt`

/**
 * Interrupt a running submission from outside the workflow.
 *
 * `Workflow.interrupt` is not this. The engine implements it as *mark and
 * resume*: it sets a flag and forks a fresh replay, and the replay -- which
 * knows nothing about why it was restarted -- runs to completion. That is the
 * D4 violation issue #77 records: an interrupted submission finishing
 * successfully, under a guarantee that says it must not.
 *
 * So interruption is a recorded *intent*, exactly as `DurableSubmission`
 * records it: written to the shared channels store, where the running body's
 * poller finds it and routes through `AgentSession.interrupt` -- committed
 * turns stay committed, the run stops at the next boundary -- and where a
 * replay resumed in any process finds it before it can run to completion.
 * Callable with only a session id, because the process that dispatched the
 * submission is typically gone.
 */
export const interrupt = (
  store: DurableChannels.Store,
  sessionId: string
): Effect.Effect<void, StorageError> =>
  throughReassignment(store.offer(interruptSignalName(sessionId), "interrupt"))

/**
 * The terminal failure an interrupted submission carries.
 *
 * It has to be a *failure*: this workflow's success schema is the agent's
 * text, which has no room for an outcome tag, and a session absorbs
 * interruption by design -- `prompt` returns normally with whatever was
 * committed before the cut. Without this conversion that partial text is
 * recorded as a successful completion, which is precisely what D4 forbids.
 * The tag matches the event `AgentSession` emits for the same thing, so a
 * caller branching on it needs no second vocabulary.
 */
const interruptedFailure = (): DurableAgentFailure =>
  new DurableAgentFailure({
    tag: "SubmissionInterrupted",
    detail: "the submission was interrupted",
    isDefect: false
  })

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
    // The dedicated wire codec preserves each file-data runtime variant across
    // the workflow journal rather than relying on incidental JSON behaviour.
    payload: { sessionId: Schema.String, prompt: PromptWire.Prompt },
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
      /**
       * R37 -- a plan and durability cannot both own the model call.
       *
       * `DurableModel` wraps the ambient `LanguageModel` so a completed call
       * is journalled and a replay returns the recorded response instead of
       * calling the provider again. An `ExecutionPlan` step *provides its own*
       * `LanguageModel`, and `AgentTurn` applies the plan directly around the
       * model call -- so the plan's layer shadows the wrapper, the provider is
       * reached outside the journal, and a replay repeats a call that has
       * already been made and billed. That is the one side effect
       * `DurableModel` exists to prevent.
       *
       * Refused rather than run. There is no way to wrap the steps of a plan
       * built elsewhere, so the alternatives are a silent loss of the
       * durability guarantee or a loud refusal, and only one of those is
       * something an operator can act on. A durable agent that needs provider
       * fallback wants it *inside* the layer it hands to `DurableAgent`, where
       * the journal is still outermost.
       */
      if (Option.isSome(agent.executionPlan)) {
        return yield* Effect.die(
          new Error(
            "A durable agent cannot carry an ExecutionPlan: the plan's steps" +
              " provide their own LanguageModel, which shadows DurableModel," +
              " so completed provider calls would be repeated on replay." +
              " Put the fallback inside the model layer instead."
          )
        )
      }

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

      // The interrupt intent this submission watches for. See `interrupt`
      // above for why the engine's own `Workflow.interrupt` cannot be it.
      const interruptKey = interruptSignalName(payload.sessionId)
      const requested = yield* Deferred.make<void>()
      // Peeked, never consumed. The intent is deliberately never cleared:
      // this module's execution id is a pure function of the session, so a
      // terminal execution is never re-run and a lingering intent can reach
      // nothing. Taking it, by contrast, would make the interruption
      // non-durable -- a crash between taking the signal and recording the
      // interrupted outcome replays into a body that finds no intent,
      // re-issues the model call and completes, with the user's interrupt
      // silently lost. Signalling the deferred twice is harmless.
      //
      // The read dies rather than failing: losing an interrupt intent to a
      // store failure must not be quiet, and this runs in a forked poller
      // whose typed failure nobody would ever see.
      const checkInterrupt = Effect.flatMap(
        Effect.orDie(store.size(interruptKey)),
        (pending) =>
          pending > 0 ? Deferred.succeed(requested, void 0) : Effect.void
      ).pipe(Effect.asVoid)

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

          // Checked once here, before anything runs, and not left to the
          // poller. A replay resumed in another process -- or by the engine
          // waking a durable await -- must learn that it was interrupted
          // while it was parked *before* it can run to completion, and the
          // poller's first tick is a poll interval away. A replay whose gate
          // no longer parks it wins that race easily; that is exactly how
          // the D4 violation reproduced. Empty text here is not the
          // submission's answer: the terminal branch below replaces it.
          yield* checkInterrupt
          if (yield* Deferred.isDone(requested)) return ""

          const scope = yield* Effect.scope
          // Interruption is delivered through a *local* deferred, not
          // `Workflow.interrupt` (terminal, and the mechanism this replaces)
          // nor an awaited `DurableDeferred` (the engine suspends on any
          // pending durable await, even in a child fibre, which would park
          // every submission that was merely interruptible).
          yield* Effect.repeat(
            checkInterrupt,
            Schedule.spaced(
              options.interruptPollInterval ??
                DurablePolling.defaults.workflowInterrupt
            )
          ).pipe(Effect.ignore, Effect.forkIn(scope))
          // The handoff to the session's own path: committed turns stay
          // committed, the run stops at the next boundary, and `prompt`
          // returns an interrupted result rather than dying.
          yield* Deferred.await(requested).pipe(
            Effect.flatMap(() =>
              // A signal for work that already stopped is stale, not an error.
              AgentSession.interrupt(session).pipe(
                Effect.catchIf(
                  (error): error is AgentIdleError | AgentClosedError =>
                    error._tag === "AgentIdleError" ||
                    error._tag === "AgentClosedError",
                  () => Effect.void
                )
              )
            ),
            Effect.forkIn(scope)
          )

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
        // `instance.suspended` is the one disjunct that carries this: it is
        // set by `Workflow.suspend` immediately before the self-interrupt, so
        // it is already true when the cause arrives here.
        //
        // The other two are defence, not signal, and the comment that used to
        // stand here overstated them on both counts.
        //
        // `instance.interrupted` cannot be true at this point at all. Both
        // engines assign it in exactly one place each -- `WorkflowEngine`'s
        // `resume` and `ClusterWorkflowEngine`'s `run` -- and both do so
        // inside an `Effect.onExit` handler wrapped *around* the body, so it
        // is set only after this `catchCause` has already run. Instrumenting
        // this expression across the durable suite (67 tests, including the
        // two-runner failover) recorded it false on every one of the seven
        // times the branch was reached. It is left in place because it costs
        // nothing and would become live if the engine ever set the flag from
        // inside the run, but it is not what makes this correct today.
        //
        // `hasInterruptsOnly` is the fallback for an interrupt this workflow
        // did not ask for, such as its runner shutting down. That is real, but
        // unobservable in the suite: removing it and re-running the failover
        // test changes nothing, because an interrupt reaching the body from
        // outside is the same event that tears down whatever would have
        // recorded the difference.
        //
        // A cause holding *both* a failure and an interrupt is re-raised, not
        // projected, whenever either flag reads true -- the disjunction is
        // checked before the cause is. `Workflow.intoResult` then keeps the
        // non-interrupt reasons, so the failure is still recorded.
        Effect.catchCause((cause) =>
          instance.suspended
            ? Effect.failCause(cause)
            : Effect.flatMap(Deferred.isDone(requested), (interrupted) =>
                // A recorded interrupt outranks the cause. Left to
                // `hasInterruptsOnly` the execution would be re-raised as
                // merely resumable, and the engine would resume it -- which
                // is the loop this mechanism exists to break.
                interrupted
                  ? Effect.fail(interruptedFailure())
                  : instance.interrupted || Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.fail(durableFailure(cause))
              )
        ),
        Effect.flatMap((text) =>
          instance.suspended
            ? Workflow.suspend(instance)
            : // A session absorbs interruption by design, so an interrupted
              // run reaches here as a *success* carrying whatever text was
              // committed before the cut. Recording that as a completion is
              // the D4 violation; the intent is consulted before the outcome
              // is believed. The suspension branch is checked first, so a
              // merely parked run is untouched.
              Effect.flatMap(Deferred.isDone(requested), (interrupted) =>
                interrupted
                  ? Effect.fail(interruptedFailure())
                  : Effect.succeed(text)
              )
        ),
        // The marker says "this session is still accepting input", which a
        // suspended submission very much is — it is waiting to be resumed.
        // Clearing it on suspension would make `steer` and `followUp` reject
        // work for a run that is about to continue.
        Effect.onExit(() =>
          instance.suspended
            ? Effect.void
            : Effect.all([
                store.takeAll(openKey(payload.sessionId)),
                store.takeAll(DurableChannels.steeringOpenKey(payload.sessionId))
              ], { discard: true })
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
      // Deliberately fixed with the 600-attempt budget: roughly one minute,
      // which must outlast the cluster's default 35s shard lease. Making only
      // the interval configurable could silently shorten that safety window.
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
): Effect.Effect<string, StorageError, WorkflowEngine.WorkflowEngine> =>
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
): Effect.Effect<void, AgentIdleError | StorageError> =>
  DurableChannels.offerIfAdmitting(
    store,
    sessionId,
    "steering",
    input,
    DurableChannels.steeringOpenKey(sessionId)
  ).pipe(
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
): Effect.Effect<void, AgentIdleError | StorageError> =>
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
): Effect.Effect<void, StorageError> =>
  throughReassignment(
    Effect.all([
      store.offer(openKey(sessionId), "open"),
      store.offer(DurableChannels.steeringOpenKey(sessionId), "open")
    ], { discard: true })
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
      schedule: Schedule.spaced(
        options?.interval ?? DurablePolling.defaults.result
      )
    }
  )

/** As `result`, with its polling interval loaded through Effect Config. */
export const resultConfig = <W extends ReturnType<typeof workflow>>(
  agent: W,
  executionId: string,
  options?: { readonly interval?: Config.Config<Duration.Duration> | undefined }
): Effect.Effect<
  Exit.Exit<string, DurableAgentFailure>,
  "pending" | Config.ConfigError,
  WorkflowEngine.WorkflowEngine
> =>
  Effect.flatMap(
    options?.interval ?? DurablePolling.result,
    (interval) => result(agent, executionId, { interval })
  )

export { DurableChannels, DurableModel, DurableToolkit }
