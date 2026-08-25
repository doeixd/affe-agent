import { assert, describe, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Fiber, Layer, Option, Ref } from "effect"
import { TestClock } from "effect/testing"
import {
  HttpClient,
  HttpClientError,
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


/**
 * Every span from the client callback up to the root, with its attributes.
 *
 * Captured inside the HttpClient rather than around the fetch, because the
 * span at issue is the one `HttpClient` creates for itself: an assertion made
 * outside it never sees the attribute it is looking for.
 */
const spanChain = (span: unknown): ReadonlyArray<{
  readonly name: string
  readonly attributes: Readonly<Record<string, unknown>>
}> => {
  const spans: Array<{ name: string; attributes: Readonly<Record<string, unknown>> }> = []
  let current: any = span
  while (current !== undefined) {
    spans.push({
      name: current.name,
      attributes: Object.fromEntries(current.attributes ?? new Map())
    })
    current = current.parent !== undefined && Option.isSome(current.parent)
      ? current.parent.value
      : undefined
  }
  return spans
}

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
        // The origin, not the path. Origin is the granularity the permission
        // decision is made at, so it is what a caller needs to ask again for
        // -- and a redirect path is server-controlled text that can carry a
        // token, which is exactly what these errors must not copy.
        assert.strictEqual(error.to, "https://other.example")
        assert.strictEqual(error.from, "https://example.com")
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

  /**
   * R143/R120 -- a model-selected URL is content, not metadata.
   *
   * The path, the query and the fragment are where an API key, a session
   * token or a private document id live, and both a tagged error and a trace
   * are things a caller is expected to keep. This drives one secret through
   * every failure the provider can raise and scans the encoded error, its
   * message and the whole span chain for it.
   *
   * Falsified by putting `current.href` back in any one error, or by removing
   * `Effect.withTracerEnabled(false)` around the execution: the client's own
   * `url.full` attribute reappears with the secret in it.
   */
  it.effect("never copies a target's path, query or fragment into an error or a span", () =>
    Effect.gen(function* () {
      const SECRET = "s3cr3t-in-the-url"
      const target =
        `https://example.com/private/${SECRET}?token=${SECRET}#${SECRET}`

      const seen = yield* Ref.make<ReadonlyArray<{
        readonly name: string
        readonly attributes: Readonly<Record<string, unknown>>
      }>>([])

      const respondWith = (
        init: ResponseInit,
        content: string | Uint8Array | null = "body"
      ) =>
        HttpClient.make((request) =>
          Effect.flatMap(Effect.currentSpan, (span) =>
            Ref.set(seen, spanChain(span)).pipe(
              Effect.as(response(request, content, init))
            )).pipe(Effect.orDie))

      // One per failure path that names a target.
      const failures = [
        // An HTTP status.
        yield* Effect.flip(fetchWith(respondWith({ status: 500 }), target)),
        // A redirect with no destination.
        yield* Effect.flip(fetchWith(
          respondWith({ status: 302 }),
          target
        )),
        // A destination that does not parse.
        yield* Effect.flip(fetchWith(
          respondWith({ status: 302, headers: { location: "http://[::" } }),
          target
        )),
        // A content type that is not text.
        yield* Effect.flip(fetchWith(
          respondWith({ status: 200, headers: { "content-type": "image/png" } }),
          target
        )),
        // A body larger than the cap admits.
        yield* Effect.flip(fetchWith(
          respondWith({
            status: 200,
            headers: { "content-type": "text/plain", "content-length": "999999999" }
          }),
          target
        )),
        // A body that is not text for its declared charset.
        yield* Effect.flip(fetchWith(
          respondWith(
            { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
            new Uint8Array([0xff, 0xfe, 0xfd])
          ),
          target
        )),
        // A transport-level failure.
        yield* Effect.flip(fetchWith(
          HttpClient.make((request) =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  description: "no route"
                })
              })
            )),
          target
        ))
      ]

      for (const failure of failures) {
        const rendered = JSON.stringify(failure, Object.getOwnPropertyNames(Object(failure)))
        assert.isFalse(
          rendered.includes(SECRET),
          `a failure carried the secret: ${rendered}`
        )
        assert.isFalse(
          String((failure as { message?: unknown }).message ?? "").includes(SECRET)
        )
      }

      // And the trace. `url.full` is the attribute the HTTP client writes
      // unconditionally; the assertion is over every attribute of every span,
      // because naming one is a filter that the next release can outgrow.
      const chain = yield* Ref.get(seen)
      assert.isAbove(chain.length, 0, "no span was captured")
      for (const span of chain) {
        for (const [key, value] of Object.entries(span.attributes)) {
          assert.isFalse(
            JSON.stringify(value ?? null).includes(SECRET),
            `span ${span.name} leaked the secret through ${key}`
          )
        }
      }
    })
  )

  /**
   * R154 -- an "allow" policy is a permission decision, not a resource limit.
   *
   * The default tool strategy runs a model response's calls in parallel with
   * no bound, so twenty `web_fetch` calls used to open twenty requests at
   * once, each holding a megabyte of body budget and its redirect chain for
   * the whole timeout.
   *
   * The latch is what makes this an assertion rather than a race: every
   * request blocks until it is opened, so the peak concurrency observed is
   * the provider's bound and not a scheduling accident.
   */
  it.effect("admits no more fetches at once than its bound", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const live = yield* Ref.make(0)
      const peak = yield* Ref.make(0)
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          const now = yield* Ref.updateAndGet(live, (n) => n + 1)
          yield* Ref.update(peak, (high) => Math.max(high, now))
          yield* Deferred.await(gate)
          yield* Ref.update(live, (n) => n - 1)
          return response(request, "ok", {
            status: 200,
            headers: { "content-type": "text/plain" }
          })
        }))

      const all = yield* Effect.forkChild(
        Effect.all(
          Array.from({ length: 20 }, (_, index) =>
            Effect.flatMap(WebFetch.WebFetch, (service) =>
              service.fetch(new URL(`https://example.com/${index}`)))),
          { concurrency: "unbounded" }
        ).pipe(Effect.provide(provider(client)))
      )

      // Let every admitted request reach the client and stop there.
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      assert.strictEqual(yield* Ref.get(live), HttpWebFetch.MAX_CONCURRENT)

      yield* Deferred.succeed(gate, undefined)
      const results = yield* Fiber.join(all)
      assert.strictEqual(results.length, 20)
      assert.strictEqual(
        yield* Ref.get(peak),
        HttpWebFetch.MAX_CONCURRENT,
        "more requests were in flight than the bound allows"
      )
    })
  )

  /**
   * And the permit comes back however the fetch ends. A permit leaked on a
   * failure path is worse than no bound at all: the provider works until the
   * fourth failure and then stops answering forever.
   *
   * One client and one provider throughout -- a fresh `provider(...)` per
   * phase would build a fresh semaphore, and the test would pass however
   * badly permits leaked. Behaviour is chosen by path instead.
   */
  it.effect("returns its permit after a failure, and after an interruption", () =>
    Effect.gen(function* () {
      const stuck = yield* Deferred.make<void>()
      const client = HttpClient.make((request, url) => {
        if (url.pathname.startsWith("/fail")) {
          return Effect.succeed(response(request, "", { status: 500 }))
        }
        if (url.pathname.startsWith("/held")) {
          return Effect.as(
            Deferred.await(stuck),
            response(request, "", { status: 200 })
          )
        }
        return Effect.succeed(response(request, "fine", {
          status: 200,
          headers: { "content-type": "text/plain" }
        }))
      })

      yield* Effect.gen(function* () {
        const service = yield* WebFetch.WebFetch
        const each = Array.from(
          { length: HttpWebFetch.MAX_CONCURRENT },
          (_, index) => index
        )

        // Exactly the bound in failures: a permit lost per failure exhausts it.
        yield* Effect.forEach(
          each,
          (index) => Effect.flip(service.fetch(new URL(`https://example.com/fail/${index}`))),
          { discard: true }
        )

        // And the bound again in fetches interrupted while holding a permit.
        const held = yield* Effect.forkChild(
          Effect.all(
            each.map((index) => service.fetch(new URL(`https://example.com/held/${index}`))),
            { concurrency: "unbounded" }
          )
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(held)

        // Still serving. If any of those eight permits were lost, this hangs.
        const after = yield* service.fetch(new URL("https://example.com/after"))
        assert.strictEqual(after.body, "fine")
      }).pipe(Effect.provide(provider(client)))
    })
  )

  /**
   * R114/R26 -- what the abstract layer can and cannot promise.
   *
   * Two properties depend on behaviour that is not in the `HttpClient`
   * contract: that a redirect is *visible* to the provider, and that no
   * ambient credential is attached to a model-selected origin. A supplied
   * client can break both, and no amount of care inside the provider changes
   * that -- so the fix is a wiring that owns its transport, and a test that
   * states which layer carries which guarantee.
   *
   * This is deliberately a demonstration of the gap, not a claim that it is
   * closed: it is what stops the documentation from drifting back into
   * claiming `layer` is a boundary against your own client.
   */
  it.effect("an authenticated client reaches the target through the abstract layer", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<Record<string, string>>({})
      const injecting = HttpClient.mapRequest(
        HttpClient.make((request) =>
          Ref.set(sent, { ...request.headers }).pipe(
            Effect.as(response(request, "ok", {
              status: 200,
              headers: { "content-type": "text/plain" }
            }))
          )),
        HttpClientRequest.setHeader("authorization", "Bearer ambient-token")
      )

      yield* fetchWith(injecting, "https://example.com/page")
      // The provider builds a request with `accept` and nothing else; the
      // header is the client's, and it went out.
      assert.strictEqual(
        (yield* Ref.get(sent))["authorization"],
        "Bearer ambient-token"
      )
    })
  )

  it.effect("the transport-owning layer has no seam for one to arrive through", () => {
    /**
     * A type-level assertion, because that is where this guarantee lives:
     * `layerFetch` requires nothing, so there is no `HttpClient` an
     * application could substitute. A value assertion would need the network.
     */
    const owned: Layer.Layer<WebFetch.WebFetch, never, never> =
      HttpWebFetch.layerFetch
    return Effect.sync(() => {
      assert.isDefined(owned)
    })
  })
})
