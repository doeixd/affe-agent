import { Clock, Context, Duration, Effect, Layer, Schema } from "effect"
import * as WebCapture from "./WebCapture.js"

/**
 * A bounded, same-host crawl over `WebCapture`.
 *
 * Breadth-first from one page: capture it, follow the links that stay on
 * its host, and stop at whichever bound is met first -- pages, depth, total
 * bytes, or the deadline. A page that fails to capture is recorded and
 * skipped; one bad page does not end a crawl. Built *over* the capture
 * capability rather than as a second provider contract, so every provider
 * that can render one page can crawl, and the bounds live in one place.
 *
 * Every bound has a default and a hard ceiling. A model may ask for fewer
 * pages or less depth; it may not ask for more than the ceiling, which is
 * what keeps one tool call from behaving like a crawler in the bad sense.
 */

/** Pages a crawl visits when the caller does not say; capped by `MAX_PAGES`. */
export const DEFAULT_PAGES = 20
/** The most pages any crawl visits, whatever is asked. */
export const MAX_PAGES = 100
/** Link depth from the start page when the caller does not say; capped by `MAX_DEPTH`. */
export const DEFAULT_DEPTH = 3
/** The deepest any crawl follows links, whatever is asked. */
export const MAX_DEPTH = 10
/** Total Markdown bytes across pages; the page that crosses it is the last kept. */
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024
/** Whole-crawl budget, on Effect's clock: pages captured after it are not kept. */
export const DEADLINE_MILLIS = 5 * 60_000
/** Captures in flight at once. Two: a crawl is many requests to one host, and it should be polite. */
export const CONCURRENCY = 2

export interface CrawlOptions {
  readonly maxPages?: number | undefined
  readonly maxDepth?: number | undefined
}

export const CrawledPage = Schema.Struct({
  url: Schema.String,
  /** 0 for the start page. */
  depth: Schema.Number,
  markdown: Schema.String
})
export type CrawledPage = typeof CrawledPage.Type

/** Why a crawl stopped before running out of links. */
export const StopReason = Schema.Literals(["pages", "depth", "bytes", "deadline"])
export type StopReason = typeof StopReason.Type

export const CrawlResult = Schema.Struct({
  pages: Schema.Array(CrawledPage),
  /** Pages that failed to capture, with the failure's tag; the crawl went on. */
  failed: Schema.Array(Schema.Struct({ url: Schema.String, error: Schema.String })),
  /** Present when a bound ended the crawl with links still unvisited. */
  stoppedBy: Schema.optional(StopReason)
})
export type CrawlResult = typeof CrawlResult.Type

/** The start page could not be captured; there was nothing to crawl from. */
export class WebCrawlStartError extends
  Schema.TaggedError<WebCrawlStartError>()(
    "@doeixd/effect-agent/web/WebCrawlStartError",
    { url: Schema.String, cause: Schema.String }
  ) {
  override get message() {
    return `Web crawl could not capture its start page ${this.url}: ${this.cause}`
  }
}

export type WebCrawlError = WebCrawlStartError | WebCapture.WebCaptureInvalidUrlError | WebCapture.WebCaptureDeniedTargetError

export interface Service {
  readonly crawl: (url: URL, options?: CrawlOptions) => Effect.Effect<CrawlResult, WebCrawlError>
}

export class WebCrawl extends Context.Service<WebCrawl, Service>()(
  "@doeixd/effect-agent/web/WebCrawl"
) {}

const clamp = (asked: number | undefined, fallback: number, ceiling: number): number =>
  asked === undefined || !Number.isFinite(asked) || asked < 1 ? Math.min(fallback, ceiling) : Math.min(Math.floor(asked), ceiling)

const sameHost = (a: URL, b: URL): boolean => a.protocol === b.protocol && a.host === b.host

const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength

/**
 * The crawler over whatever `WebCapture` is provided.
 *
 * The start page's failure is the crawl's failure; every later page's
 * failure is a row in `failed`. Links are normalised by dropping the
 * fragment and are visited once. The deadline is checked before each
 * capture is *kept*, on Effect's clock, so a `TestClock` can state it.
 */
export const make: Effect.Effect<Service, never, WebCapture.WebCapture> = Effect.gen(function* () {
  const capture = yield* WebCapture.WebCapture

  const crawl: Service["crawl"] = (start, options) =>
    Effect.gen(function* () {
      const maxPages = clamp(options?.maxPages, DEFAULT_PAGES, MAX_PAGES)
      const maxDepth = clamp(options?.maxDepth, DEFAULT_DEPTH, MAX_DEPTH)
      const startedAt = yield* Clock.currentTimeMillis
      const deadline = startedAt + DEADLINE_MILLIS

      const normalise = (candidate: string, base: URL): URL | undefined => {
        try {
          const url = new URL(candidate, base)
          url.hash = ""
          return (url.protocol === "http:" || url.protocol === "https:") && sameHost(url, start) ? url : undefined
        } catch {
          return undefined
        }
      }

      const origin = new URL(start.href)
      origin.hash = ""
      const first = yield* capture.capture(origin).pipe(
        Effect.catch((error): Effect.Effect<never, WebCrawlError> =>
          error._tag === "@doeixd/effect-agent/web/WebCaptureInvalidUrlError" ||
            error._tag === "@doeixd/effect-agent/web/WebCaptureDeniedTargetError"
            ? Effect.fail(error)
            : Effect.fail(new WebCrawlStartError({ url: WebCapture.diagnosticTarget(origin), cause: error._tag })))
      )

      const pages: Array<CrawledPage> = [{ url: first.url, depth: 0, markdown: first.markdown }]
      const failed: Array<{ url: string; error: string }> = []
      const seen = new Set<string>([origin.href])
      let bytes = byteLength(first.markdown)
      let stoppedBy: StopReason | undefined
      // The frontier: links of the last captured layer, with their depth.
      const frontier: Array<{ url: URL; depth: number }> = []
      const enqueue = (links: ReadonlyArray<string>, base: URL, depth: number) => {
        for (const link of links) {
          const url = normalise(link, base)
          if (url === undefined || seen.has(url.href)) continue
          seen.add(url.href)
          frontier.push({ url, depth })
        }
      }
      enqueue(first.links, origin, 1)

      while (frontier.length > 0 && stoppedBy === undefined) {
        if (pages.length >= maxPages) {
          stoppedBy = "pages"
          break
        }
        const batch = frontier.splice(0, Math.min(CONCURRENCY, maxPages - pages.length))
        if (batch.every((entry) => entry.depth > maxDepth)) {
          stoppedBy = "depth"
          break
        }
        const within = batch.filter((entry) => entry.depth <= maxDepth)
        const captured = yield* Effect.forEach(
          within,
          (entry) => Effect.map(Effect.result(capture.capture(entry.url)), (result) => ({ entry, result })),
          { concurrency: CONCURRENCY }
        )
        for (const { entry, result } of captured) {
          if (result._tag === "Failure") {
            failed.push({ url: entry.url.href, error: result.failure._tag })
            continue
          }
          const now = yield* Clock.currentTimeMillis
          if (now >= deadline) {
            stoppedBy = "deadline"
            break
          }
          const size = byteLength(result.success.markdown)
          if (bytes + size > MAX_TOTAL_BYTES) {
            stoppedBy = "bytes"
            break
          }
          bytes = bytes + size
          pages.push({ url: result.success.url, depth: entry.depth, markdown: result.success.markdown })
          enqueue(result.success.links, entry.url, entry.depth + 1)
          if (pages.length >= maxPages && frontier.length > 0) {
            stoppedBy = "pages"
            break
          }
        }
        if (stoppedBy === undefined && frontier.length > 0 && frontier.every((entry) => entry.depth > maxDepth)) {
          stoppedBy = "depth"
        }
      }

      return {
        pages,
        failed,
        ...(stoppedBy === undefined ? {} : { stoppedBy })
      } satisfies CrawlResult
    })

  return { crawl }
})

/** The crawler, over whatever `WebCapture` is provided. Portable. */
export const layer: Layer.Layer<WebCrawl, never, WebCapture.WebCapture> = Layer.effect(WebCrawl, make)

/** Provide an already-constructed crawl service, for a double. */
export const layerService = (service: Service): Layer.Layer<WebCrawl> => Layer.succeed(WebCrawl)(service)

/** How long a crawl may take, as a `Duration`, for a caller wrapping it. */
export const deadline: Duration.Duration = Duration.millis(DEADLINE_MILLIS)
