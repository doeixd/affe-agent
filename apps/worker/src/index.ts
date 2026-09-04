import { Context, Effect, Layer, Option, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { DurableObjectState } from "effect-cf"
import { Agent, AgentLoop, Permission } from "affe-agent"
import * as CloudflareHost from "affe-agent/cloudflare"
import { CodeTool } from "affe-agent/code"
import type { CodeMode } from "affe-agent/code"
import { TestLanguageModel } from "affe-agent/testing"

/**
 * The reference Worker: `affe-agent/cloudflare` with the scripted
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
 * as logical alarms, code mode in an isolate -- is the entry's, documented
 * and tested there. This file is what a deployment writes.
 */

/** A tool with no effect, so the scripted model can drive a multi-turn run. */
const Tick = Tool.make("tick", {
  description: "Advance one step.",
  parameters: Schema.Struct({}),
  success: Schema.String
})

const Echo = Tool.make("echo", {
  description: "Echo the text back",
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.String
})

/** The isolate executor, built once per object; the agent's toolkit reads it. */
class Executor extends Context.Service<Executor, CodeMode.CodeExecutor>()("apps/worker/Executor") {}

const agent = Agent.make({
  instructions: "You are a helpful assistant running inside a Durable Object.",
  // Resolved per turn from the object's environment: the code tool needs
  // the executor this object built, which a module-level toolkit cannot
  // hold. Everything else about the agent is a value.
  toolkit: Effect.gen(function* () {
    const executor = yield* Executor
    const data = yield* Agent.toolkit([Echo], { echo: ({ text }) => Effect.succeed(`echoed: ${text}`) })
    const execute = yield* CodeTool.tool({
      tools: { data },
      executor,
      permission: Permission.allowAll,
      limits: { maxToolCalls: 20 }
    })
    // Lowered the way `Agent.make({ tools })` lowers bound tools: the code
    // tool's name is a string the host chose, so the record is keyed by
    // `tools`, not written by hand.
    const lowered = Agent.make({ tools: [Agent.tool(Tick, () => Effect.succeed("tick")), execute] }).toolkit
    return Effect.isEffect(lowered) ? yield* lowered : lowered
  }),
  loop: AgentLoop.bounded(4)
})

/** The two programs the scripted model writes for a `code-*` session. */
const callsATool = `const answer = await tools.data.echo({ text: "hello from the isolate" })
return { answer }`
const reachesForTheNetwork = `try {
  await fetch("https://example.com/")
  return "reached the network"
} catch (error) {
  return "blocked: " + error.message
}`

/**
 * The script is per object instance and chosen by the object's name -- the
 * one thing a per-instance layer can do that a module-level one cannot.
 * A `code-*` session gets two programs and an answer; a `backlog-*` session
 * answers every prompt in one text turn, so a queue of dispatched jobs can
 * actually drain; every other session answers in text first, then on its
 * second prompt runs two tool turns and hangs, which is how the test leaves a
 * run mid-flight when it kills the runtime.
 */
const scriptedModel = Layer.unwrap(
  Effect.gen(function* () {
    const state = yield* DurableObjectState.DurableObjectState
    const name = Option.fromNullishOr(state.id.name)
    const code = Option.isSome(name) && name.value.startsWith("code-")
    // A `backlog-` session answers every prompt in one text turn and never
    // hangs. The default script deliberately hangs on its fourth model call,
    // which is what leaves a run mid-flight for the hibernation test -- and
    // which also means at most one dispatched job could ever *finish* under
    // it. A test about draining a queue of jobs needs turns that end.
    const backlog = Option.isSome(name) && name.value.startsWith("backlog-")
    const { layer } = yield* TestLanguageModel.script(
      backlog
        ? Array.from({ length: 20 }, (_, index) => TestLanguageModel.text(`ran-${index + 1}`))
        : code
        ? [
          { toolCalls: [{ id: "p1", name: "execute", params: { program: callsATool } }] },
          { toolCalls: [{ id: "p2", name: "execute", params: { program: reachesForTheNetwork } }] },
          TestLanguageModel.text("done")
        ]
        : [
          TestLanguageModel.text("reply-1"),
          TestLanguageModel.toolCall("tick", {}, { id: "tick-1" }),
          TestLanguageModel.toolCall("tick", {}, { id: "tick-2" }),
          { hang: true },
          ...Array.from({ length: 60 }, (_, index) => TestLanguageModel.text(`reply-${index + 2}`))
        ]
    )
    return layer
  })
)

const host = CloudflareHost.make({
  agent,
  layer: Layer.mergeAll(
    scriptedModel,
    Layer.effect(Executor, CloudflareHost.IsolateExecutor.executor())
  )
})

/** Bound as `SESSIONS` in `wrangler.jsonc` / the Alchemy stack; `LOADER` is the Worker Loader. */
export const AgentSessionObject = host.SessionObject
export default host.Worker
