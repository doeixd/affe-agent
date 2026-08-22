import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Queue, Ref, Stream } from "effect"
import * as Agent from "../src/Agent.js"
import type * as AgentEvent from "../src/AgentEvent.js"
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
      // done, but the session has not yet flipped to idle — so `followUp` may
      // still succeed. That accepted work must run, not be discarded on
      // release.
      const sessionRef = yield* Deferred.make<AgentSession.AgentSession<any>>()
      const raced = yield* Ref.make(false)
      const accepted = yield* Ref.make(false)

      // Offers the race exactly once, on the first empty drain of the
      // follow-up queue: the precise instant the submission believes it is
      // finished.
      //
      // The injected caller is forked rather than run inline: drains hold the
      // input gate now, and `followUp` takes the same non-reentrant permit.
      // Forking is also honest about what this simulates — a concurrent caller
      // arriving while the submission closes its input.
      const racing: InputChannel.Factory = {
        make: (sessionId, name) =>
          Effect.map(
            InputChannel.memory.make(sessionId, name),
            (inner): InputChannel.InputChannel => ({
              ...inner,
              offer: (input) =>
                Ref.set(accepted, true).pipe(
                  Effect.andThen(inner.offer(input))
                ),
              drain: Effect.gen(function* () {
                const batch = yield* inner.drain
                if (
                  name === "followUps" &&
                  batch.length === 0 &&
                  !(yield* Ref.get(raced))
                ) {
                  yield* Ref.set(raced, true)
                  const session = yield* Deferred.await(sessionRef)
                  yield* Effect.forkChild(
                    AgentSession.followUp(session, "late").pipe(Effect.ignore)
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

      // Either outcome is allowed on its own: refused outright, or accepted
      // and executed. Accepting and dropping is the one that is not — so if
      // the offer was admitted to the channel, the transcript must contain it.
      const texts = FakeModel.userTexts(history)
      if (yield* Ref.get(accepted)) {
        assert.deepStrictEqual(texts, ["go", "late"])
      } else {
        assert.deepStrictEqual(texts, ["go"])
      }
    })
  )

  it.effect("a follow-up offered while the submission closes is not dropped", () =>
    Effect.gen(function* () {
      // The offer races every stage of the submission's shutdown: it is in
      // flight — parked mid-call, past its gate check, holding the input gate
      // — while the run completes and the submission begins closing. Whichever
      // way the two interleave, an accepted follow-up must be announced before
      // anything can observe it, and must run.
      const sessionRef = yield* Deferred.make<AgentSession.AgentSession<any>>()
      const offerEntered = yield* Deferred.make<void>()
      const releaseOffer = yield* Deferred.make<void>()
      const parkedOnce = yield* Ref.make(false)

      const parking: InputChannel.Factory = {
        make: (sessionId, name) =>
          Effect.map(
            InputChannel.memory.make(sessionId, name),
            (inner): InputChannel.InputChannel => ({
              ...inner,
              offer: (input) =>
                Effect.gen(function* () {
                  if (
                    name === "followUps" &&
                    (yield* Ref.get(parkedOnce)) === false
                  ) {
                    yield* Ref.set(parkedOnce, true)
                    // Parked after the gate read open, before anything reached
                    // the queue.
                    yield* Deferred.succeed(offerEntered, void 0)
                    yield* Deferred.await(releaseOffer)
                  }
                  yield* inner.offer(input)
                })
            })
          )
      }

      const { layer } = yield* FakeModel.layer([
        {
          text: "one",
          during: Effect.gen(function* () {
            const s = yield* Deferred.await(sessionRef)
            yield* Effect.forkChild(
              AgentSession.followUp(s, "late").pipe(Effect.ignore)
            )
            // Gone only once the follow-up has read its open gate and parked
            // mid-offer; the model call may now finish and let the submission
            // begin closing.
            yield* Deferred.await(offerEntered)
          })
        },
        { text: "two" }
      ])

      // Unblocks the parked offer while the submission is mid-shutdown. The
      // exact interleaving from here is the scheduler's; both orders are
      // covered by the assertions below.
      yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Deferred.await(offerEntered)
          yield* Effect.yieldNow
          yield* Deferred.succeed(releaseOffer, void 0)
        })
      )

      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({}), {
            channels: parking
          })
          // Collected so the announcement ordering can be asserted alongside
          // the execution itself.
          const seen = yield* Queue.unbounded<AgentEvent.AgentEventEnvelope>()
          yield* Effect.forkScoped(
            Stream.runForEach(AgentSession.events(session), (envelope) =>
              Queue.offer(seen, envelope)
            )
          )
          yield* Effect.yieldNow
          yield* Deferred.succeed(sessionRef, session)
          yield* AgentSession.prompt(session, "go")
          return {
            history: yield* AgentSession.history(session),
            events: yield* Queue.clear(seen)
          }
        }).pipe(Effect.provide(layer))
      )

      // The caller was told the follow-up was queued, so it must run.
      assert.deepStrictEqual(FakeModel.userTexts(outcome.history), [
        "go",
        "late"
      ])

      // The acceptance is announced before anything can apply it: offer and
      // announcement share the input gate with every drain, so the inversion
      // — Applied reaching a consumer before Queued — cannot happen.
      const tags = outcome.events.map((envelope) => envelope.event._tag)
      assert.isTrue(
        tags.indexOf("FollowUpQueued") < tags.indexOf("FollowUpApplied"),
        `expected FollowUpQueued before FollowUpApplied, got: ${tags.join(", ")}`
      )
    })
  )
})
