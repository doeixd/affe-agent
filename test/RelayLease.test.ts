import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Option, Stream } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { Relay, RelayProtocol, RelayServer } from "../src/relay/index.js"

/**
 * The lease (`docs/plan-failure-paths.md` 48e).
 *
 * Before this, `heartbeat` recorded `lastSeenAt` and nothing ever read it: a
 * peer whose socket was half-open -- a laptop that slept, a NAT that dropped
 * the mapping -- stayed `online` in the directory for good, and traffic for it
 * was accepted into a queue nobody was draining. A directory that says
 * "online" for a peer nothing can reach is worse than one that says nothing.
 *
 * Driven through `RpcTest` rather than a socket. The relay's own protocol is
 * the seam under test, and a real WebSocket would only add a way for the test
 * to be slow: what matters here is the clock, and the lease is set in
 * milliseconds so the waits are short and real.
 */

const TARGET = Relay.PeerId.make("target")
const CALLER = Relay.PeerId.make("caller")
const tokens = { "target-secret": TARGET, "caller-secret": CALLER }

const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } })

const relay = (lease: Duration.Duration) =>
  RelayServer.layer({ lease }).pipe(Layer.provide(RelayServer.bearerTokens(tokens)))

/**
 * Wait until the relay has actually registered a peer.
 *
 * `listen` registers when the stream is first pulled, not when it is forked,
 * so asserting straight after the fork races the registration -- and a race
 * that usually wins is the worst kind, because it fails on someone else's
 * slower machine.
 */
const awaitOnline = (
  peers: Effect.Effect<ReadonlyArray<Relay.PeerInfo>, unknown>,
  peer: Relay.PeerId
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      const all = yield* Effect.orDie(peers)
      if (all.some((info) => info.id === peer && info.status === "online")) return
      yield* Effect.sleep("5 millis")
    }
  })

const envelopeFor = (to: Relay.PeerId) => ({
  to,
  endpoint: Relay.EndpointId.make("test/endpoint"),
  channel: Relay.ChannelId.make("channel-1"),
  frame: { _tag: "Ping" }
})

describe("relay leases", () => {
  it.live("a peer that stops renewing stops being routable, and its stream ends saying why", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RelayProtocol.Protocol)

      // The target connects and then goes quiet, which is what a half-open
      // socket looks like from here.
      const listening = yield* Effect.forkChild(
        Effect.exit(Stream.runDrain(client.listen({}, as("target-secret"))))
      )
      yield* awaitOnline(client.peers({}, as("caller-secret")), TARGET)
      // Reachable while the lease holds.
      yield* client.send(envelopeFor(TARGET), as("caller-secret"))

      yield* Effect.sleep("700 millis")

      // Routing is refused rather than queued into a connection nobody drains.
      const refused = yield* Effect.flip(client.send(envelopeFor(TARGET), as("caller-secret")))
      assert.strictEqual(refused._tag, "affe-agent/relay/RelayPeerOfflineError")

      // And the target's own stream ends with the reason, so a node that is
      // still there learns it has been dropped rather than waiting forever.
      const ended = yield* Fiber.join(listening)
      assert.strictEqual(ended._tag, "Failure")
      assert.include(String(ended), "expired its lease")
    }).pipe(Effect.provide(relay(Duration.millis(400)))),
    20_000
  )

  it.live("the directory stops claiming an expired peer is online", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RelayProtocol.Protocol)
      yield* Effect.forkChild(Effect.exit(Stream.runDrain(client.listen({}, as("target-secret")))))
      yield* awaitOnline(client.peers({}, as("caller-secret")), TARGET)

      const online = yield* client.peers({}, as("caller-secret"))
      const before = online.find((info) => info.id === TARGET)
      assert.isDefined(before)
      assert.strictEqual(before?.status, "online")
      assert.isTrue(Option.isSome(before!.connectedAt))

      yield* Effect.sleep("700 millis")

      const after = (yield* client.peers({}, as("caller-secret"))).find((info) => info.id === TARGET)
      assert.strictEqual(after?.status, "offline", "an expired peer is still listed as online")
      // `connectedAt` is documented as present only while online, so it must
      // go with the status rather than lingering as a stale fact.
      assert.isTrue(Option.isNone(after!.connectedAt))
    }).pipe(Effect.provide(relay(Duration.millis(400)))),
    20_000
  )

  it.live("any traffic renews the lease, not only heartbeat", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RelayProtocol.Protocol)
      yield* Effect.forkChild(Effect.exit(Stream.runDrain(client.listen({}, as("target-secret")))))
      yield* awaitOnline(client.peers({}, as("caller-secret")), TARGET)

      // The target says nothing for longer than a lease, but keeps *sending* --
      // which is the thing a heartbeat is asking about, already demonstrated.
      for (let i = 0; i < 4; i++) {
        yield* Effect.sleep("60 millis")
        yield* client.send(envelopeFor(CALLER), as("target-secret")).pipe(Effect.ignore)
      }

      const listed = (yield* client.peers({}, as("caller-secret"))).find((info) => info.id === TARGET)
      assert.strictEqual(
        listed?.status,
        "online",
        "a peer that was actively sending was expired anyway"
      )
    }).pipe(Effect.provide(relay(Duration.millis(150)))),
    20_000
  )

  it.live("a heartbeat renews it too, which is what a silent serving node has", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RelayProtocol.Protocol)
      yield* Effect.forkChild(Effect.exit(Stream.runDrain(client.listen({}, as("target-secret")))))
      yield* awaitOnline(client.peers({}, as("caller-secret")), TARGET)

      for (let i = 0; i < 4; i++) {
        yield* Effect.sleep("60 millis")
        yield* client.heartbeat({}, as("target-secret"))
      }

      yield* client.send(envelopeFor(TARGET), as("caller-secret"))
      const listed = (yield* client.peers({}, as("caller-secret"))).find((info) => info.id === TARGET)
      assert.strictEqual(listed?.status, "online")
    }).pipe(Effect.provide(relay(Duration.millis(150)))),
    20_000
  )
})
