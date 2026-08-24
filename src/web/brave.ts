import {
  Config,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
  Semaphore,
  Stream
} from "effect"
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse
} from "effect/unstable/http"
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

interface BodyState {
  readonly chunks: ReadonlyArray<Uint8Array>
  readonly size: number
}

/** Consume the response incrementally; neither `.text` nor `.json` is bounded. */
const readBody = Effect.fn("BraveWebSearch.readBody")(function*(
  response: HttpClientResponse.HttpClientResponse
) {
  const declared = response.headers["content-length"]
  if (declared !== undefined) {
    const bytes = Number(declared)
    if (Number.isFinite(bytes) && bytes > MAX_RESPONSE_BYTES) {
      return yield* new WebSearch.WebSearchResponseTooLargeError({
        maxBytes: MAX_RESPONSE_BYTES,
        observedBytes: bytes
      })
    }
  }

  const state = yield* Stream.runFoldEffect(
    response.stream,
    (): BodyState => ({ chunks: [], size: 0 }),
    (current, chunk) => {
      const size = current.size + chunk.byteLength
      return size > MAX_RESPONSE_BYTES
        ? Effect.fail(
          new WebSearch.WebSearchResponseTooLargeError({
            maxBytes: MAX_RESPONSE_BYTES,
            observedBytes: size
          })
        )
        : Effect.succeed({
          chunks: [...current.chunks, chunk],
          size
        })
    }
  ).pipe(
    Effect.catchTag("HttpClientError", (error) =>
      Effect.fail(transportError(error.reason._tag)))
  )

  const bytes = new Uint8Array(state.size)
  let offset = 0
  for (const chunk of state.chunks) {
    bytes.set(chunk, offset)
    offset = offset + chunk.byteLength
  }
  return bytes
})

const retryable = (error: WebSearch.WebSearchError): boolean =>
  error._tag === "@doeixd/effect-agent/web/WebSearchTransportError" ||
  error._tag === "@doeixd/effect-agent/web/WebSearchRateLimitedError"

const retryDelay = (error: WebSearch.WebSearchError): Duration.Duration => {
  if (error._tag !== "@doeixd/effect-agent/web/WebSearchRateLimitedError") {
    return Duration.millis(100)
  }
  return Option.match(error.retryAfter, {
    onNone: () => Duration.seconds(1),
    onSome: (value) => {
      const seconds = Number(value)
      return Duration.seconds(
        Number.isFinite(seconds) ? Math.min(2, Math.max(0, seconds)) : 2
      )
    }
  })
}

const retrySchedule = Schedule.identity<WebSearch.WebSearchError>().pipe(
  Schedule.modifyDelay(({ input }) => Effect.succeed(retryDelay(input)))
)

/** Construct a Brave-backed service from explicit, redacted configuration. */
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
        Effect.catchTag("HttpClientError", (error) =>
          Effect.fail(transportError(error.reason._tag)))
      )

      if (response.status === 401 || response.status === 403) {
        return yield* new WebSearch.WebSearchAuthenticationError({
          status: response.status
        })
      }
      if (response.status === 429) {
        return yield* new WebSearch.WebSearchRateLimitedError({
          retryAfter: Option.fromNullishOr(response.headers["retry-after"])
        })
      }
      if (response.status < 200 || response.status >= 300) {
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
