import { assert, describe, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Fiber, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "effect/unstable/http"
import { WebFetch } from "../src/web/index.js"
import * as HttpWebFetch from "../src/web/http.js"

const response = (
  request: HttpClientRequest.HttpClientRequest,
  content: string | Uint8Array | null,
  init?: ResponseInit | undefined
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(request, new Response(content, init))

const provider = (client: HttpClient.HttpClient) =>
  HttpWebFetch.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient)(client))
  )

const fetchWith = (client: HttpClient.HttpClient, url: string) =>
  Effect.flatMap(WebFetch.WebFetch, (service) => service.fetch(new URL(url))).pipe(
    Effect.provide(provider(client))
  )

describe("guarded HTTP web fetch provider", () => {
  it.effect("fetches bounded text and reports its honest canonical representation", () =>
    Effect.gen(function* () {
      const requested = yield* Ref.make<Array<string>>([])
      const client = HttpClient.make((request, url) =>
        Ref.update(requested, (all) => [...all, url.href]).pipe(
          Effect.as(response(request, "<h1>Effect</h1>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" }
          }))
        ))

      const result = yield* fetchWith(
        client,
        "https://EXAMPLE.com:443/docs#installation"
      )

      assert.deepStrictEqual(yield* Ref.get(requested), ["https://example.com/docs"])
      assert.deepStrictEqual(result, {
        finalUrl: "https://example.com/docs",
        status: 200,
        mediaType: "text/html",
        format: "html",
        body: "<h1>Effect</h1>"
      })
    })
  )

  it.effect("rejects invalid, local, private and metadata targets before HTTP", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const client = HttpClient.make((request) =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.as(response(request, "unexpected", {
            headers: { "content-type": "text/plain" }
          }))
        ))
      const cases = [
        ["ftp://example.com/file", "WebFetchInvalidUrlError"],
        ["https://user:secret@example.com/", "WebFetchInvalidUrlError"],
        ["http://localhost/", "WebFetchDeniedTargetError"],
        ["http://service.local/", "WebFetchDeniedTargetError"],
        ["http://metadata.google.internal/", "WebFetchDeniedTargetError"],
        ["http://127.0.0.1/", "WebFetchDeniedTargetError"],
        ["http://2130706433/", "WebFetchDeniedTargetError"],
        ["http://10.1.2.3/", "WebFetchDeniedTargetError"],
        ["http://172.16.1.2/", "WebFetchDeniedTargetError"],
        ["http://192.168.1.2/", "WebFetchDeniedTargetError"],
        ["http://169.254.169.254/latest/meta-data", "WebFetchDeniedTargetError"],
        ["http://[::1]/", "WebFetchDeniedTargetError"],
        ["http://[fe80::1]/", "WebFetchDeniedTargetError"],
        ["http://[fc00::1]/", "WebFetchDeniedTargetError"],
        ["http://[::ffff:127.0.0.1]/", "WebFetchDeniedTargetError"]
      ] as const

      for (const [url, suffix] of cases) {
        const error = yield* Effect.flip(fetchWith(client, url))
        assert.isTrue(error._tag.endsWith(suffix), `${url}: ${error._tag}`)
        if (url.includes("secret")) {
          assert.notInclude(JSON.stringify(error), "secret")
          assert.notInclude(error.message, "secret")
        }
      }
      assert.strictEqual(yield* Ref.get(calls), 0)
    })
  )

  it.effect("follows same-origin redirects and refuses cross-origin redirects", () =>
    Effect.gen(function* () {
      const paths = yield* Ref.make<Array<string>>([])
      const sameOrigin = HttpClient.make((request, url) =>
        Ref.update(paths, (all) => [...all, url.pathname]).pipe(
          Effect.as(
            url.pathname === "/start"
              ? response(request, null, {
                status: 302,
                headers: { location: "/final" }
              })
              : response(request, "done", {
                headers: { "content-type": "text/plain" }
              })
          )
        ))
      const result = yield* fetchWith(sameOrigin, "https://example.com/start")
      assert.strictEqual(result.finalUrl, "https://example.com/final")
      assert.deepStrictEqual(yield* Ref.get(paths), ["/start", "/final"])

      const crossCalls = yield* Ref.make(0)
      const crossOrigin = HttpClient.make((request) =>
        Ref.updateAndGet(crossCalls, (count) => count + 1).pipe(
          Effect.as(response(request, null, {
            status: 302,
            headers: { location: "https://other.example/final" }
          }))
        ))
      const error = yield* Effect.flip(
        fetchWith(crossOrigin, "https://example.com/start")
      )
      assert.strictEqual(
        error._tag,
        "@doeixd/effect-agent/web/WebFetchCrossOriginRedirectError"
      )
      if (error._tag === "@doeixd/effect-agent/web/WebFetchCrossOriginRedirectError") {
        assert.strictEqual(error.to, "https://other.example/final")
      }
      assert.strictEqual(yield* Ref.get(crossCalls), 1)
    })
  )

  it.effect("enforces the five-hop redirect cap without an automatic retry", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const client = HttpClient.make((request, url) =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.as(response(request, null, {
            status: 302,
            headers: { location: `/hop/${Number(url.pathname.split("/").at(-1) ?? "0") + 1}` }
          }))
        ))

      const error = yield* Effect.flip(
        fetchWith(client, "https://example.com/hop/0")
      )
      assert.strictEqual(
        error._tag,
        "@doeixd/effect-agent/web/WebFetchRedirectLimitError"
      )
      assert.strictEqual(yield* Ref.get(calls), HttpWebFetch.MAX_REDIRECTS + 1)

      const failedCalls = yield* Ref.make(0)
      const unavailable = HttpClient.make((request) =>
        Ref.updateAndGet(failedCalls, (count) => count + 1).pipe(
          Effect.as(response(request, "unavailable", { status: 503 }))
        ))
      const unavailableError = yield* Effect.flip(
        fetchWith(unavailable, "https://example.com/unavailable")
      )
      assert.strictEqual(
        unavailableError._tag,
        "@doeixd/effect-agent/web/WebFetchHttpResponseError"
      )
      assert.strictEqual(yield* Ref.get(failedCalls), 1)
    })
  )

  it.effect("rejects unsupported, advertised, streamed and malformed bodies", () =>
    Effect.gen(function* () {
      const binary = HttpClient.make((request) =>
        Effect.succeed(response(request, "pdf", {
          headers: { "content-type": "application/pdf" }
        })))
      const binaryError = yield* Effect.flip(fetchWith(binary, "https://example.com/a.pdf"))
      assert.strictEqual(
        binaryError._tag,
        "@doeixd/effect-agent/web/WebFetchUnsupportedContentTypeError"
      )

      const advertised = HttpClient.make((request) =>
        Effect.succeed(response(request, "small", {
          headers: {
            "content-type": "text/plain",
            "content-length": String(HttpWebFetch.MAX_RESPONSE_BYTES + 1)
          }
        })))
      const advertisedError = yield* Effect.flip(
        fetchWith(advertised, "https://example.com/large")
      )
      assert.strictEqual(
        advertisedError._tag,
        "@doeixd/effect-agent/web/WebFetchResponseTooLargeError"
      )

      const streamed = HttpClient.make((request) =>
        Effect.succeed(response(
          request,
          "x".repeat(HttpWebFetch.MAX_RESPONSE_BYTES + 1),
          { headers: { "content-type": "text/plain" } }
        )))
      const streamedError = yield* Effect.flip(
        fetchWith(streamed, "https://example.com/chunked")
      )
      assert.strictEqual(
        streamedError._tag,
        "@doeixd/effect-agent/web/WebFetchResponseTooLargeError"
      )

      const malformed = HttpClient.make((request) =>
        Effect.succeed(response(request, Uint8Array.of(0xff), {
          headers: { "content-type": "text/plain; charset=utf-8" }
        })))
      const malformedError = yield* Effect.flip(
        fetchWith(malformed, "https://example.com/text")
      )
      assert.strictEqual(
        malformedError._tag,
        "@doeixd/effect-agent/web/WebFetchDecodeError"
      )
    })
  )

  it.effect("times out the whole operation and interruption aborts HTTP", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const signal = yield* Deferred.make<AbortSignal>()
      const client = HttpClient.make((_request, _url, abortSignal) =>
        Deferred.succeed(signal, abortSignal).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Effect.never)
        ))

      const fiber = yield* Effect.forkChild(
        fetchWith(client, "https://example.com/slow")
      )
      yield* Deferred.await(started)
      yield* TestClock.adjust(Duration.millis(HttpWebFetch.TIMEOUT_MILLIS + 1))
      const error = yield* Effect.flip(Fiber.join(fiber))
      assert.strictEqual(
        error._tag,
        "@doeixd/effect-agent/web/WebFetchTimeoutError"
      )
      assert.isTrue((yield* Deferred.await(signal)).aborted)

      const interruptedSignal = yield* Deferred.make<AbortSignal>()
      const interrupted = HttpClient.make((_request, _url, abortSignal) =>
        Deferred.succeed(interruptedSignal, abortSignal).pipe(
          Effect.andThen(Effect.never)
        ))
      const interruptedFiber = yield* Effect.forkChild(
        fetchWith(interrupted, "https://example.com/interrupted")
      )
      const observed = yield* Deferred.await(interruptedSignal)
      yield* Fiber.interrupt(interruptedFiber)
      assert.isTrue(observed.aborted)
    })
  )
})
