import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer, Option, Ref, Stream, SubscriptionRef } from "effect"
import { Prompt } from "effect/unstable/ai"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { RpcClient, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import { NodeHttpServer } from "@effect/platform-node"
import { createServer } from "node:http"
import { Agent, AgentLoop } from "../src/index.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import { Relay, RelayClient, RelayProtocol, RelayRpc, RelayServer } from "../src/relay/index.js"
import { AgentRpc } from "../src/rpc/index.js"
import { TestLanguageModel } from "../src/testing/index.js"
import { echoToolkit } from "./helpers.js"

/**
 * One process, three parties: a relay (an HTTP server with the relay
 * protocol mounted over WebSocket), a target node serving `AgentRpc` through
 * the relay, and a caller node reaching it the same way. `AgentRpc`,
 * `AgentSessionHost` and the agent are the ones every other transport suite
 * uses -- nothing in them knows the relay exists.
 */

const peer = (id: string) => Relay.PeerId.make(id)
const requestId = (value: string) => AgentProtocol.RequestId.make(value)
const sessionId = (value: string) => AgentProtocol.SessionId.make(value)

const AgentEndpoint = RelayRpc.endpoint("effect-agent/agent", AgentRpc.Protocol)

const TARGET = peer("desktop")
const CALLER = peer("vps")
const tokens = { "desktop-secret": TARGET, "vps-secret": CALLER, "laptop-secret": peer("laptop") }

/** The relay, listening on an ephemeral port; yields its `ws://` address. */
const relay = (options?: RelayServer.Options) =>
  Effect.gen(function* () {
    const routes = RpcServer.layerHttp({
      group: RelayProtocol.Protocol,
      path: "/relay",
      protocol: "websocket"
    }).pipe(
      Layer.provide(RelayServer.layer(options)),
      Layer.provide(RelayServer.bearerTokens(tokens)),
      Layer.provide(RpcSerialization.layerNdjson)
    )
    const server = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 }))
    )
    // Built into the test's scope, so the relay outlives the nodes that dial it.
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

/** The agent behind the target: one echo turn, then text. */
const agent = Agent.make({
  instructions: "Echo, then answer.",
  toolkit: echoToolkit,
  loop: AgentLoop.bounded(3)
})

const model = Layer.unwrap(
  Effect.map(
    TestLanguageModel.script([
      TestLanguageModel.toolCall("echo", { value: "over the relay" }),
      TestLanguageModel.text("relayed answer")
    ]),
    ({ layer }) => layer
  )
)

/**
 * The host resolves its principal from the header the relay stamps: the
 * relay-authenticated caller is who prompts, whatever else the caller sent.
 */
const targetHost = Effect.gen(function* () {
  const principals = yield* Ref.make<ReadonlyArray<string>>([])
  const Host = AgentSessionHost.Tag<string>(`test/Relay/host/${globalThis.crypto.randomUUID()}`)
  const host = AgentSessionHost.layer(Host, {
    authorization: { authorize: () => Effect.void },
    principal: {
      resolve: ({ headers, operation }) => {
        const from = headers[Relay.PEER_HEADER]
        return from === undefined
          ? Effect.fail(new AgentProtocol.AgentUnauthorizedError({ operation }))
          : Effect.as(Ref.update(principals, (all) => [...all, `${operation}:${from}`]), from)
      }
    },
    maxSessions: 4,
    maxRequestsPerSession: 32
  }).pipe(Layer.provide(AgentClient.layer(agent).pipe(Layer.provide(model))))
  return { principals, serve: AgentRpc.serverLayer({ host: Host }).pipe(Layer.provide(host)) }
})

const userPrompt = (text: string) => Prompt.make([{ role: "user", content: [{ type: "text", text }] }])

describe("Relay", () => {
  it.live("runs AgentRpc unchanged through the relay: calls, a stream, and the stamped caller", () =>
    Effect.gen(function* () {
      const url = yield* relay()
      const target = yield* targetHost
      // The target: its relay connection, and the agent endpoint served over it.
      yield* Layer.build(
        RelayRpc.serve(AgentEndpoint).pipe(
          Layer.provide(target.serve),
          Layer.provideMerge(node(url, TARGET, "desktop-secret"))
        )
      )
      // The caller: `AgentRpc.clientLayer` over the relay protocol, addressed at the target.
      const caller = yield* Layer.build(
        AgentRpc.clientLayer.pipe(
          Layer.provide(RelayRpc.clientProtocol({ peer: TARGET, endpoint: AgentEndpoint })),
          Layer.provideMerge(node(url, CALLER, "vps-secret"))
        )
      )
      const client = yield* Effect.provide(AgentRpc.Client, caller)
      const id = sessionId("relayed")

      // A forged identity header on the call: the host must see the relay's, not this.
      const forged = { headers: { [Relay.PEER_HEADER]: "admin" } }
      yield* client.createSession({ requestId: requestId("create"), sessionId: id }, forged)
      // The third thing a transport must carry, after a call and its result:
      // a streamed response, with the acks that pace it.
      //
      // Subscribed *before* the prompt on purpose. `events` without `after`
      // is a live tail -- resuming from a sequence needs a delivery log,
      // which is the durable client's -- so a subscription taken afterwards
      // would wait for events that have already gone by. And `it.live`
      // rather than `it.effect` because this test is real sockets and real
      // time; under the default test clock every sleep here waits for a
      // virtual clock nobody advances.
      const collecting = yield* client.events({ sessionId: id }, forged).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* Effect.sleep("500 millis")
      const answer = yield* client.prompt(
        { requestId: requestId("prompt"), sessionId: id, input: userPrompt("hello") },
        forged
      )
      assert.strictEqual(answer.result.status, "completed")
      assert.strictEqual(answer.result.text, "relayed answer")

      const events = yield* Fiber.join(collecting)
      assert.deepStrictEqual(
        events.map((event) => event.event._tag),
        // The session already existed, so its `SessionStarted` is behind us:
        // a tail taken here begins with the submission this test starts.
        ["SubmissionStarted", "RunStarted"],
        "the streamed response did not cross the relay"
      )

      assert.strictEqual((yield* client.status({ sessionId: id }, forged)).status, "idle")

      // Every operation was attributed to the relay-authenticated caller, and
      // none to the `admin` the caller forged in its own header. Asserted as a
      // set rather than a sequence: the streamed `events` subscription and the
      // prompt overlap, so their order is a race and pinning it would make
      // this fail for a reason it does not care about.
      const principals = yield* Ref.get(target.principals)
      for (const operation of ["createSession", "prompt", "events", "status"]) {
        assert.include(principals, `${operation}:${CALLER}`, `${operation} was not stamped by the relay`)
      }
      assert.isFalse(
        principals.some((entry) => entry.endsWith(":admin")),
        "a forged identity header reached the host"
      )

      // The directory saw both nodes come online.
      const relayClient = yield* Effect.provide(RelayClient.RelayClient, caller)
      const peers = yield* relayClient.peers
      assert.deepStrictEqual(
        peers.filter((info) => info.status === "online").map((info) => info.id).sort(),
        [TARGET, CALLER].sort()
      )
    }).pipe(Effect.scoped)
  )

  it.live("a caller can be torn down and dialled again on the same node", () =>
    Effect.gen(function* () {
      const url = yield* relay()
      const target = yield* targetHost
      yield* Layer.build(
        RelayRpc.serve(AgentEndpoint).pipe(
          Layer.provide(target.serve),
          Layer.provideMerge(node(url, TARGET, "desktop-secret"))
        )
      )
      const connection = yield* Layer.build(node(url, CALLER, "vps-secret"))
      const forged = { headers: {} }

      // Each dial is its own channel, so the target mints a fresh RPC client
      // for it. The first one's teardown sends `Eof` and releases that client;
      // the second must be unaffected, which is what the release path has to
      // get right -- announcing a disconnect twice, or minting a client just
      // to release it, would tear down the wrong one.
      const dial = <A, E>(use: (client: AgentRpc.Client["Service"]) => Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          const caller = yield* Layer.build(
            AgentRpc.clientLayer.pipe(
              Layer.provide(RelayRpc.clientProtocol({ peer: TARGET, endpoint: AgentEndpoint }))
            )
          ).pipe(Effect.provide(connection))
          return yield* use(yield* Effect.provide(AgentRpc.Client, caller))
        }).pipe(Effect.scoped)

      const first = sessionId("first")
      yield* dial((client) => client.createSession({ requestId: requestId("a"), sessionId: first }, forged))
      // A dial that opens and closes without ever calling: its `Eof` names a
      // channel the target has never seen, which must not mint a client just
      // to announce its disconnect.
      yield* dial(() => Effect.void)
      // The first caller's scope has closed: its `Eof` has been sent and its
      // client released. A second dial over the same relay connection still
      // reaches the same host, and sees the session the first one made.
      const status = yield* dial((client) => client.status({ sessionId: first }, forged))
      assert.strictEqual(status.status, "idle")
    }).pipe(Effect.scoped)
  )

  it.effect("live traffic to an offline peer fails now, as the caller's RPC error", () =>
    Effect.gen(function* () {
      const url = yield* relay()
      const caller = yield* Layer.build(
        AgentRpc.clientLayer.pipe(
          Layer.provide(RelayRpc.clientProtocol({ peer: peer("laptop"), endpoint: AgentEndpoint })),
          Layer.provideMerge(node(url, CALLER, "vps-secret"))
        )
      )
      const client = yield* Effect.provide(AgentRpc.Client, caller)
      const failure = yield* Effect.flip(
        client.status({ sessionId: sessionId("nobody") }, { headers: {} })
      )
      assert.strictEqual(failure._tag, "RpcClientError")
      assert.include(failure.message, "laptop is offline")
    }).pipe(Effect.scoped)
  )

  it.effect("a newer connection for the same peer supersedes the older one", () =>
    Effect.gen(function* () {
      const url = yield* relay()
      const first = yield* Layer.build(node(url, TARGET, "desktop-secret"))
      const older = yield* Effect.provide(RelayClient.RelayClient, first)
      yield* Layer.build(node(url, TARGET, "desktop-secret"))
      const status = yield* SubscriptionRef.changes(older.status).pipe(
        Stream.filter((state) => state._tag === "offline"),
        Stream.runHead
      )
      assert.isTrue(Option.isSome(status))
      if (Option.isSome(status) && status.value._tag === "offline") {
        assert.isTrue(Option.isSome(status.value.cause))
        assert.include(Option.getOrElse(status.value.cause, () => ""), "superseded")
      }
    }).pipe(Effect.scoped)
  )

  it.effect("an unknown credential is refused before anything is routed", () =>
    Effect.gen(function* () {
      const url = yield* relay()
      const failure = yield* Effect.flip(Layer.build(node(url, TARGET, "wrong")))
      assert.strictEqual(failure._tag, "@doeixd/effect-agent/relay/RelayUnauthorizedError")
    }).pipe(Effect.scoped)
  )
})

// --- Type assertions ---------------------------------------------------------

type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T

/** The endpoint witness keeps the group; a client over it has AgentRpc's exact methods. */
export type _EndpointKeepsGroup = Assert<
  typeof AgentEndpoint extends RelayRpc.Endpoint<infer Rpcs>
    ? IsAny<Rpcs> extends false ? true : false
    : false
>
/** A peer is a `PeerId`, not a string: `clientProtocol({ peer: "desktop" })` does not compile. */
export type _PeerIsBranded = Assert<
  string extends RelayRpc.ClientProtocolOptions<never>["peer"] ? false : true
>
