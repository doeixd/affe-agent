import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Result, Scope, Stream } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient, AgentProtocol } from "../src/client/index.js"
import * as AgentSessionHost from "../src/client/internal/sessionHost.js"
import { SessionProjection } from "../src/sessions/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * The host-wide event stream (`docs/effect-plan-2.txt` §29).
 *
 * Driven over a real in-process client, so the inner events are the kernel's
 * own rather than a fixture's idea of them -- which matters here more than
 * usual, because two of these invariants are about *ordering* between the
 * host's lifecycle events and the sessions' own, and a fixture would be
 * asserting an ordering it had itself invented.
 */
const requestId = (value: string) => AgentProtocol.RequestId.make(value)
const sessionId = (value: string) => AgentProtocol.SessionId.make(value)

const withHost = <A, E>(
  turns: ReadonlyArray<TestLanguageModel.Turn>,
  use: (host: AgentSessionHost.Host<void>) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const { layer: model } = yield* TestLanguageModel.script(turns)
    return yield* Effect.scoped(
      Effect.flatMap(
        AgentSessionHost.make({
          authorization: AgentSessionHost.allowAll<void>(),
          maxSessions: 4,
          maxRequestsPerSession: 8
        }),
        use
      )
    ).pipe(
      Effect.provide(
        AgentClient.layer(Agent.make({ loop: AgentLoop.bounded(1) })).pipe(
          Layer.provide(model)
        )
      )
    )
  })

/** Collect the host stream in the background while `body` drives the host. */
const collecting = <A, E>(
  host: AgentSessionHost.Host<void>,
  body: Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const events = yield* host.hostEvents(undefined)
    const collected: Array<AgentProtocol.HostEvent> = []
    const pump = yield* Effect.forkChild(
      Stream.runForEach(events, (event) =>
        Effect.sync(() => {
          collected.push(event)
        }))
    )
    // Let the subscription register before anything is published, the same
    // cooperative-scheduler step the host's own pump relies on.
    yield* Effect.yieldNow
    const value = yield* body
    yield* Effect.yieldNow
    yield* Fiber.interrupt(pump)
    return { value, collected }
  })

const tagsFor = (
  collected: ReadonlyArray<AgentProtocol.HostEvent>,
  id: string
) =>
  collected.flatMap((event) => {
    switch (event._tag) {
      case "HostAttached":
        return event.sessionIds.includes(sessionId(id)) ? ["HostAttached"] : []
      case "SessionHosted":
      case "SessionUnhosted":
        return event.sessionId === id ? [event._tag] : []
      case "SessionEvent":
        return event.envelope.sessionId === id ? ["SessionEvent"] : []
    }
  })

describe("AgentSessionHost host-wide events", () => {
  it.effect("announces a session before any of its events", () =>
    withHost([TestLanguageModel.text("one")], (host) =>
      Effect.gen(function* () {
        const { collected } = yield* collecting(
          host,
          Effect.gen(function* () {
            yield* host.createSession(undefined, {
              requestId: requestId("c-a"),
              sessionId: sessionId("a")
            })
            yield* host.prompt(undefined, {
              requestId: requestId("p-1"),
              sessionId: sessionId("a"),
              input: Prompt.make("go")
            })
          })
        )

        const tags = tagsFor(collected, "a")
        assert.strictEqual(tags[0], "SessionHosted")
        // Not merely "the first tag is right": no event may precede it at all,
        // which is the property a consumer routing on `sessionId` depends on.
        assert.isTrue(tags.slice(1).every((tag) => tag !== "SessionHosted"))
        assert.isTrue(tags.includes("SessionEvent"))
      })))

  it.effect("delivers the inventory first, then goes live", () =>
    withHost([TestLanguageModel.text("one")], (host) =>
      Effect.gen(function* () {
        // Hosted *before* anyone subscribes: its `SessionHosted` went out
        // when there was nobody to hear it, so only the inventory can name it.
        yield* host.createSession(undefined, {
          requestId: requestId("c-early"),
          sessionId: sessionId("early")
        })

        const { collected } = yield* collecting(
          host,
          host.createSession(undefined, {
            requestId: requestId("c-late"),
            sessionId: sessionId("late")
          })
        )

        const first = collected[0]
        assert.strictEqual(first?._tag, "HostAttached")
        if (first?._tag !== "HostAttached") return
        assert.deepStrictEqual([...first.sessionIds], [sessionId("early")])

        // Exactly once each, from opposite sides of the subscription.
        assert.deepStrictEqual(tagsFor(collected, "early"), ["HostAttached"])
        assert.deepStrictEqual(tagsFor(collected, "late"), ["SessionHosted"])
      })))

  it.effect("reports a closed session as unhosted, last and once", () =>
    withHost([TestLanguageModel.text("one")], (host) =>
      Effect.gen(function* () {
        const { collected } = yield* collecting(
          host,
          Effect.gen(function* () {
            yield* host.createSession(undefined, {
              requestId: requestId("c-a"),
              sessionId: sessionId("a")
            })
            yield* host.prompt(undefined, {
              requestId: requestId("p-1"),
              sessionId: sessionId("a"),
              input: Prompt.make("go")
            })
            yield* host.closeSession(undefined, {
              requestId: requestId("x-a"),
              sessionId: sessionId("a")
            })
          })
        )

        const tags = tagsFor(collected, "a")
        // The ordering the pump's own exit exists to guarantee: publishing
        // from `closeRaw` instead would let a session's tail trail its own
        // unhosting, because the scope is closed outside the registry gate
        // while the pump is still draining.
        assert.strictEqual(tags[tags.length - 1], "SessionUnhosted")
        assert.strictEqual(
          tags.filter((tag) => tag === "SessionUnhosted").length,
          1
        )

        const unhosted = collected.find(
          (event) => event._tag === "SessionUnhosted"
        )
        assert.strictEqual(unhosted?._tag, "SessionUnhosted")
        if (unhosted?._tag !== "SessionUnhosted") return
        assert.strictEqual(unhosted.reason, "closed")
        // The remover's word, not the pump's guess: a closing subscription
        // reaches the pump as a `Cause.Done` defect that looks exactly like a
        // transport dying, so classifying from the cause reported `failed`
        // for every ordinary close.
        assert.isTrue(Option.isSome(unhosted.lastSequence))
      })))

  it.effect("a host shutting down says so, rather than claiming a close", () =>
    Effect.gen(function* () {
      // `released` is not `closed`, and the difference is the whole point for
      // a durable client: its sessions outlive the host that was watching
      // them, so reporting a shutdown as a close would assert something false
      // about every one of them.
      //
      // The scope is opened by hand rather than with `Effect.scoped` so this
      // test owns the close *ordering*. Forked into the same scope, the
      // collector is torn down before `releaseAll` ever runs and the event
      // under test is never observed -- which is exactly what the first
      // version of this did.
      const { layer: model } = yield* TestLanguageModel.script([
        TestLanguageModel.text("one")
      ])
      const collected: Array<AgentProtocol.HostEvent> = []
      yield* Effect.gen(function* () {
        const scope = yield* Scope.make()
        const host = yield* Effect.provideService(
          AgentSessionHost.make({
            authorization: AgentSessionHost.allowAll<void>(),
            maxSessions: 4,
            maxRequestsPerSession: 8
          }),
          Scope.Scope,
          scope
        )
        const events = yield* host.hostEvents(undefined)
        const pump = yield* Effect.forkChild(
          Stream.runForEach(events, (event) =>
            Effect.sync(() => {
              collected.push(event)
            }))
        )
        yield* Effect.yieldNow
        yield* host.createSession(undefined, {
          requestId: requestId("c-a"),
          sessionId: sessionId("a")
        })
        yield* Effect.yieldNow
        // The host goes away while the collector is still reading.
        yield* Scope.close(scope, Exit.void)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(pump)
      }).pipe(
        Effect.provide(
          AgentClient.layer(Agent.make({ loop: AgentLoop.bounded(1) })).pipe(
            Layer.provide(model)
          )
        )
      )

      const unhosted = collected.find(
        (event) => event._tag === "SessionUnhosted"
      )
      assert.strictEqual(unhosted?._tag, "SessionUnhosted")
      if (unhosted?._tag !== "SessionUnhosted") return
      assert.strictEqual(unhosted.reason, "released")
    }))

  it.effect("a parked subscriber blocks neither a run nor another subscriber", () =>
    withHost([TestLanguageModel.text("one")], (host) =>
      Effect.gen(function* () {
        // The subscriber has to be *running and stuck*, not merely obtained.
        // `hostEvents` returns `Stream.unwrap`, which defers the subscribe to
        // the first pull -- so an earlier version of this test held a stream
        // value that had subscribed to nothing, and `PubSub.bounded(1)` passed
        // it. Reading one element and then blocking for ever is what actually
        // fills a bounded buffer and stalls every pump behind it.
        const parked = yield* host.hostEvents(undefined)
        const wedge = yield* Deferred.make<void>()
        const stuck = yield* Effect.forkChild(
          Stream.runForEach(parked, () => Deferred.await(wedge))
        )
        yield* Effect.yieldNow

        const { collected } = yield* collecting(
          host,
          Effect.gen(function* () {
            yield* host.createSession(undefined, {
              requestId: requestId("c-a"),
              sessionId: sessionId("a")
            })
            return yield* host.prompt(undefined, {
              requestId: requestId("p-1"),
              sessionId: sessionId("a"),
              input: Prompt.make("go")
            })
          })
        )

        // The run finished and a second subscriber saw everything, while the
        // first is still wedged on its very first element.
        assert.isTrue(tagsFor(collected, "a").includes("SessionEvent"))
        yield* Deferred.succeed(wedge, undefined)
        yield* Fiber.interrupt(stuck)
      })))

  it.effect("the host stream and the event log agree on what happened", () =>
    withHost([TestLanguageModel.text("one")], (host) =>
      Effect.gen(function* () {
        const { collected } = yield* collecting(
          host,
          Effect.gen(function* () {
            yield* host.createSession(undefined, {
              requestId: requestId("c-a"),
              sessionId: sessionId("a")
            })
            yield* host.prompt(undefined, {
              requestId: requestId("p-1"),
              sessionId: sessionId("a"),
              input: Prompt.make("go")
            })
          })
        )

        const streamed = collected.flatMap((event) =>
          event._tag === "SessionEvent" &&
            event.envelope.sessionId === sessionId("a")
            ? [event.envelope.sequence]
            : []
        )
        const logged = yield* host.eventLog(undefined, {
          sessionId: sessionId("a")
        })

        // One subscription feeds both, so they cannot drift. Two independent
        // subscriptions would pass a weaker assertion than this one.
        assert.deepStrictEqual(
          streamed,
          logged.events.map((envelope) => envelope.sequence)
        )
      })))

  it.effect("no pump outlives its session", () =>
    withHost(
      [
        TestLanguageModel.text("one"),
        TestLanguageModel.text("two"),
        TestLanguageModel.text("three")
      ],
      (host) =>
        Effect.gen(function* () {
          for (const name of ["a", "b", "c"]) {
            yield* host.createSession(undefined, {
              requestId: requestId(`c-${name}`),
              sessionId: sessionId(name)
            })
          }
          // Seen non-zero first. Asserting only that it returns to zero is
          // passed by a `pumps` that is hardcoded to zero, which is no
          // detector at all.
          assert.strictEqual(yield* host.pumps, 3)
          assert.strictEqual(yield* host.size, 3)

          for (const name of ["a", "b", "c"]) {
            yield* host.closeSession(undefined, {
              requestId: requestId(`x-${name}`),
              sessionId: sessionId(name)
            })
          }
          yield* Effect.yieldNow
          // `size` cannot see this: a leaked pump is precisely one whose
          // session has already left the registry, so the count that would
          // catch it is the one over live fibres.
          assert.strictEqual(yield* host.size, 0)
          assert.strictEqual(yield* host.pumps, 0)
        })
    ))

  it.effect("authorization is separate from per-session events", () =>
    Effect.gen(function* () {
      const { layer: model } = yield* TestLanguageModel.script([
        TestLanguageModel.text("one")
      ])
      const denied = yield* Effect.scoped(
        Effect.flatMap(
          AgentSessionHost.make<void>({
            authorization: {
              authorize: (context) =>
                context.operation === "hostEvents"
                  ? Effect.fail(
                    new AgentProtocol.AgentUnauthorizedError({
                      operation: "hostEvents"
                    })
                  )
                  : Effect.void
            },
            maxSessions: 4,
            maxRequestsPerSession: 8
          }),
          (host) =>
            Effect.gen(function* () {
              yield* host.createSession(undefined, {
                requestId: requestId("c-a"),
                sessionId: sessionId("a")
              })
              // The neighbouring grant still works, which is the whole reason
              // this operation has a name of its own.
              const perSession = yield* host.events(undefined, {
                sessionId: sessionId("a")
              })
              void perSession
              return yield* Effect.result(host.hostEvents(undefined))
            })
        )
      ).pipe(
        Effect.provide(
          AgentClient.layer(Agent.make({ loop: AgentLoop.bounded(1) })).pipe(
            Layer.provide(model)
          )
        )
      )

      assert.isTrue(Result.isFailure(denied))
    }))

  describe("folded into per-session projections", () => {
    it.effect("routes every event to its own session, and none to another", () =>
      withHost(
        [TestLanguageModel.text("one"), TestLanguageModel.text("two")],
        (host) =>
          Effect.gen(function* () {
            const { collected } = yield* collecting(
              host,
              Effect.gen(function* () {
                yield* host.createSession(undefined, {
                  requestId: requestId("c-a"),
                  sessionId: sessionId("a")
                })
                yield* host.createSession(undefined, {
                  requestId: requestId("c-b"),
                  sessionId: sessionId("b")
                })
                yield* host.prompt(undefined, {
                  requestId: requestId("p-a"),
                  sessionId: sessionId("a"),
                  input: Prompt.make("go")
                })
                yield* host.prompt(undefined, {
                  requestId: requestId("p-b"),
                  sessionId: sessionId("b"),
                  input: Prompt.make("go")
                })
              })
            )

            // The §30 fold, and the reason `Projection.foreign` exists.
            const projections = new Map<
              AgentProtocol.SessionId,
              SessionProjection.Projection
            >()
            for (const event of collected) {
              switch (event._tag) {
                case "HostAttached":
                  for (const id of event.sessionIds) {
                    projections.set(id, SessionProjection.empty(id))
                  }
                  break
                case "SessionHosted":
                  projections.set(
                    event.sessionId,
                    SessionProjection.empty(event.sessionId)
                  )
                  break
                case "SessionEvent": {
                  const id = event.envelope.sessionId
                  const current = projections.get(id)
                  if (current !== undefined) {
                    projections.set(
                      id,
                      SessionProjection.reduce(current, event.envelope)
                    )
                  }
                  break
                }
                case "SessionUnhosted":
                  break
              }
            }

            assert.strictEqual(projections.size, 2)
            for (const projection of projections.values()) {
              // Mis-routing is the mistake this fold makes, and it is silent:
              // the counters still move, they just move on the wrong session.
              assert.strictEqual(projection.foreign, 0)
              assert.strictEqual(projection.submissions.completed, 1)
              assert.isTrue(projection.modelCalls >= 1)
            }
          })
      ))

    it.effect("must be seeded with `empty`, because sequence 1 is never on the wire", () =>
      withHost([TestLanguageModel.text("one")], (host) =>
        Effect.gen(function* () {
          const { collected } = yield* collecting(
            host,
            Effect.gen(function* () {
              yield* host.createSession(undefined, {
                requestId: requestId("c-a"),
                sessionId: sessionId("a")
              })
              yield* host.prompt(undefined, {
                requestId: requestId("p-1"),
                sessionId: sessionId("a"),
                input: Prompt.make("go")
              })
            })
          )

          const envelopes = collected.flatMap((event) =>
            event._tag === "SessionEvent" ? [event.envelope] : []
          )
          // `SessionStarted` is emitted while the session is still being
          // constructed, before any host can subscribe -- the same fact
          // `EventLogResponse.oldest` records when it says "normally 2".
          assert.isTrue(envelopes.every((envelope) => envelope.sequence >= 2))

          const seeded = SessionProjection.reduceAll(
            SessionProjection.empty(sessionId("a")),
            envelopes
          )
          assert.isTrue(SessionProjection.isComplete(seeded))

          // The intuitive seed, and it is wrong for ever: the gap it reports
          // was never a loss.
          const fromZero = SessionProjection.reduceAll(
            SessionProjection.since(sessionId("a"), 0),
            envelopes
          )
          assert.isFalse(SessionProjection.isComplete(fromZero))
        })))
  })
})
