import { assert, describe, it } from "@effect/vitest"
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Redacted,
  Ref
} from "effect"
import { TestClock } from "effect/testing"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "effect/unstable/http"
import type { Tracer } from "effect"
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


/**
 * Every span from the client callback up to the root, with its attributes.
 *
 * Captured *inside* the `HttpClient`, because the span at issue is the one
 * `HttpClient` creates for itself: an assertion made around the search never
 * sees the attribute it is looking for. Walking to the root rather than
 * checking one span, because a suppressed annotation that reappears on a
 * parent is the same leak.
 *
 * `ExternalSpan` ends the walk: it carries no attributes and no parent, so
 * there is nothing further to inspect.
 */
interface CapturedSpan {
  readonly name: string
  readonly attributes: ReadonlyMap<string, unknown>
}

const spanChain = (span: Tracer.Span): ReadonlyArray<CapturedSpan> => {
  const chain: Array<CapturedSpan> = []
  let current: Tracer.AnySpan | undefined = span
  while (current !== undefined && current._tag === "Span") {
    chain.push({ name: current.name, attributes: current.attributes })
    current = Option.getOrUndefined(current.parent)
  }
  return chain
}

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

  /**
   * R158 -- a redirect must not carry the API key onward.
   *
   * The adapter used to delegate redirect policy to whatever client was
   * injected. The documented production wiring follows redirects through
   * `globalThis.fetch`, which strips a small standard set of sensitive headers
   * across origins and leaves provider-specific ones like
   * `x-subscription-token` in place -- so a redirect sent the key to the
   * destination.
   *
   * The client here counts *physical* requests and records every host it was
   * asked to talk to, which is the only way to see a hop that a
   * redirect-following client would make invisibly.
   */
  it.effect("asks for manual redirects, and refuses the redirect it gets", () =>
    Effect.gen(function* () {
      const contacted = yield* Ref.make<ReadonlyArray<string>>([])
      const init = yield* Ref.make<Option.Option<RequestInit>>(Option.none())
      const client = HttpClient.make((request, url) =>
        Effect.gen(function* () {
          yield* Ref.update(contacted, (all) => [...all, url.origin])
          yield* Ref.set(init, yield* Effect.serviceOption(FetchHttpClient.RequestInit))
          return response(request, "", {
            status: 302,
            headers: { location: "https://evil.example/search" }
          })
        }))

      const error = yield* Effect.flip(searchWith(client, "Effect"))
      assert.strictEqual(
        error._tag,
        "@doeixd/effect-agent/web/WebSearchResponseError"
      )

      /**
       * The policy, not just the outcome.
       *
       * A mock client never follows a redirect, so "the second origin was not
       * contacted" holds whether or not the adapter asked for anything -- it
       * cannot tell a fixed provider from a broken one. What actually stops
       * the real transport is this service reaching `globalThis.fetch`, so
       * that is what is asserted.
       */
      const requested = yield* Ref.get(init)
      assert.isTrue(Option.isSome(requested), "no RequestInit was provided")
      if (Option.isSome(requested)) {
        assert.strictEqual(requested.value.redirect, "manual")
        assert.strictEqual(requested.value.credentials, "omit")
      }
      assert.deepStrictEqual(
        yield* Ref.get(contacted),
        ["https://api.search.brave.com"]
      )
    })
  )

  /**
   * R160 -- `Retry-After` is delta-seconds *or* an HTTP-date.
   *
   * Only the first form was parsed, so every valid date took the
   * "unparseable" branch and waited exactly two seconds -- including a date
   * already in the past, which asks for no wait at all. Driven with
   * `TestClock` so the assertion is about the delay chosen, not about how long
   * the test took.
   */
  const retryAfter = (header: string) =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const client = HttpClient.make((request) =>
        Effect.flatMap(
          Ref.updateAndGet(attempts, (count) => count + 1),
          (count) =>
            Effect.succeed(
              count === 1
                ? response(request, "", {
                  status: 429,
                  headers: { "retry-after": header }
                })
                : response(request, body(), {
                  status: 200,
                  headers: { "content-type": "application/json" }
                })
            )
        ))

      const fiber = yield* Effect.forkChild(searchWith(client, "Effect"))
      // Enough for the first attempt to run and be refused. Whether the
      // *second* has also happened by now is the thing each test is about, so
      // it is not asserted here.
      yield* TestClock.adjust(Duration.millis(1))
      return { fiber, attempts }
    })

  it.effect("waits no time at all for a Retry-After date already in the past", () =>
    Effect.gen(function* () {
      const { attempts, fiber } = yield* retryAfter(new Date(0).toUTCString())
      // Both attempts inside the first millisecond: a date that has passed
      // asks for no wait at all. Two seconds used to be spent here.
      assert.strictEqual(yield* Ref.get(attempts), 2)
      yield* Fiber.join(fiber)
    })
  )

  it.effect("honours a Retry-After date in the near future", () =>
    Effect.gen(function* () {
      const at = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      const { attempts, fiber } = yield* retryAfter(
        new Date(at + 1_000).toUTCString()
      )
      // The header asked for a second; a second is not yet up.
      yield* TestClock.adjust(Duration.millis(900))
      assert.strictEqual(yield* Ref.get(attempts), 1)
      yield* TestClock.adjust(Duration.millis(200))
      assert.strictEqual(yield* Ref.get(attempts), 2)
      yield* Fiber.join(fiber)
    })
  )

  it.effect("clamps a far-future Retry-After date to the two-second ceiling", () =>
    Effect.gen(function* () {
      const at = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      const { attempts, fiber } = yield* retryAfter(
        new Date(at + 5 * 60_000).toUTCString()
      )
      yield* TestClock.adjust(Duration.seconds(2))
      assert.strictEqual(yield* Ref.get(attempts), 2)
      yield* Fiber.join(fiber)
    })
  )

  /**
   * R159 -- what "at most one retry" actually guarantees.
   *
   * The wrapper retries once. It calls an already-composed `HttpClient`, so
   * middleware on that client can retry underneath and multiply the physical
   * requests -- each one resending the query and the key. This pins the real
   * contract rather than the one the plan claimed: two *logical* attempts, and
   * as many physical requests as the supplied client chooses to make.
   *
   * The narrower contract is stated on `make`; this is the test that keeps the
   * statement honest.
   */
  it.effect("bounds its own attempts, not a supplied client's", () =>
    Effect.gen(function* () {
      const physical = yield* Ref.make(0)
      const failing = HttpClient.make((request) =>
        Ref.update(physical, (count) => count + 1).pipe(
          Effect.as(response(request, "", { status: 503 }))
        ))
      // A client that retries twice underneath, as ordinary middleware might.
      // Middleware that talks to the server more than once per logical
      // request -- a retry policy, a mirror, a probe. A 503 is a *response*,
      // not an Effect failure, so this is written as repetition rather than
      // `Effect.retry`, which would have nothing to retry.
      const retrying = HttpClient.transformResponse(
        failing,
        (execute) => Effect.flatMap(execute, () => Effect.flatMap(execute, () => execute))
      )

      const error = yield* Effect.flip(searchWith(retrying, "Effect"))
      assert.strictEqual(
        error._tag,
        "@doeixd/effect-agent/web/WebSearchResponseError"
      )
      // Two logical attempts from the wrapper. The physical count is the
      // client's business, and it is larger.
      assert.isAbove(yield* Ref.get(physical), 2)
    })
  )

  /**
   * The query is user content, and `HttpClient` puts it on a span for free.
   *
   * `HttpClient` unconditionally annotates `url.full` and `url.query` on its
   * `http.client GET` span, and for a search the query string *is* the model's
   * search text. Redacting `x-subscription-token` does not touch it: that is a
   * header and this is the URL. `src/web/http.ts` already made this trade for
   * fetches; this pins that `brave.ts` makes it too.
   *
   * Falsified by removing `Effect.withTracerEnabled(false)` from `brave.ts`:
   * an `http.client GET` span appears in the chain carrying the query.
   */
  it.effect("never exports the model's search query on a span", () =>
    Effect.gen(function*() {
      const query = "how to appeal a denied benefits claim"
      const seen = yield* Ref.make<ReadonlyArray<CapturedSpan>>([])
      const client = HttpClient.make((request) =>
        Effect.flatMap(Effect.currentSpan, (span) =>
          Ref.set(seen, spanChain(span)).pipe(
            Effect.as(response(request, body()))
          )).pipe(Effect.orDie))

      const results = yield* searchWith(client, query)
      assert.strictEqual(results.length, 1)

      const spans = yield* Ref.get(seen)
      // The adapter's own span is still there -- suppression removes the
      // annotations, not the call's place in the trace.
      assert.isTrue(spans.some((span) => span.name === "BraveWebSearch.search"))
      for (const span of spans) {
        assert.isFalse(
          span.attributes.has("url.query"),
          `${span.name} carries url.query`
        )
        assert.isFalse(
          span.attributes.has("url.full"),
          `${span.name} carries url.full`
        )
        for (const [key, value] of span.attributes) {
          assert.isFalse(
            typeof value === "string" && value.includes("appeal"),
            `${span.name}.${key} carries the search text`
          )
        }
      }
    })
  )

})
