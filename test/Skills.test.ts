import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Ref } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Permission from "../src/Permission.js"
import { Skills } from "../src/skills/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Skills. The registry is exercised as values (list is metadata only, load and
 * loadResource resolve or miss), the advertise transform is checked for what it
 * does and does not put in the prompt, the load tool for how it reaches the
 * model, and the whole loop in a session -- including the property the design
 * exists for: a body is not loaded until the model asks for it.
 */

const refunds = Skills.skill({
  id: "refunds",
  name: "Issuing refunds",
  description: "How to issue a refund and the limits on doing so.",
  body: "Step 1: verify the order. Step 2: refunds over $500 need a manager.",
  resources: { policy: "Refunds are allowed within 30 days." }
})
const greeting = Skills.skill({
  id: "greeting",
  name: "Greeting customers",
  description: "The house style for greeting a customer.",
  body: "Say hello warmly and use their first name."
})

describe("Skills registry", () => {
  it.effect("list is metadata only; load and loadResource resolve or miss", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const registry = yield* Skills.SkillRegistry
        return {
          list: yield* registry.list,
          body: yield* registry.load("refunds"),
          missing: yield* registry.load("nope"),
          resource: yield* registry.loadResource("refunds", "policy"),
          noResource: yield* registry.loadResource("refunds", "nope")
        }
      }).pipe(Effect.provide(Skills.layer([refunds, greeting])))

      assert.deepStrictEqual(result.list, [
        { id: "refunds", name: "Issuing refunds", description: "How to issue a refund and the limits on doing so.", resources: ["policy"] },
        { id: "greeting", name: "Greeting customers", description: "The house style for greeting a customer.", resources: [] }
      ])
      assert.deepStrictEqual(result.body, Option.some("Step 1: verify the order. Step 2: refunds over $500 need a manager."))
      assert.deepStrictEqual(result.missing, Option.none())
      assert.deepStrictEqual(result.resource, Option.some("Refunds are allowed within 30 days."))
      assert.deepStrictEqual(result.noResource, Option.none())
    })
  )

  it.effect("a duplicate skill id is a configuration error", () =>
    Effect.sync(() => {
      assert.throws(() => Skills.layer([refunds, refunds]), /duplicate skill id "refunds"/)
    })
  )
})

describe("Skills load tool", () => {
  const projection = Permission.projectionOf(Skills.LoadSkill)

  it.effect("projects to a skill action on the id, so a policy can gate it", () => {
    assert.strictEqual(projection.action, "skill")
    assert.strictEqual(projection.resource({ skill_id: "refunds" }), "refunds")
    return Effect.void
  })
})

describe("Skills in a session", () => {
  it.effect("the model sees the catalogue, loads a body on demand, and only then is it in context", () =>
    Effect.gen(function* () {
      // The body counts its own loads, so we can prove it was lazy.
      const loads = yield* Ref.make(0)
      const counted = Skills.skill({
        id: "refunds",
        name: "Issuing refunds",
        description: "How to issue a refund.",
        body: Ref.updateAndGet(loads, (n) => n + 1).pipe(Effect.as("Step 1: verify the order."))
      })

      const { layer, recorder } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "l1", name: "load_skill", params: { skill_id: "refunds" } }] },
        TestLanguageModel.text("refund issued")
      ])
      const agent = Agent.make({
        instructions: "Help with support tasks.",
        tools: [Skills.loadTool],
        loop: AgentLoop.bounded(4),
        contextTransform: Skills.advertise
      })

      const { result, history, loadsBefore, loadsAfter, prompts } = yield* Effect.gen(function* () {
        const session = yield* AgentSession.make(agent)
        // Before the run, nothing has loaded the body.
        const loadsBefore = yield* Ref.get(loads)
        const result = yield* session.prompt("issue a refund")
        return {
          result,
          history: yield* session.history,
          loadsBefore,
          loadsAfter: yield* Ref.get(loads),
          prompts: yield* recorder.prompts
        }
      }).pipe(Effect.provide(Layer.merge(Skills.layer([counted]), layer)), Effect.scoped)

      assert.strictEqual(result.text, "refund issued")
      // The first prompt advertised the metadata, not the body.
      assert.include(JSON.stringify(prompts[0]), "refunds: Issuing refunds")
      assert.notInclude(JSON.stringify(prompts[0]), "verify the order")
      // The body was loaded exactly once, by the tool call, not by advertising.
      assert.strictEqual(loadsBefore, 0)
      assert.strictEqual(loadsAfter, 1)
      // And its text is in the transcript as the tool result the model then read.
      const toolResults = history.content.flatMap((m) => (m.role === "tool" ? m.content : []))
      assert.include(JSON.stringify(toolResults), "verify the order")
    })
  )

  it.effect("Skills.install wires the load tool and the advertise transform together", () =>
    Effect.gen(function* () {
      const { layer, recorder } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "l1", name: "load_skill", params: { skill_id: "refunds" } }] },
        TestLanguageModel.text("refund issued")
      ])
      // One call bundles both halves -- neither can be forgotten.
      const agent = Agent.make({ instructions: "Help with support.", loop: AgentLoop.bounded(4) })
        .pipe(Skills.install)

      const { result, prompts } = yield* Effect.gen(function* () {
        const session = yield* AgentSession.make(agent)
        const result = yield* session.prompt("issue a refund")
        return { result, prompts: yield* recorder.prompts }
      }).pipe(Effect.provide(Layer.merge(Skills.layer([refunds, greeting]), layer)), Effect.scoped)

      // advertise ran (metadata in the first prompt, never the body)...
      assert.include(JSON.stringify(prompts[0]), "refunds: Issuing refunds")
      assert.notInclude(JSON.stringify(prompts[0]), "verify the order")
      // ...and the load_skill tool was callable, so the run completed.
      assert.strictEqual(result.text, "refund issued")
    })
  )

  it.effect("loading an unknown skill returns a failure the model can read, not a defect", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "l1", name: "load_skill", params: { skill_id: "does-not-exist" } }] },
        TestLanguageModel.text("no such skill")
      ])
      const agent = Agent.make({
        instructions: "Help.",
        tools: [Skills.loadTool],
        loop: AgentLoop.bounded(4),
        contextTransform: Skills.advertise
      })
      const { result, history } = yield* Effect.gen(function* () {
        const session = yield* AgentSession.make(agent)
        const result = yield* session.prompt("load it")
        return { result, history: yield* session.history }
      }).pipe(Effect.provide(Layer.merge(Skills.layer([refunds]), layer)), Effect.scoped)

      assert.strictEqual(result.text, "no such skill")
      const toolResults = history.content.flatMap((m) => (m.role === "tool" ? m.content : []))
      const miss = toolResults[0]
      assert.isTrue(miss !== undefined && miss.type === "tool-result" && miss.isFailure)
      assert.include(JSON.stringify(miss), "does-not-exist")
    })
  )

  it.effect("a policy can deny a specific skill's load without touching the catalogue", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "l1", name: "load_skill", params: { skill_id: "refunds" } }] },
        TestLanguageModel.text("i cannot load that")
      ])
      const agent = Agent.make({
        instructions: "Help.",
        tools: [Skills.loadTool],
        loop: AgentLoop.bounded(4),
        contextTransform: Skills.advertise,
        permission: Permission.rules(
          [{ action: "skill", resource: "refunds", decision: Permission.deny("restricted skill") }],
          { otherwise: Permission.allow }
        ),
        toolDenialPolicy: { _tag: "ReturnToModel" }
      })

      const { result, history } = yield* Effect.gen(function* () {
        const session = yield* AgentSession.make(agent)
        const result = yield* session.prompt("load refunds")
        return { result, history: yield* session.history }
      }).pipe(Effect.provide(Layer.merge(Skills.layer([refunds]), layer)), Effect.scoped)

      assert.strictEqual(result.text, "i cannot load that")
      // The load was denied and told to the model, with the reason.
      const toolResults = history.content.flatMap((m) => (m.role === "tool" ? m.content : []))
      const denied = toolResults[0]
      assert.isTrue(denied !== undefined && denied.type === "tool-result" && denied.isFailure)
      assert.include(JSON.stringify(denied), "restricted skill")
    })
  )
})
