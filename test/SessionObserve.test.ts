import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, PubSub, Ref, Stream } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as EventBus from "../src/internal/eventBus.js"
import { SessionId } from "../src/internal/ids.js"
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

  /**
   * R156 -- a broken observer loses its own notification and nothing else.
   *
   * An observer's typed error channel is `never`, but a defect still escaped
   * the callback and failed `emit` -- which failed the model call, tool call
   * or submission that was in the middle of announcing what it had done.
   * Subscribers had already received the envelope and later observers were
   * skipped, so the session's account of itself depended on which event
   * happened to break.
   *
   * `SessionTree.capture` wrapping its own storage write was the tell: if
   * every observer has to defend itself, the coupling is the wrong way round.
   */
  it.effect("a defecting observer does not fail the agent, or its neighbours", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.text("an answer")
      ])

      const out = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        const survivor: Array<string> = []

        yield* AgentSession.observe(session, () =>
          Effect.die(new Error("this observer is broken")))
        // Attached after the broken one, so "later observers are skipped" is
        // what this would show.
        yield* AgentSession.observe(session, (envelope) =>
          Effect.sync(() => {
            survivor.push(envelope.event._tag)
          }))

        const result = yield* Effect.exit(session.prompt("go"))
        return { result, survivor }
      }).pipe(Effect.provide(layer), Effect.scoped)

      // The run finished. That is the whole claim.
      assert.strictEqual(out.result._tag, "Success")
      // And the observer standing behind the broken one still saw everything.
      assert.include(out.survivor, "SubmissionStarted")
      assert.include(out.survivor, "SubmissionCompleted")
    }))

  /**
   * R20 -- re-entry is a deadlock, and used to be an undiagnosed hang.
   *
   * Publication holds a one-permit lock across the observer, so a session
   * operation that emits waits for a permit only that observer can release.
   * The documentation warned that a slow observer slows the loop; it did not
   * say that a re-entrant one stops it forever.
   *
   * Refused as a defect instead. A test that asserted the *hang* would have to
   * be a timeout, which is a test that passes on a slow machine for the wrong
   * reason.
   */
  it.effect("an observer that emits on its own fibre is refused, not hung", () =>
    Effect.gen(function*() {
      const bus = yield* EventBus.make(SessionId.make("session-reentry"))
      const correlation = { submissionId: undefined, runId: undefined, turn: undefined }

      yield* Effect.scoped(
        Effect.gen(function*() {
          yield* EventBus.observe(bus, () =>
            // The re-entrant call, on the observer's own fibre.
            EventBus.emit(bus, correlation, { _tag: "SessionClosed" }))

          const result = yield* Effect.exit(
            EventBus.emit(bus, correlation, { _tag: "SessionStarted" })
          )

          /**
           * It ends, which is the point. And it *succeeds*: the re-entrant
           * call is a defect in the observer, so the isolation above catches
           * it, logs it, and leaves the agent's own operation alone. Two
           * defences composing, each doing its own job.
           */
          assert.strictEqual(result._tag, "Success")

          /**
           * And the re-entrant emit never happened. The sequence counter is
           * allocated *inside* the guard, so one published envelope means one
           * emit got through -- if the guard had missed, the nested
           * `SessionClosed` would have taken sequence 2 before deadlocking on
           * the permit, and this test would hang rather than fail.
           */
          assert.strictEqual(yield* Ref.get(bus.sequence), 1)
        })
      )
    }))

  /**
   * And ordinary contention is untouched: a *different* fibre emitting while
   * one holds the permit must wait, which is the entire purpose of the permit.
   * A guard that could not tell the two apart would serialise nothing.
   */
  it.effect("a second fibre emitting concurrently is not mistaken for re-entry", () =>
    Effect.gen(function*() {
      const bus = yield* EventBus.make(SessionId.make("session-contention"))
      const correlation = { submissionId: undefined, runId: undefined, turn: undefined }
      const seen: Array<number> = []

      yield* Effect.scoped(
        Effect.gen(function*() {
          yield* EventBus.observe(bus, (envelope) =>
            // Yield inside the observer, so the permit is genuinely held
            // across a suspension and the other fibre really does contend.
            Effect.andThen(Effect.yieldNow, Effect.sync(() => {
              seen.push(envelope.sequence)
            })))

          yield* Effect.all(
            Array.from({ length: 5 }, () =>
              EventBus.emit(bus, correlation, { _tag: "SessionStarted" })),
            { concurrency: "unbounded" }
          )
        })
      )

      // All five, in sequence order.
      assert.deepStrictEqual(seen, [1, 2, 3, 4, 5])
    }))

  /**
   * The re-entry guard has to survive contention, not merely coexist with it.
   *
   * The marker recording "which fibre is inside `emit`" was set before the
   * ordering permit was acquired, so it was a shared slot two fibres wrote to:
   * a second emitter waiting for the permit overwrote the holder's mark, and
   * the holder's release then cleared it. The fibre that went on to run the
   * observers was therefore recorded as nobody, and its re-entrant observer
   * blocked on the permit it was itself holding -- the undiagnosed hang the
   * guard exists to remove, back again whenever two events overlap. Parallel
   * tool calls emit concurrently, so that is the ordinary case rather than an
   * exotic one.
   */
  it.effect("refuses re-entry on a fibre that queued behind another emit", () =>
    Effect.gen(function*() {
      const bus = yield* EventBus.make(SessionId.make("session-reentry-contended"))
      const correlation = { submissionId: undefined, runId: undefined, turn: undefined }
      // The first emit parks inside its observer, holding the permit, until it
      // is released -- so the second emit is genuinely queued behind it rather
      // than racing.
      const holdingPermit = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          yield* EventBus.observe(bus, (envelope) => {
            switch (envelope.event._tag) {
              case "SessionStarted":
                return Effect.andThen(
                  Deferred.succeed(holdingPermit, void 0),
                  Deferred.await(release)
                )
              case "TurnStarted":
                // The re-entrant call, on the observer's own fibre.
                return EventBus.emit(bus, correlation, { _tag: "SessionClosed" })
              default:
                return Effect.void
            }
          })

          const first = yield* Effect.forkChild(
            EventBus.emit(bus, correlation, { _tag: "SessionStarted" })
          )
          yield* Deferred.await(holdingPermit)
          const second = yield* Effect.forkChild(
            EventBus.emit(bus, correlation, { _tag: "TurnStarted" })
          )
          // Enough turns for the second emit to reach the permit and wait.
          yield* yields(5)
          yield* Deferred.succeed(release, void 0)
          yield* Fiber.join(first)
          // A bounded wait, because the defect this asserts against presents as
          // a hang: the failure is then a timeout rather than a suite that
          // never ends.
          return yield* Effect.exit(
            Effect.timeout(Fiber.join(second), "5 seconds")
          )
        })
      )

      assert.strictEqual(outcome._tag, "Success")
      // Two emits published, and the third -- the re-entrant one -- refused.
      assert.strictEqual(yield* Ref.get(bus.sequence), 2)
    }))
})

describe("AgentSession.events after the session has closed", () => {
  it.effect("delivers the retained SessionClosed and ends, rather than hanging", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("hi")])

      // The handle outlives its scope on purpose: this is the reconnecting
      // client, holding a session that closed while it was away.
      const session = yield* Effect.scoped(
        Effect.provide(AgentSession.make(agent), layer)
      )

      // Bounded, because the defect this guards against presents as a hang.
      const envelopes = yield* Effect.timeout(
        Stream.runCollect(AgentSession.events(session)),
        "5 seconds"
      )

      // Not merely "the stream ended": a late subscriber sees the terminal
      // event itself, which is the thing it subscribed to find out.
      assert.deepStrictEqual(
        envelopes.map((envelope) => envelope.event._tag),
        ["SessionClosed"]
      )
    }))

  it.effect("does not deliver the close twice to a subscriber that was already live", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("hi")])

      const fiber = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* Effect.provide(AgentSession.make(agent), layer)
          const subscribed = yield* Deferred.make<void>()
          return yield* Effect.forkChild(
            Stream.runCollect(
              AgentSession.events(session).pipe(
                Stream.onStart(Deferred.succeed(subscribed, void 0))
              )
            )
          ).pipe(Effect.tap(() => Deferred.await(subscribed)))
        })
      )
      const collected = yield* Effect.timeout(Fiber.join(fiber), "5 seconds")

      assert.strictEqual(
        collected.filter((envelope) => envelope.event._tag === "SessionClosed").length,
        1
      )
    }))
})

// `Stream` stays exported for the ordinary case; this only asserts it exists
// alongside the two narrower seams rather than being replaced by them.
export type _EventsIsAStream = typeof AgentSession.events extends
  (session: never) => Stream.Stream<never> ? true : never
