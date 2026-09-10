import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Option, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { withSession } from "./helpers.js"

/**
 * Item 94, T6.1: a tool's own `failureMode` against the agent's
 * `toolFailurePolicy`. Decided as the plan recommended: `"return"` is the
 * tool author's statement that a failure is a value the model reads, so it
 * wins over `FailRun` -- and `describe` shows it per tool, so the agent-level
 * policy does not read as a promise the tool breaks.
 */

const lookup = (failureMode: "error" | "return") =>
  Tool.make("lookup", {
    parameters: Schema.Struct({}),
    success: Schema.String,
    failure: Schema.String,
    failureMode
  })

const agentWith = (failureMode: "error" | "return") =>
  Agent.make({
    tools: [Agent.tool(lookup(failureMode), () => Effect.fail("not found"))],
    toolFailurePolicy: ToolExecution.FailRun,
    loop: AgentLoop.bounded(3)
  })

const turns = [{ toolCalls: [{ id: "l1", name: "lookup", params: {} }] }, { text: "carried on" }]

describe("failure mode against failure policy (item 94, T6.1)", () => {
  it.effect("a \"return\" tool's failure reaches the model even under FailRun, and the run goes on", () =>
    Effect.gen(function*() {
      const { events, value: result } = yield* withSession(turns, agentWith("return"), ({ session }) =>
        AgentSession.prompt(session, "go"))
      assert.strictEqual(result.text, "carried on")
      const failed = events.flatMap((e) => AgentEvent.is("ToolCallFailed")(e) ? [e.event] : [])
      assert.strictEqual(failed.length, 1)
      assert.isTrue(failed[0]!.returnedToModel)
    }))

  it.effect("an \"error\" tool's failure fails the run under FailRun, as the policy says", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        withSession(turns, agentWith("error"), ({ session }) => AgentSession.prompt(session, "go"))
      )
      assert.isTrue(Exit.isFailure(exit))
    }))

  it("describe shows the tool's failure mode beside the agent's policy", () => {
    const described = Agent.describe(agentWith("return"))
    assert.deepStrictEqual(described.toolFailurePolicy, ToolExecution.FailRun)
    assert.deepStrictEqual(
      Option.map(described.tools, (tools) => tools.map((t) => [t.name, t.failureMode])),
      Option.some([["lookup", "return"]])
    )
  })
})
