import { Config, Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import { AgentState } from "../src/state/index.js"

/**
 * Persistent, typed agent state: a plan the agent fills in as it works.
 *
 * Typechecked, not executed. The point is that nothing here touches the engine.
 * The plan is an ordinary typed service (`AgentState.Tag`); a tool records
 * steps into it; a `ContextTransform` shows the model the plan each turn; and a
 * store makes it outlive the process. Swap the store's layer and the same agent
 * runs against SQLite instead of a map -- one line, like every other seam.
 */

interface Plan {
  readonly goal: string
  readonly steps: ReadonlyArray<string>
}
const PlanSchema = Schema.Struct({ goal: Schema.String, steps: Schema.Array(Schema.String) })

// A tag for the plan type, and a tool that appends a step. The tool declares
// the state as a dependency, exactly as a coding tool declares the sandbox.
const Plan = AgentState.Tag<Plan>("example/Plan")

const RecordStep = Tool.make("record_step", {
  description: "Append a step to the running plan.",
  parameters: Schema.Struct({ step: Schema.String }),
  success: Schema.String,
  dependencies: [Plan]
})
const recordStep = Agent.tool(RecordStep, ({ step }) =>
  AgentState.update(Plan, (plan) => ({ ...plan, steps: [...plan.steps, step] })).pipe(
    Effect.as("recorded"),
    // A persisted state writes through on every mutation, so this can fail.
    // The model is the right audience: it can try again or carry on without
    // the step recorded, which a defect would not have let it do.
    Effect.catchTag("StorageError", (error) =>
      Effect.succeed(`could not record the step: ${error.detail}`)
    )
  ))

const Planner = Agent.make({
  instructions: "Plan before you act. Record each step you decide on.",
  tools: [recordStep],
  // The model sees the current plan every turn, derived from live state --
  // canonical history is never touched.
  contextTransform: AgentState.transform(
    Plan,
    (plan) => `Goal: ${plan.goal}\nPlan so far:\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
  )
})

const program = Effect.scoped(
  Effect.flatMap(AgentSession.make(Planner), (session) =>
    AgentSession.prompt(session, "Ship the new endpoint."))
)

const model = AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer)
)

// Ephemeral: the plan starts fresh each process.
const ephemeral = program.pipe(
  Effect.provide(
    Layer.merge(AgentState.layer(Plan, { initial: { goal: "Ship the new endpoint.", steps: [] } }), model)
  )
)

// Persistent: the same agent, but the plan is keyed per user and stored in
// SQLite, so a later run for the same user resumes where this one left off.
const persistent = Effect.gen(function* () {
  const store = yield* AgentState.sqlStoreWithTable()
  return yield* program.pipe(
    Effect.provide(
      AgentState.layer(Plan, {
        initial: { goal: "Ship the new endpoint.", steps: [] },
        persistence: { schema: PlanSchema, store, key: "plan:user-42" }
      })
    )
  )
}).pipe(Effect.provide(Layer.merge(model, SqliteClient.layer({ filename: "agent-state.db" }))))

void ephemeral
void persistent
