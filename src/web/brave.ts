import {
  Config,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
  Semaphore
} from "effect"
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse
} from "effect/unstable/http"
import * as Body from "./internal/body.js"
import * as WebSearch from "./WebSearch.js"

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search"
const AUTH_HEADER = "x-subscription-token"

export const DEFAULT_LIMIT = 8
export const MAX_LIMIT = 10
export const MAX_RESPONSE_BYTES = 1024 * 1024
export const TIMEOUT_MILLIS = 15_000
export const MAX_CONCURRENT = 4

const BraveResult = Schema.Struct({
  title: Schema.String,
  url: Schema.URLFromString,
  description: Schema.String
})

const BraveResponse = Schema.Struct({
  web: Schema.Struct({
    results: Schema.Array(BraveResult)
  })
})

const decodeResponse = Schema.decodeEffect(
  Schema.fromJsonString(BraveResponse)
)

const freshness = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py"
} satisfies Record<WebSearch.Freshness, string>

/** Authentication and endpoint configuration owned by the application. */
export interface Options {
  readonly apiKey: Redacted.Redacted<string>
}

const withRedactedHeaders = Effect.updateService(
  Headers.CurrentRedactedNames,
  (names) => [...names, AUTH_HEADER]
)

const transportError = (detail: string): WebSearch.WebSearchTransportError =>
  new WebSearch.WebSearchTransportError({ detail })

/** Consume the response incrementally; neither `.text` nor `.json` is bounded. */
const readBody = (response: HttpClientResponse.HttpClientResponse) =>
  Body.readBounded<WebSearch.WebSearchError>(response, {
    maxBytes: MAX_RESPONSE_BYTES,
    tooLarge: (observedBytes) =>
      new WebSearch.WebSearchResponseTooLargeError({
        maxBytes: MAX_RESPONSE_BYTES,
        observedBytes
      }),
    transport: transportError
  })

const retryable = (error: WebSearch.WebSearchError): boolean =>
  error._tag === "@doeixd/effect-agent/web/WebSearchTransportError" ||
  error._tag === "@doeixd/effect-agent/web/WebSearchRateLimitedError"

/**
 * How long to wait before the single retry.
 *
 * `Retry-After` is either delta-seconds or an HTTP-date; only the first was
 * parsed, so *every* valid date fell through to the non-finite branch and
 * waited exactly two seconds -- including a date already in the past. Both
 * forms are read here, and the date form is resolved against Effect's clock
 * rather than wall time so a test can state what "now" is.
 *
 * Clamped to at most two seconds either way. The header is a server's request,
 * not an instruction: honouring a five-minute value would spend the caller's
 * whole timeout budget waiting, and this retry exists to ride out a blip.
 */
const retryDelay = (
  error: WebSearch.WebSearchError
): Effect.Effect<Duration.Duration> => {
  if (error._tag !== "@doeixd/effect-agent/web/WebSearchRateLimitedError") {
    return Effect.succeed(Duration.millis(100))
  }
  return Option.match(error.retryAfter, {
    onNone: () => Effect.succeed(Duration.seconds(1)),
    onSome: (value) =>
      Effect.map(Effect.clockWith((clock) => clock.currentTimeMillis), (now) => {
        const seconds = Number(value)
        if (Number.isFinite(seconds)) return clamped(seconds)
        const at = Date.parse(value)
        // An unparseable header is a server saying something this client does
        // not understand. Two seconds is the deliberate fallback: long enough
        // to be a pause, short enough to stay inside the budget.
        if (Number.isNaN(at)) return Duration.seconds(2)
        return clamped((at - now) / 1000)
      })
  })
}

const clamped = (seconds: number): Duration.Duration =>
  Duration.seconds(Math.min(2, Math.max(0, seconds)))

const retrySchedule = Schedule.identity<WebSearch.WebSearchError>().pipe(
  Schedule.modifyDelay(({ input }) => retryDelay(input))
)

/**
 * Construct a Brave-backed service from explicit, redacted configuration.
 *
 * **What "at most one retry" does and does not guarantee.**
 *
 * This wrapper makes at most two *logical* attempts, and it will not accept a
 * failure it has already retried. Each attempt calls the `HttpClient` it was
 * given, which is a composed value: middleware on it can retry a transport
 * failure or a status any number of times before `execute` returns. So the
 * bound established here is "this adapter invokes the supplied client at most
 * twice", not "at most two requests reach the network".
 *
 * That distinction matters for a search provider in particular, where every
 * hidden physical request is billed and resends both the query and the key.
 * Supplying a client with a bounded -- ideally absent -- retry policy is the
 * application's part of the contract; the `test/BraveWebSearch.test.ts` case
 * "bounds its own attempts, not a supplied client's" is what keeps this
 * paragraph honest rather than aspirational.
 */
export const make = Effect.fn("BraveWebSearch.make")(function*(options: Options) {
  const client = yield* HttpClient.HttpClient
  const concurrent = yield* Semaphore.make(MAX_CONCURRENT)

  const search = Effect.fn("BraveWebSearch.search")(function*(
    query: string,
    searchOptions?: WebSearch.SearchOptions | undefined
  ) {
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Math.trunc(searchOptions?.limit ?? DEFAULT_LIMIT))
    )
    const request = HttpClientRequest.get(ENDPOINT, {
      headers: {
        accept: "application/json",
        [AUTH_HEADER]: Redacted.value(options.apiKey)
      },
      urlParams: {
        q: query,
        count: String(limit),
        ...(searchOptions?.freshness === undefined
          ? {}
          : { freshness: freshness[searchOptions.freshness] })
      }
    })

    const attempt = Effect.gen(function* () {
      const response = yield* client.execute(request).pipe(
        /**
         * Redirects are handled here, not by whatever client was injected.
         *
         * The request carries `x-subscription-token`. Effect's documented
         * production wiring is `FetchHttpClient`, which follows redirects
         * through `globalThis.fetch` -- and fetch strips only a small standard
         * set of sensitive headers across origins, which this
         * provider-specific one is not in. A redirect from the endpoint, a
         * proxy, or a compromised host therefore *sent the API key onward*.
         * Redacting the header changes what a log shows, not what is
         * transmitted.
         *
         * There is no allowed destination: the endpoint is a constant, so a
         * redirect away from it is not something this adapter has any reason
         * to follow.
         */
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "manual",
          credentials: "omit"
        }),
        Effect.catchTag("HttpClientError", (error) =>
          Effect.fail(transportError(error.reason._tag)))
      )

      if (response.status >= 300 && response.status < 400) {
        yield* Body.release(response)
        return yield* new WebSearch.WebSearchResponseError({
          status: response.status
        })
      }

      if (response.status === 401 || response.status === 403) {
        yield* Body.release(response)
        return yield* new WebSearch.WebSearchAuthenticationError({
          status: response.status
        })
      }
      if (response.status === 429) {
        yield* Body.release(response)
        return yield* new WebSearch.WebSearchRateLimitedError({
          retryAfter: Option.fromNullishOr(response.headers["retry-after"])
        })
      }
      if (response.status < 200 || response.status >= 300) {
        yield* Body.release(response)
        return yield* new WebSearch.WebSearchResponseError({
          status: response.status
        })
      }

      const body = yield* readBody(response)
      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(body),
        catch: () =>
          new WebSearch.WebSearchDecodeError({
            detail: "response body was not valid UTF-8"
          })
      })
      const decoded = yield* decodeResponse(text).pipe(
        Effect.catchTag("SchemaError", () =>
          Effect.fail(
            new WebSearch.WebSearchDecodeError({
              detail: "provider response did not match the expected schema"
            })
          ))
      )
      return decoded.web.results.slice(0, limit).map((result) => ({
        title: result.title,
        url: result.url.href,
        snippet: result.description
      }))
    })

    return yield* concurrent.withPermit(
      attempt.pipe(
        Effect.retry({
          schedule: retrySchedule,
          times: 1,
          while: retryable
        }),
        Effect.timeout(Duration.millis(TIMEOUT_MILLIS)),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(
            new WebSearch.WebSearchTimeoutError({
              timeoutMillis: TIMEOUT_MILLIS
            })
          ))
      )
    ).pipe(withRedactedHeaders)
  })

  return { search }
})

/** Provide Brave search from explicit options. */
export const layer = (
  options: Options
): Layer.Layer<WebSearch.WebSearch, never, HttpClient.HttpClient> =>
  Layer.effect(WebSearch.WebSearch, make(options))

/** Load the Brave key from Effect Config (default `BRAVE_SEARCH_API_KEY`). */
export const layerConfig = (options?: {
  readonly apiKey?: Config.Config<Redacted.Redacted<string>> | undefined
}): Layer.Layer<
  WebSearch.WebSearch,
  Config.ConfigError,
  HttpClient.HttpClient
> =>
  Layer.effect(
    WebSearch.WebSearch,
    Effect.flatMap(
      options?.apiKey ?? Config.redacted("BRAVE_SEARCH_API_KEY"),
      (apiKey) => make({ apiKey })
    )
  )
