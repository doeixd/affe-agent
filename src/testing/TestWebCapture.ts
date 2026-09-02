import { Effect, Layer } from "effect"
import * as WebCapture from "../web/WebCapture.js"

/**
 * Deterministic canned capture provider for agent/tool tests.
 *
 * Keyed by URL (fragment dropped), so a scripted site is a map from page to
 * rendering; an unknown page fails as a provider would for a page that does
 * not exist. `WebCrawl.layer` over this is how a crawl is tested without a
 * renderer.
 */
export const layer = (
  pages: Readonly<Record<string, WebCapture.CaptureResult>>
): Layer.Layer<WebCapture.WebCapture> =>
  WebCapture.layer({
    capture: (url) => {
      const key = new URL(url.href)
      key.hash = ""
      const page = pages[key.href]
      return page === undefined
        ? Effect.fail(
          new WebCapture.WebCaptureResponseError({
            url: WebCapture.diagnosticTarget(url),
            status: 404,
            detail: "no such scripted page"
          })
        )
        : Effect.succeed({ ...page, links: [...page.links] })
    }
  })
