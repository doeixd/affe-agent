import { assert, describe, it } from "@effect/vitest"
import { Effect, Queue, Schema, Stream } from "effect"
import { AgentData } from "../src/data/index.js"

/**
 * Structured data channels. The read path (filter + decode) is pinned as a pure
 * function over a fixed event stream; the write→publish→read round-trip runs
 * against the real PubSub-backed layer, deterministically (fork the subscriber,
 * `yieldNow` to let it attach, then write -- the repo's AgentProbe pattern).
 */

interface Order {
  readonly id: string
  readonly total: number
}
const Orders = AgentData.channel("orders", Schema.Struct({ id: Schema.String, total: Schema.Number }))
const Alerts = AgentData.channel("alerts", Schema.Struct({ message: Schema.String }))

describe("AgentData.channel reads", () => {
  it.effect("decodes only its own channel's events, in order", () =>
    Effect.gen(function* () {
      const events: ReadonlyArray<AgentData.DataEvent> = [
        { channel: "orders", sequence: 1, payload: { id: "A", total: 1 } },
        { channel: "alerts", sequence: 2, payload: { message: "hi" } },
        { channel: "orders", sequence: 3, payload: { id: "B", total: 2 } }
      ]
      const orders = yield* Stream.runCollect(Orders.reads(Stream.fromIterable(events)))
      assert.deepStrictEqual([...orders], [{ id: "A", total: 1 }, { id: "B", total: 2 }])
    })
  )
})

describe("AgentData round-trip", () => {
  it.effect("a write is observed on the channel's stream, decoded and in order", () =>
    Effect.gen(function* () {
      const received = yield* Queue.unbounded<Order>()
      yield* Effect.forkScoped(Stream.runForEach(Orders.stream, (order) => Queue.offer(received, order)))
      // Let the subscriber attach before anything is published.
      yield* Effect.yieldNow

      yield* Orders.write({ id: "A-1", total: 42 })
      yield* Orders.write({ id: "A-2", total: 7 })
      // Let the subscriber drain the two published events.
      yield* Effect.yieldNow

      const orders = yield* Queue.takeAll(received)
      assert.deepStrictEqual([...orders], [{ id: "A-1", total: 42 }, { id: "A-2", total: 7 }])
    }).pipe(Effect.provide(AgentData.layer), Effect.scoped)
  )

  it.effect("channels are isolated: a write to one is not seen on another", () =>
    Effect.gen(function* () {
      const alerts = yield* Queue.unbounded<{ readonly message: string }>()
      yield* Effect.forkScoped(Stream.runForEach(Alerts.stream, (alert) => Queue.offer(alerts, alert)))
      yield* Effect.yieldNow
      yield* Orders.write({ id: "A-1", total: 1 })
      yield* Effect.yieldNow
      assert.strictEqual(yield* Queue.size(alerts), 0)
    }).pipe(Effect.provide(AgentData.layer), Effect.scoped)
  )
})

describe("AgentData encoding", () => {
  // A transforming schema: number in code, string on the wire.
  const Metrics = AgentData.channel("metrics", Schema.Struct({ n: Schema.NumberFromString }))

  it.effect("the wire payload is the schema-encoded form; reads decode it back", () =>
    Effect.gen(function* () {
      const raw = yield* Queue.unbounded<AgentData.DataEvent>()
      const decoded = yield* Queue.unbounded<{ readonly n: number }>()
      const rawEvents = Stream.unwrap(Effect.map(AgentData.DataChannels, (channels) => channels.events))
      yield* Effect.forkScoped(Stream.runForEach(rawEvents, (event) => Queue.offer(raw, event)))
      yield* Effect.forkScoped(Stream.runForEach(Metrics.stream, (value) => Queue.offer(decoded, value)))
      yield* Effect.yieldNow

      yield* Metrics.write({ n: 5 })
      yield* Effect.yieldNow

      // On the wire, the number is its encoded (string) form...
      const payload = [...(yield* Queue.takeAll(raw))][0]!.payload
      assert.isTrue(typeof payload === "object" && payload !== null && "n" in payload && payload.n === "5")
      // ...and a reader gets a real number back.
      const value = [...(yield* Queue.takeAll(decoded))][0]!
      assert.strictEqual(value.n, 5)
    }).pipe(Effect.provide(AgentData.layer), Effect.scoped)
  )
})
