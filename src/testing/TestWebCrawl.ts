import { Effect, Layer } from "effect"
import * as WebCrawl from "../web/WebCrawl.js"

/** Deterministic canned crawl service for tool tests; returns a fresh copy each call. */
export const layer = (result: WebCrawl.CrawlResult): Layer.Layer<WebCrawl.WebCrawl> =>
  WebCrawl.layerService({
    crawl: () => Effect.succeed({ ...result, pages: [...result.pages], failed: [...result.failed] })
  })
