import type { Context, Fiber, Option, Ref, Scope, SubscriptionRef } from "effect"
import type { Prompt, Tool } from "effect/unstable/ai"
import type { AgentDefinition } from "../Agent.js"
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
  readonly activeRunId: Option.Option<RunId>
  readonly turn: number
  /** Canonical conversation history; see `internal/history.ts`. */
  readonly history: Prompt.Prompt
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
  readonly bus: EventBus
  /** Out-of-band input; substitutable so a durable runtime can record it. */
  readonly steering: InputChannel
  readonly followUps: InputChannel
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
