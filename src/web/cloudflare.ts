import { Config, Duration, Effect, Layer, Redacted, Schema, Semaphore } from "effect"
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"
import * as Body from "./internal/body.js"
import * as Target from "./internal/target.js"
import * as WebCapture from "./WebCapture.js"

/**
 * `WebCapture` over Cloudflare Browser Rendering's REST API.
 *
 * Two endpoints, both `POST` with `{ url }` under a bearer token:
 * `/browser-rendering/markdown` renders the page and returns its content as
 * Markdown; `/browser-rendering/links` returns the absolute links it found.
 * Rendering happens in Cloudflare's browser, so this provider is ordinary
 * HTTP and portable -- it runs anywhere `HttpClient` does, Node and workerd
 * alike -- and needs no host binding.
 *
 * The target guard is the fetch provider's: a model-selected URL is refused
 * here for the same reasons `web_fetch` refuses it, before it is handed to
 * a renderer that would otherwise reach it from Cloudflare's network.
 */

/** Cloudflare's API origin; the account id completes the path. */
export const ENDPOINT = "https://api.cloudflare.com/client/v4/accounts"
const AUTH_HEADER = "authorization"

/** Byte budget for each provider response; exceeding it becomes `WebCaptureResponseTooLargeError`. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
/** Whole-operation budget for one capture (both endpoints): `Effect.timeout` → `WebCaptureTimeoutError`. */
export const TIMEOUT_MILLIS = 30_000
/** At most 4 captures in flight; excess calls queue so one model turn is not a crawler. */
export const MAX_CONCURRENT = 4

/** Authentication and account, owned by the application. */
export interface Options {
  readonly accountId: string
  readonly apiToken: Redacted.Redacted<string>
}

const Envelope = <A, I>(result: Schema.Codec<A, I>) =>
  Schema.Struct({
    success: Schema.Boolean,
    result: Schema.optional(result),
    errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String })))
  })

const decodeMarkdown = Schema.decodeEffect(Schema.fromJsonString(Envelope(Schema.String)))
const decodeLinks = Schema.decodeEffect(Schema.fromJsonString(Envelope(Schema.Array(Schema.String))))

const withRedactedHeaders = Effect.updateService(
  Headers.CurrentRedactedNames,
  (names) => [...names, AUTH_HEADER]
)

const validateTarget = (url: URL): Effect.Effect<void, WebCapture.WebCaptureError> => {
  const refused = Target.refusal(url)
  if (refused === undefined) return Effect.void
  return Effect.fail(
    refused.kind === "invalid"
      ? new WebCapture.WebCaptureInvalidUrlError({ url: WebCapture.diagnosticTarget(url), reason: refused.reason })
      : new WebCapture.WebCaptureDeniedTargetError({ url: WebCapture.diagnosticTarget(url), reason: refused.reason })
  )
}

export const make = Effect.fn("CloudflareWebCapture.make")(function* (options: Options) {
  const client = yield* HttpClient.HttpClient
  const concurrent = yield* Semaphore.make(MAX_CONCURRENT)
  const base = `${ENDPOINT}/${encodeURIComponent(options.accountId)}/browser-rendering`

  const readBody = (response: HttpClientResponse.HttpClientResponse, url: URL) =>
    Body.readBounded<WebCapture.WebCaptureError>(response, {
      maxBytes: MAX_RESPONSE_BYTES,
      tooLarge: (observedBytes) =>
        new WebCapture.WebCaptureResponseTooLargeError({
          url: WebCapture.diagnosticTarget(url),
          maxBytes: MAX_RESPONSE_BYTES,
          observedBytes
        }),
      transport: (detail) => new WebCapture.WebCaptureTransportError({ url: WebCapture.diagnosticTarget(url), detail })
    })

  /** One endpoint call, decoded through `decode`, with the status mapped. */
  const call = <A>(
    endpoint: "markdown" | "links",
    url: URL,
    decode: (text: string) => Effect.Effect<{ readonly success: boolean; readonly result?: A | undefined; readonly errors?: ReadonlyArray<{ readonly message: string }> | undefined }, unknown>
  ): Effect.Effect<A, WebCapture.WebCaptureError> =>
    Effect.gen(function* () {
      const target = WebCapture.diagnosticTarget(url)
      const request = HttpClientRequest.post(`${base}/${endpoint}`, {
        headers: { accept: "application/json", "content-type": "application/json" }
      }).pipe(
        HttpClientRequest.bearerToken(Redacted.value(options.apiToken)),
        HttpClientRequest.bodyJsonUnsafe({ url: url.href })
      )
      const response = yield* client.execute(request).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { credentials: "omit" }),
        // As the fetch provider: the client's own span would carry the
        // provider URL, which is fine, but the model-selected target must
        // not appear beyond its origin anywhere a span is exported.
        Effect.withTracerEnabled(false),
        Effect.withSpan("CloudflareWebCapture.request", {
          kind: "client",
          attributes: { "http.request.method": "POST", "server.address": target, "capture.endpoint": endpoint }
        }),
        Effect.catchTag("HttpClientError", (error) =>
          Effect.fail(new WebCapture.WebCaptureTransportError({ url: target, detail: error.reason._tag })))
      )
      if (response.status === 401 || response.status === 403) {
        yield* Body.release(response)
        return yield* new WebCapture.WebCaptureAuthenticationError({ status: response.status })
      }
      if (response.status === 429) {
        yield* Body.release(response)
        return yield* new WebCapture.WebCaptureRateLimitedError({ url: target })
      }
      if (response.status < 200 || response.status >= 300) {
        yield* Body.release(response)
        return yield* new WebCapture.WebCaptureResponseError({ url: target, status: response.status, detail: `HTTP ${response.status}` })
      }
      const bytes = yield* readBody(response, url)
      const text = new TextDecoder().decode(bytes)
      const envelope = yield* decode(text).pipe(
        // The body is never echoed: it is the provider's rendering of a
        // model-selected page, which is exactly what must not end up in
        // an error message that gets logged.
        Effect.mapError(() => new WebCapture.WebCaptureDecodeError({ url: target, detail: "the provider envelope did not decode" }))
      )
      if (!envelope.success || envelope.result === undefined) {
        const detail = envelope.errors?.map((e) => e.message).join("; ") ?? "the provider reported failure"
        return yield* new WebCapture.WebCaptureResponseError({ url: target, status: response.status, detail })
      }
      return envelope.result
    })

  const capture: WebCapture.Service["capture"] = (url) =>
    concurrent.withPermits(1)(
      Effect.gen(function* () {
        yield* validateTarget(url)
        const target = new URL(url.href)
        target.hash = ""
        const [markdown, links] = yield* Effect.all(
          [call("markdown", target, decodeMarkdown), call("links", target, decodeLinks)],
          { concurrency: 2 }
        )
        return {
          url: target.href,
          markdown,
          links: [...new Set(links)]
        } satisfies WebCapture.CaptureResult
      }).pipe(
        Effect.timeout(Duration.millis(TIMEOUT_MILLIS)),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(new WebCapture.WebCaptureTimeoutError({ url: WebCapture.diagnosticTarget(url), timeoutMillis: TIMEOUT_MILLIS }))),
        withRedactedHeaders
      )
    )

  return { capture } satisfies WebCapture.Service
})

/** The provider over the `HttpClient` you supply. Pass a transport, not an authenticated application client. */
export const layer = (options: Options): Layer.Layer<WebCapture.WebCapture, never, HttpClient.HttpClient> =>
  Layer.effect(WebCapture.WebCapture, make(options))

/** The provider over a transport it owns. The recommended production wiring. */
export const layerFetch = (options: Options): Layer.Layer<WebCapture.WebCapture> =>
  layer(options).pipe(Layer.provide(FetchHttpClient.layer))

/**
 * The provider from configuration: `CLOUDFLARE_ACCOUNT_ID` and
 * `CLOUDFLARE_API_TOKEN`, the names `wrangler` and Cloudflare's own tools
 * read, so a deployment that has them set has this provider configured.
 */
export const layerConfig: Layer.Layer<WebCapture.WebCapture, Config.ConfigError, HttpClient.HttpClient> =
  Layer.unwrap(
    Effect.map(
      Effect.all({
        accountId: Config.string("CLOUDFLARE_ACCOUNT_ID"),
        apiToken: Config.redacted("CLOUDFLARE_API_TOKEN")
      }),
      layer
    )
  )
