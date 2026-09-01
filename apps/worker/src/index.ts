import { Effect, Layer } from "effect"
import { Agent, AgentLoop } from "@doeixd/effect-agent"
import * as CloudflareHost from "@doeixd/effect-agent/cloudflare"
import { TestLanguageModel } from "@doeixd/effect-agent/testing"
import { Tool } from "effect/unstable/ai"
import { Schema } from "effect"

/**
 * The reference Worker: `@doeixd/effect-agent/cloudflare` with the scripted
 * model, so it runs on plain workerd in CI with no provider key
 * (`test/WorkerDurableObject.test.ts`, through miniflare). A real
 * deployment swaps `scriptedModel` for a provider layer -- for Anthropic,
 * `AnthropicLanguageModel.layer(...)` over `FetchHttpClient.layer`, with the
 * key read from a Worker secret through `WorkerEnvironment` -- and keeps
 * everything else.
 *
 * What the host does -- one Durable Object per session, history in DO
 * SQLite at every committed turn, events journaled to the delivery log,
 * `events?after=N` gapless across hibernation and death, dispatched work
 * as logical alarms -- is the entry's, documented and tested there. This
 * file is what a deployment writes.
 */

/** A tool with no effect, so the scripted model can drive a multi-turn run. */
const Tick = Tool.make("tick", {
  description: "Advance one step.",
  parameters: Schema.Struct({}),
  success: Schema.String
})

const agent = Agent.make({
  instructions: "You are a helpful assistant running inside a Durable Object.",
  tools: [Agent.tool(Tick, () => Effect.succeed("tick"))],
  loop: AgentLoop.bounded(4)
})

/**
 * The script is per object instance: a fresh runtime starts it again. The
 * first call answers in text; the second prompt in a life runs two tool
 * turns and then hangs, which is how the test leaves a run mid-flight when
 * it kills the runtime.
 */
const scriptedModel = Layer.unwrap(
  Effect.map(
    TestLanguageModel.script([
      TestLanguageModel.text("reply-1"),
      TestLanguageModel.toolCall("tick", {}, { id: "tick-1" }),
      TestLanguageModel.toolCall("tick", {}, { id: "tick-2" }),
      { hang: true },
      ...Array.from({ length: 60 }, (_, index) => TestLanguageModel.text(`reply-${index + 2}`))
    ]),
    ({ layer }) => layer
  )
)

const host = CloudflareHost.make({ agent, layer: scriptedModel })

/** Bound as `SESSIONS` in `wrangler.jsonc` / the Alchemy stack. */
export const AgentSessionObject = host.SessionObject
export default host.Worker
