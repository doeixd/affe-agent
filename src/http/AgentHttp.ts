import { Cause, Context, Deferred, Effect, Layer, Option, Schema, Stream } from "effect"
import { Prompt } from "effect/unstable/ai"
import { Sse } from "effect/unstable/encoding"
import {
  Headers,
  HttpClient,
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse
} from "effect/unstable/http"
import {
  HttpApi,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema
} from "effect/unstable/httpapi"
import * as Elicitation from "../Elicitation.js"
import { AgentBusyError, AgentClosedError, AgentIdleError } from "../Errors.js"
import * as AgentClient from "../client/AgentClient.js"
import * as AgentEvent from "../AgentEvent.js"
import * as AgentProtocol from "../client/AgentProtocol.js"
import * as AgentSessionHost from "../client/internal/sessionHost.js"

/** Metadata available while authenticating one HTTP request. */
export interface PrincipalContext {
  readonly operation: AgentProtocol.Operation
  readonly sessionId: Option.Option<AgentProtocol.SessionId>
  readonly headers: Headers.Headers
}

/** Resolve an authenticated principal without coupling the host to HTTP. */
export interface PrincipalResolver<Principal> {
  readonly resolve: (
    context: PrincipalContext
  ) => Effect.Effect<Principal, AgentProtocol.AgentUnauthorizedError>
}

export interface ServerOptions<Principal> {
  readonly authorization: AgentProtocol.Authorization<Principal>
  readonly maxSessions: number
  readonly maxRequestsPerSession: number
  readonly principal: PrincipalResolver<Principal>
}

const SessionPath = Schema.Struct({ id: AgentProtocol.SessionId })

const CloseBody = Schema.Struct({ requestId: AgentProtocol.RequestId })
const PromptBody = Schema.Struct({
  requestId: AgentProtocol.RequestId,
  input: Prompt.Prompt,
  options: Schema.optional(AgentProtocol.RemotePromptOptions)
})
const InputBody = Schema.Struct({
  requestId: AgentProtocol.RequestId,
  input: Prompt.Prompt
})
const RequestBody = Schema.Struct({ requestId: AgentProtocol.RequestId })
const RespondBody = Schema.Struct({
  requestId: AgentProtocol.RequestId,
  response: Elicitation.Response
})

const RequestHeaders = Schema.Struct({
  authorization: Schema.optional(Schema.String)
})

const BadRequestErrors = Schema.Union([
  AgentProtocol.AgentInvalidRequestError,
  AgentProtocol.AgentProtocolCodecError
]).pipe(HttpApiSchema.status(400))
const UnauthorizedError = AgentProtocol.AgentUnauthorizedError.pipe(
  HttpApiSchema.status(401)
)
const ForbiddenError = AgentProtocol.AgentForbiddenError.pipe(
  HttpApiSchema.status(403)
)
const NotFoundError = AgentProtocol.AgentSessionNotFoundError.pipe(
  HttpApiSchema.status(404)
)
const ConflictErrors = Schema.Union([
  AgentProtocol.AgentSessionAlreadyExistsError,
  AgentProtocol.AgentRequestConflictError,
  AgentBusyError,
  AgentIdleError,
  AgentClosedError
]).pipe(HttpApiSchema.status(409))
const CapacityErrors = Schema.Union([
  AgentProtocol.AgentRequestCapacityExceededError,
  AgentProtocol.AgentCapacityExceededError
]).pipe(HttpApiSchema.status(429))
const ExecutionError = AgentClient.AgentExecutionError.pipe(
  HttpApiSchema.status(422)
)
const TransportError = AgentClient.AgentTransportError.pipe(
  HttpApiSchema.status(503)
)
const HttpErrors = [
  BadRequestErrors,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictErrors,
  CapacityErrors,
  ExecutionError,
  TransportError
] as const

const Sessions = HttpApiGroup.make("sessions").add(
  HttpApiEndpoint.post("createSession", "/sessions", {
    headers: RequestHeaders,
    payload: AgentProtocol.CreateSessionRequest,
    success: AgentProtocol.CreateSessionResponse,
    error: HttpErrors
  }),
  HttpApiEndpoint.delete("closeSession", "/sessions/:id", {
    params: SessionPath.fields,
    headers: RequestHeaders,
    payload: CloseBody,
    success: AgentProtocol.CloseSessionResponse,
    error: HttpErrors
  }),
  HttpApiEndpoint.get("getSession", "/sessions/:id", {
    params: SessionPath.fields,
    headers: RequestHeaders,
    success: AgentProtocol.GetSessionResponse,
    error: HttpErrors
  }),
  HttpApiEndpoint.post("prompt", "/sessions/:id/prompt", {
    params: SessionPath.fields,
    headers: RequestHeaders,
    payload: PromptBody,
    success: AgentProtocol.PromptResponse,
    error: HttpErrors
  }),
  HttpApiEndpoint.post("steer", "/sessions/:id/steer", {
    params: SessionPath.fields,
    headers: RequestHeaders,
    payload: InputBody,
    success: AgentProtocol.SteerResponse,
    error: HttpErrors
  }),
  HttpApiEndpoint.post("followUp", "/sessions/:id/follow-up", {
    params: SessionPath.fields,
    headers: RequestHeaders,
    payload: InputBody,
    success: AgentProtocol.FollowUpResponse,
    error: HttpErrors
  }),
  HttpApiEndpoint.post("interrupt", "/sessions/:id/interrupt", {
    params: SessionPath.fields,
    headers: RequestHeaders,
    payload: RequestBody,
    success: AgentProtocol.InterruptResponse,
    error: HttpErrors
  }),
  HttpApiEndpoint.post("respond", "/sessions/:id/respond", {
    params: SessionPath.fields,
    headers: RequestHeaders,
    payload: RespondBody,
    success: AgentProtocol.RespondResponse,
    error: HttpErrors
  }),
  HttpApiEndpoint.get("pending", "/sessions/:id/pending", {
    params: SessionPath.fields,
    headers: RequestHeaders,
    success: AgentProtocol.PendingResponse,
    error: HttpErrors
  }),
  HttpApiEndpoint.get("history", "/sessions/:id/history", {
    params: SessionPath.fields,
    headers: RequestHeaders,
    success: AgentProtocol.HistoryResponse,
    error: HttpErrors
  }),
  HttpApiEndpoint.get("status", "/sessions/:id/status", {
    params: SessionPath.fields,
    headers: RequestHeaders,
    success: AgentProtocol.StatusResponse,
    error: HttpErrors
  }),
  HttpApiEndpoint.get("events", "/sessions/:id/events", {
    params: SessionPath.fields,
    headers: RequestHeaders,
    success: HttpApiSchema.StreamSse({
      // SSE data is JSON text, so Option and other transformations need their
      // explicit JSON codec here rather than the in-memory declaration.
      data: Schema.toCodecJson(AgentProtocol.AgentEventEnvelope),
      error: Schema.toCodecJson(AgentProtocol.RemoteError)
    }),
    error: HttpErrors
  })
)

/** Schema-derived description used by the Effect HTTP client and documentation. */
export const Api = HttpApi.make("AgentHttp").add(Sessions)

/** The schema-generated client retains each route's precise input and output. */
export type Service = HttpApiClient.Client<typeof Sessions>

export class Client extends Context.Service<Client, Service>()(
  "@doeixd/effect-agent/http/Client"
) {}

/** Build the schema-generated client on the application's Effect HTTP client. */
export const clientLayer = (options: {
  readonly baseUrl: string
}): Layer.Layer<Client, never, HttpClient.HttpClient> =>
  Layer.effect(Client, HttpApiClient.make(Api, options))

/** Stable HTTP status assigned to every anticipated protocol failure. */
export const errorStatus = (error: AgentProtocol.RemoteError): number => {
  switch (error._tag) {
    case "AgentInvalidRequestError":
    case "AgentProtocolCodecError":
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
  }
}

const invalidRequest = (
  operation: AgentProtocol.Operation,
  detail: string
) => new AgentProtocol.AgentInvalidRequestError({ operation, detail })

const codecError = (
  operation: AgentProtocol.Operation,
  detail: string
) =>
  new AgentProtocol.AgentProtocolCodecError({
    operation,
    phase: "response",
    detail
  })

const decodeBody = <S extends Schema.Constraint>(
  operation: AgentProtocol.Operation,
  schema: S,
  request: HttpServerRequest.HttpServerRequest
): Effect.Effect<
  S["Type"],
  AgentProtocol.AgentInvalidRequestError,
  S["DecodingServices"]
> =>
  HttpIncomingMessage.schemaBodyJson(schema)(request).pipe(
    Effect.mapError((error) => invalidRequest(operation, error.message))
  )

const decodeSessionId = (
  operation: AgentProtocol.Operation
): Effect.Effect<
  AgentProtocol.SessionId,
  AgentProtocol.AgentInvalidRequestError,
  HttpRouter.RouteContext
> =>
  HttpRouter.schemaPathParams(SessionPath).pipe(
    Effect.map((path) => path.id),
    Effect.mapError((error) => invalidRequest(operation, error.message))
  )

const errorResponse = (
  error: AgentProtocol.RemoteError
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  HttpServerResponse.schemaJson(AgentProtocol.RemoteError)(error, {
    status: errorStatus(error)
  }).pipe(Effect.orDie)

const successResponse = <A, I>(
  operation: AgentProtocol.Operation,
  schema: Schema.Codec<A, I>,
  value: A
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  HttpServerResponse.schemaJson(schema)(value).pipe(
    Effect.matchEffect({
      onFailure: (error) => errorResponse(codecError(operation, error.message)),
      onSuccess: Effect.succeed
    })
  )

const complete = <A, I>(
  operation: AgentProtocol.Operation,
  schema: Schema.Codec<A, I>,
  effect: Effect.Effect<A, AgentProtocol.RemoteError>
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  effect.pipe(
    Effect.matchEffect({
      onFailure: errorResponse,
      onSuccess: (value) => successResponse(operation, schema, value)
    })
  )

const handled = <E extends AgentProtocol.RemoteError, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  effect.pipe(Effect.catch(errorResponse))

const encodeEvent = Effect.fn("AgentHttp.encodeEvent")(function* (
  envelope: AgentProtocol.AgentEventEnvelope
) {
  const encoded = yield* Schema.encodeEffect(
    Schema.toCodecJson(AgentProtocol.AgentEventEnvelope)
  )(envelope).pipe(
    Effect.mapError((error) => codecError("events", error.message))
  )
  const data = yield* Effect.try({
    try: () => JSON.stringify(encoded),
    catch: (error) => codecError("events", String(error))
  })
  return Sse.encoder.write({
    _tag: "Event",
    id: String(envelope.sequence),
    event: envelope.event._tag,
    data
  })
})

/**
 * The frame the generated client understands as a stream failure.
 *
 * `HttpApiClient` treats exactly one event name as a failure —
 * `effect/httpapi/stream/failure` — and only when its data decodes as a
 * `Cause` of the endpoint's declared error. Anything else is handed to the
 * data schema, so a bespoke `event: "error"` frame reached the client as an
 * envelope that failed to decode rather than as the typed `RemoteError` the
 * Api declares. This mirrors what `HttpApiBuilder` writes for a failing
 * stream handler.
 */
const StreamFailure = Schema.toCodecJson(
  Schema.Cause(AgentProtocol.RemoteError, Schema.Defect())
)

const encodeStreamError = (
  error: AgentProtocol.RemoteError
): Effect.Effect<string> =>
  Schema.encodeEffect(StreamFailure)(Cause.fail(error)).pipe(
    Effect.flatMap((encoded) =>
      Effect.try({
        try: () => JSON.stringify(encoded),
        catch: (cause) => codecError("events", String(cause))
      })
    ),
    Effect.map((data) =>
      Sse.encoder.write({
        _tag: "Event",
        id: undefined,
        event: "effect/httpapi/stream/failure",
        data
      })
    ),
    // A value already admitted by RemoteError must encode. Failure here is an
    // internal codec defect, not a new untyped transport error for callers.
    Effect.orDie
  )

const eventResponse = (
  events: Stream.Stream<
    AgentProtocol.AgentEventEnvelope,
    AgentProtocol.RemoteError
  >
): HttpServerResponse.HttpServerResponse => {
  const body = events.pipe(
    // The wire projection: tool results go out in their encoded form, so a
    // decoded `Date` or class instance cannot make an envelope unencodable.
    // Should one still fail to encode, that event is logged and skipped --
    // one bad frame must not end an otherwise healthy session's stream,
    // which is what a failure frame would do.
    Stream.map(AgentEvent.toWire),
    Stream.mapEffect((envelope) =>
      encodeEvent(envelope).pipe(
        Effect.map(Option.some),
        Effect.catchTag("AgentProtocolCodecError", (error) =>
          Effect.as(
            Effect.logWarning("event could not be encoded for SSE; skipped", {
              sessionId: envelope.sessionId,
              sequence: envelope.sequence,
              tag: envelope.event._tag,
              detail: error.detail
            }),
            Option.none<string>()
          )
        )
      )
    ),
    Stream.filter(Option.isSome),
    Stream.map((frame) => frame.value),
    Stream.catch((error) => Stream.fromEffect(encodeStreamError(error))),
    Stream.encodeText
  )
  return HttpServerResponse.stream(body, {
    contentType: "text/event-stream",
    headers: {
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    }
  })
}

/**
 * Register the complete remote-session HTTP API on the current Effect router.
 *
 * The events endpoint is live-only: reconnecting creates a new observation and
 * does not replay a durable cursor. Interrupting an HTTP request or closing an
 * SSE connection ends only that observer; host-owned session work remains in
 * its scoped session until explicitly closed or the server scope shuts down.
 */
export const serverLayer = <Principal>(
  options: ServerOptions<Principal>
): Layer.Layer<never, never, HttpRouter.HttpRouter | AgentClient.AgentClient> =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const host = yield* AgentSessionHost.make(options)
      const shutdown = yield* Deferred.make<void>()
      // HTTP response streams run in request scopes rather than the layer's
      // scope. Signal them explicitly so closing this layer cannot leave an
      // SSE response holding shutdown open.
      yield* Effect.addFinalizer(() => Deferred.succeed(shutdown, void 0))

      const principal = Effect.fn("AgentHttp.principal")(function* (
        request: HttpServerRequest.HttpServerRequest,
        operation: AgentProtocol.Operation,
        sessionId: Option.Option<AgentProtocol.SessionId>
      ) {
        yield* Effect.annotateCurrentSpan({
          "agent.operation": operation,
          ...(Option.isSome(sessionId)
            ? { "agent.session.id": sessionId.value }
            : {})
        })
        return yield* options.principal.resolve({
          operation,
          sessionId,
          headers: request.headers
        })
      })

      const createSession = Effect.fn("AgentHttp.createSession")(function* (
        request: HttpServerRequest.HttpServerRequest
      ) {
        const body = yield* decodeBody(
          "createSession",
          AgentProtocol.CreateSessionRequest,
          request
        )
        const sessionId = Option.fromUndefinedOr(body.sessionId)
        const identity = yield* principal(request, "createSession", sessionId)
        return yield* complete(
          "createSession",
          AgentProtocol.CreateSessionResponse,
          host.createSession(identity, body)
        )
      })

      const closeSession = Effect.fn("AgentHttp.closeSession")(function* (
        request: HttpServerRequest.HttpServerRequest
      ) {
        const sessionId = yield* decodeSessionId("closeSession")
        const body = yield* decodeBody("closeSession", CloseBody, request)
        const identity = yield* principal(
          request,
          "closeSession",
          Option.some(sessionId)
        )
        return yield* complete(
          "closeSession",
          AgentProtocol.CloseSessionResponse,
          host.closeSession(identity, { ...body, sessionId })
        )
      })

      const getSession = Effect.fn("AgentHttp.getSession")(function* (
        request: HttpServerRequest.HttpServerRequest
      ) {
        const sessionId = yield* decodeSessionId("getSession")
        const identity = yield* principal(
          request,
          "getSession",
          Option.some(sessionId)
        )
        return yield* complete(
          "getSession",
          AgentProtocol.GetSessionResponse,
          host.session(identity, { sessionId })
        )
      })

      const prompt = Effect.fn("AgentHttp.prompt")(function* (
        request: HttpServerRequest.HttpServerRequest
      ) {
        const sessionId = yield* decodeSessionId("prompt")
        const body = yield* decodeBody("prompt", PromptBody, request)
        const identity = yield* principal(
          request,
          "prompt",
          Option.some(sessionId)
        )
        return yield* complete(
          "prompt",
          AgentProtocol.PromptResponse,
          host.prompt(identity, { ...body, sessionId })
        )
      })

      const steer = Effect.fn("AgentHttp.steer")(function* (
        request: HttpServerRequest.HttpServerRequest
      ) {
        const sessionId = yield* decodeSessionId("steer")
        const body = yield* decodeBody("steer", InputBody, request)
        const identity = yield* principal(
          request,
          "steer",
          Option.some(sessionId)
        )
        return yield* complete(
          "steer",
          AgentProtocol.SteerResponse,
          host.steer(identity, { ...body, sessionId })
        )
      })

      const followUp = Effect.fn("AgentHttp.followUp")(function* (
        request: HttpServerRequest.HttpServerRequest
      ) {
        const sessionId = yield* decodeSessionId("followUp")
        const body = yield* decodeBody("followUp", InputBody, request)
        const identity = yield* principal(
          request,
          "followUp",
          Option.some(sessionId)
        )
        return yield* complete(
          "followUp",
          AgentProtocol.FollowUpResponse,
          host.followUp(identity, { ...body, sessionId })
        )
      })

      const interrupt = Effect.fn("AgentHttp.interrupt")(function* (
        request: HttpServerRequest.HttpServerRequest
      ) {
        const sessionId = yield* decodeSessionId("interrupt")
        const body = yield* decodeBody("interrupt", RequestBody, request)
        const identity = yield* principal(
          request,
          "interrupt",
          Option.some(sessionId)
        )
        return yield* complete(
          "interrupt",
          AgentProtocol.InterruptResponse,
          host.interrupt(identity, { ...body, sessionId })
        )
      })

      const respond = Effect.fn("AgentHttp.respond")(function* (
        request: HttpServerRequest.HttpServerRequest
      ) {
        const sessionId = yield* decodeSessionId("respond")
        const body = yield* decodeBody("respond", RespondBody, request)
        const identity = yield* principal(
          request,
          "respond",
          Option.some(sessionId)
        )
        return yield* complete(
          "respond",
          AgentProtocol.RespondResponse,
          host.respond(identity, { ...body, sessionId })
        )
      })

      const pending = Effect.fn("AgentHttp.pending")(function* (
        request: HttpServerRequest.HttpServerRequest
      ) {
        const sessionId = yield* decodeSessionId("pending")
        const identity = yield* principal(
          request,
          "pending",
          Option.some(sessionId)
        )
        return yield* complete(
          "pending",
          AgentProtocol.PendingResponse,
          host.pending(identity, { sessionId })
        )
      })

      const history = Effect.fn("AgentHttp.history")(function* (
        request: HttpServerRequest.HttpServerRequest
      ) {
        const sessionId = yield* decodeSessionId("history")
        const identity = yield* principal(
          request,
          "history",
          Option.some(sessionId)
        )
        return yield* complete(
          "history",
          AgentProtocol.HistoryResponse,
          host.history(identity, { sessionId })
        )
      })

      const status = Effect.fn("AgentHttp.status")(function* (
        request: HttpServerRequest.HttpServerRequest
      ) {
        const sessionId = yield* decodeSessionId("status")
        const identity = yield* principal(
          request,
          "status",
          Option.some(sessionId)
        )
        return yield* complete(
          "status",
          AgentProtocol.StatusResponse,
          host.status(identity, { sessionId })
        )
      })

      const events = Effect.fn("AgentHttp.events")(function* (
        request: HttpServerRequest.HttpServerRequest
      ) {
        const sessionId = yield* decodeSessionId("events")
        const identity = yield* principal(
          request,
          "events",
          Option.some(sessionId)
        )
        const stream = yield* host.events(identity, { sessionId })
        return eventResponse(
          stream.pipe(Stream.interruptWhen(Deferred.await(shutdown)))
        )
      })

      yield* Effect.all(
        [
          router.add("POST", "/sessions", (request) =>
            handled(createSession(request))),
          router.add("DELETE", "/sessions/:id", (request) =>
            handled(closeSession(request))),
          router.add("GET", "/sessions/:id", (request) =>
            handled(getSession(request))),
          router.add("POST", "/sessions/:id/prompt", (request) =>
            handled(prompt(request))),
          router.add("POST", "/sessions/:id/steer", (request) =>
            handled(steer(request))),
          router.add("POST", "/sessions/:id/follow-up", (request) =>
            handled(followUp(request))),
          router.add("POST", "/sessions/:id/interrupt", (request) =>
            handled(interrupt(request))),
          router.add("POST", "/sessions/:id/respond", (request) =>
            handled(respond(request))),
          router.add("GET", "/sessions/:id/pending", (request) =>
            handled(pending(request))),
          router.add("GET", "/sessions/:id/history", (request) =>
            handled(history(request))),
          router.add("GET", "/sessions/:id/status", (request) =>
            handled(status(request))),
          router.add("GET", "/sessions/:id/events", (request) =>
            handled(events(request)))
        ],
        { discard: true }
      )
    })
  )
