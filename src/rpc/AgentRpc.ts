import { Context, Effect, Layer, Option, Scope, Stream } from "effect"
import { Headers } from "effect/unstable/http"
import {
  Rpc,
  RpcClient,
  RpcClientError,
  RpcGroup
} from "effect/unstable/rpc"
import { Prompt } from "effect/unstable/ai"
import * as AgentClient from "../client/AgentClient.js"
import * as AgentProtocol from "../client/AgentProtocol.js"
import * as AgentSessionHost from "../client/AgentSessionHost.js"
import * as Namespace from "../internal/namespace.js"

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
  Rpc.make("submit", {
    payload: AgentProtocol.SubmitRequest,
    success: AgentProtocol.SubmitResponse,
    error: AgentProtocol.RemoteError
  }),
  Rpc.make("awaitSubmission", {
    payload: AgentProtocol.AwaitSubmissionRequest,
    success: AgentProtocol.AwaitSubmissionResponse,
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
  Namespace.tag("rpc/Client")
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

/** Re-exported so an RPC deployment reads its auth types from one place. */
export type PrincipalContext = AgentSessionHost.PrincipalContext
export type PrincipalResolver<Principal> = AgentSessionHost.PrincipalResolver<Principal>
export type AuthorizationContext<Principal> =
  AgentProtocol.AuthorizationContext<Principal>
export type AuthorizationError = AgentProtocol.AuthorizationError

export interface ServerOptions<Principal> {
  /** The host this adapter serves. See `AgentSessionHost`. */
  readonly host: AgentSessionHost.Tag<Principal>
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
  AgentSessionHost.Service<Principal>
> =>
  Protocol.toLayer(
    Effect.gen(function* () {
      const host = yield* options.host

      const principal = (
        operation: AgentProtocol.Operation,
        sessionId: Option.Option<AgentProtocol.SessionId>,
        headers: Headers.Headers
      ) => host.resolve({ operation, sessionId, headers })

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
        submit: (request, context) =>
          principal(
            "submit",
            Option.some(request.sessionId),
            context.headers
          ).pipe(
            Effect.flatMap((identity) => host.submit(identity, request))
          ),
        awaitSubmission: (request, context) =>
          principal(
            "awaitSubmission",
            Option.some(request.sessionId),
            context.headers
          ).pipe(
            Effect.flatMap((identity) => host.awaitSubmission(identity, request))
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

// --- the client seam -------------------------------------------------------

/**
 * Adapt the RPC client to the `AgentClient` seam.
 *
 * Without this, RPC was the one advertised transport whose client side no
 * suite could see. `AgentClientConformance` covered the in-process, HTTP and
 * durable clients; the RPC file ran only the protocol-error contract, and the
 * relay -- which is Effect RPC over a bus -- ran a single hand-written test.
 * That is how the relay shipped with a teardown bug that was a *contract*
 * violation, caught by review rather than by a suite
 * (`docs/plan-failure-paths.md` 48f).
 *
 * The mapping is thinner than the HTTP one, and the reason is worth stating:
 * the RPC group declares `AgentProtocol.RemoteError`, so every anticipated
 * protocol failure arrives already typed and is passed straight through. Only
 * the transport's own `RpcClientError` has to be translated. HTTP has to
 * decode a status and a body back into the same union, which is where its
 * six-of-fifteen bug came from.
 */

/** A session id is required on the wire; a client-side operation without one is transport-shaped. */
const transportError = (sessionId: string, error: RpcClientError.RpcClientError) =>
  new AgentClient.AgentTransportError({
    sessionId,
    detail: `${error._tag}: ${error.message}`
  })

const liftRpc = (sessionId: string) =>
<A>(
  effect: Effect.Effect<A, AgentProtocol.RemoteError | RpcClientError.RpcClientError>
): Effect.Effect<A, AgentClient.RemoteError> =>
  Effect.mapError(effect, (error) =>
    error._tag === "RpcClientError" ? transportError(sessionId, error) : error)

let requestSeq = 0
const nextRequestId = (): AgentProtocol.RequestId => {
  requestSeq += 1
  return AgentProtocol.RequestId.make(`rpc-${requestSeq}-${globalThis.crypto.randomUUID()}`)
}

/**
 * The caller's idempotency key *is* the wire request id, as it is over HTTP.
 *
 * `requestId` already means "this mutation, once" to the host and
 * `idempotencyKey` means the same to a durable store; minting a fresh id for a
 * request the caller has named would make the two disagree. Absent a key the
 * generated id still holds across a retry of *this* effect, because it is
 * fixed when the effect is built rather than when it is run.
 */
const mutationId = (key: string | undefined): AgentProtocol.RequestId =>
  key === undefined ? nextRequestId() : AgentProtocol.RequestId.make(key)

export interface AgentClientOptions {
  /** Sent with every call; the credential lives here. */
  readonly headers?: Headers.Input | undefined
}

/** Adapt an RPC client to `AgentClient`. Exported for a caller holding its own client. */
export const agentClientFrom = (
  client: Service,
  options?: AgentClientOptions
): AgentClient.Service => {
  const auth = { headers: options?.headers ?? {} }

  const remoteSession = (id: string): AgentClient.RemoteSession => {
    const sessionId = AgentProtocol.SessionId.make(id)
    const lift = liftRpc(id)
    return {
      id,
      prompt: (input, promptOptions) =>
        lift(
          client.prompt({
            requestId: mutationId(promptOptions?.idempotencyKey),
            sessionId,
            input: AgentProtocol.input(input),
            options: { stream: promptOptions?.stream === true }
          }, auth)
        ).pipe(Effect.map((response) => response.result)),
      submit: (input, promptOptions) =>
        lift(
          client.submit({
            requestId: mutationId(promptOptions?.idempotencyKey),
            sessionId,
            input: AgentProtocol.input(input),
            options: { stream: promptOptions?.stream === true }
          }, auth)
        ).pipe(Effect.map((response) => ({ submissionId: response.submissionId }))),
      awaitSubmission: (submissionId) =>
        lift(
          client.awaitSubmission({
            sessionId,
            submissionId: AgentProtocol.SubmissionId.make(submissionId)
          }, auth)
        ).pipe(Effect.map((response) => response.result)),
      steer: (input) =>
        lift(
          client.steer({ requestId: nextRequestId(), sessionId, input: Prompt.make(input) }, auth)
        ).pipe(Effect.asVoid),
      followUp: (input) =>
        lift(
          client.followUp({ requestId: nextRequestId(), sessionId, input: Prompt.make(input) }, auth)
        ).pipe(Effect.asVoid),
      interrupt: () =>
        lift(client.interrupt({ requestId: nextRequestId(), sessionId }, auth)).pipe(Effect.asVoid),
      respond: (response) =>
        lift(
          client.respond({ requestId: nextRequestId(), sessionId, response }, auth)
        ).pipe(Effect.map((body) => body.matched)),
      pending: lift(client.pending({ sessionId }, auth)).pipe(
        Effect.map((body) => body.requests)
      ),
      history: lift(client.history({ sessionId }, auth)).pipe(
        Effect.map((body) => body.history)
      ),
      status: lift(client.status({ sessionId }, auth)).pipe(
        Effect.map((body) => body.status)
      ),
      /**
       * `after` is passed through rather than refused.
       *
       * The seam says an implementation that cannot resume must fail rather
       * than quietly handing back a live stream. This one does not have to
       * decide: the request carries the number to the host, which answers from
       * its delivery log or fails saying it has none. Refusing here would deny
       * resumption to a durable-backed host that can perfectly well provide it.
       */
      events: (eventOptions) =>
        client.events({
          sessionId,
          ...(eventOptions?.after === undefined ? {} : { after: eventOptions.after })
        }, auth).pipe(
          Stream.mapError((error) =>
            error._tag === "RpcClientError" ? transportError(id, error) : error
          )
        )
    }
  }

  return {
    createSession: (sessionOptions) =>
      liftRpc(sessionOptions?.sessionId ?? "")(
        client.createSession({
          requestId: nextRequestId(),
          ...(sessionOptions?.sessionId === undefined
            ? {}
            : { sessionId: AgentProtocol.SessionId.make(sessionOptions.sessionId) })
        }, auth)
      ).pipe(Effect.map((created) => remoteSession(created.session.sessionId))),
    session: (sessionId) =>
      liftRpc(sessionId)(
        client.getSession({ sessionId: AgentProtocol.SessionId.make(sessionId) }, auth)
      ).pipe(Effect.map((found) => remoteSession(found.sessionId)))
  }
}

/**
 * An `AgentClient` over whichever RPC protocol the application supplied.
 *
 * Composes with `clientLayer`, so the transport underneath is the
 * application's choice -- a WebSocket, a worker, or the relay, which is how
 * `/relay` joins the client contract without an adapter of its own.
 */
export const agentClientLayer = (
  options?: AgentClientOptions
): Layer.Layer<AgentClient.AgentClient, never, Client> =>
  Layer.effect(
    AgentClient.AgentClient,
    Effect.map(Client, (client) => agentClientFrom(client, options))
  )
