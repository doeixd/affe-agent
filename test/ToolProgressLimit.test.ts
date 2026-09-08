import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import type { LanguageModel, Prompt } from "effect/unstable/ai"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Limits from "../src/internal/limits.js"
import * as FakeModel from "./FakeModel.js"

/**
 * The bound on what an agent *produces*, as distinct from what an observer can
 * fall behind by.
 *
 * `plan-run-stream-start.md` §6 calls this the most important resource-safety
 * item in that plan, and the distinction is the whole point: a tool emitting
 * progress in a loop costs network, storage and telemetry even when every
 * consumer is keeping up, and `Agent.start`'s replaying handle and the durable
 * delivery log both have to hold all of it. The observer-lag bound does not
 * help — there is no lag.
 *
 * §6.5 asks that the three bounds stay distinct in code and docs. These tests
 * are about the middle one only.
 */

const Long = Tool.make("long", {
  description: "emits progress",
  parameters: Schema.Struct({}),
  success: Schema.String
})

/** One tool call, then an answer, so a submission has somewhere to put progress. */
const script: ReadonlyArray<FakeModel.Turn> = [
  { toolCalls: [{ id: "l1", name: "long", params: {} }] },
  { text: "done" }
]

/** A tool that publishes `count` snapshots of roughly `size` bytes each. */
const chatty = (count: number, size: number) =>
  Agent.make({
    tools: [
      Agent.tool(Long, (_, context) =>
        Effect.as(
          Effect.forEach(
            Array.from({ length: count }, (_unused, index) => index),
            () => context.preliminary("x".repeat(size))
          ),
          "whole"
        ))
    ],
    loop: AgentLoop.bounded(2)
  })

const runWith = <Tools extends Record<string, Tool.Any>, E, R, Value>(
  agent: Agent.AgentDefinition<Tools, E, R, LanguageModel.LanguageModel, Value, Prompt.RawInput>,
  options?: { readonly maxBytes?: number }
) =>
  Effect.gen(function*() {
    const { layer } = yield* FakeModel.layer(script)
    return yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function*() {
          const session = yield* AgentSession.make(agent, {
            ...(options?.maxBytes === undefined ? {} : { toolProgress: { maxBytes: options.maxBytes } })
          })
          return yield* AgentSession.prompt<Tools, E, Value, Prompt.RawInput>(session, "go")
        }).pipe(Effect.provide(layer))
      )
    )
  })

const failureText = <A, E>(exit: Exit.Exit<A, E>): string =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "(the effect succeeded)"

describe("the tool-progress production bound", () => {
  it.effect("ordinary progress is unaffected", () =>
    Effect.gen(function*() {
      const exit = yield* runWith(chatty(3, 16))
      assert.isTrue(Exit.isSuccess(exit), failureText(exit))
    }))

  /**
   * Over budget, the call fails. It does not truncate: a structured snapshot
   * cut in half is usually a lie, and a consumer cannot tell it from a whole
   * one.
   */
  it.effect("a tool past the budget fails, naming itself and the limit", () =>
    Effect.gen(function*() {
      const exit = yield* runWith(chatty(50, 1024), { maxBytes: 4096 })

      assert.isTrue(Exit.isFailure(exit), "progress beyond the budget was published anyway")
      const message = failureText(exit)
      assert.include(message, "AgentToolProgressLimitError")
      assert.include(message, "long", "the error must name the offending tool")
      assert.include(message, "l1", "the error must name the offending call")
      assert.include(message, "4096", "the error must name the limit it enforced")
    }))

  /**
   * The accounting unit is the submission, not the run. A per-run budget would
   * let one submission publish without limit simply by scheduling follow-ups,
   * which is the shape the plan explicitly warns about.
   */
  it.effect("the budget spans a submission's runs rather than resetting per run", () =>
    Effect.gen(function*() {
      // Two tool-calling turns inside one submission. Each stays under the
      // budget alone; together they exceed it.
      const twoCalls: ReadonlyArray<FakeModel.Turn> = [
        { toolCalls: [{ id: "l1", name: "long", params: {} }] },
        { toolCalls: [{ id: "l2", name: "long", params: {} }] },
        { text: "done" }
      ]
      const { layer } = yield* FakeModel.layer(twoCalls)

      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function*() {
            const session = yield* AgentSession.make(
              Agent.make({
                tools: [
                  Agent.tool(Long, (_, context) =>
                    Effect.as(
                      Effect.forEach(
                        Array.from({ length: 4 }, (_unused, index) => index),
                        () => context.preliminary("x".repeat(1024))
                      ),
                      "whole"
                    ))
                ],
                loop: AgentLoop.bounded(4)
              }),
              { toolProgress: { maxBytes: 6144 } }
            )
            return yield* AgentSession.prompt(session, "go")
          }).pipe(Effect.provide(layer))
        )
      )

      assert.isTrue(
        Exit.isFailure(exit),
        "a budget that reset between runs would have let this through"
      )
      assert.include(failureText(exit), "AgentToolProgressLimitError")
    }))

  /**
   * A fresh submission gets a fresh budget: the bound is a limit on one unit of
   * work, not a lifetime allowance that eventually strands a session.
   */
  it.effect("a new submission starts from zero", () =>
    Effect.gen(function*() {
      const { layer } = yield* FakeModel.layer([
        { toolCalls: [{ id: "l1", name: "long", params: {} }] },
        { text: "first" },
        { toolCalls: [{ id: "l2", name: "long", params: {} }] },
        { text: "second" }
      ])

      const second = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* AgentSession.make(chatty(3, 512), {
            toolProgress: { maxBytes: 4096 }
          })
          yield* AgentSession.prompt(session, "one")
          // Same spend again. A cumulative-across-submissions counter would
          // fail here.
          return yield* AgentSession.prompt(session, "two")
        }).pipe(Effect.provide(layer))
      )

      assert.strictEqual(second.status, "completed")
    }))

  it.effect("the ceiling cannot be raised, only lowered", () =>
    Effect.gen(function*() {
      assert.strictEqual(
        Limits.toolProgressBytes(undefined),
        Limits.TOOL_PROGRESS_BYTES,
        "the default is the ceiling"
      )
      assert.strictEqual(
        Limits.toolProgressBytes(1024),
        1024,
        "a smaller budget is honoured"
      )
      assert.strictEqual(
        Limits.toolProgressBytes(Limits.TOOL_PROGRESS_BYTES * 4),
        Limits.TOOL_PROGRESS_BYTES,
        "asking for more than the ceiling yields the ceiling, not the request"
      )
    }))

  /**
   * Failing the call must not corrupt what already happened. The plan is
   * explicit that committed history stays untouched.
   */
  it.effect("history already committed is untouched by the failure", () =>
    Effect.gen(function*() {
      const { layer } = yield* FakeModel.layer(script)

      const history = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* AgentSession.make(chatty(50, 1024), {
            toolProgress: { maxBytes: 2048 }
          })
          yield* Effect.exit(AgentSession.prompt(session, "go"))
          return yield* AgentSession.history(session)
        }).pipe(Effect.provide(layer))
      )

      // The user's turn is in history; the failed tool call's turn never
      // committed, so nothing claims the tool answered.
      const roles = history.content.map((message) => message.role)
      assert.include(roles, "user")
      assert.notInclude(
        JSON.stringify(history.content),
        "whole",
        "the failed call's result must not have reached history"
      )
    }))

  it.effect("progress is counted as wire bytes, not UTF-16 units", () =>
    Effect.gen(function*() {
      // Four-byte characters: half the length in UTF-16 units, so a bound that
      // counted `String.length` would allow roughly twice as much through.
      const wide = yield* runWith(
        Agent.make({
          tools: [
            Agent.tool(Long, (_, context) =>
              Effect.as(context.preliminary("😀".repeat(600)), "whole"))
          ],
          loop: AgentLoop.bounded(2)
        }),
        { maxBytes: 1800 }
      )

      assert.isTrue(
        Exit.isFailure(wide),
        "600 four-byte characters is 2400 bytes and must not pass a 1800-byte budget"
      )
    }))
})
