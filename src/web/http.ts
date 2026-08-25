import { Duration, Effect, Layer, Option, Stream } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse
} from "effect/unstable/http"
import * as WebFetch from "./WebFetch.js"

export const MAX_RESPONSE_BYTES = 1024 * 1024
export const MAX_REDIRECTS = 5
export const TIMEOUT_MILLIS = 20_000

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata.aws.internal",
  "metadata.azure.internal"
])

const normalizedHostname = (url: URL): string =>
  url.hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.+$/, "")


const ipv4Octets = (host: string): ReadonlyArray<number> | undefined => {
  const parts = host.split(".")
  if (parts.length !== 4) return undefined
  const octets = parts.map(Number)
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets
    : undefined
}

const deniedIpv4 = (octets: ReadonlyArray<number>): boolean => {
  const first = octets[0] ?? 0
  const second = octets[1] ?? 0
  return first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
}

const ipv6Hextets = (host: string): ReadonlyArray<number> | undefined => {
  if (!host.includes(":")) return undefined
  if (host.includes("%")) return undefined
  const halves = host.split("::")
  if (halves.length > 2) return undefined

  const parseSide = (side: string): ReadonlyArray<number> | undefined => {
    if (side === "") return []
    const pieces = side.split(":")
    const values: Array<number> = []
    for (const piece of pieces) {
      const ipv4 = ipv4Octets(piece)
      if (ipv4 !== undefined) {
        values.push(
          ((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0),
          ((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0)
        )
        continue
      }
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return undefined
      values.push(Number.parseInt(piece, 16))
    }
    return values
  }

  const left = parseSide(halves[0] ?? "")
  const right = parseSide(halves[1] ?? "")
  if (left === undefined || right === undefined) return undefined
  if (halves.length === 1) return left.length === 8 ? left : undefined
  const zeros = 8 - left.length - right.length
  return zeros >= 1 ? [...left, ...Array<number>(zeros).fill(0), ...right] : undefined
}

const deniedIpv6 = (hextets: ReadonlyArray<number>): boolean => {
  if (hextets.length !== 8) return true
  const first = hextets[0] ?? 0
  const allZero = hextets.every((part) => part === 0)
  const loopback = hextets.slice(0, 7).every((part) => part === 0) && hextets[7] === 1
  const uniqueLocal = (first & 0xfe00) === 0xfc00
  const linkLocal = (first & 0xffc0) === 0xfe80
  const siteLocal = (first & 0xffc0) === 0xfec0
  const multicast = (first & 0xff00) === 0xff00
  const ipv4Mapped = hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff
  if (ipv4Mapped) {
    const high = hextets[6] ?? 0
    const low = hextets[7] ?? 0
    return deniedIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff])
  }
  return allZero || loopback || uniqueLocal || linkLocal || siteLocal || multicast
}

const validateTarget = (url: URL): Effect.Effect<void, WebFetch.WebFetchError> => {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Effect.fail(
      new WebFetch.WebFetchInvalidUrlError({
        url: WebFetch.diagnosticTarget(url),
        reason: "only http and https are supported"
      })
    )
  }
  if (url.username !== "" || url.password !== "") {
    return Effect.fail(
      new WebFetch.WebFetchInvalidUrlError({
        url: WebFetch.diagnosticTarget(url),
        reason: "embedded credentials are not allowed"
      })
    )
  }

  const host = normalizedHostname(url)
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    METADATA_HOSTS.has(host)
  ) {
    return Effect.fail(
      new WebFetch.WebFetchDeniedTargetError({
        url: WebFetch.diagnosticTarget(url),
        reason: "local and metadata hostnames are not allowed"
      })
    )
  }

  const ipv4 = ipv4Octets(host)
  if (ipv4 !== undefined && deniedIpv4(ipv4)) {
    return Effect.fail(
      new WebFetch.WebFetchDeniedTargetError({
        url: WebFetch.diagnosticTarget(url),
        reason: "non-public IPv4 targets are not allowed"
      })
    )
  }
  const ipv6 = ipv6Hextets(host)
  if (ipv6 !== undefined && deniedIpv6(ipv6)) {
    return Effect.fail(
      new WebFetch.WebFetchDeniedTargetError({
        url: WebFetch.diagnosticTarget(url),
        reason: "non-public IPv6 targets are not allowed"
      })
    )
  }
  return Effect.void
}

interface BodyState {
  readonly chunks: ReadonlyArray<Uint8Array>
  readonly size: number
}

const readBody = Effect.fn("HttpWebFetch.readBody")(function*(
  response: HttpClientResponse.HttpClientResponse,
  url: URL
) {
  const declared = response.headers["content-length"]
  if (declared !== undefined) {
    const bytes = Number(declared)
    if (Number.isFinite(bytes) && bytes > MAX_RESPONSE_BYTES) {
      return yield* new WebFetch.WebFetchResponseTooLargeError({
        url: WebFetch.diagnosticTarget(url),
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
          new WebFetch.WebFetchResponseTooLargeError({
            url: WebFetch.diagnosticTarget(url),
            maxBytes: MAX_RESPONSE_BYTES,
            observedBytes: size
          })
        )
        : Effect.succeed({ chunks: [...current.chunks, chunk], size })
    }
  ).pipe(
    Effect.catchTag("HttpClientError", (error) =>
      Effect.fail(
        new WebFetch.WebFetchTransportError({
          url: WebFetch.diagnosticTarget(url),
          detail: error.reason._tag
        })
      ))
  )

  const bytes = new Uint8Array(state.size)
  let offset = 0
  for (const chunk of state.chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
})

const mediaTypeOf = (contentType: string | undefined): string | undefined =>
  contentType?.split(";", 1)[0]?.trim().toLowerCase()

const textualFormat = (mediaType: string): WebFetch.BodyFormat | undefined => {
  if (mediaType === "text/markdown") return "markdown"
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") return "html"
  if (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType.endsWith("+json") ||
    mediaType === "application/xml" ||
    mediaType.endsWith("+xml") ||
    mediaType === "application/javascript"
  ) return "text"
  return undefined
}

const charsetOf = (contentType: string): string => {
  const charset = /(?:^|;)\s*charset\s*=\s*["']?([^;"']+)/i.exec(contentType)?.[1]
  return charset?.trim() ?? "utf-8"
}

/** Construct the portable guarded fetch service from an abstract HttpClient. */
export const make = Effect.fn("HttpWebFetch.make")(function*() {
  const client = yield* HttpClient.HttpClient

  const fetchOne = Effect.fn("HttpWebFetch.fetchOne")(function*(
    initial: URL,
    current: URL,
    redirects: number
  ): Effect.fn.Return<WebFetch.FetchResult, WebFetch.WebFetchError> {
    yield* validateTarget(current)
    const request = HttpClientRequest.get(current.href, {
      headers: {
        accept: "text/*, application/json, application/*+json, application/xml, application/*+xml"
      }
    })
    const response = yield* client.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
        credentials: "omit"
      }),
      /**
       * The generic client span is suppressed, and replaced by this one.
       *
       * `HttpClient` unconditionally annotates `url.full` and `url.query` on
       * an `http.client GET` span. Those are the two attributes this package
       * promises never to export, and no redaction wiring documented for the
       * tool boundary reaches a nested span. Disabling the tracer for the
       * execution is what actually prevents the attribute from being written;
       * anything downstream is a filter that has to be remembered.
       *
       * What replaces it carries the origin and the status, which is what a
       * trace of an outbound fetch is read for.
       */
      Effect.withTracerEnabled(false),
      Effect.tap((response) =>
        Effect.annotateCurrentSpan({
          "server.address": WebFetch.diagnosticTarget(current),
          "http.response.status_code": response.status
        })),
      Effect.withSpan("HttpWebFetch.request", {
        kind: "client",
        attributes: {
          "http.request.method": "GET",
          "server.address": WebFetch.diagnosticTarget(current)
        }
      }),
      Effect.catchTag("HttpClientError", (error) =>
        Effect.fail(
          new WebFetch.WebFetchTransportError({
            url: WebFetch.diagnosticTarget(current),
            detail: error.reason._tag
          })
        ))
    )

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.location
      if (location === undefined) {
        return yield* new WebFetch.WebFetchHttpResponseError({
          url: WebFetch.diagnosticTarget(current),
          status: response.status
        })
      }
      const next = yield* Effect.try({
        try: () => WebFetch.canonicalize(new URL(location, current)),
        catch: () =>
          new WebFetch.WebFetchInvalidUrlError({
            // Named by the origin that sent it, not by the header itself: the
            // `Location` value is server-controlled text that failed to parse,
            // so it is neither trustworthy nor safe to copy into a log.
            url: WebFetch.diagnosticTarget(current),
            reason: "redirect location is not a valid URL"
          })
      })
      yield* validateTarget(next)
      if (next.origin !== initial.origin) {
        return yield* new WebFetch.WebFetchCrossOriginRedirectError({
          // The destination is the capability question the caller asked --
          // "may I follow this elsewhere" -- so both sides are named by
          // origin, which is exactly the granularity the answer turns on.
          from: WebFetch.diagnosticTarget(current),
          to: WebFetch.diagnosticTarget(next)
        })
      }
      if (redirects >= MAX_REDIRECTS) {
        return yield* new WebFetch.WebFetchRedirectLimitError({
          url: WebFetch.diagnosticTarget(current),
          maxRedirects: MAX_REDIRECTS
        })
      }
      return yield* fetchOne(initial, next, redirects + 1)
    }

    if (response.status < 200 || response.status >= 300) {
      return yield* new WebFetch.WebFetchHttpResponseError({
        url: WebFetch.diagnosticTarget(current),
        status: response.status
      })
    }

    const rawContentType = response.headers["content-type"]
    const mediaType = mediaTypeOf(rawContentType)
    const format = mediaType === undefined ? undefined : textualFormat(mediaType)
    if (mediaType === undefined || format === undefined) {
      return yield* new WebFetch.WebFetchUnsupportedContentTypeError({
        url: WebFetch.diagnosticTarget(current),
        contentType: Option.fromNullishOr(rawContentType)
      })
    }

    const bytes = yield* readBody(response, current)
    const body = yield* Effect.try({
      try: () => new TextDecoder(charsetOf(rawContentType ?? mediaType), { fatal: true }).decode(bytes),
      catch: () =>
        new WebFetch.WebFetchDecodeError({
          url: WebFetch.diagnosticTarget(current),
          detail: "body was not valid text for its declared charset"
        })
    })
    return {
      finalUrl: current.href,
      status: response.status,
      mediaType,
      format,
      body
    }
  })

  const fetch = Effect.fn("HttpWebFetch.fetch")(function*(input: URL) {
    const url = WebFetch.canonicalize(input)
    return yield* fetchOne(url, url, 0).pipe(
      Effect.timeout(Duration.millis(TIMEOUT_MILLIS)),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          new WebFetch.WebFetchTimeoutError({
            url: WebFetch.diagnosticTarget(url),
            timeoutMillis: TIMEOUT_MILLIS
          })
        ))
    )
  })

  return { fetch }
})

/** Portable guarded HTTP provider. Redirect visibility depends on HttpClient honoring manual mode. */
export const layer: Layer.Layer<
  WebFetch.WebFetch,
  never,
  HttpClient.HttpClient
> = Layer.effect(WebFetch.WebFetch, make())
