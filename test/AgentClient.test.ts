import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import { AgentBusyError } from "../src/Errors.js"
import { SessionId } from "../src/internal/ids.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { AgentClient } from "../src/client/index.js"
import { TestLanguageModel } from "../src/testing/index.js"
import * as Contract from "./AgentClientContract.js"

/**
 * The in-process implementation, checked against the shared client contract,
 * plus behaviour specific to being local: what a result looks like when no
 * wire is involved, and how an unknown session id fails.
 */
const harness: Contract.Harness = {
  name: "local",
  layer: ({ agent, turns, elicitation }) =>
    Effect.map(TestLanguageModel.script(turns), ({ layer: model }) =>
      AgentClient.layer(agent, elicitation ? { elicitation } : undefined).pipe(
        Layer.provide(model)
      )
    )
}

Contract.run(harness)

describe("AgentClient (local specifics)", () => {
  it.effect("carries a result a protocol can actually encode", () =>
    Effect.flatMap(
      TestLanguageModel.script([TestLanguageModel.text("done")]),
      ({ layer: model }) =>
        Effect.flatMap(Effect.service(AgentClient.AgentClient), (client) =>
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
        ).pipe(
          Effect.provide(
            AgentClient.layer(Agent.make({})).pipe(Layer.provide(model))
          )
        )
    )
  )
  it.effect("reports a session that is not open as not found, not as a transport failure", () =>
    Effect.flatMap(
      TestLanguageModel.script([]),
      ({ layer: model }) =>
        Effect.flatMap(Effect.service(AgentClient.AgentClient), (client) =>
          Effect.gen(function* () {
            // Typed, and not wearing the transport tag: a caller retrying
            // transport failures must not retry a lookup that can never
            // succeed, and can tell this apart from a session that is busy.
            const error = yield* Effect.flip(client.session("never-opened"))
            assert.strictEqual(error._tag, "AgentSessionNotFoundError")
          })
        ).pipe(
          Effect.provide(
            AgentClient.layer(Agent.make({})).pipe(Layer.provide(model))
          )
        )
    )
  )
})

/**
 * R174 -- a tag is not a wire contract.
 *
 * `isRemote` recognised six `_tag` strings, and a tool may legally fail with
 * `{ _tag: "AgentBusyError" }` -- or with the right tag and the wrong fields.
 * `prompt` then declined to wrap it as an `AgentExecutionError`, so a value
 * that is not a `RemoteError` travelled under the whole `RemoteError` type and
 * the RPC or HTTP encoding failed later instead of the agent failure being
 * reported at all.
 */
describe("AgentClient remote-error recognition", () => {
  const failWith = (failure: unknown) =>
    Effect.gen(function* () {
      const Break = Tool.make("break", {
        parameters: Schema.Struct({}),
        success: Schema.String,
        failure: Schema.Unknown
      })
      const toolkit = Agent.toolkit([Break], { break: () => Effect.fail(failure) })
      const agent = Agent.make({ toolkit, toolFailurePolicy: ToolExecution.FailRun })
      const { layer: model } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "b1", name: "break", params: {} }] },
        TestLanguageModel.text("unreachable")
      ])

      return yield* Effect.gen(function* () {
        const client = yield* Effect.service(AgentClient.AgentClient)
        const session = yield* client.createSession()
        return yield* Effect.flip(session.prompt("go"))
      }).pipe(
        Effect.provide(AgentClient.layer(agent).pipe(Layer.provide(model))),
        Effect.scoped
      )
    })

  it.effect("a tool failure wearing a remote tag is still an execution error", () =>
    Effect.gen(function* () {
      // A plain object with the right tag and none of the fields. It used to
      // be passed through as though it were the real thing.
      const impostor = yield* failWith({ _tag: "AgentBusyError" })
      assert.strictEqual(impostor._tag, "AgentExecutionError")

      // And with the right tag but a malformed field.
      const malformed = yield* failWith({ _tag: "AgentBusyError", sessionId: 42 })
      assert.strictEqual(malformed._tag, "AgentExecutionError")
    })
  )

  it.effect("a genuine remote error still crosses unchanged", () =>
    Effect.gen(function* () {
      const real = yield* failWith(
        new AgentBusyError({ sessionId: SessionId.make("session-1") })
      )
      // The real thing is carried as itself, not rewrapped -- otherwise the
      // check above would pass by wrapping everything.
      assert.strictEqual(real._tag, "AgentBusyError")
    })
  )
})
