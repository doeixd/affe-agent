import { assert, describe, it } from "@effect/vitest"
import { Effect, ExecutionPlan, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { AgentProbe, TestLanguageModel } from "../src/testing/index.js"

/**
 * Provider fallback, as a combinator. See `docs/plan-execution-plan.md`.
 *
 * The design's load-bearing constraint is that a plan wraps the **model call
 * and nothing wider**. A turn is a model call *and the tool calls it asked
 * for*, so a plan around the turn would retry tools -- side effects on the
 * world -- because a different part of the turn failed. X1 below is that
 * property, and it is the reason the scope is what it is.
 */

const Ping = Tool.make("ping", {
  parameters: Schema.Struct({}),
  success: Schema.String
})

describe("Agent.withExecutionPlan", () => {
  it.effect("falls back to the next step when the first model fails", () =>
    Effect.gen(function* () {
      const primaryCalls = yield* Ref.make(0)
      const primaryScript = yield* TestLanguageModel.script([
        TestLanguageModel.text("primary answered")
      ])
      const fallbackScript = yield* TestLanguageModel.script([
        TestLanguageModel.text("fallback answered")
      ])

      // The primary fails every call; the plan moves on.
      const plan = ExecutionPlan.make(
        { provide: TestLanguageModel.failingAfter(primaryScript.layer, { succeedFirst: 0, calls: primaryCalls }), attempts: 1 },
        { provide: fallbackScript.layer }
      )

      const agent = Agent.make({ loop: AgentLoop.bounded(2) }).pipe(
        Agent.withExecutionPlan(plan)
      )

      const result = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(agent), (session) =>
          AgentSession.prompt(session, "go")
        )
      )

      assert.strictEqual(result.text, "fallback answered")
      // The primary was genuinely attempted, so this is a fallback and not a
      // test that only ever exercised the second step.
      assert.strictEqual(yield* Ref.get(primaryCalls), 1)
    })
  )

  /**
   * X1 — a plan never re-runs a tool.
   *
   * The primary answers the *first* model call with a tool call, so the tool
   * runs. Its second model call -- the one that reads the tool result -- fails,
   * and the plan falls back. If the plan wrapped the turn rather than the model
   * call, that fallback would re-run the tool.
   */
  it.effect("a tool called before the failure runs exactly once", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make(0)
      const primaryCalls = yield* Ref.make(0)

      const primaryScript = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall("ping", {}, { id: "p1" }),
        TestLanguageModel.text("primary should never get here")
      ])
      const fallbackScript = yield* TestLanguageModel.script([
        TestLanguageModel.text("fallback finished the turn")
      ])

      const plan = ExecutionPlan.make(
        { provide: TestLanguageModel.failingAfter(primaryScript.layer, { succeedFirst: 1, calls: primaryCalls }), attempts: 1 },
        { provide: fallbackScript.layer }
      )

      const agent = Agent.make({
        tools: [Agent.tool(Ping, () => Effect.as(Ref.update(ran, (n) => n + 1), "pong"))],
        loop: AgentLoop.bounded(4)
      }).pipe(Agent.withExecutionPlan(plan))

      const result = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(agent), (session) =>
          AgentSession.prompt(session, "go")
        )
      )

      assert.strictEqual(result.text, "fallback finished the turn")
      // The whole point. A plan around the turn would make this 2.
      assert.strictEqual(yield* Ref.get(ran), 1)
    })
  )

  /**
   * X2 — streaming.
   *
   * A fallback *before* any output is invisible to an observer: `MessageStarted`
   * is emitted once, outside the plan, and the fallback's stream completes the
   * message. That is the case worth having, and the one this asserts.
   *
   * A fallback *after* output is forbidden rather than handled --
   * `preventFallbackOnPartialStream`, set in `AgentTurn.withPlanStream`. Mixing
   * partial output with a retry would show a viewer two `MessageStarted` events
   * for one turn and deltas the transcript will never contain.
   */
  it.effect("a streamed run falls back, and emits exactly one MessageStarted", () =>
    Effect.gen(function* () {
      const primaryCalls = yield* Ref.make(0)
      const primaryScript = yield* TestLanguageModel.script([
        TestLanguageModel.text("primary answered")
      ])
      const fallbackScript = yield* TestLanguageModel.script([
        { text: "fallback streamed", chunks: ["fall", "back", " streamed"] }
      ])

      const plan = ExecutionPlan.make(
        {
          provide: TestLanguageModel.failingAfter(primaryScript.layer, {
            succeedFirst: 0,
            calls: primaryCalls
          }),
          attempts: 1
        },
        { provide: fallbackScript.layer }
      )

      const agent = Agent.make({ loop: AgentLoop.bounded(2) }).pipe(
        Agent.withExecutionPlan(plan)
      )

      const events = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(agent)
          const probe = yield* AgentProbe.make(session)
          yield* AgentSession.prompt(session, "go", { stream: true })
          return yield* probe.events
        })
      )

      const started = events.filter((e) => e.event._tag === "MessageStarted")
      const deltas = events.filter((e) => e.event._tag === "MessageDelta")

      // The primary was tried on the streaming path too -- otherwise this
      // asserts nothing about streaming.
      assert.strictEqual(yield* Ref.get(primaryCalls), 1)
      // One message, from the fallback. Two would mean a viewer saw a message
      // begin, then begin again.
      assert.strictEqual(started.length, 1)
      assert.isAbove(deltas.length, 0)
    })
  )

  it.effect("an agent without a plan is unchanged", () =>
    Effect.gen(function* () {
      // The combinator must be inert when absent: no plan, no wrapping, and the
      // model still arrives from the environment as it always did.
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.text("ordinary")
      ])
      const agent = Agent.make({ loop: AgentLoop.bounded(2) })
      const result = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(agent), (session) =>
          AgentSession.prompt(session, "go")
        )
      ).pipe(Effect.provide(layer))
      assert.strictEqual(result.text, "ordinary")
    })
  )
})
