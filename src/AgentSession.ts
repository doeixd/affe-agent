import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Option,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef
} from "effect"
import { LanguageModel, Prompt } from "effect/unstable/ai"
import type { AiError, Tool } from "effect/unstable/ai"
import type { AgentDefinition } from "./Agent.js"
import * as Elicitation from "./Elicitation.js"
import * as InputChannel from "./InputChannel.js"
import * as AgentEvent from "./AgentEvent.js"
import type { AgentEventEnvelope } from "./AgentEvent.js"
import * as AgentSubmission from "./AgentSubmission.js"
import {
  AgentBusyError,
  AgentClosedError,
  AgentIdleError
} from "./Errors.js"
import type * as ToolExecution from "./ToolExecution.js"
import * as EventBus from "./internal/eventBus.js"
import * as History from "./internal/history.js"
import * as Ids from "./internal/ids.js"
import type { SubmissionId } from "./internal/ids.js"
import type { Session, SessionState, Status, SubmissionProgress } from "./internal/state.js"

/** Correlation id for a session. See `AgentEvent` for the envelope. */
export const Id = Ids.SessionId
export type Id = Ids.SessionId

export type { Status }
export type { SessionState as State }
export type Result<Tools extends Record<string, Tool.Any> = {}> =
  AgentSubmission.Result<Tools>



const SessionTypeId: unique symbol = Symbol.for("@doeixd/effect-agent/AgentSession")

/**
 * The long-lived stateful instance of an agent, and the boundary through which
 * an application interacts with the harness.
 *
 * A small method-bearing handle: what the session can *do*, never how it does
 * it. Everything mutable — the agent, the scope, the active fiber, the input
 * channels, the state ref, the captured environment — stays behind
 * `SessionTypeId` and is reachable only through this module.
 *
 * The methods are bound to the module functions of the same name, so there is
 * one implementation and two ways to reach it:
 *
 * ```ts
 * yield* session.prompt("go")              // ergonomic
 * yield* AgentSession.prompt(session, "go") // composable
 * ```
 *
 * The handle is inert. `session.prompt(input)` builds an `Effect` and does
 * nothing else; no work starts until it is run.
 *
 * `Tools` and `E` are carried by the method signatures rather than a phantom
 * field, which is what lets this be constructed without a cast.
 *
 * Deliberately no `out` variance annotations. The phantom field previously
 * declared `Tools` covariant, but it is not: a submission's `Result` carries a
 * `GenerateTextResponse<Tools, true>`, which Effect AI makes invariant in
 * `Tools`. Declaring covariance over a phantom asserted something the type
 * never had; stating nothing lets the compiler infer what is actually true.
 */
export interface AgentSession<
  Tools extends Record<string, Tool.Any> = {},
  E = never
> {
  readonly [SessionTypeId]: Session<any, any, any>

  /**
   * Immutable identity, safe to expose: logging, tracing, UI routing,
   * persistence, RPC correlation, durable execution.
   */
  readonly id: Ids.SessionId

  /** Begin a submission. Resolves at quiescence. */
  readonly prompt: (
    input: Prompt.RawInput,
    options?: PromptOptions
  ) => Effect.Effect<Result<Tools>, PromptError<Tools, E>>

  /** Insert guidance into the active run, applied at the next turn boundary. */
  readonly steer: (
    input: Prompt.RawInput
  ) => Effect.Effect<void, AgentIdleError | AgentClosedError>

  /** Queue work to run after the active run reaches its stopping condition. */
  readonly followUp: (
    input: Prompt.RawInput
  ) => Effect.Effect<void, AgentIdleError | AgentClosedError>

  /** Interrupt the active submission. */
  readonly interrupt: () => Effect.Effect<
    void,
    AgentIdleError | AgentClosedError
  >

  /** Canonical conversation history, read when the Effect is run. */
  readonly history: Effect.Effect<Prompt.Prompt>

  /** The session's current status, read when the Effect is run. */
  readonly status: Effect.Effect<Status>

  /** The live event stream. Observational; not a durability guarantee. */
  readonly events: Stream.Stream<AgentEventEnvelope>

  /** A read-only view of runtime state, for a UI that observes it. */
  readonly state: StateView
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
   * Canonical history to start from, in place of the agent's instructions.
   *
   * Used by `restore`. Supplying it means the session begins mid-conversation
   * rather than at the beginning, which is why it replaces the instructions
   * rather than being appended to them: a restored transcript already contains
   * whatever system message the original session opened with.
   */
  readonly history?: Prompt.Prompt | undefined
  /**
   * How submissions are named. Defaults to `submission-${n}`.
   *
   * Elicitation ids are namespaced by the submission id, so the name is
   * what makes a question's id unique across submissions. The durable
   * workflow names its one in-workflow submission after the *durable*
   * submission, which is what makes a question asked in one durable
   * submission unanswerable with an id from another.
   */
  readonly submissionIds?: ((count: number) => string) | undefined
  /**
   * Where a paused run waits for an answer from outside.
   *
   * Defaults to refusing every request, which keeps an approval-requiring tool
   * behaving as it did before elicitation existed. Supply one to make such a
   * tool *satisfiable* rather than merely refused — and a durable interpreter
   * substitutes one backed by `DurableDeferred`, so a submission waiting on a
   * human survives the process it started in.
   */
  readonly elicitation?: Elicitation.Factory | undefined
  /**
   * Where steering and follow-up input is held. Defaults to in-memory queues.
   *
   * A stronger runtime substitutes this; see `InputChannel` for why it is the
   * one seam that Layer substitution could not already provide.
   */
  readonly channels?: InputChannel.Factory | undefined
  /**
   * Observes every envelope this session emits, synchronously, in sequence
   * order — before `prompt` can report the outcome those events describe.
   *
   * This is not a second way to do what `events` does. A `Stream` subscriber
   * attaches asynchronously and can miss anything emitted before its
   * subscription lands, which is exactly the delivery guarantee an interpreter
   * recording events for remote clients needs and cannot get by observing.
   * Absent by default; the local runtime never supplies one.
   */
  readonly eventSink?:
    | ((envelope: AgentEventEnvelope) => Effect.Effect<void>)
    | undefined
  /**
   * Internal synchronisation seam: an effect run once per run, after the
   * submission's first follow-up drain and before it decides to close its
   * input — the exact window the input gate protects. Absent by default; the
   * local runtime never supplies one. It exists so a test can act in that window
   * deterministically (offer a follow-up that the *closing* drain must catch)
   * rather than racing it. The permit is not held here, so acting through
   * `followUp` is safe.
   */
  readonly beforeClose?: Effect.Effect<void> | undefined
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
    })

    const history = yield* Ref.make(
      options?.history ??
        Option.match(agent.instructions, {
          onNone: () => Prompt.empty,
          onSome: History.systemMessage
        })
    )

    const bus = yield* EventBus.make(id, options?.eventSink)
    const channels = options?.channels ?? InputChannel.memory
    const admit: (
      sessionId: string,
      admitting: boolean
    ) => Effect.Effect<void> = channels.setAdmitting ?? (() => Effect.void)
    // Defaults to refusing, which is the behaviour that existed before
    // elicitation did: an agent with an approval-requiring tool must not begin
    // pausing forever because the feature arrived. A caller opts *in* to being
    // asked.
    const elicitation = yield* (options?.elicitation ?? Elicitation.denied).make(
      id
    )
    const steering = yield* channels.make(id, "steering")
    const followUps = yield* channels.make(id, "followUps")
    const inputGate = yield* Semaphore.make(1)
    const activeFiber = yield* Ref.make<Option.Option<Fiber.Fiber<any, any>>>(
      Option.none()
    )
    // Live progress of the active submission, so an interrupt can still report
    // the runs/turns/text/usage that committed before it. Reset per submission.
    const progress = yield* Ref.make<SubmissionProgress<Tools>>({
      runs: 0,
      turns: 0,
      text: "",
      response: Option.none()
    })
    const ids = yield* Ids.makeIdSource
    const submissionName = options?.submissionIds ?? ((count: number) => `submission-${count}`)
    const beforeClose = options?.beforeClose ?? Effect.void

    const session: Session<Tools, E, R> = {
      id,
      agent: agent as AgentDefinition<any, any>,
      state,
      history,
      progress,
      bus,
      steering,
      followUps,
      inputGate,
      beforeClose,
      elicitation,
      admit,
      activeFiber,
      scope,
      env,
      ids,
      submissionName
    }

    // Closing ends the active submission *before* announcing the close.
    // The scope closing interrupts the forked submission anyway, but on its
    // own schedule: its `SubmissionInterrupted` would land after
    // `SessionClosed`, and a consumer that treats the close as the end of
    // the stream would never see the submission's terminal event. Awaiting
    // the fiber here puts the terminal events where they belong.
    yield* Effect.addFinalizer(() =>
      Effect.flatMap(Ref.get(activeFiber), (active) =>
        Option.isSome(active)
          ? Effect.asVoid(Fiber.interrupt(active.value))
          : Effect.void
      ).pipe(
        Effect.andThen(
          SubscriptionRef.update(state, (s) => ({
            ...s,
            status: "closed" as const
          }))
        ),
        Effect.andThen(EventBus.emit(bus, {}, { _tag: "SessionClosed" })),
        Effect.ignore
      )
    )
    yield* EventBus.emit(bus, {}, { _tag: "SessionStarted" })

    // No cast. The handle's members are exactly what the interface declares,
    // so the compiler can check the construction rather than being told to
    // trust it — which is the point of carrying `Tools` in the method
    // signatures instead of a phantom field.
    //
    // The action methods delegate to this module's own functions, so there is
    // one implementation and one set of spans. They are safe to reference
    // before `handle` is initialised because they are only *called* later.
    const handle: AgentSession<Tools, E> = {
      [SessionTypeId]: session,
      id,
      prompt: (input, options) => prompt(handle, input, options),
      steer: (input) => steer(handle, input),
      followUp: (input) => followUp(handle, input),
      interrupt: () => interrupt(handle),
      // Observations are values, not methods: nothing is being asked of the
      // session, so there is nothing to call. They are still lazy — an
      // `Effect` describes the read rather than performing it.
      history: historyOf(session),
      status: statusOf(session),
      events: eventsOf(session),
      state: stateOf(session)
    }
    return handle
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
/**
 * Per-request options for a submission.
 *
 * Deliberately request-level rather than part of the `Agent`. The same agent
 * should be usable from an interactive UI and from a batch job, and which one
 * it is depends on the caller, not the definition.
 */
export interface PromptOptions {
  /**
   * Stream the model calls, emitting `MessageDelta` events as output arrives.
   *
   * Observational only. Canonical history is still committed atomically at the
   * end of each turn, after tools have run, so a submission's transcript does
   * not depend on whether anyone was watching it.
   */
  readonly stream?: boolean | undefined
}

export type PromptError<Tools extends Record<string, Tool.Any>, E = never> =
  | AgentBusyError
  | AgentClosedError
  | AiError.AiError
  | Tool.HandlerError<Tools[keyof Tools]>
  /**
   * The failures `ToolExecution` raises itself when the harness declines a call
   * (approval required, permission denied) rather than running the handler. No
   * *tool* produces these, so they are absent from `Tool.HandlerError` above;
   * this alias is derived from `ToolExecution`'s own signature, so a new
   * harness-raised error can never silently go missing from `prompt`'s type.
   */
  | ToolExecution.RaisedError
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
    const submissionId = Ids.submissionId(self.submissionName(count))
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
    // Admission is deliberately *not* withdrawn here. `AgentSubmission`
    // publishes the close when its gate closes, which is what shuts the
    // accepted-then-discarded window; release also runs when a run is merely
    // interrupted, and under durability that includes a submission suspending.
    // A parked submission is still open for business — it is waiting to be
    // resumed — so withdrawing admission here would refuse steering aimed at a
    // run that is about to continue.
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
>(
  session: AgentSession<Tools, E>,
  input: Prompt.RawInput,
  options: PromptOptions = {}
) {
    const self = unwrap(session)

    // Claim, fork and register as one uninterruptible step, and the release
    // finalizer installed in the same step. Each gap here was a real hole:
    // a caller interrupted between claim and fork (a `timeout`, a lost race)
    // left the session `running` with nothing to release it; one interrupted
    // between fork and registration left a submission no finalizer owned;
    // and `interrupt` arriving between claim and registration passed
    // `requireRunning`, found no fiber, and reported success while the
    // submission went on to complete. Nothing in this step blocks, so
    // holding interruption off for it costs nothing.
    const started = yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const claimed = yield* claim(self)
        if (claimed._tag !== "Claimed") return claimed
        const submissionId = claimed.submissionId

        // The submission runs in a fiber owned by the session scope, so
        // `interrupt` is ordinary fiber interruption rather than a bespoke
        // cancellation protocol.
        const submission = AgentSubmission.execute(
          self,
          submissionId,
          Prompt.make(input),
          options
        ).pipe(
          // The captured environment satisfies the model and any tool-handler
          // services; providing it leaves a submission with no requirements.
          Effect.provide(self.env)
        ) as Effect.Effect<Omit<Result<Tools>, "status">, PromptError<Tools, E>>
        // The submission's own terminal events are emitted by the submission
        // fibre, not by whoever awaits it. A caller that times out or loses a
        // race is not there to emit them, and a closing session must be able
        // to wait for them before announcing `SessionClosed`.
        const fiber = yield* submission.pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? EventBus.emit(
                  self.bus,
                  { submissionId },
                  Cause.hasInterruptsOnly(exit.cause)
                    ? { _tag: "SubmissionInterrupted" }
                    : {
                        _tag: "SubmissionFailed",
                        failure: AgentEvent.failureFromCause(exit.cause)
                      }
                )
              : Effect.void
          ),
          Effect.forkIn(self.scope)
        )
        yield* Ref.set(self.activeFiber, Option.some(fiber))

        // The finalizer runs however this ends, including when the *caller*
        // is interrupted by a timeout or a lost race. Without it the
        // submission would outlive its caller and the session would stay
        // `running` for good.
        const exit = yield* restore(Fiber.await(fiber)).pipe(
          Effect.ensuring(
            Fiber.interrupt(fiber).pipe(Effect.andThen(release(self)))
          )
        )
        return { _tag: "Done" as const, submissionId, exit }
      })
    )

    if (started._tag === "Closed") {
      return yield* new AgentClosedError({ sessionId: self.id })
    }
    if (started._tag === "Busy") {
      return yield* new AgentBusyError({ sessionId: self.id })
    }
    const { submissionId, exit } = started

    if (Exit.isFailure(exit)) {
      // Interruption is a terminal state, not a caller-level failure: the
      // caller learns about it from the result rather than being interrupted.
      // The runs/turns/text/usage reported are those that committed before the
      // interrupt (turns commit atomically, so a rolled-back partial turn is not
      // counted), read from the live submission progress.
      if (Cause.hasInterruptsOnly(exit.cause)) {
        const landed = yield* Ref.get(self.progress)
        return {
          submissionId,
          status: "interrupted",
          runs: landed.runs,
          turns: landed.turns,
          text: landed.text,
          response: landed.response
        } satisfies Result<Tools>
      }
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
    // Offer and announcement are one step under the input gate, which the
    // turn-boundary drain holds too — so a drain can never observe the input
    // before its acceptance was announced, and `SteeringQueued < SteeringApplied`
    // (PLAN §27) holds by construction rather than by scheduling luck.
    yield* self.inputGate.withPermits(1)(
      Effect.gen(function* () {
        yield* self.steering.offer(Prompt.make(input))
        yield* EventBus.emit(
          self.bus,
          { submissionId },
          { _tag: "SteeringQueued" }
        )
      })
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
    //
    // The gate check, the offer and the announcement are one step, under the
    // same permit the submission's closing drain holds. Reading
    // `acceptingFollowUps` and then offering separately would leave a window:
    // the close could land between them and its final drain would already have
    // looked — the follow-up would be accepted here and discarded on release.
    // Under the permit, anything offered while the gate read open is still in
    // the queue when that drain runs, and anything after it reads a closed gate
    // and is refused.
    //
    // `FollowUpQueued` is published inside the permit for the same reason: a
    // drain runs under it too, so it can never observe the input before its
    // acceptance was announced. PLAN §27's ordering — Queued < Applied — holds
    // by construction rather than by scheduling luck.
    yield* self.inputGate.withPermits(1)(
      Effect.gen(function* () {
        const accepting = (yield* SubscriptionRef.get(self.state))
          .acceptingFollowUps
        if (!accepting) {
          return yield* new AgentIdleError({
            sessionId: self.id,
            operation: "followUp"
          })
        }
        yield* self.followUps.offer(Prompt.make(input))
        yield* EventBus.emit(
          self.bus,
          { submissionId },
          { _tag: "FollowUpQueued" }
        )
      })
    )
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

/**
 * The observations, defined over the internal session.
 *
 * Both the module functions below and the handle's fields delegate here, so
 * there is one implementation of each and no chance of the two drifting.
 */
const historyOf = (self: Session<any, any, any>): Effect.Effect<Prompt.Prompt> =>
  History.snapshot(self.history)

const statusOf = (self: Session<any, any, any>): Effect.Effect<Status> =>
  SubscriptionRef.get(self.state).pipe(Effect.map((s) => s.status))

const eventsOf = (
  self: Session<any, any, any>
): Stream.Stream<AgentEventEnvelope> => EventBus.events(self.bus)

const stateOf = (self: Session<any, any, any>): StateView => ({
  get: SubscriptionRef.get(self.state),
  changes: SubscriptionRef.changes(self.state)
})

/**
 * Answer a request the run is waiting on.
 *
 * Returns `false` when nothing was waiting for that id — a late answer to a
 * run that has moved on. Worth reporting rather than swallowing: from the
 * outside, "approved" and "approved too late" look identical otherwise.
 */
export const respond = Effect.fn("AgentSession.respond")(function* (
  session: AgentSession<any, any>,
  response: Elicitation.Response
) {
    const self = unwrap(session)
    const answered = yield* self.elicitation.respond(response)
    return answered
  })

/** What the run is currently waiting to be told. */
export const pending = (
  session: AgentSession<any, any>
): Effect.Effect<ReadonlyArray<Elicitation.Request>> =>
  unwrap(session).elicitation.pending

/** Canonical conversation history. */
export const history = (
  session: AgentSession<any, any>
): Effect.Effect<Prompt.Prompt> => historyOf(unwrap(session))

export const status = (session: AgentSession<any, any>): Effect.Effect<Status> =>
  statusOf(unwrap(session))

/**
 * A session's conversation, as a value.
 *
 * Schema-defined, so it crosses a process boundary the same way anything else
 * in this library does: written to a database, sent over RPC, kept as a
 * fixture.
 *
 * Deliberately only the conversation. A session also holds a scope, a fibre, an
 * event bus, queued input and a captured environment — none of which are data,
 * and all of which belong to the process that created them. A snapshot is what
 * survives; the rest is rebuilt by `restore`.
 */
export const Snapshot = Schema.Struct({
  sessionId: Schema.String,
  history: Prompt.Prompt
})
export type Snapshot = typeof Snapshot.Type

/**
 * Capture a session's conversation.
 *
 * Idle only. A running session's history is mid-flight — a turn may be about
 * to commit an assistant message and its tool results as one unit — and a
 * snapshot taken between those would record a conversation that never existed.
 * Waiting for quiescence is the caller's job, and refusing is how they find
 * out they have not.
 */
export const snapshot = Effect.fn("AgentSession.snapshot")(function* (
  session: AgentSession<any, any>
) {
    const self = unwrap(session)
    const current = yield* SubscriptionRef.get(self.state)
    if (current.status === "closed") {
      return yield* new AgentClosedError({ sessionId: self.id })
    }
    if (current.status !== "idle") {
      return yield* new AgentBusyError({ sessionId: self.id })
    }
    return {
      sessionId: self.id,
      history: yield* historyOf(self)
    } satisfies Snapshot
  })

/**
 * Rebuild a session from a snapshot.
 *
 * The session resumes its identity along with its conversation, so logging,
 * tracing and durable correlation still point at the same thing after a
 * restart.
 *
 * Everything else is new: a new scope, a new event bus, empty input queues.
 * A restored session has no history of *events* — those described the original
 * run, which is over. What it has is the transcript, which is what the next
 * turn is derived from.
 */
export const restore = <Tools extends Record<string, Tool.Any>, E, R>(
  agent: AgentDefinition<Tools, E, R>,
  snapshot: Snapshot,
  options?: Omit<MakeOptions, "sessionId" | "history">
): Effect.Effect<
  AgentSession<Tools, E>,
  never,
  Scope.Scope | LanguageModel.LanguageModel | R
> =>
  make(agent, {
    ...options,
    sessionId: snapshot.sessionId,
    history: snapshot.history
  })

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

export const state = (session: AgentSession<any, any>): StateView =>
  stateOf(unwrap(session))

/**
 * The live event stream.
 *
 * Observational only. It is not a durability guarantee: a subscriber that
 * cannot tolerate loss belongs to a future store observing commits.
 */
export const events = (
  session: AgentSession<any, any>
): Stream.Stream<AgentEventEnvelope> => eventsOf(unwrap(session))
