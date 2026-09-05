import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { Subagent } from "../src/subagent/index.js"
import * as FakeModel from "./FakeModel.js"

/**
 * Item 56: do a parent's run limits see a delegated child's turns?
 *
 * The budget work decided that a child's *money* is the parent's, and left
 * this open on purpose: a turn is not fungible the way a token is. This file
 * measures what happens and pins the answer as the decision.
 *
 * **They do not cross, and that is right.** `maxTurns` reads
 * `state.turnIndex` and `maxToolCalls` reads `state.toolCallsTotal`, both
 * facts about *this run*; a delegation is one tool call of the parent's run
 * however many turns the child took. A parent that wants a child bounded
 * bounds the child's loop, which is the one place the bound means the same
 * thing regardless of who calls the child. Money is different because a
 * counter shared by two agents still counts one thing; a turn count shared
 * by two agents counts two different things.
 */

const Ping = Tool.make("ping", { parameters: Schema.Struct({}), success: Schema.String })

describe("run limits across a delegation", () => {
  it.live("a parent's `maxTurns` counts the parent's turns; a delegation is one of them however long the child ran", () =>
    Effect.gen(function* () {
      const childPings = yield* Ref.make(0)
      // Three child turns: two tool calls, then text.
      const child = Agent.make({
        instructions: "child",
        tools: [Agent.tool(Ping, () => Effect.as(Ref.update(childPings, (n) => n + 1), "pong"))],
        loop: AgentLoop.bounded(5)
      })
      const childModel = yield* FakeModel.layer([
        { toolCalls: [{ id: "p1", name: "ping", params: {} }] },
        { toolCalls: [{ id: "p2", name: "ping", params: {} }] },
        { text: "the child is done" }
      ])
      const research = Subagent.tool("research", child, {
        description: "Delegate research.",
        provide: childModel.layer
      })
      // Two parent turns allowed. If the child's three counted, the parent
      // would stop at the end of the delegating turn and never answer.
      const parent = Agent.make({
        instructions: "Delegate.",
        tools: [research],
        loop: AgentLoop.and(AgentLoop.maxTurns(2), AgentLoop.untilIdle())
      })
      const { layer: parentModel, recorder } = yield* FakeModel.script([
        { toolCalls: [{ id: "r1", name: "research", params: { prompt: "go" } }] },
        { text: "the parent answered" }
      ])

      const result = yield* Agent.run(parent, "go").pipe(Effect.scoped, Effect.provide(parentModel))

      assert.strictEqual(yield* Ref.get(childPings), 2, "the child did not run its three turns")
      assert.strictEqual((yield* recorder.prompts).length, 2, "the parent's limit saw the child's turns")
      assert.strictEqual(result.text, "the parent answered")
      assert.strictEqual(result.turns, 2)
    }),
    30_000
  )

  it.live("a parent's `maxToolCalls` counts the delegation as one call, not the child's calls", () =>
    Effect.gen(function* () {
      const child = Agent.make({
        instructions: "child",
        tools: [Agent.tool(Ping, () => Effect.succeed("pong"))],
        loop: AgentLoop.bounded(5)
      })
      const childModel = yield* FakeModel.layer([
        { toolCalls: [{ id: "p1", name: "ping", params: {} }, { id: "p2", name: "ping", params: {} }] },
        { text: "the child is done" }
      ])
      const research = Subagent.tool("research", child, {
        description: "Delegate research.",
        provide: childModel.layer
      })
      // One tool call allowed before the parent stops. The delegation is
      // that one call; the child's two are the child's.
      const parent = Agent.make({
        instructions: "Delegate.",
        tools: [research],
        loop: AgentLoop.and(AgentLoop.maxToolCalls(1), AgentLoop.untilIdle())
      })
      const { layer: parentModel, recorder } = yield* FakeModel.script([
        { toolCalls: [{ id: "r1", name: "research", params: { prompt: "go" } }] },
        { text: "never reached: the limit stops the parent after the delegating turn" }
      ])

      const result = yield* Agent.run(parent, "go").pipe(Effect.scoped, Effect.provide(parentModel))

      // Stopped by its own limit after the one delegating turn -- the same
      // as it would with any single tool call -- not earlier because the
      // child called two tools, and not later because it did.
      assert.strictEqual((yield* recorder.prompts).length, 1)
      assert.strictEqual(result.stopReason._tag === "Some" ? result.stopReason.value : "", "max tool calls")
    }),
    30_000
  )

  it.live("bounding the child is the child's loop's job, and it works there under a delegation", () =>
    Effect.gen(function* () {
      // The corollary the doc promises: the bound that means "this child may
      // take at most N turns" is on the child, and holds whoever calls it.
      const childPings = yield* Ref.make(0)
      const child = Agent.make({
        instructions: "child",
        tools: [Agent.tool(Ping, () => Effect.as(Ref.update(childPings, (n) => n + 1), "pong"))],
        loop: AgentLoop.and(AgentLoop.maxTurns(1), AgentLoop.untilIdle())
      })
      const childModel = yield* FakeModel.layer([
        { toolCalls: [{ id: "p1", name: "ping", params: {} }] },
        { toolCalls: [{ id: "p2", name: "ping", params: {} }] },
        { text: "never reached" }
      ])
      const research = Subagent.tool("research", child, {
        description: "Delegate research.",
        provide: childModel.layer
      })
      const parent = Agent.make({ instructions: "Delegate.", tools: [research], loop: AgentLoop.bounded(4) })
      const { layer: parentModel } = yield* FakeModel.script([
        { toolCalls: [{ id: "r1", name: "research", params: { prompt: "go" } }] },
        { text: "the parent answered" }
      ])

      const result = yield* Agent.run(parent, "go").pipe(Effect.scoped, Effect.provide(parentModel))

      assert.strictEqual(yield* Ref.get(childPings), 1, "the child's own bound did not hold under a delegation")
      assert.strictEqual(result.text, "the parent answered")
    }),
    30_000
  )
})
