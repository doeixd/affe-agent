import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import type { AgentDefinition } from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { AgentClient } from "../src/client/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * The seam exists so an application writes the same code whether its agent runs
 * in this process or behind RPC. These tests use only the client surface — no
 * `AgentSession` — which is the discipline the seam is meant to enforce.
 */
const Search = Tool.make("search", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String
})

const Boom = Tool.make("boom", {
  parameters: Schema.Struct({}),
  success: Schema.String,
  failure: Schema.String
})

/** A client over a scripted model, wired the way an application would wire it. */
const clientWith = <
  A,
  E,
  Tools extends Record<string, Tool.Any>,
  AgentError
>(
  turns: ReadonlyArray<TestLanguageModel.Turn>,
  agent: AgentDefinition<Tools, AgentError, never>,
  use: (client: AgentClient.Service) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const { layer: model } = yield* TestLanguageModel.script(turns)
    return yield* Effect.flatMap(
      Effect.service(AgentClient.AgentClient),
      use
    ).pipe(
      Effect.provide(AgentClient.layer(agent).pipe(Layer.provide(model)))
    )
  })

describe("AgentClient", () => {
  it.effect("runs a session through the client surface", () =>
    clientWith(
      [
        TestLanguageModel.toolCall("search", { query: "effect" }),
        TestLanguageModel.text("found it")
      ],
      Agent.make({
        toolkit: Agent.toolkit([Search], {
          search: ({ query }) => Effect.succeed(`hits for ${query}`)
        }),
        loop: AgentLoop.bounded(4)
      }),
      (client) =>
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* client.createSession({
              sessionId: "researcher-1"
            })
            assert.strictEqual(session.id, "researcher-1")

            const result = yield* session.prompt("find effect")
            assert.strictEqual(result.text, "found it")
            assert.strictEqual(result.status, "completed")
            assert.strictEqual(result.runs, 1)

            // Observations work the same way they do locally.
            const history = yield* session.history
            assert.deepStrictEqual(
              history.content.map((message) => message.role),
              ["user", "assistant", "tool", "assistant"]
            )
            assert.strictEqual(yield* session.status, "idle")

            // And the session is reachable by id while it is open.
            const again = yield* client.session("researcher-1")
            assert.strictEqual(again.id, session.id)
          })
        )
    )
  )

  it.effect("carries a result a protocol can actually encode", () =>
    clientWith(
      [TestLanguageModel.text("done")],
      Agent.make({}),
      (client) =>
        Effect.gen(function* () {
          // The local `Result` also holds a `GenerateTextResponse`, which no
          // wire format can carry. Dropping it is the point of the narrower
          // shape, and this asserts what remains really does round-trip.
          const encoded = yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* client.createSession()
              const result = yield* session.prompt("go")
              return JSON.parse(
                JSON.stringify(
                  yield* Schema.encodeEffect(AgentClient.RemoteResult)(result)
                )
              ) as unknown
            })
          )

          const decoded = yield* Schema.decodeUnknownEffect(
            AgentClient.RemoteResult
          )(encoded)
          assert.strictEqual(decoded.text, "done")
          assert.strictEqual(decoded.status, "completed")
        })
    )
  )

  it.effect("reports a session that is not open as a transport failure", () =>
    clientWith([], Agent.make({}), (client) =>
      Effect.gen(function* () {
        // Typed, not a defect: a caller can tell this apart from a session
        // that exists and is busy.
        const error = yield* Effect.flip(client.session("never-opened"))
        assert.strictEqual(error._tag, "AgentTransportError")
      })
    )
  )

  it.effect("streams events through the client", () =>
    clientWith(
      [TestLanguageModel.text("done")],
      Agent.make({}),
      (client) =>
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* client.createSession()
            // The same live stream a local session exposes, so an adapter has
            // an event source to forward rather than inventing one.
            const collected = yield* Effect.forkChild(
              Stream.runCollect(Stream.take(session.events, 3))
            )
            yield* Effect.yieldNow
            yield* session.prompt("go")
            const events = yield* Fiber.join(collected)

            assert.deepStrictEqual(
              events.map((entry) => entry.event._tag),
              ["SubmissionStarted", "RunStarted", "TurnStarted"]
            )
          })
        )
    )
  )

  it.effect("maps failures the protocol cannot carry, and passes on the rest", () =>
    Effect.gen(function* () {
      // Two different shapes have to come out right here, and neither was
      // covered before.
      //
      // A tool's typed failure is not part of the protocol -- a caller with no
      // tool definitions cannot act on it -- so it arrives described, as a
      // transport error. A session-level failure *is* part of the protocol and
      // must survive as itself, or a client cannot tell "busy" from "broken".
      const { layer: model } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall("boom", {}, { id: "b1" }),
        { text: "unused", hang: true }
      ])

      const agent = Agent.make({
        toolkit: Agent.toolkit([Boom], {
          boom: () => Effect.fail("declined")
        }),
        toolFailurePolicy: ToolExecution.FailRun,
        loop: AgentLoop.bounded(2)
      })

      yield* Effect.flatMap(
        Effect.service(AgentClient.AgentClient),
        (client) =>
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* client.createSession()

              const described = yield* Effect.flip(session.prompt("go"))
              assert.strictEqual(described._tag, "AgentTransportError")
              if (described._tag === "AgentTransportError") {
                // The tool's own reason survives, even though its type did not.
                assert.include(described.detail, "declined")
              }

              // A second submission while the first is still running: this one
              // is a protocol-level failure and keeps its identity.
              const running = yield* Effect.forkChild(session.prompt("again"))
              yield* Effect.yieldNow
              yield* Effect.yieldNow
              const busy = yield* Effect.flip(session.prompt("and again"))
              assert.strictEqual(busy._tag, "AgentBusyError")
              yield* Fiber.interrupt(running)
            })
          )
      ).pipe(
        Effect.provide(AgentClient.layer(agent).pipe(Layer.provide(model)))
      )
    })
  )
})
