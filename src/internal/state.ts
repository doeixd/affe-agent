import type { Context, Effect, Fiber, Option, Ref, Scope, Semaphore, SubscriptionRef } from "effect"
import type { Prompt, Tool } from "effect/unstable/ai"
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
  readonly activeRunId: Option.Option<RunId>
  readonly turn: number
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
  readonly agent: AgentDefinition<Tools, E, R>
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
  readonly activeFiber: Ref.Ref<Option.Option<Fiber.Fiber<any, any>>>
  readonly scope: Scope.Scope
  /**
   * The environment captured when the session was constructed, so that the
   * session handle carries no residual requirements and a child session can be
   * built under an entirely different model layer.
   */
  readonly env: Context.Context<any>
  readonly ids: IdSource
}
