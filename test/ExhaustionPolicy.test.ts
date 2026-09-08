import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import type { LanguageModel, Prompt } from "effect/unstable/ai"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as FakeModel from "./FakeModel.js"

/**
 * What a run does when it runs out.
 *
 * `plan-run-stream-start.md` §7.3 asks for one ergonomic choice over the
 * existing combinators rather than a second budgeting engine, and P4's
 * classification is what makes it expressible: each mode acts on
 * `Decision.exhaustion`, so nothing here reads a `stopReason` string.
 *
 * The three modes are not symmetric, and the asymmetry is the interesting
 * part. `"stop"` spends nothing more. `"final-answer"` spends one more model
 * call, which is why it declines for a bound whose purpose was to stop
 * spending. `"fail"` spends nothing and refuses to hand back a partial result
 * at all.
 */

const Lookup = Tool.make("lookup", {
  description: "look something up",
  parameters: Schema.Struct({}),
  success: Schema.String
})

/** Keeps asking for tools, so a bound ends the run rather than the model. */
const insistent: ReadonlyArray<FakeModel.Turn> = [
  { toolCalls: [{ id: "a", name: "lookup", params: {} }] },
  { toolCalls: [{ id: "b", name: "lookup", params: {} }] },
  { toolCalls: [{ id: "c", name: "lookup", params: {} }] }
]

const agentWith = <E, R>(loop: AgentLoop.AgentLoop<E, R, any>) =>
  Agent.make({
    tools: [Agent.tool(Lookup, () => Effect.succeed("found"))],
    loop
  })

const run = <Tools extends Record<string, Tool.Any>, E, R, Value>(
  turns: ReadonlyArray<FakeModel.Turn>,
  agent: Agent.AgentDefinition<Tools, E, R, LanguageModel.LanguageModel, Value, Prompt.RawInput>
) =>
  Effect.gen(function*() {
    const { layer } = yield* FakeModel.layer(turns)
    return yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function*() {
          const session = yield* AgentSession.make(agent)
          return yield* AgentSession.prompt<Tools, E, Value, Prompt.RawInput>(session, "go")
        }).pipe(Effect.provide(layer))
      )
    )
  })

const failureText = <A, E>(exit: Exit.Exit<A, E>): string =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "(the effect succeeded)"

const valueOf = <A, E>(exit: Exit.Exit<A, E>): A => {
  assert.isTrue(Exit.isSuccess(exit), failureText(exit))
  if (!Exit.isSuccess(exit)) throw new Error("unreachable")
  return exit.value
}

describe("onExhaustion", () => {
  it.effect("stop is the default: the run ends where the bound put it", () =>
    Effect.gen(function*() {
      const exit = yield* run(insistent, agentWith(AgentLoop.limits({ maxTurns: 2 })))
      const result = valueOf(exit)

      assert.strictEqual(result.status, "completed")
      assert.strictEqual(result.turns, 2)
      assert.deepStrictEqual(result.exhaustion, Option.some("turns"))
    }))

  it.effect("final-answer spends one more turn, with tools withheld", () =>
    Effect.gen(function*() {
      const exit = yield* run(
        // The third turn is the final one and is offered no tools, so it
        // answers rather than calling.
        [insistent[0]!, insistent[1]!, { text: "here is what I found" }],
        agentWith(AgentLoop.limits({ maxTurns: 2, onExhaustion: "final-answer" }))
      )
      const result = valueOf(exit)

      assert.strictEqual(result.text, "here is what I found")
      // Three turns under `maxTurns: 2`. The final turn is outside the ordinary
      // allowance on purpose -- it is a terminal recovery action, not work --
      // and a caller reading `turns` needs to know that.
      assert.strictEqual(result.turns, 3)
      // And it still says what ran out.
      assert.deepStrictEqual(result.exhaustion, Option.some("turns"))
    }))

  /**
   * §7.3's constraint, and the one asymmetry worth a test of its own: "do not
   * blindly make every ceiling final-answer capable". A run that exceeded its
   * *time* cannot answer by making another provider call -- that is the single
   * thing `maxDuration` existed to prevent.
   */
  // `it.live`: `maxDuration` reads real elapsed time, which a test clock does
  // not advance on its own.
  it.live("final-answer declines for a duration bound, which another call would contradict", () =>
    Effect.gen(function*() {
      const exit = yield* run(
        [
          // The first turn takes longer than the whole budget.
          { toolCalls: [{ id: "a", name: "lookup", params: {} }], during: Effect.sleep("30 millis") },
          { text: "would be the final answer" }
        ],
        agentWith(AgentLoop.limits({ maxDuration: "1 millis", onExhaustion: "final-answer" }))
      )
      const result = valueOf(exit)

      assert.deepStrictEqual(result.exhaustion, Option.some("duration"))
      assert.strictEqual(result.turns, 1, "a run out of time must not spend another model call")
      assert.strictEqual(result.text, "", "and so it has no final answer to give")
    }))

  it.effect("fail refuses to hand back a result the caller has to inspect", () =>
    Effect.gen(function*() {
      const exit = yield* run(insistent, agentWith(AgentLoop.limits({ maxTurns: 2, onExhaustion: "fail" })))

      assert.isTrue(Exit.isFailure(exit), "an exhausted run under `fail` must not complete")
      const message = failureText(exit)
      assert.include(message, "AgentExhaustedError")
      assert.include(message, "turns", "the error must name what ran out")
      assert.include(message, "max turns", "and keep the loop's own words for it")
    }))

  /**
   * The property every mode depends on: exhaustion is a decision, so a run that
   * simply finished is untouched by any of them.
   */
  it.effect("a model that finishes is unaffected, under every mode", () =>
    Effect.gen(function*() {
      for (const mode of ["stop", "final-answer", "fail"] as const) {
        const exit = yield* run(
          [{ text: "done" }],
          agentWith(AgentLoop.limits({ maxTurns: 5, onExhaustion: mode }))
        )
        const result = valueOf(exit)
        assert.strictEqual(result.text, "done", `mode ${mode} changed a finished run`)
        assert.strictEqual(result.turns, 1)
        assert.isTrue(Option.isNone(result.exhaustion), `mode ${mode} called a normal stop exhaustion`)
      }
    }))

  /**
   * `fail` acts on the classification, not on the fact that a policy stopped.
   * A custom policy that ends a run has not exhausted anything, and must not be
   * turned into a failure by a mode aimed at ceilings.
   */
  it.effect("fail leaves a custom policy's own stop alone", () =>
    Effect.gen(function*() {
      const supervisor = AgentLoop.failOnExhaustion(
        AgentLoop.make(() => Effect.succeed(AgentLoop.stop("supervisor said so")))
      )
      const exit = yield* run(insistent, agentWith(supervisor))
      const result = valueOf(exit)

      assert.strictEqual(result.status, "completed")
      assert.deepStrictEqual(result.stopReason, Option.some("supervisor said so"))
      assert.isTrue(Option.isNone(result.exhaustion))
    }))

  it.effect("the error channel widens only when fail is chosen", () =>
    Effect.gen(function*() {
      // A type-level assertion, checked by the compiler rather than at runtime:
      // `limits` without `onExhaustion: "fail"` must stay `never`, or every
      // caller inherits a branch that cannot happen.
      const plain: AgentLoop.AgentLoop<never, never, any> = AgentLoop.limits({ maxTurns: 2 })
      const stopping: AgentLoop.AgentLoop<never, never, any> = AgentLoop.limits({
        maxTurns: 2,
        onExhaustion: "final-answer"
      })
      assert.isDefined(plain)
      assert.isDefined(stopping)
    }))
})
