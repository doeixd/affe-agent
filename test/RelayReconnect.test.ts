import { assert, describe, it } from "@effect/vitest"
import { Context, Duration, Effect, Layer, Ref, Stream, SubscriptionRef } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { RpcClient, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import { NodeHttpServer } from "@effect/platform-node"
import { createServer } from "node:http"
import { Relay, RelayClient, RelayProtocol, RelayServer } from "../src/relay/index.js"

/**
 * Reconnection (`docs/plan-failure-paths.md` 48e).
 *
 * A node used to go offline for good: the `listen` stream ended, the status
 * said why, and that was the end of it. For the case the relay exists to serve
 * -- a laptop that sleeps, a phone that changes network -- that is the whole
 * problem rather than a corner of it, and lease expiry made it sharper, since
 * the relay now actively drops peers that go quiet.
 *
 * The lease is also how these tests break a connection *deterministically*.
 * Killing a socket from outside is a race; letting a lease lapse is a clock.
 */

const TARGET = Relay.PeerId.make("target")
const CALLER = Relay.PeerId.make("caller")
const tokens = { "target-secret": TARGET, "caller-secret": CALLER }

/** A relay whose lease is short enough to drop a quiet node during a test. */
const relay = (lease: Duration.Duration) =>
  Effect.gen(function* () {
    const routes = RpcServer.layerHttp({
      group: RelayProtocol.Protocol,
      path: "/relay",
      protocol: "websocket"
    }).pipe(
      Layer.provide(RelayServer.layer({ lease })),
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

const nodeProtocol = (url: string) =>
  Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket().pipe(
      Effect.provide(RpcSerialization.layerNdjson),
      Effect.provideServiceEffect(Socket.Socket, Socket.makeWebSocket(url)),
      Effect.provide(Socket.layerWebSocketConstructorGlobal)
    )
  )

const node = (
  url: string,
  id: Relay.PeerId,
  token: string,
  options?: { readonly heartbeatInterval?: Duration.Duration | undefined }
) =>
  RelayClient.layer({
    peer: id,
    headers: { authorization: `Bearer ${token}` },
    reconnect: Duration.millis(50),
    ...(options?.heartbeatInterval === undefined ? {} : { heartbeatInterval: options.heartbeatInterval })
  }).pipe(Layer.provide(nodeProtocol(url)))

/** Every status this node passes through, in order, for as long as the scope lives. */
const track = (client: RelayClient.Service) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<string>>([])
    yield* Effect.forkScoped(
      Stream.runForEach(
        SubscriptionRef.changes(client.status),
        (state) => Ref.update(seen, (all) => (all[all.length - 1] === state._tag ? all : [...all, state._tag]))
      )
    )
    return seen
  })

/** Wait until `predicate` holds of the status, or give up and let the assertion say what it saw. */
const awaitStatus = (client: RelayClient.Service, tag: Relay.ConnectionStatus["_tag"]) =>
  Stream.runHead(
    Stream.filter(SubscriptionRef.changes(client.status), (state) => state._tag === tag)
  ).pipe(Effect.timeout(Duration.seconds(15)), Effect.ignore)

/**
 * A relay that answers `listen` for a short while and then stops answering
 * `heartbeat`, counting how many `listen` streams are open at once.
 *
 * It exists for one question: does a *failed* attempt take its `listen` stream
 * with it? An attempt forks the stream and only then proves registration with
 * a heartbeat, so an attempt whose heartbeat does not come back must still
 * clean up -- otherwise every retry leaves a live connection behind, and at a
 * real relay each one supersedes the last.
 */
const countingRelay = (options: {
  /**
   * How long the first `listen` stays open, and how long every later one does.
   *
   * They differ on purpose. The first must *end* -- that is what sends the
   * node round the loop at all -- while the ones after it should outlive
   * several attempts, so that a leak accumulates instead of quietly expiring.
   * With both set the same, a leak overlaps only about `listenFor / reconnect`
   * times and the margin between "leaking" and "not" is a single stream.
   */
  readonly firstListenFor: Duration.Duration
  readonly listenFor: Duration.Duration
  readonly heartbeatsBeforeFailing: number
}) =>
  Effect.gen(function* () {
    const active = yield* Ref.make(0)
    const peak = yield* Ref.make(0)
    const beats = yield* Ref.make(0)
    const listens = yield* Ref.make(0)

    const handlers = RelayProtocol.Protocol.toLayer({
      listen: () =>
        // No envelopes, just a lifetime: open on the first pull, closed when
        // the stream ends *or is interrupted*, which is the distinction the
        // whole test turns on. `ensuring` is what makes an interrupted stream
        // decrement rather than silently stay counted.
        Stream.fromEffect(
          Effect.flatMap(
            Ref.updateAndGet(active, (n) => n + 1),
            (now) => Ref.update(peak, (highest) => Math.max(highest, now))
          )
        ).pipe(
          Stream.drain,
          Stream.concat(
            Stream.drain(
              Stream.fromEffect(
                Effect.flatMap(
                  Ref.updateAndGet(listens, (n) => n + 1),
                  (nth) => Effect.sleep(nth === 1 ? options.firstListenFor : options.listenFor)
                )
              )
            )
          ),
          Stream.ensuring(Ref.update(active, (n) => n - 1))
        ),
      heartbeat: () =>
        Effect.flatMap(
          Ref.updateAndGet(beats, (n) => n + 1),
          (n) =>
            n > options.heartbeatsBeforeFailing
              ? Effect.fail(new Relay.RelayPeerOfflineError({ peer: TARGET }))
              : Effect.succeed({ serverTime: 0 })
        ),
      send: () => Effect.void,
      peers: () => Effect.succeed([])
    })

    const routes = RpcServer.layerHttp({
      group: RelayProtocol.Protocol,
      path: "/relay",
      protocol: "websocket"
    }).pipe(Layer.provide(handlers), Layer.provide(RpcSerialization.layerNdjson))
    const server = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 }))
    )
    const services = yield* Layer.build(server)
    const { address } = Context.get(services, HttpServer.HttpServer)
    return {
      url: `${HttpServer.formatAddress(address).replace(/^http/, "ws")}/relay`,
      peak: Ref.get(peak)
    }
  })

describe("relay reconnection", () => {
  it.live("a node dropped for going quiet comes back", () =>
    Effect.gen(function* () {
      // A lease shorter than the heartbeat: the node cannot help but lapse.
      const url = yield* relay(Duration.millis(200))
      const built = yield* Layer.build(
        node(url, TARGET, "target-secret", { heartbeatInterval: Duration.seconds(30) })
      )
      const client = Context.get(built, RelayClient.RelayClient)
      const seen = yield* track(client)
      yield* awaitStatus(client, "online")

      // Someone has to ask before the lapse is collected, because the relay
      // has no reaper fibre -- and that is the design rather than a gap. The
      // point of expiry is that a sender is not routed to a dead peer and the
      // directory does not lie, and both are answered at the moment they are
      // asked. A node that has genuinely gone is not there to be told sooner.
      const callerBuilt = yield* Layer.build(node(url, CALLER, "caller-secret"))
      const caller = Context.get(callerBuilt, RelayClient.RelayClient)
      yield* Effect.sleep("400 millis")
      yield* Effect.ignore(caller.peers)

      yield* awaitStatus(client, "connecting")
      // Coming back is the assertion: the lease lapsed, the relay ended the
      // stream, and the node re-established it without anyone asking.
      yield* awaitStatus(client, "online")

      const states = yield* Ref.get(seen)
      assert.deepStrictEqual(
        states.slice(0, 3),
        ["online", "connecting", "online"],
        `expected a drop and a recovery, saw ${JSON.stringify(states)}`
      )
    }),
    30_000
  )

  it.live("a reconnected node is routable again, with its handlers intact", () =>
    Effect.gen(function* () {
      const url = yield* relay(Duration.millis(200))
      const targetBuilt = yield* Layer.build(
        node(url, TARGET, "target-secret", { heartbeatInterval: Duration.seconds(30) })
      )
      const target = Context.get(targetBuilt, RelayClient.RelayClient)

      // Subscribed once, before the drop, and never re-subscribed: the relay
      // holds no per-endpoint state, so the handler map surviving is the whole
      // of what "handlers intact" means.
      const received = yield* Ref.make<ReadonlyArray<string>>([])
      yield* target.subscribe(
        Relay.EndpointId.make("test/endpoint"),
        (envelope) => Ref.update(received, (all) => [...all, String(envelope.from)])
      )

      yield* awaitStatus(target, "online")

      const callerBuilt = yield* Layer.build(node(url, CALLER, "caller-secret"))
      const caller = Context.get(callerBuilt, RelayClient.RelayClient)
      const envelope = {
        to: TARGET,
        endpoint: Relay.EndpointId.make("test/endpoint"),
        channel: Relay.ChannelId.make("channel-1"),
        frame: { _tag: "Ping" }
      }

      // The whole sequence a caller actually sees. The target goes quiet past
      // its lease; the next send is refused, which is also what collects the
      // lapse; the target notices its stream ended and comes back; the send
      // that follows lands.
      yield* Effect.sleep("400 millis")
      const refused = yield* Effect.flip(caller.send(envelope))
      assert.strictEqual(refused._tag, "@doeixd/effect-agent/relay/RelayPeerOfflineError")

      yield* awaitStatus(target, "connecting")
      yield* awaitStatus(target, "online")
      yield* caller.send(envelope)

      // Delivery is asynchronous; wait for it rather than assuming.
      for (let attempt = 0; attempt < 200; attempt++) {
        if ((yield* Ref.get(received)).length > 0) break
        yield* Effect.sleep("25 millis")
      }

      assert.deepStrictEqual(
        yield* Ref.get(received),
        [CALLER],
        "a reconnected node did not receive traffic on a handler it subscribed before the drop"
      )
    }),
    30_000
  )

  it.live("a superseded node stays down instead of fighting for its identity", () =>
    Effect.gen(function* () {
      // A long lease: nothing here is about expiry, and a short one would let
      // the loser come back for a reason this test is not asking about.
      const url = yield* relay(Duration.seconds(30))
      const firstBuilt = yield* Layer.build(node(url, TARGET, "target-secret"))
      const older = Context.get(firstBuilt, RelayClient.RelayClient)
      yield* awaitStatus(older, "online")

      // A second node claims the same identity and wins it.
      const secondBuilt = yield* Layer.build(node(url, TARGET, "target-secret"))
      const newer = Context.get(secondBuilt, RelayClient.RelayClient)
      yield* awaitStatus(newer, "online")

      yield* awaitStatus(older, "offline")
      const dropped = yield* SubscriptionRef.get(older.status)
      assert.strictEqual(dropped._tag, "offline", "the superseded node did not stay down")

      // The point of staying down: if it reconnected it would supersede the
      // newer one, which would reconnect and supersede it back, forever. So
      // the newer node must still be online a moment later.
      yield* Effect.sleep("500 millis")
      assert.strictEqual((yield* SubscriptionRef.get(older.status))._tag, "offline", "the loser came back and started a flap")
      assert.strictEqual((yield* SubscriptionRef.get(newer.status))._tag, "online", "the winner was superseded by the node it displaced")
    }),
    30_000
  )

  it.live("a failed attempt takes its listen stream with it", () =>
    Effect.gen(function* () {
      // The first heartbeat succeeds, so the layer builds; every one after it
      // fails, so each retry gets as far as forking `listen` and no further.
      const fake = yield* countingRelay({
        // Short enough that the first attempt ends and the loop starts; the
        // rest outlive the whole test, so a leak piles up rather than expiring.
        firstListenFor: Duration.millis(100),
        listenFor: Duration.seconds(30),
        heartbeatsBeforeFailing: 1
      })
      yield* Layer.build(
        RelayClient.layer({
          peer: TARGET,
          headers: { authorization: "Bearer irrelevant" },
          // Shorter than `listenFor`, so a leaked stream from one attempt is
          // certainly still open when the next one starts.
          reconnect: Duration.millis(150),
          heartbeatInterval: Duration.seconds(30)
        }).pipe(Layer.provide(nodeProtocol(fake.url)))
      )

      // Long enough for several attempts to have come and gone.
      yield* Effect.sleep("2 seconds")

      /**
       * Two, not one, and the reason is worth stating rather than tightening.
       *
       * The count lives on the *server*, and the client cancelling its request
       * has to reach it: the finalizer that decrements runs a round trip after
       * the attempt has already moved on. Insisting on one would make this
       * assert that the cancel wins a race against the backoff, which is a
       * claim about the machine -- the same thing that made `DurableStreams`'
       * complexity test flaky until this morning.
       *
       * The bound still discriminates by a wide margin, because the later
       * streams outlive the test: every failed attempt adds one and none of
       * them leaves, so the leak this exists to catch reaches double figures
       * in the same two seconds where the fix stays at one.
       */
      const peak = yield* fake.peak
      assert.isAtMost(
        peak,
        2,
        `${peak} listen streams were open at once: a failed attempt left its connection behind, and at a real relay each one would supersede the last`
      )
    }),
    30_000
  )
})
