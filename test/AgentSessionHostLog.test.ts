import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Option } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient, AgentProtocol } from "../src/client/index.js"
import * as AgentSessionHost from "../src/client/internal/sessionHost.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * The host's enumeration and finite event-log seam (`docs/plan-mcp-frontend.md`
 * phase 4): what an MCP resource read needs from the host and could not get
 * from a live stream. Driven over a real in-process client so the events
 * are the kernel's own.
 */
const requestId = (value: string) => AgentProtocol.RequestId.make(value)
const sessionId = (value: string) => AgentProtocol.SessionId.make(value)

const withHost = <A, E>(
  turns: ReadonlyArray<TestLanguageModel.Turn>,
  options: { readonly maxRetainedEvents?: number | undefined },
  use: (host: AgentSessionHost.Host<void>) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const { layer: model } = yield* TestLanguageModel.script(turns)
    return yield* Effect.scoped(
      Effect.flatMap(
        AgentSessionHost.make({
          authorization: AgentSessionHost.allowAll<void>(),
          maxSessions: 4,
          maxRequestsPerSession: 8,
          ...(options.maxRetainedEvents === undefined ? {} : { maxRetainedEvents: options.maxRetainedEvents })
        }),
        use
      )
    ).pipe(
      Effect.provide(AgentClient.layer(Agent.make({ loop: AgentLoop.bounded(1) })).pipe(Layer.provide(model)))
    )
  })

describe("AgentSessionHost enumeration and event log", () => {
  it.effect("lists every hosted session with its status, and the log reads finitely with a cursor", () =>
    withHost(
      [TestLanguageModel.text("one"), TestLanguageModel.text("two")],
      {},
      (host) =>
        Effect.gen(function* () {
          yield* host.createSession(undefined, { requestId: requestId("c-a"), sessionId: sessionId("a") })
          yield* host.createSession(undefined, { requestId: requestId("c-b"), sessionId: sessionId("b") })
          const listed = yield* host.sessions(undefined)
          assert.deepStrictEqual(
            listed.sessions.map((entry) => [entry.sessionId, entry.status]),
            [["a", "idle"], ["b", "idle"]]
          )

          yield* host.prompt(undefined, {
            requestId: requestId("p-1"),
            sessionId: sessionId("a"),
            input: Prompt.make("go")
          })
          const log = yield* host.eventLog(undefined, { sessionId: sessionId("a") })
          const tags = log.events.map((envelope) => envelope.event._tag)
          // The kernel's own sequence since the host began holding the
          // session: `SessionStarted` (sequence 1) went out inside
          // `AgentSession.make`, before any host could subscribe, and the
          // response says so rather than pretending the tail is the start.
          assert.strictEqual(log.oldest, 2)
          assert.strictEqual(tags[0], "SubmissionStarted")
          assert.include(tags, "MessageCompleted")
          assert.strictEqual(tags[tags.length - 1], "SubmissionCompleted")
          assert.deepStrictEqual(
            log.events.map((envelope) => envelope.sequence),
            log.events.map((_, index) => index + 2)
          )
          assert.strictEqual(log.latest, log.events[log.events.length - 1]?.sequence)

          // A cursor: only what came after it, and nothing after the latest.
          const some = yield* host.eventLog(undefined, { sessionId: sessionId("a"), after: 2 })
          assert.deepStrictEqual(
            some.events.map((envelope) => envelope.sequence),
            log.events.filter((envelope) => envelope.sequence > 2).map((envelope) => envelope.sequence)
          )
          const none = yield* host.eventLog(undefined, { sessionId: sessionId("a"), after: log.latest })
          assert.deepStrictEqual(none.events, [])
          assert.strictEqual(none.latest, log.latest)
          // The other session has emitted nothing since it was hosted.
          const other = yield* host.eventLog(undefined, { sessionId: sessionId("b") })
          assert.deepStrictEqual(other, { events: [], latest: 0 })
        })
    )
  )

  it.effect("the log is bounded, and a read from before what is held is refused rather than served with a gap", () =>
    withHost(
      [TestLanguageModel.text("one"), TestLanguageModel.text("two")],
      { maxRetainedEvents: 4 },
      (host) =>
        Effect.gen(function* () {
          yield* host.createSession(undefined, { requestId: requestId("c-a"), sessionId: sessionId("a") })
          yield* host.prompt(undefined, { requestId: requestId("p-1"), sessionId: sessionId("a"), input: Prompt.make("go") })
          const log = yield* host.eventLog(undefined, { sessionId: sessionId("a"), after: 1_000 })
          assert.deepStrictEqual(log.events, [])
          // `latest` is what the host holds, not the cursor echoed back.
          assert.isBelow(log.latest, 1_000)
          // Only the newest four survive, and the oldest held names where the
          // retained tail begins.
          const held = yield* host.eventLog(undefined, { sessionId: sessionId("a"), after: log.latest - 4 })
          assert.strictEqual(held.events.length, 4)
          const oldest = held.events[0]!.sequence
          assert.strictEqual(held.oldest, oldest)
          assert.isAbove(oldest, 2)

          // Asking for everything, or for anything before the oldest held,
          // is a refusal that names the bound -- never a stream with a hole.
          for (const after of [undefined, oldest - 2]) {
            const exit = yield* Effect.exit(
              host.eventLog(undefined, { sessionId: sessionId("a"), ...(after === undefined ? {} : { after }) })
            )
            assert.isTrue(Exit.isFailure(exit))
            if (Exit.isFailure(exit)) {
              const error = Option.getOrUndefined(Exit.findErrorOption(exit))
              assert.strictEqual(error?._tag, "AgentInvalidRequestError")
              if (error?._tag === "AgentInvalidRequestError") {
                assert.include(error.detail, "no longer retained")
                assert.include(error.detail, "maxRetainedEvents is 4")
              }
            }
          }
          // Exactly the oldest held minus one is the earliest honest cursor.
          const fromEdge = yield* host.eventLog(undefined, { sessionId: sessionId("a"), after: oldest - 1 })
          assert.strictEqual(fromEdge.events[0]?.sequence, oldest)
        })
    )
  )
})
