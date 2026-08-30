import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Queue, Ref } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as InputChannel from "../src/InputChannel.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * The input gate's hardest invariant: a follow-up offered while the gate still
 * reads open -- specifically after a submission's first drain and before it
 * closes its input -- must be caught by the *closing* drain and run, never
 * accepted and then discarded.
 *
 * That window is internal, between two lines of `AgentSubmission`, so it is
 * driven deterministically through the `beforeClose` synchronisation seam (an
 * effect run in exactly that window) rather than raced. The seam offers a
 * follow-up there; the assertion is that a second run happens.
 */

const Simple = Agent.make({ loop: AgentLoop.bounded(2) })

describe("closing-drain invariant", () => {
  it.effect("a follow-up offered in the close window is caught by the closing drain and runs", () =>
    Effect.gen(function* () {
      const { layer: model } = yield* TestLanguageModel.script([
        TestLanguageModel.text("first"),
        TestLanguageModel.text("second")
      ])

      const sessionRef = yield* Deferred.make<AgentSession.AgentSession>()
      const fired = yield* Ref.make(false)
      // Fire once, in the post-first-drain / pre-close window: offer a follow-up
      // that only the closing drain (and its reopen) can still catch.
      const beforeClose = Effect.gen(function* () {
        if (yield* Ref.getAndSet(fired, true)) return
        const session = yield* Deferred.await(sessionRef)
        yield* AgentSession.followUp(session, "late").pipe(Effect.orDie)
      })

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.makeEngine(Simple, { beforeClose })
          yield* Deferred.succeed(sessionRef, session)
          return yield* AgentSession.prompt(session, "go")
        })
      ).pipe(Effect.provide(model))

      // The late follow-up was not dropped: it ran as a second run.
      assert.strictEqual(result.status, "completed")
      assert.strictEqual(result.runs, 2)
      assert.strictEqual(result.text, "second")
    })
  )
})

/**
 * The same invariant on the path `AgentSubmission`'s closing sequence does not
 * cover: an interrupt.
 *
 * `release` withdraws admission and drops whatever is queued. Ungated, it could
 * land between a follow-up's accepting-read and its offer -- so the drain that
 * was meant to catch the item ran first, the offer landed afterwards in a queue
 * nobody would look at again, and the caller was told `FollowUpQueued` for work
 * that was already condemned. The leftover is not even inert: it sits in a
 * session-wide queue for the *next* submission's first drain to pick up.
 *
 * Driven deterministically by parking the follow-up inside its own channel's
 * `offer` -- the one point between the read and the queue write -- rather than
 * by racing an interrupt against a follow-up and hoping.
 */

/** Give other fibres `count` chances to run. Cooperative, so deterministic. */
const yields = (count: number): Effect.Effect<void> =>
  Effect.forEach(Array.from({ length: count }), () => Effect.yieldNow, { discard: true })

describe("release under interruption", () => {
  it.effect("never acknowledges a follow-up whose drain has already run", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const { layer: model } = yield* TestLanguageModel.script([
        { hang: true, started }
      ])

      const offering = yield* Deferred.make<void>()
      const letOffer = yield* Deferred.make<void>()
      const parked = yield* Ref.make(false)
      const trace = yield* Ref.make<ReadonlyArray<string>>([])
      const followUpQueue = yield* Deferred.make<Queue.Queue<Prompt.Prompt>>()

      const channels: InputChannel.Factory = {
        make: (_sessionId, name) =>
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<Prompt.Prompt>()
            if (name === "followUps") yield* Deferred.succeed(followUpQueue, queue)
            const record = (what: string) =>
              Ref.update(trace, (entries) => [...entries, `${name}:${what}`])
            // Parks the first follow-up between `followUp`'s accepting-read and
            // the queue write, which is the window the gate has to close.
            const park = Effect.gen(function* () {
              if (name !== "followUps") return
              if (yield* Ref.getAndSet(parked, true)) return
              yield* Deferred.succeed(offering, void 0)
              yield* Deferred.await(letOffer)
            })
            return {
              offer: (input: Prompt.Prompt) =>
                park.pipe(
                  Effect.andThen(record("offer")),
                  Effect.andThen(Queue.offer(queue, input)),
                  Effect.asVoid
                ),
              drain: record("drain").pipe(Effect.andThen(Queue.clear(queue))),
              size: Queue.size(queue)
            } satisfies InputChannel.InputChannel
          })
      }

      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Simple, { channels })
          const running = yield* Effect.forkChild(
            Effect.exit(AgentSession.prompt(session, "go"))
          )
          // The model call, not merely "a run is active": the run becomes
          // active slightly before it reaches the model.
          yield* Deferred.await(started)

          const queued = yield* Effect.forkChild(
            Effect.exit(AgentSession.followUp(session, "later"))
          )
          yield* Deferred.await(offering)

          // Forked: with the gate taken, `release` -- and therefore
          // `Fiber.interrupt` -- cannot finish until the parked offer does.
          const interrupting = yield* Effect.forkChild(AgentSession.interrupt(session))
          // Enough turns for the interrupt to reach the gate and wait on it.
          yield* yields(20)
          yield* Deferred.succeed(letOffer, void 0)

          const acknowledged = yield* Fiber.join(queued)
          yield* Fiber.join(interrupting).pipe(Effect.ignore)
          yield* Fiber.join(running)
          const leftOver = yield* Queue.size(yield* Deferred.await(followUpQueue))
          return {
            acknowledged,
            leftOver,
            trace: (yield* Ref.get(trace)).filter((entry) => entry.startsWith("followUps:"))
          }
        })
      ).pipe(Effect.provide(model), Effect.timeout("10 seconds"))

      // The follow-up was accepted, so its acceptance must have been the thing
      // that happened *first*: offered and announced, then dropped by the
      // interrupt -- never announced after the drop.
      assert.strictEqual(outcome.acknowledged._tag, "Success")
      assert.deepStrictEqual(outcome.trace, ["followUps:offer", "followUps:drain"])
      // And nothing leaked past the interrupt into the next submission.
      assert.strictEqual(outcome.leftOver, 0)
    }))
})
