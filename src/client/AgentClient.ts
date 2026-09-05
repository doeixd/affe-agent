import { Cause, Context, Deferred, Effect, Layer, Option, Ref, Schema, Scope, Stream } from "effect"
import * as History from "../internal/history.js"
import { positiveInteger } from "../internal/positive.js"
import * as PromptWire from "../PromptWire.js"
import * as AgentEvent from "../AgentEvent.js"
import * as AgentOutput from "../AgentOutput.js"
import { LanguageModel, Prompt } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import type { AgentDefinition } from "../Agent.js"
import type { AgentEventEnvelope } from "../AgentEvent.js"
import * as AgentInput from "../AgentInput.js"
import * as InputBoundary from "../internal/inputBoundary.js"
import * as AgentSession from "../AgentSession.js"
import type * as Elicitation from "../Elicitation.js"
import { SubmissionId } from "../internal/ids.js"
import {
  AgentBusyError,
  AgentClosedError,
  AgentIdleError,
  AgentSubmissionNotFoundError
} from "../Errors.js"
import {
  AgentCapacityExceededError,
  AgentForbiddenError,
  AgentInvalidRequestError,
  AgentProtocolCodecError,
  AgentRequestCapacityExceededError,
  AgentRequestConflictError,
  AgentSessionAlreadyExistsError,
  AgentUnauthorizedError,
  RequestId
} from "./internal/protocolErrors.js"
import * as Namespace from "../internal/namespace.js"

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
  content: Schema.Array(PromptWire.Part),
  /** Why the last run stopped, when its loop said (`AgentSubmission.Result.stopReason`). */
  stopReason: Schema.optional(Schema.String),
  /**
   * The agent's declared output, encoded, when it declares one and produced it.
   *
   * Deliberately opaque here. This schema is shared by every agent, so it
   * cannot name any particular agent's `Value`; what crosses is the encoded
   * form, and the *caller* names what it expects -- `typedSession` decodes it
   * with the agent's own output schema. The alternative, publishing the schema
   * for a caller to fetch, buys nothing: you would still decode at the call
   * site, and a published schema that drifts from its agent silently mistypes
   * every consumer.
   *
   * For an agent with no declared output it is the final text, so every
   * completed result carries one. Absent when a declared output's run ended
   * without producing one -- interrupted, or stopped before it answered --
   * and absent from a host older than `plan-input-default.md` step 5, which
   * is why the field stays optional on the schema.
   */
  value: Schema.optional(Schema.Unknown)
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
  | AgentSubmissionNotFoundError

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
  AgentProtocolCodecError,
  AgentSubmissionNotFoundError
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

/** What `submit` hands back: the admitted submission's id, and nothing else. */
export const SubmissionReceipt = Schema.Struct({ submissionId: SubmissionId })
export type SubmissionReceipt = typeof SubmissionReceipt.Type

/**
 * What a remote session is asked with: a raw prompt, or the session's
 * encoded input.
 *
 * The host decodes it with the session's agent's schema and refuses what
 * does not fit as `AgentInvalidRequestError`. `typed` below is the spelling
 * that never lets a caller build the wire form by hand.
 */
export type RemoteInput = InputBoundary.RemoteInput

export interface RemoteSession {
  readonly id: string
  readonly prompt: (
    input: RemoteInput,
    options?: RemotePromptOptions
  ) => Effect.Effect<RemoteResult, RemoteError>
  /**
   * Admit a submission and return at admission, not at quiescence.
   *
   * `idempotencyKey` makes a retry the same submission: same key and same
   * request join the receipt already given, a different request under the
   * same key is `AgentRequestConflictError`.
   */
  readonly submit: (
    input: RemoteInput,
    options?: RemotePromptOptions
  ) => Effect.Effect<SubmissionReceipt, RemoteError>
  /**
   * What `prompt` would have returned for a submitted submission.
   *
   * Joins one still running; returns the retained outcome of one that
   * settled, failure included; `AgentSubmissionNotFoundError` for one this
   * session does not hold, which after enough newer submissions includes
   * ones it once did -- retention is bounded, and stated, in
   * `docs/plan-submit-await.md`.
   */
  readonly awaitSubmission: (
    submissionId: string
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
  Namespace.tag("AgentClient")
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
export const fromSession = <Value, Input>(
  session: AgentSession.AgentSession<any, any, Value, Input>,
  options: {
    /** Where settled outcomes are observed; the session's own scope. */
    readonly scope: Scope.Scope
    /** How many submissions' outcomes this session keeps. */
    readonly maxRetainedSubmissions: number
    /**
     * The agent's declared output, when it has one.
     *
     * Passed in rather than read off the session, because a session does not
     * carry its agent's schemas -- and a host that does not supply it simply
     * does not carry the typed value, which is what every host did until now.
     */
    readonly output?: Option.Option<AgentOutput.AgentOutput<any, any>> | undefined
  }
): RemoteSession => {
  const capacity = positiveInteger(
    "AgentClient maxRetainedSubmissions",
    options.maxRetainedSubmissions
  )
  const sessionId = session.id

  /** An agent failure, or an interruption, as the protocol reports it. */
  // The session is `AgentSession<any, any>`, so what it fails with is `any`
  // here already; the mapping below is what makes the result honest.
  const remote = <A>(effect: Effect.Effect<A, any>): Effect.Effect<A, RemoteError> =>
    effect.pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause) && !isRemoteCause(cause),
        (cause) =>
          Effect.fail(
            new AgentExecutionError({
              sessionId: session.id,
              ...describe(cause)
            })
          )
      )
    )

  const declaredOutput = options.output ?? Option.none()

  const toRemoteResult = (
    result: AgentSession.Result<any, any>
  ): Effect.Effect<RemoteResult> =>
    Effect.map(
      // The default output's value is the text, already a wire value; a
      // declared output's is encoded with its schema, or absent when the run
      // ended without reaching one.
      Option.match(declaredOutput, {
        onNone: () => Effect.succeed(result.value as Option.Option<unknown>),
        onSome: (output) =>
          Option.match(result.value, {
            onNone: () => Effect.succeedNone,
            onSome: (value) => Effect.asSome(AgentOutput.encode(output, value))
          })
      }),
      (encoded) => ({
        submissionId: result.submissionId,
        status: result.status,
        runs: result.runs,
        turns: result.turns,
        text: result.text,
        content: Option.match(result.response, {
          onNone: () => [],
          onSome: (response) => History.assistantContent(response.content)
        }),
        ...(Option.isSome(result.stopReason) ? { stopReason: result.stopReason.value } : {}),
        ...(Option.isSome(encoded) ? { value: encoded.value } : {})
      })
    )

  /**
   * The retained outcomes, oldest first.
   *
   * The retention contract, as implemented: an outcome is kept until it has
   * settled *and* the table needs its slot for a newer submission; a slot is
   * never taken from a submission still running -- with the table full of
   * those, admission fails with `AgentRequestCapacityExceededError` rather
   * than evicting live work. `Map` iteration is insertion order, which is
   * age.
   */
  const retained = new Map<
    string,
    {
      readonly outcome: Deferred.Deferred<RemoteResult, RemoteError>
      settled: boolean
      /** The idempotency key this submission was admitted under, if any. */
      readonly key: string | undefined
    }
  >()
  /**
   * Idempotency keys, for as long as their submission is retained: a retry
   * under a key joins its receipt, a different request under it is a
   * conflict. Lives and dies with the outcome table, so the two make one
   * promise -- see `docs/plan-submit-await.md`.
   */
  const byKey = new Map<string, { readonly fingerprint: string; readonly submissionId: string }>()

  const fingerprintOf = (input: RemoteInput, stream: boolean): Effect.Effect<string, RemoteError> =>
    // The wire form, whichever way it arrived: a raw prompt encodes to the
    // prompt wire, an encoded value is already it.
    (AgentInput.isRaw(input)
      ? Schema.encodeUnknownEffect(AgentInput.prompt.schema)(input).pipe(
        Effect.mapError((error) =>
          new AgentInvalidRequestError({ operation: "submit", detail: error.message })
        )
      )
      : Effect.succeed(input)).pipe(
        Effect.map((encoded) => JSON.stringify({ input: encoded, stream }))
      )

  // The boundary decode, in the one place every boundary shares; see
  // `internal/inputBoundary.ts` for why `asked` is the one widening.
  const admit = (operation: "prompt" | "submit", input: RemoteInput) =>
    Effect.map(InputBoundary.admit(session, operation, input), (admitted) =>
      InputBoundary.asked<Input>(admitted.asked))

  const remember = (
    submissionId: string,
    outcome: Effect.Effect<RemoteResult, RemoteError>,
    key?: string
  ): Effect.Effect<void, RemoteError> =>
    Effect.gen(function* () {
      if (retained.has(submissionId)) return
      while (retained.size >= capacity) {
        const evictable = Array.from(retained).find(([, entry]) => entry.settled)
        if (evictable === undefined) {
          return yield* new AgentRequestCapacityExceededError({
            sessionId: Option.some(sessionId),
            capacity
          })
        }
        const [evictedId, evicted] = evictable
        retained.delete(evictedId)
        if (evicted.key !== undefined) byKey.delete(evicted.key)
      }
      const entry = { outcome: yield* Deferred.make<RemoteResult, RemoteError>(), settled: false, key }
      retained.set(submissionId, entry)
      // Observed in the session's scope, not the submitter's: the submitter
      // returned at admission and may be long gone when the outcome lands.
      yield* Effect.forkIn(
        Deferred.complete(entry.outcome, outcome).pipe(
          Effect.ensuring(Effect.sync(() => { entry.settled = true }))
        ),
        options.scope
      )
    })

  const awaitSubmission = (submissionId: string): Effect.Effect<RemoteResult, RemoteError> => {
    const entry = retained.get(submissionId)
    return entry === undefined
      ? Effect.fail(new AgentSubmissionNotFoundError({ sessionId, submissionId: SubmissionId.make(submissionId) }))
      : Deferred.await(entry.outcome)
  }

  return {
    id: session.id,
    prompt: (input, promptOptions) =>
      admit("prompt", input).pipe(
        Effect.flatMap((value) => remote(session.prompt(value, { stream: promptOptions?.stream === true }))),
        Effect.flatMap(toRemoteResult),
        // A prompted outcome is retained like a submitted one, so the two
        // surfaces tell one story about what this session has done.
        Effect.tap((result) => remember(result.submissionId, Effect.succeed(result)))
      ),
    submit: (raw, promptOptions) =>
      Effect.gen(function* () {
        const stream = promptOptions?.stream === true
        const key = promptOptions?.idempotencyKey
        const input = yield* admit("submit", raw)
        if (key !== undefined) {
          const fingerprint = yield* fingerprintOf(raw, stream)
          const known = byKey.get(key)
          if (known !== undefined) {
            if (known.fingerprint !== fingerprint) {
              return yield* new AgentRequestConflictError({
                sessionId: Option.some(sessionId),
                requestId: RequestId.make(key)
              })
            }
            return { submissionId: SubmissionId.make(known.submissionId) }
          }
          const receipt = yield* remote(session.submit(input, { stream }))
          yield* remember(
            receipt.submissionId,
            remote(session.awaitSubmission(receipt.submissionId)).pipe(Effect.flatMap(toRemoteResult)),
            key
          )
          byKey.set(key, { fingerprint, submissionId: receipt.submissionId })
          return receipt
        }
        const receipt = yield* remote(session.submit(input, { stream }))
        yield* remember(
          receipt.submissionId,
          remote(session.awaitSubmission(receipt.submissionId)).pipe(Effect.flatMap(toRemoteResult))
        )
        return receipt
      }),
    awaitSubmission,
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
    events: (eventOptions) =>
      eventOptions?.after === undefined
        ? session.events
        : Stream.fail(
          new AgentTransportError({
            sessionId: session.id,
            detail:
              "this session has no delivery log, so events cannot be resumed from a sequence; use the durable client for resumable delivery"
          })
        )
  }
}

/** Re-exported so the protocol modules can name it beside the other client errors. */
export { AgentSubmissionNotFoundError }

/** Outcomes a session keeps by default; see `layer`. */
const defaultRetainedSubmissions = 64

/**
 * The in-process transport: no transport at all.
 *
 * Useful on its own — an application that runs its agent locally today and
 * remotely tomorrow writes the same code either way — and useful as the
 * reference every other implementation is checked against.
 */
export const layer = <Tools extends Record<string, Tool.Any>, E, R, Model, Value, Input>(
  agent: AgentDefinition<Tools, E, R, Model, Value, Input>,
  /**
   * How the sessions this transport creates are built — where out-of-band
   * input waits, where a paused run waits for an answer.
   *
   * `sessionId` is excluded because the transport assigns it per session, not
   * per client.
   */
  options?: Omit<AgentSession.MakeOptions, "sessionId" | "history"> & {
    /**
     * How many submissions' outcomes each session keeps for
     * `awaitSubmission`. Default 64. A settled outcome is evicted only to
     * admit a newer submission; a running one never is. See
     * `docs/plan-submit-await.md`.
     */
    readonly maxRetainedSubmissions?: number | undefined
  }
): Layer.Layer<AgentClient, never, Model | R> =>
  Layer.effect(
    AgentClient,
    Effect.gen(function* () {
      const open = yield* Ref.make(new Map<string, RemoteSession>())
      const env = yield* Effect.context<Model | R>()

      const createSession: Service["createSession"] = (sessionOptions) =>
        Effect.gen(function* () {
          const { maxRetainedSubmissions, ...sessionMake } = options ?? {}
          const session = yield* AgentSession.make(agent, {
            ...sessionMake,
            ...(sessionOptions?.sessionId === undefined
              ? {}
              : { sessionId: sessionOptions.sessionId })
          }).pipe(Effect.provide(env))

          const remote = fromSession(session, {
            output: agent.output,
            scope: yield* Effect.scope,
            maxRetainedSubmissions: maxRetainedSubmissions ?? defaultRetainedSubmissions
          })
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

// -- Typed sessions -----------------------------------------------------------------

/**
 * A remote session whose `prompt` and `submit` take the agent's `Input`:
 * the schema's type, or `Prompt.RawInput` for an agent with the default
 * input. Everything else is the `RemoteSession` it wraps.
 */
/**
 * A result whose declared output has been read back.
 *
 * `value` is `None` for an agent that declares no output, and for a run that
 * ended without producing one -- interrupted, or stopped before it answered.
 * The two are different facts and both mean "there is nothing to read".
 */
export interface TypedResult<Value> extends RemoteResult {
  readonly value: Option.Option<Value>
}

export interface TypedSession<Input, Value = string>
  extends Omit<RemoteSession, "prompt" | "submit" | "awaitSubmission">
{
  readonly prompt: (
    input: Input,
    options?: RemotePromptOptions
  ) => Effect.Effect<TypedResult<Value>, RemoteError>
  readonly submit: (
    input: Input,
    options?: RemotePromptOptions
  ) => Effect.Effect<SubmissionReceipt, RemoteError>
  readonly awaitSubmission: (
    submissionId: string
  ) => Effect.Effect<TypedResult<Value>, RemoteError>
}

/** `Service`, with its sessions typed by the agent's input and output. */
export interface TypedService<Input, Value = string> {
  readonly createSession: (options?: {
    readonly sessionId?: string | undefined
  }) => Effect.Effect<TypedSession<Input, Value>, RemoteError, Scope.Scope>
  readonly session: (sessionId: string) => Effect.Effect<TypedSession<Input, Value>, RemoteError>
}

/**
 * Address a remote session with the agent's declared input.
 *
 * The value is encoded with the agent's schema here and decoded with the
 * same schema by whichever host holds the session, so a caller writes the
 * value and never the wire form. Nothing is added to the transport: the
 * wrapped session's `prompt` receives the encoded value, which is the one
 * shape every adapter carries. For an agent with the default input this is
 * the session unchanged, so one spelling serves both.
 */
export const typedSession = <Tools extends Record<string, Tool.Any>, E, R, Model, Value, Input>(
  agent: AgentDefinition<Tools, E, R, Model, Value, Input>,
  session: RemoteSession
): TypedSession<Input, Value> => {
  /**
   * Read the declared output back, or say who got it wrong.
   *
   * A value that will not decode is a statement about the *far end* -- a
   * different version of the agent, or a different agent behind the same id --
   * so it is reported as a codec error against the response rather than dying
   * as a local bug. `AgentA2A.typed` draws the same line for the same reason.
   */
  const withValue = (result: RemoteResult): Effect.Effect<TypedResult<Value>, RemoteError> =>
    Option.match(Option.zipWith(agent.output, Option.fromNullishOr(result.value), (output, encoded) => ({ output, encoded })), {
      onNone: () =>
        Effect.succeed({
          ...result,
          // The default output: the value is the text, read from the wire when
          // the host sent it and from `text` when an older host did not. A
          // declared output whose run produced nothing stays `None`.
          value: Option.isNone(agent.output)
            ? Option.some((result.value ?? result.text) as Value)
            : Option.none<Value>()
        }),
      onSome: ({ output, encoded }) =>
        AgentOutput.decode(output, encoded).pipe(
          Effect.map((value): TypedResult<Value> => ({ ...result, value: Option.some(value as Value) })),
          Effect.mapError((error) =>
            new AgentProtocolCodecError({
              operation: "prompt",
              phase: "response",
              detail: `the agent's declared output did not decode: ${error.message}`
            })
          )
        )
    })

  const readingValue = {
    ...session,
    prompt: (input: RemoteInput, options?: RemotePromptOptions) =>
      Effect.flatMap(session.prompt(input, options), withValue),
    awaitSubmission: (submissionId: string) =>
      Effect.flatMap(session.awaitSubmission(submissionId), withValue)
  }

  return Option.match(InputBoundary.declared(agent), {
    // The default input is the prompt, which the session takes as it is:
    // `Input` is `Prompt.RawInput` there, and the cast restates that for an
    // abstract `Input` the compiler cannot narrow.
    onNone: () => readingValue as TypedSession<Input, Value>,
    onSome: (input) => ({
      ...readingValue,
      prompt: (value, options) =>
        Effect.flatMap(
          AgentInput.encode(input, value as Input),
          (encoded) => readingValue.prompt(encoded, options)
        ),
      submit: (value, options) =>
        Effect.flatMap(AgentInput.encode(input, value as Input), (encoded) => session.submit(encoded, options))
    })
  })
}

/**
 * The `AgentClient` in context, with its sessions typed by `agent`'s input.
 *
 * ```ts
 * const client = yield* AgentClient.typed(Support)
 * const session = yield* client.createSession()
 * yield* session.prompt({ customerId: "c-42", body: "my order is late" })
 * ```
 *
 * `agent` is the definition the far side serves; the client cannot check
 * that, and a mismatch is reported by the host as an invalid request.
 */
export const typed = <Tools extends Record<string, Tool.Any>, E, R, Model, Value, Input>(
  agent: AgentDefinition<Tools, E, R, Model, Value, Input>
): Effect.Effect<TypedService<Input, Value>, never, AgentClient> =>
  Effect.map(AgentClient, (client): TypedService<Input, Value> => ({
    createSession: (options) => Effect.map(client.createSession(options), (session) => typedSession(agent, session)),
    session: (sessionId) => Effect.map(client.session(sessionId), (session) => typedSession(agent, session))
  }))
