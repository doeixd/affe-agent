import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { LanguageModel, Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentInput from "../src/AgentInput.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentOutput from "../src/AgentOutput.js"
import { Budget } from "../src/budget/index.js"

/**
 * `Agent.Any` and the extractors (`plan-seams.md` E, from item 46).
 *
 * Three separate test files ended up inlining a helper because naming "some
 * agent" as a parameter type meant writing `any` through an invariant
 * parameter, which erased the agent's requirements. This file is the
 * spelling that works, pinned at the type level so that a change to the
 * interface's variance is caught here rather than in a user's helper.
 *
 * Every `Equal` below is a compile-time assertion. They were confirmed to be
 * enforced by breaking `RequirementsOf` once and watching `tsc` object.
 */

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false

const TicketSchema = Schema.Struct({ customerId: Schema.String, body: Schema.String })
const Ticket = AgentInput.make(TicketSchema, ({ body }) => body)
const Quality = Schema.Struct({ clarity: Schema.Number })
const Output = AgentOutput.make(Quality)
const Lookup = Tool.make("lookup", { parameters: Schema.Struct({}), success: Schema.String })

const plain = Agent.make({ instructions: "plain" })
const typedIn = Agent.make({ instructions: "typed in", input: Ticket })
const typedOut = Agent.make({ instructions: "typed out", output: Output })
const budgeted = Agent.make({ instructions: "budgeted", loop: Budget.within(1, AgentLoop.untilIdle()) })
const tooled = Agent.make({ instructions: "tooled", tools: [Agent.tool(Lookup, () => Effect.succeed("x"))] })

describe("Agent.Any", () => {
  it("admits every agent, whatever its input, output, tools or requirements", () => {
    // The point of the alias: one array, five differently-typed agents, no
    // cast. `AgentDefinition<{}, never, never>` would admit only `plain`.
    const shelf: ReadonlyArray<Agent.Any> = [plain, typedIn, typedOut, budgeted, tooled]
    assert.deepStrictEqual(
      shelf.map((agent) => Option.isSome(agent.output)),
      [false, false, true, false, false]
    )
    assert.deepStrictEqual(
      shelf.map((agent) => Option.getOrElse(agent.instructions, () => "?")),
      ["plain", "typed in", "typed out", "budgeted", "tooled"]
    )
  })

  it("the extractors are exact, not `any` and not vacuously `never`", () => {
    const requirements: Equal<Agent.RequirementsOf<typeof budgeted>, Budget.Budget> = true
    const noRequirements: Equal<Agent.RequirementsOf<typeof plain>, never> = true
    const tools: Equal<Agent.ToolsOfAgent<typeof tooled>, { readonly lookup: typeof Lookup }> = true
    const input: Equal<Agent.InputOf<typeof typedIn>, { readonly customerId: string; readonly body: string }> = true
    const value: Equal<Agent.ValueOf<typeof typedOut>, { readonly clarity: number }> = true
    const error: Equal<Agent.ErrorOf<typeof plain>, never> = true
    const model: Equal<Agent.ModelOf<typeof plain>, LanguageModel.LanguageModel> = true
    assert.isTrue(requirements && noRequirements && tools && input && value && error && model)
  })

  it("as a constraint, a helper keeps the agent it was given", () => {
    // The documented pattern: `Any` bounds the parameter, the parameter
    // itself is what comes out, and nothing about it was erased.
    const labelled = <A extends Agent.Any>(agent: A) => ({
      agent,
      label: Option.getOrElse(agent.instructions, () => "untitled")
    })
    const back = labelled(budgeted)
    const kept: Equal<typeof back.agent, typeof budgeted> = true
    const stillRequires: Equal<Agent.RequirementsOf<typeof back.agent>, Budget.Budget> = true
    assert.isTrue(kept && stillRequires)
    assert.strictEqual(back.label, "budgeted")
  })

  it("as a parameter type, running it erases what the agent needs -- which is why the doc says not to", () => {
    // Since `plan-input-default.md` step 2 the default input is the prompt,
    // so `Any` structurally satisfies `Agent.run`'s parameter and this
    // compiles -- with `Tools`, `E` and `R` all inferred as `any`, so the
    // result asks the environment for nothing checkable. Pinned as the
    // limitation the alias's doc states; a helper that runs stays generic.
    // (Before step 2 this line was a compile error, which was stricter and
    // is gone for the right reason.)
    const runAny = (agent: Agent.Any) => Agent.run(agent, "go")
    type Needs<T> = T extends Effect.Effect<any, any, infer R> ? R : never
    const erased: Equal<Needs<ReturnType<typeof runAny>>, any> = true
    assert.isTrue(erased)
  })
})
