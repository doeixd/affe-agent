import { Deferred, Effect, Layer, Option, Queue, Ref, Result, Schema, Stream } from "effect"
import { Prompt } from "effect/unstable/ai"
import { Sse } from "effect/unstable/encoding"
import {
  Headers,
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse
} from "effect/unstable/http"
import { AgentClosedError } from "../Errors.js"
import * as AgentEvent from "../AgentEvent.js"
import * as AgentProtocol from "../client/AgentProtocol.js"
import * as Media from "../internal/media.js"
import * as AgentSessionHost from "../client/AgentSessionHost.js"

/**
 * The user-message content shapes this adapter converts: AG-UI's text and
 * binary input parts. Binary content arrives inline as base64 `data`, by
 * `url`, or by `id` -- a reference into a store this adapter does not have,
 * which is refused as unsupported rather than dropped.
 */
export const InputContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("binary"),
    mimeType: Schema.String,
    id: Schema.optional(Schema.String),
    url: Schema.optional(Schema.String),
    data: Schema.optional(Schema.String),
    filename: Schema.optional(Schema.String)
  })
])
export type InputContent = typeof InputContent.Type

/** A user message's content: a string, or the typed input parts. */
export const UserContent = Schema.Union([Schema.String, Schema.Array(InputContent)])
export type UserContent = typeof UserContent.Type

const decodeUserContent = Schema.decodeUnknownOption(UserContent)

/** AG-UI message input accepted by the adapter. */
export const Message = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals([
    "developer",
    "system",
    "assistant",
    "user",
    "tool",
    "activity",
    "reasoning"
  ]),
  // Role-specific validation remains the official protocol's concern: every
  // role's content is accepted here, and the *user* message's is decoded
  // against `UserContent` where it is converted. `Unknown` is what the
  // protocol's other roles genuinely are to this adapter, not a shortcut past
  // the shapes it does handle.
  content: Schema.optional(Schema.Unknown),
  toolCallId: Schema.optional(Schema.String)
})
export type Message = typeof Message.Type

export const ResumeEntry = Schema.Struct({
  interruptId: Schema.String,
  status: Schema.Literals(["resolved", "cancelled"]),
  payload: Schema.optional(Schema.Unknown)
})
export type ResumeEntry = typeof ResumeEntry.Type

/** SDK-independent rendering of the official 0.0.58 RunAgentInput shape. */
export const RunAgentInput = Schema.Struct({
  threadId: Schema.String,
  runId: Schema.String,
  parentRunId: Schema.optional(Schema.String),
  state: Schema.Unknown.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({}))
  ),
  messages: Schema.Array(Message),
  tools: Schema.Array(Schema.Unknown).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  context: Schema.Array(Schema.Unknown).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  forwardedProps: Schema.Unknown.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({}))
  ),
  resume: Schema.optional(Schema.Array(ResumeEntry))
})
export type RunAgentInput = typeof RunAgentInput.Type

const RunStarted = Schema.Struct({
  type: Schema.Literal("RUN_STARTED"),
  threadId: Schema.String,
  runId: Schema.String,
  parentRunId: Schema.optional(Schema.String)
})
const RunFinished = Schema.Struct({
  type: Schema.Literal("RUN_FINISHED"),
  threadId: Schema.String,
  runId: Schema.String,
  result: Schema.optional(Schema.Unknown),
  outcome: Schema.optional(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("success") }),
      Schema.Struct({
        type: Schema.Literal("interrupt"),
        interrupts: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            reason: Schema.String,
            message: Schema.optional(Schema.String),
            toolCallId: Schema.optional(Schema.String)
          })
        )
      })
    ])
  )
})
const RunError = Schema.Struct({
  type: Schema.Literal("RUN_ERROR"),
  message: Schema.String,
  code: Schema.optional(Schema.String)
})
const StepStarted = Schema.Struct({
  type: Schema.Literal("STEP_STARTED"),
  stepName: Schema.String
})
const StepFinished = Schema.Struct({
  type: Schema.Literal("STEP_FINISHED"),
  stepName: Schema.String
})
const TextMessageStart = Schema.Struct({
  type: Schema.Literal("TEXT_MESSAGE_START"),
  messageId: Schema.String,
  role: Schema.Literal("assistant")
})
const TextMessageContent = Schema.Struct({
  type: Schema.Literal("TEXT_MESSAGE_CONTENT"),
  messageId: Schema.String,
  delta: Schema.String
})
const TextMessageEnd = Schema.Struct({
  type: Schema.Literal("TEXT_MESSAGE_END"),
  messageId: Schema.String
})
const ToolCallStart = Schema.Struct({
  type: Schema.Literal("TOOL_CALL_START"),
  toolCallId: Schema.String,
  toolCallName: Schema.String,
  parentMessageId: Schema.optional(Schema.String)
})
const ToolCallArgs = Schema.Struct({
  type: Schema.Literal("TOOL_CALL_ARGS"),
  toolCallId: Schema.String,
  delta: Schema.String
})
const ToolCallEnd = Schema.Struct({
  type: Schema.Literal("TOOL_CALL_END"),
  toolCallId: Schema.String
})
const ToolCallResult = Schema.Struct({
  type: Schema.Literal("TOOL_CALL_RESULT"),
  messageId: Schema.String,
  toolCallId: Schema.String,
  content: Schema.String,
  role: Schema.Literal("tool")
})
const Custom = Schema.Struct({
  type: Schema.Literal("CUSTOM"),
  name: Schema.String,
  value: Schema.Unknown
})

/** Official AG-UI events emitted by this projection. */
export const Event = Schema.Union([
  RunStarted,
  RunFinished,
  RunError,
  StepStarted,
  StepFinished,
  TextMessageStart,
  TextMessageContent,
  TextMessageEnd,
  ToolCallStart,
  ToolCallArgs,
  ToolCallEnd,
  ToolCallResult,
  Custom
])
export type Event = typeof Event.Type

/** Select one exact AG-UI event member by its protocol discriminant. */
export type EventOf<Type extends Event["type"]> = Extract<
  Event,
  { readonly type: Type }
>

/** The fields accepted by the constructor for one exact AG-UI event. */
export type FieldsOf<Type extends Event["type"]> = Omit<EventOf<Type>, "type">

export type RunStartedEvent = EventOf<"RUN_STARTED">
export type RunFinishedEvent = EventOf<"RUN_FINISHED">
export type RunErrorEvent = EventOf<"RUN_ERROR">
export type StepStartedEvent = EventOf<"STEP_STARTED">
export type StepFinishedEvent = EventOf<"STEP_FINISHED">
export type TextMessageStartEvent = EventOf<"TEXT_MESSAGE_START">
export type TextMessageContentEvent = EventOf<"TEXT_MESSAGE_CONTENT">
export type TextMessageEndEvent = EventOf<"TEXT_MESSAGE_END">
export type ToolCallStartEvent = EventOf<"TOOL_CALL_START">
export type ToolCallArgsEvent = EventOf<"TOOL_CALL_ARGS">
export type ToolCallEndEvent = EventOf<"TOOL_CALL_END">
export type ToolCallResultEvent = EventOf<"TOOL_CALL_RESULT">
export type CustomEvent = EventOf<"CUSTOM">

/**
 * Construct one exact event member while keeping its discriminated type.
 *
 * This is the adapter's single structural assertion: `fields` is the selected
 * union member with only `type` removed, and the spread writes that same
 * discriminant last. TypeScript cannot reduce `Extract` through a generic
 * object spread, but the resulting object is structurally that exact member.
 */
export const event = <Type extends Event["type"]>(
  type: Type,
  fields: FieldsOf<Type>
): EventOf<Type> => ({ ...fields, type }) as EventOf<Type>

/** Preserve the exact event tuple until a consumer deliberately widens it. */
export const events = <const Values extends ReadonlyArray<Event>>(
  ...values: Values
): Values => values

const textStart = (fields: FieldsOf<"TEXT_MESSAGE_START">) =>
  event("TEXT_MESSAGE_START", fields)
const textContent = (fields: FieldsOf<"TEXT_MESSAGE_CONTENT">) =>
  event("TEXT_MESSAGE_CONTENT", fields)
const textEnd = (fields: FieldsOf<"TEXT_MESSAGE_END">) =>
  event("TEXT_MESSAGE_END", fields)

export interface TextMessageOptions {
  readonly id: string
  readonly role: TextMessageStartEvent["role"]
  readonly text: string
}

const textMessage = (
  options: TextMessageOptions
): readonly [
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent
] => [
  textStart({ messageId: options.id, role: options.role }),
  textContent({ messageId: options.id, delta: options.text }),
  textEnd({ messageId: options.id })
]

/** Pure text-event constructors and the batch-message semantic macro. */
export const text = {
  start: textStart,
  content: textContent,
  end: textEnd,
  message: textMessage
}

const runStarted = (fields: FieldsOf<"RUN_STARTED">) =>
  event("RUN_STARTED", fields)
const runFinished = (fields: FieldsOf<"RUN_FINISHED">) =>
  event("RUN_FINISHED", fields)
const runErrorEvent = (fields: FieldsOf<"RUN_ERROR">) =>
  event("RUN_ERROR", fields)

export interface RunSuccessOptions {
  readonly threadId: string
  readonly runId: string
  readonly result: unknown
}

const runSuccess = (options: RunSuccessOptions): RunFinishedEvent =>
  runFinished({
    threadId: options.threadId,
    runId: options.runId,
    result: options.result,
    outcome: { type: "success" }
  })

export interface RunInterruptOptions {
  readonly threadId: string
  readonly runId: string
  readonly interrupts: ReadonlyArray<{
    readonly id: string
    readonly reason: string
    readonly message?: string | undefined
    readonly toolCallId?: string | undefined
  }>
}

const runInterrupt = (options: RunInterruptOptions): RunFinishedEvent =>
  runFinished({
    threadId: options.threadId,
    runId: options.runId,
    outcome: { type: "interrupt", interrupts: options.interrupts }
  })

export interface RunContext {
  readonly threadId: string
  readonly runId: string
}

export interface RunBuilder {
  readonly text: typeof text
  readonly started: (
    fields?: Pick<FieldsOf<"RUN_STARTED">, "parentRunId">
  ) => RunStartedEvent
  readonly finished: (
    fields: Omit<FieldsOf<"RUN_FINISHED">, "threadId" | "runId">
  ) => RunFinishedEvent
  readonly success: (result: unknown) => RunFinishedEvent
  readonly interrupt: (
    interrupts: RunInterruptOptions["interrupts"]
  ) => RunFinishedEvent
}

const bindRun = (context: RunContext): RunBuilder => ({
  text,
  started: (fields = {}) => runStarted({ ...context, ...fields }),
  finished: (fields) => runFinished({ ...context, ...fields }),
  success: (result) => runSuccess({ ...context, result }),
  interrupt: (interrupts) => runInterrupt({ ...context, interrupts })
})

/** Run primitives, semantic outcomes, and the callable correlation binder. */
export const run = Object.assign(bindRun, {
  started: runStarted,
  finished: runFinished,
  error: runErrorEvent,
  failed: runErrorEvent,
  success: runSuccess,
  interrupt: runInterrupt
})

const stepStarted = (fields: FieldsOf<"STEP_STARTED">) =>
  event("STEP_STARTED", fields)
const stepFinished = (fields: FieldsOf<"STEP_FINISHED">) =>
  event("STEP_FINISHED", fields)

export const step = {
  started: stepStarted,
  finished: stepFinished
}

const toolStarted = (fields: FieldsOf<"TOOL_CALL_START">) =>
  event("TOOL_CALL_START", fields)
const toolArgs = (fields: FieldsOf<"TOOL_CALL_ARGS">) =>
  event("TOOL_CALL_ARGS", fields)
const toolFinished = (fields: FieldsOf<"TOOL_CALL_END">) =>
  event("TOOL_CALL_END", fields)
const toolResult = (fields: FieldsOf<"TOOL_CALL_RESULT">) =>
  event("TOOL_CALL_RESULT", fields)

export interface ToolCallOptions {
  readonly id: string
  readonly name: string
  readonly args: string
  readonly parentMessageId?: string | undefined
}

const toolCall = (
  options: ToolCallOptions
): readonly [ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent] => [
  toolStarted({
    toolCallId: options.id,
    toolCallName: options.name,
    ...(options.parentMessageId === undefined
      ? {}
      : { parentMessageId: options.parentMessageId })
  }),
  toolArgs({ toolCallId: options.id, delta: options.args }),
  toolFinished({ toolCallId: options.id })
]

export const tool = {
  started: toolStarted,
  args: toolArgs,
  finished: toolFinished,
  result: toolResult,
  call: toolCall
}

/** Construct a named custom AG-UI event. */
export const custom = (fields: FieldsOf<"CUSTOM">): CustomEvent =>
  event("CUSTOM", fields)

export class AgentAgUiInvalidInputError extends Schema.TaggedError<AgentAgUiInvalidInputError>()(
  "AgentAgUiInvalidInputError",
  { detail: Schema.String }
) {
  override get message() {
    return `Invalid AG-UI input: ${this.detail}`
  }
}

export class AgentAgUiUnsupportedError extends Schema.TaggedError<AgentAgUiUnsupportedError>()(
  "AgentAgUiUnsupportedError",
  { capabilities: Schema.Array(Schema.String) }
) {
  override get message() {
    return `Unsupported AG-UI capabilities: ${this.capabilities.join(", ")}`
  }
}

export const Error = Schema.Union([
  AgentAgUiInvalidInputError,
  AgentAgUiUnsupportedError,
  AgentProtocol.RemoteError
])
export type Error = typeof Error.Type

export interface MapperOptions {
  readonly threadId: string
  readonly runId: string
  readonly parentRunId?: string | undefined
  /** The HTTP server emits RUN_STARTED before it starts the host operation. */
  readonly started?: boolean | undefined
}

export interface EventMapper {
  readonly map: (
    envelope: AgentEvent.AgentEventEnvelope
  ) => Effect.Effect<ReadonlyArray<Event>, AgentProtocol.AgentProtocolCodecError>
  readonly terminal: Effect.Effect<boolean>
}

/**
 * The protocol-local state of one AG-UI run.
 *
 * Not agent state: which text messages and steps are open on the wire, which
 * messages already streamed (so the canonical `MessageCompleted` does not
 * repeat them), whether `RUN_STARTED` has gone out, and whether a terminal
 * frame has. It threads through `transition` and lives nowhere else.
 */
export interface ProjectionState {
  readonly openMessages: ReadonlySet<string>
  readonly openSteps: ReadonlySet<string>
  readonly streamedMessages: ReadonlySet<string>
  readonly started: boolean
  readonly terminal: boolean
}

/** The state before any harness event has been projected. */
export const initialState = (options: MapperOptions): ProjectionState => ({
  openMessages: new Set(),
  openSteps: new Set(),
  streamedMessages: new Set(),
  started: options.started === true,
  terminal: false
})

const correlationKey = (envelope: AgentEvent.AgentEventEnvelope): string => {
  const runId = Option.getOrElse(envelope.runId, () => envelope.sessionId)
  const turn = Option.getOrElse(envelope.turn, () => 0)
  return `${runId}:${turn}`
}

const messageId = (envelope: AgentEvent.AgentEventEnvelope): string =>
  `${correlationKey(envelope)}:message`

const stepName = (envelope: AgentEvent.AgentEventEnvelope): string =>
  `${correlationKey(envelope)}:turn`

const json = (
  value: unknown,
  operation: AgentProtocol.Operation = "events"
): Effect.Effect<string, AgentProtocol.AgentProtocolCodecError> =>
  Effect.try({
    try: () => JSON.stringify(value),
    catch: (cause) =>
      new AgentProtocol.AgentProtocolCodecError({
        operation,
        phase: "response",
        detail: String(cause)
      })
  })

const startedEvent = (options: MapperOptions): RunStartedEvent =>
  run.started({
    threadId: options.threadId,
    runId: options.runId,
    ...(options.parentRunId === undefined
      ? {}
      : { parentRunId: options.parentRunId })
  })

/**
 * The wire form of a harness event's payload, for the few events that carry
 * one: tool arguments and results, an elicitation's structured detail.
 *
 * Encoding is the one effectful part of projection -- `JSON.stringify` can
 * refuse a value -- and is done before `transition`, which therefore stays
 * a pure function of state and input.
 */
/**
 * Accepts a `StreamedEvent`, so an event from a newer peer is carried rather
 * than refused. AG-UI already projects a subset of tags and ignores the rest;
 * an unknown tag is one more it has no frame for.
 */
export const encodePayload = (
  event: AgentEvent.StreamedEvent
): Effect.Effect<Option.Option<string>, AgentProtocol.AgentProtocolCodecError> =>
  event._tag === "ToolCallStarted"
    ? Effect.map(json(event.params), Option.some)
    : event._tag === "ToolCallSucceeded" || event._tag === "ToolCallProgress"
      ? Effect.map(json(event.encodedResult), Option.some)
      : event._tag === "ToolCallFailed"
        ? Effect.map(
            json({ error: event.failure, returnedToModel: event.returnedToModel }),
            Option.some
          )
        : event._tag === "ToolCallInterrupted"
          ? Effect.map(json({ interrupted: true }), Option.some)
          : event._tag === "ElicitationRequested" && typeof event.detail !== "string"
            ? Effect.map(json(event.detail), Option.some)
            : Effect.succeed(Option.none<string>())

/**
 * One harness event in, zero or more AG-UI events out, with the next state.
 *
 * This is the whole AG-UI lifecycle projection, as a pure function --
 * `Stream.mapAccum`'s shape (named `transition` because `step` is the
 * STEP_* constructor namespace). Everything about pairing lives here: a batch
 * `MessageCompleted` becomes start/content/end; a streamed one was already
 * opened by `MessageStarted` and is only closed; a terminal harness event
 * closes every open frame before the run's own terminal frame; after a
 * terminal frame nothing further is emitted.
 */
export const transition = (
  options: MapperOptions,
  current: ProjectionState,
  envelope: AgentEvent.AgentEventEnvelope,
  payload: Option.Option<string>
): readonly [ProjectionState, ReadonlyArray<Event>] => {
  const event = envelope.event
  const encoded = Option.getOrUndefined(payload)
    if (current.terminal) return [current, []]
    const openMessages = new Set(current.openMessages)
    const openSteps = new Set(current.openSteps)
    const streamedMessages = new Set(current.streamedMessages)
    let started = current.started
    let terminal: boolean = current.terminal
    let output: ReadonlyArray<Event> = []
    const key = correlationKey(envelope)
    const currentMessageId = messageId(envelope)
    const currentStepName = stepName(envelope)
    const closeOpenFrames = (): Array<Event> => {
      const frames: Array<Event> = []
      for (const id of openMessages) {
        frames.push(text.end({ messageId: id }))
      }
      openMessages.clear()
      for (const name of openSteps) {
        frames.push(step.finished({ stepName: name }))
      }
      openSteps.clear()
      return frames
    }

    switch (event._tag) {
      case "SubmissionStarted":
        if (!started) {
          output = [startedEvent(options)]
          started = true
        }
        break
      case "SubmissionCompleted":
        output = [...closeOpenFrames(), run.success({
          threadId: options.threadId,
          runId: options.runId,
          result: { runs: event.runs }
        })]
        terminal = true
        break
      case "SubmissionFailed":
        output = [...closeOpenFrames(), run.error({
          message: event.failure.message,
          code: event.failure.tag
        })]
        terminal = true
        break
      case "SubmissionInterrupted":
        output = [...closeOpenFrames(), run.error({
          message: "The agent run was interrupted",
          code: "INTERRUPTED"
        })]
        terminal = true
        break
      case "RunStarted":
        output = [custom({
          name: "effect-harness/run-started",
          value: {
            runId: Option.getOrElse(envelope.runId, () => options.runId)
          }
        })]
        break
      case "RunCompleted":
        output = [custom({
          name: "effect-harness/run-completed",
          value: {
            runId: Option.getOrElse(envelope.runId, () => options.runId),
            turns: event.turns
          }
        })]
        break
      case "RunFailed":
        output = [custom({
          name: "effect-harness/run-failed",
          value: event.failure
        })]
        break
      case "RunInterrupted":
        output = [custom({
          name: "effect-harness/run-interrupted",
          value: {
            runId: Option.getOrElse(envelope.runId, () => options.runId)
          }
        })]
        break
      case "TurnStarted":
        if (!openSteps.has(currentStepName)) {
          openSteps.add(currentStepName)
          output = [step.started({ stepName: currentStepName })]
        }
        break
      case "TurnCompleted":
        if (openSteps.delete(currentStepName)) {
          output = [step.finished({ stepName: currentStepName })]
        }
        break
      case "MessageStarted":
        openMessages.add(currentMessageId)
        output = [text.start({
          messageId: currentMessageId,
          role: "assistant"
        })]
        break
      case "MessageDelta":
        output = event.kind === "text"
          ? [text.content({
              messageId: currentMessageId,
              delta: event.delta
            })]
          : [custom({
              name: "effect-harness/reasoning-delta",
              value: { messageId: currentMessageId, delta: event.delta }
            })]
        break
      case "MessageStreamCompleted":
        if (openMessages.delete(currentMessageId)) {
          streamedMessages.add(key)
          output = [text.end({ messageId: currentMessageId })]
        }
        break
      case "MessageCompleted":
        if (!streamedMessages.has(key)) {
          output = openMessages.delete(currentMessageId)
            ? [
                text.content({
                  messageId: currentMessageId,
                  delta: event.text
                }),
                text.end({ messageId: currentMessageId })
              ]
            : text.message({
                id: currentMessageId,
                role: "assistant",
                text: event.text
              })
        }
        break
      case "MessageInterrupted":
      case "MessageFailed":
        if (openMessages.has(currentMessageId)) {
          openMessages.delete(currentMessageId)
          streamedMessages.add(key)
          output = [text.end({ messageId: currentMessageId })]
        }
        break
      case "ToolCallStarted":
        output = tool.call({
          id: event.id,
          name: event.name,
          args: encoded ?? "",
          parentMessageId: currentMessageId
        })
        break
      case "ToolCallProgress":
        output = [custom({
          name: "effect-harness/tool-progress",
          value: {
            toolCallId: event.id,
            toolCallName: event.name,
            content: encoded
          }
        })]
        break
      case "ToolCallSucceeded":
        output = [tool.result({
          messageId: `${event.id}:result`,
          toolCallId: event.id,
          content: encoded ?? "",
          role: "tool"
        })]
        break
      case "ToolCallFailed":
        output = [tool.result({
          messageId: `${event.id}:result`,
          toolCallId: event.id,
          content: encoded ?? "",
          role: "tool"
        })]
        break
      case "ToolCallInterrupted":
        output = [tool.result({
          messageId: `${event.id}:result`,
          toolCallId: event.id,
          content: encoded ?? "",
          role: "tool"
        })]
        break
      case "ElicitationRequested":
        output = [...closeOpenFrames(), run.interrupt({
          threadId: options.threadId,
          runId: options.runId,
          interrupts: [{
            id: event.id,
            reason: event.kind,
            message: typeof event.detail === "string"
              ? event.detail
              : encoded
          }]
        })]
        terminal = true
        break
      case "ElicitationResolved":
        output = [custom({
          name: "effect-harness/elicitation-resolved",
          value: {
            id: event.id,
            kind: event.kind,
            granted: event.granted
          }
        })]
        break
      case "SteeringQueued":
      case "SteeringApplied":
      case "FollowUpQueued":
      case "FollowUpApplied":
      case "SessionStarted":
      case "SessionClosed":
        break
    }

    return [{
      openMessages,
      openSteps,
      streamedMessages,
      started,
      terminal
    }, output]
}

/**
 * Project a stream of harness events into AG-UI events.
 *
 * `Stream.mapAccumEffect` over `transition`: lazy, pull-driven, and carrying the
 * source's error and requirement channels unchanged. The only effect in the
 * loop is payload encoding.
 */
export const project = <E, R>(
  options: MapperOptions,
  events: Stream.Stream<AgentEvent.AgentEventEnvelope, E, R>
): Stream.Stream<Event, E | AgentProtocol.AgentProtocolCodecError, R> =>
  events.pipe(
    Stream.mapAccumEffect(
      () => initialState(options),
      (state, envelope) =>
        Effect.map(encodePayload(envelope.event), (encoded) =>
          transition(options, state, envelope, encoded)
        )
    )
  )

/**
 * Build the stateful, sequential harness-event to AG-UI projection.
 *
 * The request handler drives the projection one event at a time from an
 * observer fibre, so the same `transition` is applied through a `Ref` here; the
 * `Stream`-shaped form is `project`. There is one implementation of the
 * lifecycle either way.
 */
export const makeEventMapper = Effect.fn("AgentAgUi.makeEventMapper")(
  function* (options: MapperOptions) {
    const state = yield* Ref.make<ProjectionState>(initialState(options))

    const map = Effect.fn("AgentAgUi.EventMapper.map")(function* (
      envelope: AgentEvent.AgentEventEnvelope
    ) {
      const encoded = yield* encodePayload(envelope.event)
      return yield* Ref.modify(state, (current) => {
        const [next, output] = transition(options, current, envelope, encoded)
        return [output, next]
      })
    })

    return {
      map,
      terminal: Effect.map(Ref.get(state), (current) => current.terminal)
    } satisfies EventMapper
  }
)

export interface SessionContext<Principal> {
  readonly principal: Principal
  readonly input: RunAgentInput
  readonly headers: Headers.Headers
}

export type SessionResolutionError =
  | AgentProtocol.AgentUnauthorizedError
  | AgentProtocol.AgentForbiddenError
  | AgentAgUiInvalidInputError

/** Thread ids are untrusted input; applications decide how they name sessions. */
export interface SessionResolver<Principal> {
  readonly resolve: (
    context: SessionContext<Principal>
  ) => Effect.Effect<AgentProtocol.SessionId, SessionResolutionError>
}

export interface ServerOptions<Principal> {
  /** The host this adapter serves. See `AgentSessionHost`. */
  readonly host: AgentSessionHost.Tag<Principal>
  /** How a thread becomes a session; sees the authenticated principal and the input. */
  readonly session: SessionResolver<Principal>
}

const isEmptyRecord = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 0

const validateCapabilities = (
  input: RunAgentInput
): Effect.Effect<void, AgentAgUiUnsupportedError> => {
  const unsupported: Array<string> = []
  if (input.tools.length > 0) unsupported.push("client-tools")
  if (input.context.length > 0) unsupported.push("client-context")
  if (!isEmptyRecord(input.state)) unsupported.push("client-state")
  if (!isEmptyRecord(input.forwardedProps)) unsupported.push("forwarded-props")
  return unsupported.length === 0
    ? Effect.void
    : Effect.fail(new AgentAgUiUnsupportedError({ capabilities: unsupported }))
}

const promptInput = (
  input: RunAgentInput
): Effect.Effect<Prompt.Prompt, AgentAgUiInvalidInputError | AgentAgUiUnsupportedError> => {
  const latest = Array.from(input.messages)
    .reverse()
    .find((message) => message.role === "user")
  if (latest === undefined) {
    return Effect.fail(
      new AgentAgUiInvalidInputError({ detail: "a user message is required" })
    )
  }
  const content = decodeUserContent(latest.content)
  if (Option.isNone(content)) {
    return Effect.fail(
      new AgentAgUiInvalidInputError({ detail: "the user message's content is not text or input parts" })
    )
  }
  if (typeof content.value === "string") {
    return Effect.succeed(Prompt.make(content.value))
  }
  const parts: Array<Prompt.UserMessagePart> = []
  for (const part of content.value) {
    if (part.type === "text") {
      parts.push(Prompt.textPart({ text: part.text }))
      continue
    }
    const file = part.data !== undefined
      ? Media.fileFromBase64({ mediaType: part.mimeType, base64: part.data, fileName: part.filename })
      : part.url !== undefined
      ? Media.fileFromUrl({ mediaType: part.mimeType, url: part.url, fileName: part.filename })
      : undefined
    if (file === undefined) {
      return Effect.fail(new AgentAgUiUnsupportedError({ capabilities: ["binary-input-by-id"] }))
    }
    if (Result.isFailure(file)) {
      return Effect.fail(new AgentAgUiInvalidInputError({ detail: `binary input: ${file.failure}` }))
    }
    parts.push(file.success)
  }
  return Effect.succeed(Prompt.make([Prompt.userMessage({ content: parts })]))
}

const requestId = (input: RunAgentInput, suffix: string) =>
  AgentProtocol.RequestId.make(`ag-ui:${input.runId}:${suffix}`)

const errorEvent = (error: Error): RunErrorEvent => run.error({
  message: error.message,
  code: error._tag
})

const encodeEvent = Effect.fn("AgentAgUi.encodeEvent")(function* (event: Event) {
  const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(Event))(event).pipe(
    Effect.mapError((error) =>
      new AgentProtocol.AgentProtocolCodecError({
        operation: "events",
        phase: "response",
        detail: error.message
      })
    )
  )
  const data = yield* json(encoded)
  return Sse.encoder.write({
    _tag: "Event",
    id: undefined,
    event: "message",
    data
  })
})

const errorStatus = (error: Error): number => {
  switch (error._tag) {
    case "AgentAgUiInvalidInputError":
    case "AgentAgUiUnsupportedError":
    case "AgentInvalidRequestError":
      return 400
    case "AgentUnauthorizedError":
      return 401
    case "AgentForbiddenError":
      return 403
    case "AgentSessionNotFoundError":
      return 404
    case "AgentSessionAlreadyExistsError":
    case "AgentRequestConflictError":
    case "AgentBusyError":
    case "AgentIdleError":
    case "AgentClosedError":
      return 409
    case "AgentRequestCapacityExceededError":
    case "AgentCapacityExceededError":
      return 429
    case "AgentExecutionError":
      return 422
    case "AgentTransportError":
      return 503
    case "AgentProtocolCodecError":
      return 500
  }
}

const errorResponse = (
  error: Error
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  HttpServerResponse.schemaJson(Error)(error, {
    status: errorStatus(error)
  }).pipe(Effect.orDie)

const decodeInput = (
  request: HttpServerRequest.HttpServerRequest
): Effect.Effect<RunAgentInput, AgentAgUiInvalidInputError> =>
  HttpIncomingMessage.schemaBodyJson(RunAgentInput)(request).pipe(
    Effect.mapError((error) =>
      new AgentAgUiInvalidInputError({ detail: error.message })
    )
  )

const streamResponse = (
  events: Stream.Stream<Event, AgentProtocol.AgentProtocolCodecError>
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.stream(
    events.pipe(
      Stream.mapEffect((event) => encodeEvent(event).pipe(Effect.orDie)),
      Stream.encodeText
    ),
    {
      contentType: "text/event-stream",
      headers: {
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      }
    }
  )

/** Register the official AG-UI HTTP/SSE endpoint at `POST /ag-ui`. */
export const serverLayer = <Principal>(
  options: ServerOptions<Principal>
): Layer.Layer<never, never, HttpRouter.HttpRouter | AgentSessionHost.Service<Principal>> =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const host = yield* options.host
      const shutdown = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(shutdown, void 0))

      const handleRun = Effect.fn("AgentAgUi.run")(function* (
        request: HttpServerRequest.HttpServerRequest
      ) {
        const input = yield* decodeInput(request)
        yield* validateCapabilities(input)
        // Authenticated by the host from the headers, before the session is
        // known; the host authorizes each operation against the principal.
        const principal = yield* host.resolve({
          operation: "prompt",
          sessionId: Option.none(),
          headers: request.headers
        })
        const sessionId = yield* options.session.resolve({
          principal,
          input,
          headers: request.headers
        })
        yield* Effect.annotateCurrentSpan({
          "agent.session.id": sessionId,
          "ag-ui.thread.id": input.threadId,
          "ag-ui.run.id": input.runId
        })

        const resumes = input.resume ?? []
        // Validated before any session exists for it: a request with no
        // usable user message must not consume a session slot on its way to
        // a 400. Enough of those with fresh thread ids would exhaust the
        // host's capacity without ever running anything.
        const prompt = resumes.length === 0
          ? Option.some(yield* promptInput(input))
          : Option.none<Prompt.Prompt>()
        if (resumes.length === 0) {
          yield* host.session(principal, { sessionId }).pipe(
            Effect.catchTag("AgentSessionNotFoundError", () =>
              host.createSession(principal, {
                requestId: requestId(input, "create"),
                sessionId
              })
            )
          )
        } else {
          yield* host.session(principal, { sessionId })
        }

        const source = yield* host.events(principal, { sessionId })
        const mapper = yield* makeEventMapper({
          threadId: input.threadId,
          runId: input.runId,
          parentRunId: input.parentRunId,
          started: true
        })
        // A slow or disconnected SSE client must not grant this request an
        // unbounded memory claim. The bounded queue preserves every protocol
        // event by backpressuring the projection fiber; it never drops or
        // slides frames, because either would corrupt AG-UI message/tool-call
        // sequences. 256 absorbs ordinary token bursts while imposing a fixed
        // per-request ceiling, and request-scope interruption releases a
        // blocked producer when the client disconnects.
        const queue = yield* Queue.bounded<Event>(256)
        const terminal = yield* Deferred.make<void>()
        // Who reports this run: the observer, once it has projected a fresh
        // event, or the prompt fibre, synthesising a cached response for an
        // idempotent replay that produced no events. Decided in one atomic
        // step rather than read from a deferred after the fact -- the
        // observer could otherwise be a breath away from enqueueing real
        // events while the prompt fibre, seeing nothing yet, enqueued a
        // synthetic message and its own RUN_FINISHED ahead of them.
        const reporter = yield* Ref.make<"undecided" | "observer" | "synthetic">(
          "undecided"
        )
        // The session's event stream carries every submission on it, and
        // another client may have one running. This run follows exactly one:
        // for a prompt, the first submission to *start* after subscribing;
        // for a resume, the submission already in flight. Anything from
        // another submission is not this run's to report -- without this, a
        // second request on a busy thread rendered the first run's answer as
        // its own success.
        const pinned = yield* Ref.make<Option.Option<string>>(Option.none())
        const admit = (envelope: AgentProtocol.AgentEventEnvelope) =>
          Option.match(envelope.submissionId, {
            onNone: () => Effect.succeed(true),
            onSome: (submissionId) =>
              Ref.modify(pinned, (current) => {
                if (Option.isSome(current)) {
                  return [current.value === submissionId, current]
                }
                const starts = resumes.length > 0 ||
                  envelope.event._tag === "SubmissionStarted"
                return starts
                  ? [true, Option.some<string>(submissionId)]
                  : [false, current]
              })
          })
        yield* source.pipe(
          Stream.filterEffect(admit),
          Stream.runForEach((envelope) =>
            mapper.map(envelope).pipe(
              Effect.flatMap((events) =>
                Effect.gen(function* () {
                  if (events.length === 0) return
                  const owner = yield* Ref.modify(reporter, (current) =>
                    current === "undecided"
                      ? ["observer" as const, "observer" as const]
                      : [current, current]
                  )
                  // A synthetic response already went out: nothing real may
                  // follow it on the same stream.
                  if (owner !== "observer") return
                  yield* Queue.offerAll(queue, events)
                  if (events.some((event) =>
                    event.type === "RUN_FINISHED" || event.type === "RUN_ERROR"
                  )) {
                    yield* Deferred.succeed(terminal, void 0)
                  }
                })
              )
            )
          ),
          // The source ending without a terminal event means the session went
          // away under this run -- closed by another client, or the host shut
          // down. An SSE response with no terminal frame would stay open
          // until the layer did.
          Effect.andThen(
            Effect.flatMap(Deferred.isDone(terminal), (done) =>
              done
                ? Effect.void
                : Queue.offer(
                    queue,
                    errorEvent(
                      new AgentClosedError({
                        sessionId: AgentProtocol.SessionId.make(sessionId)
                      })
                    )
                  ).pipe(Effect.andThen(Deferred.succeed(terminal, void 0)))
            )
          ),
          Effect.catch((error) =>
              Queue.offer(queue, errorEvent(error)).pipe(
              Effect.andThen(
              Deferred.succeed(terminal, void 0)
              )
            )
          ),
          Effect.forkScoped
        )
        // Let the observer acquire PubSub-backed streams before starting the
        // host operation. Once blocked on its first pull, publication cannot
        // race ahead of subscription.
        yield* Effect.yieldNow
        yield* Queue.offer(queue, startedEvent(input))

        if (resumes.length > 0) {
          yield* Effect.forEach(
            resumes,
            (resume) =>
              host.respond(principal, {
                requestId: requestId(input, `resume:${resume.interruptId}`),
                sessionId,
                response: {
                  id: resume.interruptId,
                  granted: resume.status === "resolved",
                  ...(resume.payload === undefined
                    ? {}
                    : { value: resume.payload })
                }
              }).pipe(
                Effect.flatMap((response) =>
                  response.matched
                    ? Effect.void
                    : Effect.fail(
                        new AgentAgUiInvalidInputError({
                          detail: `interrupt ${resume.interruptId} is not pending`
                        })
                      )
                )
              ),
            { discard: true }
          ).pipe(
            Effect.catch((error) => Queue.offer(queue, errorEvent(error))),
            Effect.forkScoped
          )
        } else if (Option.isSome(prompt)) {
          yield* host.prompt(principal, {
            requestId: requestId(input, "prompt"),
            sessionId,
            input: prompt.value,
            options: { stream: true }
          }).pipe(
            Effect.flatMap((response) =>
              Effect.gen(function* () {
                // A normal prompt publishes its terminal lifecycle before its
                // Effect completes. Give the subscribed observer a turn, then
                // claim reporting atomically: if the observer has projected
                // anything it owns completion; otherwise this was an
                // idempotent replay that produced no events, and the cached
                // response is synthesised for the new HTTP observer.
                yield* Effect.yieldNow
                const owner = yield* Ref.modify(reporter, (current) =>
                  current === "undecided"
                    ? ["synthetic" as const, "synthetic" as const]
                    : [current, current]
                )
                if (owner === "observer") {
                  yield* Deferred.await(terminal)
                  return
                }
                const fallbackMessageId = `${input.runId}:message`
                yield* Queue.offerAll(
                  queue,
                  events(
                    ...text.message({
                      id: fallbackMessageId,
                      role: "assistant",
                      text: response.result.text
                    }),
                    run.success({
                      threadId: input.threadId,
                      runId: input.runId,
                      result: response.result
                    })
                  )
                )
              })
            ),
            Effect.catch((error) =>
              mapper.terminal.pipe(
                Effect.flatMap((terminal) =>
                  terminal
                    ? Effect.void
                    : Queue.offer(queue, errorEvent(error))
                )
              )
            ),
            Effect.forkScoped
          )
        }

        return streamResponse(
          Stream.fromQueue(queue).pipe(
            Stream.takeUntil((event) =>
              event.type === "RUN_FINISHED" || event.type === "RUN_ERROR"
            ),
            Stream.interruptWhen(Deferred.await(shutdown))
          )
        )
      })

      yield* router.add("POST", "/ag-ui", (request) =>
        handleRun(request).pipe(Effect.catch(errorResponse)))
    })
  )
