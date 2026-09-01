import type { Context, Effect, Fiber, Option, Ref, Scope, Semaphore, SubscriptionRef } from "effect"
import type { LanguageModel, Prompt, Tool } from "effect/unstable/ai"
import type { AgentDefinition } from "../Agent.js"
import type { Elicitor } from "../Elicitation.js"
import type { InputChannel } from "../InputChannel.js"
import type { EventBus } from "./eventBus.js"
import type { IdSource, RunId, SessionId, SubmissionId } from "./ids.js"

export type Status = "idle" | "running" | "closed"

/**
 * Runtime state of the harness itself.
 *
 * This describes the harness, not the application. Application state belongs in
 * ordinary Effect services, so that the harness never becomes a competing
 * state-management system.
 */
export interface SessionState {
  readonly status: Status
  /**
   * Submissions started so far.
   *
   * Held in state rather than in a separate counter so that claiming an idle
   * session and allocating its submission id are one atomic transition.
   */
  readonly submissionCount: number
  readonly activeSubmissionId: Option.Option<SubmissionId>
  /**
   * Whether the active submission will still take follow-ups.
   *
   * Distinct from `status`, because the submission closes its own input a
   * moment before the session becomes idle. Without that gap being explicit, a
   * `followUp` can be accepted after the submission has already decided it is
   * finished, and then discarded — the caller is told it was queued and it
   * never runs.
   */
  readonly acceptingFollowUps: boolean
  /** Whether the active run can still incorporate steering at a turn boundary. */
  readonly acceptingSteering: boolean
  readonly activeRunId: Option.Option<RunId>
  readonly turn: number
}

/**
 * Progress of the active submission, accumulated as it runs so that an
 * *interrupted* submission can still report the work that actually landed.
 *
 * Turns commit atomically, so this is updated once per committed turn (never for
 * the partially-executed turn an interrupt rolls back) and once per run start.
 * When a submission completes normally the caller gets these same figures from
 * the run loop's return; the point of holding them here is the interrupt path,
 * where there is no return value to read.
 */
export interface SubmissionProgress<
  Tools extends Record<string, Tool.Any> = Record<string, Tool.Any>
> {
  readonly runs: number
  readonly turns: number
  readonly text: string
  readonly response: Option.Option<LanguageModel.GenerateTextResponse<Tools, true>>
  /**
   * The value the model reported through the agent's output tool, if it has
   * one and has called it. See `AgentOutput`.
   *
   * Here rather than in a ref of its own for the same reason the rest of this
   * lives here: an interrupted submission must still be able to report it. A
   * value is committed the moment its tool call succeeds, so an interrupt
   * landing during a later turn does not lose an answer that was already
   * given.
   *
   * `unknown` because the session's value type is a type-level fact
   * (`AgentDefinition`'s `Value`), and this internal record is shared by every
   * agent regardless. `AgentSession` restores the type at the boundary.
   */
  readonly value: Option.Option<unknown>
}

/**
 * The internal session value threaded through turn, run and submission
 * execution. Not exported from the package.
 */
export interface Session<
  Tools extends Record<string, Tool.Any> = Record<string, Tool.Any>,
  E = any,
  R = any
> {
  readonly id: SessionId
  /**
   * `Value` is `any` here on purpose: the engine reads `agent.output` to
   * decide whether to inject the output tool, and never needs the value's
   * type. Naming it would push a fifth parameter through every internal
   * signature to say nothing the engine uses -- `AgentSession` is where the
   * type is restored, at the boundary that hands it to a caller.
   */
  readonly agent: AgentDefinition<Tools, E, R, any, any>
  readonly state: SubscriptionRef.SubscriptionRef<SessionState>
  /**
   * Canonical history, held apart from the observable runtime state.
   *
   * Both are session-owned, but they change for different reasons and are read
   * by different people. Every commit appends to an ever-growing `Prompt`; if
   * that lived in the `SubscriptionRef`, a UI subscribed for status and turn
   * progress would receive the entire transcript on every turn. A plain `Ref`
   * keeps history out of the notification path, and `AgentSession.history`
   * stays the way to read it.
   */
  readonly history: Ref.Ref<Prompt.Prompt>
  /**
   * Live progress of the active submission, updated per committed turn. Read on
   * the interrupt path to report what landed before the interrupt; reset by
   * `AgentSubmission` when a new submission begins.
   */
  readonly progress: Ref.Ref<SubmissionProgress<Tools>>
  /**
   * Where the output tool's handler puts the value it decoded, until the turn
   * that produced it commits.
   *
   * Staged rather than written straight to `progress`, because a tool handler
   * runs *before* the turn's atomic commit. A run interrupted between a
   * successful call and that commit rolls the turn back -- the assistant
   * message and the tool result never enter history -- and a value promoted
   * eagerly would then be reported as this submission's answer while nothing
   * in the transcript says the model ever gave one. `text` and `response`
   * have always been recorded at the commit for the same reason; this follows
   * them rather than inventing a second rule.
   */
  readonly pendingOutput: Ref.Ref<Option.Option<unknown>>
  readonly bus: EventBus
  /** Out-of-band input; substitutable so a durable runtime can record it. */
  readonly steering: InputChannel
  readonly followUps: InputChannel
  /** Where a paused run waits for an answer. See `Elicitation`. */
  readonly elicitation: Elicitor
  /**
   * Publishes whether the session is accepting out-of-band input, for callers
   * in another process. See `InputChannel.Factory.setAdmitting`.
   */
  readonly admit: (sessionId: string, admitting: boolean) => Effect.Effect<void>
  /** Publishes the active run's narrower steering-admission gate. */
  readonly admitSteering: (
    sessionId: string,
    admitting: boolean
  ) => Effect.Effect<void>
  /**
   * Serialises admission against a submission's closing drain.
   *
   * `followUp` checks `acceptingFollowUps` and offers to the queue as two
   * steps; the submission closes that gate and performs its last drain as two
   * more. Without a shared lock, a follow-up that read an open gate could
   * offer *after* the closing drain had already looked — accepted by the
   * caller, then discarded by `AgentSession.release`. Holding this permit
   * across check-and-offer in `AgentSession.followUp`, and across the closing
   * drain in `AgentSubmission.execute`, makes those pairs mutually exclusive:
   * anything offered while the gate read open is drained before the close
   * concludes, and anything offered after is refused outright.
   */
  readonly inputGate: Semaphore.Semaphore
  /**
   * Internal seam run once per run, in the window between the first follow-up
   * drain and the close decision (see `AgentSession.EngineOptions.beforeClose`).
   * Defaults to `Effect.void`.
   */
  readonly beforeClose: Effect.Effect<void>
  /**
   * The running submission's fibre, *with the submission it belongs to*.
   *
   * Paired rather than bare, because `interrupt` has to know that the fibre it
   * is about to cancel is the one it validated. A session-wide `Fiber` alone
   * cannot say: read it after the validated submission released and its
   * successor registered, and the cancellation lands on a submission the
   * caller never addressed. One `Ref` read answers both questions at once,
   * which is what makes the check atomic without a lock.
   */
  readonly activeFiber: Ref.Ref<
    Option.Option<{
      readonly submissionId: SubmissionId
      readonly fiber: Fiber.Fiber<any, any>
    }>
  >
  /**
   * The most recently settled submission's fibre, kept until the next one
   * starts.
   *
   * A session runs one submission at a time, so "the last one" is
   * well-defined, and it is what makes `awaitSubmission` safe to call after
   * `submit` returned: a fast run can settle before a waiter attaches, and
   * without this the waiter would find nothing to join. One entry, never
   * more -- retention beyond that is the client boundary's, where it can be
   * bounded and stated.
   */
  readonly settledFiber: Ref.Ref<
    Option.Option<{
      readonly submissionId: SubmissionId
      readonly fiber: Fiber.Fiber<any, any>
      /**
       * Its progress as it landed. `progress` itself is zeroed when the next
       * submission starts, and an interrupted outcome is built from it -- so
       * a waiter joining this entry after that would otherwise read the new
       * submission's counts.
       */
      readonly progress: SubmissionProgress<any>
    }>
  >
  readonly scope: Scope.Scope
  /**
   * The environment captured when the session was constructed, so that the
   * session handle carries no residual requirements and a child session can be
   * built under an entirely different model layer.
   */
  readonly env: Context.Context<any>
  readonly ids: IdSource
  /** How the n-th submission is named. See `AgentSession.EngineOptions.submissionIds`. */
  readonly submissionName: (count: number) => string
}
