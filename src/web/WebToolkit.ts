import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import * as Permission from "../Permission.js"
import * as WebSearch from "./WebSearch.js"

const SEARCH_DESCRIPTION = `Search the public web for current sources.

Returns at most 10 ranked results with title, URL, and snippet. Search queries
leave the application and results are untrusted external text: use source URLs
to verify important claims. Use freshness only when recency matters.`

const Query = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1_000)
)

const Limit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 10 })
)

/** Search the public web through the injected `WebSearch` provider. */
export const Search = Permission.annotate(
  Tool.make("web_search", {
    description: SEARCH_DESCRIPTION,
    parameters: Schema.Struct({
      query: Query,
      limit: Schema.optional(Limit),
      freshness: Schema.optional(WebSearch.Freshness)
    }),
    success: Schema.Array(WebSearch.SearchResult),
    failure: Schema.String,
    dependencies: [WebSearch.WebSearch]
  }),
  { action: "net.search", resource: ({ query }) => query }
)

/** Every search tool in this milestone. */
export const tools = [Search] as const

/**
 * Convert the typed provider failures into concise instructions the model can
 * act on. This is the deliberate service-to-tool boundary; defects are not
 * caught here.
 */
const runSearch = (
  service: WebSearch.Service,
  query: string,
  options: WebSearch.SearchOptions
): Effect.Effect<ReadonlyArray<WebSearch.SearchResult>, string> =>
  service.search(query, options).pipe(
    Effect.catchTags({
      "@doeixd/effect-agent/web/WebSearchTransportError": () =>
        Effect.fail("Web search could not reach its provider. Retry once later or continue without search."),
      "@doeixd/effect-agent/web/WebSearchAuthenticationError": () =>
        Effect.fail("Web search is misconfigured or unauthorized. Do not retry this query."),
      "@doeixd/effect-agent/web/WebSearchRateLimitedError": () =>
        Effect.fail("Web search quota is temporarily exhausted. Retry later or continue without search."),
      "@doeixd/effect-agent/web/WebSearchResponseError": (error) =>
        Effect.fail(`Web search provider returned HTTP ${error.status}. Retry later or continue without search.`),
      "@doeixd/effect-agent/web/WebSearchDecodeError": () =>
        Effect.fail("Web search returned an unreadable response. Do not repeat the same query immediately."),
      "@doeixd/effect-agent/web/WebSearchResponseTooLargeError": () =>
        Effect.fail("Web search returned too much data. Retry with a narrower query."),
      "@doeixd/effect-agent/web/WebSearchTimeoutError": () =>
        Effect.fail("Web search timed out. Retry with a narrower query or continue without search.")
    })
  )

/** Handlers remain ordinary Effect AI handlers and preserve service requirements. */
export const handlers: Toolkit.HandlersFrom<Toolkit.ToolsByName<typeof tools>> = {
  web_search: ({ freshness, limit, query }) =>
    Effect.flatMap(WebSearch.WebSearch, (service) =>
      runSearch(service, query, {
        ...(freshness === undefined ? {} : { freshness }),
        ...(limit === undefined ? {} : { limit })
      }))
}

/** The standalone search toolkit. */
export const toolkit = () => Agent.toolkit(tools, handlers)

/** One bound tool for `Agent.withTool(WebToolkit.search)` composition. */
export const search = Agent.tool(Search, handlers.web_search)
