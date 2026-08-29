import { Cause, Config, Duration, Effect, Exit, Layer, Option, Stream } from "effect"
import type { Context } from "effect"
import { LanguageModel, Prompt } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import { WorkflowEngine } from "effect/unstable/workflow"
import type { AgentDefinition } from "../Agent.js"
import type { AgentEventEnvelope } from "../AgentEvent.js"
import * as AgentClient from "../client/AgentClient.js"
import { AgentBusyError, AgentIdleError } from "../Errors.js"
import * as History from "../internal/history.js"
import * as Ids from "../internal/ids.js"
import * as DurableAgent from "./DurableAgent.js"
import * as DurableChannels from "./DurableChannels.js"
import * as DurableElicitation from "./DurableElicitation.js"
import * as DurablePolling from "./DurablePolling.js"
import * as DeliveryLog from "./DeliveryLog.js"
import * as DurableSubmission from "./DurableSubmission.js"
import * as DurableSessionStore from "./DurableSessionStore.js"
import * as Schedules from "../internal/schedules.js"
import type { StorageError } from "../Errors.js"

/**
 * The durable interpreter of the client contract.
 *
 * `AgentClient.layer` adapts a local session; this adapts a durable one. Same
 * service, same vocabulary — the caller cannot tell which it was given, and
 * every transport built on `AgentClient` (RPC, HTTP, MCP, A2A) therefore works
 * against durable agents without knowing durability exists.
 *
 * What sits underneath:
 *
 *   createSession  — a record in the `DurableSessionStore`, whose lifetime is
 *                    independent of the handle's scope;
 *   prompt         — claim, dispatch one submission workflow, await its
 *                    terminal outcome;
 *   steer/followUp — the shared channels store, admitted by the open marker;
 *   interrupt      — a durable signal consumed inside the workflow;
 *   respond        — the session store's elicitation projection;
 *   events         — the delivery log, not the workflow's process-local bus.
 *
 * A handle is disposable. Closing its scope releases nothing the execution
 * needs: the workflow runs in the engine, and any later process reacquires the
 * logical session with `session(id)`.
 *
 * Reacquiring also **reconciles**. The store persists intent before any
 * process is relied on to carry it forward — a claim before its dispatch, an
 * answer before its delivery — so a process that died in between leaves a
 * record, not a wedged session. `session(id)` and `createSession` finish
 * whatever such a record says was owed: an undispatched claim is dispatched
 * (idempotently, under the same execution id), and a recorded answer is
 * delivered to the workflow.
 */

/** Derive the initial canonical history for a fresh durable session. */
const initialHistory = (
  agent: AgentDefinition<any, any, any>
): Prompt.Prompt =>
  Option.match(agent.instructions, {
    onNone: () => Prompt.empty,
    onSome: History.systemMessage
  })

/**
 * Await a terminal outcome.
 *
 * A resumed execution continues in whatever process owns its shard, so this
 * polls rather than blocking on a fiber that may not exist here. Unbounded by
 * design: a submission parked for a human may take days, and the caller asked
 * for its terminal outcome.
 */
const awaitOutcome = (
  definition: DurableSubmission.Definition,
  executionId: string,
  interval: Duration.Duration
): Effect.Effect<
  Exit.Exit<DurableSubmission.Outcome, DurableAgent.DurableAgentFailure>,
  never,
  WorkflowEngine.WorkflowEngine
> =>
  Effect.flatMap(
    DurableAgent.throughShardReassignment(definition.poll(executionId)),
    (polled) =>
      Option.isSome(polled) && polled.value._tag === "Complete"
        ? Effect.succeed(
            // Sound by construction: this definition declares `success` =
            // Outcome and `error` = DurableAgentFailure, so a Complete poll
            // result can only carry that exit. The generic poll signature
            // cannot restate it.
            polled.value.exit as Exit.Exit<
              DurableSubmission.Outcome,
              DurableAgent.DurableAgentFailure
            >
          )
        : Effect.fail("pending" as const)
  ).pipe(
    Effect.retry({
      while: (reason) => reason === "pending",
      // Capped backoff, not a fixed interval. This poll is unbounded on
      // purpose -- see the note above -- and at a fixed 10ms that is millions
      // of polls a day for a submission waiting on a person. The first retry
      // is still `interval`, so a fast answer stays fast.
      schedule: Schedules.backoff({
        start: interval,
        cap: Schedules.defaultPollCap
      })
    }),
    Effect.orDie
  )

export interface Options {
  /**
   * Where steering and follow-up input waits, and where admission markers
   * live. Shared with every handle onto the same sessions.
   */
  readonly store: DurableChannels.Store
  /** The durable logical-session registry and projection. */
  readonly sessionStore: DurableSessionStore.DurableSessionStore
  /**
   * Where client-facing events are recorded and streamed from.
   *
   * Optional; without one, `events` is an empty stream, because a feed that
   * pretends to work is worse than one that is honestly absent.
   */
  readonly delivery?: DeliveryLog.DeliveryLog | undefined
  /** How often `prompt` polls for its outcome. Default: 10ms. */
  readonly pollInterval?: Duration.Duration | undefined
  /** How often a workflow checks for an interrupt intent. Default: 25ms. */
  readonly interruptPollInterval?: Duration.Duration | undefined
}

/** Options for `layerConfig`; stores stay explicit and intervals come from Config. */
export interface ConfigOptions extends Omit<
  Options,
  "pollInterval" | "interruptPollInterval"
> {
  readonly pollInterval?: Config.Config<Duration.Duration> | undefined
  readonly interruptPollInterval?: Config.Config<Duration.Duration> | undefined
}

/**
 * A session id no other process could have produced.
 *
 * The local client numbers sessions from a process-local counter, which is
 * exactly wrong here: two processes sharing a store would both create
 * `session-1` and silently share one conversation. Durable ids come from the
 * platform's random source instead.
 */
const freshSessionId = Effect.sync(
  () => `session-${globalThis.crypto.randomUUID()}`
)

const noSuchSession = (sessionId: string) =>
  new AgentClient.AgentSessionNotFoundError({ sessionId })

/**
 * Provide the ordinary `AgentClient` service over a durable agent.
 *
 * The agent definition is passed through untouched to
 * `DurableSubmission.workflow` — durability remains an interpreter choice, and
 * nothing about the agent changes to be reachable this way.
 *
 * The layer also registers the submission workflow's handler, which has to be
 * present in the *runtime* environment or dispatching finds no implementation
 * and every submission would poll forever.
 *
 * `LanguageModel` is a declared requirement even though the agent definition's
 * erased requirements would let it pass silently: the workflow body resolves
 * the model from the context this layer was built in, and a deployment that
 * forgot to provide one should learn that from the compiler, not from a
 * defect on the first prompt.
 */
export const layer = <Tools extends Record<string, Tool.Any>>(
  name: string,
  agent: AgentDefinition<Tools, any, any>,
  options: Options
): Layer.Layer<
  AgentClient.AgentClient,
  never,
  WorkflowEngine.WorkflowEngine | LanguageModel.LanguageModel
> => {
  const submission = DurableSubmission.workflow(name, agent, options)
  const pollInterval = options.pollInterval ?? DurablePolling.defaults.clientOutcome

  /**
   * The execution id for a claim, derived without dispatching anything.
   *
   * The idempotency key names only the session and submission, so the id is
   * a pure function of the claim — including when the dispatching process
   * died before recording it.
   */

  /**
   * A store failure, seen from a client, is a transport failure.
   *
   * The stores now name what went wrong (`StorageError`) instead of dying,
   * which is what lets `DurableSubmission` tell infrastructure from agent
   * failure without inspecting defects. A *client* wants one bit less than
   * that: whether retrying could work. `AgentTransportError` is already that
   * bit — its doc says the caller can tell "this session is busy" from "the
   * transport broke" without either being a defect — and a database that
   * failed a read is the same kind of news as a socket that dropped.
   *
   * So `RemoteError` does not grow a variant. The distinction survives where
   * it is acted on and is folded where it is only reported, which is also why
   * the wire protocol is unchanged.
   */
  const storageAsTransport =
    (sessionId: string) =>
    <A, R>(
      effect: Effect.Effect<A, AgentClient.RemoteError | StorageError, R>
    ): Effect.Effect<A, AgentClient.RemoteError, R> =>
      Effect.catchTag(effect, "StorageError", (error) =>
        Effect.fail(
          new AgentClient.AgentTransportError({
            sessionId,
            detail: error.message
          })
        )
      )

  const executionIdFor = (
    sessionId: string,
    claim: DurableSessionStore.Claim
  ): Effect.Effect<string> =>
    claim.executionId !== undefined
      ? Effect.succeed(claim.executionId)
      : submission.definition.executionId({
          sessionId,
          submissionId: claim.submissionId,
          prompt: Prompt.empty,
          initialHistory: Prompt.empty,
          stream: claim.stream
        })

  /**
   * Whether a dispatched submission has stopped running.
   *
   * Asked of the admission marker, not of `Workflow.poll`. That is not a
   * shortcut: `DurableAgent` establishes that poll cannot answer this, because
   * a suspended execution and a finished one are not reliably distinguishable
   * from outside and polling races a submission dispatched but not yet begun.
   * The marker is the durable counterpart of core's `acceptingFollowUps` --
   * opened before dispatch, held for as long as the submission is parked or
   * resumable, and cleared however it ends.
   *
   * So the marker being gone while a claim is still held is not an ambiguous
   * signal, it is a specific one: `finishProjection` got as far as clearing
   * admission and no further. That is the R173 wedge exactly, and it is why
   * `finishProjection` clears before it finishes -- the ordering is not merely
   * the lesser evil, it is what leaves evidence a later process can read.
   */
  const hasEnded = (
    sessionId: string
  ): Effect.Effect<boolean, StorageError> =>
    Effect.map(
      options.store.size(DurableChannels.openKey(sessionId)),
      (open) => open === 0
    )

  /**
   * Dispatch a claim's workflow and record the execution on the claim.
   *
   * Safe to repeat: the execution id is the same every time, and the engine
   * rejoins a running execution rather than starting another. The admission
   * marker is opened *before* dispatch, exactly as `DurableAgent.submit`
   * opens it: once a prompt has been accepted, steering must be admissible.
   */
  const dispatch = (
    sessionId: string,
    claim: DurableSessionStore.Claim,
    initialHistory: Prompt.Prompt
  ): Effect.Effect<string, StorageError, WorkflowEngine.WorkflowEngine> =>
    Effect.gen(function* () {
      const prompt = yield* DurableSessionStore.decodeHistory(claim.prompt)
      const payload: DurableSubmission.Payload = {
        sessionId,
        submissionId: claim.submissionId,
        prompt,
        initialHistory,
        stream: claim.stream
      }
      const executionId = yield* submission.definition.executionId(payload)
      yield* DurableAgent.open(options.store, sessionId)
      yield* DurableAgent.throughShardReassignment(
        submission.definition.execute(payload, { discard: true })
      )
      yield* options.sessionStore.attachExecution(
        sessionId,
        claim.submissionId,
        executionId
      )
      return executionId
    })

  /**
   * Deliver a recorded answer to the workflow, then forget it.
   *
   * The order is the crash-safety argument: the answer stays recorded until
   * the deferred has been completed, so a process lost between the two
   * leaves something for the next reconciliation to deliver.
   */
  const deliverAnswer = (
    sessionId: string,
    claim: DurableSessionStore.Claim,
    response: Parameters<DurableSessionStore.DurableSessionStore["answerRequest"]>[1]
  ): Effect.Effect<void, StorageError, WorkflowEngine.WorkflowEngine> =>
    Effect.gen(function* () {
      const executionId = yield* executionIdFor(sessionId, claim)
      yield* DurableElicitation.respond({
        workflow: submission.definition,
        executionId,
        response
      }).pipe(DurableAgent.throughShardReassignment)
      yield* options.sessionStore.takeAnswer(sessionId, response.id)
    })

  /**
   * Finish what a lost process left owed on this session.
   *
   * Two records can be outstanding: a claim with no execution behind it, and
   * answers accepted but never delivered. Both are replayed idempotently.
   * Nothing here depends on this process having observed the original.
   */
  const reconcile = (
    record: DurableSessionStore.SessionRecord
  ): Effect.Effect<void, StorageError, WorkflowEngine.WorkflowEngine> =>
    Effect.gen(function* () {
      if (Option.isNone(record.claim)) return
      const claim = record.claim.value
      if (claim.executionId === undefined) {
        const history = yield* DurableSessionStore.decodeHistory(record.history)
        yield* dispatch(record.sessionId, claim, history)
      } else if (yield* hasEnded(record.sessionId)) {
        /**
         * A claim whose submission has already ended (R173).
         *
         * `finishProjection` clears the admission and interrupt channels and
         * then finishes the claim. Those are two stores, so they are one
         * `Activity` but not one transaction, and if the finish fails the
         * catch path retries it and can fail the same way. The workflow then
         * ends -- terminally, with a failure exit -- while the claim is still
         * `running`. Admission is closed, nothing is executing, and every
         * later prompt is refused as `Busy`. Permanently: the wedge had no
         * exit, because reconciliation only ever looked for a claim that had
         * never been dispatched.
         *
         * A claim whose submission has ended is finishable by anyone, so the
         * reacquiring client does it. What it cannot recover is the
         * conversation that submission produced: the write that would have
         * committed the history is the one that failed, and no other copy of
         * it is durable. Canonical history therefore stays where the
         * submission began -- the turn leaves no trace, which is what a failed
         * submission should look like, and is the honest best available.
         *
         * Safe against a `finishProjection` still in flight, because `finish`
         * only matches a claim whose stored text is unchanged (R66). Whichever
         * arrives second finds the claim gone and reports `false`, so this
         * cannot erase a finish that succeeded or a claim that has moved on.
         *
         * The residual is narrow and worth naming: an acquisition landing
         * *between* that activity's clear and its finish will free the claim
         * first, and the history the workflow was about to commit is lost. It
         * was never durable, so nothing is overwritten that had been
         * promised -- but the turn is discarded where it might have survived.
         */
        const history = yield* DurableSessionStore.decodeHistory(record.history)
        yield* options.sessionStore.finish(
          record.sessionId,
          claim.submissionId,
          history
        )
        return
      }
      const answers = yield* options.sessionStore.recordedAnswers(record.sessionId)
      yield* Effect.forEach(answers, (answer) =>
        deliverAnswer(record.sessionId, claim, answer)
      )
    })

  const makeRemoteSession = (
    sessionId: string,
    // Captured once at layer build: the workflow engine is a property of the
    // *process*, not of each call, and the client contract requires no
    // requirements. Providing it here is what keeps `RemoteSession` inert.
    env: Context.Context<WorkflowEngine.WorkflowEngine>
  ): AgentClient.RemoteSession => ({
    id: sessionId,

    prompt: (input, promptOptions) =>
      Effect.gen(function* () {
        // Claim and dispatch are one uninterruptible step. The claim is the
        // atomic transition — idle -> running plus the allocated submission
        // id, with the request itself recorded — and once it has been taken
        // this caller owes the dispatch: a request cancelled between the two
        // (an aborted HTTP call, a timed-out fibre) must not leave the
        // session busy until someone happens to reacquire it. A process
        // dying in that window is the case the recorded claim exists for.
        const dispatched = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const outcome = yield* options.sessionStore.claim(sessionId, {
              prompt: Prompt.make(input),
              stream: promptOptions?.stream === true,
              // The caller's key, forwarded verbatim. Without it a retry
              // after a lost acknowledgement — the store took the claim, the
              // reply never arrived — is a *second* request, refused as
              // `Busy`; with it the store recognises the retry and hands back
              // the claim it already made. Spread rather than passed as
              // `undefined` because `Claim.key` is optional and absent means
              // "no idempotence", not "the key `undefined`".
              ...(promptOptions?.idempotencyKey === undefined
                ? {}
                : { key: promptOptions.idempotencyKey })
            })
            if (outcome._tag === "Missing") {
              return yield* noSuchSession(sessionId)
            }
            if (outcome._tag === "Busy") {
              return yield* new AgentBusyError({
                sessionId: Ids.sessionId(sessionId)
              })
            }
            // History as of the claim — the transcript the previous
            // submission left behind, read in the same transition so it
            // cannot be stale.
            const history = yield* DurableSessionStore.decodeHistory(
              outcome.history
            )
            const executionId = yield* dispatch(sessionId, outcome.claim, history)
            return { executionId, claim: outcome.claim }
          })
        )
        const claim = dispatched.claim

        const exit = yield* awaitOutcome(
          submission.definition,
          dispatched.executionId,
          pollInterval
        )

        if (Exit.isFailure(exit)) {
          // Only infrastructure lands in the error channel: agent failures
          // crossed as data on the success channel. Reporting infrastructure
          // here keeps the transport tag meaning what it says — the same call
          // may succeed on another attempt.
          const failure = Cause.findErrorOption(exit.cause)
          return yield* new AgentClient.AgentTransportError({
            sessionId,
            detail:
              failure._tag === "Some"
                ? failure.value.message
                : "workflow execution failed without a typed failure"
          })
        }
        if (exit.value._tag === "Infrastructure") {
          return yield* new AgentClient.AgentTransportError({
            sessionId,
            detail: exit.value.detail
          })
        }
        if (exit.value._tag === "Failed") {
          // An agent failure is a property of the request and will recur, so
          // it wears the execution tag — retrying on transport would loop.
          return yield* new AgentClient.AgentExecutionError({
            sessionId,
            tag: exit.value.failure.tag,
            detail: exit.value.failure.detail,
            isDefect: exit.value.failure.isDefect
          })
        }
        return {
          submissionId: Ids.submissionId(claim.submissionId),
          status: exit.value.status,
          runs: exit.value.runs,
          turns: exit.value.turns,
          text: exit.value.text
        }
      }).pipe(storageAsTransport(sessionId), Effect.provide(env)),

    steer: (input) =>
      DurableAgent.steer(options.store, sessionId, input).pipe(
        storageAsTransport(sessionId)
      ),

    followUp: (input) =>
      DurableAgent.followUp(options.store, sessionId, input).pipe(
        storageAsTransport(sessionId)
      ),

    interrupt: () =>
      Effect.gen(function* () {
        const found = yield* options.sessionStore.get(sessionId)
        if (Option.isNone(found)) {
          return yield* noSuchSession(sessionId)
        }
        if (Option.isNone(found.value.claim)) {
          return yield* new AgentIdleError({
            sessionId: Ids.sessionId(sessionId),
            operation: "interrupt"
          })
        }
        const claim = found.value.claim.value
        yield* DurableSubmission.interrupt(
          options.store,
          sessionId,
          claim.submissionId
        ).pipe(DurableAgent.throughShardReassignment)
        // A submission parked on a question has nothing running to notice
        // the intent. Waking it is answering it: each outstanding request is
        // refused — the most conservative answer there is — and the resumed
        // run finds the intent before it can act on the refusal, so the
        // outcome is an interruption rather than a run that carried on.
        const waiting = yield* options.sessionStore.pendingRequests(sessionId)
        yield* Effect.forEach(waiting, (request) =>
          Effect.flatMap(
            options.sessionStore.answerRequest(sessionId, {
              id: request.id,
              granted: false
            }),
            (accepted) =>
              accepted
                ? deliverAnswer(sessionId, claim, { id: request.id, granted: false })
                : Effect.void
          )
        )
      }).pipe(storageAsTransport(sessionId), Effect.provide(env)),

    respond: (response) =>
      Effect.gen(function* () {
        // Recorded before waking the workflow: the answer survives even if
        // this process dies between the two, and reconciliation delivers it.
        const accepted = yield* options.sessionStore.answerRequest(
          sessionId,
          response
        )
        if (!accepted) return false
        const found = yield* options.sessionStore.get(sessionId)
        if (Option.isSome(found) && Option.isSome(found.value.claim)) {
          yield* deliverAnswer(sessionId, found.value.claim.value, response)
        }
        return true
      }).pipe(storageAsTransport(sessionId), Effect.provide(env)),

    pending: options.sessionStore
      .pendingRequests(sessionId)
      .pipe(storageAsTransport(sessionId)),

    history: Effect.gen(function* () {
      const found = yield* options.sessionStore.get(sessionId)
      if (Option.isNone(found)) {
        return yield* noSuchSession(sessionId)
      }
      return yield* DurableSessionStore.decodeHistory(found.value.history, sessionId)
    }).pipe(storageAsTransport(sessionId)),

    status: Effect.gen(function* () {
      const found = yield* options.sessionStore.get(sessionId)
      if (Option.isNone(found)) {
        return yield* noSuchSession(sessionId)
      }
      return found.value.status
    }).pipe(storageAsTransport(sessionId)),

    events: (eventOptions) => {
      const delivery = options.delivery
      if (delivery === undefined) {
        /**
         * No log: live delivery is empty, and resumption is refused.
         *
         * An empty stream is a defensible answer to "what is happening now"
         * when nothing records it. It is not a defensible answer to "what did
         * I miss since 41", which has a real answer this deployment simply
         * cannot produce -- so it says that instead of returning nothing and
         * letting the caller read it as "nothing happened".
         */
        return eventOptions?.after === undefined
          ? Stream.fromIterable<AgentEventEnvelope>([])
          : Stream.fail(
            new AgentClient.AgentTransportError({
              sessionId,
              detail:
                "this client has no delivery log, so events cannot be resumed from a sequence"
            })
          )
      }
      /**
       * A log that stops being readable mid-stream ends the stream with a
       * transport failure rather than a defect, so a consumer can reconnect
       * from its last sequence -- which is the whole point of the log being
       * readable from an offset.
       */
      const asTransport = <A>(
        stream: Stream.Stream<A, StorageError>
      ): Stream.Stream<A, AgentClient.RemoteError> =>
        Stream.catchTag(stream, "StorageError", (error) =>
          Stream.fail(
            new AgentClient.AgentTransportError({ sessionId, detail: error.message })
          ))

      const live = asTransport(delivery.live(sessionId))
      if (eventOptions?.after === undefined) return live

      const after = eventOptions.after
      /**
       * Catch up, then continue, with no gap and no duplicate.
       *
       * The order is the entire argument, and the obvious order is wrong.
       * Reading history and *then* subscribing loses everything recorded in
       * between -- which is precisely the window a reconnecting client is
       * trying to close, so a resumption built that way drops events exactly
       * when it is being relied on.
       *
       * So the subscription is established first, via `subscribe` rather than
       * `live`. The difference is not stylistic: a stream subscribes when it
       * is first *pulled*, and handing `live` to a queue only forks something
       * that will subscribe eventually. The read then races that fork, and an
       * event landing in between is in neither half. That version of this was
       * written, and the gap test below failed against it.
       *
       * `subscribe` does not return until the log is already holding events
       * for this subscriber, so nothing can be lost. What remains is a
       * *duplicate* -- anything recorded during the read is in both halves --
       * and duplicates are removable where gaps are not, which is why this is
       * the safe direction to err in.
       *
       * The overlap is then cut by sequence. `highest` is the last sequence
       * the history actually contained, so buffered events at or below it
       * have already been delivered. Where the history is empty it falls back
       * to `after` itself, which is the same statement about a session that
       * has recorded nothing new.
       *
       */
      return Stream.unwrap(
        Effect.gen(function* () {
          const continuing = asTransport(yield* delivery.subscribe(sessionId).pipe(
            Effect.mapError(
              (error) =>
                new AgentClient.AgentTransportError({ sessionId, detail: error.message })
            )
          ))
          const history = yield* delivery
            .read(sessionId, { after })
            .pipe(
              Effect.mapError(
                (error) =>
                  new AgentClient.AgentTransportError({
                    sessionId,
                    detail: error.message
                  })
              )
            )
          const highest = history.length === 0
            ? after
            : history[history.length - 1]!.sequence
          return Stream.concat(
            Stream.fromIterable(history),
            Stream.filter(continuing, (envelope) => envelope.sequence > highest)
          )
        })
      )
    }
  })

  return Layer.effect(
    AgentClient.AgentClient,
    Effect.gen(function* () {
      const env = yield* Effect.context<WorkflowEngine.WorkflowEngine>()

      const createSession: AgentClient.Service["createSession"] = (
        sessionOptions
      ) =>
        Effect.gen(function* () {
          const sessionId =
            sessionOptions?.sessionId ?? (yield* freshSessionId)
          const record = yield* options.sessionStore.getOrCreate(
            sessionId,
            initialHistory(agent)
          )
          yield* reconcile(record)
          // Nothing handle-owned is acquired, so there is nothing to release:
          // closing this scope ends the *handle*, never the logical session.
          return makeRemoteSession(sessionId, env)
          // The id is known only inside the block, so the transport error names
          // what the caller asked for -- or says it had not been assigned yet.
        }).pipe(
          storageAsTransport(sessionOptions?.sessionId ?? "(unassigned)"),
          Effect.provide(env)
        )

      const session: AgentClient.Service["session"] = (requested) =>
        Effect.gen(function* () {
          // Not an in-process lookup: a session created by another process is
          // reacquired here from the shared store, which is what makes clients
          // disposable and processes interchangeable.
          const found = yield* options.sessionStore.get(requested)
          if (Option.isNone(found)) {
            return yield* noSuchSession(requested)
          }
          yield* reconcile(found.value)
          return makeRemoteSession(requested, env)
        }).pipe(storageAsTransport(requested), Effect.provide(env))

      return { createSession, session }
    })
  ).pipe(Layer.merge(submission.layer))
}

/**
 * As `layer`, with operational polling durations loaded through Effect Config.
 *
 * Stores remain explicit capabilities. Missing config keys use the concrete
 * defaults exported by `DurablePolling`; malformed or non-positive values fail
 * layer construction with the typed `ConfigError`.
 */
export const layerConfig = <Tools extends Record<string, Tool.Any>>(
  name: string,
  agent: AgentDefinition<Tools, any, any>,
  options: ConfigOptions
): Layer.Layer<
  AgentClient.AgentClient,
  Config.ConfigError,
  WorkflowEngine.WorkflowEngine | LanguageModel.LanguageModel
> =>
  Layer.unwrap(
    Effect.map(
      Config.all({
        pollInterval: options.pollInterval ?? DurablePolling.clientOutcome,
        interruptPollInterval:
          options.interruptPollInterval ?? DurablePolling.workflowInterrupt
      }),
      ({ interruptPollInterval, pollInterval }) =>
        layer(name, agent, {
          ...options,
          pollInterval,
          interruptPollInterval
        })
    )
  )
