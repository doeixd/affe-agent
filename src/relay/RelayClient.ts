import { Cause, Context, Duration, Effect, Exit, Fiber, Layer, Option, Schedule, Schema, Scope, Stream, SubscriptionRef } from "effect"
import type { Headers } from "effect/unstable/http"
import { RpcClient, type RpcClientError } from "effect/unstable/rpc"
import * as Relay from "./Relay.js"
import * as RelayProtocol from "./RelayProtocol.js"
import * as Namespace from "../internal/namespace.js"

/**
 * A node's connection to the relay: one `listen` stream, dispatched to
 * whoever subscribed for an endpoint (a server, all channels) or for one
 * channel of it (a client protocol), and `send` for the other direction.
 *
 * It requires an `RpcClient.Protocol` to the relay -- a WebSocket in a
 * deployment, whatever the test hands it -- and never opens one itself, so
 * the relay's own transport stays the application's choice.
 */

export type Handler = (envelope: Relay.Envelope) => Effect.Effect<void>

export interface Service {
  /** This node's identity, as configured; the relay authenticates it independently. */
  readonly peer: Relay.PeerId
  /**
   * Hand an envelope to the destination peer's queue on the relay.
   *
   * Success means *handed over* (item 97): the peer was online and the
   * envelope is in its in-memory queue. Not delivered, not processed, not
   * persisted -- the relay never stores live traffic, so an offline peer is
   * refused rather than queued for later, and a peer that drops before
   * reading loses what was waiting. Acknowledge at the application level
   * when that matters.
   */
  readonly send: (
    outbound: Relay.Outbound
  ) => Effect.Effect<void, Relay.RelayError | RpcClientError.RpcClientError>
  /**
   * Receive envelopes for an endpoint -- every channel of it, or one
   * channel when `channel` is given. A channel subscription takes precedence
   * over the endpoint's, so a caller and a server for the same endpoint can
   * coexist on one node. Released with the scope.
   */
  readonly subscribe: (
    endpoint: Relay.EndpointId,
    handler: Handler,
    options?: { readonly channel?: Relay.ChannelId | undefined }
  ) => Effect.Effect<void, never, Scope.Scope>
  readonly peers: Effect.Effect<ReadonlyArray<Relay.PeerInfo>, Relay.RelayError | RpcClientError.RpcClientError>
  readonly heartbeat: Effect.Effect<Relay.Heartbeat, Relay.RelayError | RpcClientError.RpcClientError>
  readonly status: SubscriptionRef.SubscriptionRef<Relay.ConnectionStatus>
}

export class RelayClient extends Context.Service<RelayClient, Service>()(
  Namespace.tag("relay/RelayClient")
) {}

export interface Options {
  readonly peer: Relay.PeerId
  /** Sent with every call to the relay; the credential lives here. */
  readonly headers?: Headers.Input | undefined
  /**
   * How often to renew this node's lease. Default 20 seconds.
   *
   * Must be comfortably shorter than the relay's `lease`, which defaults to
   * 60 seconds, because a renewal that is merely *usually* in time expires
   * the node on the first slow one. A third of the lease leaves room for two
   * to go missing.
   *
   * Any traffic renews the lease, so a busy node would stay reachable without
   * this. A node that is only *serving* can be silent for a long time between
   * calls, which is exactly the node a directory must not lie about.
   */
  readonly heartbeatInterval?: Duration.Duration | undefined
  /**
   * How long to wait between attempts to come back. Default 1 second.
   *
   * Flat rather than exponential, and deliberately so: the socket underneath
   * already backs off exponentially when the application built it with a retry
   * policy, and stacking a second curve on that produces waits nobody chose.
   * This only paces re-issuing `listen` over a socket that is either there or
   * is being retried on its own schedule.
   */
  readonly reconnect?: Duration.Duration | undefined
}

const defaultReconnect = Duration.seconds(1)

const key = (endpoint: Relay.EndpointId, channel: Option.Option<Relay.ChannelId>) =>
  Option.match(channel, {
    onNone: () => `${endpoint}`,
    onSome: (channel) => `${endpoint}\u0000${channel}`
  })

/**
 * Which stream endings this node should try to come back from.
 *
 * The reason matters more than the fact. Two must *not* be retried, and one of
 * those would be actively harmful:
 *
 *   - **superseded.** Another connection authenticated as this same peer and
 *     took over. Reconnecting would supersede *them*, they would reconnect and
 *     supersede us, and two nodes sharing an identity would flap forever with
 *     each one's traffic landing wherever the race left it. Whoever arrived
 *     second keeps the identity; this one stays down and says why.
 *   - **unauthorized.** The credential is wrong. Retrying a wrong credential
 *     is a slower way of being wrong, and it hides a misconfiguration behind a
 *     connection that merely looks flaky.
 *
 * Everything else is worth another attempt: an expired lease *means* "you went
 * quiet", and coming back is the correct answer to it; a clean end is what a
 * relay restarting looks like.
 */
/**
 * Decided by the relay's own error schemas, not by tag strings. For a while
 * this held two package-prefixed literals and compared `_tag` against them,
 * which worked within one version and would have silently stopped working
 * on the day the package was renamed -- the errors would move and the check
 * would not, and supersession would become a retryable drop, which is the
 * flap this exists to prevent. The classes are the single source: a rename
 * moves both together.
 */
const Terminal = Schema.Union([Relay.RelaySupersededError, Relay.RelayUnauthorizedError])
// Decoded, not `Schema.is`: `is` on a class schema is an `instanceof` check,
// and the error may arrive as its encoded shape -- a plain object with the
// tag and fields -- rather than as an instance of *this* copy of the class.
// Decoding accepts both and still follows the classes. (The first version
// of this used `Schema.is`; the review caught it against a plain object.)
const decodeTerminal = Schema.decodeUnknownOption(Terminal)

/** Whether a failure ends reconnection for good. Exported for its test; not part of the surface. */
export const isTerminal = (cause: Cause.Cause<unknown>): boolean =>
  Option.isSome(Cause.findErrorOption(cause).pipe(Option.flatMap(decodeTerminal)))

/**
 * Connect, dispatch, and come back when the connection drops.
 *
 * Two layers of recovery, and the division is what keeps this small. The
 * `RpcClient.Protocol` the application supplies already reconnects its own
 * socket when it was built with a retry policy, and clears its error when the
 * socket reopens -- so the RPC client heals itself. What it does not do is
 * *replay requests*, and the long-lived `listen` stream is a request, so it
 * stays dead. Re-issuing it is this module's job, and it is nearly all there
 * is to reconnection: the relay holds no per-endpoint subscription state, it
 * routes to a peer, and this node dispatches locally from a `handlers` map
 * that never went anywhere.
 *
 * The *initial* connection is deliberately not retried. A node that cannot
 * reach the relay at startup fails loudly, because the likely cause is a wrong
 * address or credential, and a layer that hangs forever on a typo is worse
 * than one that fails. Once a connection has been established, losing it is a
 * fact about the network rather than the configuration, and this reconnects
 * for as long as the scope lives.
 */
export const make = Effect.fn("RelayClient.make")(function* (options: Options) {
  const relay = yield* RpcClient.make(RelayProtocol.Protocol)
  const auth = { headers: options.headers }
  const status = yield* SubscriptionRef.make<Relay.ConnectionStatus>({ _tag: "connecting" })
  const handlers = new Map<string, Handler>()

  const dispatch = (envelope: Relay.Envelope) => {
    const handler = handlers.get(key(envelope.endpoint, Option.some(envelope.channel))) ??
      handlers.get(key(envelope.endpoint, Option.none()))
    return handler === undefined
      ? Effect.logDebug("relay envelope for an endpoint nobody serves", {
        endpoint: envelope.endpoint,
        channel: envelope.channel,
        from: envelope.from
      })
      : handler(envelope)
  }

  const heartbeat = relay.heartbeat({}, auth)

  /**
   * One connected lifetime: listen, prove registration, serve until it ends.
   *
   * `listen` is answered as soon as the relay has registered the connection,
   * so the first heartbeat succeeding is the moment this node is reachable --
   * which is why the status becomes `online` only after it, on a reconnect as
   * much as on the first attempt.
   */
  const session = Effect.scoped(
    Effect.gen(function* () {
      /**
       * Scoped per attempt, which matters more than it looks.
       *
       * `forkChild` here would attach the drain to the *loop* fibre below,
       * not to this attempt, so an attempt that failed before joining it --
       * a heartbeat that did not come back, say -- would leave the `listen`
       * stream running and start another one on the next pass. Those are not
       * idle fibres: each is a registered connection at the relay, and the
       * next one supersedes the last, so a relay that is merely slow to
       * answer heartbeats would have produced a churn of connections
       * superseding each other. Closing this scope on the way out, however
       * the attempt ended, is what keeps one attempt to one connection.
       */
      const draining = yield* Effect.forkScoped(
        Stream.runDrain(Stream.tap(relay.listen({}, auth), dispatch))
      )
      const beat = yield* heartbeat
      yield* SubscriptionRef.set(status, { _tag: "online", since: beat.serverTime })
      // Ends when the connection does, carrying the reason with it.
      return yield* Fiber.join(draining)
    })
  )

  // The first attempt is awaited, so a bad address or credential fails the
  // layer here rather than disappearing into the loop below.
  const running = yield* Effect.forkChild(session)
  const settled = yield* Effect.raceFirst(
    Effect.as(Stream.runHead(SubscriptionRef.changes(status).pipe(
      Stream.filter((state) => state._tag === "online")
    )), "online" as const),
    Effect.as(Fiber.await(running), "ended" as const)
  )
  if (settled === "ended") {
    const exit = yield* Fiber.await(running)
    if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
  }

  const backoff = options.reconnect ?? defaultReconnect
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      let ending = yield* Effect.exit(Fiber.join(running))
      while (true) {
        if (Exit.isFailure(ending) && isTerminal(ending.cause)) {
          return yield* SubscriptionRef.set(status, {
            _tag: "offline",
            cause: Option.some(String(ending.cause))
          })
        }
        yield* SubscriptionRef.set(status, { _tag: "connecting" })
        yield* Effect.sleep(backoff)
        ending = yield* Effect.exit(session)
      }
    })
  )

  // Renewal, forked into the caller's scope so it stops when the node does.
  //
  // A failure here is not fatal on its own: one lost heartbeat is a slow
  // network, not a dead relay, and the lease is long enough to absorb it. What
  // actually reports the connection dying is the `listen` stream ending, which
  // is the one signal that cannot be a transient.
  const interval = options.heartbeatInterval ?? Duration.seconds(20)
  yield* Effect.forkScoped(
    Effect.repeat(
      Effect.ignore(heartbeat),
      Schedule.spaced(interval)
    ).pipe(Effect.delay(interval))
  )

  const service: Service = {
    peer: options.peer,
    send: (outbound) => relay.send(outbound, auth),
    subscribe: (endpoint, handler, subscribeOptions) =>
      Effect.gen(function* () {
        const id = key(endpoint, Option.fromNullishOr(subscribeOptions?.channel))
        handlers.set(id, handler)
        yield* Effect.addFinalizer(() => Effect.sync(() => handlers.delete(id)))
      }),
    peers: relay.peers({}, auth),
    heartbeat,
    status
  }
  return service
})

export const layer = (options: Options): Layer.Layer<RelayClient, RpcClientError.RpcClientError | Relay.RelayError, RpcClient.Protocol> =>
  Layer.effect(RelayClient, make(options))
