import type { Cause, Option } from "effect"
import type { RunId, SessionId, SubmissionId } from "./internal/ids.js"

export type { RunId, SessionId, SubmissionId }

/**
 * The observable transitions of agent execution.
 *
 * Every meaningful boundary produces exactly one event, so that consumers —
 * logging, UI, telemetry, tests — never need a second observation channel.
 */
export type AgentEvent =
  | SessionStarted
  | SessionClosed
  | SubmissionStarted
  | SubmissionCompleted
  | SubmissionFailed
  | SubmissionInterrupted
  | RunStarted
  | RunCompleted
  | RunFailed
  | RunInterrupted
  | TurnStarted
  | TurnCompleted
  | MessageCompleted
  | ToolCallStarted
  | ToolCallSucceeded
  | ToolCallFailed
  | ToolCallInterrupted
  | SteeringQueued
  | SteeringApplied
  | FollowUpQueued
  | FollowUpApplied

export interface SessionStarted {
  readonly _tag: "SessionStarted"
}

export interface SessionClosed {
  readonly _tag: "SessionClosed"
}

/**
 * A submission is the externally observed unit of work: the initial prompt plus
 * every follow-up queued before the session reaches quiescence. It is event
 * vocabulary only — never an exported noun.
 */
export interface SubmissionStarted {
  readonly _tag: "SubmissionStarted"
}

export interface SubmissionCompleted {
  readonly _tag: "SubmissionCompleted"
  readonly runs: number
}

export interface SubmissionFailed {
  readonly _tag: "SubmissionFailed"
  readonly cause: Cause.Cause<unknown>
}

export interface SubmissionInterrupted {
  readonly _tag: "SubmissionInterrupted"
}

export interface RunStarted {
  readonly _tag: "RunStarted"
}

export interface RunCompleted {
  readonly _tag: "RunCompleted"
  readonly turns: number
}

export interface RunFailed {
  readonly _tag: "RunFailed"
  readonly cause: Cause.Cause<unknown>
}

export interface RunInterrupted {
  readonly _tag: "RunInterrupted"
}

export interface TurnStarted {
  readonly _tag: "TurnStarted"
}

export interface TurnCompleted {
  readonly _tag: "TurnCompleted"
}

export interface MessageCompleted {
  readonly _tag: "MessageCompleted"
  readonly text: string
}

export interface ToolCallStarted {
  readonly _tag: "ToolCallStarted"
  readonly id: string
  readonly name: string
  readonly params: unknown
}

export interface ToolCallSucceeded {
  readonly _tag: "ToolCallSucceeded"
  readonly id: string
  readonly name: string
  readonly result: unknown
}

export interface ToolCallFailed {
  readonly _tag: "ToolCallFailed"
  readonly id: string
  readonly name: string
  readonly cause: Cause.Cause<unknown>
  /**
   * Whether the failure was handed back to the model as a tool result rather
   * than failing the run. See `ToolExecution.FailurePolicy`.
   */
  readonly returnedToModel: boolean
}

/**
 * Emitted when a tool call the harness started is interrupted.
 *
 * A run-level failure alone would leave a consumer showing a tool as still
 * running: every started call owes a correlated terminal event.
 */
export interface ToolCallInterrupted {
  readonly _tag: "ToolCallInterrupted"
  readonly id: string
  readonly name: string
}

/** Emitted when `steer` is accepted onto the queue. */
export interface SteeringQueued {
  readonly _tag: "SteeringQueued"
}

/** Emitted when queued steering is committed to canonical history. */
export interface SteeringApplied {
  readonly _tag: "SteeringApplied"
  readonly count: number
}

export interface FollowUpQueued {
  readonly _tag: "FollowUpQueued"
}

/** Emitted when a queued follow-up becomes the input of the next run. */
export interface FollowUpApplied {
  readonly _tag: "FollowUpApplied"
}

/**
 * Identifies the execution position an event belongs to.
 *
 * An options record supplied by the emitting code, not a domain value — hence
 * optional properties rather than `Option`, matching how Effect's own APIs
 * express arguments that may be omitted.
 */
export interface Correlation {
  readonly submissionId?: SubmissionId | undefined
  readonly runId?: RunId | undefined
  readonly turn?: number | undefined
}

/**
 * Correlation envelope carried by every event.
 *
 * `sequence` is a per-session monotonically increasing counter, so consumers can
 * establish a total order and detect gaps rather than trusting delivery order.
 *
 * The live stream is observational. It is deliberately not a durable journal:
 * anything that cannot tolerate loss belongs to a future store that observes
 * commits, not to an arbitrary PubSub subscriber.
 */
export interface AgentEventEnvelope {
  readonly sessionId: SessionId
  /** Absent on session-level events, which belong to no submission. */
  readonly submissionId: Option.Option<SubmissionId>
  readonly runId: Option.Option<RunId>
  readonly turn: Option.Option<number>
  readonly sequence: number
  readonly event: AgentEvent
}

/** Narrow an envelope to a specific event tag. */
export const is =
  <Tag extends AgentEvent["_tag"]>(tag: Tag) =>
  (
    envelope: AgentEventEnvelope
  ): envelope is AgentEventEnvelope & {
    readonly event: Extract<AgentEvent, { readonly _tag: Tag }>
  } =>
    envelope.event._tag === tag
