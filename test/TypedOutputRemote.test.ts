import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentOutput from "../src/AgentOutput.js"
import { AgentClient } from "../src/client/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * A typed output across the remote boundary (`remaining-work.md` item 35).
 *
 * `Result.value` was local to an in-process session: `RemoteResult` is one
 * schema shared by every agent, so it could not name any particular agent's
 * `Value`, and a remote caller had to read the answer back out of history and
 * hope. What crosses now is the *encoded* value, and the caller names what it
 * expects -- the shape `AgentA2A.typed` has used across the same kind of
 * boundary for a while, so there is one story rather than two.
 */

const Triage = Schema.Struct({
  severity: Schema.Literals(["low", "high"]),
  summary: Schema.String
})

const triage = AgentOutput.make(Triage, { name: "triage" })

const agent = Agent.make({
  instructions: "Triage it.",
  output: triage,
  loop: AgentLoop.bounded(2)
})

/** The model answers by calling the output tool, which is how a value is produced. */
const answering = (severity: "low" | "high") =>
  TestLanguageModel.script([
    TestLanguageModel.toolCall("triage", { severity, summary: "disk is full" })
  ])

describe("a typed output across the remote boundary", () => {
  it.live("the declared value crosses, decoded with the agent's own schema", () =>
    Effect.gen(function* () {
      const { layer: model } = yield* answering("high")

      yield* Effect.gen(function* () {
        const client = yield* AgentClient.typed(agent)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* client.createSession()
            const result = yield* session.prompt("the disk filled up")

            assert.isTrue(
              Option.isSome(result.value),
              "the agent declared an output and produced one, and it did not cross"
            )
            if (Option.isSome(result.value)) {
              // Decoded, not the wire form: a caller reads its own type.
              assert.strictEqual(result.value.value.severity, "high")
              assert.strictEqual(result.value.value.summary, "disk is full")
            }

            // `awaitSubmission` answers with the same thing, since it is the
            // same result read a second time.
            const again = yield* session.awaitSubmission(result.submissionId)
            assert.deepStrictEqual(again.value, result.value)
          })
        )
      }).pipe(Effect.provide(AgentClient.layer(agent).pipe(Layer.provide(model))))
    })
  )

  it.live("an agent with no declared output reports None rather than inventing one", () =>
    Effect.gen(function* () {
      const plain = Agent.make({ instructions: "Answer.", loop: AgentLoop.bounded(2) })
      const { layer: model } = yield* TestLanguageModel.script([TestLanguageModel.text("done")])

      yield* Effect.gen(function* () {
        const client = yield* AgentClient.typed(plain)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* client.createSession()
            const result = yield* session.prompt("hello")
            assert.strictEqual(result.text, "done")
            assert.isTrue(Option.isNone(result.value))
          })
        )
      }).pipe(Effect.provide(AgentClient.layer(plain).pipe(Layer.provide(model))))
    })
  )

  it.live("a value that does not decode is the far end's fault, not a defect here", () =>
    Effect.gen(function* () {
      const { layer: model } = yield* answering("high")

      /**
       * The caller expects a different shape than the one that answered --
       * a different version of the agent, or a different agent behind the
       * same id. That is a statement about the far end, so it arrives as a
       * codec error against the response rather than killing the caller.
       */
      const Expected = Schema.Struct({ severity: Schema.Number })
      const mismatched = Agent.make({
        instructions: "Triage it.",
        output: AgentOutput.make(Expected, { name: "triage" }),
        loop: AgentLoop.bounded(2)
      })

      yield* Effect.gen(function* () {
        // Served by the agent that produces a *string* severity; read by a
        // caller that expects a number.
        const client = yield* AgentClient.typed(mismatched)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* client.createSession()
            const failure = yield* Effect.flip(session.prompt("the disk filled up"))
            assert.strictEqual(failure._tag, "AgentProtocolCodecError")
            assert.include(failure.message, "did not decode")
          })
        )
      }).pipe(Effect.provide(AgentClient.layer(agent).pipe(Layer.provide(model))))
    })
  )
})
