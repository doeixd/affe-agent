import { Effect, Layer, Option, Queue, Schema, Stream, SubscriptionRef } from "effect"
import type { Rpc, RpcGroup, RpcMessage } from "effect/unstable/rpc"
import { RpcClient, RpcClientError, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import * as Relay from "./Relay.js"
import { RelayClient } from "./RelayClient.js"

/**
 * Effect RPC over the relay: a client `Protocol` that addresses one endpoint
 * on one peer, and a server `Protocol` that serves one endpoint to every
 * peer. `AgentRpc` -- or any RPC group -- runs on both unchanged: the relay
 * is a transport under Effect RPC's own protocol boundary, which already
 * handles request tracking, streaming, acknowledgement, interruption and
 * concurrency. This module only moves encoded frames.
 */

/** An endpoint witness: the identity on the wire and the group it serves. */
export interface Endpoint<Rpcs extends Rpc.Any> {
  readonly id: Relay.EndpointId
  readonly group: RpcGroup.RpcGroup<Rpcs>
}

export const endpoint = <Rpcs extends Rpc.Any>(id: string, group: RpcGroup.RpcGroup<Rpcs>): Endpoint<Rpcs> => ({
  id: Relay.EndpointId.make(id),
  group
})

// --- the frames, decoded from `unknown` at the boundary --------------------

const HeadersEncoded = Schema.Array(Schema.Tuple([Schema.String, Schema.String]))
const RequestId = Schema.Union([Schema.String, Schema.Number])

const RequestFrame = Schema.TaggedStruct("Request", {
  id: RequestId,
  tag: Schema.String,
  payload: Schema.Unknown,
  headers: HeadersEncoded,
  isNotification: Schema.optional(Schema.Literal(true)),
  traceId: Schema.optional(Schema.String),
  spanId: Schema.optional(Schema.String),
  sampled: Schema.optional(Schema.Boolean)
})

const ClientFrame = Schema.Union([
  RequestFrame,
  Schema.TaggedStruct("Ack", { requestId: RequestId }),
  Schema.TaggedStruct("Interrupt", { requestId: RequestId }),
  Schema.TaggedStruct("Ping", {}),
  Schema.TaggedStruct("Eof", {})
])

const ServerFrame = Schema.Union([
  Schema.TaggedStruct("Chunk", {
    requestId: RequestId,
    values: Schema.NonEmptyArray(Schema.Unknown)
  }),
  Schema.TaggedStruct("Exit", { requestId: RequestId, exit: Schema.Unknown }),
  Schema.TaggedStruct("Defect", { defect: Schema.Unknown }),
  Schema.TaggedStruct("Pong", {}),
  Schema.TaggedStruct("ClientProtocolError", { error: RpcClientError.RpcClientError }),
  RequestFrame
])

const decodeClientFrame = Schema.decodeUnknownEffect(ClientFrame)
const decodeServerFrame = Schema.decodeUnknownEffect(ServerFrame)

/** The JSON codec both ends agree on; frames are JSON-safe objects, never re-serialised. */
const codecFor = RpcSerialization.json.codecFor

const requestFromFrame = (
  frame: typeof RequestFrame.Type,
  headers: ReadonlyArray<readonly [string, string]>
): RpcMessage.RequestEncoded => ({
  _tag: "Request",
  id: frame.id,
  tag: frame.tag,
  payload: frame.payload,
  headers: headers.map(([name, value]): [string, string] => [name, value]),
  ...(frame.isNotification === undefined ? {} : { isNotification: frame.isNotification }),
  ...(frame.traceId === undefined ? {} : { traceId: frame.traceId }),
  ...(frame.spanId === undefined ? {} : { spanId: frame.spanId }),
  ...(frame.sampled === undefined ? {} : { sampled: frame.sampled })
})

const ExitFrame = Schema.Union([
  Schema.TaggedStruct("Success", { value: Schema.Unknown }),
  Schema.TaggedStruct("Failure", {
    cause: Schema.Array(Schema.Union([
      Schema.TaggedStruct("Fail", { error: Schema.Unknown }),
      Schema.TaggedStruct("Die", { defect: Schema.Unknown }),
      Schema.TaggedStruct("Interrupt", { fiberId: Schema.optional(Schema.Number) })
    ]))
  })
])

/** The decoded exit, rebuilt in Effect's own encoded shape (an interrupt's `fiberId` key is required there). */
const exitEncoded = (exit: unknown): Effect.Effect<RpcMessage.ExitEncoded<unknown, unknown>, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(ExitFrame)(exit).pipe(
    Effect.map((decoded): RpcMessage.ExitEncoded<unknown, unknown> =>
      decoded._tag === "Success"
        ? { _tag: "Success", value: decoded.value }
        : {
          _tag: "Failure",
          cause: decoded.cause.map((reason) =>
            reason._tag === "Interrupt" ? { _tag: "Interrupt", fiberId: reason.fiberId } : reason
          )
        }
    )
  )

// --- caller side -------------------------------------------------------------

export interface ClientProtocolOptions<Rpcs extends Rpc.Any> {
  readonly peer: Relay.PeerId
  readonly endpoint: Endpoint<Rpcs>
}

const clientDefect = (message: string, cause: unknown) =>
  new RpcClientError.RpcClientError({
    reason: new RpcClientError.RpcClientDefect({ message, cause })
  })

/**
 * An `RpcClient.Protocol` whose far end is `endpoint` on `peer`, reached
 * through this node's `RelayClient`. Provide it to `AgentRpc.clientLayer`
 * (or `RpcClient.make` of any group) and the client cannot tell.
 */
export const clientProtocol = <Rpcs extends Rpc.Any>(
  options: ClientProtocolOptions<Rpcs>
): Layer.Layer<RpcClient.Protocol, never, RelayClient> =>
  Layer.effect(
    RpcClient.Protocol,
    RpcClient.Protocol.make(Effect.fnUntraced(function* (writeResponse, clientIds) {
      const relay = yield* RelayClient
      const channel = Relay.ChannelId.make(globalThis.crypto.randomUUID())
      const requestClientMap = new Map<string | number, number>()
      let failed: Option.Option<RpcClientError.RpcClientError> = Option.none()

      const broadcast = (response: RpcMessage.FromServerEncoded) =>
        Effect.forEach(clientIds, (clientId) => writeResponse(clientId, response), { discard: true })

      const deliver = (response: RpcMessage.FromServerEncoded) => {
        if ("requestId" in response) {
          const clientId = requestClientMap.get(response.requestId)
          if (clientId !== undefined) {
            if (response._tag === "Exit") requestClientMap.delete(response.requestId)
            return writeResponse(clientId, response)
          }
        }
        return broadcast(response)
      }

      yield* relay.subscribe(
        options.endpoint.id,
        (envelope) =>
          decodeServerFrame(envelope.frame).pipe(
            Effect.flatMap((frame): Effect.Effect<void> => {
              switch (frame._tag) {
                case "Request":
                  return deliver(requestFromFrame(frame, frame.headers))
                case "Exit":
                  return exitEncoded(frame.exit).pipe(
                    Effect.flatMap((exit) => deliver({ _tag: "Exit", requestId: frame.requestId, exit })),
                    Effect.catch((error) =>
                      deliver({ _tag: "ClientProtocolError", error: clientDefect("malformed exit frame", error) })
                    )
                  )
                default:
                  return deliver(frame)
              }
            }),
            Effect.catch((error) =>
              broadcast({ _tag: "ClientProtocolError", error: clientDefect("malformed relay frame", error) })
            )
          ),
        { channel }
      )
      /**
       * A dropped connection settles what was in flight, rather than leaving
       * it waiting for an answer that can no longer come.
       *
       * The far end does not survive the gap, which is what forces this. When
       * the relay drops this node it marks it offline, so the target's next
       * `send` fails with `RelayPeerOfflineError`, and its server protocol
       * treats that as a disconnect and releases the RPC client holding the
       * request. The response is genuinely gone. Reconnecting cannot recover
       * it without a durable mailbox, and there is not one.
       *
       * So the honest answer is a transport failure, which the seam already
       * documents as the one worth retrying. It goes out as the protocol's own
       * `ClientProtocolError` rather than a synthesised `Exit`, because that is
       * the frame Effect RPC defines for "the transport failed underneath you"
       * and it fails every pending request without this module having to
       * encode anyone else's error schema.
       *
       * Only when something is actually outstanding: the status starts at
       * `connecting`, and announcing a protocol error to a client with nothing
       * in flight would be inventing a failure.
       */
      yield* Effect.forkScoped(
        SubscriptionRef.changes(relay.status).pipe(
          Stream.filter((state) => state._tag !== "online"),
          Stream.tap(() =>
            requestClientMap.size === 0 ? Effect.void : Effect.gen(function* () {
              requestClientMap.clear()
              yield* broadcast({
                _tag: "ClientProtocolError",
                error: clientDefect(
                  "the relay connection dropped while this request was in flight",
                  options.peer
                )
              })
            })
          ),
          Stream.runDrain
        )
      )

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          // Settle whatever is still in flight, locally, before the channel
          // goes away.
          //
          // Without this the shutdown deadlocks, and the trace says so
          // exactly (`docs/remaining-work.md` 26p): an interrupted streaming
          // request makes the client wait for the far end's `Exit`, the
          // relay *does* route that `Exit` back, and by then this scope has
          // already unsubscribed -- so `RelayClient.dispatch` finds no
          // handler and drops it on a debug line, leaving the request
          // waiting forever inside a scope that is trying to close. The hang
          // is therefore uninterruptible: an outer `Effect.timeout` fires,
          // interrupts the request, and then waits on an acknowledgement
          // that has nowhere left to land.
          //
          // A transport being torn down cannot promise a remote
          // acknowledgement, so it must not make its own shutdown depend on
          // one. Every outstanding request is failed as interrupted here,
          // which is the truth: the channel carrying it is gone.
          for (const [requestId, clientId] of requestClientMap) {
            yield* writeResponse(clientId, {
              _tag: "Exit",
              requestId,
              exit: { _tag: "Failure", cause: [{ _tag: "Interrupt", fiberId: undefined }] }
            })
          }
          requestClientMap.clear()
          // Then tell the far end the channel is gone, so it releases the client.
          yield* relay.send({
            to: options.peer,
            endpoint: options.endpoint.id,
            channel,
            frame: { _tag: "Eof" }
          }).pipe(Effect.ignore)
        })
      )

      return {
        send: (clientId, request) => {
          if (Option.isSome(failed)) return Effect.fail(failed.value)
          if (request._tag === "Request") requestClientMap.set(request.id, clientId)
          return relay.send({ to: options.peer, endpoint: options.endpoint.id, channel, frame: request }).pipe(
            Effect.mapError((error) => {
              if (error._tag === "RpcClientError") {
                failed = Option.some(error)
                return error
              }
              return clientDefect(error.message, error)
            })
          )
        },
        supportsAck: true,
        supportsTransferables: false,
        codecFor
      }
    }))
  )

// --- serving side ------------------------------------------------------------

/**
 * Serve `endpoint` to every peer the relay routes here. The handlers are the
 * group's own (`AgentRpc.serverLayer`, say); each (caller, channel) pair is
 * one RPC client to Effect's server, so request ids never collide across
 * callers, and every request carries `Relay.PEER_HEADER` set to the
 * relay-authenticated caller after any caller-supplied value is stripped.
 */
export const serve = <Rpcs extends Rpc.Any>(
  target: Endpoint<Rpcs>,
  options?: { readonly concurrency?: number | "unbounded" | undefined }
): Layer.Layer<never, never, RelayClient | Rpc.ToHandler<Rpcs> | Rpc.Middleware<Rpcs> | Rpc.ServicesServer<Rpcs>> =>
  RpcServer.layer(target.group, { concurrency: options?.concurrency ?? "unbounded" }).pipe(
    Layer.provide(serverProtocol(target))
  )

const serverProtocol = <Rpcs extends Rpc.Any>(target: Endpoint<Rpcs>): Layer.Layer<RpcServer.Protocol, never, RelayClient> =>
  Layer.effect(
    RpcServer.Protocol,
    RpcServer.Protocol.make((writeRequest) =>
      Effect.gen(function* () {
        const relay = yield* RelayClient
        const disconnects = yield* Queue.make<number>()
        interface Client {
          readonly id: number
          readonly from: Relay.PeerId
          readonly channel: Relay.ChannelId
        }
        const byRoute = new Map<string, Client>()
        const byId = new Map<number, Client>()
        const ids = new Set<number>()
        let next = 0

        const route = (from: Relay.PeerId, channel: Relay.ChannelId) => `${from} ${channel}`
        const clientFor = (from: Relay.PeerId, channel: Relay.ChannelId): Client => {
          const existing = byRoute.get(route(from, channel))
          if (existing !== undefined) return existing
          const client: Client = { id: next++, from, channel }
          byRoute.set(route(from, channel), client)
          byId.set(client.id, client)
          ids.add(client.id)
          return client
        }
        // Idempotent on purpose: a caller's `Eof` and the server's own `end`
        // can both arrive for one client, and announcing the same disconnect
        // twice would have `RpcServer` tear down a client id that may by then
        // have been reused.
        const release = (client: Client) => {
          if (!ids.has(client.id)) return Effect.void
          byRoute.delete(route(client.from, client.channel))
          byId.delete(client.id)
          ids.delete(client.id)
          return Effect.asVoid(Queue.offer(disconnects, client.id))
        }

        yield* relay.subscribe(target.id, (envelope) =>
          decodeClientFrame(envelope.frame).pipe(
            Effect.flatMap((frame): Effect.Effect<void> => {
              switch (frame._tag) {
                case "Eof": {
                  // Look the channel up rather than minting one: an `Eof` for
                  // a channel that sent nothing must not create a client just
                  // to announce its disconnect.
                  const existing = byRoute.get(route(envelope.from, envelope.channel))
                  return existing === undefined ? Effect.void : release(existing)
                }
                case "Request": {
                  const client = clientFor(envelope.from, envelope.channel)
                  const headers: Array<readonly [string, string]> = [[Relay.PEER_HEADER, envelope.from]]
                  for (const header of frame.headers) {
                    if (header[0].toLowerCase() !== Relay.PEER_HEADER) headers.push(header)
                  }
                  return writeRequest(client.id, requestFromFrame(frame, headers))
                }
                default:
                  return writeRequest(clientFor(envelope.from, envelope.channel).id, frame)
              }
            }),
            Effect.catch((error) =>
              Effect.logWarning("relay: malformed client frame dropped", {
                endpoint: target.id,
                from: envelope.from,
                error: String(error)
              })
            )
          ))

        return {
          disconnects,
          send: (clientId, response) => {
            const client = byId.get(clientId)
            if (client === undefined) return Effect.void
            return relay.send({ to: client.from, endpoint: target.id, channel: client.channel, frame: response }).pipe(
              // A caller that vanished mid-response is a disconnect, not a server fault.
              Effect.catchTag("affe-agent/relay/RelayPeerOfflineError", () => release(client)),
              Effect.orDie
            )
          },
          end: (clientId) => {
            const client = byId.get(clientId)
            return client === undefined ? Effect.void : release(client)
          },
          clientIds: Effect.sync(() => ids),
          initialMessage: Effect.succeedNone,
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: true,
          supportsNotifications: true,
          codecFor
        }
      })
    )
  )
