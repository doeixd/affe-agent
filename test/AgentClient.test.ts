import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import * as Agent from "../src/Agent.js"
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

  it.effect("reports a session that is not open as a transport failure", () =>
    Effect.flatMap(
      TestLanguageModel.script([]),
      ({ layer: model }) =>
        Effect.flatMap(Effect.service(AgentClient.AgentClient), (client) =>
          Effect.gen(function* () {
            // Typed, not a defect: a caller can tell this apart from a session
            // that exists and is busy.
            const error = yield* Effect.flip(client.session("never-opened"))
            assert.strictEqual(error._tag, "AgentTransportError")
          })
        ).pipe(
          Effect.provide(
            AgentClient.layer(Agent.make({})).pipe(Layer.provide(model))
          )
        )
    )
  )
})
