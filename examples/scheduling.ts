import { Config, Effect, Layer, Schedule, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import { Scheduling } from "../src/scheduling/index.js"

/**
 * Scheduling and self-dispatch over Effect's own primitives.
 *
 * Typechecked, not executed. Two shapes: a tool that enqueues a follow-up run
 * through the `AgentDispatcher` seam (self-dispatch, without touching timers),
 * and a recurring digest via `Scheduling.recurring` over a `Schedule.cron`.
 * A durable deployment swaps `Scheduling.local` for a Workflow/queue
 * implementation of the same `AgentDispatcher` -- the agent does not change.
 */

// A tool the model calls to schedule a follow-up. It depends on the dispatcher
// seam, not on any timer.
const ScheduleFollowUp = Tool.make("schedule_follow_up", {
  description: "Schedule a follow-up message to yourself, after a delay.",
  parameters: Schema.Struct({ prompt: Schema.String, afterMinutes: Schema.Number }),
  success: Schema.String,
  dependencies: [Scheduling.AgentDispatcher]
})
const scheduleFollowUp = Agent.tool(ScheduleFollowUp, ({ afterMinutes, prompt }) =>
  Scheduling.dispatch({ input: prompt, delay: `${afterMinutes} minutes` }).pipe(Effect.as("scheduled")))

const Assistant = Agent.make({
  instructions: "You are an assistant that can schedule follow-ups for itself.",
  tools: [scheduleFollowUp]
})

const model = AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer)
)

// Self-dispatch: the assistant, with an in-process dispatcher that runs the
// same agent for its follow-ups. A durable dispatcher would be the only swap.
const conversation = Effect.scoped(
  Effect.flatMap(AgentSession.make(Assistant), (session) =>
    AgentSession.prompt(session, "Remind me to review the PR in 10 minutes."))
).pipe(
  Effect.provide(Layer.merge(model, Scheduling.local(Assistant).pipe(Layer.provide(model))))
)

// A recurring job: a daily digest at 09:00, resiliently (a failed run is logged
// and the schedule continues). Fork it into the app's scope.
const Digest = Agent.make({ instructions: "Summarise what changed since yesterday." })
const dailyDigest = Effect.forkScoped(
  Scheduling.recurring(Digest, "produce today's digest", Schedule.cron("0 9 * * *"))
).pipe(Effect.provide(model))

// The durable swap: `queued` persists each dispatched job to a `JobStore` and a
// `worker` (possibly in another process) runs it, so a scheduled follow-up
// survives a restart. `dispatch` and the tool that calls it do not change — only
// the layer does. Provide a durable `JobStore` (a SQL table) in production;
// `memoryStore` is the single-node one.
const durableSelfDispatch = Effect.gen(function* () {
  const store = yield* Scheduling.memoryStore
  // Run the workers beside the app; scale them horizontally over the same store.
  yield* Effect.forkScoped(Scheduling.worker(Assistant, store).pipe(Effect.provide(model)))
  return yield* AgentSession.make(Assistant).pipe(
    Effect.flatMap((session) => AgentSession.prompt(session, "Remind me to review the PR in 10 minutes.")),
    Effect.provide(Layer.merge(model, Scheduling.queued(store)))
  )
})

export const main = conversation
void dailyDigest
void durableSelfDispatch
