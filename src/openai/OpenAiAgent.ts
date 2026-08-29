import { Clock, Deferred, Effect, Exit, Layer, Option, Schema, Scope, Semaphore, Stream } from "effect"
import { Prompt } from "effect/unstable/ai"
import { Sse } from "effect/unstable/encoding"
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse
} from "effect/unstable/http"
import type { AgentEventEnvelope } from "../AgentEvent.js"
import * as AgentClient from "../client/AgentClient.js"
import type * as AgentProtocol from "../client/AgentProtocol.js"
import * as Projection from "./OpenAiProjection.js"
import * as OpenAiSchema from "./OpenAiSchema.js"

/**
 * An OpenAI-compatible inference surface for an `AgentClient` (#8).
 *
 * `POST /v1/chat/completions` over whatever `AgentClient` is provided: the
 * in-process one, the durable one, a clustered one. The adapter knows only
 * the client interface -- it never sees a session, a workflow or an entity --
 * which is the load-bearing property: the same layer fronts every backend.
 *
 * Two conversation semantics, never conflated:
 *
 * - **Strict mode** (default). `messages` is the whole conversation. Each
 *   request is one fresh session that lives for the request; the messages
 *   become its first and only prompt. Durability, where the backend has it,
 *   covers the *execution*; the history stays with the caller.
 * - **Stateful extension.** A session id in `x-agent-session-id` (the header
 *   is configurable) addresses one persistent logical session, created on
 *   first use. The session's history is authoritative, so the request's
 *   messages are *not* appended wholesale: only the trailing input -- the
 *   user messages after the last assistant message; system and developer
 *   messages are the agent's to supply and are dropped -- is submitted. A
 *   request whose trailing input is empty is invalid.
 *
 * An `idempotency-key` (configurable) makes a retried request return the
 * result of the first: the same key with the same `model` and `messages`
 * joins the in-flight or completed work; the same key with a different
 * request is refused. In strict mode the key also names the session, so a
 * durable backend refuses a second execution of the same work from *another*
 * process as a conflict rather than running it twice; the store itself is
 * process-local unless a shared one is supplied.
 *
 * What is deliberately *not* here: steering, follow-ups, interrupts,
 * elicitation answers, history, status, replay. The protocol has no place for
 * them; the native HTTP / RPC client remains the full-fidelity transport, and
 * several surfaces may front one session.
 *
 * Authentication is not agent semantics: compose HTTP middleware around the
 * router. Nothing here reads an API key.
 */

export interface IdempotencyStore {
  /**
   * Claim a key for a request with this fingerprint.
   *
   * `Fresh`: the caller executes and must `complete`. `Joined`: the same
   * request is in flight or done; await its result. `Mismatch`: the key was
   * used for a different request.
   */
  readonly begin: (
    key: string,
    fingerprint: string
  ) => Effect.Effect<
    | { readonly _tag: "Fresh" }
    | {
        readonly _tag: "Joined"
        readonly result: Effect.Effect<
          OpenAiSchema.ChatCompletionResponse,
          OpenAiSchema.ErrorBody
        >
      }
    | { readonly _tag: "Mismatch" }
  >
  readonly complete: (
    key: string,
    result: Exit.Exit<OpenAiSchema.ChatCompletionResponse, OpenAiSchema.ErrorBody>
  ) => Effect.Effect<void>
}

/**
 * The default store: one process's memory. A failed attempt releases the key
 * so a retry executes again; a completed one is remembered for the life of
 * the process.
 */
export const memoryIdempotency: Effect.Effect<IdempotencyStore> = Effect.sync(() => {
  const entries = new Map<
    string,
    {
      readonly fingerprint: string
      readonly result: Deferred.Deferred<
        OpenAiSchema.ChatCompletionResponse,
        OpenAiSchema.ErrorBody
      >
    }
  >()
  return {
    // One synchronous block: the get-check-insert must not yield, or two
    // concurrent requests with the same key could both observe no entry and
    // both execute -- the exact double-execution the key exists to prevent.
    // `Effect.sync` runs atomically with respect to other fibers, and
    // `Deferred.makeUnsafe` keeps it synchronous.
    begin: (key, fingerprint) =>
      Effect.sync(() => {
        const existing = entries.get(key)
        if (existing !== undefined) {
          return existing.fingerprint === fingerprint
            ? { _tag: "Joined" as const, result: Deferred.await(existing.result) }
            : { _tag: "Mismatch" as const }
        }
        const result = Deferred.makeUnsafe<
          OpenAiSchema.ChatCompletionResponse,
          OpenAiSchema.ErrorBody
        >()
        entries.set(key, { fingerprint, result })
        return { _tag: "Fresh" as const }
      }),
    complete: (key, exit) =>
      Effect.gen(function* () {
        const entry = entries.get(key)
        if (entry === undefined) return
        if (Exit.isSuccess(exit)) {
          yield* Deferred.succeed(entry.result, exit.value)
        } else {
          entries.delete(key)
          yield* Deferred.failCause(entry.result, exit.cause)
        }
      })
  }
})

export interface ServerOptions {
  /** The one model name this endpoint serves. Any other is not found. */
  readonly model: string
  /** Defaults to `/v1/chat/completions`. */
  readonly path?: `/${string}` | undefined
  /** The stateful extension. Defaults to the `x-agent-session-id` header. */
  readonly session?: { readonly header?: string | undefined } | undefined
  /**
   * Idempotent retries. Defaults to the `idempotency-key` header and a
   * memory store.
   */
  readonly idempotency?:
    | {
        readonly header?: string | undefined
        readonly store?: IdempotencyStore | undefined
      }
    | undefined
}

/** The adapter's own failure: the OpenAI envelope and its status. */
export class OpenAiError extends Schema.TaggedError<OpenAiError>()("OpenAiError", {
  status: Schema.Number,
  error: OpenAiSchema.ErrorBody
}) {}

const invalid = (
  message: string,
  code: string | null = null,
  param: string | null = null
): OpenAiError =>
  new OpenAiError({
    status: 400,
    error: Projection.error("invalid_request_error", message, code, param)
  })

/**
 * The mapping from the client's errors to OpenAI envelopes. Execution
 * failures are the request's problem (422) and transport failures are not
 * (503); a caller's retry policy must be able to tell them apart. The
 * originating tag travels as `code`.
 */
export const fromRemoteError = (error: AgentProtocol.RemoteError): OpenAiError => {
  const envelope = (
    status: number,
    type: OpenAiSchema.ErrorType,
    code: string | null = error._tag
  ): OpenAiError =>
    new OpenAiError({ status, error: Projection.error(type, error.message, code) })
  switch (error._tag) {
    case "AgentInvalidRequestError":
    case "AgentProtocolCodecError":
      return envelope(400, "invalid_request_error")
    case "AgentUnauthorizedError":
      return envelope(401, "authentication_error")
    case "AgentForbiddenError":
      return envelope(403, "permission_error")
    case "AgentSessionNotFoundError":
      return envelope(404, "not_found_error")
    case "AgentBusyError":
    case "AgentIdleError":
    case "AgentClosedError":
    case "AgentSessionAlreadyExistsError":
    case "AgentRequestConflictError":
      return envelope(409, "conflict_error")
    case "AgentCapacityExceededError":
    case "AgentRequestCapacityExceededError":
      return envelope(429, "rate_limit_error")
    case "AgentExecutionError":
      return envelope(422, "server_error", error.tag)
    case "AgentTransportError":
      return envelope(503, "server_error")
  }
}

const contentText = (content: OpenAiSchema.MessageContent): string =>
  content === null
    ? ""
    : typeof content === "string"
      ? content
      : content.map((part) => part.text).join("")

/** Strict mode: the whole message list, as the prompt. */
export const strictPrompt = (
  messages: ReadonlyArray<OpenAiSchema.ChatMessage>
): Prompt.Prompt =>
  Prompt.make(
    messages.map((message) => {
      const text = contentText(message.content)
      switch (message.role) {
        case "system":
        case "developer":
          return Prompt.systemMessage({ content: text })
        case "user":
          return Prompt.userMessage({ content: [Prompt.textPart({ text })] })
        case "assistant":
          return Prompt.assistantMessage({ content: [Prompt.textPart({ text })] })
      }
    })
  )

/**
 * Stateful mode: only the trailing input. Everything up to and including the
 * last assistant message is the caller's copy of history the session already
 * holds.
 */
export const statefulDelta = (
  messages: ReadonlyArray<OpenAiSchema.ChatMessage>
): Option.Option<Prompt.Prompt> => {
  let start = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      start = i + 1
      break
    }
  }
  const trailing = messages
    .slice(start)
    .filter((message) => message.role === "user")
    .map((message) =>
      Prompt.userMessage({
        content: [Prompt.textPart({ text: contentText(message.content) })]
      })
    )
  return trailing.length === 0 ? Option.none() : Option.some(Prompt.make(trailing))
}

/** The text of the last assistant message, when there is one. */
export const lastAssistantText = (history: Prompt.Prompt): Option.Option<string> => {
  for (let i = history.content.length - 1; i >= 0; i--) {
    const message = history.content[i]!
    if (message.role === "assistant") {
      return Option.some(
        message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
      )
    }
  }
  return Option.none()
}

const fingerprintOf = (request: OpenAiSchema.ChatCompletionRequest): string =>
  JSON.stringify({ model: request.model, messages: request.messages })

const completionId = Effect.map(Clock.currentTimeMillis, (now) => ({
  id: `chatcmpl-${globalThis.crypto.randomUUID()}`,
  created: Math.floor(now / 1000)
}))

const encodeJson = <A, I>(schema: Schema.Codec<A, I>, value: A): Effect.Effect<string> =>
  Schema.encodeEffect(schema)(value).pipe(
    Effect.map((encoded) => JSON.stringify(encoded)),
    // Values built here come from the protocol's own constructors; they encode.
    Effect.orDie
  )

const sseData = (data: string): string =>
  Sse.encoder.write({ _tag: "Event", id: undefined, event: "message", data })

const frameText = (frame: Projection.Frame): Effect.Effect<string> => {
  switch (frame._tag) {
    case "Chunk":
      return Effect.map(encodeJson(OpenAiSchema.ChatCompletionChunkJson, frame.chunk), sseData)
    case "Error":
      return Effect.map(
        encodeJson(OpenAiSchema.ErrorResponseJson, { error: frame.error }),
        sseData
      )
    case "Done":
      return Effect.succeed(sseData("[DONE]"))
  }
}

const errorResponse = (
  error: OpenAiError
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  HttpServerResponse.schemaJson(OpenAiSchema.ErrorResponseJson)(
    { error: error.error },
    { status: error.status }
  ).pipe(Effect.orDie)

const jsonResponse = (
  result: OpenAiSchema.ChatCompletionResponse
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  HttpServerResponse.schemaJson(OpenAiSchema.ChatCompletionResponseJson)(result).pipe(
    Effect.orDie
  )

const sseResponse = (
  frames: Stream.Stream<Projection.Frame>
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.stream(
    frames.pipe(Stream.mapEffect(frameText), Stream.encodeText),
    {
      contentType: "text/event-stream",
      headers: {
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      }
    }
  )

/** A stored result, replayed in the shape the retry asked for. */
const replay = (
  projection: Projection.Options,
  result: OpenAiSchema.ChatCompletionResponse
): Stream.Stream<Projection.Frame> =>
  Stream.fromIterable<Projection.Frame>([
    { _tag: "Chunk", chunk: Projection.chunk.role(projection) },
    {
      _tag: "Chunk",
      chunk: Projection.chunk.text(projection, result.choices[0]?.message.content ?? "")
    },
    { _tag: "Chunk", chunk: Projection.chunk.finish(projection) },
    { _tag: "Done" }
  ])

/** Register `POST {path}` on the current router. */
export const serverLayer = (
  options: ServerOptions
): Layer.Layer<never, never, HttpRouter.HttpRouter | AgentClient.AgentClient> =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const client = yield* AgentClient.AgentClient
      const path = options.path ?? "/v1/chat/completions"
      const sessionHeader = (options.session?.header ?? "x-agent-session-id").toLowerCase()
      const idempotencyHeader = (
        options.idempotency?.header ?? "idempotency-key"
      ).toLowerCase()
      const idempotency = options.idempotency?.store ?? (yield* memoryIdempotency)
      // Response streams run in request scopes, not this layer's; tell them
      // when the layer goes so a live stream cannot hold shutdown open.
      const shutdown = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(shutdown, void 0))
      // A stateful session must outlive the request that created it. For a
      // backend whose sessions are their scope -- the in-process client --
      // that means creating it in this layer's scope; a durable backend's
      // sessions outlive every handle anyway.
      const layerScope = yield* Effect.scope
      // Two first requests for one new session id must not each create a
      // session; resolution is serialised.
      const creating = yield* Semaphore.make(1)

      /** The session and the input for one request, per mode. */
      const resolve = Effect.fn("OpenAiAgent.resolve")(function* (
        request: OpenAiSchema.ChatCompletionRequest,
        sessionId: Option.Option<string>,
        idempotencyKey: Option.Option<string>
      ) {
        if (Option.isSome(sessionId)) {
          const input = statefulDelta(request.messages)
          if (Option.isNone(input)) {
            return yield* invalid(
              "stateful mode submits the user messages after the last assistant message, and there are none",
              "empty_delta",
              "messages"
            )
          }
          const session = yield* creating.withPermits(1)(
            client.session(sessionId.value).pipe(
              Effect.catchTag("AgentSessionNotFoundError", () =>
                client
                  .createSession({ sessionId: sessionId.value })
                  .pipe(Scope.provide(layerScope))
              )
            )
          ).pipe(Effect.mapError(fromRemoteError))
          return { session, input: input.value, done: Option.none() }
        }
        if (request.messages.length === 0) {
          return yield* invalid("messages must not be empty", "empty_messages", "messages")
        }
        if (Option.isNone(idempotencyKey)) {
          const session = yield* client
            .createSession()
            .pipe(Effect.mapError(fromRemoteError))
          return { session, input: strictPrompt(request.messages), done: Option.none() }
        }
        // The key names the session. A backend whose sessions are shared
        // across processes hands back the *same* session to a retry landing
        // elsewhere: if that session already answered, the answer is in its
        // history and is replayed rather than produced again; if it is still
        // at work, the prompt is refused as busy, and the retry comes back.
        const session = yield* client
          .createSession({ sessionId: `openai:${idempotencyKey.value}` })
          .pipe(Effect.mapError(fromRemoteError))
        const history = yield* session.history.pipe(Effect.mapError(fromRemoteError))
        return {
          session,
          input: strictPrompt(request.messages),
          done: lastAssistantText(history)
        }
      })

      const decode = Effect.fn("OpenAiAgent.decode")(function* (
        request: HttpServerRequest.HttpServerRequest
      ) {
        const body = yield* HttpIncomingMessage.schemaBodyJson(
          OpenAiSchema.ChatCompletionRequest
        )(request).pipe(Effect.mapError((error) => invalid(error.message, "invalid_body")))
        if (body.model !== options.model) {
          return yield* new OpenAiError({
            status: 404,
            error: Projection.error(
              "not_found_error",
              `The model '${body.model}' does not exist`,
              "model_not_found",
              "model"
            )
          })
        }
        return body
      })

      /**
       * The live stream: subscribe first, then prompt, so nothing between
       * acceptance and the first delta is missed. The prompt is a child of
       * the response's scope -- a consumer that goes away takes its request
       * with it. Should the prompt be *refused* (busy, for one), the refusal
       * ends the stream as an error frame: the projection cannot tell whose
       * submission it was following until the prompt answers.
       */
      const live = (
        session: AgentClient.RemoteSession,
        input: Prompt.Prompt,
        projection: Projection.Options
      ): Stream.Stream<Projection.Frame> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const queue = yield* Stream.toQueue(
              session.events().pipe(Stream.interruptWhen(Deferred.await(shutdown))),
              { capacity: "unbounded" }
            )
            const outcome = yield* Deferred.make<void, OpenAiError>()
            yield* Effect.forkChild(
              session.prompt(input, { stream: true }).pipe(
                Effect.mapError(fromRemoteError),
                Effect.asVoid,
                Effect.exit,
                Effect.flatMap((exit) => Deferred.done(outcome, exit))
              )
            )
            const failed = (error: OpenAiError) =>
              Stream.fromIterable<Projection.Frame>([
                { _tag: "Error", error: error.error },
                { _tag: "Done" }
              ])
            const refused = Stream.fromEffect(Deferred.await(outcome)).pipe(
              Stream.drain,
              Stream.catch(failed)
            )
            const projected = Projection.project(
              projection,
              Stream.fromQueue(queue).pipe(
                Stream.filter((envelope: AgentEventEnvelope) =>
                  Option.isSome(envelope.submissionId)
                ),
                // The feed failing before a terminal frame is a transport
                // matter; say so rather than leave the response hanging.
                Stream.mapError(fromRemoteError)
              )
            ).pipe(Stream.catch(failed))
            return Stream.merge(projected, refused).pipe(
              Stream.takeUntil((frame) => frame._tag === "Done")
            )
          })
        )

      const handle = Effect.fn("OpenAiAgent.chatCompletions")(function* (
        request: HttpServerRequest.HttpServerRequest
      ) {
        const body = yield* decode(request)
        const sessionId = Option.fromUndefinedOr(request.headers[sessionHeader])
        const idempotencyKey = Option.fromUndefinedOr(request.headers[idempotencyHeader])
        const projection: Projection.Options = {
          ...(yield* completionId),
          model: options.model
        }

        if (Option.isSome(idempotencyKey)) {
          const claim = yield* idempotency.begin(idempotencyKey.value, fingerprintOf(body))
          if (claim._tag === "Mismatch") {
            return yield* invalid(
              "the idempotency key was already used for a different request",
              "idempotency_key_reuse",
              idempotencyHeader
            )
          }
          if (claim._tag === "Joined") {
            const result = yield* claim.result.pipe(
              Effect.mapError((error) => new OpenAiError({ status: 422, error }))
            )
            return body.stream === true
              ? sseResponse(replay(projection, result))
              : yield* jsonResponse(result)
          }
        }
        const record = (
          exit: Exit.Exit<OpenAiSchema.ChatCompletionResponse, OpenAiError>
        ): Effect.Effect<void> =>
          Option.isSome(idempotencyKey)
            ? idempotency.complete(
                idempotencyKey.value,
                Exit.mapError(exit, (error) => error.error)
              )
            : Effect.void

        const served = Effect.gen(function* () {
          // Resolution happens before the response starts, in either mode, so
          // an unknown session or a refused creation is a status code and not
          // a frame. The session handle is scoped to the request, which for a
          // streaming response lasts until the body has been sent.
          const { session, input, done } = yield* resolve(body, sessionId, idempotencyKey)

          if (Option.isSome(done)) {
            const result = Projection.response.success(projection, done.value)
            yield* record(Exit.succeed(result))
            return body.stream === true
              ? sseResponse(replay(projection, result))
              : yield* jsonResponse(result)
          }

          if (body.stream !== true) {
            const exit = yield* session.prompt(input).pipe(
              Effect.mapError(fromRemoteError),
              Effect.map((result) => Projection.response.success(projection, result.text)),
              Effect.exit
            )
            yield* record(exit)
            return yield* Effect.flatMap(exit, jsonResponse)
          }

          // The collected text is what an idempotent retry replays.
          let text = ""
          let failure: OpenAiSchema.ErrorBody | undefined
          // Whether the stream reached its terminal `Done` frame. A stream cut
          // short -- the consumer disconnects mid-generation -- must not record
          // the partial text as the answer, or a retry under the same key would
          // replay a truncated result. It records a failure instead, releasing
          // the key so the retry re-executes.
          let completed = false
          return sseResponse(
            live(session, input, projection).pipe(
              Stream.tap((frame) =>
                Effect.sync(() => {
                  if (frame._tag === "Done") {
                    completed = true
                  } else if (frame._tag === "Chunk") {
                    text += frame.chunk.choices[0]?.delta.content ?? ""
                  } else if (frame._tag === "Error") {
                    failure = frame.error
                  }
                })
              ),
              Stream.ensuring(
                Effect.suspend(() =>
                  record(
                    failure !== undefined
                      ? Exit.fail(new OpenAiError({ status: 422, error: failure }))
                      : completed
                        ? Exit.succeed(Projection.response.success(projection, text))
                        // Interrupted before the terminal frame: release the key.
                        : Exit.fail(
                            new OpenAiError({
                              status: 503,
                              error: Projection.error(
                                "server_error",
                                "the stream was interrupted before completing",
                                "interrupted"
                              )
                            })
                          )
                  )
                )
              )
            )
          )
        })

        /**
         * A claimed key is either kept or released -- never left claimed.
         *
         * `record` is reached on every path that produces an answer, and on
         * none of the paths that do not: an unusable stateful delta, a
         * refused session, a request interrupted before its response exists.
         * The key then held a promise nothing would ever keep, and the retry
         * it exists to serve joined a deferred that never completed -- worse
         * than executing twice, because it never ends.
         *
         * Only a non-success exit is handled here. A JSON answer has already
         * recorded, and a streaming one records from its own `ensuring` once
         * the body has been sent -- the response value succeeding is not the
         * stream succeeding.
         */
        return yield* Effect.onExit(served, (exit) => {
          if (Exit.isSuccess(exit)) return Effect.void
          const failures = exit.cause.reasons.flatMap((reason) =>
            reason._tag === "Fail" ? [reason.error] : [])
          return record(
            Exit.fail(
              failures[0] ??
                // A defect or an interruption: nothing the caller asked for
                // happened, so the key is released the same way.
                new OpenAiError({
                  status: 503,
                  error: Projection.error(
                    "server_error",
                    "the request ended before producing a result",
                    "interrupted"
                  )
                })
            )
          )
        })
      })

      yield* router.add("POST", path, (request) =>
        handle(request).pipe(Effect.catchTag("OpenAiError", errorResponse))
      )
    })
  )
