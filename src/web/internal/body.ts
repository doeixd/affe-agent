import { Effect, Stream } from "effect"
import type { HttpClientResponse } from "effect/unstable/http"

/**
 * Reading and releasing HTTP response bodies, once, for both web providers.
 *
 * Written as one module rather than a copy in each provider because the two
 * had already drifted: the same quadratic accumulation was fixed in one and
 * left in the other, and neither released a body it decided not to read.
 */

/** The one value this module fails with when a body outgrows its cap. */
const overflow = Symbol.for("affe-agent/web/bodyOverflow")

/** How the caller names "too large" in its own failure vocabulary. */
export interface Bounds<E> {
  readonly maxBytes: number
  readonly tooLarge: (observedBytes: number) => E
  readonly transport: (reason: string) => E
}

/**
 * Give up on a response without reading it.
 *
 * Every early exit -- a redirect, a 401, an unsupported media type, a body
 * whose advertised size already exceeds the cap -- used to simply drop the
 * response. Effect's client aborts when a *consumed* stream is finalized or
 * when the response is eventually collected, so dropping it is not a release
 * boundary: a redirect or retry chain can hold connections open for as long
 * as the collector takes to notice.
 *
 * One element, then done. Taking *zero* looked tidier and does nothing at
 * all: the stream short-circuits before it is ever pulled, so neither the
 * client's finalizer nor the platform stream's `cancel` runs. Pulling one
 * chunk and terminating runs both, and one chunk is bounded by whatever the
 * transport hands over -- a hostile body cannot make the release expensive.
 */
export const release = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<void> =>
  Effect.ignore(Stream.runDrain(Stream.take(response.stream, 1)))

/**
 * The whole body, or a failure, never more than `maxBytes`.
 *
 * Neither `.text` nor `.json` is bounded, so the body is consumed a chunk at
 * a time and the running total is checked before the next one is kept.
 *
 * Chunks are pushed onto one array rather than copied into a new one per
 * chunk. The byte cap bounds the total *size*; it does not bound the chunk
 * *count*, so a response delivered one byte at a time made the old
 * `[...chunks, chunk]` fold copy a million arrays inside a cap that was doing
 * its job. A `Response` built in a test delivers a few large chunks and can
 * never show it.
 */
export const readBounded = <E>(
  response: HttpClientResponse.HttpClientResponse,
  bounds: Bounds<E>
): Effect.Effect<Uint8Array, E> =>
  Effect.gen(function*() {
    const declared = response.headers["content-length"]
    if (declared !== undefined) {
      const advertised = Number(declared)
      if (Number.isFinite(advertised) && advertised > bounds.maxBytes) {
        // Refused before a byte is read, and the connection is let go rather
        // than left for the collector.
        yield* release(response)
        return yield* Effect.fail(bounds.tooLarge(advertised))
      }
    }

    const chunks: Array<Uint8Array> = []
    let size = 0
    /**
     * A local marker rather than the caller's failure.
     *
     * The stream's own error channel is `HttpClientError`, and the caller's
     * `E` is generic -- so a union of the two cannot be narrowed by tag, and
     * mixing them makes the whole channel `unknown`. Failing with something
     * this module owns keeps the two distinguishable, and the caller's
     * vocabulary is applied once, here, where both cases are in hand.
     */
    const outcome = yield* Effect.result(
      Stream.runForEach(response.stream, (chunk) => {
        size = size + chunk.byteLength
        if (size > bounds.maxBytes) return Effect.fail(overflow)
        chunks.push(chunk)
        return Effect.void
      })
    )
    if (outcome._tag === "Failure") {
      const error = outcome.failure
      // No release here. The stream has already been read from, so its
      // finalizer has already run -- asking for a second reader is what
      // "ReadableStream is locked" means. Release is for a body this code
      // decided *not* to read.
      return yield* Effect.fail(
        error === overflow ? bounds.tooLarge(size) : bounds.transport(error.reason._tag)
      )
    }

    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset = offset + chunk.byteLength
    }
    return bytes
  })
