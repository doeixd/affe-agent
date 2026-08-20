import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Option,
  Ref,
  Scope,
  Stream,
  SubscriptionRef
} from "effect"
import { LanguageModel, Prompt } from "effect/unstable/ai"
import type { AiError, Tool } from "effect/unstable/ai"
import type { AgentDefinition } from "./Agent.js"
import * as InputChannel from "./InputChannel.js"
import * as AgentEvent from "./AgentEvent.js"
import type { AgentEventEnvelope } from "./AgentEvent.js"
import * as AgentSubmission from "./AgentSubmission.js"
import { AgentBusyError, AgentClosedError, AgentIdleError } from "./Errors.js"
import * as EventBus from "./internal/eventBus.js"
import * as History from "./internal/history.js"
import * as Ids from "./internal/ids.js"
import type { SubmissionId } from "./internal/ids.js"
import type { Session, SessionState, Status } from "./internal/state.js"

/** Correlation id for a session. See `AgentEvent` for the envelope. */
export const Id = Ids.SessionId
export type Id = Ids.SessionId

export type { Status }
export type { SessionState as State }
export type Result<Tools extends Record<string, Tool.Any> = {}> =
  AgentSubmission.Result<Tools>



const SessionTypeId: unique symbol = Symbol.for("@doeixd/effect-agent/AgentSession")
declare const ToolsVariance: unique symbol

/**
 * The long-lived stateful instance of an agent, and the boundary through which
 * an application interacts with the harness.
 *
 * Opaque: everything it holds is reached through the functions in this module.
 * `Tools` is carried purely at the type level, so a session keeps the tool
 * types its agent was defined with.
 */
export interface AgentSession<
  out Tools extends Record<string, Tool.Any> = {},
  out E = never
> {
  readonly [SessionTypeId]: Session<any, any, any>
  readonly [ToolsVariance]: () => readonly [Tools, E]
}

const unwrap = <Tools extends Record<string, Tool.Any>, E>(
  session: AgentSession<Tools, E>
): Session<Tools, E, never> =>
  session[SessionTypeId] as Session<Tools, E, never>

/**
 * Create a scoped session for an agent.
 *
 * Leaving the scope interrupts any active run and releases everything the
 * session owns, so lifetime is governed by ordinary structured concurrency
 * rather than a close protocol of the harness's own.
 */
export interface MakeOptions {
  /**
   * Fixes the session's identity.
   *
   * Sessions are otherwise numbered per process, which a durable or
   * distributed runtime cannot rely on: the same logical session must keep its
   * id across a restart, and across nodes.
   */
  readonly sessionId?: string | undefined
  /**
   * Where steering and follow-up input is held. Defaults to in-memory queues.
   *
   * A stronger runtime substitutes this; see `InputChannel` for why it is the
   * one seam that Layer substitution could not already provide.
   */
  readonly channels?: InputChannel.Factory | undefined
}

export const make = <Tools extends Record<string, Tool.Any>, E, R>(
  agent: AgentDefinition<Tools, E, R>,
  options?: MakeOptions
): Effect.Effect<
  AgentSession<Tools, E>,
  never,
  Scope.Scope | LanguageModel.LanguageModel | R
> =>
  Effect.gen(function* () {
    // Captured once, so the session handle carries no residual requirements
    // and a child session can run under an entirely different model layer.
    const env = yield* Effect.context<LanguageModel.LanguageModel | R>()
    const scope = yield* Effect.scope
    const id =
      options?.sessionId === undefined
        ? yield* Ids.nextSessionId
        : Ids.sessionId(options.sessionId)

    const state = yield* SubscriptionRef.make<SessionState>({
      status: "idle",
      submissionCount: 0,
      activeSubmissionId: Option.none(),
      acceptingFollowUps: false,
      activeRunId: Option.none(),
      turn: 0,
      history: Option.match(agent.instructions, {
        onNone: () => Prompt.empty,
        onSome: History.systemMessage
      })
    })

    const bus = yield* EventBus.make(id)
    const channels = options?.channels ?? InputChannel.memory
    const steering = yield* channels.make(id, "steering")
    const followUps = yield* channels.make(id, "followUps")
    const activeFiber = yield* Ref.make<Option.Option<Fiber.Fiber<any, any>>>(
      Option.none()
    )
    const ids = yield* Ids.makeIdSource

    const session: Session<Tools, E, R> = {
      id,
      agent: agent as AgentDefinition<any, any>,
      state,
      bus,
      steering,
      followUps,
      activeFiber,
      scope,
      env,
      ids
    }

    yield* Effect.addFinalizer(() =>
      SubscriptionRef.update(state, (s) => ({
        ...s,
        status: "closed" as const
      })).pipe(
        Effect.andThen(EventBus.emit(bus, {}, { _tag: "SessionClosed" })),
        Effect.ignore
      )
    )
    yield* EventBus.emit(bus, {}, { _tag: "SessionStarted" })

    // `AgentSession` carries `Tools` in a phantom field that has no runtime
    // counterpart, so constructing one is always an assertion.
    return { [SessionTypeId]: session } as unknown as AgentSession<Tools, E>
  })

/**
 * Begin a submission. Requires an idle session.
 *
 * Resolves only once the session reaches quiescence — after the initial prompt
 * and every follow-up queued during its execution.
 */
/**
 * The failures a submission can produce.
 *
 * Typed rather than collapsed into one agent error: a caller can distinguish a
 * busy session from a provider fault from a tool's own declared failure, which
 * is the point of Effect's error channel.
 */
export type PromptError<Tools extends Record<string, Tool.Any>, E = never> =
  | AgentBusyError
  | AgentClosedError
  | AiError.AiError
  | Tool.HandlerError<Tools[keyof Tools]>
  // Whatever the agent's own loop or context transform can fail with.
  | E

type Claim =
  | { readonly _tag: "Claimed"; readonly submissionId: SubmissionId }
  | { readonly _tag: "Busy" }
  | { readonly _tag: "Closed" }

/**
 * Atomically take an idle session and allocate its submission id.
 *
 * Reading the status and then writing it would be a check-then-act race: two
 * concurrent prompts could both observe `idle`, and the "at most one run per
 * session" invariant would hold only by luck of scheduling.
 */
const claim = (self: Session<any>): Effect.Effect<Claim> =>
  SubscriptionRef.modify(self.state, (s): [Claim, SessionState] => {
    if (s.status === "closed") return [{ _tag: "Closed" }, s]
    if (s.status === "running") return [{ _tag: "Busy" }, s]
    const count = s.submissionCount + 1
    const submissionId = Ids.submissionId(`submission-${count}`)
    return [
      { _tag: "Claimed", submissionId },
      {
        ...s,
        status: "running",
        submissionCount: count,
        activeSubmissionId: Option.some(submissionId),
        // Open for follow-ups until the submission closes its own input.
        acceptingFollowUps: true
      }
    ]
  })

/** Return the session to idle and drop anything queued for the submission. */
const release = (self: Session<any>): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Ref.set(self.activeFiber, Option.none())
    yield* SubscriptionRef.update(self.state, (s) => ({
      ...s,
      // A closed session stays closed; the scope has already gone.
      status: s.status === "closed" ? s.status : ("idle" as const),
      activeSubmissionId: Option.none(),
      acceptingFollowUps: false,
      activeRunId: Option.none()
    }))
    yield* self.steering.drain
    yield* self.followUps.drain
  })

/**
 * Begin a submission. Requires an idle session.
 *
 * Resolves only once the session reaches quiescence — after the initial prompt
 * and every follow-up queued during its execution.
 */
export const prompt = Effect.fn("AgentSession.prompt")(function* <
  Tools extends Record<string, Tool.Any>,
  E
>(session: AgentSession<Tools, E>, input: Prompt.RawInput) {
    const self = unwrap(session)
    const claimed = yield* claim(self)

    if (claimed._tag === "Closed") {
      return yield* new AgentClosedError({ sessionId: self.id })
    }
    if (claimed._tag === "Busy") {
      return yield* new AgentBusyError({ sessionId: self.id })
    }
    const submissionId = claimed.submissionId

    // The submission runs in a fiber owned by the session scope, so
    // `interrupt` is ordinary fiber interruption rather than a bespoke
    // cancellation protocol.
    const submission = AgentSubmission.execute(
      self,
      submissionId,
      Prompt.make(input)
    ).pipe(
      // The captured environment satisfies the model and any tool-handler
      // services; providing it leaves a submission with no requirements.
      Effect.provide(self.env)
    ) as Effect.Effect<Omit<Result<Tools>, "status">, PromptError<Tools, E>>
    const fiber = yield* submission.pipe(Effect.forkIn(self.scope))
    yield* Ref.set(self.activeFiber, Option.some(fiber))

    // The finalizer runs however this ends, including when the *caller* is
    // interrupted by a timeout or a lost race. Without it the submission would
    // outlive its caller and the session would stay `running` for good.
    const exit = yield* Fiber.await(fiber).pipe(
      Effect.ensuring(Fiber.interrupt(fiber).pipe(Effect.andThen(release(self))))
    )

    if (Exit.isFailure(exit)) {
      // Interruption is a terminal state, not a caller-level failure: the
      // caller learns about it from the result rather than being interrupted.
      if (Cause.hasInterruptsOnly(exit.cause)) {
        yield* EventBus.emit(
          self.bus,
          { submissionId },
          { _tag: "SubmissionInterrupted" }
        )
        return {
          submissionId,
          status: "interrupted",
          runs: 0,
          turns: 0,
          text: "",
          response: Option.none()
        } satisfies Result<Tools>
      }
      yield* EventBus.emit(
        self.bus,
        { submissionId },
        {
          _tag: "SubmissionFailed",
          failure: AgentEvent.failureFromCause(exit.cause)
        }
      )
      return yield* Effect.failCause(exit.cause)
    }

    return { ...exit.value, status: "completed" } satisfies Result<Tools>
  })

const requireRunning = (
  session: Session<any>,
  operation: "steer" | "followUp" | "interrupt"
) =>
  Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(session.state)
    if (current.status === "closed") {
      return yield* new AgentClosedError({ sessionId: session.id })
    }
    if (current.status !== "running") {
      return yield* new AgentIdleError({ sessionId: session.id, operation })
    }
    return Option.getOrUndefined(current.activeSubmissionId)
  })

/**
 * Insert guidance into the active run.
 *
 * Applied at the next turn boundary; it never interrupts work already under
 * way. For immediate intervention, `interrupt` then `prompt`.
 */
export const steer = Effect.fn("AgentSession.steer")(function* (
  session: AgentSession<any, any>,
  input: Prompt.RawInput
) {
    const self = unwrap(session)
    const submissionId = yield* requireRunning(self, "steer")
    yield* self.steering.offer(Prompt.make(input))
    yield* EventBus.emit(
      self.bus,
      { submissionId },
      { _tag: "SteeringQueued" }
    )
  })

/** Queue work to run after the active run reaches its stopping condition. */
export const followUp = Effect.fn("AgentSession.followUp")(function* (
  session: AgentSession<any, any>,
  input: Prompt.RawInput
) {
    const self = unwrap(session)
    const submissionId = yield* requireRunning(self, "followUp")
    // The submission may have closed its input without the session being idle
    // yet; accepting here would mean promising work that is about to be
    // discarded.
    const accepting = yield* SubscriptionRef.get(self.state).pipe(
      Effect.map((s) => s.acceptingFollowUps)
    )
    if (!accepting) {
      return yield* new AgentIdleError({
        sessionId: self.id,
        operation: "followUp"
      })
    }
    yield* self.followUps.offer(Prompt.make(input))
    yield* EventBus.emit(self.bus, { submissionId }, { _tag: "FollowUpQueued" })
  })

/** Interrupt the active submission. */
export const interrupt = Effect.fn("AgentSession.interrupt")(function* (
  session: AgentSession<any, any>
) {
    const self = unwrap(session)
    yield* requireRunning(self, "interrupt")
    const fiber = yield* Ref.get(self.activeFiber)
    if (Option.isSome(fiber)) {
      yield* Fiber.interrupt(fiber.value)
    }
  })

/** Canonical conversation history. */
export const history = (
  session: AgentSession<any, any>
): Effect.Effect<Prompt.Prompt> =>
  History.snapshot(unwrap(session).state)

export const status = (session: AgentSession<any, any>): Effect.Effect<Status> =>
  SubscriptionRef.get(unwrap(session).state).pipe(Effect.map((s) => s.status))

/**
 * A read-only view of harness runtime state, for a UI that observes it.
 *
 * Deliberately not the underlying `SubscriptionRef`. Handing that out would let
 * a caller write to it, and canonical history lives there — which would break
 * the invariant that the session is its sole owner (PLAN §45). Observation is
 * a different capability from mutation, and only one of them is on offer.
 */
export interface StateView {
  readonly get: Effect.Effect<SessionState>
  readonly changes: Stream.Stream<SessionState>
}

export const state = (session: AgentSession<any, any>): StateView => {
  const ref = unwrap(session).state
  return {
    get: SubscriptionRef.get(ref),
    changes: SubscriptionRef.changes(ref)
  }
}

/**
 * The live event stream.
 *
 * Observational only. It is not a durability guarantee: a subscriber that
 * cannot tolerate loss belongs to a future store observing commits.
 */
export const events = (
  session: AgentSession<any, any>
): Stream.Stream<AgentEventEnvelope> => EventBus.events(unwrap(session).bus)
