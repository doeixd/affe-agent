import { assert, describe, it } from "@effect/vitest"
import { Context, Deferred, Duration, Effect, Layer, Stream } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { RpcClient, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import { NodeHttpServer } from "@effect/platform-node"
import { createServer } from "node:http"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import { Relay, RelayClient, RelayProtocol, RelayRpc, RelayServer } from "../src/relay/index.js"
import { AgentRpc } from "../src/rpc/index.js"
import { TestLanguageModel } from "../src/testing/index.js"
import * as Contract from "./AgentClientContract.js"

/**
 * The relay, held to the client contract -- `docs/plan-failure-paths.md` 48f.
 *
 * This is the point of the RPC client adapter. The relay is Effect RPC over a
 * bus, and until now it was checked by one hand-written test, which is how it
 * shipped with a teardown bug that was a *contract* violation: a caller
 * cancelling an in-flight request waited forever on an acknowledgement its own
 * teardown had made undeliverable. Review caught that; no suite could.
 *
 * Now every row the seam owns runs across two nodes and a real WebSocket.
 *
 * One honest caveat, because it was checked rather than assumed: none of
 * these rows discriminates the finalizer in `RelayRpc.clientProtocol` that
 * settles outstanding requests before the channel goes away. See the teardown
 * test below.
 *
 * Everything here is the deployment shape rather than a fixture: a relay
 * process, a target node that serves the agent endpoint, and a caller node
 * that reaches it. The host resolves its principal from the header the relay
 * stamps, so the identity path is exercised too.
 */

const TARGET = Relay.PeerId.make("target")
const CALLER = Relay.PeerId.make("caller")
const tokens = { "target-secret": TARGET, "caller-secret": CALLER }

const AgentEndpoint = RelayRpc.endpoint("effect-agent/agent", AgentRpc.Protocol)

/** The relay itself, on an ephemeral port; yields its `ws://` address. */
const startRelay = Effect.gen(function* () {
  const routes = RpcServer.layerHttp({
    group: RelayProtocol.Protocol,
    path: "/relay",
    protocol: "websocket"
  }).pipe(
    Layer.provide(RelayServer.layer()),
    Layer.provide(RelayServer.bearerTokens(tokens)),
    Layer.provide(RpcSerialization.layerNdjson)
  )
  const server = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 }))
  )
  const services = yield* Layer.build(server)
  const { address } = Context.get(services, HttpServer.HttpServer)
  return `${HttpServer.formatAddress(address).replace(/^http/, "ws")}/relay`
})

/** A node's `RpcClient.Protocol` to the relay: a real WebSocket. */
const nodeProtocol = (url: string) =>
  Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket().pipe(
      Effect.provide(RpcSerialization.layerNdjson),
      Effect.provideServiceEffect(Socket.Socket, Socket.makeWebSocket(url)),
      Effect.provide(Socket.layerWebSocketConstructorGlobal)
    )
  )

const node = (url: string, id: Relay.PeerId, token: string) =>
  RelayClient.layer({ peer: id, headers: { authorization: `Bearer ${token}` } }).pipe(
    Layer.provide(nodeProtocol(url))
  )

const harness: Contract.Harness = {
  name: "relay",
  layer: ({ agent, turns, elicitation, maxRetainedSubmissions }) =>
    Effect.succeed(
      /**
       * `orDie`, for the reason the HTTP harness gives: a relay that cannot
       * bind, or a node whose credential is refused, is a broken fixture and
       * not a case this contract has an answer for. Every other backing has
       * nothing to fail with at construction, which is why the shared harness
       * asks for a `Layer` with an empty error channel.
       */
      Layer.orDie(Layer.unwrap(
        Effect.gen(function* () {
          const url = yield* startRelay
          const { layer: model } = yield* TestLanguageModel.script(turns)

          const Host = AgentSessionHost.Tag<string>(
            `test/RelayContract/${globalThis.crypto.randomUUID()}`
          )
          const host = AgentSessionHost.layer(Host, {
            // The relay stamps the caller; a session's principal is whoever
            // the relay authenticated, never what the caller claimed.
            principal: {
              resolve: ({ headers, operation }) => {
                const from = headers[Relay.PEER_HEADER]
                return from === undefined
                  ? Effect.fail(new AgentProtocol.AgentUnauthorizedError({ operation }))
                  : Effect.succeed(from)
              }
            },
            authorization: AgentSessionHost.allowAll(),
            maxSessions: 32,
            maxRequestsPerSession: 256
          }).pipe(
            Layer.provide(
              AgentClient.layer(agent, {
                ...(elicitation ? { elicitation } : {}),
                ...(maxRetainedSubmissions === undefined ? {} : { maxRetainedSubmissions })
              }).pipe(Layer.provide(model))
            )
          )

          // The target must actually be serving before the caller dials it.
          yield* Layer.build(
            RelayRpc.serve(AgentEndpoint).pipe(
              Layer.provide(AgentRpc.serverLayer({ host: Host }).pipe(Layer.provide(host))),
              Layer.provideMerge(node(url, TARGET, "target-secret"))
            )
          )

          return AgentRpc.agentClientLayer().pipe(
            Layer.provide(
              AgentRpc.clientLayer.pipe(
                Layer.provide(RelayRpc.clientProtocol({ peer: TARGET, endpoint: AgentEndpoint })),
                Layer.provideMerge(node(url, CALLER, "caller-secret"))
              )
            )
          )
        })
      ))
    )
}

Contract.run(harness)

/**
 * Teardown with work outstanding, and an honest label on what it proves.
 *
 * The property is real and worth holding: closing a caller while a streamed
 * response and a prompt are both in flight must finish, because a transport
 * being torn down cannot promise a remote acknowledgement and so must not make
 * its own shutdown wait for one. What makes it askable here and nowhere else
 * is that the relay and the target are built in the *outer* scope, so closing
 * the caller tears down exactly one thing -- the transport. In the shared
 * contract the same act would also tear down the server, and the answer would
 * be about the harness.
 *
 * **It does not guard the finalizer that settles in-flight requests.** Deleting
 * that loop from `RelayRpc.clientProtocol` leaves this green, as does the whole
 * contract above; both were checked, in this shape and with a unary prompt
 * instead of a stream. The trace recorded in `docs/remaining-work.md` 26p was
 * real, but the hang it describes does not reproduce here, and the more likely
 * explanation is that the other half of that fix -- the test's `events`
 * subscription being taken before the prompt rather than after -- is what
 * removed it. So the finalizer is defensive code whose necessity is unproven,
 * and this test is cheap insurance rather than a regression guard. Saying so
 * is the point: a test nobody can make fail is worth exactly what it costs,
 * and mislabelling one as a guard is worse than not having it.
 */
describe("relay teardown", () => {
  it.live("closing a caller with a request in flight does not hang", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const held = yield* Deferred.make<void>()
      const url = yield* startRelay
      const { layer: model } = yield* TestLanguageModel.script([
        // Never released: the request is still outstanding when the caller
        // goes away, which is the whole scenario.
        { text: "done", started: entered, during: Deferred.await(held) }
      ])

      const Host = AgentSessionHost.Tag<string>(
        `test/RelayContract/teardown/${globalThis.crypto.randomUUID()}`
      )
      const host = AgentSessionHost.layer(Host, {
        principal: { resolve: () => Effect.succeed("relay-teardown") },
        authorization: AgentSessionHost.allowAll(),
        maxSessions: 8,
        maxRequestsPerSession: 32
      }).pipe(
        Layer.provide(
          AgentClient.layer(Agent.make({ loop: AgentLoop.bounded(2) })).pipe(Layer.provide(model))
        )
      )

      // Target and relay live in this scope, not the caller's.
      yield* Layer.build(
        RelayRpc.serve(AgentEndpoint).pipe(
          Layer.provide(AgentRpc.serverLayer({ host: Host }).pipe(Layer.provide(host))),
          Layer.provideMerge(node(url, TARGET, "target-secret"))
        )
      )

      const caller = AgentRpc.agentClientLayer().pipe(
        Layer.provide(
          AgentRpc.clientLayer.pipe(
            Layer.provide(RelayRpc.clientProtocol({ peer: TARGET, endpoint: AgentEndpoint })),
            Layer.provideMerge(node(url, CALLER, "caller-secret"))
          )
        )
      )

      const closed = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* Effect.service(AgentClient.AgentClient)
            const session = yield* client.createSession()
            // A *streamed* response left open, which is what the recorded
            // trace shows: the `events` request goes out, nothing comes back
            // for it, and the close then interrupts it and sends `Eof`. A
            // unary prompt does not reproduce this -- checked -- because its
            // `Exit` has already arrived by the time anything is torn down.
            yield* Effect.forkChild(Effect.exit(Stream.runDrain(session.events())))
            yield* Effect.forkChild(Effect.exit(session.prompt("go")))
            // The model has actually been entered, so both the stream and the
            // prompt are outstanding rather than merely sent.
            yield* Deferred.await(entered)
          }).pipe(Effect.provide(caller))
        )
      ).pipe(
        Effect.as(true),
        Effect.timeout(Duration.seconds(10)),
        Effect.catchTag("TimeoutError", () => Effect.succeed(false))
      )

      assert.isTrue(
        closed,
        "closing the caller hung with a request in flight: a transport being torn down cannot promise a remote acknowledgement, so it must not make its own shutdown wait for one"
      )
    }),
    30_000
  )
})
