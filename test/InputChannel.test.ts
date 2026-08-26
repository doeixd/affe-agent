import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Ref } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as InputChannel from "../src/InputChannel.js"
import { Prompt } from "effect/unstable/ai"
import * as FakeModel from "./FakeModel.js"

/**
 * The seam exists so a stronger runtime can record what a drain consumed.
 * A durable interpreter needs exactly this: the batch a turn consumed, stored
 * with that turn, so replay re-derives the same prompt.
 */
describe("input channels", () => {
  it.effect("a substituted channel observes every drain", () =>
    Effect.gen(function* () {
      const drains = yield* Ref.make<
        Array<readonly [string, ReadonlyArray<string>]>
      >([])
      // Channels carry prompts; the test compares their user text.
      const texts = (batch: ReadonlyArray<Prompt.Prompt>) =>
        batch.flatMap(FakeModel.userTexts)
      const sessionRef = yield* Deferred.make<AgentSession.AgentSession<any>>()

      // Wraps the in-memory channel and records each drained batch.
      const recording: InputChannel.Factory = {
        make: (sessionId, name) =>
          Effect.map(
            InputChannel.memory.make(sessionId, name),
            (inner): InputChannel.InputChannel => ({
              offer: inner.offer,
              size: inner.size,
              drain: Effect.tap(inner.drain, (batch) =>
                batch.length > 0
                  ? Ref.update(drains, (all) => [
                      ...all,
                      [name, texts(batch)] as const
                    ])
                  : Effect.void
              )
            })
          )
      }

      const { layer } = yield* FakeModel.layer([
        {
          during: Effect.gen(function* () {
            const session = yield* Deferred.await(sessionRef)
            yield* AgentSession.steer(session, "steer-a")
            yield* AgentSession.steer(session, "steer-b")
            yield* AgentSession.followUp(session, "follow-up")
          }).pipe(Effect.orDie),
          text: "one"
        },
        { text: "two" }
      ])

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({}), {
            channels: recording
          })
          yield* Deferred.succeed(sessionRef, session)
          const result = yield* AgentSession.prompt(session, "go")
          assert.strictEqual(result.runs, 2)
        }).pipe(Effect.provide(layer))
      )

      // Both queues went through the substituted channel. The steers arrived
      // during the run's final turn, so the run's closing drain took them and
      // gave them a turn of their own before the follow-up started run two.
      assert.deepStrictEqual(yield* Ref.get(drains), [
        ["steering", ["steer-a", "steer-b"]],
        ["followUps", ["follow-up"]]
      ])
    })
  )
})
