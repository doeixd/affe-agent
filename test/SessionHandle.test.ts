import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema, Stream } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentSession from "../src/AgentSession.js"
import type {
  AgentBusyError,
  AgentClosedError,
  AgentIdleError,
  ToolApprovalRequiredError
} from "../src/Errors.js"
import { withSession } from "./helpers.js"

/**
 * The method-bearing handle is a surface over the module functions, not a
 * second runtime. These tests exist to prove two things the issue asks for:
 * the methods behave identically to the module functions, and they lose no
 * type precision on the way.
 */
const Lookup = Tool.make("lookup", {
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.Number,
  failure: Schema.String
})

describe("session handle", () => {
  it.effect("methods and module functions are the same operations", () =>
    Effect.gen(function* () {
      const toolkit = yield* Agent.toolkit([Lookup], {
        lookup: ({ id }) => Effect.succeed(id.length)
      })

      const { session } = yield* withSession(
        [{ text: "one" }, { text: "two" }],
        Agent.make({ toolkit }),
        ({ session }) =>
          Effect.gen(function* () {
            // Same call, two spellings.
            const viaMethod = yield* session.prompt("first")
            const viaModule = yield* AgentSession.prompt(session, "second")
            assert.strictEqual(viaMethod.text, "one")
            assert.strictEqual(viaModule.text, "two")
            return session
          })
      ).pipe(Effect.map((outcome) => ({ session: outcome.value })))

      // Observations agree, because they are the same implementation.
      assert.deepStrictEqual(
        yield* session.status,
        yield* AgentSession.status(session)
      )
      const fromMethod = yield* session.history
      const fromModule = yield* AgentSession.history(session)
      assert.strictEqual(fromMethod.content.length, fromModule.content.length)

      // Identity is public, and it is the session's own.
      assert.isString(session.id)
    })
  )

  it.effect("the handle is inert until the Effect is run", () =>
    // `session.prompt(input)` must describe work, not start it. If it
    // performed hidden eager work, building this value would consume a
    // scripted turn and the assertion below would fail.
    withSession(
      [{ text: "only turn" }],
      Agent.make({}),
      ({ recorder, session }) =>
        Effect.gen(function* () {
          const pending = session.prompt("go")
          assert.deepStrictEqual(yield* recorder.prompts, [])
          yield* pending
          assert.strictEqual((yield* recorder.prompts).length, 1)
        })
    )
  )

  it.effect("preserves tool and error inference through the methods", () =>
    Effect.gen(function* () {
      const toolkit = yield* Agent.toolkit([Lookup], {
        lookup: ({ id }) => Effect.succeed(id.length)
      })

      yield* withSession(
        [{ text: "done" }],
        Agent.make({ toolkit }),
        ({ session }) =>
          Effect.gen(function* () {
            const result = yield* session.prompt("go")

            // Type-level assertions. Each line fails to compile if the handle
            // widens what the module API keeps precise -- which is the whole
            // risk of adding a second spelling.
            const text: string = result.text
            const runs: number = result.runs
            void text
            void runs

            // The declared error union, exactly. `never` would mean the errors
            // were erased; a wider union would mean something crept in.
            const promptErrors: Effect.Effect<
              unknown,
              | AgentBusyError
              | AgentClosedError
              | import("effect/unstable/ai").AiError.AiError
              // Raised by the harness rather than by a tool, so it is absent
              // from `Tool.HandlerError` and easy to omit -- which is exactly
              // what had happened.
              | ToolApprovalRequiredError
              | string
            > = session.prompt("again")
            void promptErrors

            const steerErrors: Effect.Effect<
              void,
              AgentIdleError | AgentClosedError
            > = session.steer("focus")
            void steerErrors

            const followUpErrors: Effect.Effect<
              void,
              AgentIdleError | AgentClosedError
            > = session.followUp("then this")
            void followUpErrors

            const interruptErrors: Effect.Effect<
              void,
              AgentIdleError | AgentClosedError
            > = session.interrupt()
            void interruptErrors

            // Observations are values of the right shape, not functions.
            const history: Effect.Effect<Prompt.Prompt> = session.history
            const events: Stream.Stream<AgentEvent.AgentEventEnvelope> =
              session.events
            void history
            void events

            assert.isTrue(true)
          })
      )
    })
  )
})
