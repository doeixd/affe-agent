import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Binding, WorkerEnvironment } from "effect-cf"
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
 * through `WorkerEnvironment`. Three bindings, read by name:
 *
 * - `ANTHROPIC_API_KEY` -- **a secret** (`npx wrangler secret put`), never
 *   a `var`. Missing, the Durable Object fails to build its model and says
 *   which binding it wanted, rather than calling the provider unauthenticated.
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

/** A string binding, or the failure that names it. */
const binding = (env: Record<string, unknown>, name: string) =>
  Option.fromNullishOr(env[name]).pipe(
    Option.filter((value): value is string => typeof value === "string" && value.length > 0)
  )

const anthropic = Layer.unwrap(
  Effect.gen(function* () {
    const env = (yield* WorkerEnvironment) as Record<string, unknown>
    const apiKey = yield* Option.match(binding(env, "ANTHROPIC_API_KEY"), {
      onNone: () =>
        new Binding.BindingNotFoundError({
          binding: "ANTHROPIC_API_KEY",
          message: "ANTHROPIC_API_KEY is not set: `npx wrangler secret put ANTHROPIC_API_KEY --config wrangler.real.jsonc`"
        }),
      onSome: (key) => Effect.succeed(key)
    })
    const model = Option.getOrElse(binding(env, "ANTHROPIC_MODEL"), () => "claude-haiku-4-5")
    const apiUrl = Option.getOrUndefined(binding(env, "ANTHROPIC_BASE_URL"))
    return AnthropicLanguageModel.layer({ model }).pipe(
      Layer.provide(AnthropicClient.layer({ apiKey: Redacted.make(apiKey), ...(apiUrl === undefined ? {} : { apiUrl }) })),
      Layer.provide(FetchHttpClient.layer)
    )
  })
)

const host = CloudflareHost.make({ agent, layer: anthropic })

export const AgentSessionObject = host.SessionObject
export default host.Worker
