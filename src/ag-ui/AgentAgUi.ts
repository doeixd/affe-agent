import {
  Deferred,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream
} from "effect"
import { Prompt } from "effect/unstable/ai"
import { Sse } from "effect/unstable/encoding"
import {
  Headers,
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse
} from "effect/unstable/http"
import * as AgentEvent from "../AgentEvent.js"
import * as AgentClient from "../client/AgentClient.js"
import * as AgentProtocol from "../client/AgentProtocol.js"
import * as AgentSessionHost from "../client/internal/sessionHost.js"

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
  // Role-specific validation remains the official protocol's concern. The
  // adapter accepts every official content shape, then narrows the user input
  // capabilities it can faithfully convert to a Harness prompt.
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

interface MapperState {
  readonly openMessages: ReadonlySet<string>
  readonly openSteps: ReadonlySet<string>
  readonly streamedMessages: ReadonlySet<string>
  readonly started: boolean
  readonly terminal: boolean
}

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
 * Build the stateful, sequential harness-event to AG-UI projection.
 *
 * Batch messages synthesize start/content/end. Streamed messages remember that
 * they already emitted those frames, so the later canonical MessageCompleted
 * event cannot duplicate the assistant response.
 */
export const makeEventMapper = Effect.fn("AgentAgUi.makeEventMapper")(
  function* (options: MapperOptions) {
    const state = yield* Ref.make<MapperState>({
      openMessages: new Set(),
      openSteps: new Set(),
      streamedMessages: new Set(),
      started: options.started === true,
      terminal: false
    })

    const map = Effect.fn("AgentAgUi.EventMapper.map")(function* (
      envelope: AgentEvent.AgentEventEnvelope
    ) {
      const event = envelope.event
      const encoded = event._tag === "ToolCallStarted"
        ? yield* json(event.params)
        : event._tag === "ToolCallSucceeded" || event._tag === "ToolCallProgress"
        ? yield* json(event.encodedResult)
        : event._tag === "ToolCallFailed"
        ? yield* json({
            error: event.failure,
            returnedToModel: event.returnedToModel
          })
        : event._tag === "ToolCallInterrupted"
        ? yield* json({ interrupted: true })
        : event._tag === "ElicitationRequested" && typeof event.detail !== "string"
        ? yield* json(event.detail)
        : undefined

      return yield* Ref.modify(state, (current): readonly [ReadonlyArray<Event>, MapperState] => {
        if (current.terminal) return [[], current]
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

        return [output, {
          openMessages,
          openSteps,
          streamedMessages,
          started,
          terminal
        }]
      })
    })

    return {
      map,
      terminal: Effect.map(Ref.get(state), (current) => current.terminal)
    } satisfies EventMapper
  }
)

/** Metadata available to trusted authentication and session routing. */
export interface PrincipalContext {
  readonly input: RunAgentInput
  readonly headers: Headers.Headers
}

export interface PrincipalResolver<Principal> {
  readonly resolve: (
    context: PrincipalContext
  ) => Effect.Effect<Principal, AgentProtocol.AgentUnauthorizedError>
}

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
  readonly authorization: AgentProtocol.Authorization<Principal>
  readonly principal: PrincipalResolver<Principal>
  readonly session: SessionResolver<Principal>
  readonly maxSessions: number
  readonly maxRequestsPerSession: number
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
  if (typeof latest.content !== "string") {
    return Effect.fail(
      new AgentAgUiUnsupportedError({
        capabilities: ["multimodal-user-message"]
      })
    )
  }
  return Effect.succeed(Prompt.make(latest.content))
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
): Layer.Layer<never, never, HttpRouter.HttpRouter | AgentClient.AgentClient> =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const host = yield* AgentSessionHost.make(options)
      const shutdown = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(shutdown, void 0))

      const handleRun = Effect.fn("AgentAgUi.run")(function* (
        request: HttpServerRequest.HttpServerRequest
      ) {
        const input = yield* decodeInput(request)
        yield* validateCapabilities(input)
        const principal = yield* options.principal.resolve({
          input,
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
        const queue = yield* Queue.unbounded<Event>()
        const progressed = yield* Deferred.make<void>()
        const terminal = yield* Deferred.make<void>()
        yield* source.pipe(
          Stream.runForEach((envelope) =>
            mapper.map(envelope).pipe(
              Effect.flatMap((events) =>
                Effect.gen(function* () {
                  yield* Queue.offerAll(queue, events)
                  if (events.length > 0) {
                    yield* Deferred.succeed(progressed, void 0)
                  }
                  if (events.some((event) =>
                    event.type === "RUN_FINISHED" || event.type === "RUN_ERROR"
                  )) {
                    yield* Deferred.succeed(terminal, void 0)
                  }
                })
              )
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
        } else {
          const prompt = yield* promptInput(input)
          yield* host.prompt(principal, {
            requestId: requestId(input, "prompt"),
            sessionId,
            input: prompt,
            options: { stream: true }
          }).pipe(
            Effect.flatMap((response) =>
              Effect.gen(function* () {
                // A normal prompt publishes its terminal lifecycle before its
                // Effect completes. Give the subscribed observer a turn; once
                // it has seen any projected event, it owns completion. With no
                // fresh event this was an idempotent replay, so synthesize the
                // cached response for the new HTTP observer.
                yield* Effect.yieldNow
                if (yield* mapper.terminal) return
                if (yield* Deferred.isDone(progressed)) {
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
