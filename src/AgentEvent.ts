import { Cause, Schema } from "effect"
import { RunId, SessionId, SubmissionId } from "./internal/ids.js"

export { RunId, SessionId, SubmissionId }

/**
 * A failure, as it appears in the observation contract.
 *
 * Events carry this rather than a `Cause`. v4 has no `Schema.Cause` codec, but
 * that constraint only forced the question — the answer stands on its own
 * merits. Events are the *serializable* record of what happened, and a `Cause`
 * is an in-process value carrying fibers and arbitrary defect payloads that no
 * wire format should try to reproduce.
 *
 * The full `Cause` stays available where it can be acted on: the typed error
 * channel of `prompt`. This is the lossy projection, and it says so.
 */
export const Failure = Schema.Struct({
  /** The error's `_tag` when it has one; otherwise a generic label. */
  tag: Schema.String,
  message: Schema.String,
  /** A defect is a bug; a non-defect is an anticipated failure. */
  isDefect: Schema.Boolean
})
export type Failure = typeof Failure.Type

const describe = (error: unknown): { tag: string; message: string } => {
  if (typeof error === "object" && error !== null) {
    const tagged = error as { _tag?: unknown; message?: unknown }
    const tag = typeof tagged._tag === "string" ? tagged._tag : "Error"
    const message =
      typeof tagged.message === "string" ? tagged.message : String(error)
    return { tag, message }
  }
  return { tag: "Error", message: String(error) }
}

/** Project a `Cause` onto the wire-safe summary above. */
export const failureFromCause = (cause: Cause.Cause<unknown>): Failure => {
  const error = Cause.findErrorOption(cause)
  if (error._tag === "Some") {
    return { ...describe(error.value), isDefect: false }
  }
  const defect = Cause.findDefect(cause)
  return {
    ...describe(defect._tag === "Success" ? defect.success : cause),
    isDefect: true
  }
}

export const SessionStarted = Schema.TaggedStruct("SessionStarted", {})
export const SessionClosed = Schema.TaggedStruct("SessionClosed", {})

/**
 * A submission is the externally observed unit of work: the initial prompt plus
 * every follow-up queued before the session reaches quiescence.
 */
export const SubmissionStarted = Schema.TaggedStruct("SubmissionStarted", {})
export const SubmissionCompleted = Schema.TaggedStruct("SubmissionCompleted", {
  runs: Schema.Number
})
export const SubmissionFailed = Schema.TaggedStruct("SubmissionFailed", {
  failure: Failure
})
export const SubmissionInterrupted = Schema.TaggedStruct(
  "SubmissionInterrupted",
  {}
)

export const RunStarted = Schema.TaggedStruct("RunStarted", {})
export const RunCompleted = Schema.TaggedStruct("RunCompleted", {
  turns: Schema.Number
})
export const RunFailed = Schema.TaggedStruct("RunFailed", {
  failure: Failure
})
export const RunInterrupted = Schema.TaggedStruct("RunInterrupted", {})

export const TurnStarted = Schema.TaggedStruct("TurnStarted", {})
export const TurnCompleted = Schema.TaggedStruct("TurnCompleted", {})

export const MessageCompleted = Schema.TaggedStruct("MessageCompleted", {
  text: Schema.String
})

export const ToolCallStarted = Schema.TaggedStruct("ToolCallStarted", {
  id: Schema.String,
  name: Schema.String,
  params: Schema.Unknown
})
export const ToolCallSucceeded = Schema.TaggedStruct("ToolCallSucceeded", {
  id: Schema.String,
  name: Schema.String,
  result: Schema.Unknown
})
export const ToolCallFailed = Schema.TaggedStruct("ToolCallFailed", {
  id: Schema.String,
  name: Schema.String,
  failure: Failure,
  /**
   * Whether the failure was handed back to the model as a tool result rather
   * than failing the run. See `ToolExecution.FailurePolicy`.
   */
  returnedToModel: Schema.Boolean
})
/**
 * Emitted when a tool call the harness started is interrupted.
 *
 * A run-level failure alone would leave a consumer showing a tool as still
 * running: every started call owes a correlated terminal event.
 */
export const ToolCallInterrupted = Schema.TaggedStruct("ToolCallInterrupted", {
  id: Schema.String,
  name: Schema.String
})

/** Emitted when `steer` is accepted onto the queue. */
export const SteeringQueued = Schema.TaggedStruct("SteeringQueued", {})
/** Emitted when queued steering is committed to canonical history. */
export const SteeringApplied = Schema.TaggedStruct("SteeringApplied", {
  count: Schema.Number
})

export const FollowUpQueued = Schema.TaggedStruct("FollowUpQueued", {})
/** Emitted when a queued follow-up becomes the input of the next run. */
export const FollowUpApplied = Schema.TaggedStruct("FollowUpApplied", {})

/**
 * The observable transitions of agent execution.
 *
 * Every meaningful boundary produces exactly one event, so that consumers —
 * logging, UI, telemetry, tests, a remote subscriber — never need a second
 * observation channel.
 */
export const AgentEvent = Schema.Union([
  SessionStarted,
  SessionClosed,
  SubmissionStarted,
  SubmissionCompleted,
  SubmissionFailed,
  SubmissionInterrupted,
  RunStarted,
  RunCompleted,
  RunFailed,
  RunInterrupted,
  TurnStarted,
  TurnCompleted,
  MessageCompleted,
  ToolCallStarted,
  ToolCallSucceeded,
  ToolCallFailed,
  ToolCallInterrupted,
  SteeringQueued,
  SteeringApplied,
  FollowUpQueued,
  FollowUpApplied
])
export type AgentEvent = typeof AgentEvent.Type

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
 * anything that cannot tolerate loss belongs to a store that observes commits.
 * The envelope is Schema-defined so a remote subscriber or a store can decode
 * it — not because the live stream became durable.
 */
export const AgentEventEnvelope = Schema.Struct({
  sessionId: SessionId,
  /** Absent on session-level events, which belong to no submission. */
  submissionId: Schema.Option(SubmissionId),
  runId: Schema.Option(RunId),
  turn: Schema.Option(Schema.Number),
  sequence: Schema.Number,
  event: AgentEvent
})
export type AgentEventEnvelope = typeof AgentEventEnvelope.Type

/** Narrow an envelope to a specific event tag. */
export const is =
  <Tag extends AgentEvent["_tag"]>(tag: Tag) =>
  (
    envelope: AgentEventEnvelope
  ): envelope is AgentEventEnvelope & {
    readonly event: Extract<AgentEvent, { readonly _tag: Tag }>
  } =>
    envelope.event._tag === tag
