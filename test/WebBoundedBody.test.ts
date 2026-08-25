import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Layer } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "effect/unstable/http"
import { WebFetch } from "../src/web/index.js"
import * as HttpWebFetch from "../src/web/http.js"
import * as Body from "../src/web/internal/body.js"

/**
 * A body delivered one byte at a time.
 *
 * A `Response` built from a string hands over a couple of large chunks, which
 * is why a fold that copied its accumulator per chunk sat behind a green
 * suite: the byte cap bounds the total size, not the number of chunks.
 */
const drip = (
  request: HttpClientRequest.HttpClientRequest,
  bytes: number,
  onCancel?: () => void
): HttpClientResponse.HttpClientResponse => {
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) {
        controller.close()
        return
      }
      sent = sent + 1
      controller.enqueue(new Uint8Array([65]))
    },
    cancel() {
      onCancel?.()
    }
  })
  return HttpClientResponse.fromWeb(request, new Response(stream))
}

const request = HttpClientRequest.get("https://example.com/")

describe("bounded web response bodies", () => {
  /**
   * R94 -- the byte cap does not bound the chunk count.
   *
   * 100,000 one-byte chunks. The old `[...chunks, chunk]` fold copies the
   * accumulator every time, which is five billion reference copies: not slow,
   * unfinishable. Bounded by an explicit timeout rather than a wall-clock
   * sleep, and `it.live` so that timeout is real time rather than a test
   * clock that would never advance on its own.
   */
  it.live("reads a hundred thousand one-byte chunks in bounded time", () =>
    Effect.gen(function*() {
      const bytes = yield* Body.readBounded(drip(request, 100_000), {
        maxBytes: 1024 * 1024,
        tooLarge: () => "too large" as const,
        transport: () => "transport" as const
      }).pipe(Effect.timeout(Duration.seconds(10)))

      assert.strictEqual(bytes.byteLength, 100_000)
    }))

  /**
   * R95 -- giving up on a response has to release it.
   *
   * Effect's client aborts when a consumed stream is finalized or when the
   * response is eventually collected; dropping the value is not a release
   * boundary. Taking zero elements runs the finalizer at once, and the web
   * stream's own `cancel` is what proves it.
   */
  it.effect("releasing a body cancels it without reading it", () =>
    Effect.gen(function*() {
      // A plain binding rather than a `Ref`: `cancel` is a synchronous
      // callback from the platform stream, so there is no Effect to run it in
      // and nothing concurrent to protect it from.
      let cancelled = false
      const response = drip(request, 1_000, () => {
        cancelled = true
      })

      yield* Body.release(response)
      assert.isTrue(cancelled)
    }))


  /**
   * And the same property through the provider.
   *
   * These are the paths that used to drop a response outright: a redirect, a
   * non-2xx status, a media type that is not text, and a body whose declared
   * size already exceeds the cap. `HttpClient.make` hands its callback the
   * abort signal of the controller it will abort on release, so a settled
   * signal by the time the failure returns is the release actually happening.
   */
  const releasedOn = (init: ResponseInit) =>
    Effect.gen(function*() {
      const signals: Array<AbortSignal> = []
      const client = HttpClient.make((clientRequest, _url, signal) => {
        signals.push(signal)
        return Effect.succeed(
          HttpClientResponse.fromWeb(clientRequest, new Response("body", init))
        )
      })

      yield* Effect.flip(
        Effect.flatMap(WebFetch.WebFetch, (service) =>
          service.fetch(new URL("https://example.com/page"))).pipe(
          Effect.provide(
            HttpWebFetch.layer.pipe(
              Layer.provide(Layer.succeed(HttpClient.HttpClient)(client))
            )
          )
        )
      )

      assert.isAbove(signals.length, 0, "the client was never called")
      return signals.every((signal) => signal.aborted)
    })

  it.effect("every early exit settles the request", () =>
    Effect.gen(function*() {
      // A redirect this provider will not follow.
      assert.isTrue(
        yield* releasedOn({
          status: 302,
          headers: { location: "https://elsewhere.example/" }
        }),
        "a refused redirect left the request open"
      )
      // A failing status.
      assert.isTrue(
        yield* releasedOn({ status: 500 }),
        "a failed status left the request open"
      )
      // A media type that is not text.
      assert.isTrue(
        yield* releasedOn({ status: 200, headers: { "content-type": "image/png" } }),
        "an unsupported media type left the request open"
      )
      // A body that says up front it is too big to read.
      assert.isTrue(
        yield* releasedOn({
          status: 200,
          headers: { "content-type": "text/plain", "content-length": "999999999" }
        }),
        "an oversized body left the request open"
      )
    }))
})
