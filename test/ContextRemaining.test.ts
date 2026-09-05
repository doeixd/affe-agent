import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { Budget } from "../src/budget/index.js"
import { Compaction } from "../src/compaction/index.js"
import { AgentProbe } from "../src/testing/index.js"
import * as FakeModel from "./FakeModel.js"

/**
 * Item 60a: the model can see its own window.
 *
 * The harness meters the projection every turn and stops the run on a budget
 * the model never saw. `Controller.tools.contextRemaining` makes the same
 * measurement readable, so a model running out of room has a reason to act.
 *
 * The observable in every row is the tool's *decoded result* on
 * `ToolCallSucceeded`, read from the session's events: a number that only the
 * transform could have recorded. Remove the recording and the tool fails
 * (row four says how); that is what makes these rows worth having.
 */

const Ping = Tool.make("ping", { parameters: Schema.Struct({}), success: Schema.String })
const usage = (tokens: number) => ({ input: tokens, output: 0 })

/** Run `agent` against `turns`, return the decoded `context_remaining` result(s) the model was shown. */
const statuses = <E, R>(agent: Agent.AgentDefinition<any, E, R>, turns: ReadonlyArray<FakeModel.Turn>) =>
  Effect.gen(function* () {
    const { layer } = yield* FakeModel.script([...turns])
    const events = yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* AgentSession.make(agent)
        const probe = yield* AgentProbe.make(session)
        yield* session.prompt("go")
        return yield* probe.events
      })
    ).pipe(Effect.provide(layer))
    return events.flatMap((envelope) =>
      AgentEvent.is("ToolCallSucceeded")(envelope) && envelope.event.name === "context_remaining"
        ? [Schema.decodeUnknownSync(Compaction.WindowStatus)(envelope.event.result)]
        : []
    )
  })

describe("the model can see its own window", () => {
  it.effect("under a token policy: estimate, limit and remaining, as the transform measured them", () =>
    Effect.gen(function* () {
      const compaction = yield* Compaction.controller({
        policy: Compaction.tokens({
          budget: { contextWindow: 1_000, reserveTokens: 100, keepRecentTokens: 200 },
          estimate: Compaction.estimate.approximate
        }),
        summarise: () => Effect.succeed("summary")
      })
      const agent = Agent.make({
        instructions: "Check your room.",
        tools: [compaction.tools.contextRemaining],
        contextTransform: compaction.transform,
        loop: AgentLoop.bounded(3)
      })
      const [status] = yield* statuses(agent, [
        { toolCalls: [{ id: "c1", name: "context_remaining", params: {} }] },
        { text: "done" }
      ])
      assert.isDefined(status)
      assert.strictEqual(status!.contextLimit, 900, "the limit is contextWindow - reserveTokens")
      assert.isNotNull(status!.estimatedTokens)
      assert.isAbove(status!.estimatedTokens!, 0, "the projection was measured")
      assert.strictEqual(status!.remainingTokens, 900 - status!.estimatedTokens!)
      // The instructions and the prompt: two canonical messages, none folded.
      assert.strictEqual(status!.canonicalMessages, 2)
      assert.strictEqual(status!.compactedThrough, 0)
      // No budget in context: the run's spend is not something this can know.
      assert.isNull(status!.spentTokens)
      assert.isNull(status!.spentCost)
    })
  )

  it.effect("under a message-count policy: no token numbers, and it says so with null", () =>
    Effect.gen(function* () {
      const compaction = yield* Compaction.controller({
        policy: Compaction.whenLongerThan(50, { retain: 4 }),
        summarise: () => Effect.succeed("summary")
      })
      const agent = Agent.make({
        instructions: "Check your room.",
        tools: [compaction.tools.contextRemaining],
        contextTransform: compaction.transform,
        loop: AgentLoop.bounded(3)
      })
      const [status] = yield* statuses(agent, [
        { toolCalls: [{ id: "c1", name: "context_remaining", params: {} }] },
        { text: "done" }
      ])
      assert.isDefined(status)
      assert.isNull(status!.estimatedTokens)
      assert.isNull(status!.contextLimit)
      assert.isNull(status!.remainingTokens)
      assert.strictEqual(status!.canonicalMessages, 2)
    })
  )

  it.effect("with a budget in context: the run's spend through the previous turn", () =>
    Effect.gen(function* () {
      // `Budget.record` runs after a turn's tools, so what a tool sees is the
      // spend up to the turn before it. Turn one spends 100; the tool runs in
      // turn two and sees exactly that.
      const compaction = yield* Compaction.controller({
        policy: Compaction.whenLongerThan(50, { retain: 4 }),
        summarise: () => Effect.succeed("summary")
      })
      const agent = Agent.make({
        instructions: "Check your room.",
        tools: [compaction.tools.contextRemaining, Agent.tool(Ping, () => Effect.succeed("pong"))],
        contextTransform: compaction.transform,
        loop: AgentLoop.bounded(4)
      })
      const [status] = yield* statuses(agent, [
        { toolCalls: [{ id: "p1", name: "ping", params: {} }], usage: usage(100) },
        { toolCalls: [{ id: "c1", name: "context_remaining", params: {} }], usage: usage(7) },
        { text: "done" }
      ]).pipe(Effect.provide(Budget.layer))
      assert.isDefined(status)
      assert.strictEqual(status!.spentTokens, 100, "the budget's total through the previous turn")
      assert.strictEqual(status!.spentCost, 0)
      // Three messages by then: instructions, the prompt, and turn one's exchange folded into history.
      assert.isAbove(status!.canonicalMessages, 2)
    })
  )

  it.effect("without the controller's transform on the agent, the tool fails rather than inventing a number", () =>
    Effect.gen(function* () {
      // The tool reads what the transform recorded. An agent given the tool
      // but not the transform has nothing recorded, and the honest answer is
      // a failure the model can read, not zeros.
      const compaction = yield* Compaction.controller({
        policy: Compaction.whenLongerThan(50, { retain: 4 }),
        summarise: () => Effect.succeed("summary")
      })
      const agent = Agent.make({
        instructions: "Check your room.",
        tools: [compaction.tools.contextRemaining],
        loop: AgentLoop.bounded(3)
      })
      const { layer, recorder } = yield* FakeModel.script([
        { toolCalls: [{ id: "c1", name: "context_remaining", params: {} }] },
        { text: "done" }
      ])
      yield* Agent.run(agent, "go").pipe(Effect.scoped, Effect.provide(layer))
      const shown = JSON.stringify((yield* recorder.prompts)[1])
      assert.include(shown, "no projection has been recorded")
    })
  )

  it.effect("outside any session, the handler says so", () =>
    Effect.gen(function* () {
      const compaction = yield* Compaction.controller({
        policy: Compaction.whenLongerThan(50, { retain: 4 }),
        summarise: () => Effect.succeed("summary")
      })
      const exit = yield* Effect.exit(
        compaction.tools.contextRemaining.handler({}, { preliminary: () => Effect.void })
      )
      assert.isTrue(exit._tag === "Failure")
      assert.include(JSON.stringify(exit), "outside a session")
    })
  )

  it("the tool is annotated read-only, so a policy can wave it through", () => {
    // Upstream's own annotation, read the way `DurableToolkit` reads
    // `Tool.Idempotent`: through the tool's annotation context.
    assert.isTrue(Context.get(Compaction.ContextRemaining.annotations, Tool.Readonly))
    assert.isFalse(Context.get(Ping.annotations, Tool.Readonly))
  })
})
