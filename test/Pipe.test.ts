import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect } from "effect"
import { Prompt } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import * as AgentLoop from "../src/AgentLoop.js"
import * as ContextTransform from "../src/ContextTransform.js"

/**
 * `.pipe` on the declarative values, so an external combinator can be applied
 * the way Effect applies everything else.
 *
 * The distinction the review drew is the one that matters: `.pipe` carries no
 * agent semantics. It is syntax for passing a value through functions. So
 * `and` and `or` stay explicit calls — a policy combined by argument position
 * would leave a reader guessing which one it was, and the difference between
 * them is the difference between a run that stops and one that does not.
 */
describe("pipeable declarative values", () => {
  it.effect("an external combinator can be applied to a loop", () =>
    Effect.gen(function* () {
      // Written outside the library, needing no change to it.
      const alsoStopAfter =
        (max: number) =>
        <E, R, Tools extends Record<string, Tool.Any>>(
          loop: AgentLoop.AgentLoop<E, R, Tools>
        ) =>
          AgentLoop.and(loop, AgentLoop.maxTurns<Tools>(max))

      const bounded = AgentLoop.untilIdle().pipe(alsoStopAfter(2))

      const decide = (turnIndex: number) =>
        bounded.decide({
          sessionId: "s" as never,
          submissionId: "sub" as never,
          runId: "r" as never,
          turnIndex,
          toolCallsTotal: turnIndex,
          elapsed: Duration.zero,
          response: null as never,
          toolCalls: [{ id: "t", name: "x" }] as never
        })

      // Tools outstanding, so `untilIdle` continues -- until the bound.
      assert.strictEqual((yield* decide(1))._tag, "Continue")
      assert.strictEqual((yield* decide(2))._tag, "Stop")
    })
  )

  it.effect("and an external combinator to a transform", () =>
    Effect.gen(function* () {
      const shout =
        <E, R>(transform: ContextTransform.ContextTransform<E, R>) =>
          ContextTransform.compose(
            transform,
            ContextTransform.appendSystem(() => Effect.succeed("LOUD"))
          )

      const composed = ContextTransform.identity.pipe(shout)
      const prompt = yield* composed.transform({
        sessionId: "s" as never,
        submissionId: "sub" as never,
        runId: "r" as never,
        turnIndex: 1,
        canonicalPrompt: Prompt.make("hi"),
        prompt: Prompt.make("hi")
      })

      assert.deepStrictEqual(
        prompt.content.flatMap((message) =>
          message.role === "system" ? [message.content] : []
        ),
        ["LOUD"]
      )
    })
  )
})
