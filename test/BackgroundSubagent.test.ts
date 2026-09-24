import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import * as Agent from "../src/Agent.js"
import { Subagent } from "../src/subagent/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Background delegation: a child that outlives the run that started it, and
 * reports when it is done. The child runs in the scope the caller opened
 * around `Subagent.background`; the reports are the caller's to deliver, so
 * the test collects them from the stream.
 */
describe("background delegation", () => {
  it.live("a child outlives the run that started it, is followed up, and reports", () =>
    Effect.gen(function* () {
      const childModel = yield* TestLanguageModel.script([
        TestLanguageModel.text("findings one"),
        TestLanguageModel.text("findings two")
      ])
      const { layer: parentModel } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "p1", name: "start_background", params: { question: "food in Lisbon" } }] },
        {
          toolCalls: [
            { id: "p2", name: "follow_up_background", params: { worker: "worker-1", question: "add indoor options" } }
          ]
        },
        TestLanguageModel.text("started and followed up")
      ])

      const { result, reports } = yield* Effect.scoped(
        Effect.gen(function* () {
          const background = yield* Subagent.background("research", Agent.make({ instructions: "Research." }), {
            description: "Research a question in the background and report when done.",
            provide: childModel.layer
          })
          const Lead = Agent.make({ instructions: "Start research.", toolkit: background.toolkit })

          // The layer must live for the application, not one run: a child
          // forked into its scope outlives the run that started it, so
          // `Effect.provide(background.layer)` around a single run would tie
          // the children to that run. Build it in the application's scope.
          const env = yield* Layer.build(Layer.merge(parentModel, background.layer))
          // The reports are a stream the caller delivers; collect two.
          const collecting = yield* Effect.forkChild(
            Stream.runCollect(Stream.take(background.reports, 2))
          )
          const result = yield* Agent.run(Lead, "start").pipe(Effect.provide(env))
          return { result, reports: yield* Fiber.join(collecting) }
        })
      )

      assert.strictEqual(result.text, "started and followed up")
      assert.deepStrictEqual(
        Array.from(reports).map((report) => [report.worker, report.status, report.text]),
        [
          ["worker-1", "completed", "findings one"],
          ["worker-1", "completed", "findings two"]
        ]
      )
    }))

  it.live("follow-up to an unknown worker is a tool failure the parent can read", () =>
    Effect.gen(function* () {
      const childModel = yield* TestLanguageModel.script([])
      const { layer: parentModel } = yield* TestLanguageModel.script([
        {
          toolCalls: [
            { id: "p1", name: "follow_up_background", params: { worker: "nobody", question: "hello" } }
          ]
        },
        TestLanguageModel.text("carried on")
      ])

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const background = yield* Subagent.background("research", Agent.make({ instructions: "Research." }), {
            description: "Research in the background.",
            provide: childModel.layer
          })
          const Lead = Agent.make({ instructions: "Follow up.", toolkit: background.toolkit })
          return yield* Agent.run(Lead, "go").pipe(
            Effect.provide(Layer.merge(parentModel, background.layer))
          )
        })
      )

      // `onError` is not involved: the tool returns a string failure, so the
      // model reads it and the run continues.
      assert.strictEqual(result.text, "carried on")
    }))
})
