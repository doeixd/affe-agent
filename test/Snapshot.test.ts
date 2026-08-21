import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Schema } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * A snapshot is what survives a process. Everything else a session holds — a
 * scope, a fibre, an event bus, queued input, a captured environment — belongs
 * to the process that made it and is rebuilt by `restore`.
 */
describe("session snapshots", () => {
  it.effect("round-trips a conversation through its Schema", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.text("the capital is Paris"),
        TestLanguageModel.text("its population is about two million")
      ])

      const wire = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({ loop: AgentLoop.bounded(1) })
          )
          yield* session.prompt("what is the capital of France?")

          const snapshot = yield* AgentSession.snapshot(session)
          assert.strictEqual(snapshot.sessionId, session.id)

          // Encoded and parsed as JSON, which is the point of it being a
          // Schema value: a snapshot that only survives in memory is not
          // persistence.
          return JSON.parse(
            JSON.stringify(yield* Schema.encodeEffect(AgentSession.Snapshot)(snapshot))
          ) as unknown
        })
      ).pipe(Effect.provide(layer))

      const restoredText = yield* Effect.scoped(
        Effect.gen(function* () {
          const snapshot = yield* Schema.decodeUnknownEffect(
            AgentSession.Snapshot
          )(wire)

          const session = yield* AgentSession.restore(
            Agent.make({ loop: AgentLoop.bounded(1) }),
            snapshot
          )
          // Identity survives, so logging and correlation still point at the
          // same conversation after a restart.
          assert.strictEqual(session.id, snapshot.sessionId)

          const history = yield* session.history
          assert.deepStrictEqual(
            history.content.map((message) => message.role),
            ["user", "assistant"]
          )

          const result = yield* session.prompt("and its population?")
          return { text: result.text, history: yield* session.history }
        })
      ).pipe(Effect.provide(layer))

      // The restored session continued the conversation rather than starting
      // one: four messages, not two.
      assert.strictEqual(restoredText.text, "its population is about two million")
      assert.deepStrictEqual(
        restoredText.history.content.map((message) => message.role),
        ["user", "assistant", "user", "assistant"]
      )
    })
  )

  it.effect("the restored transcript is what the model actually sees", () =>
    Effect.gen(function* () {
      // Restoring history that never reaches the model would be a convincing
      // way to lose a conversation while appearing to keep it.
      const { layer: first } = yield* TestLanguageModel.script([
        TestLanguageModel.text("noted")
      ])
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({ loop: AgentLoop.bounded(1) })
          )
          yield* session.prompt("remember the number 41")
          return yield* AgentSession.snapshot(session)
        })
      ).pipe(Effect.provide(first))

      const { layer: second, recorder } = yield* TestLanguageModel.script([
        TestLanguageModel.text("41")
      ])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.restore(
            Agent.make({ loop: AgentLoop.bounded(1) }),
            snapshot
          )
          yield* session.prompt("what number?")
        })
      ).pipe(Effect.provide(second))

      const prompt = (yield* recorder.prompts)[0]!
      assert.deepStrictEqual(TestLanguageModel.userTexts(prompt), [
        "remember the number 41",
        "what number?"
      ])
    })
  )

  it.effect("refuses to snapshot a running session", () =>
    Effect.gen(function* () {
      // A turn commits its assistant message and tool results as one unit. A
      // snapshot taken between those would record a conversation that never
      // existed, so waiting for quiescence is the caller's job and refusing is
      // how they find out they have not.
      const { layer } = yield* TestLanguageModel.script([
        { text: "slow", hang: true }
      ])

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({}))
          const running = yield* Effect.forkChild(session.prompt("go"))
          // Let the run claim the session before asking.
          yield* Effect.yieldNow
          yield* Effect.yieldNow

          const error = yield* Effect.flip(AgentSession.snapshot(session))
          assert.strictEqual(error._tag, "AgentBusyError")

          yield* Fiber.interrupt(running)
        })
      ).pipe(Effect.provide(layer))
    })
  )
})
