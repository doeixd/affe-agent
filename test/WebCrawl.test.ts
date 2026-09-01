import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { TestWebCapture } from "../src/testing/index.js"
import { WebCapture, WebCrawl } from "../src/web/index.js"

/**
 * The crawler over a scripted site: breadth-first, same host, every bound
 * at its boundary, and one bad page not ending the crawl.
 */

const page = (url: string, links: ReadonlyArray<string>, markdown = `# ${url}`): [string, WebCapture.CaptureResult] =>
  [url, { url, markdown, links }]

const siteOf = (...pages: ReadonlyArray<[string, WebCapture.CaptureResult]>) =>
  TestWebCapture.layer(Object.fromEntries(pages))

const crawlWith = (capture: Layer.Layer<WebCapture.WebCapture>, url: string, options?: WebCrawl.CrawlOptions) =>
  Effect.flatMap(WebCrawl.WebCrawl, (service) => service.crawl(new URL(url), options)).pipe(
    Effect.provide(WebCrawl.layer.pipe(Layer.provide(capture)))
  )

const urls = (result: WebCrawl.CrawlResult) => result.pages.map((p) => `${p.depth}:${p.url}`)

describe("WebCrawl", () => {
  it.effect("follows same-host links breadth-first, once each, and returns cross-host links unfollowed", () =>
    Effect.gen(function* () {
      const site = siteOf(
        page("https://example.com/", ["/a", "https://example.com/b#frag", "https://other.example/x", "mailto:x@y"]),
        page("https://example.com/a", ["/", "/c"]),
        page("https://example.com/b", ["/c"]),
        page("https://example.com/c", [])
      )
      const result = yield* crawlWith(site, "https://example.com/")
      assert.deepStrictEqual(urls(result), [
        "0:https://example.com/",
        "1:https://example.com/a",
        "1:https://example.com/b",
        "2:https://example.com/c"
      ])
      assert.deepStrictEqual(result.failed, [])
      assert.isUndefined(result.stoppedBy)
    })
  )

  it.effect("a page that fails to capture is recorded and the crawl goes on", () =>
    Effect.gen(function* () {
      const site = siteOf(
        page("https://example.com/", ["/gone", "/ok"]),
        page("https://example.com/ok", [])
      )
      const result = yield* crawlWith(site, "https://example.com/")
      assert.deepStrictEqual(urls(result), ["0:https://example.com/", "1:https://example.com/ok"])
      assert.deepStrictEqual(result.failed, [
        { url: "https://example.com/gone", error: "@doeixd/effect-agent/web/WebCaptureResponseError" }
      ])
    })
  )

  it.effect("the start page's failure is the crawl's failure", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(crawlWith(siteOf(), "https://example.com/"))
      assert.strictEqual(error._tag, "@doeixd/effect-agent/web/WebCrawlStartError")
    })
  )

  it.effect("stops at the page bound, and clamps a request above the ceiling", () =>
    Effect.gen(function* () {
      const chain = Array.from({ length: 6 }, (_, i) =>
        page(`https://example.com/${i}`, i < 5 ? [`/${i + 1}`] : []))
      const site = siteOf(...chain)
      const bounded = yield* crawlWith(site, "https://example.com/0", { maxPages: 3 })
      assert.strictEqual(bounded.pages.length, 3)
      assert.strictEqual(bounded.stoppedBy, "pages")
      // Asked for more than the ceiling: the ceiling applies, silently.
      const clamped = yield* crawlWith(site, "https://example.com/0", { maxPages: WebCrawl.MAX_PAGES * 10, maxDepth: WebCrawl.MAX_DEPTH * 10 })
      assert.strictEqual(clamped.pages.length, 6)
      assert.isUndefined(clamped.stoppedBy)
    })
  )

  it.effect("stops at the depth bound", () =>
    Effect.gen(function* () {
      const site = siteOf(
        page("https://example.com/", ["/d1"]),
        page("https://example.com/d1", ["/d2"]),
        page("https://example.com/d2", ["/d3"]),
        page("https://example.com/d3", [])
      )
      const result = yield* crawlWith(site, "https://example.com/", { maxDepth: 1 })
      assert.deepStrictEqual(urls(result), ["0:https://example.com/", "1:https://example.com/d1"])
      assert.strictEqual(result.stoppedBy, "depth")
    })
  )

  it.effect("stops at the byte bound; the page that would cross it is not kept", () =>
    Effect.gen(function* () {
      // "start" is five bytes; with this the pair lands exactly on the ceiling,
      // and the five-byte page after it is the one that would cross.
      const big = "x".repeat(WebCrawl.MAX_TOTAL_BYTES - 5)
      const site = siteOf(
        page("https://example.com/", ["/big", "/small"], "start"),
        page("https://example.com/big", [], big),
        page("https://example.com/small", [], "small")
      )
      const result = yield* crawlWith(site, "https://example.com/")
      assert.deepStrictEqual(result.pages.map((p) => p.url), ["https://example.com/", "https://example.com/big"])
      assert.strictEqual(result.stoppedBy, "bytes")
    })
  )

  it.effect("stops at the deadline, on Effect's clock", () =>
    Effect.gen(function* () {
      // A renderer that takes the whole budget per page.
      const slow = WebCapture.layer({
        capture: (url) =>
          TestClock.adjust(Duration.millis(WebCrawl.DEADLINE_MILLIS)).pipe(
            Effect.as({ url: url.href, markdown: "slow", links: url.pathname === "/" ? ["/next", "/after"] : [] })
          )
      })
      const result = yield* crawlWith(slow, "https://example.com/")
      assert.strictEqual(result.pages.length, 1)
      assert.strictEqual(result.stoppedBy, "deadline")
    })
  )
})
