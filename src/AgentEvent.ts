import { Cause, Effect, Schema } from "effect"
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

/**
 * Render an error's own fields, for when it has nothing better to say.
 *
 * `Schema.TaggedError` subclasses inherit `Error`'s empty `message` unless the
 * author overrides it, so the obvious projection — read `.message` — throws
 * away everything specific about the failure and leaves a bare tag. That is the
 * common case, not an edge one: most tagged errors carry their detail in named
 * fields.
 */
const fields = (error: object): string => {
  const own = Object.entries(error).filter(
    ([key, value]) =>
      key !== "_tag" && key !== "message" && key !== "stack" && value !== undefined
  )
  if (own.length === 0) return ""
  try {
    return own
      .map(([key, value]) =>
        `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`
      )
      .join(", ")
  } catch {
    // A field held something uncloneable. A partial description still beats
    // failing to describe the failure at all.
    return own.map(([key]) => key).join(", ")
  }
}

const describe = (error: unknown): { tag: string; message: string } => {
  if (typeof error === "object" && error !== null) {
    const tagged = error as { _tag?: unknown; message?: unknown }
    const tag = typeof tagged._tag === "string" ? tagged._tag : "Error"
    const stated =
      typeof tagged.message === "string" && tagged.message.length > 0
        ? tagged.message
        : ""
    if (stated.length > 0) return { tag, message: stated }
    const described = fields(error)
    return { tag, message: described.length > 0 ? described : String(error) }
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

/**
 * The model has begun producing a message, and deltas will follow.
 *
 * Streaming output is **observational**. These four events report generation
 * as it happens; canonical history is still committed atomically at the end of
 * the turn, after tools have run. A consumer renders deltas, and the
 * transcript is unaffected by whether it did.
 */
export const MessageStarted = Schema.TaggedStruct("MessageStarted", {})

/**
 * A chunk of model output.
 *
 * Normalised to one shape rather than exposing the provider's stream protocol:
 * a consumer that renders text and reasoning should not have to track chunk
 * ids, start and end markers, or the differences between providers.
 */
export const MessageDelta = Schema.TaggedStruct("MessageDelta", {
  kind: Schema.Literals(["text", "reasoning"]),
  delta: Schema.String
})

/** The model finished producing its message. Tools have not run yet. */
export const MessageStreamCompleted = Schema.TaggedStruct(
  "MessageStreamCompleted",
  {}
)

/**
 * Generation was interrupted part-way.
 *
 * Every `MessageStarted` owes a terminal event, or a consumer is left showing
 * a message that never resolves. Canonical history contains no partial
 * assistant message from this turn.
 */
export const MessageInterrupted = Schema.TaggedStruct("MessageInterrupted", {})

/**
 * Generation failed part-way.
 *
 * The other way an opened message can end. Interruption and failure are
 * separate events for the same reason `ToolCallInterrupted` and
 * `ToolCallFailed` are: one is the run going away, the other is something
 * going wrong, and a consumer generally wants to show them differently.
 *
 * As with interruption, canonical history contains no partial assistant
 * message from this turn.
 */
export const MessageFailed = Schema.TaggedStruct("MessageFailed", {
  failure: Failure
})

/**
 * The run has paused, needing an answer from outside.
 *
 * A pause, not a failure: the run resumes when answered. Every request owes a
 * matching `ElicitationResolved`, or a consumer is left showing a question
 * that never closes.
 */
export const ElicitationRequested = Schema.TaggedStruct(
  "ElicitationRequested",
  { id: Schema.String, kind: Schema.String, detail: Schema.Unknown }
)

/** The answer arrived, and the run continued. */
export const ElicitationResolved = Schema.TaggedStruct("ElicitationResolved", {
  id: Schema.String,
  kind: Schema.String,
  granted: Schema.Boolean
})

export const ToolCallStarted = Schema.TaggedStruct("ToolCallStarted", {
  id: Schema.String,
  name: Schema.String,
  params: Schema.Unknown
})
/**
 * A preliminary result from a tool that is still running.
 *
 * `Toolkit.handle` returns a `Stream`, and a handler may emit intermediate
 * results before its final one — progress from a shell command, a browser step,
 * a long remote call. Those were previously collected and discarded, so a
 * long-running tool was invisible until it finished.
 *
 * Progress is **observational**. Only the tool's final result is committed to
 * canonical history, so a consumer may render these freely without them
 * becoming part of the conversation. For tools running in parallel, progress
 * arrives in real completion order while canonical results are still committed
 * in model call order.
 */
export const ToolCallProgress = Schema.TaggedStruct("ToolCallProgress", {
  id: Schema.String,
  name: Schema.String,
  /** Decoded, as `ToolCallSucceeded.result` is. */
  result: Schema.Unknown,
  /** JSON, as `ToolCallSucceeded.encodedResult` is. */
  encodedResult: Schema.Unknown
})
export const ToolCallSucceeded = Schema.TaggedStruct("ToolCallSucceeded", {
  id: Schema.String,
  name: Schema.String,
  /**
   * The handler's result, decoded.
   *
   * `Schema.Unknown` at the type level, and genuinely arbitrary at runtime: a
   * tool whose success schema transforms produces a `Date`, a class instance, a
   * branded value. Useful in-process, where the consumer knows the toolkit.
   */
  result: Schema.Unknown,
  /**
   * The same result, as it goes to the model.
   *
   * Being Schema-defined is not the same as having a stable wire
   * representation, and `Unknown` holding a decoded value is exactly where the
   * two come apart: encoding an envelope containing a `Date` produces whatever
   * `JSON.stringify` decides, silently and irreversibly. Anything projecting
   * events onto a wire wants this field, which is already JSON by construction
   * because the model receives it.
   */
  encodedResult: Schema.Unknown
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
  MessageStarted,
  MessageDelta,
  MessageStreamCompleted,
  MessageInterrupted,
  MessageFailed,
  ElicitationRequested,
  ElicitationResolved,
  ToolCallStarted,
  ToolCallProgress,
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

/**
 * Exhaustively handle an event by tag.
 *
 * Every consumer of the stream — a UI, a logger, a persistence adapter — starts
 * by switching on `_tag`, and a hand-written switch silently stops covering new
 * events as the ADT grows. This makes that a type error instead.
 *
 * Handlers receive the event payload and the envelope, since correlation is
 * usually needed alongside the event itself.
 *
 * ```ts
 * Stream.runForEach(
 *   AgentSession.events(session),
 *   AgentEvent.match({
 *     ToolCallStarted: (event) => Effect.log(`tool ${event.name}`),
 *     orElse: () => Effect.void
 *   })
 * )
 * ```
 */
export const match =
  <A, E = never, R = never>(handlers: {
    readonly [Tag in AgentEvent["_tag"]]?: (
      event: Extract<AgentEvent, { readonly _tag: Tag }>,
      envelope: AgentEventEnvelope
    ) => Effect.Effect<A, E, R>
  } & {
    /** Runs for any event without its own handler. */
    readonly orElse: (
      event: AgentEvent,
      envelope: AgentEventEnvelope
    ) => Effect.Effect<A, E, R>
  }) =>
  (envelope: AgentEventEnvelope): Effect.Effect<A, E, R> => {
    const handler = handlers[envelope.event._tag]
    return handler === undefined
      ? handlers.orElse(envelope.event, envelope)
      : (handler as (
          event: AgentEvent,
          envelope: AgentEventEnvelope
        ) => Effect.Effect<A, E, R>)(envelope.event, envelope)
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

/**
 * Project an envelope onto values safe for a wire representation.
 *
 * `ToolCallSucceeded.result` and `ToolCallProgress.result` are decoded values:
 * a `Date`, a class instance, a branded value — useful in-process, and
 * irreversibly mangled by `JSON.stringify`. Their `encodedResult` twins are
 * JSON by construction, because the model receives them. Anything recording
 * or transmitting events — a delivery log, an SSE adapter — wants `result` to
 * *be* the encoded form, and this is the one place that substitution is made,
 * so no adapter re-derives it.
 *
 * Every other event already carries only Schema-encodable data.
 */
export const toWire = (envelope: AgentEventEnvelope): AgentEventEnvelope => {
  const event = envelope.event
  switch (event._tag) {
    case "ToolCallSucceeded":
    case "ToolCallProgress":
      return {
        ...envelope,
        event: { ...event, result: event.encodedResult }
      }
    default:
      return envelope
  }
}
