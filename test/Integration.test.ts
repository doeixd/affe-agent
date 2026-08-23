import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { CodingToolkit } from "../src/coding/index.js"
import * as ContextTransform from "../src/ContextTransform.js"
import { Evals } from "../src/evals/index.js"
import { Memory } from "../src/memory/index.js"
import * as Permission from "../src/Permission.js"
import * as MemorySandbox from "../src/sandbox/memory.js"
import * as Sandbox from "../src/sandbox/Sandbox.js"
import { Skills } from "../src/skills/index.js"
import { AgentState } from "../src/state/index.js"
import { TestLanguageModel } from "../src/testing/index.js"
import * as ToolExecution from "../src/ToolExecution.js"

/**
 * The whole higher-level stack in one agent, proving the seven packages
 * compose: the coding toolkit over the sandbox, skills advertised and loaded on
 * demand, long-term memory recalled and written, typed state surfaced into the
 * prompt, all behind a permission policy -- and evals drives the run and asserts
 * on the behaviour. Deterministic throughout: a scripted model stands in for a
 * provider, so every seam is exercised exactly.
 */

const scope = "user-1"
const ws = Sandbox.workspace("project")

interface Plan {
  readonly steps: ReadonlyArray<string>
}
const Plan = AgentState.Tag<Plan>("integration/Plan")

// A state tool: record a plan step. The state tag is its dependency.
const RecordStep = Tool.make("record_step", {
  description: "Record a step in the plan.",
  parameters: Schema.Struct({ step: Schema.String }),
  success: Schema.String,
  dependencies: [Plan]
})
const recordStep = Agent.tool(RecordStep, ({ step }) =>
  AgentState.update(Plan, (plan) => ({ steps: [...plan.steps, step] })).pipe(Effect.as("recorded")))

// The coding write tool as a bound tool, so it sits beside the battery tools.
const writeFile = Agent.tool(CodingToolkit.WriteFile, CodingToolkit.handlers.write_file)

const Assistant = Agent.make({
  instructions: "You are a coding assistant. Load a skill before acting on it.",
  tools: [writeFile, Skills.loadTool, Memory.rememberTool(scope), recordStep],
  // Skills advertised, memory recalled, and the plan shown -- three transforms,
  // composed, each pulling from its own service.
  contextTransform: ContextTransform.compose(
    Skills.advertise,
    Memory.recall(scope),
    AgentState.transform(Plan, (plan) => `Plan so far: ${plan.steps.join("; ") || "(empty)"}`)
  ),
  // One policy over every projected action across the packages.
  permission: Permission.rules(
    [
      { action: "write", resource: /\.env$/, decision: Permission.deny("secrets are off limits") },
      { action: "write", decision: Permission.allow },
      { action: "skill", decision: Permission.allow },
      { action: "memory", decision: Permission.allow }
    ],
    { otherwise: Permission.allow }
  ),
  // A denied tool call is returned to the model, not fatal to the run.
  toolDenialPolicy: ToolExecution.ReturnToModel,
  loop: AgentLoop.bounded(8)
})

const skills = Skills.layer([
  Skills.skill({
    id: "refactor",
    name: "Refactoring safely",
    description: "How to refactor without breaking the build.",
    body: "Run the tests first, change one thing, run them again."
  })
])

describe("Integration: the whole stack in one agent", () => {
  it.effect("skills, memory, state, coding and permissions compose under one run, asserted by evals", () =>
    Effect.gen(function* () {
      const script = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "s", name: "load_skill", params: { skill_id: "refactor" } }] },
        { toolCalls: [{ id: "p", name: "record_step", params: { step: "read the failing test" } }] },
        { toolCalls: [{ id: "w", name: "write_file", params: { path: "src/fix.ts", content: "export const x = 1" } }] },
        { toolCalls: [{ id: "m", name: "remember", params: { content: "The user prefers tabs over spaces." } }] },
        TestLanguageModel.text("done: fixed the bug and recorded the plan")
      ])

      const outcome = yield* Effect.gen(function* () {
        // Seed a prior-session memory so recall has something to inject.
        const memory = yield* Memory.Memory
        yield* memory.remember(scope, { content: "The user works in the payments service." })

        const evaluation = Evals.defineEval({
          name: "fixes a bug across the whole stack",
          agent: Assistant,
          test: (t) =>
            Effect.gen(function* () {
              yield* t.send("fix the bug in the payments service")
              yield* t.succeeded()
              yield* t.calledTool("load_skill")
              yield* t.calledTool("record_step")
              yield* t.calledToolWith("write_file", Evals.satisfying("path=src/fix.ts", (params) =>
                typeof params === "object" && params !== null && "path" in params && params.path === "src/fix.ts"))
              yield* t.calledTool("remember")
              yield* t.reply(Evals.includes("done"))
              yield* t.turns(Evals.atMost(6))
            })
        })
        const evalResult = yield* Evals.run(evaluation)

        // Now read every subsystem's committed state directly.
        const sandbox = yield* Sandbox.Current
        const file = yield* Sandbox.readText(sandbox)(yield* Sandbox.path("src/fix.ts"))
        const plan = yield* AgentState.get(Plan)
        const recalledLater = yield* memory.recall(scope, "tabs preference")
        const prompts = yield* script.recorder.prompts
        return { evalResult, file, plan, recalledLater, prompts }
      }).pipe(
        Effect.provide(Layer.mergeAll(
          script.layer,
          skills,
          Memory.layer(),
          AgentState.layer(Plan, { initial: { steps: [] } }),
          Sandbox.currentLayer(ws).pipe(Layer.provide(MemorySandbox.layer({ seed: {} })))
        )),
        Effect.scoped
      )

      // Evals saw the whole behaviour and every check held.
      assert.isTrue(outcome.evalResult.passed, JSON.stringify(outcome.evalResult.checks.filter((c) => !c.passed)))
      // Coding wrote the file to the sandbox.
      assert.strictEqual(outcome.file, "export const x = 1")
      // State captured the plan step.
      assert.deepStrictEqual(outcome.plan.steps, ["read the failing test"])
      // Memory kept the new fact, recallable in a later session.
      assert.include(JSON.stringify(outcome.recalledLater.entries), "tabs over spaces")
      // The first prompt carried the skill catalogue and the recalled memory --
      // three transforms all fired.
      const firstPrompt = JSON.stringify(outcome.prompts[0])
      assert.include(firstPrompt, "refactor: Refactoring safely")
      assert.include(firstPrompt, "works in the payments service")
      assert.include(firstPrompt, "Plan so far")
    })
  )

  it.effect("the shared permission policy denies a sensitive write while the rest of the run proceeds", () =>
    Effect.gen(function* () {
      const script = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "w", name: "write_file", params: { path: ".env", content: "SECRET=1" } }] },
        { toolCalls: [{ id: "p", name: "record_step", params: { step: "asked to write a secret" } }] },
        TestLanguageModel.text("I won't write secrets")
      ])

      const outcome = yield* Effect.gen(function* () {
        const evaluation = Evals.defineEval({
          name: "refuses to write secrets",
          agent: Assistant,
          test: (t) =>
            Effect.gen(function* () {
              yield* t.send("write the API key to .env")
              yield* t.succeeded()
              yield* t.reply(Evals.includes("won't"))
            })
        })
        const evalResult = yield* Evals.run(evaluation)
        const plan = yield* AgentState.get(Plan)
        // The .env write was denied, so the file never landed.
        const sandbox = yield* Sandbox.Current
        const exists = yield* Sandbox.readText(sandbox)(yield* Sandbox.path(".env")).pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false))
        )
        return { evalResult, plan, exists }
      }).pipe(
        Effect.provide(Layer.mergeAll(
          script.layer,
          skills,
          Memory.layer(),
          AgentState.layer(Plan, { initial: { steps: [] } }),
          Sandbox.currentLayer(ws).pipe(Layer.provide(MemorySandbox.layer({ seed: {} })))
        )),
        Effect.scoped
      )

      assert.isTrue(outcome.evalResult.passed, JSON.stringify(outcome.evalResult.checks.filter((c) => !c.passed)))
      // The denial did not abort the run: the later step still recorded.
      assert.deepStrictEqual(outcome.plan.steps, ["asked to write a secret"])
      // And the secret file was never written.
      assert.isFalse(outcome.exists)
    })
  )
})
