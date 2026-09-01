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
import { Clock, Deferred, Duration, Effect, Option, Ref, Schema, Stream } from "effect"
import * as Sandbox from "../sandbox/Sandbox.js"
import {
  AgentA2ARemoteError,
  AgentA2ATransportError,
  type RemoteAgent,
  type RemoteAgentError
} from "./AgentA2A.js"

/**
 * Claude Code as an A2A agent.
 *
 * `docs/plan-a2a-layers-bridges.txt` argues the case and this module is its
 * step 1: **a coding CLI is an agent, not a model.** Putting it behind
 * `LanguageModel` would nest one agent loop inside another and call the inner
 * one a model; putting it behind A2A says what it is -- an autonomous peer with
 * its own loop, tools, workspace and session state -- and costs nothing extra,
 * because `AgentA2A.tool` already turns any `RemoteAgent` into an ordinary tool
 * of this agent's. The contrast that makes the distinction visible is
 * `examples/openrouter.ts`: a model gateway *is* a model API and nests under
 * `LanguageModel` with nothing left over.
 *
 * Everything runs through `Sandbox`, which is the plan's physical boundary
 * (§"Physical boundary"): the CLI is spawned inside the workspace, under the
 * sandbox's timeout and output bounds, and this module imports no `node:*` --
 * the host arrives as a provider layer, so the same bridge works against a
 * remote sandbox with no change.
 *
 * ```ts
 * const claude = yield* ClaudeCodeA2A.remote(sandbox)
 * const Manager = Agent.make({
 *   tools: [AgentA2A.tool("claude_coder", {
 *     agent: claude,
 *     request: Schema.Struct({ task: Schema.String }),
 *     result: Schema.String
 *   })]
 * })
 * ```
 *
 * **Permissions are opt-in, and separate.** On its own this module does not
 * re-implement Claude Code's permission model: the CLI decides what it may do,
 * from its own flags and settings, and the sandbox is the only boundary. To put
 * this application's policy in front of the CLI's own tool calls, add
 * `ClaudeCodePermissions` -- its `args` are `extraArgs` here, and its `layer`
 * serves the decision. Without it, choose the workspace accordingly and prefer
 * explicit `allowedTools` over a broad permission mode.
 */

// ---------------------------------------------------------------------------
// Options

export interface Options {
  /** The program to run. Default `claude`; a path or a wrapper works too. */
  readonly executable?: string | undefined
  /** Model passed through as `--model`. Omitted, the CLI chooses. */
  readonly model?: string | undefined
  /**
   * Tools the CLI may use without prompting (`--allowedTools`).
   *
   * There is no interactive terminal behind a bridged run, so a prompt the CLI
   * cannot ask has to be answered by configuration. Naming the tools is the
   * narrow way to do that; `permissionMode` is the broad one.
   */
  readonly allowedTools?: ReadonlyArray<string> | undefined
  /** `--permission-mode`, e.g. `acceptEdits`. Omitted, the CLI's default holds. */
  readonly permissionMode?: string | undefined
  /**
   * `--bare`: skip discovery of hooks, plugins, MCP servers and `CLAUDE.md`.
   *
   * Default `true` here, and deliberately not the CLI's default. A bridged run
   * is a scripted one: whatever sits in the workspace or in the host's
   * `~/.claude` should not silently change what a delegated task does, and a
   * bridge whose behaviour depends on the machine it runs on is not portable in
   * any sense this repository means by the word.
   */
  readonly bare?: boolean | undefined
  /** Anything else, appended verbatim after the flags above. */
  readonly extraArgs?: ReadonlyArray<string> | undefined
  /**
   * How long a single delegated task may run. Default 10 minutes.
   *
   * `Sandbox`'s own default is 10 seconds, which is right for a command you
   * wait on and absurd for an agent doing a coding task.
   */
  readonly timeout?: Duration.Input | undefined
  /** Output bound for one run. Default 32 MiB, for the same reason. */
  readonly maxOutputBytes?: number | undefined
  /**
   * How many finished tasks stay fetchable by `task(id)`. Default 256.
   *
   * A bridge is meant to be long-lived -- one manager delegating all day -- and
   * a task carries the CLI's whole answer, so remembering every one of them
   * without a bound is a leak that only shows up in the deployments that matter
   * most. The oldest are dropped first; a caller who needs them kept has them
   * already, in the value `delegate` returned.
   */
  readonly historyLimit?: number | undefined
  /** Name and version reported on the generated Agent Card. */
  readonly card?:
    | { readonly name?: string | undefined; readonly version?: string | undefined }
    | undefined
}

const DEFAULT_TIMEOUT = "10 minutes"
const DEFAULT_MAX_OUTPUT = 32 * 1024 * 1024
const DEFAULT_HISTORY = 256

// ---------------------------------------------------------------------------
// The CLI's stream-json, read for exactly what a bridge needs

/**
 * One line of `--output-format stream-json`, decoded permissively.
 *
 * The CLI's event vocabulary is larger than this and grows; a bridge that
 * required the whole of it would break on the next release for no benefit. So
 * every field is optional, unknown `type`s are ignored, and only three things
 * are actually read: the session id (to resume), assistant text (to report
 * progress), and the terminal `result` (the answer, and whether it failed).
 */
const Line = Schema.Struct({
  type: Schema.optional(Schema.String),
  subtype: Schema.optional(Schema.String),
  session_id: Schema.optional(Schema.String),
  is_error: Schema.optional(Schema.Boolean),
  result: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.Unknown)
})

const decodeLine = Schema.decodeUnknownOption(Line)

/** The text blocks of an `assistant` line's Anthropic-shaped message. */
const assistantText = (message: unknown): string => {
  if (typeof message !== "object" || message === null) return ""
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ""
  let text = ""
  for (const block of content) {
    if (
      typeof block === "object" && block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      text += (block as { text: string }).text
    }
  }
  return text
}

/** What a `result` line carries as the answer, however it is shaped. */
const resultText = (value: unknown): string =>
  typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value)

interface Parsed {
  readonly sessionId: Option.Option<string>
  readonly assistant: Option.Option<string>
  readonly result: Option.Option<{ readonly text: string; readonly failed: boolean }>
}

const nothing: Parsed = {
  sessionId: Option.none(),
  assistant: Option.none(),
  result: Option.none()
}

/**
 * A line as the three facts above.
 *
 * A line that is not JSON is not an error: the CLI writes warnings and
 * progress to the same stream, and refusing the whole run over one of them
 * would make the bridge less reliable than the thing it wraps.
 */
export const parseLine = (line: string): Parsed => {
  const trimmed = line.trim()
  if (trimmed.length === 0 || !trimmed.startsWith("{")) return nothing
  let json: unknown
  try {
    json = JSON.parse(trimmed)
  } catch {
    return nothing
  }
  const decoded = decodeLine(json)
  if (Option.isNone(decoded)) return nothing
  const value = decoded.value
  const sessionId = value.session_id === undefined || value.session_id.length === 0
    ? Option.none<string>()
    : Option.some(value.session_id)
  if (value.type === "result") {
    return {
      sessionId,
      assistant: Option.none(),
      result: Option.some({
        text: resultText(value.result),
        // `is_error` is the CLI's own verdict; `subtype` says which failure it
        // was. Either one saying so is enough to not call the run a success.
        failed: value.is_error === true ||
          (value.subtype !== undefined && value.subtype !== "success")
      })
    }
  }
  if (value.type === "assistant") {
    const text = assistantText(value.message)
    return {
      sessionId,
      assistant: text.length === 0 ? Option.none() : Option.some(text),
      result: Option.none()
    }
  }
  return { sessionId, assistant: Option.none(), result: Option.none() }
}

// ---------------------------------------------------------------------------
// A2A values
//
// Small constructors rather than a shared internal module: `AgentA2A`'s are
// the server's, shaped by what a run of *this* library produces, and the two
// would only be one function if the bridge pretended to be that server.

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
  name: "Claude Code result",
  description: "The final result reported by the Claude Code CLI",
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

const taskOf = (options: {
  readonly taskId: string
  readonly contextId: string
  readonly state: TaskState
  readonly timestamp: string
  readonly history: ReadonlyArray<Message>
  readonly artifacts: ReadonlyArray<Artifact>
  readonly sessionId: Option.Option<string>
}): Task => ({
  id: options.taskId,
  contextId: options.contextId,
  status: { state: options.state, message: undefined, timestamp: options.timestamp },
  artifacts: [...options.artifacts],
  history: [...options.history],
  // The one thing a caller cannot reconstruct and may well want: the CLI's own
  // session id, which is what `--resume` takes and what the bridge keys its
  // context mapping on.
  metadata: Option.isSome(options.sessionId)
    ? { claudeSessionId: options.sessionId.value }
    : undefined
})

/** The A2A message's text, which is all a `claude -p` prompt can be. */
const promptOf = (message: Message): string => {
  let text = ""
  for (const part of message.parts) {
    if (part.content?.$case === "text") text += part.content.value
  }
  return text
}

// ---------------------------------------------------------------------------
// The run

/** One thing the bridge decided while reading the stream. */
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

/** What the pure fold over lines can decide without a clock. */
type Emitted =
  | { readonly _tag: "Assistant"; readonly text: string }
  | { readonly _tag: "Result"; readonly text: string; readonly failed: boolean }
  | { readonly _tag: "Halted"; readonly sessionId: Option.Option<string> }

interface Accumulated {
  readonly sessionId: Option.Option<string>
  readonly done: boolean
}

const argsFor = (
  options: Options,
  prompt: string,
  resume: Option.Option<string>
): ReadonlyArray<string> => [
  ...(options.bare === false ? [] : ["--bare"]),
  "-p",
  prompt,
  "--output-format",
  "stream-json",
  // Required by the CLI alongside `stream-json`, and the reason the bridge can
  // report progress at all.
  "--verbose",
  ...(Option.isSome(resume) ? ["--resume", resume.value] : []),
  ...(options.model === undefined ? [] : ["--model", options.model]),
  ...(options.permissionMode === undefined ? [] : ["--permission-mode", options.permissionMode]),
  ...(options.allowedTools === undefined || options.allowedTools.length === 0
    ? []
    : ["--allowedTools", options.allowedTools.join(",")]),
  ...(options.extraArgs ?? [])
]

const cardFor = (options: Options): AgentCard => ({
  name: options.card?.name ?? "Claude Code",
  description:
    "Anthropic's Claude Code CLI, bridged as an A2A agent. It runs its own agent loop, tools and session inside the sandbox workspace it is given.",
  // No interface is advertised, because there is no endpoint: this agent is
  // reached in-process through the bridge, not over a URL. Saying so is more
  // honest than inventing one.
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
    description: "Read, write and run code in the workspace, and report what was done.",
    tags: ["coding", "files", "shell"],
    examples: ["Fix the failing test in src/auth.ts", "Explain what this module does"],
    inputModes: ["text/plain"],
    outputModes: ["text/plain"],
    securityRequirements: []
  }],
  signatures: []
})

/**
 * A bridged runtime, which is a `RemoteAgent` and one thing more.
 *
 * `send` is A2A's, and A2A's answer is `Message | Task` because a peer may
 * reply either way. This peer never replies with a bare message -- a delegated
 * coding task is always a task -- so `delegate` says that in the type and
 * spares every caller a narrowing that can only go one way.
 */
export interface Bridge extends RemoteAgent {
  readonly delegate: (message: Message) => Effect.Effect<Task, RemoteAgentError>
}

/** A run in flight: how to stop it, and how to learn what it settled as. */
interface Running {
  readonly stop: Deferred.Deferred<void>
  readonly settled: Deferred.Deferred<Task>
}

/**
 * A bridged Claude Code, ready to be sent A2A messages.
 *
 * The sandbox is a value rather than a requirement because `RemoteAgent`'s
 * methods carry no services -- an A2A peer is reached, not provided -- so the
 * capability is captured here, once, where the caller can see which workspace
 * it is.
 */
export const remote = (
  sandbox: Sandbox.Sandbox,
  options?: Options
): Effect.Effect<Bridge> =>
  Effect.gen(function* () {
    const config = options ?? {}
    const executable = config.executable ?? "claude"
    const card = cardFor(config)

    /** A2A context id -> the CLI session id `--resume` takes. */
    const sessions = yield* Ref.make(new Map<string, string>())
    /** Every task this bridge has produced, for `task(id)`. */
    const tasks = yield* Ref.make(new Map<string, Task>())
    /** Runs still going, and the switch `cancel` throws. */
    const running = yield* Ref.make(new Map<string, Running>())

    const now = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString())

    const forget = (taskId: string) =>
      Ref.update(running, (all) => {
        if (!all.has(taskId)) return all
        const next = new Map(all)
        next.delete(taskId)
        return next
      })

    const historyLimit = Math.max(1, config.historyLimit ?? DEFAULT_HISTORY)

    const record = (task: Task) =>
      Effect.gen(function* () {
        yield* Ref.update(tasks, (all) => {
          const next = new Map(all)
          // Re-inserting moves it to the end, so the eviction order is "least
          // recently finished" rather than "first ever seen".
          next.delete(task.id)
          next.set(task.id, task)
          while (next.size > historyLimit) {
            const oldest = next.keys().next()
            if (oldest.done === true) break
            next.delete(oldest.value)
          }
          return next
        })
        const sessionId = (task.metadata as { claudeSessionId?: string } | undefined)?.claudeSessionId
        if (sessionId !== undefined && task.contextId.length > 0) {
          yield* Ref.update(sessions, (all) => new Map(all).set(task.contextId, sessionId))
        }
        const inFlight = (yield* Ref.get(running)).get(task.id)
        if (inFlight !== undefined) yield* Deferred.succeed(inFlight.settled, task)
        yield* forget(task.id)
      })

    const steps = (message: Message): Stream.Stream<Step, RemoteAgentError> =>
      Stream.unwrap(Effect.gen(function* () {
        const contextId = message.contextId
        const taskId = message.taskId.length > 0 ? message.taskId : `${message.messageId}:task`
        const prompt = promptOf(message)
        if (prompt.trim().length === 0) {
          return Stream.fail(
            new AgentA2ARemoteError({
              code: "INVALID_INPUT",
              detail: "the message carried no text; the CLI has nothing to be asked"
            })
          )
        }
        // Two runs under one task id would leave `cancel(id)` pointing at
        // whichever registered last, and the other one unstoppable. The id is
        // the caller's to choose, so this is their mistake to hear about.
        if ((yield* Ref.get(running)).has(taskId)) {
          return Stream.fail(
            new AgentA2ARemoteError({
              code: "TASK_ALREADY_RUNNING",
              detail: `${taskId} is already running; give the second message its own task id`
            })
          )
        }
        const resume = contextId.length === 0
          ? Option.none<string>()
          : Option.fromUndefinedOr((yield* Ref.get(sessions)).get(contextId))

        const stop = yield* Deferred.make<void>()
        const settled = yield* Deferred.make<Task>()
        yield* Ref.update(running, (all) => new Map(all).set(taskId, { stop, settled }))

        const command = Sandbox.command(executable, argsFor(config, prompt, resume))
        const lines = Sandbox.lines(
          sandbox.execStream(command, {
            timeout: config.timeout ?? DEFAULT_TIMEOUT,
            maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT
          })
        ).pipe(
          // The sandbox's failures are this bridge's transport failures: the
          // process is the wire.
          Stream.mapError((error): RemoteAgentError =>
            new AgentA2ATransportError({ detail: error.message })
          ),
          Stream.interruptWhen(Deferred.await(stop))
        )

        const terminal = (
          state: { readonly sessionId: Option.Option<string> },
          timestamp: string,
          outcome:
            | { readonly _tag: "Result"; readonly text: string; readonly failed: boolean }
            | { readonly _tag: "Halted" }
        ): Step => {
          const artifact = outcome._tag === "Result"
            ? Option.some(resultArtifact(taskId, outcome.text))
            : Option.none<Artifact>()
          const state_ = outcome._tag === "Halted"
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
            task: taskOf({
              taskId,
              contextId,
              state: state_,
              timestamp,
              history: [message],
              artifacts: Option.isSome(artifact) ? [artifact.value] : [],
              sessionId: state.sessionId
            })
          }
        }

        return lines.pipe(
          Stream.mapAccum(
            (): Accumulated => ({ sessionId: Option.none(), done: false }),
            (state, line): readonly [Accumulated, ReadonlyArray<readonly [Accumulated, Emitted]>] => {
              const parsed = parseLine(line)
              const sessionId = Option.isSome(parsed.sessionId) ? parsed.sessionId : state.sessionId
              if (Option.isSome(parsed.result)) {
                const next: Accumulated = { sessionId, done: true }
                return [next, [[next, {
                  _tag: "Result",
                  text: parsed.result.value.text,
                  failed: parsed.result.value.failed
                }]]]
              }
              const next: Accumulated = { sessionId, done: state.done }
              return Option.isSome(parsed.assistant)
                ? [next, [[next, { _tag: "Assistant", text: parsed.assistant.value }]]]
                : [next, []]
            },
            {
              // The stream ended with no `result`: the run was cancelled, or the
              // process died without reporting. Either way the task is not
              // completed, and saying so is the point -- a caller must never read
              // "it worked" from "it stopped".
              onHalt: (state) =>
                state.done ? [] : [[state, { _tag: "Halted", sessionId: state.sessionId }] as const]
            }
          ),
          // The clock cannot be read inside a pure fold, so the timestamps and
          // the task values are built here.
          Stream.mapEffect(([state, emitted]) =>
            Effect.map(now, (timestamp): Step =>
              emitted._tag === "Assistant"
                ? { _tag: "Working", taskId, contextId, timestamp, text: emitted.text }
                : terminal(state, timestamp, emitted)
            )
          ),
          Stream.tap((step) => step._tag === "Final" ? record(step.task) : Effect.void),
          // A run whose consumer walked away leaves nothing behind claiming to
          // be in flight: the process itself dies with the sandbox stream's
          // scope, and this is the bookkeeping that goes with it.
          Stream.ensuring(forget(taskId))
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
                detail: "the CLI produced no result and no terminal state"
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
       * Stop a run, and report the task it became.
       *
       * The switch is a `Deferred` the stream is interrupted by, so the CLI is
       * killed by the sandbox scope closing -- the same mechanism an ordinary
       * fiber interruption uses, which is what a caller composing this with
       * `Effect` will reach for first. This exists for the callers who cannot:
       * an A2A client holding a task id and no fiber.
       *
       * It waits for the run to actually settle, because a `cancel` that
       * returns before the process is gone is a lie a supervisor would act on.
       * The wait is bounded: nobody consuming the stream means nobody to
       * observe the interruption, and hanging forever would be worse than
       * saying so.
       */
      cancel: (id) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(running)).get(id)
          if (pending === undefined) {
            const known = (yield* Ref.get(tasks)).get(id)
            return known === undefined
              ? yield* new AgentA2ARemoteError({ code: "TASK_NOT_FOUND", detail: id })
              : known
          }
          yield* Deferred.succeed(pending.stop, undefined)
          const settled = yield* Effect.timeoutOption(Deferred.await(pending.settled), "30 seconds")
          return Option.isSome(settled)
            ? settled.value
            : yield* new AgentA2ARemoteError({
              code: "CANCEL_NOT_OBSERVED",
              detail:
                `the run for ${id} was signalled but nothing was consuming its stream, so it did not settle`
            })
        })
    } satisfies Bridge
  })
