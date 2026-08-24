import { Effect, Layer } from "effect"
import * as WebSearch from "../web/WebSearch.js"

/**
 * Deterministic canned provider for agent/tool tests.
 *
 * It performs no I/O and returns a fresh array so callers cannot mutate the
 * canned value observed by a later search.
 */
export const layer = (
  results: ReadonlyArray<WebSearch.SearchResult>
): Layer.Layer<WebSearch.WebSearch> =>
  WebSearch.layer({
    search: () => Effect.succeed([...results])
  })
