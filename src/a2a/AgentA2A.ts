import {
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  AGENT_CARD_PATH,
  AgentCard as AgentCardCodec,
  formatSSEErrorEvent,
  formatSSEEvent,
  Role,
  TaskState,
  type AgentCard,
  type AgentSkill,
  type Artifact,
  type Message,
  type Part,
  type SendMessageResult,
  type StreamResponse,
  type Task,
  type TaskStatusUpdateEvent
} from "@a2a-js/sdk"
import { A2AError, TaskNotCancelableError } from "@a2a-js/sdk/errors"
import { ClientFactory } from "@a2a-js/sdk/client"
import {
  AgentEvent,
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type RequestHeaders
} from "@a2a-js/sdk/server"
import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  Exit,
  FiberSet,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream
} from "effect"
import { Prompt } from "effect/unstable/ai"
import {
  Headers,
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse
} from "effect/unstable/http"
import * as AgentClient from "../client/AgentClient.js"
import * as AgentProtocol from "../client/AgentProtocol.js"
import * as AgentSessionHost from "../client/AgentSessionHost.js"
import { is as isEvent } from "../AgentEvent.js"

/** A2A skill metadata advertised by the generated v1 Agent Card. */
export interface Skill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly tags: ReadonlyArray<string>
  readonly examples: ReadonlyArray<string>
  readonly inputModes: ReadonlyArray<string>
  readonly outputModes: ReadonlyArray<string>
}

/** Harness-owned inputs for the protocol's public Agent Card. */
export interface Card {
  readonly name: string
  readonly description: string
  readonly version: string
  readonly skills: ReadonlyArray<Skill>
}

/**
 * What the official task store is isolated by: a stable key for the
 * authenticated owner. Authentication itself is the host's
 * (`AgentSessionHost`); this is the one thing A2A needs of the principal
 * that the host does not.
 */
export interface SubjectResolver<Principal> {
  readonly subject: (principal: Principal) => string
}

export interface SessionContext<Principal> {
  readonly principal: Principal
  readonly contextId: string
}

export interface SessionResolver<Principal> {
  readonly resolve: (
    context: SessionContext<Principal>
  ) => Effect.Effect<
    AgentProtocol.SessionId,
    | AgentProtocol.AgentUnauthorizedError
    | AgentProtocol.AgentForbiddenError
    | AgentA2AInvalidInputError
  >
}

export interface ServerOptions<Principal> {
  readonly card: Card
  /** The host this adapter serves. See `AgentSessionHost`. */
  readonly host: AgentSessionHost.Tag<Principal>
  readonly principal: SubjectResolver<Principal>
  readonly session: SessionResolver<Principal>
  /** JSON-RPC endpoint. The Agent Card is always served at the v1 well-known path. */
  readonly path?: `/${string}` | undefined
  /** Public endpoint URL for reverse-proxy deployments; otherwise derived per request. */
  readonly publicUrl?: string | undefined
}

export class AgentA2AInvalidInputError extends Schema.TaggedError<AgentA2AInvalidInputError>()(
  "AgentA2AInvalidInputError",
  { detail: Schema.String }
) {
  override get message() {
    return `Invalid A2A input: ${this.detail}`
  }
}

export class AgentA2AUnsupportedContentError extends Schema.TaggedError<AgentA2AUnsupportedContentError>()(
  "AgentA2AUnsupportedContentError",
  { kinds: Schema.Array(Schema.String) }
) {
  override get message() {
    return `Unsupported A2A message content: ${this.kinds.join(", ")}`
  }
}

export class AgentA2ATransportError extends Schema.TaggedError<AgentA2ATransportError>()(
  "AgentA2ATransportError",
  { detail: Schema.String }
) {
  override get message() {
    return `A2A transport failure: ${this.detail}`
  }
}

const JsonRpcBody = Schema.Record(Schema.String, Schema.Unknown)

const textPart = (text: string): Part => ({
  content: { $case: "text", value: text },
  metadata: undefined,
  filename: "",
  mediaType: "text/plain"
})

const timestamp = Effect.map(
  Clock.currentTimeMillis,
  (millis) => new Date(millis).toISOString()
)

const inputText = (
  message: Message
): Effect.Effect<string, AgentA2AUnsupportedContentError> => {
  const texts: Array<string> = []
  const unsupported: Array<string> = []
  for (const part of message.parts) {
    const content = part.content
    if (content?.$case === "text") {
      texts.push(content.value)
    } else {
      unsupported.push(content?.$case ?? "empty")
    }
  }
  if (unsupported.length > 0 || texts.length === 0) {
    return Effect.fail(
      new AgentA2AUnsupportedContentError({
        kinds: unsupported.length === 0 ? ["empty"] : unsupported
      })
    )
  }
  return Effect.succeed(texts.join("\n"))
}

const skill = (value: Skill): AgentSkill => ({
  id: value.id,
  name: value.name,
  description: value.description,
  tags: [...value.tags],
  examples: [...value.examples],
  inputModes: [...value.inputModes],
  outputModes: [...value.outputModes],
  securityRequirements: []
})

const requestUrl = (
  request: HttpServerRequest.HttpServerRequest,
  path: string,
  configured: string | undefined
): Effect.Effect<string, AgentA2AInvalidInputError> => {
  if (configured !== undefined) return Effect.succeed(configured)
  const host = request.headers.host
  if (host === undefined) {
    return Effect.fail(
      new AgentA2AInvalidInputError({
        detail: "Host header is required to derive the Agent Card endpoint"
      })
    )
  }
  const forwarded = request.headers["x-forwarded-proto"]
  const protocol = forwarded === undefined
    ? "http"
    : forwarded.split(",", 1)[0]?.trim() || "http"
  return Effect.succeed(`${protocol}://${host}${path}`)
}

const agentCard = <Principal>(
  options: ServerOptions<Principal>,
  url: string
): AgentCard => ({
  name: options.card.name,
  description: options.card.description,
  supportedInterfaces: [{
    url,
    protocolBinding: "JSONRPC",
    tenant: "",
    protocolVersion: A2A_PROTOCOL_VERSION
  }],
  provider: undefined,
  version: options.card.version,
  capabilities: {
    streaming: true,
    pushNotifications: false,
    extensions: [],
    extendedAgentCard: false
  },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: options.card.skills.map(skill),
  signatures: []
})

interface ActiveTask<Principal> {
  readonly taskId: string
  readonly principal: Principal
  readonly sessionId: AgentProtocol.SessionId
  readonly contextId: string
  readonly cancelRequested: Deferred.Deferred<void>
  readonly cancelResolved: Deferred.Deferred<boolean>
}

const createTask = (
  taskId: string,
  contextId: string,
  message: Message,
  recordedAt: string
): Task => ({
  id: taskId,
  contextId,
  status: {
    state: TaskState.TASK_STATE_SUBMITTED,
    message: undefined,
    timestamp: recordedAt
  },
  artifacts: [],
  history: [message],
  metadata: undefined
})

const statusUpdate = (
  taskId: string,
  contextId: string,
  state: TaskState,
  recordedAt: string,
  message?: Message
): TaskStatusUpdateEvent => ({
  taskId,
  contextId,
  status: {
    state,
    message,
    timestamp: recordedAt
  },
  metadata: undefined
})

const responseMessage = (
  taskId: string,
  contextId: string,
  text: string
): Message => ({
  messageId: `${taskId}:response`,
  contextId,
  taskId,
  role: Role.ROLE_AGENT,
  parts: [textPart(text)],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: []
})

const responseArtifact = (taskId: string, text: string): Artifact => ({
  artifactId: `${taskId}:result`,
  name: "Agent response",
  description: "The completed Effect Harness agent response",
  parts: [textPart(text)],
  metadata: undefined,
  extensions: []
})

/** An agent message attached to a status update, rendering what the run needs. */
const statusMessage = (
  taskId: string,
  contextId: string,
  text: string,
  suffix: string
): Message => ({
  messageId: `${taskId}:${suffix}`,
  contextId,
  taskId,
  role: Role.ROLE_AGENT,
  parts: [textPart(text)],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: []
})

const describeRequest = (request: {
  readonly kind: string
  readonly detail: unknown
}): string => {
  const detail = typeof request.detail === "string"
    ? request.detail
    : request.detail === undefined || request.detail === null
      ? undefined
      : JSON.stringify(request.detail)
  return detail === undefined
    ? `The run is paused waiting for "${request.kind}".`
    : `The run is paused waiting for "${request.kind}": ${detail}`
}

/** The run's final answer, read from canonical history once it reaches quiescence. */
const lastAssistantText = (prompt: Prompt.Prompt): string => {
  for (let index = prompt.content.length - 1; index >= 0; index--) {
    const message = prompt.content[index]
    if (message === undefined || message.role !== "assistant") continue
    const content = message.content
    if (typeof content === "string") return content
    return content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
  }
  return ""
}

/** Submission-level events whose arrival means the paused run has settled. */
const terminalTags = new Set([
  "SubmissionCompleted",
  "SubmissionFailed",
  "SubmissionInterrupted"
])

interface ElicitationRequestedEvent {
  readonly _tag: "ElicitationRequested"
  readonly id: string
  readonly kind: string
  readonly detail: unknown
}

type PromptOutcome = {
  readonly _tag: "Prompt"
  readonly exit: Exit.Exit<AgentProtocol.PromptResponse, AgentProtocol.RemoteError>
}

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof value === "object" &&
  value !== null &&
  Symbol.asyncIterator in value

/**
 * Register a native A2A v1 Agent Card and JSON-RPC endpoint.
 *
 * The official SDK owns protocol routing and task persistence. Harness owns
 * authentication, session identity, execution, and scope lifetime.
 */
export const serverLayer = <Principal>(
  options: ServerOptions<Principal>
): Layer.Layer<never, never, HttpRouter.HttpRouter | AgentSessionHost.Service<Principal>> =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const path = options.path ?? "/a2a"
      if (!path.startsWith("/")) {
        return yield* Effect.die(
          new Error("AgentA2A server path must begin with '/'")
        )
      }

      const host = yield* options.host
      const layerScope = yield* Effect.scope
      const runPromise = yield* FiberSet.makeRuntimePromise()
      const active = yield* Ref.make<Map<string, ActiveTask<Principal>>>(
        new Map()
      )
      // Tasks whose run is paused waiting for an answer. The SDK keeps their
      // event bus alive across INPUT_REQUIRED, so the adapter must not finish
      // it when the first request returns.
      const paused = yield* Ref.make(new Set<string>())
      const principals = new WeakMap<
        ServerCallContext,
        { readonly value: Principal }
      >()

      const continuePaused = Effect.fn("AgentA2A.continuePaused")(function* (
        entry: ActiveTask<Principal>,
        target: { readonly id: string },
        userMessage: Message,
        eventBus: ExecutionEventBus
      ) {
        const answer = yield* inputText(userMessage)
        // Subscribe before answering so the terminal event cannot slip past.
        const eventsStream = yield* host.events(entry.principal, {
          sessionId: entry.sessionId
        })
        const matched = yield* host.respond(entry.principal, {
          // Keyed by the question as well as the task: a run that asks twice
          // is answered twice, and an idempotency key per task would reject
          // the second answer as a replay of the first.
          requestId: AgentProtocol.RequestId.make(
            `a2a:${entry.taskId}:respond:${target.id}`
          ),
          sessionId: entry.sessionId,
          response: { id: target.id, granted: true, value: answer }
        })
        if (!matched) {
          const failedAt = yield* timestamp
          yield* Effect.sync(() =>
            eventBus.publish(AgentEvent.statusUpdate(statusUpdate(
              entry.taskId,
              entry.contextId,
              TaskState.TASK_STATE_FAILED,
              failedAt,
              statusMessage(
                entry.taskId,
                entry.contextId,
                `No run was waiting for an answer to "${target.id}".`,
                "unmatched"
              )
            )))
          )
          return
        }
        // How the resumed run settled decides the task's terminal state:
        // completion gets the answer artifact; a failed or interrupted run
        // must not be reported as completed just because it stopped.
        //
        // A resumed run may also ask *again*. Waiting only for a terminal
        // event would then never return: the continuation request hangs, the
        // bus is never finished, and a third message starts a second
        // continuation on the same bus that later publishes duplicate
        // terminal events. A second question is another INPUT_REQUIRED, with
        // the task left paused exactly as the first one left it.
        let settledWith = ""
        const askedAgain = yield* Ref.make<Option.Option<ElicitationRequestedEvent>>(Option.none())
        yield* eventsStream.pipe(
          Stream.filter((envelope) =>
            terminalTags.has(envelope.event._tag) ||
            envelope.event._tag === "ElicitationRequested"
          ),
          Stream.take(1),
          Stream.runForEach((envelope) =>
            envelope.event._tag === "ElicitationRequested"
              ? Ref.set(askedAgain, Option.some(envelope.event))
              : Effect.sync(() => {
                  settledWith = envelope.event._tag
                })
          )
        )
        const settledAt = yield* timestamp
        const again = yield* Ref.get(askedAgain)
        if (Option.isSome(again)) {
          yield* Effect.sync(() =>
            eventBus.publish(AgentEvent.statusUpdate(statusUpdate(
              entry.taskId,
              entry.contextId,
              TaskState.TASK_STATE_INPUT_REQUIRED,
              settledAt,
              statusMessage(
                entry.taskId,
                entry.contextId,
                describeRequest(again.value),
                "input-required"
              )
            )))
          )
          return
        }
        yield* Ref.update(paused, (all) => {
          if (!all.has(entry.taskId)) return all
          const next = new Set(all)
          next.delete(entry.taskId)
          return next
        })
        if (settledWith === "SubmissionFailed") {
          yield* Effect.sync(() =>
            eventBus.publish(AgentEvent.statusUpdate(statusUpdate(
              entry.taskId,
              entry.contextId,
              TaskState.TASK_STATE_FAILED,
              settledAt,
              statusMessage(
                entry.taskId,
                entry.contextId,
                "The run failed after the answer was delivered.",
                "failed"
              )
            )))
          )
          return
        }
        if (settledWith === "SubmissionInterrupted") {
          yield* Effect.sync(() =>
            eventBus.publish(AgentEvent.statusUpdate(statusUpdate(
              entry.taskId,
              entry.contextId,
              TaskState.TASK_STATE_CANCELED,
              settledAt
            )))
          )
          return
        }
        const history = yield* host.history(entry.principal, {
          sessionId: entry.sessionId
        })
        const completedAt = settledAt
        const text = lastAssistantText(history.history)
        yield* Effect.sync(() => {
          eventBus.publish(AgentEvent.artifactUpdate({
            taskId: entry.taskId,
            contextId: entry.contextId,
            artifact: responseArtifact(entry.taskId, text),
            append: false,
            lastChunk: true,
            metadata: undefined
          }))
          eventBus.publish(AgentEvent.statusUpdate(statusUpdate(
            entry.taskId,
            entry.contextId,
            TaskState.TASK_STATE_COMPLETED,
            completedAt,
            responseMessage(entry.taskId, entry.contextId, text)
          )))
        })
      })

      const execute = Effect.fn("AgentA2A.execute")(function* (
        requestContext: RequestContext,
        eventBus: ExecutionEventBus
      ) {
        const owner = principals.get(requestContext.context)
        if (owner === undefined) {
          return yield* new AgentA2ATransportError({
            detail: "request principal was not attached to the SDK call context"
          })
        }
        const principal = owner.value
        const sessionId = yield* options.session.resolve({
          principal,
          contextId: requestContext.contextId
        })
        const taskId = requestContext.taskId
        const openedAt = yield* timestamp

        yield* Effect.sync(() =>
          eventBus.publish(
            AgentEvent.task(
              createTask(
                taskId,
                requestContext.contextId,
                requestContext.userMessage,
                openedAt
              )
            )
          )
        )
        yield* host.session(principal, { sessionId }).pipe(
          Effect.catchTag("AgentSessionNotFoundError", () =>
            host.createSession(principal, {
              requestId: AgentProtocol.RequestId.make(`a2a:${taskId}:create`),
              sessionId
            })
          )
        )
        const cancelRequested = yield* Deferred.make<void>()
        const cancelResolved = yield* Deferred.make<boolean>()
        const entry: ActiveTask<Principal> = {
          taskId,
          principal,
          sessionId,
          contextId: requestContext.contextId,
          cancelRequested,
          cancelResolved
        }
        // Only this invocation's entry: a continuation re-registering the same
        // task id must not be unregistered by the earlier fibre settling.
        const releaseEntry = Ref.update(active, (all) => {
          if (all.get(taskId) !== entry) return all
          const next = new Map(all)
          next.delete(taskId)
          return next
        })
        // Registered only once everything that can fail before work starts
        // has succeeded. A task that failed on its input or its subscription
        // used to stay registered forever, and a later cancel for that id
        // found it — and interrupted whatever the session was running then.
        const register = Ref.update(active, (all) => new Map(all).set(taskId, entry))
        yield* Effect.sync(() =>
          eventBus.publish(
            AgentEvent.statusUpdate(
              statusUpdate(
                taskId,
                requestContext.contextId,
                TaskState.TASK_STATE_WORKING,
                openedAt
              )
            )
          )
        )

        // A paused run answers through a continuation message rather than
        // starting anything new.
        const waiting = yield* host.pending(principal, { sessionId })
        const target = waiting.requests[0]
        if (target !== undefined) {
          yield* register
          yield* continuePaused(
            entry,
            target,
            requestContext.userMessage,
            eventBus
          ).pipe(Effect.ensuring(releaseEntry))
          return
        }

        const prompt = yield* inputText(requestContext.userMessage)

        // Subscribed before the prompt starts so the pause cannot slip past it.
        const eventsStream = yield* host.events(principal, { sessionId })
        yield* register
        const promptDone = yield* Deferred.make<PromptOutcome>()
        const elicited = yield* Deferred.make<ElicitationRequestedEvent>()
        // Owned by this request: once the race below is decided the listener
        // has no further purpose, and left in the layer scope it stayed
        // subscribed to the session for the layer's lifetime — one fibre per
        // request that never paused.
        const listener = yield* Effect.forkIn(
          eventsStream.pipe(
            Stream.filter(isEvent("ElicitationRequested")),
            Stream.take(1),
            Stream.runForEach((envelope) =>
              Deferred.succeed(elicited, envelope.event)
            )
          ),
          layerScope
        )
        // The prompt outlives this request when the run pauses: it is forked
        // into the layer scope and only its exit is reported back here.
        yield* Effect.forkIn(
          Effect.gen(function* () {
            const result = yield* Effect.exit(host.prompt(principal, {
              requestId: AgentProtocol.RequestId.make(`a2a:${taskId}:prompt`),
              sessionId,
              input: Prompt.make(prompt)
            }))
            // A cancellation must publish its terminal event before this
            // request can wake and settle the bus, or the CANCELED update is
            // published to a bus with no listeners left.
            if (yield* Deferred.isDone(cancelRequested)) {
              yield* Deferred.await(cancelResolved)
            }
            const settled: PromptOutcome = { _tag: "Prompt", exit: result }
            yield* Deferred.succeed(promptDone, settled)
          }).pipe(
            // However the paused run ends — cancel, session close, an answer
            // delivered through another transport — its pause marker must not
            // outlive it.
            Effect.ensuring(releaseEntry),
            Effect.ensuring(Ref.update(paused, (all) => {
              if (!all.has(taskId)) return all
              const next = new Set(all)
              next.delete(taskId)
              return next
            }))
          ),
          layerScope
        )

        const outcome = yield* Effect.race(
          Deferred.await(promptDone),
          Deferred.await(elicited)
        ).pipe(Effect.ensuring(Fiber.interrupt(listener)))
        if (outcome._tag === "ElicitationRequested") {
          const pausedAt = yield* timestamp
          yield* Effect.sync(() =>
            eventBus.publish(AgentEvent.statusUpdate(statusUpdate(
              taskId,
              requestContext.contextId,
              TaskState.TASK_STATE_INPUT_REQUIRED,
              pausedAt,
              statusMessage(
                taskId,
                requestContext.contextId,
                describeRequest(outcome),
                "input-required"
              )
            )))
          )
          yield* Ref.update(paused, (all) => new Set(all).add(taskId))
          return
        }
        if (Exit.isFailure(outcome.exit)) {
          // A cancellation interrupts the prompt; the cancel path owns the
          // terminal event, so return quietly rather than failing a second time.
          if (yield* Deferred.isDone(cancelRequested)) return
          return yield* Effect.failCause(outcome.exit.cause)
        }

        const text = outcome.exit.value.result.text
        const completedAt = yield* timestamp
        const message = responseMessage(taskId, requestContext.contextId, text)
        yield* Effect.sync(() => {
          eventBus.publish(AgentEvent.artifactUpdate({
            taskId,
            contextId: requestContext.contextId,
            artifact: responseArtifact(taskId, text),
            append: false,
            lastChunk: true,
            metadata: undefined
          }))
          eventBus.publish(AgentEvent.statusUpdate(statusUpdate(
            taskId,
            requestContext.contextId,
            TaskState.TASK_STATE_COMPLETED,
            completedAt,
            message
          )))
        })
      })

      const cancel = Effect.fn("AgentA2A.cancel")(function* (
        taskId: string,
        eventBus: ExecutionEventBus
      ) {
        const running = (yield* Ref.get(active)).get(taskId)
        if (running === undefined) {
          return yield* Effect.fail(
            new TaskNotCancelableError(`Task ${taskId} is not active`)
          )
        }
        yield* Deferred.succeed(running.cancelRequested, void 0)
        const interrupted = yield* Effect.exit(host.interrupt(running.principal, {
          requestId: AgentProtocol.RequestId.make(`a2a:${taskId}:cancel`),
          sessionId: running.sessionId
        }))
        if (Exit.isFailure(interrupted)) {
          yield* Deferred.succeed(running.cancelResolved, false)
          return yield* Effect.failCause(interrupted.cause)
        }
        const canceledAt = yield* timestamp
        yield* Effect.sync(() => {
          eventBus.publish(AgentEvent.statusUpdate(statusUpdate(
            taskId,
            running.contextId,
            TaskState.TASK_STATE_CANCELED,
            canceledAt
          )))
        })
        yield* Deferred.succeed(running.cancelResolved, true)
        yield* Ref.update(paused, (all) => {
          if (!all.has(taskId)) return all
          const next = new Set(all)
          next.delete(taskId)
          return next
        })
        yield* Effect.sync(() => {
          eventBus.finished()
        })
      })

      const executor = {
        execute: (requestContext, eventBus) =>
          runPromise(
            execute(requestContext, eventBus).pipe(
              Effect.onExit((exit) =>
                // Only a *successful* return settles the bus here. A failure
                // is the SDK's to render: its handler publishes the FAILED
                // task and settles the bus itself, and finishing first would
                // discard that synthesis. An INPUT_REQUIRED task also keeps
                // its bus alive so the continuation message and resubscribers
                // can still attach.
                Exit.isSuccess(exit)
                  ? Effect.flatMap(Ref.get(paused), (all) =>
                    all.has(requestContext.taskId)
                      ? Effect.void
                      : Effect.sync(() => eventBus.finished())
                  )
                  : Effect.void
              )
            )
          ),
        cancelTask: (taskId, eventBus) =>
          runPromise(cancel(taskId, eventBus))
      } satisfies AgentExecutor

      const taskStore = new InMemoryTaskStore()
      const eventBusManager = new DefaultExecutionEventBusManager()

      const handlerFor = (card: AgentCard) =>
        new JsonRpcTransportHandler(
          new DefaultRequestHandler(
            card,
            taskStore,
            executor,
            eventBusManager
          )
        )

      const cardRoute = Effect.fn("AgentA2A.agentCard")(function* (
        request: HttpServerRequest.HttpServerRequest
      ) {
        const url = yield* requestUrl(request, path, options.publicUrl)
        return yield* HttpServerResponse.json(
          AgentCardCodec.toJSON(
            agentCard(options, url)
          ),
          { headers: { [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION } }
        ).pipe(Effect.orDie)
      })

      const jsonRpcRoute = Effect.fn("AgentA2A.jsonRpc")(function* (
        request: HttpServerRequest.HttpServerRequest
      ) {
        const body = yield* HttpIncomingMessage.schemaBodyJson(JsonRpcBody)(
          request
        ).pipe(
          Effect.mapError((error) =>
            new AgentA2AInvalidInputError({ detail: error.message })
          )
        )
        // Authenticated by the host before the task's session is known; the
        // host authorizes each session operation against the principal.
        const principal = yield* host.resolve({
          operation: "prompt",
          sessionId: Option.none(),
          headers: request.headers
        })
        const url = yield* requestUrl(request, path, options.publicUrl)
        const context = new ServerCallContext({
          requestedVersion: request.headers["a2a-version"] ??
            A2A_PROTOCOL_VERSION,
          user: {
            isAuthenticated: true,
            userName: options.principal.subject(principal)
          },
          state: new Map<string, unknown>([[
            "headers",
            request.headers satisfies RequestHeaders
          ]])
        })
        principals.set(context, { value: principal })
        const response = yield* Effect.tryPromise({
          try: () => handlerFor(agentCard(options, url)).handle(body, context),
          catch: (cause) =>
            new AgentA2ATransportError({ detail: String(cause) })
        })
        if (isAsyncIterable(response)) {
          // The SDK generator is drained by a layer-owned fiber because it is
          // also the task-store consumer. The response queue contains at most
          // the adapter's finite task/status/artifact sequence, so disconnecting
          // the one observer cannot backpressure or cancel task execution.
          const output = yield* Queue.unbounded<Option.Option<string>>()
          const requestId = typeof body.id === "string" ||
              typeof body.id === "number" || body.id === null
            ? body.id
            : null
          // Consumed by hand rather than through `Stream.fromAsyncIterable`,
          // whose teardown *awaits* `iterator.return()`. On a parked task the
          // generator is blocked in a pending `iterator.next()` that a shared
          // host (whose session outlives this adapter) never lets resolve
          // here, so awaiting `return()` would deadlock the adapter's own
          // teardown. Interruption instead stops pulling and calls `return()`
          // fire-and-forget, so closing the layer scope completes at once;
          // the host session keeps running, unobserved through A2A.
          const iterator = response[Symbol.asyncIterator]()
          const pump = Effect.gen(function* () {
            while (true) {
              const next = yield* Effect.tryPromise({
                try: () => iterator.next(),
                catch: (cause) =>
                  new AgentA2ATransportError({ detail: String(cause) })
              })
              if (next.done === true) break
              yield* Queue.offer(output, Option.some(formatSSEEvent(next.value)))
            }
          }).pipe(
            Effect.catchTag("AgentA2ATransportError", (error) =>
              Queue.offer(
                output,
                Option.some(formatSSEErrorEvent({
                  jsonrpc: "2.0",
                  id: requestId,
                  error: JsonRpcTransportHandler.mapToJSONRPCError(error)
                }))
              ).pipe(Effect.asVoid)
            ),
            // Queue shutdown discards buffered frames. An explicit sentinel
            // lets the HTTP writer drain every protocol event first.
            Effect.ensuring(Queue.offer(output, Option.none())),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                void iterator.return?.()
              })
            )
          )
          yield* Effect.forkIn(pump, layerScope)
          return HttpServerResponse.stream(
            Stream.fromQueue(output).pipe(
              Stream.takeWhile(Option.isSome),
              Stream.map((chunk) => chunk.value),
              Stream.encodeText
            ),
            {
              contentType: "text/event-stream",
              headers: {
                "cache-control": "no-cache",
                connection: "keep-alive",
                "x-accel-buffering": "no",
                [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION
              }
            }
          )
        }
        return yield* HttpServerResponse.json(response, {
          headers: { [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION }
        }).pipe(Effect.orDie)
      })

      const handled = <A extends HttpServerResponse.HttpServerResponse>(
        effect: Effect.Effect<
          A,
          | AgentA2AInvalidInputError
          | AgentA2ATransportError
          | AgentProtocol.AgentUnauthorizedError
        >
      ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
        effect.pipe(
          Effect.catch((error) =>
            HttpServerResponse.json({
              jsonrpc: "2.0",
              id: null,
              error: {
                // JSON-RPC's own vocabulary: a body that is not a request is
                // the client's fault (-32600), not a server fault (-32603),
                // which strict clients treat as something to report rather
                // than fix.
                code: error._tag === "AgentUnauthorizedError"
                  ? -32001
                  : error._tag === "AgentA2AInvalidInputError"
                    ? -32600
                    : -32603,
                message: error.message
              }
            }, {
              status: error._tag === "AgentUnauthorizedError" ? 401 : 400
            }).pipe(Effect.orDie)
          )
        )

      yield* Effect.all([
        router.add("GET", `/${AGENT_CARD_PATH}`, (request) =>
          handled(cardRoute(request))),
        router.add("POST", path, (request) =>
          handled(jsonRpcRoute(request)))
      ], { discard: true })
    })
  )

/**
 * A protocol-level failure reported by the remote agent.
 *
 * Distinct from `AgentA2ATransportError` for the same reason transport and
 * execution failures are distinguished everywhere else in this library: a
 * remote refusal ("no such task", "not cancelable") is an answer, while a
 * transport failure says nothing about the request.
 */
export class AgentA2ARemoteError extends Schema.TaggedError<AgentA2ARemoteError>()(
  "AgentA2ARemoteError",
  { code: Schema.String, detail: Schema.String }
) {
  override get message() {
    return `A2A remote failure (${this.code}): ${this.detail}`
  }
}

export type RemoteAgentError = AgentA2ATransportError | AgentA2ARemoteError

const toRemoteError = (cause: unknown): RemoteAgentError => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    (("reason" in cause) || cause instanceof A2AError)
  ) {
    const reason = (cause as { reason?: unknown }).reason
    return new AgentA2ARemoteError({
      code: reason === undefined ? cause.constructor.name : String(reason),
      detail: cause instanceof Error ? cause.message : String(cause)
    })
  }
  return new AgentA2ATransportError({ detail: String(cause) })
}

/**
 * An agent reached through the A2A v1 protocol.
 *
 * The official client does the protocol work; this wrapper puts it in Effect
 * terms — typed errors instead of rejections, a `Stream` instead of an async
 * generator — so a caller composes it like any other harness value. The
 * JSON-RPC transport holds no resources of its own, so there is nothing to
 * scope.
 */
export interface RemoteAgent {
  /** The card discovered at construction time. */
  readonly card: Effect.Effect<AgentCard, RemoteAgentError>
  readonly send: (
    message: Message
  ) => Effect.Effect<SendMessageResult, RemoteAgentError>
  readonly stream: (
    message: Message
  ) => Stream.Stream<StreamResponse, RemoteAgentError>
  readonly task: (
    id: string,
    options?: { readonly historyLength?: number | undefined }
  ) => Effect.Effect<Task, RemoteAgentError>
  readonly cancel: (id: string) => Effect.Effect<Task, RemoteAgentError>
}

export interface ClientOptions {
  /** Base URL of the remote agent; the card is read from the v1 well-known path. */
  readonly url: string
  readonly cardPath?: string | undefined
  /** Tenant used on every request; most single-agent deployments use "". */
  readonly tenant?: string | undefined
}

export const client = (
  options: ClientOptions
): Effect.Effect<RemoteAgent, AgentA2ATransportError> =>
  Effect.gen(function* () {
    const tenant = options.tenant ?? ""
    const inner = yield* Effect.tryPromise({
      try: () => new ClientFactory().createFromUrl(options.url, options.cardPath),
      catch: (cause) => new AgentA2ATransportError({ detail: String(cause) })
    })
    const call = <A>(attempt: () => Promise<A>) =>
      Effect.tryPromise({ try: attempt, catch: toRemoteError })
    return {
      card: call(() => inner.getAgentCard()),
      send: (message) =>
        call(() => inner.sendMessage({
          tenant,
          message,
          configuration: undefined,
          metadata: undefined
        })),
      stream: (message) =>
        Stream.fromAsyncIterable(
          inner.sendMessageStream({
            tenant,
            message,
            configuration: undefined,
            metadata: undefined
          }),
          toRemoteError
        ),
      task: (id, taskOptions) =>
        call(() => inner.getTask({
          tenant,
          id,
          historyLength: taskOptions?.historyLength
        })),
      cancel: (id) => call(() => inner.cancelTask({ tenant, id, metadata: undefined }))
    }
  })

/**
 * Schema-driven request/result exchange between two agents.
 *
 * The request value is encoded through its schema, carried as one JSON text
 * part, and the first artifact's text is decoded back through the result
 * schema — so both sides keep precise types across a wire that only speaks
 * text parts.
 */
export interface TypedExchange<Request, Result> {
  readonly exchange: (
    agent: RemoteAgent,
    options: {
      readonly contextId: string
      readonly request: Request
    }
  ) => Effect.Effect<
    Result,
    | RemoteAgentError
    | AgentA2AUnsupportedContentError
    | AgentA2ARemoteError
    | Schema.SchemaError
  >
}

export const typed = <Request, Result>(schemas: {
  readonly request: Schema.Codec<Request, unknown>
  readonly result: Schema.Codec<Result, unknown>
}): TypedExchange<Request, Result> => ({
  exchange: (agent, options) =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(schemas.request)(options.request)
      const sent = yield* agent.send({
        messageId: crypto.randomUUID(),
        contextId: options.contextId,
        taskId: "",
        role: Role.ROLE_USER,
        parts: [textPart(JSON.stringify(encoded))],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: []
      })
      if (!("artifacts" in sent) || !Array.isArray(sent.artifacts)) {
        return yield* new AgentA2ARemoteError({
          code: "NO_RESULT",
          detail: "the agent replied with a bare message instead of a task"
        })
      }
      const content = sent.artifacts[0]?.parts[0]?.content
      if (content?.$case !== "text") {
        return yield* new AgentA2AUnsupportedContentError({
          kinds: [content?.$case ?? "empty"]
        })
      }
      const parsed = yield* Effect.try({
        try: () => JSON.parse(content.value) as unknown,
        catch: (cause) =>
          new AgentA2ARemoteError({
            code: "BAD_RESULT",
            detail: `the result artifact was not JSON: ${String(cause)}`
          })
      })
      return yield* Schema.decodeUnknownEffect(schemas.result)(parsed)
    })
})
