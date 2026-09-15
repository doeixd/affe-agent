import { Clock, Config, Duration, Effect, Layer, Option, Redacted, Schema, Semaphore } from "effect"
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

/** One entry of the provider's `errors`; either half may be missing. */
const ProviderError = Schema.Struct({
  code: Schema.optional(Schema.Number),
  message: Schema.optional(Schema.String)
})
type ProviderError = typeof ProviderError.Type

const Envelope = <A, I>(result: Schema.Codec<A, I>) =>
  Schema.Struct({
    success: Schema.Boolean,
    result: Schema.optional(result),
    errors: Schema.optional(Schema.Array(ProviderError))
  })

const decodeMarkdown = Schema.decodeEffect(Schema.fromJsonString(Envelope(Schema.String)))
const decodeLinks = Schema.decodeEffect(Schema.fromJsonString(Envelope(Schema.Array(Schema.String))))
const decodeErrors = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ errors: Schema.optional(Schema.Array(ProviderError)) }))
)

/** Read from an error response only for its codes; the provider's error envelope is small. */
const MAX_ERROR_BODY_BYTES = 16 * 1024
/** The most provider codes a failure repeats. */
const MAX_CODES = 8
/** The longest `retry-after` honoured: a day. Past it the header is noise, not a plan. */
const MAX_RETRY_AFTER_MILLIS = 86_400_000

/**
 * Browser Rendering's "the page did not finish loading" error. Recognised by
 * code *and* exact wording, and nothing else of the provider's text is used:
 * a navigation timeout is reported as the renderer's limit rather than as an
 * HTTP status that reads like the destination's.
 */
const NAVIGATION_TIMEOUT_CODE = 6002
const NAVIGATION_TIMEOUT = /^Navigation timeout of ([1-9][0-9]{0,5}) ms exceeded$/

/** A `cf-ray` id is hex with an optional data-centre suffix; anything else is not repeated. */
const RAY_ID = /^[0-9a-f]{8,32}(?:-[A-Za-z]{3,4})?$/

const rayIdOf = (response: HttpClientResponse.HttpClientResponse): Option.Option<string> => {
  const value = response.headers["cf-ray"]
  return value !== undefined && RAY_ID.test(value) ? Option.some(value) : Option.none()
}

/** `retry-after` as delta-seconds or an HTTP date, on Effect's clock. */
const retryAfterMillis = (value: string | undefined): Effect.Effect<Option.Option<number>> =>
  Effect.map(Clock.currentTimeMillis, (now) => {
    if (value === undefined) return Option.none()
    const trimmed = value.trim()
    const millis = /^[0-9]{1,9}$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - now
    return Number.isFinite(millis) ? Option.some(Math.min(Math.max(millis, 0), MAX_RETRY_AFTER_MILLIS)) : Option.none()
  })

const responseError = (
  url: string,
  response: HttpClientResponse.HttpClientResponse,
  errors: ReadonlyArray<ProviderError>,
  fallback: string
): WebCapture.WebCaptureResponseError => {
  const navigationTimeoutMillis = Option.fromUndefinedOr(
    errors.flatMap((error) => {
      if (error.code !== NAVIGATION_TIMEOUT_CODE || error.message === undefined) return []
      const match = NAVIGATION_TIMEOUT.exec(error.message)
      return match === null ? [] : [Number(match[1])]
    })[0]
  )
  const codes = errors
    .flatMap((error) => (error.code !== undefined && Number.isSafeInteger(error.code) ? [error.code] : []))
    .slice(0, MAX_CODES)
  const detail = Option.match(navigationTimeoutMillis, {
    onSome: (millis) => `the provider's page navigation timed out after ${millis}ms`,
    onNone: () => (codes.length === 0 ? fallback : `${fallback} (provider codes ${codes.join(", ")})`)
  })
  return new WebCapture.WebCaptureResponseError({
    url,
    status: response.status,
    detail,
    navigationTimeoutMillis,
    rayId: rayIdOf(response)
  })
}

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
    decode: (text: string) => Effect.Effect<{ readonly success: boolean; readonly result?: A | undefined; readonly errors?: ReadonlyArray<ProviderError> | undefined }, unknown>
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
        return yield* new WebCapture.WebCaptureRateLimitedError({
          url: target,
          retryAfterMillis: yield* retryAfterMillis(response.headers["retry-after"]),
          rayId: rayIdOf(response)
        })
      }
      if (response.status < 200 || response.status >= 300) {
        // Read, bounded, for the provider's codes: a navigation timeout
        // arrives this way, and releasing the body unread reported it as a
        // bare status. A body that is too large or unreadable has no codes.
        const errors = yield* Body.readBounded<null>(response, {
          maxBytes: MAX_ERROR_BODY_BYTES,
          tooLarge: () => null,
          transport: () => null
        }).pipe(
          Effect.flatMap((bytes) => decodeErrors(new TextDecoder().decode(bytes))),
          Effect.map((envelope) => envelope.errors ?? []),
          Effect.orElseSucceed((): ReadonlyArray<ProviderError> => [])
        )
        return yield* responseError(target, response, errors, `HTTP ${response.status}`)
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
        return yield* responseError(target, response, envelope.errors ?? [], "the provider reported failure")
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
