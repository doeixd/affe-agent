import { Effect, Fiber, Layer, Stream } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient, AgentProtocol } from "../src/client/index.js"
import * as AgentSessionHost from "../src/client/internal/sessionHost.js"
import { SessionProjection } from "../src/sessions/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * One stream for a whole host, folded into a read model per session.
 *
 * `docs/effect-plan-2.txt` §29 gives the host a single stream carrying every
 * hosted session's events plus its own hosting lifecycle; §27 gives a session's
 * events a fold. This is the two of them joined, which is the shape an operator
 * console actually wants: *what is running here, what has it cost, and what is
 * waiting on a human* -- answered without a query per session and without a
 * store.
 *
 * §30 is why the joining happens here rather than in `src/`. The host knows
 * about hosted agents and nothing else; merging its stream with, say, a process
 * manager's is the application's business, so the library ships the stream and
 * the reducer and stops.
 *
 * Two things this demonstrates that are easy to get wrong:
 *
 * - **Route on `envelope.sessionId`.** A host stream carries every session, so
 *   a fold that does not route corrupts every projection it touches --
 *   silently, because the counters still move. `Projection.foreign` exists to
 *   catch exactly that, and is asserted below.
 * - **Seed with `empty`, never `since(id, 0)`.** A session emits
 *   `SessionStarted` at sequence 1 while it is still being constructed, before
 *   any host can subscribe, so the host stream never carries it. Seeding from
 *   zero reports a gap that was never a loss.
 */

const agent = Agent.make({ loop: AgentLoop.bounded(1) })

const program = Effect.gen(function* () {
  const { layer: model } = yield* TestLanguageModel.script([
    TestLanguageModel.text("first answer"),
    TestLanguageModel.text("second answer")
  ])

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const host = yield* AgentSessionHost.make({
        authorization: AgentSessionHost.allowAll<void>(),
        maxSessions: 8,
        maxRequestsPerSession: 16
      })

      const projections = new Map<
        AgentProtocol.SessionId,
        SessionProjection.Projection
      >()

      const consume = (event: AgentProtocol.HostEvent) =>
        Effect.sync(() => {
          switch (event._tag) {
            // The inventory: sessions already hosted when we subscribed.
            case "HostAttached":
              for (const id of event.sessionIds) {
                projections.set(id, SessionProjection.empty(id))
              }
              return
            case "SessionHosted":
              projections.set(
                event.sessionId,
                SessionProjection.empty(event.sessionId)
              )
              return
            case "SessionEvent": {
              const id = event.envelope.sessionId
              const current = projections.get(id)
              if (current === undefined) return
              projections.set(
                id,
                SessionProjection.reduce(current, event.envelope)
              )
              return
            }
            // Not `SessionClosed`: it says this host stopped watching, which
            // for a durable session says nothing about the session itself.
            case "SessionUnhosted":
              return
          }
        })

      const events = yield* host.hostEvents(undefined)
      const reader = yield* Effect.forkChild(Stream.runForEach(events, consume))
      yield* Effect.yieldNow

      for (const name of ["alpha", "beta"]) {
        yield* host.createSession(undefined, {
          requestId: AgentProtocol.RequestId.make(`create-${name}`),
          sessionId: AgentProtocol.SessionId.make(name)
        })
        yield* host.prompt(undefined, {
          requestId: AgentProtocol.RequestId.make(`prompt-${name}`),
          sessionId: AgentProtocol.SessionId.make(name),
          input: Prompt.make("say something")
        })
      }

      yield* Effect.yieldNow
      yield* Fiber.interrupt(reader)

      for (const [id, projection] of projections) {
        yield* Effect.log(
          `${id}: ${projection.submissions.completed} submission(s), ` +
            `${projection.turns} turn(s), ` +
            `${projection.usage.totalTokens} tokens, ` +
            `active=${SessionProjection.isActive(projection)} ` +
            `blocked=${SessionProjection.isBlocked(projection)}`
        )
      }

      // The claims, asserted rather than described -- breaking any of them
      // fails the run.
      const require_ = (ok: boolean, why: string) =>
        ok ? Effect.void : Effect.die(new Error(why))

      yield* require_(
        projections.size === 2,
        `expected two projections, got ${projections.size}`
      )
      for (const [id, projection] of projections) {
        yield* require_(
          projection.foreign === 0,
          `${id} folded another session's events`
        )
        yield* require_(
          SessionProjection.isComplete(projection),
          `${id} reported a gap it never had`
        )
        yield* require_(
          projection.submissions.completed === 1,
          `${id} did not complete its submission`
        )
      }
    })
  ).pipe(Effect.provide(AgentClient.layer(agent).pipe(Layer.provide(model))))
})

Effect.runPromise(program).then(
  () => console.log("host-events: ok"),
  (error) => {
    console.error(error)
    process.exit(1)
  }
)
