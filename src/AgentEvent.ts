import { Cause, Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
import { Response } from "effect/unstable/ai"
import { RunId, SessionId, SubmissionId } from "./internal/ids.js"
import * as PromptWire from "./PromptWire.js"

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
  // `Object.entries` runs every enumerable getter, and a Proxy can throw from
  // enumeration itself -- so even listing the keys is a call into code this
  // module does not own.
  let own: Array<[string, unknown]>
  try {
    own = Object.entries(error).filter(
      ([key, value]) =>
        key !== "_tag" && key !== "message" && key !== "stack" && value !== undefined
    )
  } catch {
    return ""
  }
  if (own.length === 0) return ""
  try {
    return own
      .map(([key, value]) =>
        `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`
      )
      .join(", ")
  } catch {
    // A field held something uncloneable, or a `bigint`, which `JSON.stringify`
    // throws on. A partial description still beats failing to describe the
    // failure at all.
    try {
      return own.map(([key]) => key).join(", ")
    } catch {
      return ""
    }
  }
}

/**
 * `String(value)`, for a value that may not want to be one.
 *
 * `String` calls `toString`/`Symbol.toPrimitive`, which is arbitrary code, and
 * a `Symbol` throws outright. Everywhere this module coerces, it is coercing
 * something a tool, a model provider, a storage adapter or a user-defined
 * error handed over -- none of which is required to be well behaved.
 */
const text = (value: unknown): string => {
  try {
    return typeof value === "symbol" ? value.toString() : String(value)
  } catch {
    return "<unprintable>"
  }
}

/**
 * Describe a failure, whatever it is.
 *
 * Total by construction, and it has to be: this projection is what turns a
 * failure into the *terminal event*, and a terminal event is what durability
 * and every UI use to stop waiting. A projection that throws replaces the
 * original failure with its own and the terminal event is never published --
 * so the run that failed looks, to everything downstream, like a run still
 * going.
 *
 * Every boundary below is a call into code this module does not own: reading
 * `_tag` and `message` runs getters, enumerating fields runs more of them, and
 * coercing to text runs `toString`. Each is guarded separately, so one hostile
 * member costs its own detail and not the description.
 */
const describe = (error: unknown): { tag: string; message: string } => {
  if (typeof error === "object" && error !== null) {
    let tag = "Error"
    let stated = ""
    try {
      const tagged = error as { _tag?: unknown; message?: unknown }
      if (typeof tagged._tag === "string") tag = tagged._tag
      if (typeof tagged.message === "string") stated = tagged.message
    } catch {
      // A throwing getter on `_tag` or `message`. The tag stays "Error" and
      // the description falls through to the fields.
    }
    if (stated.length > 0) return { tag, message: stated }
    const described = fields(error)
    return { tag, message: described.length > 0 ? described : text(error) }
  }
  return { tag: "Error", message: text(error) }
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
  turns: Schema.Number,
  /**
   * The reason the loop gave for stopping, when it gave one (`AgentLoop.stop`
   * / `final` with a reason; `maxTurns`, `maxToolCalls`, `maxDuration` and
   * `Budget.within` name theirs). Optional so a journal or consumer written
   * before it existed still decodes.
   */
  stopReason: Schema.optional(Schema.String)
})
export const RunFailed = Schema.TaggedStruct("RunFailed", {
  failure: Failure
})
export const RunInterrupted = Schema.TaggedStruct("RunInterrupted", {})

export const TurnStarted = Schema.TaggedStruct("TurnStarted", {})
export const TurnCompleted = Schema.TaggedStruct("TurnCompleted", {})

/** Provider-neutral token totals for one successful model call. */
export const ModelUsage = Schema.Struct({
  inputTokens: Schema.Natural,
  outputTokens: Schema.Natural,
  totalTokens: Schema.Natural
})
export type ModelUsage = typeof ModelUsage.Type

/**
 * The provider returned successfully. Tools named by the response have not run
 * yet, so this event is retained even if later work in the turn fails.
 *
 * Effect AI normalises finish reasons to `Response.FinishReason` and represents
 * an unreported reason as `"unknown"`. Providers may omit either token total;
 * those totals are normalised to zero here, as `Budget` already does when it
 * accounts for a response.
 */
export const ModelCallCompleted = Schema.TaggedStruct("ModelCallCompleted", {
  usage: ModelUsage,
  finishReason: Response.FinishReason
})

/**
 * The model's message content: text, reasoning and files, in order.
 *
 * Provider-neutral prompt parts through the wire codec, not the provider's
 * response parts -- the same decision `RemoteResult` made. A consumer
 * switches on `part.type` and gets a real `Prompt.FilePart`, bytes and all.
 */
export const MessageContent = Schema.Array(PromptWire.Part)
export type MessageContent = typeof MessageContent.Type

/**
 * The model's message, as committed.
 *
 * `text` is the joined text, as it always was. `content` is the whole message
 * -- a model that returned an image alongside its sentence used to report
 * only the sentence here, and a consumer had to read history to learn there
 * was an image. Optional on the wire, so a build that predates it still
 * decodes this event, and a build that has it still decodes a stream from
 * one that does not.
 */
export const MessageCompleted = Schema.TaggedStruct("MessageCompleted", {
  text: Schema.String,
  content: Schema.optional(MessageContent)
})

/**
 * A part that arrived whole while the message was streaming.
 *
 * Text and reasoning stream as `MessageDelta`s; a file does not stream -- a
 * provider emits it complete -- and inventing deltas for it would be a lie
 * about what happened. So it is announced once, as the part it is, and is
 * also in the `MessageCompleted` that follows. Only emitted under
 * `stream: true`.
 */
export const MessagePartCompleted = Schema.TaggedStruct("MessagePartCompleted", {
  part: PromptWire.Part
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
  ModelCallCompleted,
  MessageCompleted,
  MessageStarted,
  MessageDelta,
  MessagePartCompleted,
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
 * An event this build does not know.
 *
 * The stream crosses a process boundary, and the two ends are not always the
 * same build: `AgentServer` and the relay exist so a client and a server can be
 * deployed independently. A strict union makes every event addition a breaking
 * wire change -- adding `ModelCallCompleted` meant an older client failed to
 * decode the stream the first time a model call completed, which is every turn.
 *
 * Nothing here is invented: the tag and the raw payload are carried through
 * exactly as they arrived, so a consumer can log or forward it, and a build
 * that *does* know the tag can decode it properly. What it removes is the
 * decode failure, which is the part an older client cannot do anything about.
 *
 * This is deliberately not a version number. A version says "refuse the whole
 * stream"; the useful behaviour for an observational stream is to keep the
 * events you understand and skip the ones you do not, which is what every
 * projection already does -- `AgentAgUi` covers a subset of tags and ignores
 * the rest with no ill effect.
 */
export const UnknownEvent = Schema.TaggedStruct("UnknownEvent", {
  /** The tag as it arrived, so a consumer can recognise it by name. */
  originalTag: Schema.String,
  /** The event's fields, undecoded. */
  payload: Schema.Unknown
})
export type UnknownEvent = typeof UnknownEvent.Type

/**
 * What a consumer of the *stream* sees: a known event, or one from a newer
 * peer.
 *
 * `AgentEvent` remains the closed union this build emits. The distinction
 * matters at exactly one place -- reading the wire -- and naming it keeps every
 * producer exhaustive while letting consumers stay tolerant.
 */
export type StreamedEvent = AgentEvent | UnknownEvent

const decodeKnownEvent = Schema.decodeUnknownEffect(AgentEvent)
const encodeKnownEvent = Schema.encodeUnknownEffect(AgentEvent)

/**
 * The tags this build has, read off the union rather than restated, so a new
 * event cannot be added above and forgotten here.
 */
const knownTags: ReadonlySet<string> = new Set(
  AgentEvent.members.map((member) => String(member.fields._tag.ast.literal))
)

const tagOf = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const tag = (value as { _tag?: unknown })._tag
  return typeof tag === "string" ? tag : undefined
}

/**
 * The event union, tolerant of tags this build does not have.
 *
 * Encoding is unchanged: a known event encodes exactly as it always did, so
 * adopting this is not itself a wire change. Only the read side gains the
 * fallback, and an `UnknownEvent` re-encodes to the payload it arrived as, so
 * relaying a stream through a build that does not understand every event does
 * not degrade it for one that does.
 *
 * A value with no `_tag` at all is still a decode failure. That is not a
 * newer peer, it is malformed input, and quietly accepting it would remove the
 * only check that this is an event stream.
 *
 * So is a value whose tag *is* one of this build's. Tolerance is for a name
 * this build has never heard of; a `ToolCallSucceeded` that fails to decode is
 * a corrupt event, and turning it into an `UnknownEvent` would be the worst of
 * both -- the failure is gone, and so is the tool result, because every
 * consumer skips a tag it has no frame for. The decode failure is the honest
 * answer, and it is the one a known tag keeps.
 */
export const AgentEventTolerant: Schema.Codec<
  AgentEvent | UnknownEvent,
  unknown
> = Schema.Unknown.pipe(
  Schema.decodeTo(
    Schema.toType(Schema.Union([AgentEvent, UnknownEvent])),
    {
      decode: SchemaGetter.transformOrFail((value: unknown) =>
        decodeKnownEvent(value).pipe(
          Effect.catch((error) => {
            const tag = tagOf(value)
            if (tag === undefined) {
              return Effect.fail(
                new SchemaIssue.InvalidValue(
                  { message: "not an agent event: no _tag" },
                  Option.some(value)
                )
              )
            }
            return knownTags.has(tag)
              ? Effect.fail(error.issue)
              : Effect.succeed<AgentEvent | UnknownEvent>({
                _tag: "UnknownEvent",
                originalTag: tag,
                payload: value
              })
          })
        )
      ),
      encode: SchemaGetter.transformOrFail((event) =>
        event._tag === "UnknownEvent"
          ? Effect.succeed(event.payload)
          : encodeKnownEvent(event).pipe(
            Effect.mapError((error) => error.issue)
          )
      )
    }
  )
)

/**
 * Identifies the execution position an event belongs to.
 *
 * This is an *argument bag* the emitting code fills in, not a domain value, so
 * it uses optional properties the way Effect's own option records do — a caller
 * writes `{ submissionId, runId }`, never `Option.some(...)` at every site. The
 * moment it becomes a persisted domain value it crosses into the
 * `AgentEventEnvelope`, whose `submissionId`/`runId`/`turn` are `Schema.Option`;
 * `EventBus.emit` performs that `undefined`→`Option` conversion once, at that
 * boundary. The two representations are therefore deliberate: `undefined` on the
 * argument side, `Option` on the domain/wire side.
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
  /**
   * `AgentEventTolerant`, not `AgentEvent`, because this is the wire.
   *
   * The two ends of a stream are not always the same build -- `AgentServer`
   * and the relay exist precisely so they need not be -- and a strict union
   * makes every new event a breaking change for every deployed client. Adding
   * `ModelCallCompleted` did exactly that: an older client failed to decode the
   * stream the first time a model call completed, which is every turn.
   *
   * A known event is unaffected, in both directions. An unknown one arrives as
   * `UnknownEvent` carrying its original tag and payload, so a consumer can
   * skip it -- which every projection already does for tags it has no frame
   * for -- and a relay can forward it intact to a build that understands it.
   */
  event: AgentEventTolerant
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
    readonly [Tag in StreamedEvent["_tag"]]?: (
      event: Extract<StreamedEvent, { readonly _tag: Tag }>,
      envelope: AgentEventEnvelope
    ) => Effect.Effect<A, E, R>
  } & {
    /**
     * Runs for any event without its own handler.
     *
     * Including `UnknownEvent`, which is how an event from a newer peer
     * arrives. Most consumers want the same thing for both -- ignore it -- and
     * `orElse` already means that, so tolerance costs an existing caller
     * nothing. A consumer that wants to log or forward unknown events can
     * name `UnknownEvent` explicitly.
     */
    readonly orElse: (
      event: StreamedEvent,
      envelope: AgentEventEnvelope
    ) => Effect.Effect<A, E, R>
  }) =>
  (envelope: AgentEventEnvelope): Effect.Effect<A, E, R> => {
    const handler = handlers[envelope.event._tag]
    return handler === undefined
      ? handlers.orElse(envelope.event, envelope)
      : (handler as (
          event: StreamedEvent,
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
