import { Cause, Deferred, Duration, Effect, Exit, Option, Ref, Schedule, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import {
  Activity,
  DurableDeferred,
  Workflow,
  WorkflowEngine
} from "effect/unstable/workflow"
import type { AgentDefinition } from "../Agent.js"
import type { AgentEventEnvelope } from "../AgentEvent.js"
import * as AgentEvent from "../AgentEvent.js"
import * as AgentSession from "../AgentSession.js"
import * as Ids from "../internal/ids.js"
import { AgentClosedError, AgentIdleError } from "../Errors.js"
import * as Elicitation from "../Elicitation.js"
import * as DurableAgent from "./DurableAgent.js"
import * as DeliveryLog from "./DeliveryLog.js"
import * as DurableChannels from "./DurableChannels.js"
import * as DurableElicitation from "./DurableElicitation.js"
import * as DurableModel from "./DurableModel.js"
import * as DurablePermission from "./DurablePermission.js"
import * as DurablePolling from "./DurablePolling.js"
import * as DurableToolkit from "./DurableToolkit.js"
import type * as DurableSessionStore from "./DurableSessionStore.js"
import { isStorageError, StorageError } from "../Errors.js"

/**
 * One submission of a durable logical session, as a workflow.
 *
 * `DurableAgent.workflow` keys an execution by session: one live submission
 * per session, one execution identity for all of them. That suits the embedded
 * runtime, but a client-backed session needs three identities kept apart:
 *
 *   session id     — the long-lived conversation;
 *   submission id  — one prompt and its follow-up chain;
 *   execution id   — the durable Workflow execution of that submission.
 *
 * Keying by `${name}:${sessionId}:${submissionId}` means prompt A can finish,
 * the process that started it can die, and prompt B runs in a fresh execution
 * while canonical history — carried in the payload, committed back to the
 * `DurableSessionStore` on the way out — continues across both.
 *
 * It also makes interruption tractable: ending execution B never touches the
 * logical session, which simply accepts another submission later.
 */

/** What the client dispatches. Everything replay must reproduce is here. */
export const Payload = Schema.Struct({
  sessionId: Schema.String,
  submissionId: Schema.String,
  prompt: Prompt.Prompt,
  /**
   * Canonical history up to this submission.
   *
   * The store holds it between submissions; the payload carries it so a
   * replayed execution derives the same prompts from the same starting
   * transcript without reading mutable external state.
   */
  initialHistory: Prompt.Prompt,
  /**
   * Part of the payload rather than a definition-level option, so replay
   * makes the choice the original run did.
   */
  stream: Schema.Boolean
})
export type Payload = typeof Payload.Type

/**
 * How a submission ended, as data on the success channel.
 *
 * An agent failure — a tool, the provider, a transform — is an outcome the
 * caller branches on, not an infrastructure event, so it crosses as a value
 * rather than through the workflow error channel. This follows what
 * `DurableModel` and `DurableToolkit` already learned: when the journal must
 * preserve an outcome, representing it as data survives the Schema boundary,
 * where asking an arbitrary typed error to cross it does not.
 *
 * History deliberately rides beside this in the session store's projection
 * rather than in the outcome: every terminal state commits its history there
 * in one atomic step, so a failed submission preserves exactly what a local
 * one would — completed turns only — and the transcript is never duplicated
 * into two persistence paths that could disagree.
 */
export const Outcome = Schema.Union([
  Schema.TaggedStruct("Succeeded", {
    submissionId: Schema.String,
    status: Schema.Literals(["completed", "interrupted"]),
    runs: Schema.Number,
    turns: Schema.Number,
    text: Schema.String
  }),
  Schema.TaggedStruct("Failed", {
    submissionId: Schema.String,
    failure: DurableAgent.DurableAgentFailure
  }),
  /**
   * The infrastructure under the agent failed -- a store that could not be
   * reached -- not the agent. The session is freed all the same, because a
   * body defect is terminal for the engine (without `SuspendOnFailure`
   * there is no retry), and a claim left behind would wedge the session for
   * good. The client reports this as the retryable transport failure it is.
   */
  Schema.TaggedStruct("Infrastructure", {
    submissionId: Schema.String,
    detail: Schema.String
  })
])
export type Outcome = typeof Outcome.Type

/** The channels-store key holding this submission's interrupt intent. */
const interruptSignalName = (sessionId: string, submissionId: string): string =>
  `${sessionId}:interrupt/${submissionId}`

/**
 * Commit the session projection as an activity.
 *
 * The workflow owes the projection update, not the process awaiting the
 * result — otherwise a workflow completing successfully while its initiating
 * request dies would leave the session running on stale history with no way
 * to recover either. The activity name encodes the submission, so replay
 * re-records the identical transition instead of a divergent one.
 */
const finishProjection = (
  sessionStore: DurableSessionStore.DurableSessionStore,
  store: DurableChannels.Store,
  payload: Payload,
  history: Prompt.Prompt
): Effect.Effect<
  void,
  StorageError,
  WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<
      WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
    >()
    // Admission closes *before* the session goes idle, and the interrupt
    // intent is cleared with it -- both inside the activity, so they happen
    // exactly once. The marker is per session: clearing it after `finish`
    // would race the next submission, and clearing it outside the journal
    // would let a *replay* of this body (crash after the activity, before
    // the workflow result was recorded) wipe the marker submission N+1 had
    // already opened, refusing steering aimed at running work as idle.
    // Nothing can be claimed while this submission still holds the session,
    // so inside the activity the ordering is safe.
    yield* Activity.make({
      name: `session-projection/${payload.sessionId}/${payload.submissionId}/finish`,
      success: Schema.Boolean,
      // A store failure here is declared, not a defect: the whole point of
      // `StorageError` is that the workflow can tell infrastructure from the
      // agent. It crosses the journal because it is a `Schema.TaggedError`.
      error: StorageError,
      /**
       * R173, and why the order stays as it is.
       *
       * These two are grouped in one activity but not one storage
       * transaction -- they can be different stores -- so one can commit and
       * the other be lost to a failure or a dying process. Both orders lose
       * something, and the choice is which:
       *
       * - **Clear then finish** (this order): a lost `finish` leaves admission
       *   closed with the claim still `running`, and nothing reconciles a
       *   completed workflow into a finished claim -- so later prompts see
       *   `Busy` permanently.
       * - **Finish then clear**: a lost clear wipes the admission marker of
       *   the *next* submission, which another client may already have
       *   claimed and opened in that gap -- so a running submission refuses
       *   steering as though it were idle.
       *
       * The second is worse: it corrupts work that is happening now, rather
       * than stranding work that has ended. Reversing this order was tried and
       * reverted for exactly that reason, and the test below
       * (`admission is closed before the session goes idle, never after`)
       * pins it.
       *
       * Closing R173 properly needs one of two things this ordering cannot
       * provide: both writes in one transaction, or reconciliation that
       * inspects a completed workflow and finishes its claim. Until then the
       * wedge is a real, recorded limitation rather than a fixed one.
       */
      execute: Effect.all([
        store.takeAll(DurableChannels.openKey(payload.sessionId)),
        store.takeAll(
          interruptSignalName(payload.sessionId, payload.submissionId)
        )
      ]).pipe(
        Effect.andThen(
          sessionStore.finish(payload.sessionId, payload.submissionId, history)
        )
      )
    }).pipe(Effect.provide(context))
  })

/**
 * Elicitation whose pending requests are projected into the session store.
 *
 * `DurableElicitation`'s own pending list is necessarily empty — a suspended
 * workflow has no memory to enumerate. The projection fills that gap: each
 * request is recorded before the announce and removed once its answer is
 * consumed, so `pending` answers from any process at any time — which is the
 * point of answering durable work from somewhere else.
 */
export const projectedElicitation = (
  sessionStore: DurableSessionStore.DurableSessionStore,
  sessionId: string,
  /**
   * Runs after an answer arrives and before it is handed to the run.
   *
   * This is where a resumed workflow learns what happened while it was
   * parked — specifically, that someone asked for it to be interrupted.
   * Checking here rather than trusting the poller makes the outcome
   * deterministic: the interrupt is delivered before the run can act on the
   * answer, instead of racing the next model call by a poll interval.
   */
  onResume: Effect.Effect<void> = Effect.void
): Effect.Effect<
  Elicitation.Factory,
  never,
  WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<
      WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
    >()
    return {
      make: () =>
        Effect.succeed<Elicitation.Elicitor>({
          elicit: (request, announce) =>
            // Registered, then announced, then awaited — the ordering contract
            // the local elicitor keeps. Announcing first looks equivalent and
            // is not: the only sensible way to answer is to react to the
            // announcement, and answering a request nothing was yet waiting on
            // would strand the answer and hang the run.
            // The two `orDie`s below are deliberate, and are the third
            // triage bucket from `StorageError`: a real failure the caller
            // cannot act on.
            //
            // `Elicitation.Elicitor` is a *core* seam whose methods declare no
            // error, because a local elicitor genuinely cannot fail. Widening
            // it so the durable implementation can report a store failure
            // would push durability's concerns into the kernel, which is the
            // one thing every package here is forbidden to do. And there is no
            // useful answer at this depth anyway: a run whose elicitation
            // projection is unwritable cannot ask its question, so it cannot
            // continue. Failing the fibre is the honest outcome; the
            // difference from before is that it is now a considered choice
            // with a reason, not the default.
            Effect.gen(function* () {
              yield* Effect.orDie(
                sessionStore.addPendingRequest(sessionId, request)
              )
              yield* announce
              const response = yield* DurableDeferred.await(
                DurableElicitation.deferredFor(request.id)
              ).pipe(Effect.provide(context))
              yield* onResume
              // Consumed. Whoever delivered the answer already recorded it in
              // the store; removing the request is what makes the run look
              // unpaused to every other observer.
              yield* Effect.orDie(
                sessionStore.removeRequest(sessionId, request.id)
              )
              return response
            }),
          respond: () => Effect.succeed(false),
          // Same reason as `elicit` above: the seam declares no error.
          pending: Effect.orDie(sessionStore.pendingRequests(sessionId))
        })
    }
  })

/**
 * Interrupt a running submission from outside the workflow.
 *
 * Records the intent in the shared channels store, where the workflow's
 * poller finds it and routes through `AgentSession.interrupt` — so committed
 * turns stay committed, an interrupted result is projected, and the logical
 * session returns to idle. Callable with only ids, because the process that
 * dispatched the submission is typically gone. A crash after recording but
 * before delivery replays into the same interrupt.
 */
export const interrupt = (
  store: DurableChannels.Store,
  sessionId: string,
  submissionId: string
): Effect.Effect<void, StorageError> =>
  store.offer(interruptSignalName(sessionId, submissionId), "interrupt")

/**
 * The durable identity of one event, for the delivery log.
 *
 * A replay re-runs emission logic, so every event can be offered to the log
 * more than once — and, with parallel tools, in a different interleaving than
 * the first time. The in-process `sequence` is therefore not a stable key.
 * What *is* stable is where an event sits in the execution: the submission,
 * the run (ids are session-local ordinals, replayed identically), the turn,
 * the tag, the tool call or request it concerns, and its ordinal among events
 * with all of those in common. Two executions of the same journal agree on
 * every one of these.
 */
const eventKey = (
  submissionId: string,
  counts: Map<string, number>,
  envelope: AgentEventEnvelope
): string => {
  const event = envelope.event
  const discriminator =
    "id" in event && typeof event.id === "string" ? event.id : "-"
  const base = [
    submissionId,
    Option.getOrElse(envelope.runId, () => "-"),
    Option.match(envelope.turn, { onNone: () => "-", onSome: String }),
    event._tag,
    discriminator
  ].join("/")
  const ordinal = counts.get(base) ?? 0
  counts.set(base, ordinal + 1)
  return `${base}/${ordinal}`
}

/**
 * The sink that records a submission's events into the delivery log.
 *
 * Synchronous and sequence-ordered by construction: it runs under the event
 * bus's own permit, so — unlike a `Stream` subscriber, which attaches
 * asynchronously and can miss what was emitted before it landed — nothing is
 * lost, and `prompt` cannot report an outcome whose lifecycle events are
 * still in flight. The in-workflow session allocates its own submission ids,
 * so the envelope's is replaced with the durable one a client can correlate
 * with its `prompt` result.
 *
 * A `Conflict` — the same key, a different payload — is logged, not fatal.
 * It is the expected shape of a replayed `MessageDelta`, whose chunking is a
 * property of the provider connection that the journal does not preserve;
 * for lifecycle events it would be a recorder bug, and the tests pin that it
 * does not occur.
 */
/** The submission-level terminal events. */
const TERMINAL = new Set([
  "SubmissionCompleted",
  "SubmissionFailed",
  "SubmissionInterrupted"
])

interface Recorder {
  readonly sink: (envelope: AgentEventEnvelope) => Effect.Effect<void>
  /**
   * Deliver the terminal event held back by the sink.
   *
   * Called after the session projection has been committed. A terminal
   * event is a promise to the reader that the session is settled: that
   * `history` holds the transcript the event describes and `status` is
   * idle. The session emits it *before* the workflow commits either, so
   * delivering it on emission let a client -- the A2A continuation reads
   * history on seeing `SubmissionCompleted` -- observe the transcript from
   * before the submission. Holding it until after the commit restores the
   * promise.
   */
  readonly flushTerminal: Effect.Effect<void>
}

const recordingSink = (
  delivery: DeliveryLog.DeliveryLog,
  instance: WorkflowEngine.WorkflowInstance["Service"],
  sessionId: string,
  submissionId: string,
  held: Ref.Ref<Option.Option<{ readonly key: string; readonly envelope: AgentEventEnvelope }>>
): Recorder => {
  // Mutated only from within the bus's permit, which serialises the sink.
  const counts = new Map<string, number>()
  /**
   * A failed append dies here, and that is the third triage bucket again.
   *
   * `AgentSession.MakeOptions.eventSink` is a *core* seam declaring
   * `Effect<void>`: an interpreter recording events cannot report a failure
   * through it without durability's concerns reaching the kernel.
   *
   * Dying is also the outcome we want, which is why this is not a workaround.
   * A submission whose events cannot be recorded has a gap in the client's
   * reconnect stream (D5), so it must not be reported as having completed
   * normally -- and `isInfrastructure` turns exactly this into an
   * `Infrastructure` outcome, which the client reports as the retryable
   * transport failure it is.
   *
   * What the typed error bought here is reliability of *that* classification.
   * The defect used to be whatever the driver threw, recognised by matching
   * `"SqlError"` against its `name`; it is now a `StorageError`, which
   * `isInfrastructure` matches by tag whether it arrives as a failure or, as
   * here, as a defect.
   */
  const record = (key: string, projected: AgentEventEnvelope) =>
    Effect.flatMap(Effect.orDie(delivery.append(sessionId, key, projected)), (outcome) =>
      // A conflict on a `MessageDelta` is expected, not a bug: the first run
      // streams the provider's chunks live and a replay re-expresses the
      // journalled text as one chunk, so the payloads differ under the same
      // key. The log keeps the first (the live chunks) either way; only a
      // conflict on some *other* event is a recorder disagreeing with itself
      // about a lifecycle fact, which is worth a warning.
      outcome._tag === "Conflict" && projected.event._tag !== "MessageDelta"
        ? Effect.logWarning(
            `DeliveryLog: conflicting payload for event ${key}; keeping the first`
          )
        : Effect.void
    )
  return {
    sink: (envelope) => {
      // Session-level events belong to the in-workflow session, which is an
      // implementation detail: the logical session a client addresses is
      // not started and closed once per submission.
      if (Option.isNone(envelope.submissionId)) return Effect.void
      // A suspending workflow interrupts its fiber, and the session reports
      // that as `RunInterrupted` / `SubmissionInterrupted`. Those describe
      // the process, not the submission, which is parked and will resume; a
      // client must not be told it ended.
      if (instance.suspended || instance.interrupted) return Effect.void
      const key = eventKey(submissionId, counts, envelope)
      const projected: AgentEventEnvelope = {
        ...envelope,
        submissionId: Option.map(envelope.submissionId, () =>
          Ids.submissionId(submissionId)
        )
      }
      return TERMINAL.has(envelope.event._tag)
        ? Ref.set(held, Option.some({ key, envelope: projected }))
        : record(key, projected)
    },
    /**
     * Record first, then forget. Not the other way round.
     *
     * This was `Ref.getAndSet(held, None)` *before* the append, so an append
     * that failed left the session idle with its terminal event gone -- and
     * gone permanently, because nothing holds it any more and no reader can
     * tell a submission that ended from one whose ending was never recorded.
     * That is the exact shape D5 forbids.
     *
     * Reading without clearing, appending, and clearing only on success means
     * a failure keeps the event for a retry. The cost is that a *successful*
     * append whose clear is then lost could append again -- and the delivery
     * log dedups by key, so a duplicate is a `Duplicate` outcome rather than a
     * second event. Trading a possible duplicate for a possible loss is the
     * right direction for a terminal event.
     */
    flushTerminal: Effect.flatMap(Ref.get(held), (pending) =>
      Option.isSome(pending)
        ? Effect.andThen(
          record(pending.value.key, pending.value.envelope),
          Ref.set(held, Option.none())
        )
        : Effect.void
    )
  }
}

/**
 * Whether a cause is the infrastructure under the agent failing rather than
 * the agent.
 *
 * The distinction matters because an infrastructure failure must not be
 * reported to a client as the submission ending: the same call may succeed on
 * another attempt, while an agent failure is a property of the request and
 * will recur.
 *
 * This used to walk the *defects*, matching `_tag === "SqlError"` and, failing
 * that, asking whether a `name` string merely *contained* `"SqlError"`. It had
 * to: the stores converted every failure into a defect with `Effect.orDie`, so
 * the only evidence left was the shape of whatever object happened to be
 * thrown. That check reconstructed, unreliably, exactly the information the
 * error channel had been made to discard -- a store returning a differently
 * named driver error was silently reported to a caller as its agent failing.
 *
 * Now the stores name it. A `StorageError` in the error channel is the answer,
 * and the defect walk survives only for what genuinely still arrives that way:
 * the elicitation seam, which declares no error and dies on a store failure
 * for the reason recorded at that site.
 */
const isInfrastructure = (cause: Cause.Cause<unknown>): boolean =>
  Option.isSome(Cause.findErrorOption(cause).pipe(Option.filter(isStorageError))) ||
  cause.reasons.some((reason) => {
    if (!Cause.isDieReason(reason)) return false
    const defect: unknown = reason.defect
    if (isStorageError(defect)) return true
    if (typeof defect !== "object" || defect === null) return false
    const tagged = defect as { readonly _tag?: unknown; readonly name?: unknown }
    const tag = typeof tagged._tag === "string" ? tagged._tag : ""
    const name = typeof tagged.name === "string" ? tagged.name : ""
    return (
      tag === "SqlError" ||
      name.includes("SqlError") ||
      tag === "PersistenceError" ||
      name.includes("PersistenceError")
    )
  })

const infrastructureOutcome = (
  submissionId: string,
  cause: Cause.Cause<unknown>
): Outcome => ({
  _tag: "Infrastructure",
  submissionId,
  detail: AgentEvent.failureFromCause(cause).message
})

/** Map a prompt result onto the wire-safe outcome. */
const succeededOutcome = (
  submissionId: string,
  result: AgentSession.Result<any>
): Outcome => ({
  _tag: "Succeeded",
  submissionId,
  status: result.status === "interrupted" ? "interrupted" : "completed",
  runs: result.runs,
  turns: result.turns,
  text: result.text
})

/** Map an agent failure onto the wire-safe outcome. */
const failedOutcome = (
  submissionId: string,
  cause: Cause.Cause<unknown>
): Outcome => ({
  _tag: "Failed",
  submissionId,
  failure: DurableAgent.durableFailure(cause)
})

/**
 * Define the per-submission workflow for an agent.
 *
 * The interpreter wiring is the substitution `DurableAgent.workflow` performs
 * — model and tools become activities, out-of-band input moves to the channels
 * factory — reused rather than copied, so the two paths cannot drift.
 */
export const workflow = <Tools extends Record<string, Tool.Any>>(
  name: string,
  agent: AgentDefinition<Tools, any, any>,
  options: {
    readonly store: DurableChannels.Store
    readonly sessionStore: DurableSessionStore.DurableSessionStore
    /**
     * Where client-facing events are recorded.
     *
     * Optional because the embedded runtime has no remote clients to feed;
     * when present, every envelope the session emits is recorded through its
     * event sink before the emitting step continues, so an outcome is never
     * declared while the events describing it are still in flight.
     */
    readonly delivery?: DeliveryLog.DeliveryLog | undefined
    /**
     * How often the workflow checks for an externally recorded interrupt.
     * Default: `DurablePolling.defaults.workflowInterrupt`.
     */
    readonly interruptPollInterval?: Duration.Duration | undefined
  }
) => {
  const definition = Workflow.make(name, {
    payload: Payload,
    idempotencyKey: (payload) =>
      `${name}:${payload.sessionId}:${payload.submissionId}`,
    success: Outcome,
    error: DurableAgent.DurableAgentFailure
  })

  const layer = definition.toLayer((payload) =>
    Effect.gen(function* () {
      // Built inside the workflow body: activities need the workflow context,
      // and `LanguageModel.make` pins its provider's requirements, so the
      // context cannot be threaded in from outside.
      const toolkit = yield* DurableAgent.resolveToolkit(agent.toolkit)
      const durableTools = yield* DurableToolkit.wrap(toolkit)
      // Submission-scoped activity names: several executions of this
      // definition run against the same engine, and their journals must not
      // share an activity namespace.
      const scopePrefix = `${payload.submissionId}:`
      const modelLayer = yield* DurableModel.wrap(durableTools, {
        prefix: scopePrefix
      })
      const channels = yield* DurableChannels.factory(options.store, {
        prefix: scopePrefix
      })
      const instance = yield* WorkflowEngine.WorkflowInstance

      // The interrupt intent this submission watches for. Declared here,
      // ahead of the session, because the elicitation needs to consult it on
      // resumption and the session needs to be interrupted through it.
      const interruptKey = interruptSignalName(
        payload.sessionId,
        payload.submissionId
      )
      const requested = yield* Deferred.make<void>()
      // Peeked, never consumed here. The intent is cleared only by the
      // terminal projection, which is journalled. Consuming it on sight
      // would make the interruption non-durable: a crash between taking the
      // signal and recording the interrupted outcome replays into a body
      // that finds no intent, re-issues the model call, and completes --
      // the user's interrupt silently lost. Signalling the deferred twice
      // is harmless.
      // The store read dies rather than failing, because this is handed to
      // `projectedElicitation` as the elicitor's `onResume` hook, and
      // `Elicitation.Elicitor` declares no error -- the same core seam that
      // already forced the two `orDie`s inside that function. Losing an
      // interrupt intent to a store failure must not be quiet, and a defect
      // that `isInfrastructure` recognises by tag is the loud version.
      const checkInterrupt = Effect.flatMap(
        Effect.orDie(options.store.size(interruptKey)),
        (pending) =>
          pending > 0 ? Deferred.succeed(requested, void 0) : Effect.void
      ).pipe(Effect.asVoid)
      const elicitation = yield* projectedElicitation(
        options.sessionStore,
        payload.sessionId,
        // On resumption, an intent found here must win over the answer that
        // woke the run: signal the interrupter and then never hand the
        // answer back. The run cannot proceed — not to the tool, not to the
        // next model call — and `AgentSession.interrupt` ends it exactly as
        // it would have mid-flight. Waking the run was only ever a way to
        // deliver the interruption.
        // Either this check or the poller may take the signal first; what
        // matters is that the answer is withheld in both cases.
        Effect.flatMap(checkInterrupt, () =>
          Effect.flatMap(Deferred.isDone(requested), (interrupting) =>
            interrupting ? Effect.never : Effect.void
          )
        )
      )

      // Decisions are journalled like tool calls: see `DurablePermission`.
      const durablePermission = yield* DurablePermission.wrap(agent.permission, {
        prefix: scopePrefix
      })
      const durableAgent = {
        ...agent,
        toolkit: durableTools,
        permission: durablePermission
      } as AgentDefinition<Tools, any, any>

      // History as of the moment the prompt settled, whatever way it settled.
      // Captured inside the scope where the session lives, read outside it by
      // whichever terminal branch runs.
      const historyAtEnd = yield* Ref.make<Prompt.Prompt>(payload.initialHistory)

      const held = yield* Ref.make<
        Option.Option<{ readonly key: string; readonly envelope: AgentEventEnvelope }>
      >(Option.none())
      const recorder =
        options.delivery === undefined
          ? undefined
          : recordingSink(
              options.delivery,
              instance,
              payload.sessionId,
              payload.submissionId,
              held
            )
      const eventSink = recorder?.sink
      // The terminal event goes out only once the projection has committed.
      const flushTerminal = recorder?.flushTerminal ?? Effect.void

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(durableAgent, {
            channels,
            elicitation,
            sessionId: payload.sessionId,
            history: payload.initialHistory,
            // One in-workflow session per durable submission, so its one
            // submission *is* the durable one: events, elicitation ids and
            // activity names all carry the id a client already holds.
            submissionIds: () => payload.submissionId,
            eventSink
          })

          // Interruption arrives as a recorded intent in the channels store,
          // polled here and delivered through a *local* deferred — not
          // `Workflow.interrupt`, which is terminal, nor an awaited
          // `DurableDeferred`, since the engine suspends on any pending
          // durable await, even in a child fibre, parking every submission
          // that was merely interruptible.
          //
          // The poller hands off to `AgentSession.interrupt` — exactly the
          // local path — so committed turns stay committed, prompt returns an
          // interrupted result, the projection commits, and the logical
          // session goes idle and stays usable. The key names the submission,
          // so a stale intent cannot interrupt a later one, and a crash after
          // recording but before delivery replays into the same interrupt.
          const scope = yield* Effect.scope
          // The poller acts only once this execution has committed its
          // input. A resumed execution replays from the top, and an intent
          // recorded while it was parked must not land on the replay before
          // the user message is back in the transcript — the interrupted
          // outcome would then commit an empty history, losing a message
          // the original execution had already accepted.
          const committed = Effect.map(
            session.history,
            (history) =>
              history.content.length > payload.initialHistory.content.length
          )
          yield* Effect.repeat(
            Effect.flatMap(committed, (ready) =>
              ready ? checkInterrupt : Effect.void
            ),
            Schedule.spaced(
              options.interruptPollInterval ??
                DurablePolling.defaults.workflowInterrupt
            )
          ).pipe(Effect.ignore, Effect.forkIn(scope))
          // The interrupt is delivered through the session's own path. When
          // the signal was found on resumption (inside an elicitation), this
          // fibre interrupts the run before the answer can be acted on: the
          // elicitor hands the answer back only after `checkInterrupt`, and
          // `AgentSession.interrupt` cancels the run fibre that is waiting
          // on it.
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

          // `Effect.exit`, so the suspension check below sees the raw outcome:
          // a suspended workflow's prompt returns *normally* — the session
          // absorbed the interrupt — and committing a terminal projection for
          // it would finalise work that is merely parked.
          const exit = yield* Effect.exit(
            AgentSession.prompt(session, payload.prompt, {
              stream: payload.stream
            })
          )
          yield* Ref.set(historyAtEnd, yield* session.history)

          if (Exit.isSuccess(exit)) {
            return exit.value
          }
          return yield* Effect.failCause(exit.cause)
        })
      ).pipe(
        Effect.provide(modelLayer),
        // Success commits its projection and crosses as data — unless the
        // "success" is a suspension. A session absorbs interruption by
        // design, so a parked workflow's prompt returns normally, as an
        // interrupted result; committing that would finalise work that is
        // about to resume, leaving the session idle with no claim behind an
        // execution that is still running. The flag is consulted first.
        Effect.flatMap((result) =>
          instance.suspended
            ? Effect.succeed(succeededOutcome(payload.submissionId, result))
            : Effect.flatMap(Ref.get(historyAtEnd), (history) =>
                finishProjection(options.sessionStore, options.store, payload, history).pipe(
                  Effect.andThen(flushTerminal),
                  Effect.as(succeededOutcome(payload.submissionId, result))
                )
              )
        ),
        // Suspension is signalled by interrupting the fiber and setting flags
        // on the instance; a session absorbs interruption by design, so the
        // flags are the precise signal, and `hasInterruptsOnly` covers an
        // interrupt nobody asked for, such as runner shutdown. Both leave the
        // execution non-terminal — suspending or resumable — with the claim
        // still open. Any other cause is an agent failure: it still owes its
        // projection, then crosses as data rather than as an error.
        Effect.catchCause((cause) =>
          instance.suspended ||
          instance.interrupted ||
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.flatMap(Ref.get(historyAtEnd), (history) =>
                finishProjection(options.sessionStore, options.store, payload, history).pipe(
                  Effect.andThen(flushTerminal),
                  Effect.as(
                    // A store that could not be reached is not the agent
                    // failing: it crosses as infrastructure, so the client
                    // does not report an agent failure the agent never
                    // produced, for a fault the next attempt may not see.
                    isInfrastructure(cause)
                      ? infrastructureOutcome(payload.submissionId, cause)
                      : failedOutcome(payload.submissionId, cause)
                  )
                )
              )
        ),
        // Admission stays open while suspended or resumable — a parked
        // submission is still accepting steering — and was closed by
        // `finishProjection` on every terminal path.
        Effect.flatMap((outcome) =>
          instance.suspended
            ? Workflow.suspend(instance)
            : Effect.succeed(outcome)
        )
      )
    })
  )

  return { definition, layer } as const
}

/** The workflow definition a client dispatches and polls. */
export type Definition = ReturnType<typeof workflow>["definition"]
