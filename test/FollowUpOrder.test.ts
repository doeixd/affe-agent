import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Ref } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as InputChannel from "../src/InputChannel.js"
import * as FakeModel from "./FakeModel.js"
import { withSession } from "./helpers.js"

describe("follow-up ordering and quiescence", () => {
  it.effect("three follow-ups queued together run in FIFO order", () =>
    Effect.gen(function* () {
      const sessionRef = yield* Deferred.make<AgentSession.AgentSession<any>>()

      const { session, value } = yield* withSession(
        [
          {
            during: Effect.gen(function* () {
              const s = yield* Deferred.await(sessionRef)
              yield* AgentSession.followUp(s, "A")
              yield* AgentSession.followUp(s, "B")
              yield* AgentSession.followUp(s, "C")
            }).pipe(Effect.orDie),
            text: "start"
          },
          { text: "a" },
          { text: "b" },
          { text: "c" }
        ],
        Agent.make({}),
        ({ session }) =>
          Deferred.succeed(sessionRef, session).pipe(
            Effect.andThen(AgentSession.prompt(session, "go"))
          )
      )

      assert.strictEqual(value.runs, 4)
      // All three were drained in one batch; the order they were queued in is
      // the order they must run in.
      const history = yield* AgentSession.history(session)
      assert.deepStrictEqual(FakeModel.userTexts(history), [
        "go",
        "A",
        "B",
        "C"
      ])
    })
  )

  it.effect("a follow-up accepted at quiescence is not silently dropped", () =>
    Effect.gen(function* () {
      // The window: the submission drains an empty queue and decides it is
      // done, but the session has not yet flipped to idle — so `followUp` still
      // succeeds. That accepted work must run, not be discarded on release.
      const sessionRef = yield* Deferred.make<AgentSession.AgentSession<any>>()
      const raced = yield* Ref.make(false)

      // Fires the race exactly once, on the first empty drain of the follow-up
      // queue: the precise instant the submission believes it is finished.
      const racing: InputChannel.Factory = {
        make: (sessionId, name) =>
          Effect.map(
            InputChannel.memory.make(sessionId, name),
            (inner): InputChannel.InputChannel => ({
              ...inner,
              drain: Effect.gen(function* () {
                const batch = yield* inner.drain
                if (
                  name === "followUps" &&
                  batch.length === 0 &&
                  !(yield* Ref.get(raced))
                ) {
                  yield* Ref.set(raced, true)
                  const session = yield* Deferred.await(sessionRef)
                  // Accepted here, after the drain that saw nothing.
                  yield* AgentSession.followUp(session, "late").pipe(
                    Effect.ignore
                  )
                }
                return batch
              })
            })
          )
      }

      const { layer } = yield* FakeModel.layer([{ text: "one" }, { text: "two" }])

      const history = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({}), {
            channels: racing
          })
          yield* Deferred.succeed(sessionRef, session)
          yield* AgentSession.prompt(session, "go")
          return yield* AgentSession.history(session)
        }).pipe(Effect.provide(layer))
      )

      // Either the follow-up was rejected, or it ran. Accepting and dropping it
      // is the one outcome that is not allowed.
      assert.deepStrictEqual(FakeModel.userTexts(history), ["go", "late"])
    })
  )
})
