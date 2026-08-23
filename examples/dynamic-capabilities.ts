import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Config, Context, Effect, Layer, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"

/**
 * Dynamic capabilities: a toolkit resolved per turn from runtime state.
 *
 * Typechecked, not executed. An agent's `toolkit` may be a plain value or an
 * `Effect`. In the Effect form the harness re-resolves it **once per turn**, so
 * the tools -- and the state their handlers close over -- can vary with whatever
 * the resolver reads: the current tenant, a feature flag, a freshly-fetched
 * credential, a per-tenant MCP connection. Because it is an ordinary Effect, the
 * resolver may also *fail*, and that failure joins the agent's own error channel
 * rather than becoming a defect (see `test/ToolkitResolution.test.ts`).
 *
 * Here the `search` tool always exists, but which index it searches is read from
 * a `Tenant` service at turn time -- so one agent definition serves every tenant,
 * and switching the provided `Tenant` layer switches what the tool can reach.
 */

// Runtime state the toolkit depends on: who the request is for.
class Tenant extends Context.Service<Tenant, {
  readonly id: string
  readonly searchIndex: string
}>()("example/Tenant") {}

const Search = Tool.make("search", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.Struct({ hits: Schema.Array(Schema.String) })
})

// The toolkit is an Effect: it reads the current `Tenant` and builds a toolkit
// whose handler is scoped to that tenant's index. Re-resolved every turn, so a
// long-lived session always acts for the tenant in context now.
const perTenantToolkit = Effect.flatMap(Tenant, (tenant) =>
  Agent.toolkit([Search], {
    search: ({ query }) =>
      Effect.succeed({ hits: [`[${tenant.searchIndex}] result for "${query}"`] })
  }))

// One definition for every tenant. `Tenant` surfaces in the agent's requirements
// (through the toolkit's Effect), so a session that forgets to provide it is a
// type error, not a runtime surprise.
const Assistant = Agent.make({
  instructions: "Answer using the search tool; it is scoped to the caller's tenant.",
  toolkit: perTenantToolkit
})

const model = AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer)
)

// Switching the provided Tenant layer switches what every tool call can reach --
// the agent definition never changes.
const acmeTenant = Layer.succeed(Tenant, { id: "acme", searchIndex: "acme-docs" })

export const main = Effect.scoped(
  Effect.flatMap(AgentSession.make(Assistant), (session) =>
    AgentSession.prompt(session, "find the refund policy"))
).pipe(Effect.provide(Layer.mergeAll(model, acmeTenant)))
