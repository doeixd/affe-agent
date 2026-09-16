import { assert, describe, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Fiber, Layer, Option, Redacted, Ref } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Permission from "../src/Permission.js"
import { TestLanguageModel, TestWebCapture } from "../src/testing/index.js"
import * as CloudflareWebCapture from "../src/web/cloudflare.js"
import { WebCapture, WebCrawl, WebToolkit } from "../src/web/index.js"

/**
 * The Cloudflare Browser Rendering provider, against a scripted
 * `HttpClient` as the Brave test drives its provider: no account, no
 * network, every bound at its boundary.
 */

const accountId = "acct-123"
const token = "cf-secret-token"
const options = { accountId, apiToken: Redacted.make(token) }

const envelope = (result: unknown) => JSON.stringify({ success: true, result, errors: [] })

const response = (
  request: HttpClientRequest.HttpClientRequest,
  content: string,
  init?: ResponseInit | undefined
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(request, new Response(content, init))

const captureWith = (client: HttpClient.HttpClient, url: string) =>
  Effect.flatMap(WebCapture.WebCapture, (service) => service.capture(new URL(url))).pipe(
    Effect.provide(CloudflareWebCapture.layer(options).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient)(client))))
  )

describe("Cloudflare web capture provider", () => {
  it.effect("posts the target to both endpoints under the account, with a redacted bearer token", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<Array<{ path: string; body: string; auth: string | undefined; headers: string }>>([])
      const client = HttpClient.make((request, url) =>
        Effect.gen(function* () {
          const body = yield* Effect.promise(() =>
            new Response(request.body._tag === "Uint8Array" ? request.body.body : "").text())
          yield* Ref.update(calls, (all) => [...all, {
            path: url.pathname,
            body,
            auth: request.headers.authorization,
            headers: JSON.stringify(request.headers)
          }])
          return response(
            request,
            url.pathname.endsWith("/markdown") ? envelope("# Hello") : envelope(["https://example.com/a", "https://example.com/a", "https://other.example/b"]),
            { status: 200 }
          )
        }))
      const result = yield* captureWith(client, "https://example.com/page#section")
      assert.strictEqual(result.url, "https://example.com/page")
      assert.strictEqual(result.markdown, "# Hello")
      // Deduplicated, and cross-host links are returned (the crawler decides what to follow).
      assert.deepStrictEqual(result.links, ["https://example.com/a", "https://other.example/b"])
      const seen = yield* Ref.get(calls)
      assert.deepStrictEqual(seen.map((c) => c.path).sort(), [
        `/client/v4/accounts/${accountId}/browser-rendering/links`,
        `/client/v4/accounts/${accountId}/browser-rendering/markdown`
      ])
      for (const call of seen) {
        assert.deepStrictEqual(JSON.parse(call.body), { url: "https://example.com/page" })
        assert.strictEqual(call.auth, `Bearer ${token}`)
        // Redacted where headers are rendered.
        assert.notInclude(call.headers, token)
      }
    })
  )

  it.effect("refuses the targets the fetch provider refuses, before any request", () =>
    Effect.gen(function* () {
      const requests = yield* Ref.make(0)
      const client = HttpClient.make((request) =>
        Ref.update(requests, (n) => n + 1).pipe(Effect.as(response(request, envelope("x")))))
      for (const [url, tag] of [
        ["http://localhost/admin", "affe-agent/web/WebCaptureDeniedTargetError"],
        ["http://169.254.169.254/latest", "affe-agent/web/WebCaptureDeniedTargetError"],
        ["ftp://example.com/x", "affe-agent/web/WebCaptureInvalidUrlError"],
        ["https://user:pw@example.com/x", "affe-agent/web/WebCaptureInvalidUrlError"]
      ] as const) {
        const error = yield* Effect.flip(captureWith(client, url))
        assert.strictEqual(error._tag, tag, url)
        // The error names the origin, never the path.
        assert.notInclude(error.message, "/admin")
        assert.notInclude(error.message, "pw@")
      }
      assert.strictEqual(yield* Ref.get(requests), 0)
    })
  )

  it.effect("maps 401/403, 429 and other statuses to their own errors", () =>
    Effect.gen(function* () {
      const status = (code: number) =>
        HttpClient.make((request) => Effect.succeed(response(request, "", { status: code })))
      assert.strictEqual(
        (yield* Effect.flip(captureWith(status(401), "https://example.com/")))._tag,
        "affe-agent/web/WebCaptureAuthenticationError"
      )
      assert.strictEqual(
        (yield* Effect.flip(captureWith(status(429), "https://example.com/")))._tag,
        "affe-agent/web/WebCaptureRateLimitedError"
      )
      const other = yield* Effect.flip(captureWith(status(502), "https://example.com/"))
      assert.strictEqual(other._tag, "affe-agent/web/WebCaptureResponseError")
      if (other._tag === "affe-agent/web/WebCaptureResponseError") {
        assert.strictEqual(other.status, 502)
      }
    })
  )

  it.effect("a provider-reported failure keeps its codes and drops its text", () =>
    Effect.gen(function* () {
      // The provider's message can quote the rendered page, so it is exactly
      // what must not reach an error that gets logged.
      const quoted = "render failed near 'account 4417 balance'"
      const client = HttpClient.make((request) =>
        Effect.succeed(response(
          request,
          JSON.stringify({ success: false, errors: [{ code: 1001, message: quoted }, { message: "no code" }] }),
          { status: 200, headers: { "cf-ray": "8f1e2d3c4b5a6978-IAD" } }
        )))
      const error = yield* Effect.flip(captureWith(client, "https://example.com/"))
      assert.strictEqual(error._tag, "affe-agent/web/WebCaptureResponseError")
      if (error._tag === "affe-agent/web/WebCaptureResponseError") {
        assert.strictEqual(error.detail, "the provider reported failure (provider codes 1001)")
        assert.deepStrictEqual(error.navigationTimeoutMillis, Option.none())
        assert.deepStrictEqual(error.rayId, Option.some("8f1e2d3c4b5a6978-IAD"))
        assert.notInclude(error.message, "4417")
      }
    })
  )

  it.effect("a navigation timeout on an error status is reported as the renderer's limit", () =>
    Effect.gen(function* () {
      const body = (message: string, code = 6002) => JSON.stringify({ success: false, errors: [{ code, message }] })
      const withBody = (text: string) =>
        HttpClient.make((request) => Effect.succeed(response(request, text, { status: 422 })))

      const timedOut = yield* Effect.flip(captureWith(withBody(body("Navigation timeout of 30000 ms exceeded")), "https://example.com/"))
      assert.strictEqual(timedOut._tag, "affe-agent/web/WebCaptureResponseError")
      if (timedOut._tag === "affe-agent/web/WebCaptureResponseError") {
        assert.strictEqual(timedOut.status, 422)
        assert.deepStrictEqual(timedOut.navigationTimeoutMillis, Option.some(30000))
        assert.strictEqual(timedOut.detail, "the provider's page navigation timed out after 30000ms")
      }

      // Recognised by code and exact wording together; near misses are codes only.
      for (const near of [
        body("Navigation timeout of 30000 ms exceeded; see https://page.example/secret"),
        body("Navigation timeout of 30000 ms exceeded", 6003),
        "not json at all"
      ]) {
        const error = yield* Effect.flip(captureWith(withBody(near), "https://example.com/"))
        assert.strictEqual(error._tag, "affe-agent/web/WebCaptureResponseError")
        if (error._tag === "affe-agent/web/WebCaptureResponseError") {
          assert.deepStrictEqual(error.navigationTimeoutMillis, Option.none(), near)
          assert.notInclude(error.message, "secret")
        }
      }
    })
  )

  it.effect("a failure envelope with a null result retains its diagnostics", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) => Effect.succeed(response(request, JSON.stringify({
        success: false,
        result: null,
        errors: [{ code: 6002, message: "Navigation timeout of 30000 ms exceeded" }]
      }), { headers: { "cf-ray": "8f1e2d3c4b5a6978-IAD" } })))
      const error = yield* Effect.flip(captureWith(client, "https://example.com/"))
      assert.strictEqual(error._tag, "affe-agent/web/WebCaptureResponseError")
      if (error._tag === "affe-agent/web/WebCaptureResponseError") {
        assert.deepStrictEqual(error.navigationTimeoutMillis, Option.some(30_000))
        assert.deepStrictEqual(error.rayId, Option.some("8f1e2d3c4b5a6978-IAD"))
      }
    })
  )

  it.effect("a rate limit carries the provider's retry-after, as seconds or a date", () =>
    Effect.gen(function* () {
      const limited = (retryAfter: string) =>
        HttpClient.make((request) =>
          Effect.succeed(response(request, "", { status: 429, headers: { "retry-after": retryAfter, "cf-ray": "not a ray id!" } })))
      const retryOf = (retryAfter: string) =>
        Effect.flip(captureWith(limited(retryAfter), "https://example.com/")).pipe(
          Effect.map((error) => error._tag === "affe-agent/web/WebCaptureRateLimitedError" ? error : undefined)
        )

      const seconds = yield* retryOf("7")
      assert.deepStrictEqual(seconds?.retryAfterMillis, Option.some(7000))
      // A header that is not a ray id is not repeated.
      assert.deepStrictEqual(seconds?.rayId, Option.none())
      // The test clock stands at the epoch, so this date is ten seconds out.
      assert.deepStrictEqual((yield* retryOf("Thu, 01 Jan 1970 00:00:10 GMT"))?.retryAfterMillis, Option.some(10_000))
      assert.deepStrictEqual((yield* retryOf("soon"))?.retryAfterMillis, Option.none())
      assert.deepStrictEqual((yield* retryOf("999999999"))?.retryAfterMillis, Option.some(86_400_000))
      assert.deepStrictEqual((yield* retryOf("0000000007"))?.retryAfterMillis, Option.some(7000))
      assert.deepStrictEqual((yield* retryOf("1000000000"))?.retryAfterMillis, Option.some(86_400_000))
      assert.deepStrictEqual((yield* retryOf("9".repeat(400)))?.retryAfterMillis, Option.some(86_400_000))
    })
  )

  it.effect("rejects advertised and actual body overflow, and never echoes a malformed body", () =>
    Effect.gen(function* () {
      const advertised = HttpClient.make((request) =>
        Effect.succeed(response(request, "{}", { headers: { "content-length": String(CloudflareWebCapture.MAX_RESPONSE_BYTES + 1) } })))
      assert.strictEqual(
        (yield* Effect.flip(captureWith(advertised, "https://example.com/")))._tag,
        "affe-agent/web/WebCaptureResponseTooLargeError"
      )
      const actual = HttpClient.make((request) =>
        Effect.succeed(response(request, "x".repeat(CloudflareWebCapture.MAX_RESPONSE_BYTES + 1))))
      assert.strictEqual(
        (yield* Effect.flip(captureWith(actual, "https://example.com/")))._tag,
        "affe-agent/web/WebCaptureResponseTooLargeError"
      )
      const secret = "not-json secret page content"
      const malformed = HttpClient.make((request) => Effect.succeed(response(request, secret, { status: 200 })))
      const error = yield* Effect.flip(captureWith(malformed, "https://example.com/"))
      assert.strictEqual(error._tag, "affe-agent/web/WebCaptureDecodeError")
      assert.notInclude(error.message, secret)
    })
  )

  it.effect("times out on the provider's whole operation, on Effect's clock", () =>
    Effect.gen(function* () {
      const never = yield* Deferred.make<never>()
      const hanging = HttpClient.make(() => Deferred.await(never))
      const attempt = yield* Effect.forkChild(Effect.flip(captureWith(hanging, "https://example.com/")))
      yield* TestClock.adjust(Duration.millis(CloudflareWebCapture.TIMEOUT_MILLIS + 1))
      const error = yield* Fiber.join(attempt)
      assert.strictEqual(error._tag, "affe-agent/web/WebCaptureTimeoutError")
    })
  )

  it.effect("the web_capture tool delimits the rendering as untrusted and turns failures into instructions", () =>
    Effect.gen(function* () {
      const pages = TestWebCapture.layer({
        "https://example.com/": { url: "https://example.com/", markdown: "# Home", links: ["https://example.com/about"] }
      })
      const { layer: model } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "c1", name: "web_capture", params: { url: "https://example.com/" } }] },
        { toolCalls: [{ id: "c2", name: "web_capture", params: { url: "https://example.com/missing" } }] },
        TestLanguageModel.text("done")
      ])
      const agent = Agent.make({
        toolkit: WebToolkit.renderedToolkit(),
        permission: Permission.allowAll,
        loop: AgentLoop.bounded(4)
      })
      const { history, result } = yield* Effect.gen(function* () {
        const session = yield* AgentSession.make(agent)
        const result = yield* session.prompt("go")
        return { result, history: yield* session.history }
      }).pipe(
        Effect.provide(Layer.mergeAll(model, pages, WebCrawl.layer.pipe(Layer.provide(pages)))),
        Effect.scoped
      )
      assert.strictEqual(result.text, "done")
      const transcript = JSON.stringify(history)
      assert.include(transcript, "BEGIN UNTRUSTED WEB CONTENT FROM https://example.com/")
      assert.include(transcript, "Web capture failed with HTTP 404")
    })
  )

  it.effect("the web_capture tool tells the model a navigation timeout and a retry wait, not a status", () =>
    Effect.gen(function* () {
      const slow = new WebCapture.WebCaptureResponseError({
        url: "https://example.com",
        status: 422,
        detail: "the provider's page navigation timed out after 30000ms",
        navigationTimeoutMillis: Option.some(30000),
        rayId: Option.some("8f1e2d3c4b5a6978-IAD")
      })
      const busy = new WebCapture.WebCaptureRateLimitedError({
        url: "https://example.com",
        retryAfterMillis: Option.some(7000),
        rayId: Option.none()
      })
      const pages = WebCapture.layer({
        capture: (url) => Effect.fail(url.pathname === "/busy" ? busy : slow)
      })
      const { layer: model } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "c1", name: "web_capture", params: { url: "https://example.com/slow" } }] },
        { toolCalls: [{ id: "c2", name: "web_capture", params: { url: "https://example.com/busy" } }] },
        TestLanguageModel.text("done")
      ])
      const agent = Agent.make({
        toolkit: WebToolkit.renderedToolkit(),
        permission: Permission.allowAll,
        loop: AgentLoop.bounded(4)
      })
      const history = yield* Effect.gen(function* () {
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("go")
        return yield* session.history
      }).pipe(
        Effect.provide(Layer.mergeAll(model, pages, WebCrawl.layer.pipe(Layer.provide(pages)))),
        Effect.scoped
      )
      const transcript = JSON.stringify(history)
      assert.include(transcript, "Web capture timed out loading the page after 30000ms")
      assert.notInclude(transcript, "HTTP 422")
      assert.include(transcript, "the provider asked for 7s")
      // The ray id is for the operator, not the model.
      assert.notInclude(transcript, "8f1e2d3c4b5a6978")
    })
  )
})

