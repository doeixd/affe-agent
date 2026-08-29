import { Cause, Context, Effect, Layer, Option, Ref, Schema, Scope, Stream } from "effect"
import * as History from "../internal/history.js"
import * as PromptWire from "../PromptWire.js"
import * as AgentEvent from "../AgentEvent.js"
import { LanguageModel, Prompt } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import type { AgentDefinition } from "../Agent.js"
import type { AgentEventEnvelope } from "../AgentEvent.js"
import * as AgentSession from "../AgentSession.js"
import type * as Elicitation from "../Elicitation.js"
import { SubmissionId } from "../internal/ids.js"
import {
  AgentBusyError,
  AgentClosedError,
  AgentIdleError
} from "../Errors.js"
import {
  AgentCapacityExceededError,
  AgentForbiddenError,
  AgentInvalidRequestError,
  AgentProtocolCodecError,
  AgentRequestCapacityExceededError,
  AgentRequestConflictError,
  AgentSessionAlreadyExistsError,
  AgentUnauthorizedError
} from "./internal/protocolErrors.js"

/**
 * Talking to a session that may not be in this process.
 *
 * `AgentSession` is a local handle: it carries the agent's tool types, hands
 * back a `GenerateTextResponse`, and fails with whatever the agent's tools and
 * transforms fail with. None of that survives a wire. A caller on the far side
 * of RPC or HTTP has no access to the tool definitions, and a provider response
 * is not a value a protocol can carry.
 *
 * So this is a deliberately narrower surface: the same five operations and the
 * same event stream, in terms that can cross a process boundary. It is the seam
 * adapters implement — RPC, HTTP/SSE, AG-UI, A2A — rather than each inventing
 * its own notion of what a session is.
 *
 * Everything is still an ordinary `Effect` or `Stream`. A remote session is not
 * a second runtime; it is the same vocabulary with a transport underneath.
 */

/**
 * A submission's outcome, in terms a protocol can carry.
 *
 * The local `Result` also holds the final `GenerateTextResponse`, which keeps
 * usage, finish reason and the provider's own parts. That is genuinely useful
 * locally and genuinely not transportable, so it is not carried here: a
 * caller who needs it is asking for a local session. What *is* carried is
 * `content` -- the final message as provider-neutral prompt parts, through
 * the wire codec -- so a model that answered with an image no longer reaches
 * a remote caller as a sentence and nothing else.
 */
export const RemoteResult = Schema.Struct({
  submissionId: SubmissionId,
  status: Schema.Literals(["completed", "interrupted"]),
  runs: Schema.Number,
  turns: Schema.Number,
  text: Schema.String,
  /** The final assistant message: text, reasoning and files, in order. */
  content: Schema.Array(PromptWire.Part)
})
export type RemoteResult = typeof RemoteResult.Type

/**
 * Raised when the transport itself fails, as distinct from the session.
 *
 * The distinction is about *retrying*. A transport failure says nothing about
 * the request — the same call may well succeed on a different connection — so
 * retrying it is reasonable. That only holds if nothing else is wearing this
 * tag.
 */
export class AgentTransportError extends Schema.TaggedError<AgentTransportError>()(
  "AgentTransportError",
  { sessionId: Schema.String, detail: Schema.String }
) {
  override get message() {
    return "Transport failure for session " + this.sessionId + ": " + this.detail
  }
}

/**
 * A session lookup failed without implying that the transport itself failed.
 *
 * Kept apart from `AgentTransportError` for the same reason that one is kept
 * apart from `AgentExecutionError`: a missing session is a property of the
 * request, and a caller retrying on transport failures would otherwise retry
 * `session("unknown")` forever.
 */
export class AgentSessionNotFoundError extends Schema.TaggedError<AgentSessionNotFoundError>()(
  "AgentSessionNotFoundError",
  { sessionId: Schema.String }
) {
  override get message() {
    return `Session ${this.sessionId} does not exist`
  }
}

/**
 * The agent itself failed: a tool, a context transform, the provider.
 *
 * Separate from `AgentTransportError` because conflating them is actively
 * dangerous. These failures are properties of the request — a tool that refuses
 * this input refuses it again — so a caller retrying on transport failure would
 * retry them forever, and each attempt costs a model call. Reporting an agent
 * failure as a transport failure turns a sensible retry policy into a loop.
 *
 * The originating error's `tag` is carried because it is the one thing a remote
 * caller can act on. The typed error itself cannot cross: it may be a tool's
 * declared failure, and the far side has no tool definitions to interpret it.
 */
export class AgentExecutionError extends Schema.TaggedError<AgentExecutionError>()(
  "AgentExecutionError",
  {
    sessionId: Schema.String,
    /** The originating error's `_tag`, or a generic label. */
    tag: Schema.String,
    detail: Schema.String,
    /**
     * Whether the agent *died* rather than failing.
     *
     * A defect is a bug in the agent; a failure is an outcome it declared. A
     * caller cannot recover from either remotely, but it can report them
     * differently, and an operator very much wants to know which happened.
     */
    isDefect: Schema.Boolean
  }
) {
  override get message() {
    return (
      "Session " + this.sessionId + " failed: " + this.tag + ": " + this.detail
    )
  }
}

/**
 * What a remote call can fail with.
 *
 * Every member is a `Schema.TaggedError`, so the union survives the wire, and a
 * caller can tell "this session is busy" from "the transport broke" without
 * either being a defect.
 *
 * This is the *whole* protocol vocabulary, not the six the seam once named.
 * The narrower union was not a smaller promise, it was a wrong one: the HTTP
 * `Api` declares fourteen errors, and the eight this type could not name --
 * authorization, capacity, conflict, codec -- collapsed into
 * `AgentTransportError` on the way out. That tag exists to mean "retrying is
 * reasonable", so a caller with an ordinary retry policy retried a 403 for as
 * long as it was willing to keep asking. A seam has to be able to say what its
 * transports can already say.
 */
export type RemoteError =
  | AgentBusyError
  | AgentIdleError
  | AgentClosedError
  | AgentSessionNotFoundError
  | AgentExecutionError
  | AgentTransportError
  | AgentSessionAlreadyExistsError
  | AgentRequestConflictError
  | AgentRequestCapacityExceededError
  | AgentUnauthorizedError
  | AgentForbiddenError
  | AgentCapacityExceededError
  | AgentInvalidRequestError
  | AgentProtocolCodecError

/**
 * The wire contract, as a schema rather than as six strings.
 *
 * Recognising a `_tag` was not recognition: a tool or a context transform may
 * legally fail with `{ _tag: "AgentBusyError" }`, or with the right tag and
 * malformed fields, and `prompt` then declined to wrap it as an
 * `AgentExecutionError` -- so a value that is not a `RemoteError` was carried
 * under the whole `RemoteError` type, and the RPC or HTTP encoding failed
 * later instead of the agent failure being reported at all.
 *
 * Validating the value is what makes the guard mean what its name says.
 */
const RemoteErrorSchema = Schema.Union([
  AgentBusyError,
  AgentIdleError,
  AgentClosedError,
  AgentSessionNotFoundError,
  AgentExecutionError,
  AgentTransportError,
  AgentSessionAlreadyExistsError,
  AgentRequestConflictError,
  AgentRequestCapacityExceededError,
  AgentUnauthorizedError,
  AgentForbiddenError,
  AgentCapacityExceededError,
  AgentInvalidRequestError,
  AgentProtocolCodecError
])

const decodeRemote = Schema.decodeUnknownOption(RemoteErrorSchema)

/**
 * Whether *everything* in this cause is a remote error.
 *
 * `Cause.findErrorOption` returns the first failure, so a composite cause --
 * two parallel tool calls failing together, say -- was judged by whichever one
 * happened to come first, and unrelated failures travelled beside it under a
 * type that did not describe them.
 */
const isRemoteCause = (cause: Cause.Cause<unknown>): boolean => {
  const failures = cause.reasons.flatMap((reason) =>
    reason._tag === "Fail" ? [reason.error] : [])
  // Every reason must be a failure, and every failure a remote one: a defect
  // or an interruption travelling beside one is not something the wire
  // contract describes either.
  return failures.length === cause.reasons.length &&
    failures.length > 0 &&
    failures.every(isRemote)
}

const isRemote = (error: unknown): error is RemoteError =>
  Option.isSome(decodeRemote(error))

/**
 * Projects a cause the same way `AgentEvent.Failure` does, so the wire and the
 * event stream describe a failure identically.
 */
const describe = (
  cause: Cause.Cause<unknown>
): { readonly tag: string; readonly detail: string; readonly isDefect: boolean } => {
  const failure = AgentEvent.failureFromCause(cause)
  return {
    tag: failure.tag,
    detail: failure.message,
    isDefect: failure.isDefect
  }
}

/**
 * A session, addressed through a transport.
 *
 * The same shape as the local handle — actions as methods, observations as
 * values — so moving between them is a change of import rather than of style.
 */
/**
 * Per-request options a transport can carry.
 *
 * Mirrors `AgentSession.PromptOptions`, minus anything that cannot cross. A
 * seam that exposes the session's operations but not its *modes* is only half
 * a seam: streaming is the reason `events` is on this interface at all, and
 * without this there was no way for a remote caller to ask for it.
 */
export interface RemotePromptOptions {
  /**
   * Stream the model calls, so `MessageDelta` reaches `events`.
   *
   * Whether a consumer sees deltas depends on the transport actually
   * forwarding the event stream; the in-process one does, by being the same
   * stream.
   */
  readonly stream?: boolean | undefined
  /**
   * Names this prompt so a retry is the same request, not a second one.
   *
   * A durable client hands it to the session store's `claim` as the
   * idempotency key: a caller whose acknowledgement was lost retries under the
   * same key and is told what it would have been told the first time, instead
   * of being refused as `Busy` for a submission it does not know it started.
   * The HTTP and RPC adapters forward their `requestId`, which already means
   * exactly this on the wire. The in-process client ignores it -- a local
   * call cannot lose its acknowledgement.
   */
  readonly idempotencyKey?: string | undefined
}

export interface RemoteSession {
  readonly id: string
  readonly prompt: (
    input: Prompt.RawInput,
    options?: RemotePromptOptions
  ) => Effect.Effect<RemoteResult, RemoteError>
  readonly steer: (input: Prompt.RawInput) => Effect.Effect<void, RemoteError>
  readonly followUp: (
    input: Prompt.RawInput
  ) => Effect.Effect<void, RemoteError>
  readonly interrupt: () => Effect.Effect<void, RemoteError>
  /**
   * Answer something the run is waiting for.
   *
   * The remote half of `Elicitation`. Without it a transport can *show* a
   * paused run — `ElicitationRequested` reaches `events` like any other event —
   * and offer no way to unpause it, which is worse than not showing it.
   *
   * `false` when nothing was waiting for that id.
   */
  readonly respond: (
    response: Elicitation.Response
  ) => Effect.Effect<boolean, RemoteError>
  /** What the run is currently waiting to be told. */
  readonly pending: Effect.Effect<
    ReadonlyArray<Elicitation.Request>,
    RemoteError
  >
  readonly history: Effect.Effect<Prompt.Prompt, RemoteError>
  readonly status: Effect.Effect<AgentSession.Status, RemoteError>
  /**
   * The session's events, live or resumed.
   *
   * A function rather than a value because of `after`, and a single function
   * rather than a second `eventsFrom` because there is one question here --
   * "where do I start?" -- and two entry points would only invite an adapter
   * to implement one of them.
   *
   * **`after` is a resumption, and an implementation that cannot honour it
   * must fail rather than quietly returning a live stream.** A caller
   * reconnecting from sequence 41 and silently handed events from 60 onward
   * has lost eighteen events and has no way to find out; that is the failure
   * this parameter exists to prevent, so producing it would be worse than not
   * offering resumption at all. Only a client with a durable log can answer
   * the question, and the in-process one says so.
   */
  readonly events: (options?: {
    /**
     * Resume after this sequence number, rather than from now.
     *
     * Exclusive: the first event delivered is the first one *above* this. A
     * consumer therefore passes the last sequence it actually saw, which is
     * what SSE's `Last-Event-ID` carries and what `DeliveryLog.read` means by
     * the same name.
     */
    readonly after?: number | undefined
  }) => Stream.Stream<AgentEventEnvelope, RemoteError>
}

/** Opens and finds sessions. */
export interface Service {
  /**
   * Open a session.
   *
   * The returned handle is scoped: closing the scope releases whatever the
   * handle itself owns. Whether the underlying *logical* session also ends is
   * the implementation's business. The in-process implementation ends it —
   * a local session's lifetime is its scope — while a durable one does not:
   * its sessions outlive every client handle and are reacquired later with
   * `session(id)`, from any process.
   */
  readonly createSession: (options?: {
    readonly sessionId?: string | undefined
  }) => Effect.Effect<RemoteSession, RemoteError, Scope.Scope>
  /**
   * Reach a session that already exists.
   *
   * For the in-process implementation that means one this client opened and
   * still holds; for a durable one it means one recorded in shared state,
   * whichever process created it and whether or not that process survives.
   */
  readonly session: (
    sessionId: string
  ) => Effect.Effect<RemoteSession, RemoteError>
}

export class AgentClient extends Context.Service<AgentClient, Service>()(
  "@doeixd/effect-agent/AgentClient"
) {}

/**
 * Adapt a local session to the remote surface.
 *
 * Exported because every in-process transport needs it: an RPC *server* holds
 * real sessions and answers with exactly these shapes, so the projection
 * belongs here rather than being rewritten by each adapter.
 *
 * The agent's own failures are not part of the protocol. A caller with no
 * access to the tool definitions cannot act on a tool's typed failure, so those
 * arrive as `AgentExecutionError` carrying the originating tag — honest about
 * what crossed the boundary, instead of pretending a shape survived that did
 * not.
 *
 * They are emphatically *not* reported as transport failures. An agent failure
 * is a property of the request and will recur; a transport failure is not.
 * Wearing the same tag would turn a caller's retry policy into a loop, with a
 * model call on every attempt.
 */
export const fromSession = (
  session: AgentSession.AgentSession<any, any>
): RemoteSession => ({
  id: session.id,
  prompt: (input, options) =>
    session.prompt(input, { stream: options?.stream === true }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause) && !isRemoteCause(cause),
        (cause) =>
          Effect.fail(
            new AgentExecutionError({
              sessionId: session.id,
              ...describe(cause)
            })
          )
      ),
      Effect.map((result) => ({
        submissionId: result.submissionId,
        status: result.status,
        runs: result.runs,
        turns: result.turns,
        text: result.text,
        content: Option.match(result.response, {
          onNone: () => [],
          onSome: (response) => History.assistantContent(response.content)
        })
      }))
    ),
  steer: (input) => session.steer(input),
  followUp: (input) => session.followUp(input),
  interrupt: () => session.interrupt(),
  respond: (response) => AgentSession.respond(session, response),
  pending: AgentSession.pending(session),
  history: session.history,
  status: session.status,
  /**
   * Live only, and explicit about it.
   *
   * An in-process session's events come from a `PubSub` that exists for as
   * long as the session does and remembers nothing. There is no log to read a
   * cursor from, so `after` cannot be honoured -- and answering it with a live
   * stream would hand a reconnecting caller a silent gap. Refusing names the
   * missing capability instead, which is something a deployment can act on:
   * the durable client is the one that can do this.
   */
  events: (options) =>
    options?.after === undefined
      ? session.events
      : Stream.fail(
        new AgentTransportError({
          sessionId: session.id,
          detail:
            "this session has no delivery log, so events cannot be resumed from a sequence; use the durable client for resumable delivery"
        })
      )
})

/**
 * The in-process transport: no transport at all.
 *
 * Useful on its own — an application that runs its agent locally today and
 * remotely tomorrow writes the same code either way — and useful as the
 * reference every other implementation is checked against.
 */
export const layer = <Tools extends Record<string, Tool.Any>, E, R>(
  agent: AgentDefinition<Tools, E, R>,
  /**
   * How the sessions this transport creates are built — where out-of-band
   * input waits, where a paused run waits for an answer.
   *
   * `sessionId` is excluded because the transport assigns it per session, not
   * per client.
   */
  options?: Omit<AgentSession.MakeOptions, "sessionId" | "history">
): Layer.Layer<AgentClient, never, LanguageModel.LanguageModel | R> =>
  Layer.effect(
    AgentClient,
    Effect.gen(function* () {
      const open = yield* Ref.make(new Map<string, RemoteSession>())
      const env = yield* Effect.context<LanguageModel.LanguageModel | R>()

      const createSession: Service["createSession"] = (sessionOptions) =>
        Effect.gen(function* () {
          const session = yield* AgentSession.make(agent, {
            ...options,
            ...(sessionOptions?.sessionId === undefined
              ? {}
              : { sessionId: sessionOptions.sessionId })
          }).pipe(Effect.provide(env))

          const remote = fromSession(session)
          yield* Ref.update(open, (all) => new Map(all).set(remote.id, remote))
          // Forgotten when the caller's scope closes, so a client does not
          // accumulate handles to sessions that no longer exist.
          yield* Effect.addFinalizer(() =>
            Ref.update(open, (all) => {
              const next = new Map(all)
              next.delete(remote.id)
              return next
            })
          )
          return remote
        })

      return {
        createSession,
        session: (sessionId: string) =>
          Effect.flatMap(Ref.get(open), (all) => {
            const found = all.get(sessionId)
            return found === undefined
              ? Effect.fail(new AgentSessionNotFoundError({ sessionId }))
              : Effect.succeed(found)
          })
      }
    })
  )
