import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentSession from "../src/AgentSession.js"
import { Subagent } from "../src/subagent/index.js"
import { AgentProbe, TestLanguageModel } from "../src/testing/index.js"

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

  it.live("the control tools list, cancel and stop a worker, and stopping seals it", () =>
    Effect.gen(function* () {
      const childModel = yield* TestLanguageModel.script([TestLanguageModel.text("findings")])
      const { layer: parentModel } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "p1", name: "start_background", params: { question: "food" } }] },
        { toolCalls: [{ id: "p2", name: "list_background", params: {} }] },
        { toolCalls: [{ id: "p3", name: "cancel_background", params: { worker: "worker-1" } }] },
        { toolCalls: [{ id: "p4", name: "stop_background", params: { worker: "worker-1" } }] },
        {
          toolCalls: [
            { id: "p5", name: "follow_up_background", params: { worker: "worker-1", question: "more" } }
          ]
        },
        TestLanguageModel.text("done")
      ])

      const events = yield* Effect.scoped(
        Effect.gen(function* () {
          const background = yield* Subagent.background("research", Agent.make({ instructions: "Research." }), {
            description: "Research in the background.",
            provide: childModel.layer
          })
          const Lead = Agent.make({ instructions: "Work.", toolkit: background.toolkit })
          const env = yield* Layer.build(Layer.merge(parentModel, background.layer))
          return yield* Effect.gen(function* () {
            const session = yield* AgentSession.make(Lead)
            const probe = yield* AgentProbe.make(session)
            yield* AgentSession.prompt(session, "go")
            return yield* probe.events
          }).pipe(Effect.provide(env))
        })
      )

      const succeeded = events.flatMap((e) => AgentEvent.is("ToolCallSucceeded")(e) ? [e.event.name] : [])
      assert.include(succeeded, "start_background")
      assert.include(succeeded, "list_background")
      assert.include(succeeded, "cancel_background")
      assert.include(succeeded, "stop_background")
      // A cancelled-or-idle worker is still a success; `list` names it.
      const listed = events.flatMap((e) =>
        AgentEvent.is("ToolCallSucceeded")(e) && e.event.name === "list_background" ? [e.event.result] : []
      )
      assert.include(JSON.stringify(listed), "worker-1")
      // Sealed by stop: the follow-up is a failure the parent model reads.
      const failed = events.flatMap((e) => AgentEvent.is("ToolCallFailed")(e) ? [e.event] : [])
      assert.strictEqual(failed.length, 1)
      assert.strictEqual(failed[0]!.name, "follow_up_background")
      assert.include(failed[0]!.failure.message, "no background worker")
    }))
})
