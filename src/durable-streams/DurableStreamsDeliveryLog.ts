import { Effect, Option, Ref, Schema, Semaphore, Stream } from "effect"
import * as AgentEvent from "../AgentEvent.js"
import * as DeliveryLog from "../durable/DeliveryLog.js"
import * as DurableStreams from "./DurableStreams.js"

/**
 * The durable client's `DeliveryLog`, on Durable Streams (issue #10).
 *
 * One durable stream per session, at `${baseUrl}/${sessionId}`. What a
 * client observes of a session is an ordered, URL-addressable log it can
 * catch up on and tail from any process -- which is the property the
 * memory and SQL logs lack: their `live` is a process-local PubSub, so a
 * browser reconnecting to a different node sees nothing until it polls.
 * Here `live` is the protocol's own tail.
 *
 * The log's contract has two numbers the protocol does not have:
 *
 * - the **key**, the event's identity under replay. The stream stores
 *   `{ key, envelope }` records, and a key's first occurrence is the event;
 *   later occurrences -- two runners replaying the same emission, an
 *   acknowledgement lost and the append retried -- are skipped by every
 *   reader. A later occurrence with a *different* payload is reported as
 *   `Conflict`, as the other stores do.
 * - the **sequence**, the session-wide delivery offset `read({ after })`
 *   is addressed by. It is the record's position among first occurrences,
 *   computed by counting the stream from its start. Every reader in every
 *   process computes the same number for the same event, because they all
 *   count the same stream; no writer assigns it, so no two writers can
 *   disagree about it.
 *
 * Protocol offsets stay transport positions. Each process keeps a per-session
 * index -- the keys seen, the count, the offset read up to -- rebuilt from the
 * stream on first touch and advanced incrementally; it is a cache of the
 * stream, never a second source of truth.
 *
 * A session stream is never closed by this log: a durable session accepts
 * prompts for as long as it exists. Closing is for finite streams, and the
 * typed module exposes it for those.
 */

const Record = Schema.Struct({
  key: Schema.String,
  envelope: AgentEvent.AgentEventEnvelope
})
type Record = typeof Record.Type

interface Index {
  /** The position read up to. */
  readonly offset: DurableStreams.Offset
  /** First-occurrence records, numbered 1..n. */
  readonly entries: ReadonlyArray<AgentEvent.AgentEventEnvelope>
  /** Key to its first payload, for conflict detection. */
  readonly payloads: ReadonlyMap<string, string>
  readonly ensured: boolean
}

const emptyIndex: Index = {
  offset: DurableStreams.start,
  entries: [],
  payloads: new Map(),
  ensured: false
}

/** The payload identity used for conflict detection: the wire form, without the per-process sequence. */
const payloadOf = (envelope: AgentEvent.AgentEventEnvelope): Effect.Effect<string> =>
  Effect.map(DeliveryLog.encodeEnvelope(envelope), (encoded) =>
    encoded.replace(/"sequence":\d+/, "")
  )

/** Fold one record into an index: a new key is the next entry; a seen key is skipped. */
const absorb = (
  index: Index,
  record: DurableStreams.Record<Record>,
  payload: string
): { readonly index: Index; readonly entry: Option.Option<AgentEvent.AgentEventEnvelope> } => {
  if (index.payloads.has(record.value.key)) {
    return { index: { ...index, offset: record.offset }, entry: Option.none() }
  }
  const entry: AgentEvent.AgentEventEnvelope = {
    ...record.value.envelope,
    sequence: index.entries.length + 1
  }
  const payloads = new Map(index.payloads)
  payloads.set(record.value.key, payload)
  return {
    index: { ...index, offset: record.offset, entries: [...index.entries, entry], payloads },
    entry: Option.some(entry)
  }
}

export interface Options {
  /** Streams live at `${baseUrl}/${encodeURIComponent(sessionId)}`. */
  readonly baseUrl: string
  readonly fetch?: typeof fetch | undefined
  readonly headers?: Readonly<globalThis.Record<string, string>> | undefined
}

/** The stream for a session. Exposed for tests and for tooling that reads the raw log. */
export const streamFor = (options: Options, sessionId: string) =>
  DurableStreams.make({
    url: `${options.baseUrl.replace(/\/$/, "")}/${encodeURIComponent(sessionId)}`,
    schema: Record,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.headers === undefined ? {} : { headers: options.headers })
  })

/**
 * Build the log. Protocol and decode failures are defects here: the
 * `DeliveryLog` interface is infallible, because the recorder runs inside a
 * workflow activity that treats infrastructure loss as what it is, and a
 * delivery log that cannot be reached is not a case a session handles.
 */
export const make = (options: Options): Effect.Effect<DeliveryLog.DeliveryLog> =>
  Effect.gen(function* () {
    const indexes = yield* Ref.make(new Map<string, Ref.Ref<Index>>())
    const locks = yield* Ref.make(new Map<string, Semaphore.Semaphore>())

    const indexFor = (sessionId: string) =>
      Effect.flatMap(Ref.get(indexes), (all) => {
        const existing = all.get(sessionId)
        return existing !== undefined
          ? Effect.succeed(existing)
          : Effect.flatMap(Ref.make(emptyIndex), (fresh) =>
              Ref.modify(indexes, (current) => {
                const raced = current.get(sessionId)
                if (raced !== undefined) return [raced, current]
                return [fresh, new Map(current).set(sessionId, fresh)]
              })
            )
      })

    const lockFor = (sessionId: string) =>
      Effect.flatMap(Ref.get(locks), (all) => {
        const existing = all.get(sessionId)
        return existing !== undefined
          ? Effect.succeed(existing)
          : Effect.flatMap(Semaphore.make(1), (fresh) =>
              Ref.modify(locks, (current) => {
                const raced = current.get(sessionId)
                if (raced !== undefined) return [raced, current]
                return [fresh, new Map(current).set(sessionId, fresh)]
              })
            )
      })

    /** Catch the index up to the stream's current end. Under the session lock. */
    const sync = (sessionId: string, index: Ref.Ref<Index>): Effect.Effect<Index> =>
      Effect.gen(function* () {
        const stream = streamFor(options, sessionId)
        const current = yield* Ref.get(index)
        if (!current.ensured) {
          yield* stream.ensure.pipe(Effect.orDie)
          yield* Ref.update(index, (i) => ({ ...i, ensured: true }))
        }
        const folded = yield* Stream.runFoldEffect(
          stream.read({ after: current.offset, live: false }),
          () => ({ ...current, ensured: true }),
          (acc, record) =>
            Effect.map(payloadOf(record.value.envelope), (payload) => absorb(acc, record, payload).index)
        ).pipe(Effect.orDie)
        yield* Ref.set(index, folded)
        return folded
      })

    const withSession = <A>(sessionId: string, use: (index: Ref.Ref<Index>) => Effect.Effect<A>) =>
      Effect.gen(function* () {
        const lock = yield* lockFor(sessionId)
        const index = yield* indexFor(sessionId)
        return yield* lock.withPermits(1)(use(index))
      })

    const append: DeliveryLog.DeliveryLog["append"] = (sessionId, key, envelope) =>
      withSession(sessionId, (index) =>
        Effect.gen(function* () {
          const wire = AgentEvent.toWire(envelope)
          const payload = yield* payloadOf(wire)
          // Others may have written since we last looked, including this
          // very key from another process.
          const before = yield* sync(sessionId, index)
          const seen = before.payloads.get(key)
          if (seen !== undefined) {
            return seen === payload
              ? { _tag: "Duplicate" as const }
              : { _tag: "Conflict" as const }
          }
          yield* streamFor(options, sessionId)
            .append({ key, envelope: wire })
            .pipe(Effect.orDie)
          // Our record's position is whatever the stream says it is: read
          // it back rather than guess. Another process may have landed the
          // same key first; then theirs is the event and ours is the
          // duplicate -- the same outcome, unless they disagree about it.
          const after = yield* sync(sessionId, index)
          const first = after.payloads.get(key)
          return first === payload
            ? { _tag: "Appended" as const, sequence: indexOfKey(after, key) }
            : { _tag: "Conflict" as const }
        })
      )

    const read: DeliveryLog.DeliveryLog["read"] = (sessionId, readOptions) =>
      withSession(sessionId, (index) =>
        Effect.map(sync(sessionId, index), (synced) => {
          const after = readOptions?.after ?? 0
          return synced.entries.filter((e) => e.sequence > after)
        })
      )

    const live: DeliveryLog.DeliveryLog["live"] = (sessionId) =>
      Stream.unwrap(
        withSession(sessionId, (index) => sync(sessionId, index)).pipe(
          Effect.map((snapshot) => {
            // A private copy of the index from here on: numbering is
            // deterministic, so counting locally agrees with every other
            // reader and needs no lock.
            let local = snapshot
            return streamFor(options, sessionId)
              .read({ after: snapshot.offset, live: true })
              .pipe(
                Stream.mapEffect((record) =>
                  Effect.map(payloadOf(record.value.envelope), (payload) => {
                    const result = absorb(local, record, payload)
                    local = result.index
                    return result.entry
                  })
                ),
                Stream.filter(Option.isSome),
                Stream.map((entry) => entry.value),
                Stream.orDie
              )
          })
        )
      )

    return { append, live, read }
  })

/** The sequence of a key's first occurrence, or -1. */
const indexOfKey = (index: Index, key: string): number => {
  // Keys are recorded in entry order, and a Map iterates in insertion order.
  let position = 0
  for (const k of index.payloads.keys()) {
    position += 1
    if (k === key) return position
  }
  return -1
}
