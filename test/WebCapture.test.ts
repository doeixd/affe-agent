import { assert, describe, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Fiber, Layer, Redacted, Ref } from "effect"
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
        ["http://localhost/admin", "@doeixd/effect-agent/web/WebCaptureDeniedTargetError"],
        ["http://169.254.169.254/latest", "@doeixd/effect-agent/web/WebCaptureDeniedTargetError"],
        ["ftp://example.com/x", "@doeixd/effect-agent/web/WebCaptureInvalidUrlError"],
        ["https://user:pw@example.com/x", "@doeixd/effect-agent/web/WebCaptureInvalidUrlError"]
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
        "@doeixd/effect-agent/web/WebCaptureAuthenticationError"
      )
      assert.strictEqual(
        (yield* Effect.flip(captureWith(status(429), "https://example.com/")))._tag,
        "@doeixd/effect-agent/web/WebCaptureRateLimitedError"
      )
      const other = yield* Effect.flip(captureWith(status(502), "https://example.com/"))
      assert.strictEqual(other._tag, "@doeixd/effect-agent/web/WebCaptureResponseError")
      if (other._tag === "@doeixd/effect-agent/web/WebCaptureResponseError") {
        assert.strictEqual(other.status, 502)
      }
    })
  )

  it.effect("a provider-reported failure is a response error carrying the provider's message", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(response(request, JSON.stringify({ success: false, errors: [{ message: "render failed: navigation timeout" }] }), { status: 200 })))
      const error = yield* Effect.flip(captureWith(client, "https://example.com/"))
      assert.strictEqual(error._tag, "@doeixd/effect-agent/web/WebCaptureResponseError")
      if (error._tag === "@doeixd/effect-agent/web/WebCaptureResponseError") {
        assert.include(error.detail, "navigation timeout")
      }
    })
  )

  it.effect("rejects advertised and actual body overflow, and never echoes a malformed body", () =>
    Effect.gen(function* () {
      const advertised = HttpClient.make((request) =>
        Effect.succeed(response(request, "{}", { headers: { "content-length": String(CloudflareWebCapture.MAX_RESPONSE_BYTES + 1) } })))
      assert.strictEqual(
        (yield* Effect.flip(captureWith(advertised, "https://example.com/")))._tag,
        "@doeixd/effect-agent/web/WebCaptureResponseTooLargeError"
      )
      const actual = HttpClient.make((request) =>
        Effect.succeed(response(request, "x".repeat(CloudflareWebCapture.MAX_RESPONSE_BYTES + 1))))
      assert.strictEqual(
        (yield* Effect.flip(captureWith(actual, "https://example.com/")))._tag,
        "@doeixd/effect-agent/web/WebCaptureResponseTooLargeError"
      )
      const secret = "not-json secret page content"
      const malformed = HttpClient.make((request) => Effect.succeed(response(request, secret, { status: 200 })))
      const error = yield* Effect.flip(captureWith(malformed, "https://example.com/"))
      assert.strictEqual(error._tag, "@doeixd/effect-agent/web/WebCaptureDecodeError")
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
      assert.strictEqual(error._tag, "@doeixd/effect-agent/web/WebCaptureTimeoutError")
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
})

