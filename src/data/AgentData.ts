import { Context, Effect, Layer, Metric, Option, PubSub, Ref, Schema, Semaphore, Stream } from "effect"
import * as Namespace from "../internal/namespace.js"

/**
 * Counts events a reader dropped because it could not decode them (a schema
 * skew between an incompatible writer and reader), tagged by channel name. The
 * drop stays non-fatal, but it is no longer invisible: a rising count on a
 * channel is the signal that two ends disagree on its schema.
 */
const droppedEvents = Metric.counter("agent_data_dropped_events", {
  description: "DataChannel events dropped because a reader could not decode them",
  incremental: true
})

/**
 * Structured client/UI data (issue #4 §9).
 *
 * An agent often has typed output beyond its reply -- an order it created, a
 * chart's data, a row to append to a table. This package gives that a home: a
 * Schema-first named channel a tool writes to, and a stream a UI or transport
 * reads, with the payload typed on both ends rather than `unknown` at the wire.
 *
 * It is **observational**: writing to a channel does not touch canonical
 * conversation history. A UI card rendered from a channel is not part of the
 * transcript merely because it was displayed -- the same separation the harness
 * keeps between derived output and canonical state.
 *
 * ```ts
 * const Orders = AgentData.channel("orders", OrderSchema)
 *
 * // In a tool handler -- fully typed, requires the DataChannels service:
 * yield* Orders.write({ id: "A-1", total: 42 })
 *
 * // In a UI/transport -- a typed stream of just this channel's values:
 * yield* Stream.runForEach(Orders.stream, (order) => render(order))
 *
 * // Wire it like any service:
 * program.pipe(Effect.provide(AgentData.layer))
 * ```
 */

/** One structured write: the channel it went to, a session-monotonic sequence, and the encoded payload. */
export interface DataEvent {
  readonly channel: string
  readonly sequence: number
  /** Schema-encoded (JSON-safe); decode with the channel's schema. */
  readonly payload: unknown
}

export interface DataChannelsShape {
  /** Publish an already-encoded payload to a channel. Channels use this; prefer `channel(...).write`. */
  readonly publish: (channel: string, payload: unknown) => Effect.Effect<void>
  /** The live stream of every channel's events, from the point of subscription. */
  readonly events: Stream.Stream<DataEvent>
}

/**
 * The bus structured data flows through. A tool writes to it via a `channel`
 * handle; a UI or transport reads `events`. Provided as a layer, so what backs
 * it -- an in-process PubSub here -- is wiring.
 */
export class DataChannels extends Context.Service<DataChannels, DataChannelsShape>()(
  Namespace.tag("data/DataChannels")
) {}

/** An in-process implementation over a PubSub, with a monotonic sequence. */
export const layer: Layer.Layer<DataChannels> = Layer.effect(
  DataChannels,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<DataEvent>()
    const sequence = yield* Ref.make(0)
    // A permit so a sequence is assigned and published as one step: without it,
    // two concurrent writers could publish out of sequence order, and a
    // subscriber rendering in arrival order would show them reordered.
    const lock = yield* Semaphore.make(1)
    return {
      publish: (channel, payload) =>
        lock.withPermits(1)(
          Ref.updateAndGet(sequence, (n) => n + 1).pipe(
            Effect.flatMap((next) => PubSub.publish(pubsub, { channel, sequence: next, payload })),
            Effect.asVoid
          )
        ),
      events: Stream.fromPubSub(pubsub)
    }
  })
)

/**
 * A typed data channel. `write` encodes and publishes; `stream` and `reads`
 * decode. An unencodable value is a defect (the schema must round-trip its own
 * value); an event a reader cannot decode -- foreign traffic on a shared name --
 * is dropped and logged rather than killing the reader.
 */
export interface Channel<A, I> {
  readonly name: string
  readonly schema: Schema.Codec<A, I>
  /** Encode and publish a value to this channel. */
  readonly write: (value: A) => Effect.Effect<void, never, DataChannels>
  /** Decode this channel's values out of a `DataEvent` stream. */
  readonly reads: (events: Stream.Stream<DataEvent>) => Stream.Stream<A>
  /** This channel's values from the ambient `DataChannels` service. */
  readonly stream: Stream.Stream<A, never, DataChannels>
}

/** Define a Schema-first channel. Give it a stable name and a codec. */
export const channel = <A, I>(name: string, schema: Schema.Codec<A, I>): Channel<A, I> => {
  const encode = Schema.encodeEffect(schema)
  const decode = Schema.decodeUnknownEffect(schema)
  // A reader tolerates a payload it cannot decode -- another writer sharing the
  // channel name with an incompatible schema, or a version skew -- by dropping
  // it rather than dying, so one bad publisher cannot kill every reader of a
  // shared bus. The drop is made observable, not silent: it logs and increments
  // the `agent_data_dropped_events` counter tagged with this channel, so a
  // schema skew surfaces as a rising metric instead of vanishing. A channel
  // decoding its own round-tripped writes never hits this path.
  const dropped = Metric.withAttributes(droppedEvents, { channel: name })
  const reads = (events: Stream.Stream<DataEvent>): Stream.Stream<A> =>
    events.pipe(
      Stream.filter((event) => event.channel === name),
      Stream.mapEffect((event) =>
        decode(event.payload).pipe(
          Effect.map(Option.some),
          Effect.catchCause((cause) =>
            Metric.update(dropped, 1).pipe(
              Effect.andThen(Effect.logWarning(`AgentData: dropped an undecodable "${name}" event`, cause)),
              Effect.as(Option.none<A>())
            ))
        )),
      Stream.filter(Option.isSome),
      Stream.map((some) => some.value)
    )
  return {
    name,
    schema,
    write: (value) =>
      Effect.flatMap(DataChannels, (channels) =>
        encode(value).pipe(Effect.orDie, Effect.flatMap((payload) => channels.publish(name, payload)))),
    reads,
    stream: Stream.unwrap(Effect.map(DataChannels, (channels) => reads(channels.events)))
  }
}
