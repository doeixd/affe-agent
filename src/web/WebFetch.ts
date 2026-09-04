import { Context, Effect, Layer, Option, Schema } from "effect"

/** The representation of a bounded textual response body. */
export const BodyFormat = Schema.Literals(["text", "html", "markdown"])
export type BodyFormat = typeof BodyFormat.Type

/** A fetched textual resource. Bodies are untrusted external input. */
export const FetchResult = Schema.Struct({
  finalUrl: Schema.String,
  status: Schema.Number,
  mediaType: Schema.String,
  format: BodyFormat,
  body: Schema.String
})
export type FetchResult = typeof FetchResult.Type

/** Remove the fragment which never reaches HTTP and normalize URL syntax. */
export const canonicalize = (input: URL): URL => {
  const url = new URL(input.href)
  url.hash = ""
  return url
}

/** Canonical permission resource: scheme, hostname and effective port. */
export const canonicalOrigin = (url: URL): string => canonicalize(url).origin

/**
 * What a failure, a log line or a span is allowed to say about a target.
 *
 * The origin, and nothing after it. A model-selected URL is *content*: a path
 * segment or a query parameter is where an API key, a session token or a
 * document id lives, and every one of these errors is serializable and
 * expected to be logged. `https://example.com/private/<secret>?token=<secret>`
 * used to be copied whole into a tagged error and its message.
 *
 * The origin is what the diagnosis actually needs -- it is the thing the
 * permission decision was made about, and the thing a reader uses to tell
 * "the host refused us" from "we refused the host". A redacted path was
 * considered and rejected: a path segment is as likely to be the secret as a
 * query value, so keeping a bounded prefix keeps a bounded amount of it.
 *
 * The successful result's `finalUrl` is deliberately not this: it is a value
 * the caller asked for, not a diagnostic emitted on their behalf.
 */
export const diagnosticTarget = (url: URL): string => canonicalOrigin(url)

export class WebFetchInvalidUrlError extends
  Schema.TaggedError<WebFetchInvalidUrlError>()(
    "affe-agent/web/WebFetchInvalidUrlError",
    { url: Schema.String, reason: Schema.String }
  ) {
  override get message() {
    return `Web fetch rejected URL ${this.url}: ${this.reason}`
  }
}

export class WebFetchDeniedTargetError extends
  Schema.TaggedError<WebFetchDeniedTargetError>()(
    "affe-agent/web/WebFetchDeniedTargetError",
    { url: Schema.String, reason: Schema.String }
  ) {
  override get message() {
    return `Web fetch denied target ${this.url}: ${this.reason}`
  }
}

export class WebFetchTransportError extends
  Schema.TaggedError<WebFetchTransportError>()(
    "affe-agent/web/WebFetchTransportError",
    { url: Schema.String, detail: Schema.String }
  ) {
  override get message() {
    return `Web fetch transport failed for ${this.url}: ${this.detail}`
  }
}

export class WebFetchHttpResponseError extends
  Schema.TaggedError<WebFetchHttpResponseError>()(
    "affe-agent/web/WebFetchHttpResponseError",
    { url: Schema.String, status: Schema.Number }
  ) {
  override get message() {
    return `Web fetch received HTTP ${this.status} from ${this.url}`
  }
}

export class WebFetchCrossOriginRedirectError extends
  Schema.TaggedError<WebFetchCrossOriginRedirectError>()(
    "affe-agent/web/WebFetchCrossOriginRedirectError",
    { from: Schema.String, to: Schema.String }
  ) {
  override get message() {
    return `Web fetch refused cross-origin redirect from ${this.from} to ${this.to}`
  }
}

export class WebFetchRedirectLimitError extends
  Schema.TaggedError<WebFetchRedirectLimitError>()(
    "affe-agent/web/WebFetchRedirectLimitError",
    { url: Schema.String, maxRedirects: Schema.Number }
  ) {
  override get message() {
    return `Web fetch exceeded ${this.maxRedirects} redirects at ${this.url}`
  }
}

export class WebFetchUnsupportedContentTypeError extends
  Schema.TaggedError<WebFetchUnsupportedContentTypeError>()(
    "affe-agent/web/WebFetchUnsupportedContentTypeError",
    { url: Schema.String, contentType: Schema.Option(Schema.String) }
  ) {
  override get message() {
    return Option.match(this.contentType, {
      onNone: () => `Web fetch response from ${this.url} had no textual content type`,
      onSome: (contentType) =>
        `Web fetch does not accept content type ${contentType} from ${this.url}`
    })
  }
}

export class WebFetchResponseTooLargeError extends
  Schema.TaggedError<WebFetchResponseTooLargeError>()(
    "affe-agent/web/WebFetchResponseTooLargeError",
    { url: Schema.String, maxBytes: Schema.Number, observedBytes: Schema.Number }
  ) {
  override get message() {
    return `Web fetch response from ${this.url} exceeded ${this.maxBytes} bytes (observed ${this.observedBytes})`
  }
}

export class WebFetchDecodeError extends
  Schema.TaggedError<WebFetchDecodeError>()(
    "affe-agent/web/WebFetchDecodeError",
    { url: Schema.String, detail: Schema.String }
  ) {
  override get message() {
    return `Web fetch response from ${this.url} could not be decoded: ${this.detail}`
  }
}

export class WebFetchTimeoutError extends
  Schema.TaggedError<WebFetchTimeoutError>()(
    "affe-agent/web/WebFetchTimeoutError",
    { url: Schema.String, timeoutMillis: Schema.Number }
  ) {
  override get message() {
    return `Web fetch of ${this.url} exceeded ${this.timeoutMillis}ms`
  }
}

export type WebFetchError =
  | WebFetchInvalidUrlError
  | WebFetchDeniedTargetError
  | WebFetchTransportError
  | WebFetchHttpResponseError
  | WebFetchCrossOriginRedirectError
  | WebFetchRedirectLimitError
  | WebFetchUnsupportedContentTypeError
  | WebFetchResponseTooLargeError
  | WebFetchDecodeError
  | WebFetchTimeoutError

/** Provider-neutral arbitrary HTTP(S) retrieval capability. */
export interface Service {
  readonly fetch: (
    url: URL
  ) => Effect.Effect<FetchResult, WebFetchError>
}

/**
 * Infrastructure service supplied by a guarded fetch provider.
 *
 * The portable provider is baseline defense. Strong DNS/address isolation
 * requires an application provider backed by an egress proxy or an
 * address-aware runtime.
 */
export class WebFetch extends Context.Service<WebFetch, Service>()(
  "affe-agent/web/WebFetch"
) {}

/** Provide an already-constructed fetch service. */
export const layer = (service: Service): Layer.Layer<WebFetch> =>
  Layer.succeed(WebFetch)(service)
