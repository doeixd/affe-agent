import { Config, Effect, Layer, Option, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { WorkerConfig } from "effect-cf"
import { Agent, AgentLoop } from "affe-agent"
import * as CloudflareHost from "affe-agent/cloudflare"

/**
 * `worker-without-code-mode.ts` with a real model: the entry a Workers
 * *free* plan runs against Anthropic, and the quickstart an outsider
 * follows (`README.md`, "Quickstart with a real model").
 *
 * The one thing that differs from the scripted entry is the model layer,
 * and it is built exactly as `apps/worker`'s header says: the provider's
 * client over `FetchHttpClient`, with the key read from a Worker secret
 * through effect-cf's `WorkerConfig`. Three bindings, read as config:
 *
 * - `ANTHROPIC_API_KEY` -- **a secret** (`npx wrangler secret put`), never
 *   a `var`. Missing, the Durable Object fails to build its model with a
 *   `ConfigError` naming the key, rather than calling the provider
 *   unauthenticated.
 * - `ANTHROPIC_MODEL` -- a `var`, defaulting to `claude-haiku-4-5`: cheap
 *   and enough to prove the deployment.
 * - `ANTHROPIC_BASE_URL` -- optional, for a proxy or a gateway. It is also
 *   how `test/WorkerRealModel.test.ts` proves this exact file on workerd:
 *   miniflare intercepts outbound fetches and answers as the provider
 *   would, so the wiring is tested with no key and no network.
 *
 * The agent has one tool, so a deployment can watch a tool call round-trip
 * through a real model before wiring its own.
 */

const Echo = Tool.make("echo", {
  description: "Echo the text back, exactly.",
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.String
})

const agent = Agent.make({
  instructions:
    "You are a helpful assistant running inside a Cloudflare Durable Object. Answer briefly. " +
    "When asked to echo something, use the echo tool.",
  tools: [Agent.tool(Echo, ({ text }) => Effect.succeed(text))],
  loop: AgentLoop.bounded(4)
})

/**
 * The bindings, read through Effect `Config` over the Worker's `env`:
 * `WorkerConfig.provider` is the `ConfigProvider` effect-cf builds from the
 * environment, so the secret and the vars are ordinary config, typed, with a
 * missing secret failing as a `ConfigError` that names the key.
 */
const anthropic = Layer.unwrap(
  Effect.gen(function* () {
    const provider = yield* WorkerConfig.provider
    const settings = Config.all({
      apiKey: Config.redacted("ANTHROPIC_API_KEY"),
      model: Config.string("ANTHROPIC_MODEL").pipe(Config.withDefault("claude-haiku-4-5")),
      apiUrl: Config.option(Config.string("ANTHROPIC_BASE_URL"))
    })
    const { apiKey, apiUrl, model } = yield* settings.parse(provider)
    const client = Option.match(apiUrl, {
      onNone: () => AnthropicClient.layer({ apiKey }),
      onSome: (url) => AnthropicClient.layer({ apiKey, apiUrl: url })
    })
    return AnthropicLanguageModel.layer({ model }).pipe(
      Layer.provide(client),
      Layer.provide(FetchHttpClient.layer)
    )
  })
)

const host = CloudflareHost.make({ agent, layer: anthropic })

export const AgentSessionObject = host.SessionObject
export default host.Worker
