import { Cause, Duration, Effect, Exit, Layer, Option, Stream } from "effect"
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
  const pollInterval = options.pollInterval ?? Duration.millis(10)

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
              stream: promptOptions?.stream === true
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

    // Live delivery from the shared log when one is supplied. The stream is
    // live-only — events recorded after this subscription begins — matching
    // the HTTP adapter's policy; replay from an offset is `DeliveryLog.read`.
    events:
      options.delivery !== undefined
        ? options.delivery
            .live(sessionId)
            // A log that stops being readable mid-stream ends the stream with
            // a transport failure rather than a defect, so a consumer can
            // reconnect from its last sequence — which is the whole point of
            // the log being readable from an offset.
            .pipe(
              Stream.catchTag("StorageError", (error) =>
                Stream.fail(
                  new AgentClient.AgentTransportError({
                    sessionId,
                    detail: error.message
                  })
                )
              )
            )
        : Stream.fromIterable<AgentEventEnvelope>([])
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
