import { Context, Effect, Layer, Option } from "effect"
import type { Headers } from "effect/unstable/http"
import type * as AgentClient from "./AgentClient.js"
import type * as AgentProtocol from "./AgentProtocol.js"
import * as Internal from "./internal/sessionHost.js"

/**
 * The session host as a service the transport adapters share (#12 item 2).
 *
 * Before this, each adapter (`AgentHttp`, `AgentRpc`, `AgentAgUi`,
 * `AgentA2A`) built its own host from the same four options. An application
 * running HTTP *and* AG-UI in front of one client then had two hosts with two
 * session registries and two capacity limits for the same sessions -- a
 * session adopted by one was counted twice, and `maxSessions` did not mean
 * what it said. Now the host is one service, and every adapter given the same
 * tag serves the same registry, the same capacity, and the same authentication.
 *
 * A shared `Context` service cannot be generic in the application's principal,
 * so the application makes a *tag* for its principal type once and hands it to
 * each adapter:
 *
 * ```ts
 * const Host = AgentSessionHost.Tag<User>("app/AgentSessionHost")
 * const HostLive = AgentSessionHost.layer(Host, {
 *   principal: { resolve: ({ headers }) => authenticate(headers) },
 *   authorization: { authorize: ({ principal, operation }) => ... },
 *   maxSessions: 100,
 *   maxRequestsPerSession: 256
 * }).pipe(Layer.provide(AgentClient.layer(agent)))
 *
 * AgentHttp.serverLayer({ host: Host }).pipe(Layer.provide(HostLive))
 * AgentAgUi.serverLayer({ host: Host, session }).pipe(Layer.provide(HostLive))
 * ```
 *
 * Authentication happens in the host (`resolve`): an adapter hands it the
 * operation, the session in question and the request headers, and gets the
 * principal back -- or `AgentUnauthorizedError`. Authorization happens in the
 * host too, per operation, against that principal. Adapters carry headers;
 * they decide nothing about identity.
 */

/** What the host knows while authenticating one request. */
export interface PrincipalContext {
  readonly operation: AgentProtocol.Operation
  readonly sessionId: Option.Option<AgentProtocol.SessionId>
  readonly headers: Headers.Headers
  /**
   * The tenant the request addressed, when the transport carries one.
   *
   * Untrusted until the resolver joins it to the principal: it comes from a
   * URL path or a header, and a caller can put anything there. A resolver
   * that scopes storage by tenant must refuse a request whose addressed
   * tenant is not one its principal may act in -- the transport cannot make
   * that decision, because only the application knows the mapping. Absent on
   * transports with no tenant concept, which is most of them.
   */
  readonly tenant?: string | undefined
}

/** Turn a request's headers into the application's principal. */
export interface PrincipalResolver<Principal> {
  readonly resolve: (
    context: PrincipalContext
  ) => Effect.Effect<Principal, AgentProtocol.AgentUnauthorizedError>
}

export interface Options<Principal> {
  readonly principal: PrincipalResolver<Principal>
  readonly authorization: AgentProtocol.Authorization<Principal>
  /** Refuse new sessions at this bound; the host never evicts live work. */
  readonly maxSessions: number
  /** Completed request records are evicted FIFO when this bound is reached. */
  readonly maxRequestsPerSession: number
  /**
   * Events kept per session for the finite `eventLog` read; newest wins.
   * Default 256. A read from before what is held is refused, never served
   * with a gap.
   */
  readonly maxRetainedEvents?: number | undefined
}

/** The host's operations, plus request authentication. */
export interface Service<Principal> extends Internal.Host<Principal> {
  /**
   * Authenticate one request, annotating the current span with the operation
   * and session so every adapter's traces read the same.
   */
  readonly resolve: (
    context: PrincipalContext
  ) => Effect.Effect<Principal, AgentProtocol.AgentUnauthorizedError>
}

/** A host tag for one principal type. */
export type Tag<Principal> = Context.Service<Service<Principal>, Service<Principal>>

/**
 * Make the tag an application's adapters share. The string is the runtime
 * identity: two tags with one string are one service.
 */
export const Tag = <Principal>(id: string): Tag<Principal> =>
  Context.Service<Service<Principal>, Service<Principal>>(id)

/** Build the host for a tag. */
export const layer = <Principal>(
  tag: Tag<Principal>,
  options: Options<Principal>
): Layer.Layer<Service<Principal>, never, AgentClient.AgentClient> =>
  Layer.effect(
    tag,
    Effect.map(Internal.make(options), (host): Service<Principal> => ({
      ...host,
      resolve: (context) =>
        Effect.annotateCurrentSpan({
          "agent.operation": context.operation,
          ...(Option.isSome(context.sessionId)
            ? { "agent.session.id": context.sessionId.value }
            : {})
        }).pipe(Effect.andThen(options.principal.resolve(context)))
    }))
  )

/** Explicitly opt into an unauthenticated host, primarily for tests and examples. */
export const allowAll = Internal.allowAll
