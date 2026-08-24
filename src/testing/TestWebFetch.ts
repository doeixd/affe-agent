import { Effect, Layer } from "effect"
import * as WebFetch from "../web/WebFetch.js"

/** Deterministic canned fetch provider for agent/tool tests. */
export const layer = (
  result: WebFetch.FetchResult
): Layer.Layer<WebFetch.WebFetch> =>
  WebFetch.layer({
    fetch: () => Effect.succeed({ ...result })
  })
