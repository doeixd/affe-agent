import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import { AgentProbe, TestLanguageModel } from "../src/testing/index.js"

/**
 * Written the way a consumer of `@doeixd/effect-agent/testing` would write it:
 * only the published surface, no reaching into the suite's own helpers. If the
 * testing package stops being usable on its own terms, this is what notices.
 */
const Search = Tool.make("search", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String
})

describe("@doeixd/effect-agent/testing", () => {
  it.effect("scripts a model and observes the lifecycle", () =>
    Effect.gen(function* () {
      const { layer, recorder } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall("search", { query: "effect" }, { id: "s1" }),
        TestLanguageModel.text("found it")
      ])

      const toolkit = yield* Agent.toolkit([Search], {
        search: ({ query }) => Effect.succeed(`hits for ${query}`)
      })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({ toolkit }))
          const probe = yield* AgentProbe.make(session)

          const result = yield* session.prompt("find effect")
          assert.strictEqual(result.text, "found it")

          // The lifecycle, in order, as a plain list of tags. It starts at
          // `SubmissionStarted`: `SessionStarted` is emitted inside
          // `AgentSession.make`, before there is a handle to attach a probe to.
          const tags = yield* probe.tags
          assert.deepStrictEqual(tags.slice(0, 3), [
            "SubmissionStarted",
            "RunStarted",
            "TurnStarted"
          ])
          assert.include(tags, "ToolCallSucceeded")
          assert.include(tags, "SubmissionCompleted")

          // `events` is non-destructive: reading twice gives the same record.
          assert.deepStrictEqual(
            (yield* probe.events).length,
            (yield* probe.events).length
          )
        })
      ).pipe(Effect.provide(layer))

      // The recorder shows the prompt the harness derived, not just the input.
      const prompts = yield* recorder.prompts
      assert.strictEqual(prompts.length, 2)
      assert.deepStrictEqual(TestLanguageModel.userTexts(prompts[0]!), [
        "find effect"
      ])
      // Turn 2 carries the tool result, so the model saw the search output.
      assert.include(TestLanguageModel.roles(prompts[1]!), "tool")
    })
  )

  it.effect("counts model calls without the caller writing a cast", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.text("one"),
        TestLanguageModel.text("two")
      ])

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({}))
          yield* session.prompt("first")
          yield* session.prompt("second")
        })
      ).pipe(Effect.provide(TestLanguageModel.counting(layer, calls)))

      assert.strictEqual(yield* Ref.get(calls), 2)
    })
  )

  it.effect("drives a run from inside a model call", () =>
    Effect.gen(function* () {
      // `during` is what makes concurrent interaction deterministic: it runs
      // while the model call is in flight, at a known instant, so a test can
      // steer or interrupt a turn rather than racing it.
      const statusDuringCall = yield* Ref.make<string>("unobserved")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const sessionRef = yield* Effect.map(
            Ref.make<AgentSession.AgentSession | undefined>(undefined),
            (ref) => ref
          )

          const { layer } = yield* TestLanguageModel.script([
            {
              text: "done",
              during: Effect.gen(function* () {
                const session = yield* Ref.get(sessionRef)
                if (session !== undefined) {
                  yield* Ref.set(statusDuringCall, yield* session.status)
                }
              })
            }
          ])

          yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* AgentSession.make(Agent.make({}))
              yield* Ref.set(sessionRef, session)
              yield* session.prompt("go")
            })
          ).pipe(Effect.provide(layer))
        })
      )

      // Observed from inside the model call: the session was mid-run, which is
      // exactly the window a test cannot otherwise reach.
      assert.strictEqual(yield* Ref.get(statusDuringCall), "running")
    })
  )
})
