import {
  A2A_CONTENT_TYPE,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  AGENT_CARD_PATH,
  AgentCard as AgentCardCodec,
  formatSSEErrorEvent,
  formatSSEEvent,
  ListTaskPushNotificationConfigsResponse as ListTaskPushNotificationConfigsResponseCodec,
  ListTasksRequest as ListTasksRequestCodec,
  ListTasksResponse as ListTasksResponseCodec,
  Role,
  SendMessageRequest as SendMessageRequestCodec,
  SendMessageResponse as SendMessageResponseCodec,
  StreamResponse as StreamResponseCodec,
  Task as TaskCodec,
  TaskPushNotificationConfig as TaskPushNotificationConfigCodec,
  TaskState,
  type AgentCard,
  type AgentSkill,
  type Artifact,
  type Message,
  Part,
  type SendMessageResult,
  type StreamResponse,
  type Task,
  type TaskStatusUpdateEvent
} from "@a2a-js/sdk"
import {
  A2AError,
  ContentTypeNotSupportedError,
  ExtendedAgentCardNotConfiguredError,
  ExtensionSupportRequiredError,
  InvalidAgentResponseError,
  PushNotificationNotSupportedError,
  RequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError,
  VersionNotSupportedError,
  restStatusFor,
  toRestErrorBody
} from "@a2a-js/sdk/errors"
import { ClientFactory } from "@a2a-js/sdk/client"
import {
  AgentEvent,
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  validateVersion,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type RequestHeaders
} from "@a2a-js/sdk/server"
import { Clock, Deferred, Duration, Effect, Encoding, Exit, Fiber, FiberSet, Layer, Option, Predicate, Queue, Ref, Result, Schema, Stream } from "effect"
import { Prompt } from "effect/unstable/ai"
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse
} from "effect/unstable/http"
import * as AgentProtocol from "../client/AgentProtocol.js"
import * as Media from "../internal/media.js"
import * as AgentSessionHost from "../client/AgentSessionHost.js"
import { is as isEvent } from "../AgentEvent.js"

/**
 * The SSE keep-alive frame.
 *
 * A comment, not an event: the spec says a line beginning with `:` is
 * ignored, so it reaches the socket -- and any proxy counting idle time --
 * without reaching the application, without an `id:` field, and so without
 * disturbing `Last-Event-ID` or the protocol's event sequence.
 */
const SSE_KEEP_ALIVE = ": keep-alive\n\n"

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
  /**
   * Where push notifications may be sent.
   *
   * A push notification config names a URL this server will later POST task
   * content to, chosen by the caller. That is an outbound request on the
   * server's behalf to an address it did not pick, so the default refuses
   * anything but `https` to a non-loopback, non-private host.
   *
   * `allowHosts` opts specific hostnames back in -- the usual reason being an
   * internal collector reachable only on a private network. Supplying it is
   * a deliberate statement that those hosts are safe to reach; there is no
   * wildcard, because a wildcard would silently restore the default-open
   * behaviour this exists to remove.
   */
  /**
   * How long an SSE stream may sit idle before a keep-alive comment frame is
   * written, or `false` to write none.
   *
   * An intermediary cannot tell a stream parked on `input-required` from a
   * dead connection, and drops it at its own idle timeout. A comment frame is
   * the only thing that can be sent without inventing a protocol event: SSE
   * parsers -- the official client's included -- discard a line starting with
   * `:`, so it reaches the socket without reaching the application, and
   * touches neither `Last-Event-ID` nor the event sequence.
   *
   * The default is 15 seconds because the shortest idle timeout in common
   * infrastructure is 30 (nginx `proxy_read_timeout` is 60, AWS ALB and GCP
   * load balancers default to 60, Heroku to 55; the tightest of the ones
   * worth naming is Cloudflare's 30 for a stalled origin). Half of the
   * tightest gives one frame's grace before the timeout, so a single lost
   * write does not close the stream.
   */
  readonly sseHeartbeat?: Duration.Duration | false | undefined
  readonly pushNotifications?: {
    readonly allowHosts?: ReadonlyArray<string> | undefined
    /** Permit `http`. Off by default: the target receives task content. */
    readonly allowInsecure?: boolean | undefined
  } | undefined
}

/**
 * Addresses a server must not be talked into calling.
 *
 * Not an exhaustive SSRF defence -- DNS still resolves wherever it likes, and
 * a name that looks public can point at a private address. It removes the
 * direct cases, which is what a literal in a request body actually carries,
 * and leaves the rest to network policy where it belongs.
 */
const privateIpv4Pattern =
  /^(127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/

/**
 * Hostnames that name an internal service without looking like an address.
 *
 * The link-local address is covered by the IPv4 rule, but the cloud providers
 * also publish *names* for the same endpoint, and a name does not match any
 * address pattern.
 */
const metadataHostnames = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "instance-data"
])

/**
 * Whether a URL's hostname names something on the local or private network.
 *
 * The WHATWG `URL` parser does more of this work than it looks: it canonicalises
 * every IPv4 spelling before this sees it, so `2130706433`, `0x7f000001`,
 * `0177.0.0.1` and `127.1` all arrive as `127.0.0.1`. Verified, not assumed --
 * each of those is in the test.
 *
 * What it does *not* normalise is an IPv4-mapped IPv6 address, so
 * `[::ffff:127.0.0.1]` arrives with the mapping intact and has to be unwrapped
 * before the IPv4 rules can see the loopback inside it.
 */
const isPrivateHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (metadataHostnames.has(host)) return true
  if (privateIpv4Pattern.test(host)) return true

  if (host.startsWith("[") && host.endsWith("]")) {
    const inner = host.slice(1, -1)
    // `::ffff:127.0.0.1` and `::ffff:7f00:1` are the same address; the parser
    // may hand back either spelling.
    const mapped = /^::ffff:(.+)$/.exec(inner)
    if (mapped !== null) {
      const embedded = mapped[1]!
      if (privateIpv4Pattern.test(embedded)) return true
      const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(embedded)
      if (hex !== null) {
        const high = Number.parseInt(hex[1]!, 16)
        const low = Number.parseInt(hex[2]!, 16)
        const dotted = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
        if (privateIpv4Pattern.test(dotted)) return true
      }
    }
    if (inner === "::1" || inner === "::" || /^(fc|fd|fe8|fe9|fea|feb)/.test(inner)) {
      return true
    }
    return false
  }
  return false
}

/**
 * Reject a push-notification target, with a reason, or accept it.
 *
 * Returns the reason rather than a boolean so the caller can say *why* the
 * config was refused: "not a URL" and "points at loopback" send an operator to
 * very different places.
 */
export const rejectPushUrl = (
  value: unknown,
  policy?: ServerOptions<never>["pushNotifications"]
): Option.Option<string> => {
  if (typeof value !== "string" || value === "") {
    return Option.some("push notification url is required")
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return Option.some(`push notification url is not a valid URL: ${value}`)
  }
  const allowed = policy?.allowHosts ?? []
  if (allowed.includes(url.hostname)) return Option.none()
  if (url.protocol !== "https:") {
    if (!(url.protocol === "http:" && policy?.allowInsecure === true)) {
      return Option.some(
        `push notification url must use https, got ${url.protocol.replace(":", "")}`
      )
    }
  }
  if (isPrivateHost(url.hostname)) {
    return Option.some(
      `push notification url may not target a private or loopback address: ${url.hostname}`
    )
  }
  return Option.none()
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

/**
 * An A2A message as a user prompt: `text` parts become text, `raw` and `url`
 * parts become file parts with the message's media type, `data` (structured
 * JSON) is refused as unsupported -- nothing in a prompt means "here is an
 * arbitrary object". An empty message is refused too.
 */
const inputPrompt = (
  message: Message
): Effect.Effect<Prompt.Prompt, AgentA2AUnsupportedContentError> => {
  const parts: Array<Prompt.UserMessagePart> = []
  const unsupported: Array<string> = []
  for (const part of message.parts) {
    const content = part.content
    const mediaType = part.mediaType === "" ? "application/octet-stream" : part.mediaType
    const fileName = part.filename === "" ? undefined : part.filename
    if (content?.$case === "text") {
      parts.push(Prompt.textPart({ text: content.value }))
    } else if (content?.$case === "raw") {
      parts.push(
        Prompt.filePart({
          mediaType,
          data: Uint8Array.from(content.value),
          ...(fileName === undefined ? {} : { fileName })
        })
      )
    } else if (content?.$case === "url") {
      const file = Media.fileFromUrl({ mediaType, url: content.value, fileName })
      if (Result.isSuccess(file)) parts.push(file.success)
      else unsupported.push("url")
    } else {
      unsupported.push(content?.$case ?? "empty")
    }
  }
  if (unsupported.length > 0 || parts.length === 0) {
    return Effect.fail(
      new AgentA2AUnsupportedContentError({
        kinds: unsupported.length === 0 ? ["empty"] : unsupported
      })
    )
  }
  return Effect.succeed(Prompt.make([Prompt.userMessage({ content: parts })]))
}

/** The text of a message, for an answer to a question: a file is not one. */
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
  }, {
    url,
    protocolBinding: "HTTP+JSON",
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

/**
 * The agent's answer as A2A parts: text as `text`, a file as `raw` bytes or a
 * `url`, with its media type and name. Reasoning is not for the wire, and a
 * file whose string data is not base64 is dropped rather than sent as a
 * text part claiming to be an image. An answer with nothing to say is one
 * empty text part, as it always was.
 */
const outputParts = (content: ReadonlyArray<Prompt.Part>): Array<Part> => {
  const parts: Array<Part> = []
  for (const part of content) {
    if (part.type === "text") {
      parts.push(textPart(part.text))
    } else if (part.type === "file") {
      const data = Media.outgoing(part)
      if (Result.isFailure(data)) continue
      // Through the SDK's own JSON codec rather than a `Buffer` of ours: the
      // raw variant is typed as one, and this module is portable -- it
      // reaches the host through nothing but the SDK.
      parts.push(
        data.success._tag === "bytes"
          ? Part.fromJSON({
            raw: Encoding.encodeBase64(data.success.bytes),
            filename: part.fileName ?? "",
            mediaType: part.mediaType
          })
          : {
            content: { $case: "url", value: data.success.url.href },
            metadata: undefined,
            filename: part.fileName ?? "",
            mediaType: part.mediaType
          }
      )
    }
  }
  return parts.length === 0 ? [textPart("")] : parts
}

const responseMessage = (
  taskId: string,
  contextId: string,
  content: ReadonlyArray<Prompt.Part>
): Message => ({
  messageId: `${taskId}:response`,
  contextId,
  taskId,
  role: Role.ROLE_AGENT,
  parts: outputParts(content),
  metadata: undefined,
  extensions: [],
  referenceTaskIds: []
})

const responseArtifact = (taskId: string, content: ReadonlyArray<Prompt.Part>): Artifact => ({
  artifactId: `${taskId}:result`,
  name: "Agent response",
  description: "The completed Effect Harness agent response",
  parts: outputParts(content),
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
const lastAssistantContent = (prompt: Prompt.Prompt): ReadonlyArray<Prompt.Part> => {
  for (let index = prompt.content.length - 1; index >= 0; index--) {
    const message = prompt.content[index]
    if (message === undefined || message.role !== "assistant") continue
    return message.content
  }
  return []
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
 * Register a native A2A v1 Agent Card, JSON-RPC endpoint, and HTTP+JSON
 * binding.
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
        const content = lastAssistantContent(history.history)
        yield* Effect.sync(() => {
          eventBus.publish(AgentEvent.artifactUpdate({
            taskId: entry.taskId,
            contextId: entry.contextId,
            artifact: responseArtifact(entry.taskId, content),
            append: false,
            lastChunk: true,
            metadata: undefined
          }))
          eventBus.publish(AgentEvent.statusUpdate(statusUpdate(
            entry.taskId,
            entry.contextId,
            TaskState.TASK_STATE_COMPLETED,
            completedAt,
            responseMessage(entry.taskId, entry.contextId, content)
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

        const input = yield* inputPrompt(requestContext.userMessage)

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
              input
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

        const content = outcome.exit.value.result.content
        const completedAt = yield* timestamp
        const message = responseMessage(taskId, requestContext.contextId, content)
        yield* Effect.sync(() => {
          eventBus.publish(AgentEvent.artifactUpdate({
            taskId,
            contextId: requestContext.contextId,
            artifact: responseArtifact(taskId, content),
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

      const requestHandlerFor = (card: AgentCard) =>
        new DefaultRequestHandler(
          card,
          taskStore,
          executor,
          eventBusManager
        )

      const handlerFor = (card: AgentCard) =>
        new JsonRpcTransportHandler(requestHandlerFor(card))

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

      const heartbeatIdle = options.sseHeartbeat === undefined
        ? Duration.seconds(15)
        : options.sseHeartbeat

      /**
       * Start the keep-alive fibre for one SSE response, and hand back the
       * effect that tells it a real frame was just written.
       *
       * Idleness is measured against a shared instant rather than a fixed
       * tick, so an event genuinely restarts the countdown instead of merely
       * skipping the next tick -- a stream that emits every 14 seconds should
       * never write a keep-alive. `Clock` rather than `Date.now()` so a test
       * can drive it deterministically with `TestClock`.
       *
       * Forked as a child of the caller's fibre, which is the pump: when the
       * generator ends and the pump offers its sentinel, the heartbeat is
       * interrupted with it, so nothing can be written after the close.
       */
      const startHeartbeat = Effect.fn("AgentA2A.sseHeartbeat")(function* (
        output: Queue.Queue<Option.Option<string>>
      ) {
        if (heartbeatIdle === false) return { touch: Effect.void }
        const idle = Duration.toMillis(heartbeatIdle)
        const lastWrite = yield* Ref.make(yield* Clock.currentTimeMillis)
        yield* Effect.forkChild(Effect.gen(function* () {
          while (true) {
            const now = yield* Clock.currentTimeMillis
            const remaining = idle - (now - (yield* Ref.get(lastWrite)))
            if (remaining > 0) {
              yield* Effect.sleep(Duration.millis(remaining))
              continue
            }
            yield* Queue.offer(output, Option.some(SSE_KEEP_ALIVE))
            yield* Ref.set(lastWrite, now)
          }
        }))
        return {
          touch: Effect.flatMap(
            Clock.currentTimeMillis,
            (now) => Ref.set(lastWrite, now)
          )
        }
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
          // Deliberately unbounded. The SDK generator is drained by a
          // layer-owned fiber because it is also the task-store consumer. The
          // response queue contains at most the adapter's finite
          // task/status/artifact sequence, so its size is bounded by one finite
          // protocol response even though the Queue primitive has no numeric
          // bound. Disconnecting the one observer therefore cannot backpressure
          // or cancel task execution, and there is no perpetual producer whose
          // output can accumulate for the life of the server.
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
            const { touch } = yield* startHeartbeat(output)
            while (true) {
              const next = yield* Effect.tryPromise({
                try: () => iterator.next(),
                catch: (cause) =>
                  new AgentA2ATransportError({ detail: String(cause) })
              })
              if (next.done === true) break
              yield* Queue.offer(output, Option.some(formatSSEEvent(next.value)))
              yield* touch
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
                // Fire-and-forget for the reason above -- awaiting would
                // deadlock on a parked task -- but the rejection still has to
                // be absorbed. An unhandled rejection from a generator that
                // was interrupted mid-`next()` crashes the process under
                // Node's default policy, which would turn a client
                // disconnecting into a server outage.
                iterator.return?.()?.catch(() => {})
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

      const restJson = (
        body: unknown,
        status = 200
      ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
        HttpServerResponse.json(body, {
          status,
          contentType: A2A_CONTENT_TYPE,
          headers: { [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION }
        }).pipe(Effect.orDie)

      const restFailure = (cause: unknown) => {
        // The SDK publishes each subpath as a self-contained bundle, so an
        // error created by `@a2a-js/sdk/server` is not `instanceof` the same
        // constructor re-exported by `@a2a-js/sdk/errors`. Rebuild semantic
        // server errors by their stable SDK name before using the official
        // REST status/body helpers.
        const normalized = cause instanceof A2AError || !(cause instanceof Error)
          ? cause
          : cause.name === "TaskNotFoundError"
            ? new TaskNotFoundError(cause.message)
            : cause.name === "TaskNotCancelableError"
              ? new TaskNotCancelableError(cause.message)
              : cause.name === "PushNotificationNotSupportedError"
                ? new PushNotificationNotSupportedError(cause.message)
                : cause.name === "UnsupportedOperationError"
                  ? new UnsupportedOperationError(cause.message)
                  : cause.name === "ContentTypeNotSupportedError"
                    ? new ContentTypeNotSupportedError(cause.message)
                    : cause.name === "InvalidAgentResponseError"
                      ? new InvalidAgentResponseError(cause.message)
                      : cause.name === "ExtendedAgentCardNotConfiguredError"
                        ? new ExtendedAgentCardNotConfiguredError(cause.message)
                        : cause.name === "ExtensionSupportRequiredError"
                          ? new ExtensionSupportRequiredError(cause.message)
                          : cause.name === "VersionNotSupportedError"
                            ? new VersionNotSupportedError(cause.message)
                            : cause.name === "RequestMalformedError"
                              ? new RequestMalformedError(cause.message)
                              : cause
        const status = cause instanceof AgentProtocol.AgentUnauthorizedError
          ? 401
          : cause instanceof AgentProtocol.AgentForbiddenError
            ? 403
            : cause instanceof AgentA2AInvalidInputError
              ? 400
              : restStatusFor(normalized)
        return { body: toRestErrorBody(normalized, status), status }
      }

      const restErrorResponse = (
        cause: unknown
      ): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
        const failure = restFailure(cause)
        return restJson(failure.body, failure.status)
      }

      const sdkJson = <A>(
        evaluate: () => Promise<A>,
        encode: (value: A) => unknown,
        status = 200
      ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
        Effect.tryPromise({
          try: evaluate,
          // Normalize the SDK rejection at this private boundary so the
          // public operation has no `unknown` error channel.
          catch: restFailure
        }).pipe(
          Effect.matchEffect({
            onFailure: (failure) => restJson(failure.body, failure.status),
            onSuccess: (value) => restJson(encode(value), status)
          })
        )

      const sdkEmpty = (
        evaluate: () => Promise<void>
      ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
        Effect.tryPromise({
          try: evaluate,
          catch: restFailure
        }).pipe(
          Effect.matchEffect({
            onFailure: (failure) => restJson(failure.body, failure.status),
            onSuccess: () => Effect.succeed(HttpServerResponse.empty({
              status: 204,
              headers: { [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION }
            }))
          })
        )

      const sdkStream = Effect.fn("AgentA2A.restStream")(function* (
        evaluate: () => Promise<AsyncGenerator<StreamResponse, void, undefined>>
      ) {
        return yield* Effect.tryPromise({
          try: async () => {
            const iterator = (await evaluate())[Symbol.asyncIterator]()
            const first = await iterator.next()
            return { first, iterator }
          },
          // REST can still select an HTTP status until the first event has
          // been pulled. This matches the official Express binding.
          catch: restFailure
        }).pipe(
          Effect.matchEffect({
            onFailure: (failure) => restJson(failure.body, failure.status),
            onSuccess: ({ first, iterator }) =>
              Effect.gen(function* () {
                const output = yield* Queue.unbounded<Option.Option<string>>()
                if (!first.done) {
                  yield* Queue.offer(
                    output,
                    Option.some(formatSSEEvent(
                      StreamResponseCodec.toJSON(first.value)
                    ))
                  )
                }
                const pump = Effect.gen(function* () {
                  const { touch } = yield* startHeartbeat(output)
                  while (true) {
                    const next = yield* Effect.tryPromise({
                      try: () => iterator.next(),
                      catch: (cause) => restFailure(cause).body
                    })
                    if (next.done === true) break
                    yield* Queue.offer(
                      output,
                      Option.some(formatSSEEvent(
                        StreamResponseCodec.toJSON(next.value)
                      ))
                    )
                    yield* touch
                  }
                }).pipe(
                  Effect.catch((error) =>
                    Queue.offer(
                      output,
                      Option.some(formatSSEErrorEvent(error))
                    ).pipe(Effect.asVoid)
                  ),
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
              })
          })
        )
      })

      const restContext = Effect.fn("AgentA2A.restContext")(function* (
        request: HttpServerRequest.HttpServerRequest,
        operation: AgentProtocol.Operation,
        tenant: string
      ) {
        // The tenant is a path segment, so it is the caller's word and nothing
        // more until the application's resolver joins it to the principal.
        // Presenting it is the whole point: only the application knows which
        // tenants a principal may act in, and without this the segment would
        // be stamped onto `ServerCallContext` having passed no check at all.
        //
        // The tenantless routes carry no segment, and that is *absent*, not
        // the tenant named by the empty string -- a resolver testing
        // `tenant !== undefined` must not see a request to `/message:send`
        // as addressing a tenant.
        const principal = yield* host.resolve({
          operation,
          sessionId: Option.none(),
          tenant: tenant === "" ? undefined : tenant,
          headers: request.headers
        })
        const url = yield* requestUrl(request, path, options.publicUrl)
        const card = agentCard(options, url)
        const requestedVersion = request.headers["a2a-version"]
        const context = new ServerCallContext({
          tenant,
          ...(requestedVersion === undefined ? {} : { requestedVersion }),
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
        return { card, context, handler: requestHandlerFor(card) }
      })

      const restHandled = <R>(
        effect: Effect.Effect<
          HttpServerResponse.HttpServerResponse,
          AgentA2AInvalidInputError | AgentProtocol.AgentUnauthorizedError,
          R
        >
      ): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
        effect.pipe(Effect.catch(restErrorResponse))

      const validateRest = (
        context: ServerCallContext,
        card: AgentCard
      ): Option.Option<unknown> => {
        try {
          validateVersion(context.requestedVersion, card, "HTTP+JSON")
          return Option.none()
        } catch (cause) {
          return Option.some(cause)
        }
      }

      const validateContentType = (
        request: HttpServerRequest.HttpServerRequest
      ): Option.Option<ContentTypeNotSupportedError> => {
        const raw = request.headers["content-type"]
        if (raw === undefined) return Option.none()
        const mediaType = raw.split(";", 1)[0]?.trim().toLowerCase()
        return mediaType === "application/json" || mediaType === A2A_CONTENT_TYPE
          ? Option.none()
          : Option.some(new ContentTypeNotSupportedError(
            `Unsupported Content-Type "${raw}"; expected application/json or ${A2A_CONTENT_TYPE}.`
          ))
      }

      const restBody = (
        request: HttpServerRequest.HttpServerRequest
      ): Effect.Effect<
        Record<string, unknown>,
        AgentA2AInvalidInputError
      > =>
        HttpIncomingMessage.schemaBodyJson(JsonRpcBody)(request).pipe(
          Effect.mapError((error) =>
            new AgentA2AInvalidInputError({ detail: error.message })
          )
        )

      const routeParams = Effect.fn("AgentA2A.routeParams")(function* () {
        const params = yield* HttpRouter.params
        return {
          tenant: params.tenant ?? ""
        }
      })

      const taskRouteParams = Effect.fn("AgentA2A.taskRouteParams")(function* () {
        const params = yield* HttpRouter.params
        const captured = params.taskId ?? ""
        const subscribe = captured.endsWith(":subscribe")
        const cancel = captured.endsWith(":cancel")
        return {
          tenant: params.tenant ?? "",
          taskId: subscribe
            ? captured.slice(0, -":subscribe".length)
            : cancel
              ? captured.slice(0, -":cancel".length)
              : captured,
          action: subscribe ? "subscribe" as const : cancel ? "cancel" as const : "task" as const,
          tail: params["*"] ?? ""
        }
      })

      const prepareRest = Effect.fn("AgentA2A.prepareRest")(function* (
        request: HttpServerRequest.HttpServerRequest,
        operation: AgentProtocol.Operation,
        tenant: string,
        hasBody: boolean
      ) {
        if (hasBody) {
          const invalidContentType = validateContentType(request)
          if (Option.isSome(invalidContentType)) {
            return { _tag: "Response" as const, response: yield* restErrorResponse(invalidContentType.value) }
          }
        }
        const prepared = yield* restContext(request, operation, tenant)
        const invalidVersion = validateRest(prepared.context, prepared.card)
        if (Option.isSome(invalidVersion)) {
          return { _tag: "Response" as const, response: yield* restErrorResponse(invalidVersion.value) }
        }
        return { _tag: "Prepared" as const, ...prepared }
      })

      const sendResultJson = (result: SendMessageResult): unknown =>
        SendMessageResponseCodec.toJSON({
          payload: "messageId" in result
            ? { $case: "message", value: result }
            : { $case: "task", value: result }
        })

      const sendMessageRest = Effect.fn("AgentA2A.sendMessageRest")(function* (
        request: HttpServerRequest.HttpServerRequest,
        tenant: string,
        streaming: boolean
      ) {
        const prepared = yield* prepareRest(request, "prompt", tenant, true)
        if (prepared._tag === "Response") return prepared.response
        const body = yield* restBody(request)
        const params = SendMessageRequestCodec.fromJSON({ ...body, tenant })
        if (params.message === undefined || params.message.messageId === "") {
          return yield* restErrorResponse(new RequestMalformedError(
            params.message === undefined
              ? "message is required"
              : "message.messageId is required"
          ))
        }
        return streaming
          ? yield* sdkStream(() =>
            Promise.resolve(
              prepared.handler.sendMessageStream(params, prepared.context)
            )
          )
          : yield* sdkJson(
            () => prepared.handler.sendMessage(params, prepared.context),
            sendResultJson
          )
      })

      const taskRest = Effect.fn("AgentA2A.taskRest")(function* (
        request: HttpServerRequest.HttpServerRequest,
        tenant: string,
        taskId: string
      ) {
        const prepared = yield* prepareRest(request, "status", tenant, false)
        if (prepared._tag === "Response") return prepared.response
        const search = yield* HttpServerRequest.ParsedSearchParams
        const historyLength = search.historyLength
        const params = {
          tenant,
          id: taskId,
          ...(typeof historyLength === "string"
            ? { historyLength: Number(historyLength) }
            : {})
        }
        if (
          params.historyLength !== undefined &&
          (!Number.isInteger(params.historyLength) || params.historyLength < 0)
        ) {
          return yield* restErrorResponse(new RequestMalformedError(
            "historyLength must be a non-negative integer"
          ))
        }
        return yield* sdkJson(
          () => prepared.handler.getTask(params, prepared.context),
          TaskCodec.toJSON
        )
      })

      const listTasksRest = Effect.fn("AgentA2A.listTasksRest")(function* (
        request: HttpServerRequest.HttpServerRequest,
        tenant: string
      ) {
        const prepared = yield* prepareRest(request, "status", tenant, false)
        if (prepared._tag === "Response") return prepared.response
        const search = yield* HttpServerRequest.ParsedSearchParams
        const params = ListTasksRequestCodec.fromJSON({ ...search, tenant })
        return yield* sdkJson(
          () => prepared.handler.listTasks(params, prepared.context),
          ListTasksResponseCodec.toJSON
        )
      })

      const cancelTaskRest = Effect.fn("AgentA2A.cancelTaskRest")(function* (
        request: HttpServerRequest.HttpServerRequest,
        tenant: string,
        taskId: string
      ) {
        const prepared = yield* prepareRest(request, "interrupt", tenant, true)
        if (prepared._tag === "Response") return prepared.response
        return yield* sdkJson(
          () => prepared.handler.cancelTask({
            tenant,
            id: taskId,
            metadata: undefined
          }, prepared.context),
          TaskCodec.toJSON
        )
      })

      const subscribeTaskRest = Effect.fn("AgentA2A.subscribeTaskRest")(function* (
        request: HttpServerRequest.HttpServerRequest,
        tenant: string,
        taskId: string
      ) {
        const prepared = yield* prepareRest(request, "events", tenant, false)
        if (prepared._tag === "Response") return prepared.response
        return yield* sdkStream(() =>
          Promise.resolve(prepared.handler.resubscribe({
            tenant,
            id: taskId
          }, prepared.context))
        )
      })

      const extendedCardRest = Effect.fn("AgentA2A.extendedCardRest")(function* (
        request: HttpServerRequest.HttpServerRequest,
        tenant: string
      ) {
        const prepared = yield* prepareRest(request, "status", tenant, false)
        if (prepared._tag === "Response") return prepared.response
        return yield* sdkJson(
          () => prepared.handler.getAuthenticatedExtendedAgentCard(
            { tenant },
            prepared.context
          ),
          AgentCardCodec.toJSON
        )
      })

      const createPushConfigRest = Effect.fn("AgentA2A.createPushConfigRest")(function* (
        request: HttpServerRequest.HttpServerRequest,
        tenant: string,
        taskId: string
      ) {
        const prepared = yield* prepareRest(request, "configure", tenant, true)
        if (prepared._tag === "Response") return prepared.response
        const body = yield* restBody(request)
        // Only a target that was actually supplied is checked here. A request
        // with no `url` is not a bad target, it is an incomplete request, and
        // the handler answers it better: on a server that does not support
        // push at all, "push notifications are not supported" is the useful
        // reply, not a complaint about a field that would not have helped.
        const suppliedUrl = Predicate.isObject(body)
          ? Reflect.get(body, "url")
          : undefined
        if (suppliedUrl !== undefined) {
          const rejected = rejectPushUrl(suppliedUrl, options.pushNotifications)
          if (Option.isSome(rejected)) {
            return yield* restErrorResponse(
              new AgentA2AInvalidInputError({ detail: rejected.value })
            )
          }
        }
        const config = TaskPushNotificationConfigCodec.fromJSON({
          ...body,
          tenant,
          taskId
        })
        return yield* sdkJson(
          () => prepared.handler.createTaskPushNotificationConfig(
            config,
            prepared.context
          ),
          TaskPushNotificationConfigCodec.toJSON,
          201
        )
      })

      const listPushConfigsRest = Effect.fn("AgentA2A.listPushConfigsRest")(function* (
        request: HttpServerRequest.HttpServerRequest,
        tenant: string,
        taskId: string
      ) {
        const prepared = yield* prepareRest(request, "configure", tenant, false)
        if (prepared._tag === "Response") return prepared.response
        return yield* sdkJson(
          () => prepared.handler.listTaskPushNotificationConfigs({
            tenant,
            taskId,
            pageSize: 0,
            pageToken: ""
          }, prepared.context),
          ListTaskPushNotificationConfigsResponseCodec.toJSON
        )
      })

      const getPushConfigRest = Effect.fn("AgentA2A.getPushConfigRest")(function* (
        request: HttpServerRequest.HttpServerRequest,
        tenant: string,
        taskId: string,
        configId: string
      ) {
        const prepared = yield* prepareRest(request, "configure", tenant, false)
        if (prepared._tag === "Response") return prepared.response
        return yield* sdkJson(
          () => prepared.handler.getTaskPushNotificationConfig({
            tenant,
            taskId,
            id: configId
          }, prepared.context),
          TaskPushNotificationConfigCodec.toJSON
        )
      })

      const deletePushConfigRest = Effect.fn("AgentA2A.deletePushConfigRest")(function* (
        request: HttpServerRequest.HttpServerRequest,
        tenant: string,
        taskId: string,
        configId: string
      ) {
        const prepared = yield* prepareRest(request, "configure", tenant, false)
        if (prepared._tag === "Response") return prepared.response
        return yield* sdkEmpty(
          () => prepared.handler.deleteTaskPushNotificationConfig({
            tenant,
            taskId,
            id: configId
          }, prepared.context)
        )
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

      const restRouter = router.prefixed(path)
      const sendRoute = (streaming: boolean) =>
        (request: HttpServerRequest.HttpServerRequest) =>
          restHandled(
            Effect.flatMap(routeParams(), ({ tenant }) =>
              sendMessageRest(request, tenant, streaming)
            )
          )
      const listTasksRoute = (request: HttpServerRequest.HttpServerRequest) =>
        restHandled(
          Effect.flatMap(routeParams(), ({ tenant }) =>
              listTasksRest(request, tenant)
            )
          )
      const extendedCardRoute = (request: HttpServerRequest.HttpServerRequest) =>
        restHandled(
          Effect.flatMap(routeParams(), ({ tenant }) =>
              extendedCardRest(request, tenant)
            )
          )

      const malformedTaskRoute = () =>
        restErrorResponse(new RequestMalformedError("Unknown A2A task resource"))

      const taskGetDispatch = (request: HttpServerRequest.HttpServerRequest) =>
        restHandled(
          Effect.flatMap(taskRouteParams(), ({ action, tail, taskId, tenant }) => {
            if (action === "subscribe" && tail === "") {
              return subscribeTaskRest(request, tenant, taskId)
            }
            if (action !== "task") return malformedTaskRoute()
            if (tail === "") return taskRest(request, tenant, taskId)
            if (tail === "pushNotificationConfigs") {
              return listPushConfigsRest(request, tenant, taskId)
            }
            const prefix = "pushNotificationConfigs/"
            return tail.startsWith(prefix) && tail.length > prefix.length
              ? getPushConfigRest(request, tenant, taskId, tail.slice(prefix.length))
              : malformedTaskRoute()
          })
        )

      const taskPostDispatch = (request: HttpServerRequest.HttpServerRequest) =>
        restHandled(
          Effect.flatMap(taskRouteParams(), ({ action, tail, taskId, tenant }) => {
            if (tail !== "") {
              return action === "task" && tail === "pushNotificationConfigs"
                ? createPushConfigRest(request, tenant, taskId)
                : malformedTaskRoute()
            }
            if (action === "cancel") return cancelTaskRest(request, tenant, taskId)
            if (action === "subscribe") {
              return subscribeTaskRest(request, tenant, taskId)
            }
            return malformedTaskRoute()
          })
        )

      const taskDeleteDispatch = (request: HttpServerRequest.HttpServerRequest) =>
        restHandled(
          Effect.flatMap(taskRouteParams(), ({ action, tail, taskId, tenant }) => {
            const prefix = "pushNotificationConfigs/"
            return action === "task" && tail.startsWith(prefix) && tail.length > prefix.length
              ? deletePushConfigRest(request, tenant, taskId, tail.slice(prefix.length))
              : malformedTaskRoute()
          })
        )

      yield* Effect.all([
        router.add("GET", `/${AGENT_CARD_PATH}`, (request) =>
          handled(cardRoute(request))),
        router.add("POST", path, (request) =>
          handled(jsonRpcRoute(request))),
        restRouter.add("GET", "/extendedAgentCard", extendedCardRoute),
        restRouter.add("GET", "/:tenant/extendedAgentCard", extendedCardRoute),
        restRouter.add("POST", "/message::send", sendRoute(false)),
        restRouter.add("POST", "/:tenant/message::send", sendRoute(false)),
        restRouter.add("POST", "/message::stream", sendRoute(true)),
        restRouter.add("POST", "/:tenant/message::stream", sendRoute(true)),
        restRouter.add("GET", "/tasks", listTasksRoute),
        restRouter.add("GET", "/:tenant/tasks", listTasksRoute),
        restRouter.add("GET", "/tasks/:taskId/*", taskGetDispatch),
        restRouter.add("GET", "/:tenant/tasks/:taskId/*", taskGetDispatch),
        restRouter.add("POST", "/tasks/:taskId/*", taskPostDispatch),
        restRouter.add("POST", "/:tenant/tasks/:taskId/*", taskPostDispatch),
        restRouter.add("DELETE", "/tasks/:taskId/*", taskDeleteDispatch),
        restRouter.add("DELETE", "/:tenant/tasks/:taskId/*", taskDeleteDispatch)
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
