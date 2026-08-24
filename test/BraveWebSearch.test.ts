import { assert, describe, it } from "@effect/vitest"
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Redacted,
  Ref
} from "effect"
import { TestClock } from "effect/testing"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "effect/unstable/http"
import * as BraveWebSearch from "../src/web/brave.js"
import { WebSearch } from "../src/web/index.js"

const secret = "brave-secret-value"
const options = { apiKey: Redacted.make(secret) }

const body = (title = "Effect") => JSON.stringify({
  web: {
    results: [
      {
        title,
        url: "https://effect.website/docs",
        description: "Current Effect documentation."
      }
    ]
  }
})

const response = (
  request: HttpClientRequest.HttpClientRequest,
  content: string,
  init?: ResponseInit | undefined
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(request, new Response(content, init))

const provider = (client: HttpClient.HttpClient) =>
  BraveWebSearch.layer(options).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient)(client))
  )

const searchWith = (
  client: HttpClient.HttpClient,
  query: string,
  searchOptions?: WebSearch.SearchOptions | undefined
) =>
  Effect.flatMap(WebSearch.WebSearch, (service) =>
    service.search(query, searchOptions)).pipe(
      Effect.provide(provider(client))
    )

describe("Brave web search provider", () => {
  it.effect("uses the fixed endpoint, maps neutral options, redacts auth and decodes results", () =>
    Effect.gen(function* () {
      const inspectedHeaders = yield* Ref.make("")
      const client = HttpClient.make((request, url) =>
        Effect.gen(function* () {
          assert.strictEqual(url.origin, "https://api.search.brave.com")
          assert.strictEqual(url.pathname, "/res/v1/web/search")
          assert.strictEqual(url.searchParams.get("q"), "Effect HttpClient")
          assert.strictEqual(url.searchParams.get("count"), "3")
          assert.strictEqual(url.searchParams.get("freshness"), "pw")
          assert.strictEqual(request.headers["x-subscription-token"], secret)
          yield* Ref.set(inspectedHeaders, JSON.stringify(request.headers))
          return response(request, body(), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        }))

      const results = yield* searchWith(client, "Effect HttpClient", {
        limit: 3,
        freshness: "week"
      })

      assert.deepStrictEqual(results, [
        {
          title: "Effect",
          url: "https://effect.website/docs",
          snippet: "Current Effect documentation."
        }
      ])
      assert.notInclude(yield* Ref.get(inspectedHeaders), secret)
    })
  )

  it.effect("uses the documented default and hard maximum result counts", () =>
    Effect.gen(function* () {
      const counts = yield* Ref.make<Array<string | null>>([])
      const client = HttpClient.make((request, url) =>
        Ref.update(counts, (all) => [...all, url.searchParams.get("count")]).pipe(
          Effect.as(response(request, body()))
        ))

      yield* searchWith(client, "default")
      yield* searchWith(client, "clamped", { limit: 100 })

      assert.deepStrictEqual(yield* Ref.get(counts), ["8", "10"])
    })
  )

  it.effect("rejects advertised and actual body overflow before decoding", () =>
    Effect.gen(function* () {
      const advertised = HttpClient.make((request) =>
        Effect.succeed(
          response(request, "{}", {
            headers: {
              "content-length": String(BraveWebSearch.MAX_RESPONSE_BYTES + 1)
            }
          })
        ))
      const advertisedError = yield* Effect.flip(searchWith(advertised, "large"))
      assert.strictEqual(
        advertisedError._tag,
        "@doeixd/effect-agent/web/WebSearchResponseTooLargeError"
      )
      if (
        advertisedError._tag ===
          "@doeixd/effect-agent/web/WebSearchResponseTooLargeError"
      ) {
        assert.strictEqual(
          advertisedError.observedBytes,
          BraveWebSearch.MAX_RESPONSE_BYTES + 1
        )
      }

      const actual = HttpClient.make((request) =>
        Effect.succeed(
          response(request, "x".repeat(BraveWebSearch.MAX_RESPONSE_BYTES + 1))
        ))
      const actualError = yield* Effect.flip(searchWith(actual, "large"))
      assert.strictEqual(
        actualError._tag,
        "@doeixd/effect-agent/web/WebSearchResponseTooLargeError"
      )
    })
  )

  it.effect("rejects malformed provider data without echoing it into the error", () =>
    Effect.gen(function* () {
      const sensitiveMalformedBody = "not-json secret page content"
      const client = HttpClient.make((request) =>
        Effect.succeed(response(request, sensitiveMalformedBody)))

      const error = yield* Effect.flip(searchWith(client, "malformed"))
      assert.strictEqual(
        error._tag,
        "@doeixd/effect-agent/web/WebSearchDecodeError"
      )
      assert.notInclude(error.message, sensitiveMalformedBody)
    })
  )

  it.effect("retries a 429 once and never retries authentication", () =>
    Effect.gen(function* () {
      const rateCalls = yield* Ref.make(0)
      const rateLimited = HttpClient.make((request) =>
        Ref.updateAndGet(rateCalls, (n) => n + 1).pipe(
          Effect.map((attempt) =>
            attempt === 1
              ? response(request, "", {
                status: 429,
                headers: { "retry-after": "0" }
              })
              : response(request, body("retried")))
        ))
      const results = yield* searchWith(rateLimited, "retry")
      assert.strictEqual(results[0]?.title, "retried")
      assert.strictEqual(yield* Ref.get(rateCalls), 2)

      const authCalls = yield* Ref.make(0)
      const unauthorized = HttpClient.make((request) =>
        Ref.updateAndGet(authCalls, (n) => n + 1).pipe(
          Effect.as(response(request, "", { status: 401 }))
        ))
      const authError = yield* Effect.flip(searchWith(unauthorized, "auth"))
      assert.strictEqual(
        authError._tag,
        "@doeixd/effect-agent/web/WebSearchAuthenticationError"
      )
      assert.strictEqual(yield* Ref.get(authCalls), 1)
    })
  )

  it.effect("times out request plus body consumption and interrupts the HTTP request", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const signal = yield* Deferred.make<AbortSignal>()
      const client = HttpClient.make((_request, _url, abortSignal) =>
        Deferred.succeed(signal, abortSignal).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Effect.never)
        ))

      const fiber = yield* Effect.forkChild(searchWith(client, "timeout"))
      yield* Deferred.await(started)
      yield* TestClock.adjust(Duration.millis(BraveWebSearch.TIMEOUT_MILLIS + 1))
      const error = yield* Effect.flip(Fiber.join(fiber))

      assert.strictEqual(
        error._tag,
        "@doeixd/effect-agent/web/WebSearchTimeoutError"
      )
      assert.isTrue((yield* Deferred.await(signal)).aborted)
    })
  )

  it.effect("caller interruption aborts an in-flight HTTP request", () =>
    Effect.gen(function* () {
      const signal = yield* Deferred.make<AbortSignal>()
      const client = HttpClient.make((_request, _url, abortSignal) =>
        Deferred.succeed(signal, abortSignal).pipe(Effect.andThen(Effect.never)))

      const fiber = yield* Effect.forkChild(searchWith(client, "interrupt"))
      const observed = yield* Deferred.await(signal)
      yield* Fiber.interrupt(fiber)

      assert.isTrue(observed.aborted)
    })
  )

  it.effect("shares one four-request concurrency gate per provider Layer", () =>
    Effect.gen(function* () {
      const active = yield* Ref.make(0)
      const entered = yield* Ref.make(0)
      const peak = yield* Ref.make(0)
      const fourEntered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const client = HttpClient.make((request) =>
        Effect.acquireUseRelease(
          Effect.gen(function* () {
            const now = yield* Ref.updateAndGet(active, (n) => n + 1)
            yield* Ref.update(peak, (n) => Math.max(n, now))
            yield* Ref.update(entered, (n) => n + 1)
            if (now === BraveWebSearch.MAX_CONCURRENT) {
              yield* Deferred.succeed(fourEntered, undefined)
            }
          }),
          () => Deferred.await(release).pipe(Effect.as(response(request, body()))),
          () => Ref.update(active, (n) => n - 1)
        ))

      const all = Effect.gen(function* () {
        const service = yield* WebSearch.WebSearch
        return yield* Effect.forEach(
          [1, 2, 3, 4, 5],
          (n) => service.search(`query ${n}`),
          { concurrency: "unbounded" }
        )
      }).pipe(Effect.provide(provider(client)))

      const fiber = yield* Effect.forkChild(all)
      yield* Deferred.await(fourEntered)
      assert.strictEqual(yield* Ref.get(active), 4)
      assert.strictEqual(yield* Ref.get(entered), 4)
      yield* Deferred.succeed(release, undefined)
      const results = yield* Fiber.join(fiber)

      assert.strictEqual(results.length, 5)
      assert.strictEqual(yield* Ref.get(entered), 5)
      assert.strictEqual(yield* Ref.get(peak), 4)
      assert.strictEqual(yield* Ref.get(active), 0)
    })
  )
})
