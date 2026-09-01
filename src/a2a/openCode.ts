import {
  Role,
  TaskState,
  type AgentCard,
  type Artifact,
  type Message,
  type Part,
  type SendMessageResult,
  type StreamResponse,
  type Task,
  type TaskStatusUpdateEvent
} from "@a2a-js/sdk"
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Option,
  Queue,
  Ref,
  Schedule,
  Schema,
  Stream
} from "effect"
import { Sse } from "effect/unstable/encoding"
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "effect/unstable/http"
import {
  AgentA2ARemoteError,
  AgentA2ATransportError,
  type RemoteAgent,
  type RemoteAgentError
} from "./AgentA2A.js"
import * as DelegatedPermission from "./internal/delegatedPermission.js"

/**
 * OpenCode as an A2A agent, over `opencode serve`.
 *
 * `docs/plan-a2a-layers-bridges.txt` step 3, and the plan is emphatic about
 * *how*: do not shell out to `opencode run` and parse a terminal. OpenCode is
 * already a server -- sessions, an event bus, and first-class permission
 * requests -- so the bridge speaks its HTTP API and inherits all three. That is
 * also why this needed none of `Sandbox.execStream`: the seam the Claude Code
 * bridge required does not appear here at all, which is the sign it was put in
 * the right place rather than everywhere.
 *
 * The A2A surface is `ClaudeCodeA2A`'s, deliberately. Two runtimes with
 * "wildly different implementations" (the plan's words) present the same
 * `RemoteAgent`, so `AgentA2A.tool` makes either one an ordinary tool and a
 * manager delegating to both writes the same code twice.
 *
 * **Permissions are tighter here.** Claude Code has to be *given* a prompt tool
 * to ask us anything; OpenCode asks on its own bus, and the answer has a third
 * value: `always`. So "allow always" reaches the delegated runtime as well as
 * our policy, and it stops asking -- see `permissions`.
 *
 * ```ts
 * const opencode = yield* OpenCodeA2A.remote({
 *   baseUrl: "http://127.0.0.1:4096",
 *   permissions: { policy, elicitor }
 * })
 * ```
 */

// ---------------------------------------------------------------------------
// Options

export interface Options<R = never> {
  /** Where `opencode serve` is listening. */
  readonly baseUrl: string
  /**
   * Which of OpenCode's two HTTP APIs to speak. Default `v1`.
   *
   * Not a path change. v1's prompt returns the finished assistant message; v2's
   * *admits* it (`POST /api/session/{id}/prompt` -> `SessionInputAdmitted`) and
   * the run is followed on the event bus until `POST .../wait` returns. The
   * permission frames differ in field names, and v2's reply carries a `message`
   * -- so on v2 a policy's reason reaches the delegated agent, which v1 has no
   * field for.
   *
   * Which one a server speaks is a property of its build, not its
   * configuration: 1.18.23 and the `beta` channel expose `/api/...` but fail it
   * (`no such table: session_input`), while the `dev` channel serves it. Left at
   * `v1` because that is what a released server actually answers.
   */
  readonly api?: "v1" | "v2" | undefined
  /**
   * Headers sent with every request, including the event subscription.
   *
   * `opencode serve` warns `OPENCODE_SERVER_PASSWORD is not set; server is
   * unsecured` -- so it has an authenticated mode, and without this there was
   * no way to reach one. A secured server needs its credential here.
   */
  readonly headers?: Readonly<Record<string, string>> | undefined
  /** The model to run, when the server's default is not the one you want. */
  readonly model?: { readonly providerID: string; readonly modelID: string } | undefined
  /** The OpenCode agent to run as (`build`, `plan`, one of yours). */
  readonly agent?: string | undefined
  /** Extra system prompt for the delegated run. */
  readonly system?: string | undefined
  /**
   * Answer OpenCode's permission requests with this application's policy.
   *
   * Omitted, the bridge does not subscribe to permission events at all and the
   * server decides on its own -- which is the honest default, because a bridge
   * that half-answers permissions is worse than one that visibly does not.
   */
  readonly permissions?:
    | (DelegatedPermission.Options<R> & {
      readonly projection?:
        | ((permission: string, request: PermissionAsked) => DelegatedPermission.Projected)
        | undefined
    })
    | undefined
  /**
   * How long to wait for the event subscription before prompting. Default 2s.
   *
   * Only waited when `permissions` is configured, and only that long: a server
   * that never sends its first frame must not hold a delegated task before it
   * has started, and continuing without the bus is better than not running.
   */
  readonly subscribeTimeout?: Duration.Input | undefined
  /**
   * v2 only: how long to wait for the server's agent loop to become busy
   * before waiting for it to go idle again. Default 30 seconds.
   *
   * `wait` means "wait for idle", and a loop that has not started is idle, so
   * the two waits have to happen in that order. This bounds the first one.
   */
  readonly startTimeout?: Duration.Input | undefined
  /**
   * v2 only: how often to ask whether the answer has landed. Default 300ms.
   *
   * Polling is not the first choice -- it is what is left when the endpoint
   * that exists for this is unimplemented. The whole run is bounded by
   * `timeout`.
   */
  readonly pollInterval?: Duration.Input | undefined
  /** The whole delegated run's bound. Default 10 minutes. */
  readonly timeout?: Duration.Input | undefined
  /** How many finished tasks stay fetchable by `task(id)`. Default 256. */
  readonly historyLimit?: number | undefined
  /** Name and version reported on the generated Agent Card. */
  readonly card?:
    | { readonly name?: string | undefined; readonly version?: string | undefined }
    | undefined
}

const DEFAULT_HISTORY = 256

/** Keeps two prompts in one process from minting the same message id. */
let nextMessage = 0

// ---------------------------------------------------------------------------
// The server's side of the contract
//
// Decoded permissively, for the reason the Claude Code bridge decodes its
// stream-json permissively: this is somebody else's evolving API, and a field
// we do not read must never be able to fail a run.

const Session = Schema.Struct({ id: Schema.String })

const TextPart = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String)
})

const PromptResponse = Schema.Struct({
  info: Schema.optional(Schema.Struct({
    id: Schema.optional(Schema.String),
    error: Schema.optional(Schema.Unknown)
  })),
  parts: Schema.optional(Schema.Array(TextPart))
})

/** `permission.asked`, which is the event this bridge exists to answer. */
export const PermissionAsked = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  /** What is being asked for -- `bash`, `edit`, `webfetch`, a plugin's own. */
  permission: Schema.String,
  patterns: Schema.optional(Schema.Array(Schema.String)),
  metadata: Schema.optional(Schema.Unknown),
  always: Schema.optional(Schema.Array(Schema.String))
})
export type PermissionAsked = typeof PermissionAsked.Type

const BusEvent = Schema.Struct({
  type: Schema.optional(Schema.String),
  properties: Schema.optional(Schema.Unknown)
})

/** v2 wraps every response in `data`, and its session create is no exception. */
const SessionV2 = Schema.Struct({
  data: Schema.Struct({ id: Schema.String })
})

/** `POST /api/session/{id}/prompt` answers with the admission, not the answer. */
const AdmittedV2 = Schema.Struct({
  data: Schema.Struct({
    id: Schema.optional(Schema.String),
    /**
     * When the server admitted *this* prompt.
     *
     * The floor for the answer: the message projection is a conversation, so
     * the newest completed assistant message is the *previous* run's until this
     * one finishes. Without this a second delegation returned the first one's
     * answer -- observed live, 2026-09-01.
     */
    timeCreated: Schema.optional(Schema.Number)
  })
})

/**
 * A v2 bus frame.
 *
 * The envelope carries `data` where v1 carries `properties` -- observed against
 * a `dev` server on 2026-09-01, along with the run's whole event sequence:
 * `session.next.prompt.admitted`, `.prompted`, `.step.started`,
 * `.text.started` / `.text.delta` / `.text.ended`, `.step.ended`.
 */
const BusEventV2 = Schema.Struct({
  type: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown)
})

/** `session.next.text.ended`, which carries the whole block, not a delta. */
const TextEndedV2 = Schema.Struct({
  sessionID: Schema.String,
  text: Schema.optional(Schema.String)
})

/** `session.next.step.failed`, the reason a run produced no answer. */
const StepFailedV2 = Schema.Struct({
  sessionID: Schema.String,
  error: Schema.optional(Schema.Struct({
    type: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String)
  }))
})

/** `permission.v2.asked`: `action` and `resources` where v1 says `permission` and `patterns`. */
const PermissionAskedV2 = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  action: Schema.String,
  resources: Schema.optional(Schema.Array(Schema.String)),
  metadata: Schema.optional(Schema.Unknown)
})

/**
 * `GET /api/session/{id}/message`, which is projected state rather than a
 * stream -- so reading the answer from it cannot race the bus.
 *
 * `time.completed` is the marker that the assistant has finished; an assistant
 * message without it is still being written.
 */
const MessagesV2 = Schema.Struct({
  data: Schema.Array(Schema.Struct({
    id: Schema.optional(Schema.String),
    type: Schema.optional(Schema.String),
    time: Schema.optional(Schema.Struct({
      created: Schema.optional(Schema.Number),
      completed: Schema.optional(Schema.Number)
    })),
    content: Schema.optional(Schema.Array(Schema.Struct({
      type: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String)
    })))
  }))
})

const decodeMessagesV2 = Schema.decodeUnknownOption(MessagesV2)

const decodeSessionV2 = Schema.decodeUnknownOption(SessionV2)
const decodeAdmittedV2 = Schema.decodeUnknownOption(AdmittedV2)
const decodeEventV2 = Schema.decodeUnknownOption(BusEventV2)
const decodeTextEndedV2 = Schema.decodeUnknownOption(TextEndedV2)
const decodeStepFailedV2 = Schema.decodeUnknownOption(StepFailedV2)
const decodeAskedV2 = Schema.decodeUnknownOption(PermissionAskedV2)

const decodeSession = Schema.decodeUnknownOption(Session)
const decodePrompt = Schema.decodeUnknownOption(PromptResponse)
const decodeEvent = Schema.decodeUnknownOption(BusEvent)
const decodeAsked = Schema.decodeUnknownOption(PermissionAsked)

// ---------------------------------------------------------------------------
// Projection: OpenCode's permissions in this application's vocabulary

const stringField = (value: unknown, name: string): Option.Option<string> => {
  if (typeof value !== "object" || value === null) return Option.none()
  const found = (value as Record<string, unknown>)[name]
  return typeof found === "string" && found.length > 0 ? Option.some(found) : Option.none()
}

/**
 * OpenCode's permission names in `/coding`'s vocabulary.
 *
 * The same table the Claude Code bridge carries, from the other side: one rule
 * set -- `shell` on the command, `read` and `write` on the path -- governs a
 * local `CodingToolkit` run, a delegated Claude Code run, and this. A
 * permission this does not recognise keeps its own name under `action: "tool"`,
 * so it is visible to a policy rather than silently uncategorised.
 *
 * The resource is the first of: the request's own patterns (OpenCode's
 * canonical scope for the ask, and what `always` would remember), a familiar
 * metadata field, then the permission name.
 */
export const defaultProjection = (
  permission: string,
  request: PermissionAsked
): DelegatedPermission.Projected => {
  const action = permission === "bash" || permission === "shell"
    ? "shell"
    : permission === "edit" || permission === "write" || permission === "patch"
    ? "write"
    : permission === "read"
    ? "read"
    : permission === "webfetch" || permission === "fetch"
    ? "fetch"
    : "tool"
  const resource = Option.getOrElse(
    Option.orElse(
      Option.fromUndefinedOr(request.patterns?.[0]),
      () =>
        Option.orElse(
          stringField(request.metadata, "command"),
          () =>
            Option.orElse(
              // `filepath`, lowercase, is what a real server sends -- observed
              // 2026-09-01, having guessed `filePath` from the schema. Both are
              // accepted, because guessing once is enough.
              stringField(request.metadata, "filepath"),
              () =>
                Option.orElse(
                  stringField(request.metadata, "filePath"),
                  () => stringField(request.metadata, "url")
                )
            )
        )
    ),
    () => permission
  )
  return action === "tool" ? { action, resource: permission } : { action, resource }
}

/** What one bus frame means to this bridge, if anything. */
type Interesting =
  | { readonly _tag: "Permission"; readonly asked: PermissionAsked }
  | { readonly _tag: "Text"; readonly text: string }
  /** v2 only: the run failed, and this is what it said. */
  | { readonly _tag: "Failed"; readonly reason: string }
  /** v2 only: the agent loop is now busy on our behalf. See `awaitIdle`. */
  | { readonly _tag: "Started" }

/**
 * One server-sent frame, read for the two things a bridge needs.
 *
 * Exported for the same reason `ClaudeCodeA2A.parseLine` is: it is where a
 * change in somebody else's event vocabulary would show up first, and a pure
 * function is the cheapest place to notice. Everything else on the bus is
 * ignored rather than refused.
 */
export const readEvent = (
  data: string,
  sessionId: string,
  /**
   * The id of the message *we* sent, whose parts are not progress.
   *
   * The server echoes the caller's own prompt back on the bus as a text part,
   * so without this the bridge reported the question as the agent's first
   * answer. Found by watching a real server's bus, not by reading its schema.
   */
  ownMessageId?: string | undefined
): Option.Option<Interesting> => {
  let json: unknown
  try {
    json = JSON.parse(data)
  } catch {
    return Option.none()
  }
  const decoded = decodeEvent(json)
  if (Option.isNone(decoded)) return Option.none()
  const value = decoded.value
  if (value.type === "permission.asked") {
    const asked = decodeAsked(value.properties)
    return Option.isSome(asked) && asked.value.sessionID === sessionId
      ? Option.some({ _tag: "Permission", asked: asked.value })
      : Option.none()
  }
  if (value.type === "message.part.updated") {
    const part = stringField(
      (value.properties as { part?: unknown } | undefined)?.part,
      "text"
    )
    const forUs = stringField(value.properties, "sessionID")
    const from = stringField(
      (value.properties as { part?: unknown } | undefined)?.part,
      "messageID"
    )
    const ours = ownMessageId !== undefined && Option.isSome(from) &&
      from.value === ownMessageId
    return Option.isSome(part) && Option.isSome(forUs) && forUs.value === sessionId && !ours
      ? Option.some({ _tag: "Text", text: part.value })
      : Option.none()
  }
  return Option.none()
}

/**
 * One v2 frame, read for the three things a bridge needs.
 *
 * A `permission.v2.asked` is normalised into v1's shape -- `action` becomes
 * `permission`, `resources` becomes `patterns` -- so one projection serves both
 * protocols and a policy cannot tell which one answered it. That is the same
 * reason the bridge exists at all.
 */
export const readEventV2 = (
  data: string,
  sessionId: string
): Option.Option<Interesting> => {
  let json: unknown
  try {
    json = JSON.parse(data)
  } catch {
    return Option.none()
  }
  const decoded = decodeEventV2(json)
  if (Option.isNone(decoded)) return Option.none()
  const value = decoded.value
  if (value.type === "permission.v2.asked") {
    const asked = decodeAskedV2(value.data)
    if (Option.isNone(asked) || asked.value.sessionID !== sessionId) return Option.none()
    return Option.some({
      _tag: "Permission",
      asked: {
        id: asked.value.id,
        sessionID: asked.value.sessionID,
        permission: asked.value.action,
        ...(asked.value.resources === undefined ? {} : { patterns: asked.value.resources }),
        ...(asked.value.metadata === undefined ? {} : { metadata: asked.value.metadata })
      }
    })
  }
  if (value.type === "session.next.text.ended") {
    const ended = decodeTextEndedV2(value.data)
    return Option.isSome(ended) && ended.value.sessionID === sessionId &&
        ended.value.text !== undefined && ended.value.text.length > 0
      ? Option.some({ _tag: "Text", text: ended.value.text })
      : Option.none()
  }
  if (value.type === "session.next.step.started") {
    const started = decodeTextEndedV2(value.data)
    return Option.isSome(started) && started.value.sessionID === sessionId
      ? Option.some({ _tag: "Started" })
      : Option.none()
  }
  if (value.type === "session.next.step.failed") {
    const failed = decodeStepFailedV2(value.data)
    return Option.isSome(failed) && failed.value.sessionID === sessionId
      ? Option.some({
        _tag: "Failed",
        reason: failed.value.error?.message ?? failed.value.error?.type ?? "the step failed"
      })
      : Option.none()
  }
  // Everything else on the bus -- the deltas, the prompt echoed back, plugin
  // and catalog chatter -- is ignored rather than refused.
  return Option.none()
}

// ---------------------------------------------------------------------------
// A2A values

const textPart = (text: string): Part => ({
  content: { $case: "text", value: text },
  metadata: undefined,
  filename: "",
  mediaType: "text/plain"
})

const agentMessage = (
  taskId: string,
  contextId: string,
  suffix: string,
  text: string
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

const resultArtifact = (taskId: string, text: string): Artifact => ({
  artifactId: `${taskId}:result`,
  name: "OpenCode result",
  description: "The final assistant message from the delegated OpenCode run",
  parts: [textPart(text)],
  metadata: undefined,
  extensions: []
})

const statusUpdate = (
  taskId: string,
  contextId: string,
  state: TaskState,
  timestamp: string,
  message: Message | undefined,
  final: boolean
): TaskStatusUpdateEvent & { readonly final: boolean } => ({
  taskId,
  contextId,
  status: { state, message, timestamp },
  metadata: undefined,
  final
})

const promptOf = (message: Message): string => {
  let text = ""
  for (const part of message.parts) {
    if (part.content?.$case === "text") text += part.content.value
  }
  return text
}

const cardFor = (options: Options<any>): AgentCard => ({
  name: options.card?.name ?? "OpenCode",
  description:
    "An OpenCode server, bridged as an A2A agent. It runs its own agent loop, tools and session; this bridge speaks its HTTP API rather than its terminal.",
  supportedInterfaces: [],
  provider: undefined,
  version: options.card?.version ?? "0.0.0",
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
  skills: [{
    id: "coding",
    name: "Coding task",
    description: "Read, write and run code in the server's workspace, and report what was done.",
    tags: ["coding", "files", "shell"],
    examples: ["Fix the failing test in src/auth.ts", "Explain what this module does"],
    inputModes: ["text/plain"],
    outputModes: ["text/plain"],
    securityRequirements: []
  }],
  signatures: []
})

// ---------------------------------------------------------------------------
// The bridge

/**
 * A bridged runtime, which is a `RemoteAgent` and one thing more.
 *
 * Identical to `ClaudeCodeA2A.Bridge`, and that is the point: `delegate`
 * narrows A2A's `Message | Task` to `Task`, because neither peer ever answers
 * with a bare message, and a caller should not have to know which runtime it is
 * talking to.
 */
export interface Bridge extends RemoteAgent {
  readonly delegate: (message: Message) => Effect.Effect<Task, RemoteAgentError>
}

type Step =
  | {
    readonly _tag: "Working"
    readonly taskId: string
    readonly contextId: string
    readonly timestamp: string
    readonly text: string
  }
  | {
    readonly _tag: "Final"
    readonly taskId: string
    readonly contextId: string
    readonly timestamp: string
    readonly task: Task
    readonly artifact: Option.Option<Artifact>
  }

export const remote = <R = never>(
  options: Options<R>
): Effect.Effect<Bridge, never, HttpClient.HttpClient | R> =>
  Effect.gen(function* () {
    /**
     * Status is checked, which it was not.
     *
     * `POST /api/session/{id}/wait` answers `503 "Session wait is not available
     * yet"` on a `dev` server -- the endpoint is documented and unimplemented.
     * Without this filter its body decoded as ordinary JSON, the bridge read it
     * as "the run is over", and delegated tasks completed with an empty answer.
     * Observed 2026-09-01.
     */
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const services = yield* Effect.context<R>()
    const card = cardFor(options)
    const base = options.baseUrl.replace(/\/+$/, "")
    const historyLimit = Math.max(1, options.historyLimit ?? DEFAULT_HISTORY)

    /** A2A context id -> the OpenCode session it maps to. */
    const sessions = yield* Ref.make(new Map<string, string>())
    const tasks = yield* Ref.make(new Map<string, Task>())
    /** Task id -> the run in flight, for `cancel` and for refusing a second. */
    const running = yield* Ref.make(new Map<string, {
      readonly sessionId: string
      readonly contextId: string
      readonly message: Message
    }>())
    /**
     * Tasks `cancel` has stopped.
     *
     * The prompt request is still outstanding when `cancel` returns -- aborting
     * makes the *server* return, and what it returns then is an interrupted
     * run, which must not be reported as a completed one. So the run remembers
     * it was cancelled and says so when it finishes.
     */
    const cancelled = yield* Ref.make(new Set<string>())

    const v2 = options.api === "v2"
    const eventPath = v2 ? "/api/event" : "/event"

    const now = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString())

    const transport = (detail: string) => new AgentA2ATransportError({ detail })

    const send = (
      request: HttpClientRequest.HttpClientRequest
    ): Effect.Effect<unknown, RemoteAgentError> =>
      client.execute(request).pipe(
        Effect.flatMap((response) => response.json),
        Effect.mapError((error) => transport(String(error)))
      )

    const get = (path: string) =>
      send(HttpClientRequest.get(`${base}${path}`, {
        headers: { accept: "application/json", ...options.headers }
      }))

    const post = (path: string, body: unknown) =>
      send(HttpClientRequest.post(`${base}${path}`, {
        body: HttpBody.jsonUnsafe(body),
        headers: { accept: "application/json", ...options.headers }
      }))

    const record = (task: Task) =>
      Effect.gen(function* () {
        yield* Ref.update(tasks, (all) => {
          const held = all.get(task.id)
          // A cancellation is final. A late answer from an aborted run must not
          // quietly replace it with "completed".
          if (held?.status?.state === TaskState.TASK_STATE_CANCELED) return all
          const next = new Map(all)
          next.delete(task.id)
          next.set(task.id, task)
          while (next.size > historyLimit) {
            const oldest = next.keys().next()
            if (oldest.done === true) break
            next.delete(oldest.value)
          }
          return next
        })
        yield* Ref.update(running, (all) => {
          if (!all.has(task.id)) return all
          const next = new Map(all)
          next.delete(task.id)
          return next
        })
      })

    /**
     * The session an A2A context maps to, created on first use.
     *
     * One context is one conversation, exactly as `--resume` makes it for the
     * Claude Code bridge -- the mapping is the same idea, and OpenCode's
     * server does the remembering.
     */
    const sessionFor = (contextId: string): Effect.Effect<string, RemoteAgentError> =>
      Effect.gen(function* () {
        if (contextId.length > 0) {
          const known = (yield* Ref.get(sessions)).get(contextId)
          if (known !== undefined) return known
        }
        const answer = yield* post(v2 ? "/api/session" : "/session", v2
          ? {
            ...(options.agent === undefined ? {} : { agent: options.agent }),
            ...(options.model === undefined ? {} : {
              model: { providerID: options.model.providerID, id: options.model.modelID }
            })
          }
          : { title: contextId.length > 0 ? contextId : "delegated task" })
        // v2 wraps its answer in `data`; v1 returns the session itself.
        const id = v2
          ? Option.map(decodeSessionV2(answer), (session) => session.data.id)
          : Option.map(decodeSession(answer), (session) => session.id)
        if (Option.isNone(id)) {
          return yield* new AgentA2ARemoteError({
            code: "BAD_RESULT",
            detail: "the server's session did not carry an id"
          })
        }
        if (contextId.length > 0) {
          yield* Ref.update(sessions, (all) => new Map(all).set(contextId, id.value))
        }
        return id.value
      })

    // --- permissions -------------------------------------------------------

    const answerPermission = (asked: PermissionAsked): Effect.Effect<void> => {
      const permissions = options.permissions
      if (permissions === undefined) return Effect.void
      const project = permissions.projection ?? defaultProjection
      return DelegatedPermission.decide(permissions)({
        callId: asked.id,
        toolName: asked.permission,
        params: asked.metadata,
        projected: project(asked.permission, asked),
        origin: "opencode"
      }).pipe(
        Effect.provideContext(services),
        Effect.flatMap((verdict) =>
          // The third value Claude Code's prompt tool does not have: an
          // approval that the delegated runtime itself remembers, so it stops
          // asking. Our policy remembered it too -- both halves of "always"
          // land, which is the tighter integration the plan predicted.
          //
          // v2 adds a fourth thing: a `message`, so the *reason* a policy
          // refused reaches the delegated agent instead of a bare refusal it
          // has to guess about.
          v2
            ? post(`/api/session/${asked.sessionID}/permission/${asked.id}/reply`, {
              reply: verdict.allow ? (verdict.remember ? "always" : "once") : "reject",
              ...(verdict.reason === undefined ? {} : { message: verdict.reason })
            })
            : post(`/session/${asked.sessionID}/permissions/${asked.id}`, {
              response: verdict.allow ? (verdict.remember ? "always" : "once") : "reject"
            })
        ),
        // A failure to *deliver* the answer must not fail the delegated run:
        // the server will keep waiting, and its own timeout is a better outcome
        // than this bridge tearing the task down over a lost reply.
        Effect.catchCause(() => Effect.void),
        Effect.asVoid
      )
    }

    /** The server's event bus, decoded, filtered to one session. */
    const events = (
      sessionId: string,
      connected: Deferred.Deferred<void>,
      ownMessageId: string
    ) =>
      HttpClientResponse.stream(
        client.execute(HttpClientRequest.get(`${base}${eventPath}`, {
          headers: { accept: "text/event-stream", ...options.headers }
        }))
      ).pipe(
        Stream.decodeText(),
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.mapEffect((event) =>
          // The first frame is `server.connected`, and it is the signal that
          // matters most here: a prompt sent before the subscription is live
          // would have its permission requests asked to nobody.
          Effect.as(Deferred.succeed(connected, undefined), event)
        ),
        Stream.flatMap((event) => {
          const interesting = v2
            ? readEventV2(event.data, sessionId)
            : readEvent(event.data, sessionId, ownMessageId)
          return Option.isSome(interesting) ? Stream.succeed(interesting.value) : Stream.empty
        }),
        Stream.mapError((error): RemoteAgentError => transport(String(error)))
      )

    // --- one delegated task ------------------------------------------------

    const steps = (message: Message): Stream.Stream<Step, RemoteAgentError> =>
      Stream.unwrap(Effect.gen(function* () {
        const contextId = message.contextId
        const taskId = message.taskId.length > 0 ? message.taskId : `${message.messageId}:task`
        const prompt = promptOf(message)
        if (prompt.trim().length === 0) {
          return Stream.fail(
            new AgentA2ARemoteError({
              code: "INVALID_INPUT",
              detail: "the message carried no text; the server has nothing to be asked"
            })
          )
        }
        const sessionId = yield* sessionFor(contextId)
        // One conversation, one run. Two prompts against one OpenCode session
        // is a `SessionBusyError` on its side, and on this side it would make
        // the permission subscription ambiguous -- both runs watch the same
        // session, so both would answer the other's questions.
        const busy = Array.from((yield* Ref.get(running)).values()).some(
          (entry) => entry.sessionId === sessionId
        )
        if (busy) {
          return Stream.fail(
            new AgentA2ARemoteError({
              code: "SESSION_BUSY",
              detail: `${contextId} already has a run in flight; wait for it or use another context`
            })
          )
        }
        yield* Ref.update(running, (all) =>
          new Map(all).set(taskId, { sessionId, contextId, message }))

        // Minted rather than left to the server, so the echo of this very
        // message can be told apart from the agent's answer on the bus.
        const ownMessageId = `msg${taskId.replace(/[^a-zA-Z0-9]/g, "")}${nextMessage++}`
        const body = {
          messageID: ownMessageId,
          parts: [{ type: "text", text: prompt }],
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.agent === undefined ? {} : { agent: options.agent }),
          ...(options.system === undefined ? {} : { system: options.system })
        }

        const terminal = (
          timestamp: string,
          outcome:
            | { readonly _tag: "Answer"; readonly text: string; readonly failed: boolean }
            | { readonly _tag: "Halted" },
          wasCancelled: boolean
        ): Step => {
          const artifact = outcome._tag === "Answer" && !wasCancelled
            ? Option.some(resultArtifact(taskId, outcome.text))
            : Option.none<Artifact>()
          const state = wasCancelled || outcome._tag === "Halted"
            ? TaskState.TASK_STATE_CANCELED
            : outcome.failed
            ? TaskState.TASK_STATE_FAILED
            : TaskState.TASK_STATE_COMPLETED
          return {
            _tag: "Final",
            taskId,
            contextId,
            timestamp,
            artifact,
            task: {
              id: taskId,
              contextId,
              status: { state, message: undefined, timestamp },
              artifacts: Option.isSome(artifact) ? [artifact.value] : [],
              history: [message],
              // The one thing a caller cannot reconstruct: which OpenCode
              // session this conversation is, which is what a follow-up
              // message continues and what `opencode` itself can be pointed at.
              metadata: { openCodeSessionId: sessionId }
            }
          }
        }

        return Stream.callback<Step, RemoteAgentError>((queue) =>
          Effect.gen(function* () {
            const connected = yield* Deferred.make<void>()
            /**
             * v2's answer is not returned by any call -- it arrives as
             * `session.next.text.ended` blocks while the run works, and the run
             * is over when `wait` returns. So the bus is not decoration here:
             * it is where the result comes from.
             */
            const spoken = yield* Ref.make<ReadonlyArray<string>>([])
            const failure = yield* Ref.make(Option.none<string>())
            /**
             * Resolved when the server's agent loop is actually working.
             *
             * `wait` is "wait for the loop to become idle", and a loop that has
             * not started yet *is* idle -- so prompting and immediately waiting
             * returned at once and the answer was read as empty. Observed
             * against a live dev server on 2026-09-01; the bus showed
             * `step.started` and three text deltas arriving after the bridge
             * had already decided the run was over.
             */
            const busy = yield* Deferred.make<void>()

            yield* Effect.forkScoped(
              Stream.runForEach(events(sessionId, connected, ownMessageId), (event) => {
                if (event._tag === "Permission") return answerPermission(event.asked)
                if (event._tag === "Started") {
                  return Effect.asVoid(Deferred.succeed(busy, undefined))
                }
                if (event._tag === "Failed") {
                  // A failure ends the run, so nothing is waiting for it to get
                  // busy any more.
                  return Effect.flatMap(
                    Ref.set(failure, Option.some(event.reason)),
                    () => Effect.asVoid(Deferred.succeed(busy, undefined))
                  )
                }
                return Effect.flatMap(now, (timestamp) =>
                  Effect.flatMap(
                    Ref.update(spoken, (all) => [...all, event.text]),
                    () =>
                      Effect.sync(() => {
                        Queue.offerUnsafe(queue, {
                          _tag: "Working",
                          taskId,
                          contextId,
                          timestamp,
                          text: event.text
                        })
                      })
                  ))
              }).pipe(
                // The bus ending is not the task ending on v1 -- the prompt
                // below is what answers there, and losing progress reports is
                // worth less than losing the answer. However it ends, nothing
                // may still be waiting to be told the subscription is live.
                Effect.catchCause(() => Effect.void),
                Effect.ensuring(Deferred.succeed(connected, undefined))
              )
            )
            // Wait for the bus when there is a stake in it: a permission asked
            // before the subscription is live would be asked of nobody, and on
            // v2 the answer itself would be missed. On v1 with no policy, the
            // stake is a few progress reports, which is not worth delaying
            // every delegated task for.
            if (options.permissions !== undefined || v2) {
              yield* Effect.timeoutOption(
                Deferred.await(connected),
                options.subscribeTimeout ?? "2 seconds"
              )
            }

            const finish = (
              timestamp: string,
              outcome:
                | { readonly _tag: "Answer"; readonly text: string; readonly failed: boolean }
                | { readonly _tag: "Halted" },
              stopped: boolean
            ) => {
              Queue.offerUnsafe(queue, terminal(timestamp, outcome, stopped))
              Queue.endUnsafe(queue)
            }

            if (v2) {
              const admitted = yield* Effect.exit(
                post(`/api/session/${sessionId}/prompt`, { prompt: { text: prompt } })
              )
              if (admitted._tag === "Failure") {
                Queue.failCauseUnsafe(queue, admitted.cause)
                return
              }
              if (Option.isNone(decodeAdmittedV2(admitted.value))) {
                finish(yield* now, { _tag: "Halted" }, false)
                return
              }
              // Busy first: a loop that has not started yet has produced
              // nothing, and polling for its answer would find the previous
              // one. Bounded, because a run that never starts must not hold the
              // caller forever.
              yield* Effect.timeoutOption(
                Deferred.await(busy),
                options.startTimeout ?? "30 seconds"
              )
              /**
               * Then the answer, read from projected state.
               *
               * `wait` would be the obvious completion signal and is documented
               * as one -- it is also `503 "not available yet"` on every build
               * that serves v2 at all. The message projection is not a
               * substitute for it, it is better: `time.completed` is a fact
               * about the finished message, where the bus is a race between the
               * last text block and whoever asked whether the run was over.
               */
              const admittedAt = Option.flatMap(
                decodeAdmittedV2(admitted.value),
                (value) => Option.fromUndefinedOr(value.data.timeCreated)
              )
              const answered = yield* Effect.exit(
                Effect.repeat(
                  Effect.map(
                    get(`/api/session/${sessionId}/message?order=desc&limit=8`),
                    (page) =>
                      Option.flatMap(decodeMessagesV2(page), (messages) =>
                        Option.fromUndefinedOr(
                          messages.data.find((entry) =>
                            entry.type === "assistant" &&
                            entry.time?.completed !== undefined &&
                            // Newer than our own prompt, or it is the answer to
                            // the message before this one.
                            (Option.isNone(admittedAt) ||
                              (entry.time?.created ?? 0) >= admittedAt.value)
                          )
                        ))
                  ),
                  {
                    until: (found) => Option.isSome(found),
                    schedule: Schedule.spaced(options.pollInterval ?? "300 millis")
                  }
                ).pipe(Effect.timeoutOption(options.timeout ?? "10 minutes"))
              )
              const failed = yield* Ref.get(failure)
              if (answered._tag === "Failure") {
                Queue.failCauseUnsafe(queue, answered.cause)
                return
              }
              const text = Option.isSome(failed)
                ? failed.value
                : Option.isSome(answered.value) && Option.isSome(answered.value.value)
                ? (answered.value.value.value.content ?? [])
                  .filter((part) => part.type === "text" && part.text !== undefined)
                  .map((part) => part.text ?? "")
                  .join("")
                : (yield* Ref.get(spoken)).join("")
              finish(
                yield* now,
                { _tag: "Answer", text, failed: Option.isSome(failed) },
                (yield* Ref.get(cancelled)).has(taskId)
              )
              return
            }

            const answer = yield* Effect.exit(post(`/session/${sessionId}/message`, body))
            const timestamp = yield* now
            if (answer._tag === "Failure") {
              Queue.failCauseUnsafe(queue, answer.cause)
              return
            }
            const stopped = (yield* Ref.get(cancelled)).has(taskId)
            const decoded = decodePrompt(answer.value)
            if (Option.isNone(decoded)) {
              finish(timestamp, { _tag: "Halted" }, stopped)
              return
            }
            const text = (decoded.value.parts ?? [])
              .filter((part) => part.type === "text" && part.text !== undefined)
              .map((part) => part.text ?? "")
              .join("")
            finish(timestamp, {
              _tag: "Answer",
              text,
              failed: decoded.value.info?.error !== undefined
            }, stopped)
          })
        ).pipe(
          Stream.tap((step) => step._tag === "Final" ? record(step.task) : Effect.void)
        )
      }))

    const responsesOf = (step: Step): ReadonlyArray<StreamResponse> =>
      step._tag === "Working"
        ? [{
          payload: {
            $case: "statusUpdate",
            value: statusUpdate(
              step.taskId,
              step.contextId,
              TaskState.TASK_STATE_WORKING,
              step.timestamp,
              agentMessage(step.taskId, step.contextId, `working:${step.timestamp}`, step.text),
              false
            )
          }
        }]
        : [
          ...(Option.isSome(step.artifact)
            ? [{
              payload: {
                $case: "artifactUpdate" as const,
                value: {
                  taskId: step.taskId,
                  contextId: step.contextId,
                  artifact: step.artifact.value,
                  append: false,
                  lastChunk: true,
                  metadata: undefined
                }
              }
            }]
            : []),
          {
            payload: {
              $case: "statusUpdate" as const,
              value: statusUpdate(
                step.taskId,
                step.contextId,
                step.task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED,
                step.timestamp,
                undefined,
                true
              )
            }
          }
        ]

    const delegate = (message: Message): Effect.Effect<Task, RemoteAgentError> =>
      Stream.runFold(
        steps(message),
        () => Option.none<Task>(),
        (last, step) => step._tag === "Final" ? Option.some(step.task) : last
      ).pipe(
        Effect.flatMap((task) =>
          Option.isSome(task)
            ? Effect.succeed(task.value)
            : Effect.fail(
              new AgentA2ARemoteError({
                code: "NO_RESULT",
                detail: "the server produced no answer and no terminal state"
              })
            )
        )
      )

    return {
      card: Effect.succeed(card),
      delegate,
      send: (message): Effect.Effect<SendMessageResult, RemoteAgentError> => delegate(message),
      stream: (message) => Stream.flatMap(steps(message), (step) => Stream.fromArray(responsesOf(step))),
      task: (id) =>
        Effect.flatMap(Ref.get(tasks), (all) => {
          const found = all.get(id)
          return found === undefined
            ? Effect.fail(new AgentA2ARemoteError({ code: "TASK_NOT_FOUND", detail: id }))
            : Effect.succeed(found)
        }),
      /**
       * Stop a run through the server's own `abort`.
       *
       * Unlike the Claude Code bridge there is no process to kill: the run
       * lives in the server, so ending it is a request, and interrupting the
       * fibre here would leave it running. That asymmetry is the whole reason
       * `cancel` is on the interface.
       */
      cancel: (id) =>
        Effect.gen(function* () {
          const inFlight = (yield* Ref.get(running)).get(id)
          if (inFlight === undefined) {
            const known = (yield* Ref.get(tasks)).get(id)
            return known === undefined
              ? yield* new AgentA2ARemoteError({ code: "TASK_NOT_FOUND", detail: id })
              : known
          }
          // Marked before the abort is sent, so an answer that races back from
          // the server is still read as the interrupted run it is.
          yield* Ref.update(cancelled, (all) => new Set(all).add(id))
          yield* post(
            v2
              ? `/api/session/${inFlight.sessionId}/interrupt`
              : `/session/${inFlight.sessionId}/abort`,
            {}
          )
          const timestamp = yield* now
          const stopped: Task = {
            id,
            contextId: inFlight.contextId,
            status: {
              state: TaskState.TASK_STATE_CANCELED,
              message: undefined,
              timestamp
            },
            artifacts: [],
            history: [inFlight.message],
            metadata: { openCodeSessionId: inFlight.sessionId }
          }
          yield* record(stopped)
          return stopped
        })
    } satisfies Bridge
  })
