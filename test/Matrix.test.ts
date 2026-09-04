import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Option, Stream } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as ContextTransform from "../src/ContextTransform.js"
import * as ToolExecution from "../src/ToolExecution.js"
import * as FakeModel from "./FakeModel.js"
import { EchoToolkit, echoToolkit, tags, withSession } from "./helpers.js"

const callEcho = (id: string, value = "x") => ({
  id,
  name: "echo",
  params: { value }
})

/**
 * The cases named in PLAN §44 that the main suite does not already cover.
 */

describe("canonical history", () => {
  it.effect("a failed turn commits nothing", () =>
    Effect.gen(function* () {
      const failing = EchoToolkit.pipe(
        Effect.provide(
          EchoToolkit.toLayer({ echo: () => Effect.die(new Error("boom")) })
        )
      )

      const { session } = yield* withSession(
        [
          { text: "committed" },
          { text: "doomed", toolCalls: [callEcho("t1")] }
        ],
        Agent.make({
          toolkit: failing,
          loop: AgentLoop.make(() => Effect.succeed(AgentLoop.Stop))
        }),
        ({ session }) =>
          Effect.gen(function* () {
            yield* AgentSession.prompt(session, "one")
            const second = yield* Effect.exit(
              AgentSession.prompt(session, "two")
            )
            assert.isTrue(Exit.isFailure(second))
          })
      )

      // The failed turn's assistant message is absent: a turn commits as a
      // unit, and this one never completed.
      const history = yield* AgentSession.history(session)
      assert.deepStrictEqual(FakeModel.roles(history), [
        "user",
        "assistant",
        "user"
      ])
    })
  )

  it.effect("tool results are committed in call order", () =>
    Effect.gen(function* () {
      const { session } = yield* withSession(
        [
          {
            toolCalls: [
              callEcho("t1", "first"),
              callEcho("t2", "second"),
              callEcho("t3", "third")
            ]
          },
          { text: "done" }
        ],
        Agent.make({ toolkit: echoToolkit }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      const history = yield* AgentSession.history(session)
      const toolMessage = history.content.find((m) => m.role === "tool")
      assert.isDefined(toolMessage)
      // Parallel execution must not reorder results relative to the calls.
      assert.deepStrictEqual(
        (toolMessage as { content: ReadonlyArray<{ id: string }> }).content.map(
          (part) => part.id
        ),
        ["t1", "t2", "t3"]
      )
    })
  )
})

describe("turn ordering", () => {
  it.effect("follows the lifecycle PLAN §14 specifies", () =>
    Effect.gen(function* () {
      const observed: Array<string> = []

      const recordingTransform = ContextTransform.make((context) =>
        Effect.sync(() => {
          observed.push("derive")
          return context.canonicalPrompt
        })
      )

      const recordingToolkit = EchoToolkit.pipe(
        Effect.provide(
          EchoToolkit.toLayer({
            echo: ({ value }) =>
              Effect.sync(() => {
                observed.push("tool")
                return value
              })
          })
        )
      )

      const recordingLoop = AgentLoop.make((state) =>
        Effect.sync(() => {
          observed.push("loop")
          return state.toolCalls.length > 0 ? AgentLoop.Continue : AgentLoop.Stop
        })
      )

      const { events, session } = yield* withSession(
        [
          {
            during: Effect.sync(() => observed.push("model")),
            toolCalls: [callEcho("t1")]
          },
          { during: Effect.sync(() => observed.push("model")), text: "done" }
        ],
        Agent.make({
          toolkit: recordingToolkit,
          contextTransform: recordingTransform,
          loop: recordingLoop
        }),
        ({ session }) =>
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(
              AgentSession.prompt(session, "go")
            )
            // Steering queued before the run starts is drained by turn 1.
            yield* Fiber.join(fiber)
          })
      )

      // Derive precedes the model call; tools run before the loop decides.
      assert.deepStrictEqual(observed, [
        "derive",
        "model",
        "tool",
        "loop",
        "derive",
        "model",
        "loop"
      ])

      // And TurnStarted is emitted after derivation, so it is never orphaned.
      const turnTags = tags(events).filter((tag) =>
        ["TurnStarted", "ToolCallStarted", "TurnCompleted"].includes(tag)
      )
      assert.deepStrictEqual(turnTags, [
        "TurnStarted",
        "ToolCallStarted",
        "TurnCompleted",
        "TurnStarted",
        "TurnCompleted"
      ])

      const history = yield* AgentSession.history(session)
      assert.deepStrictEqual(FakeModel.roles(history), [
        "user",
        "assistant",
        "tool",
        "assistant"
      ])
    })
  )
})

describe("steering arrival points", () => {
  it.effect("steer after the model responded, as tools begin", () =>
    Effect.gen(function* () {
      const sessionRef = yield* Deferred.make<AgentSession.AgentSession<any>>()
      const steered = yield* Deferred.make<void>()

      const { recorder } = yield* withSession(
        [{ toolCalls: [callEcho("t1")] }, { text: "done" }],
        Agent.make({ toolkit: echoToolkit }),
        ({ session }) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(sessionRef, session)
            // Steer on the first observable event after the model call.
            yield* Effect.forkChild(
              Stream.runForEach(AgentSession.events(session), (envelope) =>
                envelope.event._tag === "ToolCallStarted"
                  ? AgentSession.steer(session, "after the response").pipe(
                      Effect.andThen(Deferred.succeed(steered, void 0)),
                      Effect.ignore
                    )
                  : Effect.void
              )
            )
            yield* AgentSession.prompt(session, "go")
            yield* Deferred.await(steered)
          })
      )

      const prompts = yield* recorder.prompts
      assert.deepStrictEqual(FakeModel.userTexts(prompts[1]!), [
        "go",
        "after the response"
      ])
    })
  )

  it.effect("steer at a turn boundary, from inside the loop", () =>
    Effect.gen(function* () {
      const sessionRef = yield* Deferred.make<AgentSession.AgentSession<any>>()

      // `decide` runs after a turn commits and before the next begins.
      const steeringLoop = AgentLoop.make((state) =>
        Effect.gen(function* () {
          if (state.turnIndex > 1) return AgentLoop.Stop
          const session = yield* Deferred.await(sessionRef)
          yield* AgentSession.steer(session, "at the boundary").pipe(
            Effect.ignore
          )
          return AgentLoop.Continue
        })
      )

      const { recorder } = yield* withSession(
        [{ text: "one" }, { text: "two" }],
        Agent.make({ loop: steeringLoop }),
        ({ session }) =>
          Deferred.succeed(sessionRef, session).pipe(
            Effect.andThen(AgentSession.prompt(session, "go"))
          )
      )

      const prompts = yield* recorder.prompts
      assert.deepStrictEqual(FakeModel.userTexts(prompts[1]!), [
        "go",
        "at the boundary"
      ])
    })
  )
})

describe("follow-up arrival points", () => {
  it.effect("follow-up queued during tool execution", () =>
    Effect.gen(function* () {
      const sessionRef = yield* Deferred.make<AgentSession.AgentSession<any>>()

      const queueing = EchoToolkit.pipe(
        Effect.provide(
          EchoToolkit.toLayer({
            echo: ({ value }) =>
              Effect.gen(function* () {
                const session = yield* Deferred.await(sessionRef)
                yield* AgentSession.followUp(session, "afterwards")
                return value
              }).pipe(Effect.orDie)
          })
        )
      )

      const { value } = yield* withSession(
        [{ toolCalls: [callEcho("t1")] }, { text: "done" }, { text: "extra" }],
        Agent.make({ toolkit: queueing }),
        ({ session }) =>
          Deferred.succeed(sessionRef, session).pipe(
            Effect.andThen(AgentSession.prompt(session, "go"))
          )
      )

      assert.strictEqual(value.runs, 2)
      assert.strictEqual(value.text, "extra")
    })
  )

  it.effect("follow-up queued between runs, during a later run", () =>
    Effect.gen(function* () {
      const sessionRef = yield* Deferred.make<AgentSession.AgentSession<any>>()

      const { events, value } = yield* withSession(
        [
          {
            during: Effect.gen(function* () {
              const session = yield* Deferred.await(sessionRef)
              yield* AgentSession.followUp(session, "second")
            }).pipe(Effect.orDie),
            text: "a"
          },
          {
            // Queued while run 2 is executing, so it extends the submission.
            during: Effect.gen(function* () {
              const session = yield* Deferred.await(sessionRef)
              yield* AgentSession.followUp(session, "third")
            }).pipe(Effect.orDie),
            text: "b"
          },
          { text: "c" }
        ],
        Agent.make({}),
        ({ session }) =>
          Deferred.succeed(sessionRef, session).pipe(
            Effect.andThen(AgentSession.prompt(session, "first"))
          )
      )

      assert.strictEqual(value.runs, 3)
      assert.strictEqual(
        events.filter(AgentEvent.is("SubmissionStarted")).length,
        1
      )
    })
  )
})

describe("interruption points", () => {
  it.effect("interrupt during multiple parallel tools", () =>
    Effect.gen(function* () {
      const firstRunning = yield* Deferred.make<void>()

      const hanging = EchoToolkit.pipe(
        Effect.provide(
          EchoToolkit.toLayer({
            echo: () =>
              Deferred.succeed(firstRunning, void 0).pipe(
                Effect.andThen(Effect.never),
                Effect.orDie
              )
          })
        )
      )

      const { events } = yield* withSession(
        [{ toolCalls: [callEcho("t1"), callEcho("t2"), callEcho("t3")] }],
        Agent.make({ toolkit: hanging, toolExecution: ToolExecution.Parallel }),
        ({ session }) =>
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(
              AgentSession.prompt(session, "go")
            )
            yield* Deferred.await(firstRunning)
            yield* AgentSession.interrupt(session)
            const result = yield* Fiber.join(fiber)
            assert.strictEqual(result.status, "interrupted")
          })
      )

      // Every started call gets exactly one terminal event, even in parallel.
      const started = events.filter(AgentEvent.is("ToolCallStarted"))
      const interrupted = events.filter(AgentEvent.is("ToolCallInterrupted"))
      assert.strictEqual(started.length, 3)
      assert.strictEqual(interrupted.length, 3)
    })
  )

  it.effect("interrupt between turns, after a turn committed", () =>
    Effect.gen(function* () {
      const sessionRef = yield* Deferred.make<AgentSession.AgentSession<any>>()
      const atBoundary = yield* Deferred.make<void>()

      // Park the run between turns so interruption lands there deterministically.
      const parkingLoop = AgentLoop.make(() =>
        Deferred.succeed(atBoundary, void 0).pipe(
          Effect.andThen(Effect.never as Effect.Effect<AgentLoop.Decision>)
        )
      )

      const { events, session } = yield* withSession(
        [{ text: "committed" }, { text: "never reached" }],
        Agent.make({ loop: parkingLoop }),
        ({ session }) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(sessionRef, session)
            const fiber = yield* Effect.forkChild(
              AgentSession.prompt(session, "go")
            )
            yield* Deferred.await(atBoundary)
            yield* AgentSession.interrupt(session)
            const result = yield* Fiber.join(fiber)
            assert.strictEqual(result.status, "interrupted")
          })
      )

      // The committed turn survives; no second turn ever started.
      const history = yield* AgentSession.history(session)
      assert.deepStrictEqual(FakeModel.roles(history), ["user", "assistant"])
      assert.strictEqual(
        events.filter(AgentEvent.is("TurnStarted")).length,
        1
      )
    })
  )
})

describe("errors", () => {
  it.effect("interrupt on an idle session is rejected", () =>
    withSession([], Agent.make({}), ({ session }) =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(AgentSession.interrupt(session))
        assert.isTrue(Exit.isFailure(result))
      })
    )
  )
})

describe("events", () => {
  it.effect("no duplicate run or submission terminal events", () =>
    Effect.gen(function* () {
      const { events } = yield* withSession(
        [{ toolCalls: [callEcho("t1")] }, { text: "done" }],
        Agent.make({ toolkit: echoToolkit }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      const terminal = tags(events).filter((tag) =>
        [
          "RunCompleted",
          "RunFailed",
          "RunInterrupted",
          "SubmissionCompleted",
          "SubmissionFailed",
          "SubmissionInterrupted"
        ].includes(tag)
      )
      assert.deepStrictEqual(terminal, [
        "RunCompleted",
        "SubmissionCompleted"
      ])
    })
  )

  it.effect("turn index is correct across runs", () =>
    Effect.gen(function* () {
      const sessionRef = yield* Deferred.make<AgentSession.AgentSession<any>>()

      const { events } = yield* withSession(
        [
          {
            during: Effect.gen(function* () {
              const session = yield* Deferred.await(sessionRef)
              yield* AgentSession.followUp(session, "next")
            }).pipe(Effect.orDie),
            toolCalls: [callEcho("t1")]
          },
          { text: "a" },
          { text: "b" }
        ],
        Agent.make({ toolkit: echoToolkit }),
        ({ session }) =>
          Deferred.succeed(sessionRef, session).pipe(
            Effect.andThen(AgentSession.prompt(session, "go"))
          )
      )

      // Turn numbering restarts per run, not per submission.
      // Run ids are qualified by their session (`internal/ids.ts`); the
      // session's own prefix is stripped so the pin reads as the counter.
      const perRun = events
        .filter(AgentEvent.is("TurnStarted"))
        .map((e) => [
          Option.getOrNull(Option.map(e.runId, (id) => `${id}`.slice(`${e.sessionId}:`.length))),
          Option.getOrNull(e.turn)
        ])
      assert.deepStrictEqual(perRun, [
        ["run-1", 1],
        ["run-1", 2],
        ["run-2", 1]
      ])
    })
  )
})
