import { Config, Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { CodingToolkit } from "../src/coding/index.js"
import * as ContextTransform from "../src/ContextTransform.js"
import { Memory } from "../src/memory/index.js"
import * as Permission from "../src/Permission.js"
import * as LocalSandbox from "../src/sandbox/local.js"
import * as Sandbox from "../src/sandbox/Sandbox.js"
import { Skills } from "../src/skills/index.js"
import { AgentState } from "../src/state/index.js"
import * as ToolExecution from "../src/ToolExecution.js"

/**
 * The whole higher-level stack in one agent.
 *
 * Typechecked, not executed. Its job is to show that the packages compose with
 * no glue: one `Agent.make`, and each capability arrives through the ordinary
 * seams -- tools, a composed `ContextTransform`, a `Permission` policy -- with
 * every requirement flowing into one merged layer. Swap the model layer for a
 * test double and the same agent is deterministically evaluable
 * (`examples/evals.ts`, `test/Integration.test.ts`).
 */

const userId = "user-42"

interface Plan {
  readonly steps: ReadonlyArray<string>
}
const Plan = AgentState.Tag<Plan>("app/Plan")

const RecordStep = Tool.make("record_step", {
  description: "Record a step in the plan.",
  parameters: Schema.Struct({ step: Schema.String }),
  success: Schema.String,
  dependencies: [Plan]
})

// One agent, four capabilities: coding tools over the sandbox, skills, memory,
// and a typed plan -- plus a policy that gates every projected action.
const Assistant = Agent.make({
  instructions: "You are a coding assistant. Load a skill before acting on it, and record your plan.",
  tools: [
    Agent.tool(CodingToolkit.ReadFile, CodingToolkit.handlers.read_file),
    Agent.tool(CodingToolkit.WriteFile, CodingToolkit.handlers.write_file),
    Agent.tool(CodingToolkit.EditFile, CodingToolkit.handlers.edit_file),
    Skills.loadTool,
    Memory.rememberTool(userId),
    Agent.tool(RecordStep, ({ step }) =>
      AgentState.update(Plan, (plan) => ({ steps: [...plan.steps, step] })).pipe(Effect.as("recorded")))
  ],
  contextTransform: ContextTransform.compose(
    Skills.advertise,
    Memory.recall(userId),
    AgentState.transform(Plan, (plan) => `Plan so far: ${plan.steps.join("; ") || "(empty)"}`)
  ),
  permission: Permission.rules(
    [
      { action: "write", resource: /\.env$/, decision: Permission.deny("never write secrets") },
      { action: "shell", resource: /rm -rf/, decision: Permission.deny("destructive") }
    ],
    { otherwise: Permission.allow }
  ),
  toolDenialPolicy: ToolExecution.ReturnToModel,
  loop: AgentLoop.bounded(20)
})

const program = Effect.scoped(
  Effect.flatMap(AgentSession.make(Assistant), (session) =>
    AgentSession.prompt(session, "Fix the failing test in src/add.test.ts."))
)

// Every capability's implementation is chosen here, in one merged layer, and
// the agent never mentions any of it. Swap any single layer -- a real memory
// backend, an in-memory sandbox for tests -- and nothing above changes.
const model = AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer)
)

export const main = program.pipe(
  Effect.provide(Layer.mergeAll(
    model,
    Skills.layer([
      Skills.skill({
        id: "tdd",
        name: "Test-driven fixes",
        description: "How to fix a failing test without breaking others.",
        body: "Read the test, run it, change one thing, run the whole suite."
      })
    ]),
    Memory.layer(),
    AgentState.layer(Plan, { initial: { steps: [] } }),
    Sandbox.currentLayer(Sandbox.workspace("project")).pipe(Layer.provide(LocalSandbox.layer()))
  ))
)
