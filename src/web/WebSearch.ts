import { Context, Effect, Layer, Option, Schema } from "effect"

/** Freshness windows understood by the provider-neutral search contract. */
export const Freshness = Schema.Literals(["day", "week", "month", "year"])
export type Freshness = typeof Freshness.Type

/** Options records keep optional properties, following Effect's own APIs. */
export interface SearchOptions {
  readonly limit?: number | undefined
  readonly freshness?: Freshness | undefined
}

/** One ranked source returned by a web search provider. */
export const SearchResult = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  snippet: Schema.String
})
export type SearchResult = typeof SearchResult.Type

/** The provider could not send a request or consume its response stream. */
export class WebSearchTransportError extends
  Schema.TaggedError<WebSearchTransportError>()(
    "affe-agent/web/WebSearchTransportError",
    { detail: Schema.String }
  ) {
  override get message() {
    return `Web search transport failed: ${this.detail}`
  }
}

/** The configured provider credential was absent, invalid or unauthorized. */
export class WebSearchAuthenticationError extends
  Schema.TaggedError<WebSearchAuthenticationError>()(
    "affe-agent/web/WebSearchAuthenticationError",
    { status: Schema.Number }
  ) {
  override get message() {
    return `Web search authentication failed with HTTP ${this.status}`
  }
}

/** The provider refused the call because its rate or quota was exhausted. */
export class WebSearchRateLimitedError extends
  Schema.TaggedError<WebSearchRateLimitedError>()(
    "affe-agent/web/WebSearchRateLimitedError",
    { retryAfter: Schema.Option(Schema.String) }
  ) {
  override get message() {
    return Option.match(this.retryAfter, {
      onNone: () => "Web search was rate limited",
      onSome: (retryAfter) => `Web search was rate limited (retry after ${retryAfter})`
    })
  }
}

/** The provider returned an HTTP response that has no search-domain meaning. */
export class WebSearchResponseError extends
  Schema.TaggedError<WebSearchResponseError>()(
    "affe-agent/web/WebSearchResponseError",
    { status: Schema.Number }
  ) {
  override get message() {
    return `Web search provider returned HTTP ${this.status}`
  }
}

/** The response was syntactically valid bytes but not the provider schema. */
export class WebSearchDecodeError extends
  Schema.TaggedError<WebSearchDecodeError>()(
    "affe-agent/web/WebSearchDecodeError",
    { detail: Schema.String }
  ) {
  override get message() {
    return `Web search response could not be decoded: ${this.detail}`
  }
}

/** The provider response exceeded the advertised or actual byte budget. */
export class WebSearchResponseTooLargeError extends
  Schema.TaggedError<WebSearchResponseTooLargeError>()(
    "affe-agent/web/WebSearchResponseTooLargeError",
    { maxBytes: Schema.Number, observedBytes: Schema.Number }
  ) {
  override get message() {
    return `Web search response exceeded ${this.maxBytes} bytes (observed ${this.observedBytes})`
  }
}

/** Request, retries and response consumption exceeded one total time budget. */
export class WebSearchTimeoutError extends
  Schema.TaggedError<WebSearchTimeoutError>()(
    "affe-agent/web/WebSearchTimeoutError",
    { timeoutMillis: Schema.Number }
  ) {
  override get message() {
    return `Web search exceeded ${this.timeoutMillis}ms`
  }
}

export type WebSearchError =
  | WebSearchTransportError
  | WebSearchAuthenticationError
  | WebSearchRateLimitedError
  | WebSearchResponseError
  | WebSearchDecodeError
  | WebSearchResponseTooLargeError
  | WebSearchTimeoutError

/** Provider-neutral outbound search capability. */
export interface Service {
  readonly search: (
    query: string,
    options?: SearchOptions | undefined
  ) => Effect.Effect<ReadonlyArray<SearchResult>, WebSearchError>
}

/**
 * Infrastructure service supplied by a concrete search-provider Layer.
 *
 * It is intentionally separate from `WebToolkit`: policy gates the tool call,
 * while this service determines which fixed provider endpoint can be reached.
 */
export class WebSearch extends Context.Service<WebSearch, Service>()(
  "affe-agent/web/WebSearch"
) {}

/** Provide an already-constructed search service. */
export const layer = (service: Service): Layer.Layer<WebSearch> =>
  Layer.succeed(WebSearch)(service)
