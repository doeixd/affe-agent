import { Context, Effect, Layer, Option, Scope, Stream } from "effect"
import { Headers } from "effect/unstable/http"
import {
  Rpc,
  RpcClient,
  RpcClientError,
  RpcGroup
} from "effect/unstable/rpc"
import * as AgentClient from "../client/AgentClient.js"
import * as AgentProtocol from "../client/AgentProtocol.js"
import * as AgentSessionHost from "../client/internal/sessionHost.js"

/**
 * The Effect RPC rendering of the canonical remote-session protocol.
 *
 * The schemas live under `/client`; this group only assigns RPC procedure
 * names and marks `events` as a stream. Keeping that division means a plain
 * HTTP adapter can share every value and error without depending on RPC.
 */
export const Protocol = RpcGroup.make(
  Rpc.make("createSession", {
    payload: AgentProtocol.CreateSessionRequest,
    success: AgentProtocol.CreateSessionResponse,
    error: AgentProtocol.RemoteError
  }),
  Rpc.make("closeSession", {
    payload: AgentProtocol.CloseSessionRequest,
    success: AgentProtocol.CloseSessionResponse,
    error: AgentProtocol.RemoteError
  }),
  Rpc.make("getSession", {
    payload: AgentProtocol.GetSessionRequest,
    success: AgentProtocol.GetSessionResponse,
    error: AgentProtocol.RemoteError
  }),
  Rpc.make("prompt", {
    payload: AgentProtocol.PromptRequest,
    success: AgentProtocol.PromptResponse,
    error: AgentProtocol.RemoteError
  }),
  Rpc.make("steer", {
    payload: AgentProtocol.SteerRequest,
    success: AgentProtocol.SteerResponse,
    error: AgentProtocol.RemoteError
  }),
  Rpc.make("followUp", {
    payload: AgentProtocol.FollowUpRequest,
    success: AgentProtocol.FollowUpResponse,
    error: AgentProtocol.RemoteError
  }),
  Rpc.make("interrupt", {
    payload: AgentProtocol.InterruptRequest,
    success: AgentProtocol.InterruptResponse,
    error: AgentProtocol.RemoteError
  }),
  Rpc.make("respond", {
    payload: AgentProtocol.RespondRequest,
    success: AgentProtocol.RespondResponse,
    error: AgentProtocol.RemoteError
  }),
  Rpc.make("pending", {
    payload: AgentProtocol.PendingRequest,
    success: AgentProtocol.PendingResponse,
    error: AgentProtocol.RemoteError
  }),
  Rpc.make("history", {
    payload: AgentProtocol.HistoryRequest,
    success: AgentProtocol.HistoryResponse,
    error: AgentProtocol.RemoteError
  }),
  Rpc.make("status", {
    payload: AgentProtocol.StatusRequest,
    success: AgentProtocol.StatusResponse,
    error: AgentProtocol.RemoteError
  }),
  Rpc.make("events", {
    payload: AgentProtocol.EventsRequest,
    success: AgentProtocol.EventsResponse,
    error: AgentProtocol.RemoteError,
    stream: true
  })
)

/** The schema-derived client. Its methods retain each procedure's exact type. */
export type Service = RpcClient.FromGroup<
  typeof Protocol,
  RpcClientError.RpcClientError
>

export class Client extends Context.Service<Client, Service>()(
  "@doeixd/effect-agent/rpc/Client"
) {}

/**
 * Build a schema-aware client using whichever Effect RPC protocol layer the
 * application supplies (HTTP, WebSocket, socket, worker, or a custom one).
 */
export const clientLayer: Layer.Layer<
  Client,
  never,
  RpcClient.Protocol
> = Layer.effect(Client, RpcClient.make(Protocol))

/** Metadata available while resolving the principal for one RPC call. */
export interface PrincipalContext {
  readonly operation: AgentProtocol.Operation
  readonly sessionId: Option.Option<AgentProtocol.SessionId>
  readonly headers: Headers.Headers
}

/** Authentication is request-specific; authorization remains host-specific. */
export interface PrincipalResolver<Principal> {
  readonly resolve: (
    context: PrincipalContext
  ) => Effect.Effect<Principal, AgentProtocol.AgentUnauthorizedError>
}

export type AuthorizationContext<Principal> =
  AgentProtocol.AuthorizationContext<Principal>
export type AuthorizationError = AgentProtocol.AuthorizationError

export interface ServerOptions<Principal> {
  readonly authorization: AgentProtocol.Authorization<Principal>
  readonly maxSessions: number
  readonly maxRequestsPerSession: number
  readonly principal: PrincipalResolver<Principal>
}

const sessionIdOf = (
  request: { readonly sessionId?: AgentProtocol.SessionId | undefined }
): Option.Option<AgentProtocol.SessionId> =>
  request.sessionId === undefined
    ? Option.none()
    : Option.some(request.sessionId)

/**
 * Handlers backed by one scoped session host.
 *
 * This layer deliberately stops at Effect RPC handlers. Applications choose
 * and wire the server protocol with `RpcServer.layer` / `layerHttp`, so the
 * harness does not hide upstream transport configuration or serialization.
 */
export const serverLayer = <Principal>(
  options: ServerOptions<Principal>
): Layer.Layer<
  Rpc.ToHandler<RpcGroup.Rpcs<typeof Protocol>>,
  never,
  AgentClient.AgentClient
> =>
  Protocol.toLayer(
    Effect.gen(function* () {
      const host = yield* AgentSessionHost.make(options)

      const principal = Effect.fn("AgentRpc.principal")(function* (
        operation: AgentProtocol.Operation,
        sessionId: Option.Option<AgentProtocol.SessionId>,
        headers: Headers.Headers
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
          headers
        })
      })

      return {
        createSession: (request, context) =>
          principal("createSession", sessionIdOf(request), context.headers).pipe(
            Effect.flatMap((identity) => host.createSession(identity, request))
          ),
        closeSession: (request, context) =>
          principal(
            "closeSession",
            Option.some(request.sessionId),
            context.headers
          ).pipe(
            Effect.flatMap((identity) =>
              host.closeSession(identity, request)
            )
          ),
        getSession: (request, context) =>
          principal(
            "getSession",
            Option.some(request.sessionId),
            context.headers
          ).pipe(
            Effect.flatMap((identity) => host.session(identity, request))
          ),
        prompt: (request, context) =>
          principal(
            "prompt",
            Option.some(request.sessionId),
            context.headers
          ).pipe(
            Effect.flatMap((identity) => host.prompt(identity, request))
          ),
        steer: (request, context) =>
          principal(
            "steer",
            Option.some(request.sessionId),
            context.headers
          ).pipe(
            Effect.flatMap((identity) => host.steer(identity, request))
          ),
        followUp: (request, context) =>
          principal(
            "followUp",
            Option.some(request.sessionId),
            context.headers
          ).pipe(
            Effect.flatMap((identity) => host.followUp(identity, request))
          ),
        interrupt: (request, context) =>
          principal(
            "interrupt",
            Option.some(request.sessionId),
            context.headers
          ).pipe(
            Effect.flatMap((identity) => host.interrupt(identity, request))
          ),
        respond: (request, context) =>
          principal(
            "respond",
            Option.some(request.sessionId),
            context.headers
          ).pipe(
            Effect.flatMap((identity) => host.respond(identity, request))
          ),
        pending: (request, context) =>
          principal(
            "pending",
            Option.some(request.sessionId),
            context.headers
          ).pipe(
            Effect.flatMap((identity) => host.pending(identity, request))
          ),
        history: (request, context) =>
          principal(
            "history",
            Option.some(request.sessionId),
            context.headers
          ).pipe(
            Effect.flatMap((identity) => host.history(identity, request))
          ),
        status: (request, context) =>
          principal(
            "status",
            Option.some(request.sessionId),
            context.headers
          ).pipe(
            Effect.flatMap((identity) => host.status(identity, request))
          ),
        events: (request, context) =>
          Stream.unwrap(
            principal(
              "events",
              Option.some(request.sessionId),
              context.headers
            ).pipe(
              Effect.flatMap((identity) => host.events(identity, request))
            )
          )
      }
    })
  )

/**
 * Create a remotely owned session and close it when the caller's scope closes.
 *
 * Calling `Client.getSession` attaches to an existing session and deliberately
 * installs no finalizer. Ownership is therefore explicit at the call site.
 */
export const acquireSession = Effect.fn("AgentRpc.acquireSession")(function* (
  request: AgentProtocol.CreateSessionRequest,
  options?: { readonly headers?: Headers.Input | undefined }
) {
  const client = yield* Client
  const response = yield* client.createSession(request, {
    headers: options?.headers
  })
  yield* Scope.addFinalizer(
    yield* Effect.scope,
    client.closeSession(
      {
        // Derived from the owning create request so finalizer retries remain
        // idempotent without introducing a random/crypto requirement.
        requestId: AgentProtocol.RequestId.make(`${request.requestId}:close`),
        sessionId: response.session.sessionId
      },
      { headers: options?.headers }
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to close remotely owned agent session", {
          sessionId: response.session.sessionId,
          cause
        })
      ),
      Effect.asVoid
    )
  )
  return response
})
