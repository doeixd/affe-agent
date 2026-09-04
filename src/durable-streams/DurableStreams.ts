import {
  DurableStream,
  DurableStreamError as ClientError,
  IdempotentProducer,
  stream as openStream
} from "@durable-streams/client"
import type { Offset as ClientOffset } from "@durable-streams/client"
import { Cause, Effect, Exit, Option, Queue, Schema, Stream } from "effect"

/**
 * The official Durable Streams protocol, as Effect values (issue #10).
 *
 * A durable stream is a URL-addressable, append-only, ordered log with
 * opaque offsets, catch-up reads, live tailing and a durable close. This
 * module does not reimplement any of that: it wraps the official client,
 * which owns the HTTP, the offset grammar, the SSE / long-poll fallback and
 * the idempotent-producer state machine. What it adds is the Effect-native
 * boundary the protocol deliberately leaves out -- `Schema` on the way in
 * and out, typed errors, interruption that releases the connection -- and
 * ordinary `Stream` for reads. There is no second stream datatype here;
 * a durable stream is somewhere a `Stream` comes *from*.
 *
 * Offsets are transport positions, never semantic state. A `Record<A>`
 * pairs a decoded value with the offset *after* it, which is what a
 * consumer saves to resume; what the value means is the consumer's layer.
 *
 * Not covered by the client at this version: forking. It is left as a
 * protocol capability to revisit, not emulated.
 */

/** An opaque position in a stream. Comparable only for equality. */
export const Offset = Schema.String.pipe(Schema.brand("affe-agent/DurableStreams/Offset"))
export type Offset = typeof Offset.Type

/** The position before any record. */
export const start: Offset = Offset.make("-1")

/**
 * A decoded value and a position it is safe to resume after.
 *
 * The client delivers records in batches and reports positions per batch,
 * not per record. So `offset` is the position after the batch on the
 * batch's *last* record, and the position *before* the batch on the others:
 * resuming after any record loses nothing, and resuming after a record
 * that was not last in its batch re-delivers that batch. At-least-once for
 * a checkpoint taken mid-batch, exact for one taken at a batch boundary --
 * which a completed read, and every record of a one-record batch (a live
 * tail delivers one batch per append), always is. A consumer that needs
 * exactness across a mid-batch checkpoint keys its records, as the delivery
 * log does.
 */
export interface Record<A> {
  readonly value: A
  readonly offset: Offset
}

export const ErrorCode = Schema.Literals([
  "NOT_FOUND",
  "CONFLICT_SEQ",
  "CONFLICT_EXISTS",
  "BAD_REQUEST",
  "BUSY",
  "SSE_NOT_SUPPORTED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "RATE_LIMITED",
  "ALREADY_CONSUMED",
  "ALREADY_CLOSED",
  "PARSE_ERROR",
  "STREAM_CLOSED",
  "UNKNOWN"
])
export type ErrorCode = typeof ErrorCode.Type

/** The protocol or its transport failing, with the client's code. */
export class DurableStreamError extends Schema.TaggedError<DurableStreamError>()(
  "DurableStreamError",
  {
    url: Schema.String,
    code: ErrorCode,
    detail: Schema.String
  }
) {
  override get message() {
    return `Durable stream ${this.url}: ${this.code}: ${this.detail}`
  }
}

const toError = (url: string) => (cause: unknown): DurableStreamError =>
  cause instanceof ClientError
    ? new DurableStreamError({ url, code: cause.code, detail: cause.message })
    : new DurableStreamError({
        url,
        code: "UNKNOWN",
        detail: cause instanceof Error ? cause.message : String(cause)
      })

/** The client's `fetch`, injectable for a host that supplies its own. */
export interface Options {
  readonly url: string
  readonly fetch?: typeof fetch | undefined
  readonly headers?: Readonly<globalThis.Record<string, string>> | undefined
}

/** Every stream here is JSON: the handle says so, so appends and reads agree with the server. */
const clientOptions = (options: Options) => ({
  url: options.url,
  contentType: "application/json",
  ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  ...(options.headers === undefined ? {} : { headers: options.headers })
})

/** Metadata from a HEAD. */
export interface Head {
  readonly exists: boolean
  /** The tail: the position after the last record. */
  readonly offset: Offset
  readonly closed: boolean
}

export interface ReadOptions {
  /** Resume after this position. Defaults to the start. */
  readonly after?: Offset | undefined
  /**
   * Keep tailing once caught up. Defaults to `true`. A live read ends only
   * when the stream is closed (EOF) or the reader is interrupted; a
   * catch-up read ends when it is up to date.
   */
  readonly live?: boolean | undefined
}

/** A retry-safe writer. Appends are batched; `flush` waits for them to land. */
export interface Producer<A> {
  readonly append: (value: A) => Effect.Effect<void, DurableStreamError | Schema.SchemaError>
  readonly flush: Effect.Effect<void, DurableStreamError>
}

/** A schema-typed stream at a URL. */
export interface Typed<A, I> {
  readonly url: string
  readonly schema: Schema.Codec<A, I>
  /**
   * Create the stream. A server may accept an identical re-create or report
   * `CONFLICT_EXISTS`; one with a different configuration is refused.
   */
  readonly create: Effect.Effect<void, DurableStreamError>
  /** `create`, with an existing identical stream counted as success. */
  readonly ensure: Effect.Effect<void, DurableStreamError>
  readonly head: Effect.Effect<Head, DurableStreamError>
  /** Encode and append one value. Resolves when the server has it. */
  readonly append: (value: A) => Effect.Effect<void, DurableStreamError | Schema.SchemaError>
  /**
   * Records from the stream, decoded. An undecodable record fails the read
   * with the `SchemaError`; what arrived is not silently skipped.
   */
  readonly read: (
    options?: ReadOptions
  ) => Stream.Stream<Record<A>, DurableStreamError | Schema.SchemaError>
  /** Close durably. Idempotent. Readers see EOF. */
  readonly close: Effect.Effect<void, DurableStreamError>
  /** Delete the stream. */
  readonly delete: Effect.Effect<void, DurableStreamError>
  /**
   * An idempotent producer: the official client's retry-safe, fenced writer.
   * `producerId` names the writer; `epoch` fences a stale one. Scoped: the
   * remaining batch is flushed when the scope closes.
   */
  readonly producer: (
    producerId: string,
    options?: { readonly epoch?: number | undefined }
  ) => Effect.Effect<Producer<A>, DurableStreamError, import("effect").Scope.Scope>
}

/**
 * Values cross as JSON; the protocol carries bytes, the content type says
 * JSON, and the schema's JSON codec says what the JSON is.
 */
export const make = <A, I>(
  options: Options & { readonly schema: Schema.Codec<A, I> }
): Typed<A, I> => {
  const url = options.url
  const fail = toError(url)
  const json = Schema.toCodecJson(options.schema)
  const encode = (value: A) =>
    Schema.encodeEffect(json)(value).pipe(Effect.map((encoded) => JSON.stringify(encoded)))
  const handle = new DurableStream(clientOptions(options))
  const promise = <X>(run: () => Promise<X>) =>
    Effect.tryPromise({ try: run, catch: fail })

  const head: Typed<A, I>["head"] = promise(() => DurableStream.head(clientOptions(options))).pipe(
    Effect.map((result) =>
      result.exists
        ? {
            exists: true,
            offset: Offset.make(result.offset ?? start),
            closed: result.streamClosed
          }
        : { exists: false, offset: start, closed: false }
    )
  )

  const create = Effect.asVoid(
    promise(() => DurableStream.create(clientOptions(options)))
  )

  const decodeExit = Schema.decodeUnknownExit(json)

  // The callback queue is unbounded on purpose: batches are offered without
  // awaiting, and a bounded queue would *drop* records past its capacity
  // for a consumer slower than the network. A durable log's reader
  // buffering in memory is acceptable; losing records is not.
  const read: Typed<A, I>["read"] = (readOptions) =>
    Stream.callback<Record<A>, DurableStreamError | Schema.SchemaError>((queue) =>
      Effect.gen(function* () {
        const controller = new AbortController()
        const live = readOptions?.live ?? true
        const after = readOptions?.after ?? start
        const session = yield* promise(() =>
          openStream({
            ...clientOptions(options),
            live,
            signal: controller.signal,
            ...(after === start ? {} : { offset: after as ClientOffset })
          })
        )
        let batchStart: Offset = after
        /** Decode a batch and offer it under the offset contract on `Record`. */
        const offer = (items: ReadonlyArray<unknown>, batchEnd: Offset): boolean => {
          const records: Array<Record<A>> = []
          for (const item of items) {
            const exit = decodeExit(item)
            if (Exit.isFailure(exit)) {
              // What arrived is not silently skipped: the read fails with
              // the decode error. What decoded before it in the batch is
              // delivered first, so a reader can still find the position.
              Queue.offerAllUnsafe(queue, records)
              Queue.failCauseUnsafe(queue, exit.cause)
              return false
            }
            records.push({ value: exit.value, offset: batchStart })
          }
          if (records.length > 0) {
            records[records.length - 1] = { ...records[records.length - 1]!, offset: batchEnd }
          }
          Queue.offerAllUnsafe(queue, records)
          batchStart = batchEnd
          return true
        }
        if (!live) {
          // A catch-up read is one response: the client has it whole.
          const items = yield* promise(() => session.json())
          // Same contract as the live path: a failed `offer` has already
          // failed the queue with the decode cause, and ending it here would
          // race that failure with an EOF. Return instead.
          if (!offer(items, Offset.make(session.offset))) return
          Queue.endUnsafe(queue)
          return
        }
        // A live read is batches as they arrive: the catch-up body first,
        // then one per append, then EOF.
        const unsubscribe = session.subscribeJson((batch) => {
          if (!offer(batch.items, Offset.make(batch.offset))) return
          if (batch.streamClosed) Queue.endUnsafe(queue)
        })
        // `closed` can already be settled when the stream was closed before
        // this read began; the buffered first batch is still delivered to
        // the subscriber afterwards, so ending here yields a turn first.
        // The batch carrying `streamClosed` ends the queue itself in the
        // usual case; this is the backstop.
        void session.closed.then(
          () => setTimeout(() => Queue.endUnsafe(queue), 0),
          (cause) => {
            if (!controller.signal.aborted) Queue.failCauseUnsafe(queue, Cause.fail(fail(cause)))
          }
        )
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            unsubscribe()
            controller.abort()
          })
        )
      })
    )

  return {
    url,
    schema: options.schema,
    create,
    ensure: create.pipe(
      Effect.catchIf(
        (error) => error.code === "CONFLICT_EXISTS",
        () => Effect.void
      )
    ),
    head,
    append: (value) =>
      Effect.flatMap(encode(value), (body) => promise(() => handle.append(body))),
    read,
    close: Effect.asVoid(promise(() => handle.close())).pipe(
      Effect.catchIf((error) => error.code === "ALREADY_CLOSED", () => Effect.void)
    ),
    delete: promise(() => handle.delete()),
    producer: (producerId, producerOptions) =>
      Effect.gen(function* () {
        const producer = new IdempotentProducer(handle, producerId, {
          ...(producerOptions?.epoch === undefined ? {} : { epoch: producerOptions.epoch })
        })
        yield* Effect.addFinalizer(() =>
          Effect.ignore(promise(() => producer.flush()))
        )
        return {
          append: (value) =>
            Effect.flatMap(encode(value), (body) =>
              Effect.try({ try: () => producer.append(body), catch: fail })
            ),
          flush: Effect.asVoid(promise(() => producer.flush()))
        }
      })
  }
}

/** Read a stream to the end and fold it: the shape of replaying deltas into state. */
export const fold = <A, I, S>(
  typed: Typed<A, I>,
  initial: S,
  step: (state: S, value: A) => S,
  options?: { readonly after?: Offset | undefined }
): Effect.Effect<{ readonly state: S; readonly offset: Offset }, DurableStreamError | Schema.SchemaError> =>
  Stream.runFold(
    typed.read({ after: options?.after, live: false }),
    () => ({ state: initial, offset: options?.after ?? start }),
    (acc, record) => ({ state: step(acc.state, record.value), offset: record.offset })
  )

/** `Option` of the last record, for a caller that wants the tail position. */
export const last = <A, I>(
  typed: Typed<A, I>
): Effect.Effect<Option.Option<Record<A>>, DurableStreamError | Schema.SchemaError> =>
  Stream.runLast(typed.read({ live: false }))
