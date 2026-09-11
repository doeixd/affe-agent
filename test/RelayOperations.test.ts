import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Layer, Metric, Option, Ref, Stream } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { Relay, RelayProtocol, RelayServer } from "../src/relay/index.js"

/**
 * Item 117, relay phase 14: what an operator needs before a relay serves
 * anyone but its owner -- a send rate per sender, an audit trail of refusals,
 * and counters. Driven through the relay's own protocol, as `RelayLease.test`
 * is.
 */

const TARGET = Relay.PeerId.make("target")
const CALLER = Relay.PeerId.make("caller")
const tokens = { "target-secret": TARGET, "caller-secret": CALLER }
const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } })

const envelopeFor = (to: Relay.PeerId, endpoint = "test/endpoint") => ({
  to,
  endpoint: Relay.EndpointId.make(endpoint),
  channel: Relay.ChannelId.make("channel-1"),
  frame: { _tag: "Ping" }
})

const relay = (options: Omit<RelayServer.Options, "authorization"> & { readonly authorization?: RelayServer.Authorization }) =>
  RelayServer.layer({ authorization: RelayServer.allowAll, ...options }).pipe(
    Layer.provide(RelayServer.bearerTokens(tokens))
  )

/** A protocol client, with the target online and draining so sends to it are delivered. */
const connected = Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(RelayProtocol.Protocol)
    yield* Effect.forkChild(Stream.runDrain(client.listen({}, as("target-secret"))))
    for (let attempt = 0; attempt < 200; attempt++) {
      const peers = yield* Effect.orDie(client.peers({}, as("caller-secret")))
      if (peers.some((peer) => peer.id === TARGET && peer.status === "online")) break
      yield* Effect.sleep("5 millis")
    }
    return client
  })

describe("relay operations (item 117, phase 14)", () => {
  it.live("a sender past its rate is refused with when to retry, and admitted after", () =>
    Effect.gen(function* () {
      const client = yield* connected
      // The burst, then a refusal that says when.
      yield* client.send(envelopeFor(TARGET), as("caller-secret"))
      yield* client.send(envelopeFor(TARGET), as("caller-secret"))
      const refused = yield* Effect.flip(client.send(envelopeFor(TARGET), as("caller-secret")))
      assert.instanceOf(refused, Relay.RelayRateLimitedError)
      if (!(refused instanceof Relay.RelayRateLimitedError)) return
      assert.strictEqual(refused.peer, CALLER)
      assert.isAbove(refused.retryAfterMs, 0)
      // Another peer's budget is its own.
      yield* client.send(envelopeFor(CALLER), as("target-secret")).pipe(Effect.ignore)
      yield* Effect.sleep(Duration.millis(refused.retryAfterMs + 20))
      yield* client.send(envelopeFor(TARGET), as("caller-secret"))
    }).pipe(Effect.scoped, Effect.provide(relay({ sendRate: { perSecond: 4, burst: 2 } }))),
    20_000
  )

  it.live("every refusal is audited, with its reason, and a connection is too", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<RelayServer.AuditEvent>>([])
      yield* Effect.gen(function* () {
        const client = yield* connected
        yield* Effect.ignore(client.send(envelopeFor(TARGET), { headers: { authorization: "Bearer nobody" } }))
        yield* Effect.ignore(client.send(envelopeFor(TARGET, "secret/endpoint"), as("caller-secret")))
        yield* Effect.ignore(client.send(envelopeFor(Relay.PeerId.make("gone")), as("caller-secret")))
        yield* client.send(envelopeFor(TARGET), as("caller-secret"))
      }).pipe(Effect.scoped, Effect.provide(relay({
        authorization: {
          authorize: ({ endpoint, from, to }) =>
            endpoint === "secret/endpoint"
              ? Effect.fail(new Relay.RelayForbiddenError({ from, to, endpoint }))
              : Effect.void
        },
        audit: (event) => Ref.update(events, (all) => [...all, event])
      })))
      const seen = yield* Ref.get(events)
      assert.deepStrictEqual(
        seen.map((event) => event._tag === "Connected" ? `connected:${event.peer}` : `${event.reason}:${Option.getOrElse(event.from, () => "?")}`),
        ["connected:target", "unauthenticated:?", "forbidden:caller", "offline:caller"]
      )
    }),
    20_000
  )

  it.live("sends are counted by outcome", () =>
    Effect.gen(function* () {
      const count = (outcome: string) =>
        Effect.map(Metric.value(Metric.withAttributes(RelayServer.metrics.sends, { outcome })), (state) => state.count)
      const before = { delivered: yield* count("delivered"), offline: yield* count("offline") }
      yield* Effect.gen(function* () {
        const client = yield* connected
        yield* client.send(envelopeFor(TARGET), as("caller-secret"))
        yield* client.send(envelopeFor(TARGET), as("caller-secret"))
        yield* Effect.ignore(client.send(envelopeFor(Relay.PeerId.make("gone")), as("caller-secret")))
      }).pipe(Effect.scoped, Effect.provide(relay({})))
      assert.strictEqual((yield* count("delivered")) - before.delivered, 2)
      assert.strictEqual((yield* count("offline")) - before.offline, 1)
    }),
    20_000
  )

  it("a send rate that could never admit a send is refused where the relay is built", () => {
    assert.throws(() =>
      Effect.runSync(Layer.build(relay({ sendRate: { perSecond: 0 } })).pipe(Effect.scoped)), /sendRate/)
  })
})
