import { Clock, Context, Duration, Effect, Layer, Metric, Option, Queue, Stream } from "effect"
import type { Headers } from "effect/unstable/http"
import type { Rpc, RpcGroup } from "effect/unstable/rpc"
import { StorageError } from "../Errors.js"
import * as Relay from "./Relay.js"
import * as RelayProtocol from "./RelayProtocol.js"
import * as Namespace from "../internal/namespace.js"

/**
 * The relay: an in-memory route table keyed by `PeerId`, one bounded inbound
 * queue per online peer, and a directory. It knows source, destination,
 * endpoint and an opaque frame, and nothing about agents.
 *
 * Authentication is a service the deployment provides
 * (`RelayAuthenticator`): the relay never trusts a `from` a caller sends;
 * the source of every envelope is whoever the connection authenticated as.
 */

/**
 * Resolve the connection's headers to the peer they belong to.
 *
 * The error channel carries `StorageError` as well as
 * `RelayUnauthorizedError`, and the distinction is load-bearing rather than
 * tidy: an authenticator backed by a store can fail to *ask* the question, and
 * `RelayClient` treats an unauthorized answer as terminal -- retrying a wrong
 * credential is a slower way of being wrong. Folding a database blip into that
 * answer would take every node in a fleet permanently offline over a
 * transient. A store that cannot answer says so, and the node comes back when
 * it can.
 */
export interface AuthenticatorService {
  readonly authenticate: (
    headers: Headers.Headers
  ) => Effect.Effect<Relay.PeerId, Relay.RelayUnauthorizedError | StorageError>
}

export class RelayAuthenticator extends Context.Service<RelayAuthenticator, AuthenticatorService>()(
  Namespace.tag("relay/RelayAuthenticator")
) {}

/**
 * The V1 credential scheme's simplest form: a fixed map from bearer token to
 * peer. Enrollment, rotation and revocation arrive as a store behind the
 * same service; the relay's routing does not change when they do.
 */
export const bearerTokens = (
  tokens: Readonly<Record<string, Relay.PeerId>>
): Layer.Layer<RelayAuthenticator> =>
  Layer.succeed(RelayAuthenticator, {
    authenticate: (headers) => {
      const authorization = headers["authorization"]
      if (authorization === undefined) {
        return Effect.fail(new Relay.RelayUnauthorizedError({ reason: "no authorization header" }))
      }
      const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : authorization
      const peer = tokens[token]
      return peer === undefined
        ? Effect.fail(new Relay.RelayUnauthorizedError({ reason: "unknown credential" }))
        : Effect.succeed(peer)
    }
  })

/**
 * The coarse routing rule: which authenticated peer may reach which. A
 * deployment narrows it (same account, explicit sharing) here. Required --
 * the relay is network-facing -- with `allowAll` as the explicit opt-out.
 */
export interface Authorization {
  readonly authorize: (options: {
    readonly from: Relay.PeerId
    readonly to: Relay.PeerId
    readonly endpoint: Relay.EndpointId
  }) => Effect.Effect<void, Relay.RelayForbiddenError>
}

export const allowAll: Authorization = { authorize: () => Effect.void }

export interface Options {
  /** Required: see `Authorization`. It used to default to `allowAll` (item 110). */
  readonly authorization: Authorization
  /**
   * How long a peer stays reachable without proving it is there. Default 60
   * seconds.
   *
   * Renewed by *any* traffic from the peer, not only `heartbeat`: a node that
   * is answering calls has already demonstrated the thing a heartbeat is
   * asking about. A connection that lets the lease lapse has its `listen`
   * stream ended with `RelayLeaseExpiredError`, and stops being routable
   * before that -- the directory saying "online" for a peer nothing can reach
   * is worse than saying nothing.
   *
   * Collected when the relay is already doing something (a send, a listing),
   * not by a reaper fibre: the relay has no background loop and should not
   * grow one, and whoever asks is the one who collects, so the answer a caller
   * gets and the state the relay holds cannot disagree.
   *
   * The consequence is worth stating, because it surprises people: a lapsed
   * peer is not dropped until somebody asks about it, so a node nobody is
   * trying to reach can stay registered long past its lease. Nothing is lost
   * by that. Expiry exists so a sender is not routed into a queue nobody
   * drains and so the directory does not claim an unreachable peer is online,
   * and both of those are questions, answered when they are asked. A node that
   * has genuinely gone is not there to be told sooner either way -- and one
   * that is still there, on a socket that merely looks alive to the relay,
   * finds out the moment its first would-be caller does.
   */
  readonly lease?: Duration.Duration | undefined
  /**
   * Frames buffered per online peer before `send` suspends its caller.
   * Backpressure, not a drop: a slow reader slows its senders rather than
   * growing the relay's memory. Default 1024.
   */
  readonly inboundCapacity?: number | undefined
  /**
   * Each sender's send rate (item 117, relay phase 14): a token bucket per
   * authenticated peer, refilled at `perSecond` and holding at most `burst`
   * (default `perSecond`). A send past it fails with `RelayRateLimitedError`
   * and its `retryAfterMs`, rather than being dropped or slowing everyone
   * else's traffic behind it. Absent: unlimited, as before.
   */
  readonly sendRate?: { readonly perSecond: number; readonly burst?: number | undefined } | undefined
  /**
   * Told about every connection and every refused send, for an audit trail.
   * Its own failure is logged and never becomes the sender's. Called inline,
   * so the trail is in order and a refusal is recorded before its sender
   * hears of it -- which also means a slow hook delays that reply: hand the
   * event to a queue if writing it is slow.
   */
  readonly audit?: ((event: AuditEvent) => Effect.Effect<void>) | undefined
}

/** What the relay reports to `Options.audit`. */
export type AuditEvent =
  | { readonly _tag: "Connected"; readonly peer: Relay.PeerId; readonly at: number }
  | {
    readonly _tag: "Refused"
    readonly reason: "unauthenticated" | "rate-limited" | "forbidden" | "offline"
    /** Absent when the sender could not be authenticated. */
    readonly from: Option.Option<Relay.PeerId>
    readonly to: Relay.PeerId
    readonly endpoint: Relay.EndpointId
    readonly at: number
  }

/**
 * Sends by outcome (`delivered`, `unauthenticated`, `rate-limited`,
 * `forbidden`, `offline`) and connections opened: what an operator watches.
 */
export const metrics = {
  sends: Metric.counter("relay_sends", { description: "Relay sends, by outcome", incremental: true }),
  connections: Metric.counter("relay_connections", { description: "Relay connections opened", incremental: true })
} as const

interface Connection {
  readonly queue: Queue.Queue<Relay.Envelope, Relay.ConnectionEnded>
  readonly connectedAt: number
}

interface Entry {
  readonly connection: Option.Option<Connection>
  readonly lastSeenAt: number
}

/**
 * The protocol's handlers. Mount them the way `AgentRpc.serverLayer` is
 * mounted: `RpcServer.layerHttp({ group: RelayProtocol.Protocol, protocol:
 * "websocket", path })` over an HTTP server, with an `RpcSerialization`.
 */
export const layer = (
  options: Options
): Layer.Layer<Rpc.ToHandler<RpcGroup.Rpcs<typeof RelayProtocol.Protocol>>, never, RelayAuthenticator> =>
  RelayProtocol.Protocol.toLayer(
    Effect.gen(function* () {
      const authenticator = yield* RelayAuthenticator
      const authorization = options.authorization
      const capacity = options.inboundCapacity ?? 1024
      const lease = Duration.toMillis(options.lease ?? Duration.seconds(60))
      const peers = new Map<Relay.PeerId, Entry>()
      const rate = options.sendRate
      if (rate !== undefined && !(rate.perSecond > 0 && (rate.burst === undefined || rate.burst >= 1))) {
        return yield* Effect.die(new RangeError("RelayServer: sendRate needs perSecond > 0 and burst >= 1"))
      }
      const buckets = new Map<Relay.PeerId, { readonly tokens: number; readonly at: number }>()

      /** `None` if the send is admitted; otherwise how long until one would be. */
      const admit = (peer: Relay.PeerId, now: number): Option.Option<number> => {
        if (rate === undefined) return Option.none()
        const burst = rate.burst ?? rate.perSecond
        const held = buckets.get(peer) ?? { tokens: burst, at: now }
        const tokens = Math.min(burst, held.tokens + ((now - held.at) * rate.perSecond) / 1000)
        if (tokens >= 1) {
          buckets.set(peer, { tokens: tokens - 1, at: now })
          return Option.none()
        }
        buckets.set(peer, { tokens, at: now })
        return Option.some(Math.ceil(((1 - tokens) * 1000) / rate.perSecond))
      }

      const report = (event: AuditEvent): Effect.Effect<void> =>
        options.audit === undefined
          ? Effect.void
          : options.audit(event).pipe(Effect.catchCause((cause) => Effect.logWarning("relay: the audit hook failed", cause)))

      const outcome = (name: string) => Metric.update(Metric.withAttributes(metrics.sends, { outcome: name }), 1)

      const refused = (
        reason: Extract<AuditEvent, { _tag: "Refused" }>["reason"],
        from: Option.Option<Relay.PeerId>,
        outbound: Relay.Outbound,
        at: number
      ) =>
        Effect.andThen(
          outcome(reason),
          report({ _tag: "Refused", reason, from, to: outbound.to, endpoint: outbound.endpoint, at })
        )

      /**
       * Whether this peer is reachable *now*, expiring it if not.
       *
       * The expiry happens here rather than in a sweep, so the answer a caller
       * gets and the state the relay holds cannot disagree: whoever asks is
       * the one who collects.
       */
      const live = (
        peer: Relay.PeerId,
        entry: Entry,
        now: number
      ): Effect.Effect<Option.Option<Connection>> =>
        Effect.gen(function* () {
          if (Option.isNone(entry.connection)) return Option.none()
          if (now - entry.lastSeenAt <= lease) return entry.connection
          peers.set(peer, { connection: Option.none(), lastSeenAt: entry.lastSeenAt })
          // Ending the stream is how the node finds out, if it is still there
          // to find out: `RelayClient` moves to `offline` with the reason.
          yield* Queue.fail(entry.connection.value.queue, new Relay.RelayLeaseExpiredError({ peer }))
          return Option.none()
        })

      const touch = (peer: Relay.PeerId, now: number) => {
        const entry = peers.get(peer)
        peers.set(peer, { connection: entry === undefined ? Option.none() : entry.connection, lastSeenAt: now })
      }

      const listen = Effect.fn("RelayServer.listen")(function* (headers: Headers.Headers) {
        const peer = yield* authenticator.authenticate(headers)
        yield* Effect.annotateCurrentSpan("relay.peer", peer)
        const now = yield* Clock.currentTimeMillis
        const queue = yield* Queue.make<Relay.Envelope, Relay.ConnectionEnded>({ capacity, strategy: "suspend" })
        const previous = peers.get(peer)
        if (previous !== undefined && Option.isSome(previous.connection)) {
          // Newest authenticated connection wins; the old stream ends with the reason.
          yield* Queue.fail(previous.connection.value.queue, new Relay.RelaySupersededError({ peer }))
        }
        const connection: Connection = { queue, connectedAt: now }
        peers.set(peer, { connection: Option.some(connection), lastSeenAt: now })
        yield* Metric.update(metrics.connections, 1)
        yield* report({ _tag: "Connected", peer, at: now })
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const current = peers.get(peer)
            // Only the connection that registered itself marks the peer offline;
            // a superseded one leaving must not evict its successor.
            if (current !== undefined && Option.isSome(current.connection) && current.connection.value === connection) {
              peers.set(peer, { connection: Option.none(), lastSeenAt: yield* Clock.currentTimeMillis })
            }
            yield* Queue.shutdown(queue)
          })
        )
        return Stream.fromQueue(queue)
      })

      const send = Effect.fn("RelayServer.send")(function* (outbound: Relay.Outbound, headers: Headers.Headers) {
        const arrived = yield* Clock.currentTimeMillis
        const from = yield* authenticator.authenticate(headers).pipe(
          Effect.tapError((error) =>
            error._tag === Namespace.tag("relay/RelayUnauthorizedError")
              ? refused("unauthenticated", Option.none(), outbound, arrived)
              : Effect.void
          )
        )
        yield* Effect.annotateCurrentSpan("relay.from", from)
        yield* Effect.annotateCurrentSpan("relay.to", outbound.to)
        yield* Effect.annotateCurrentSpan("relay.endpoint", outbound.endpoint)
        // Before authorization, so a flood of forbidden sends is limited too.
        const wait = admit(from, arrived)
        if (Option.isSome(wait)) {
          yield* refused("rate-limited", Option.some(from), outbound, arrived)
          return yield* new Relay.RelayRateLimitedError({ peer: from, retryAfterMs: wait.value })
        }
        yield* authorization.authorize({ from, to: outbound.to, endpoint: outbound.endpoint }).pipe(
          Effect.tapError(() => refused("forbidden", Option.some(from), outbound, arrived))
        )
        touch(from, yield* Clock.currentTimeMillis)
        const now = yield* Clock.currentTimeMillis
        const target = peers.get(outbound.to)
        // The reachable connection, not a boolean and a second lookup: asking
        // twice invites the two answers to drift.
        const reachable = target === undefined
          ? Option.none<Connection>()
          : yield* live(outbound.to, target, now)
        if (Option.isNone(reachable)) {
          yield* refused("offline", Option.some(from), outbound, arrived)
          return yield* new Relay.RelayPeerOfflineError({ peer: outbound.to })
        }
        const envelope: Relay.Envelope = {
          from,
          to: outbound.to,
          endpoint: outbound.endpoint,
          channel: outbound.channel,
          frame: outbound.frame
        }
        const accepted = yield* Queue.offer(reachable.value.queue, envelope)
        if (!accepted) {
          yield* refused("offline", Option.some(from), outbound, arrived)
          return yield* new Relay.RelayPeerOfflineError({ peer: outbound.to })
        }
        yield* outcome("delivered")
      })

      const heartbeat = Effect.fn("RelayServer.heartbeat")(function* (headers: Headers.Headers) {
        const peer = yield* authenticator.authenticate(headers)
        const now = yield* Clock.currentTimeMillis
        touch(peer, now)
        return { serverTime: now }
      })

      const list = Effect.fn("RelayServer.peers")(function* (headers: Headers.Headers) {
        yield* authenticator.authenticate(headers)
        const now = yield* Clock.currentTimeMillis
        const all: Array<Relay.PeerInfo> = []
        // Snapshotted first: `live` expires entries as it goes, and mutating
        // the map underneath its own iteration is how a listing quietly starts
        // skipping peers.
        for (const [id, entry] of [...peers]) {
          const reachable = yield* live(id, entry, now)
          all.push({
            id,
            status: Option.isSome(reachable) ? "online" : "offline",
            connectedAt: Option.map(reachable, (connection) => connection.connectedAt),
            lastSeenAt: (peers.get(id) ?? entry).lastSeenAt
          })
        }
        return all
      })

      return {
        listen: (_, context) => Stream.unwrap(listen(context.headers)),
        send: (outbound, context) => send(outbound, context.headers),
        heartbeat: (_, context) => heartbeat(context.headers),
        peers: (_, context) => list(context.headers)
      }
    })
  )
