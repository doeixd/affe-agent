import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import * as Relay from "./Relay.js"

/**
 * The public relay protocol, as an Effect RPC group. A node opens one
 * `listen` stream and leaves it open (the relay -> node path), and calls
 * `send` / `heartbeat` / `peers` on the same connection; Effect RPC
 * multiplexes them, so the relay invents no request ids, stream framing or
 * cancellation of its own.
 *
 * Applications mount it with `RpcServer.layerHttp({ protocol: "websocket" })`
 * or any other Effect RPC server protocol, exactly as `AgentRpc.Protocol`.
 */
export const Protocol = RpcGroup.make(
  Rpc.make("listen", {
    payload: Schema.Struct({}),
    success: Relay.Envelope,
    error: Relay.RelayError,
    stream: true
  }),
  Rpc.make("send", {
    payload: Relay.Outbound,
    success: Schema.Void,
    error: Relay.RelayError
  }),
  Rpc.make("heartbeat", {
    payload: Schema.Struct({}),
    success: Relay.Heartbeat,
    error: Relay.RelayError
  }),
  Rpc.make("peers", {
    payload: Schema.Struct({}),
    success: Schema.Array(Relay.PeerInfo),
    error: Relay.RelayError
  })
)
