import { assert, describe, it } from "@effect/vitest"
import { Effect, PubSub, Stream } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Observing versus subscribing.
 *
 * Both deliver every event in sequence order; they differ in *when* the
 * consumer runs, and that decides which one a given job needs.
 *
 * The job that forces the distinction is reading session state to interpret an
 * event. `TurnCompleted` carries no payload, so anything wanting the
 * conversation as of that boundary has to go and read `history` -- and a
 * consumer scheduled later reads the history as of whenever it ran. After a
 * lag that is a different conversation, and the read is silently wrong rather
 * than late.
 */

/** Give other fibres `count` chances to run. Cooperative, so deterministic. */
const yields = (count: number): Effect.Effect<void> =>
  Effect.forEach(Array.from({ length: count }), () => Effect.yieldNow, { discard: true })

const agent = Agent.make({
  instructions: "You answer briefly.",
  loop: AgentLoop.bounded(2)
})

describe("AgentSession.observe", () => {
  it.effect("reads state as of the event, where a lagging subscriber cannot", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script(
        ["one", "two", "three"].map((reply) => TestLanguageModel.text(reply))
      )

      const out = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)

        // Both consumers do the same job -- record how large the conversation
        // is at each turn boundary -- and differ only in how they are attached.
        const observed: Array<number> = []
        const subscribed: Array<number> = []

        yield* AgentSession.observe(session, (envelope) =>
          envelope.event._tag !== "TurnCompleted"
            ? Effect.void
            : Effect.map(session.history, (history) => {
              observed.push(history.content.length)
            }))

        const subscription = yield* AgentSession.subscribe(session)
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.flatMap(PubSub.take(subscription), (envelope) =>
              envelope.event._tag !== "TurnCompleted"
                ? Effect.void
                // An explicit lag, so this is a demonstration rather than a
                // race: a real subscriber lags for its own reasons -- a slow
                // renderer, a full terminal -- and lags by an unknown amount.
                : Effect.andThen(
                  yields(50),
                  Effect.map(session.history, (history) => {
                    subscribed.push(history.content.length)
                  })
                ))
          )
        )

        yield* session.prompt("a")
        yield* session.prompt("b")
        yield* session.prompt("c")
        yield* yields(300)

        return { observed, subscribed, final: (yield* session.history).content.length }
      }).pipe(Effect.provide(layer), Effect.scoped)

      // The observer saw three different conversations, each as it stood.
      assert.strictEqual(out.observed.length, 3)
      assert.strictEqual(new Set(out.observed).size, 3)
      assert.deepStrictEqual(out.observed, [...out.observed].sort((a, b) => a - b))
      assert.strictEqual(out.observed[out.observed.length - 1], out.final)

      // The subscriber saw every event -- delivery is not the problem -- but
      // read the same finished conversation each time. A recorder built this
      // way stores one node three times and calls the other two duplicates.
      assert.strictEqual(out.subscribed.length, 3)
      assert.deepStrictEqual(out.subscribed, [out.final, out.final, out.final])
    }))

  it.effect("detaches with its scope, and misses nothing before that", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script(
        ["one", "two"].map((reply) => TestLanguageModel.text(reply))
      )

      const out = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        const seen: Array<string> = []

        yield* Effect.scoped(
          Effect.gen(function*() {
            yield* AgentSession.observe(session, (envelope) =>
              Effect.sync(() => {
                seen.push(envelope.event._tag)
              }))
            yield* session.prompt("a")
          })
        )

        const during = seen.length
        yield* session.prompt("b")
        return { during, after: seen.length }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.isAbove(out.during, 0)
      // Nothing arrived after the scope closed, which is what makes an
      // observer safe to attach for a screen, a request, or a branch.
      assert.strictEqual(out.after, out.during)
    }))

  it.effect("subscribing is the right tool when lag is only cosmetic", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("hi")])

      const out = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        // Acquired before anything is published, so the window a `Stream`
        // cannot close -- between forking a consumer and it running -- is not
        // a window here.
        const subscription = yield* AgentSession.subscribe(session)
        yield* session.prompt("a")

        const seen: Array<string> = []
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.flatMap(PubSub.take(subscription), (envelope) =>
              Effect.sync(() => {
                seen.push(envelope.event._tag)
              }))
          )
        )
        yield* yields(100)
        return seen
      }).pipe(Effect.provide(layer), Effect.scoped)

      // Queued while nobody was reading, and delivered in order once someone
      // was -- including the first event of the run.
      assert.strictEqual(out[0], "SubmissionStarted")
      assert.include(out, "TurnCompleted")
    }))
})

// `Stream` stays exported for the ordinary case; this only asserts it exists
// alongside the two narrower seams rather than being replaced by them.
export type _EventsIsAStream = typeof AgentSession.events extends
  (session: never) => Stream.Stream<never> ? true : never
