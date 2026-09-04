import { Option, Schema } from "effect"
import { StorageError } from "../Errors.js"

/**
 * The relay's vocabulary: who a node is, which endpoint on it a message is
 * for, and the envelope the relay routes. The relay never reads a payload;
 * an envelope's `frame` is an encoded Effect RPC message the two ends
 * understand and the relay only carries (`docs/plan-relay.txt`, "the public
 * relay protocol can be tiny").
 */

/** One authenticated running node. */
export const PeerId = Schema.String.pipe(Schema.brand("affe-agent/relay/PeerId"))
export type PeerId = typeof PeerId.Type

/** A named RPC surface a peer serves, e.g. `affe-agent/agent`. */
export const EndpointId = Schema.String.pipe(Schema.brand("affe-agent/relay/EndpointId"))
export type EndpointId = typeof EndpointId.Type

/**
 * One logical RPC connection between a caller and an endpoint. A caller
 * opens a channel per client protocol instance; the target keys its RPC
 * clients by (caller, channel), so two callers on one peer never share
 * request-id space.
 */
export const ChannelId = Schema.String.pipe(Schema.brand("affe-agent/relay/ChannelId"))
export type ChannelId = typeof ChannelId.Type

/**
 * The reserved header the target's RPC server stamps on every request with
 * the relay-authenticated source peer, after stripping any caller-supplied
 * value. An `AgentSessionHost` principal resolver reads it to map a peer to
 * a principal; a caller cannot forge it.
 */
export const PEER_HEADER = "x-relay-peer"

/** What a caller sends: the relay fills in `from` from the authenticated connection. */
export const Outbound = Schema.Struct({
  to: PeerId,
  endpoint: EndpointId,
  channel: ChannelId,
  /** An encoded RPC frame; opaque to the relay. */
  frame: Schema.Unknown
})
export type Outbound = typeof Outbound.Type

/** What a peer receives: `from` is authoritative, set by the relay. */
export const Envelope = Schema.Struct({
  from: PeerId,
  to: PeerId,
  endpoint: EndpointId,
  channel: ChannelId,
  frame: Schema.Unknown
})
export type Envelope = typeof Envelope.Type

export const PeerStatus = Schema.Literals(["online", "offline"])
export type PeerStatus = typeof PeerStatus.Type

/** A directory entry. Timestamps are epoch milliseconds. */
export const PeerInfo = Schema.Struct({
  id: PeerId,
  status: PeerStatus,
  /** Present while online. */
  connectedAt: Schema.Option(Schema.Number),
  lastSeenAt: Schema.Number
})
export type PeerInfo = typeof PeerInfo.Type

export const Heartbeat = Schema.Struct({
  /** The relay's clock, so a peer can measure skew. */
  serverTime: Schema.Number
})
export type Heartbeat = typeof Heartbeat.Type

// --- errors --------------------------------------------------------------

/** The connection carried no credential the relay recognises. */
export class RelayUnauthorizedError extends Schema.TaggedError<RelayUnauthorizedError>()(
  "affe-agent/relay/RelayUnauthorizedError",
  { reason: Schema.String }
) {
  override get message() {
    return `relay refused the connection: ${this.reason}`
  }
}

/** The target peer has no live connection. Live traffic is never queued. */
export class RelayPeerOfflineError extends Schema.TaggedError<RelayPeerOfflineError>()(
  "affe-agent/relay/RelayPeerOfflineError",
  { peer: PeerId }
) {
  override get message() {
    return `relay peer ${this.peer} is offline`
  }
}

/**
 * A newer authenticated connection for the same peer replaced this one
 * ("newest wins", so a stale half-open laptop connection never keeps
 * receiving traffic).
 */
export class RelaySupersededError extends Schema.TaggedError<RelaySupersededError>()(
  "affe-agent/relay/RelaySupersededError",
  { peer: PeerId }
) {
  override get message() {
    return `relay connection for ${this.peer} was superseded by a newer one`
  }
}

/**
 * The peer stopped proving it was there.
 *
 * A socket can be half-open for a long time -- a laptop that slept, a NAT that
 * dropped the mapping -- and the relay cannot tell that from a quiet peer by
 * looking at the socket. So liveness is a lease the peer renews, by any traffic
 * or by `heartbeat`, and a connection that lets it lapse is ended rather than
 * left in the directory claiming to be reachable.
 */
export class RelayLeaseExpiredError extends Schema.TaggedError<RelayLeaseExpiredError>()(
  "affe-agent/relay/RelayLeaseExpiredError",
  { peer: PeerId }
) {
  override get message() {
    return `relay connection for ${this.peer} expired its lease`
  }
}

/** Why the relay ended a connection's `listen` stream. */
export type ConnectionEnded = RelaySupersededError | RelayLeaseExpiredError

/** The relay's routing rule refused the send. */
export class RelayForbiddenError extends Schema.TaggedError<RelayForbiddenError>()(
  "affe-agent/relay/RelayForbiddenError",
  { from: PeerId, to: PeerId, endpoint: EndpointId }
) {
  override get message() {
    return `relay refused ${this.from} -> ${this.to}/${this.endpoint}`
  }
}

/** Every error the relay's own protocol can answer with. */
export const RelayError = Schema.Union([
  RelayUnauthorizedError,
  RelayPeerOfflineError,
  RelaySupersededError,
  RelayLeaseExpiredError,
  RelayForbiddenError,
  // An authenticator with a store behind it can fail to ask its question.
  // Typed rather than a defect, because the caller's correct response is to
  // try again, and a defect does not say that.
  StorageError
])
export type RelayError = typeof RelayError.Type

/** A peer's view of its relay connection. */
export type ConnectionStatus =
  | { readonly _tag: "connecting" }
  | { readonly _tag: "online"; readonly since: number }
  | { readonly _tag: "offline"; readonly cause: Option.Option<string> }
