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
  type Task,
  type TaskStatusUpdateEvent
} from "@a2a-js/sdk"
import { TaskNotCancelableError } from "@a2a-js/sdk/errors"
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
import * as AgentSessionHost from "../client/internal/sessionHost.js"

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

export interface PrincipalContext {
  readonly headers: Headers.Headers
}

export interface PrincipalResolver<Principal> {
  readonly resolve: (
    context: PrincipalContext
  ) => Effect.Effect<Principal, AgentProtocol.AgentUnauthorizedError>
  /** Stable authenticated owner key used to isolate official task storage. */
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
  readonly authorization: AgentProtocol.Authorization<Principal>
  readonly principal: PrincipalResolver<Principal>
  readonly session: SessionResolver<Principal>
  readonly maxSessions: number
  readonly maxRequestsPerSession: number
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
): Layer.Layer<never, never, HttpRouter.HttpRouter | AgentClient.AgentClient> =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const path = options.path ?? "/a2a"
      if (!path.startsWith("/")) {
        return yield* Effect.die(
          new Error("AgentA2A server path must begin with '/'")
        )
      }

      const host = yield* AgentSessionHost.make(options)
      const layerScope = yield* Effect.scope
      const runPromise = yield* FiberSet.makeRuntimePromise()
      const active = yield* Ref.make<Map<string, ActiveTask<Principal>>>(
        new Map()
      )
      const principals = new WeakMap<
        ServerCallContext,
        { readonly value: Principal }
      >()

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
        yield* Ref.update(active, (all) =>
          new Map(all).set(taskId, {
            principal,
            sessionId,
            contextId: requestContext.contextId,
            cancelRequested,
            cancelResolved
          })
        )
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

        const runPrompt = Effect.gen(function* () {
          const prompt = yield* inputText(requestContext.userMessage)
          const result = yield* Effect.exit(host.prompt(principal, {
            requestId: AgentProtocol.RequestId.make(`a2a:${taskId}:prompt`),
            sessionId,
            input: Prompt.make(prompt)
          }))

          if (yield* Deferred.isDone(cancelRequested)) {
            const canceled = yield* Deferred.await(cancelResolved)
            if (canceled) return
          }
          if (Exit.isFailure(result)) {
            return yield* Effect.failCause(result.cause)
          }

          const completedAt = yield* timestamp
          const message = responseMessage(
            taskId,
            requestContext.contextId,
            result.value.result.text
          )
          yield* Effect.sync(() => {
            eventBus.publish(AgentEvent.artifactUpdate({
              taskId,
              contextId: requestContext.contextId,
              artifact: responseArtifact(taskId, result.value.result.text),
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

        yield* runPrompt.pipe(
          Effect.ensuring(
            Ref.update(active, (all) => {
              const next = new Map(all)
              next.delete(taskId)
              return next
            })
          )
        )
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
        yield* Effect.sync(() => {
          eventBus.finished()
        })
      })

      const executor = {
        execute: (requestContext, eventBus) =>
          runPromise(
            execute(requestContext, eventBus).pipe(
              Effect.ensuring(Effect.sync(() => eventBus.finished()))
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
        const principal = yield* options.principal.resolve({
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
          const drain = Stream.fromAsyncIterable(
            response,
            (cause) => new AgentA2ATransportError({ detail: String(cause) })
          ).pipe(
            Stream.runForEach((event) =>
              Queue.offer(output, Option.some(formatSSEEvent(event)))
            ),
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
            Effect.ensuring(Queue.offer(output, Option.none()))
          )
          yield* Effect.forkIn(drain, layerScope)
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
                code: error._tag === "AgentUnauthorizedError" ? -32001 : -32603,
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
