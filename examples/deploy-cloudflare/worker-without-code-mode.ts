import { Effect, Layer, Option, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { DurableObjectState } from "effect-cf"
import { Agent, AgentLoop } from "@doeixd/effect-agent"
import * as CloudflareHost from "@doeixd/effect-agent/cloudflare"
import { TestLanguageModel } from "@doeixd/effect-agent/testing"

/**
 * `apps/worker` minus the code tool: the entry a Workers *free* plan can
 * run. Dynamic Workers (the `LOADER` binding the isolate executor loads
 * programs through) is the one part of the host that needs a paid plan
 * (Cloudflare error 10195 at deploy); SQLite-backed Durable Objects,
 * alarms and everything else in `@doeixd/effect-agent/cloudflare` are
 * available on free. This is what proved the host on real Cloudflare on
 * 2026-09-02 (`docs/status-history.md`), and what a deployment on the free
 * plan copies. Everything else is `apps/worker` verbatim; the model is
 * still the scripted one, swapped for a provider layer exactly as that
 * file's header says.
 */

const Echo = Tool.make("echo", {
  description: "Echo the text back",
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.String
})

const agent = Agent.make({
  instructions: "You are a helpful assistant running inside a Durable Object.",
  tools: [Agent.tool(Echo, ({ text }) => Effect.succeed(`echoed: ${text}`))],
  loop: AgentLoop.bounded(4)
})

/** One answer per object instance, named so the smoke can tell them apart. */
const scriptedModel = Layer.unwrap(
  Effect.gen(function* () {
    const state = yield* DurableObjectState.DurableObjectState
    const name = Option.getOrElse(Option.fromNullishOr(state.id.name), () => "unnamed")
    const { layer } = yield* TestLanguageModel.script([
      TestLanguageModel.toolCall("echo", { text: name }, { id: "echo-1" }),
      TestLanguageModel.text(`hello from ${name}`),
      TestLanguageModel.text("second reply")
    ])
    return layer
  })
)

const host = CloudflareHost.make({ agent, layer: scriptedModel })

export const AgentSessionObject = host.SessionObject
export default host.Worker
