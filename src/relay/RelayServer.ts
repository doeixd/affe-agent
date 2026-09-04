import { Clock, Context, Duration, Effect, Layer, Option, Queue, Stream } from "effect"
import type { Headers } from "effect/unstable/http"
import type { Rpc, RpcGroup } from "effect/unstable/rpc"
import { StorageError } from "../Errors.js"
import * as Relay from "./Relay.js"
import * as RelayProtocol from "./RelayProtocol.js"

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
  "@doeixd/effect-agent/relay/RelayAuthenticator"
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
 * The coarse routing rule. Default: any authenticated peer may reach any
 * other; a deployment narrows it (same account, explicit sharing) here.
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
  readonly authorization?: Authorization | undefined
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
}

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
  options?: Options
): Layer.Layer<Rpc.ToHandler<RpcGroup.Rpcs<typeof RelayProtocol.Protocol>>, never, RelayAuthenticator> =>
  RelayProtocol.Protocol.toLayer(
    Effect.gen(function* () {
      const authenticator = yield* RelayAuthenticator
      const authorization = options?.authorization ?? allowAll
      const capacity = options?.inboundCapacity ?? 1024
      const lease = Duration.toMillis(options?.lease ?? Duration.seconds(60))
      const peers = new Map<Relay.PeerId, Entry>()

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
        const from = yield* authenticator.authenticate(headers)
        yield* Effect.annotateCurrentSpan("relay.from", from)
        yield* Effect.annotateCurrentSpan("relay.to", outbound.to)
        yield* Effect.annotateCurrentSpan("relay.endpoint", outbound.endpoint)
        yield* authorization.authorize({ from, to: outbound.to, endpoint: outbound.endpoint })
        touch(from, yield* Clock.currentTimeMillis)
        const now = yield* Clock.currentTimeMillis
        const target = peers.get(outbound.to)
        // The reachable connection, not a boolean and a second lookup: asking
        // twice invites the two answers to drift.
        const reachable = target === undefined
          ? Option.none<Connection>()
          : yield* live(outbound.to, target, now)
        if (Option.isNone(reachable)) {
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
          return yield* new Relay.RelayPeerOfflineError({ peer: outbound.to })
        }
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
