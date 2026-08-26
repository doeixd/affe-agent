import { Cause, Context, Deferred, Effect, Layer, Option, Schema, Stream } from "effect"
import { Prompt } from "effect/unstable/ai"
import { Sse } from "effect/unstable/encoding"
import {
  Headers,
  HttpClient,
  HttpIncomingMessage,
  HttpRouter,
  HttpServer,
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
import * as AgentSessionHost from "../client/AgentSessionHost.js"

/** Re-exported so an HTTP deployment reads its auth types from one place. */
export type PrincipalContext = AgentSessionHost.PrincipalContext
export type PrincipalResolver<Principal> = AgentSessionHost.PrincipalResolver<Principal>

export interface ServerOptions<Principal> {
  /**
   * The host this adapter serves: registry, capacity, authentication and
   * authorization live there, shared with every other adapter given the
   * same tag. See `AgentSessionHost`.
   */
  readonly host: AgentSessionHost.Tag<Principal>
  /**
   * Path prefix prepended to every route.
   *
   * The single-agent `Api` is served at `/sessions`. A named `api({ name })`
   * lives at `/agents/${name}` by default; pass the same prefix here so the
   * router and the schema agree. No trailing slash.
   */
  readonly path?: `/${string}` | undefined
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

const sessionsGroup = <const Id extends string>(identifier: Id) =>
  HttpApiGroup.make(identifier).add(
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

/**
 * Schema-derived description used by the Effect HTTP client and documentation.
 *
 * The single-agent case: group id `sessions`, routes at `/sessions`. Serving
 * several agents through `HttpApi.prefix` + `addHttpApi` silently drops all
 * but one -- both copies keep the group id `sessions`, and the second
 * replaces the first. `api({ name })` is the way out: each agent gets its
 * own group id and a prefixed path. See `docs/plan-agent-server.md`.
 */
const Sessions = sessionsGroup("sessions")
export const Api = HttpApi.make("AgentHttp").add(Sessions)

const isGroupName = (name: string): boolean =>
  name.length > 0 && !name.includes("/") && !name.includes(":") && !name.includes(" ")

/**
 * An HTTP API for one named agent, with its own group id and path prefix.
 *
 * `Api.prefix("/agents/alpha").addHttpApi(Api.prefix("/agents/beta"))` is
 * the trap this exists to close: both still carry the group `sessions`, so
 * the second replaces the first with no error. Naming the group after the
 * agent makes the collision unrepresentable, and prefixing the routes keeps
 * each agent at its own path.
 *
 * Default path is `/agents/${name}`. `Api` itself is unchanged.
 */
export const api = <const Name extends string>(options: {
  readonly name: Name
  readonly path?: `/${string}` | undefined
}) => {
  if (!isGroupName(options.name)) {
    throw new Error(
      `AgentHttp.api: ${JSON.stringify(options.name)} is not a valid group name` +
        ` (non-empty, no '/', ':', or space)`
    )
  }
  const path = options.path ?? (`/agents/${options.name}` as const)
  return HttpApi.make(`AgentHttp/${options.name}`).add(
    sessionsGroup(options.name).prefix(path)
  )
}

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

/**
 * The schema-generated HTTP client for `Api`, including the `sessions` group.
 *
 * `HttpApiClient.Client` is parameterised by the *groups*, not by the `HttpApi`
 * that holds them -- it maps each group to its methods under that group's
 * identifier, so this already reads `{ sessions: ... }`. Passing `typeof Api`
 * fails the `HttpApiGroup.Constraint` and, because the mapped type then has no
 * groups to map, quietly resolves to `{}`: every `client.sessions.…` in
 * `AgentServer` and the client tests failed as "Property 'sessions' does not
 * exist on type '{}'", twenty-two errors from one type argument.
 *
 * Which makes this exactly `Service` above, so it says so rather than
 * restating it and risking the two drifting apart.
 */
export type Generated = Service

const ClientFailure = Schema.Union([
  AgentBusyError,
  AgentIdleError,
  AgentClosedError,
  AgentClient.AgentSessionNotFoundError,
  AgentClient.AgentExecutionError,
  AgentClient.AgentTransportError
])
const decodeClientFailure = Schema.decodeUnknownOption(ClientFailure)

const toRemote = (
  sessionId: string,
  error: unknown
): AgentClient.RemoteError => {
  const decoded = decodeClientFailure(error)
  if (Option.isSome(decoded)) return decoded.value
  const tag = typeof error === "object" && error !== null && "_tag" in error
    ? String((error as { readonly _tag: unknown })._tag)
    : "Error"
  const message =
    typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof (error as { readonly message: unknown }).message === "string"
      ? (error as { readonly message: string }).message
      : String(error)
  return new AgentClient.AgentTransportError({
    sessionId,
    detail: `${tag}: ${message}`
  })
}

const lift = (
  sessionId: string
) =>
  <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, AgentClient.RemoteError> =>
    effect.pipe(Effect.mapError((error) => toRemote(sessionId, error)))

let requestSeq = 0
const nextRequestId = (): AgentProtocol.RequestId => {
  requestSeq += 1
  return AgentProtocol.RequestId.make(
    `http-${requestSeq}-${globalThis.crypto.randomUUID()}`
  )
}

/**
 * Adapt the generated HTTP client to the `AgentClient` seam.
 *
 * A host is backed by an `AgentClient`, not an HTTP schema. This is what lets
 * one `AgentServer` mount a local agent and a remote one: the remote mount is
 * an ordinary host whose client happens to speak HTTP. `AgentClientContract`
 * runs against this adapter the same way it runs against the in-process
 * client — that is AS3, rather than a second suite of HTTP assertions.
 */
export const fromGenerated = (
  client: Generated,
  options?: {
    readonly headers?: { readonly authorization?: string } | undefined
  }
): AgentClient.Service => {
  const headers = options?.headers ?? {}
  const params = (id: string) => ({
    id: AgentProtocol.SessionId.make(id)
  })

  const remoteSession = (id: string): AgentClient.RemoteSession => ({
    id,
    prompt: (input, promptOptions) =>
      lift(id)(
        client.sessions.prompt({
          params: params(id),
          headers,
          payload: {
            requestId: nextRequestId(),
            input: Prompt.make(input),
            options: { stream: promptOptions?.stream === true }
          }
        })
      ).pipe(Effect.map((response) => response.result)),
    steer: (input) =>
      lift(id)(
        client.sessions.steer({
          params: params(id),
          headers,
          payload: {
            requestId: nextRequestId(),
            input: Prompt.make(input)
          }
        })
      ).pipe(Effect.asVoid),
    followUp: (input) =>
      lift(id)(
        client.sessions.followUp({
          params: params(id),
          headers,
          payload: {
            requestId: nextRequestId(),
            input: Prompt.make(input)
          }
        })
      ).pipe(Effect.asVoid),
    interrupt: () =>
      lift(id)(
        client.sessions.interrupt({
          params: params(id),
          headers,
          payload: { requestId: nextRequestId() }
        })
      ).pipe(Effect.asVoid),
    respond: (response) =>
      lift(id)(
        client.sessions.respond({
          params: params(id),
          headers,
          payload: {
            requestId: nextRequestId(),
            response
          }
        })
      ).pipe(Effect.map((body) => body.matched)),
    pending: lift(id)(
      client.sessions.pending({ params: params(id), headers })
    ).pipe(Effect.map((body) => body.requests)),
    history: lift(id)(
      client.sessions.history({ params: params(id), headers })
    ).pipe(Effect.map((body) => body.history)),
    status: lift(id)(
      client.sessions.status({ params: params(id), headers })
    ).pipe(Effect.map((body) => body.status)),
    events: (eventOptions) =>
      eventOptions?.after === undefined
        ? Stream.unwrap(
          lift(id)(client.sessions.events({ params: params(id), headers }))
        ).pipe(Stream.catch((error) => Stream.fail(toRemote(id, error))))
        : Stream.fail(
          new AgentClient.AgentTransportError({
            sessionId: id,
            detail:
              "this HTTP client does not resume events from a sequence; use a delivery-log-backed session"
          })
        )
  })

  return {
    createSession: (sessionOptions) =>
      lift(sessionOptions?.sessionId ?? "")(
        client.sessions.createSession({
          headers,
          payload: {
            requestId: nextRequestId(),
            ...(sessionOptions?.sessionId === undefined
              ? {}
              : { sessionId: AgentProtocol.SessionId.make(sessionOptions.sessionId) })
          }
        })
      ).pipe(
        Effect.map((created) => remoteSession(created.session.sessionId))
      ),
    session: (sessionId) =>
      lift(sessionId)(
        client.sessions.getSession({
          params: params(sessionId),
          headers
        })
      ).pipe(Effect.map((found) => remoteSession(found.sessionId)))
  }
}

/** An `AgentClient` that speaks this package's HTTP API at `baseUrl`. */
export const agentClientLayer = (options: {
  readonly baseUrl: string
  readonly headers?: { readonly authorization?: string } | undefined
}): Layer.Layer<AgentClient.AgentClient, never, HttpClient.HttpClient> =>
  Layer.effect(
    AgentClient.AgentClient,
    Effect.map(
      HttpApiClient.make(Api, { baseUrl: options.baseUrl }),
      (client) => fromGenerated(client, options)
    )
  )

/**
 * Same adapter, talking to whatever `HttpServer` is in the environment.
 *
 * For tests and in-process composition: the listen address is not known until
 * the server layer is built, so `agentClientLayer` cannot take it as a
 * constant. This reads it from the live server.
 */
export const agentClientFromServer = (options?: {
  readonly headers?: { readonly authorization?: string } | undefined
}): Layer.Layer<
  AgentClient.AgentClient,
  never,
  HttpClient.HttpClient | HttpServer.HttpServer
> =>
  Layer.effect(
    AgentClient.AgentClient,
    Effect.gen(function* () {
      const httpServer = yield* HttpServer.HttpServer
      const client = yield* HttpApiClient.make(Api, {
        baseUrl: HttpServer.formatAddress(httpServer.address)
      })
      return fromGenerated(client, options)
    })
  )

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

/**
 * Where a reconnecting client left off, from the standard SSE header.
 *
 * `EventSource` resends the last `id:` it saw as `Last-Event-ID` automatically,
 * with no cooperation from page code -- which is why the ids this adapter
 * writes are the envelope's sequence and not something of its own. A browser
 * that drops its connection therefore resumes correctly by default, and the
 * only reason it did not before was that nothing read the header back.
 *
 * The query parameter is for everything that is not a browser. `EventSource`
 * cannot set request headers, but neither can a `curl` pipeline resume
 * conveniently without one, and a client reconnecting through a proxy that
 * strips unknown headers has no other route.
 *
 * **A header that is not a sequence is ignored, not rejected.** `Last-Event-ID`
 * is echoed from whatever this server previously sent, so a value that will not
 * parse means the client is resuming against something that did not write these
 * ids -- a different server, or a cached response. Live delivery is the safe
 * reading of that: it is what the client would have got had it not tried, and
 * refusing the connection outright would strand a consumer whose only mistake
 * was reconnecting to the wrong place. Negative and fractional values are
 * turned away the same way; `after` counts sequences, and a log read has no
 * meaning for either.
 */
const resumeFrom = (
  request: HttpServerRequest.HttpServerRequest
): number | undefined => {
  const header = Headers.get(request.headers, "last-event-id").pipe(
    Option.orElse(() =>
      Option.fromNullishOr(
        new URL(request.url, "http://localhost").searchParams.get("after")
      )
    )
  )
  if (Option.isNone(header)) return undefined
  const parsed = Number(header.value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

const eventResponse = (
  events: Stream.Stream<
    AgentProtocol.AgentEventEnvelope,
    AgentProtocol.RemoteError
  >
): HttpServerResponse.HttpServerResponse => {
  // The wire projection: tool results go out in their encoded form, so a
  // decoded `Date` or class instance cannot make an envelope unencodable.
  // Should one still fail to encode, that event is logged and skipped --
  // one bad frame must not end an otherwise healthy session's stream,
  // which is what a failure frame would do.
  const frames = events.pipe(
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
    Stream.catch((error) => Stream.fromEffect(encodeStreamError(error)))
  )
  // An SSE comment first, so the response headers go out before the first
  // event exists. A body that writes nothing until the session emits leaves
  // the client waiting on headers -- `fetch` does not resolve, `EventSource`
  // does not open -- for as long as the session stays quiet, which for a
  // subscription opened *before* the prompt is exactly the interesting case.
  //
  // The subscription is acquired *eagerly*: the source is run into a queue
  // from the moment the response starts, so a client that has connected is
  // observing from then, not from its second read. (`concat` would start
  // the source only once the comment had been consumed.)
  const body = Stream.unwrap(
    Effect.map(Stream.toQueue(frames, { capacity: "unbounded" }), (queue) =>
      Stream.fromQueue(queue).pipe(Stream.prepend([": connected\n\n"]))
    )
  ).pipe(Stream.encodeText)
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
 * The events endpoint is resumable: a reconnecting client that sends
 * `Last-Event-ID` (or `?after=`) is served from that sequence, and a client
 * that sends neither observes from now. Resumption needs a delivery log behind
 * the session, and a client without one fails the request rather than quietly
 * serving live events to a caller that asked to catch up. Interrupting an HTTP
 * request or closing an
 * SSE connection ends only that observer; host-owned session work remains in
 * its scoped session until explicitly closed or the server scope shuts down.
 */
export const serverLayer = <Principal>(
  options: ServerOptions<Principal>
): Layer.Layer<never, never, HttpRouter.HttpRouter | AgentSessionHost.Service<Principal>> =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const host = yield* options.host
      const shutdown = yield* Deferred.make<void>()
      // HTTP response streams run in request scopes rather than the layer's
      // scope. Signal them explicitly so closing this layer cannot leave an
      // SSE response holding shutdown open.
      yield* Effect.addFinalizer(() => Deferred.succeed(shutdown, void 0))

      const principal = (
        request: HttpServerRequest.HttpServerRequest,
        operation: AgentProtocol.Operation,
        sessionId: Option.Option<AgentProtocol.SessionId>
      ) => host.resolve({ operation, sessionId, headers: request.headers })

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
        const after = resumeFrom(request)
        const stream = yield* host.events(identity, {
          sessionId,
          ...(after === undefined ? {} : { after })
        })
        return eventResponse(
          stream.pipe(Stream.interruptWhen(Deferred.await(shutdown)))
        )
      })

      const prefix: "" | `/${string}` = options.path === undefined
        ? ""
        : options.path.replace(/\/+$/, "") as `/${string}`
      const route = (suffix: `/${string}`): `/${string}` =>
        prefix === "" ? suffix : `${prefix}${suffix}`

      yield* Effect.all(
        [
          router.add("POST", route("/sessions"), (request) =>
            handled(createSession(request))),
          router.add("DELETE", route("/sessions/:id"), (request) =>
            handled(closeSession(request))),
          router.add("GET", route("/sessions/:id"), (request) =>
            handled(getSession(request))),
          router.add("POST", route("/sessions/:id/prompt"), (request) =>
            handled(prompt(request))),
          router.add("POST", route("/sessions/:id/steer"), (request) =>
            handled(steer(request))),
          router.add("POST", route("/sessions/:id/follow-up"), (request) =>
            handled(followUp(request))),
          router.add("POST", route("/sessions/:id/interrupt"), (request) =>
            handled(interrupt(request))),
          router.add("POST", route("/sessions/:id/respond"), (request) =>
            handled(respond(request))),
          router.add("GET", route("/sessions/:id/pending"), (request) =>
            handled(pending(request))),
          router.add("GET", route("/sessions/:id/history"), (request) =>
            handled(history(request))),
          router.add("GET", route("/sessions/:id/status"), (request) =>
            handled(status(request))),
          router.add("GET", route("/sessions/:id/events"), (request) =>
            handled(events(request)))
        ],
        { discard: true }
      )
    })
  )
