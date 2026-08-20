import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as FakeModel from "./FakeModel.js"

/**
 * A tool may declare `dependencies`, and its handler then requires those
 * services. Those requirements must reach `AgentSession.make` — otherwise the
 * program typechecks and fails at the first tool call, which is exactly the
 * class of error the Effect environment exists to prevent.
 */
class Greeter extends Context.Service<Greeter>()("Greeter", {
  make: Effect.succeed({ greet: (who: string) => `hello ${who}` })
}) {}

const Greet = Tool.make("greet", {
  parameters: Schema.Struct({ who: Schema.String }),
  success: Schema.String,
  dependencies: [Greeter]
})

describe("tool requirements", () => {
  it.effect("a tool's declared dependency is demanded and used", () =>
    Effect.gen(function* () {
      const used = yield* Ref.make<Array<string>>([])

      const toolkit = Agent.toolkit([Greet], {
        greet: ({ who }) =>
          Effect.gen(function* () {
            const greeter = yield* Greeter
            const text = greeter.greet(who)
            yield* Ref.update(used, (all) => [...all, text])
            return text
          })
      })

      const agent = Agent.make({ toolkit })
      const { layer } = yield* FakeModel.layer([
        {
          toolCalls: [
            { id: "g1", name: "greet", params: { who: "world" } }
          ]
        },
        { text: "done" }
      ])

      // `Greeter` must be provided here; omitting it is a type error, not a
      // runtime surprise.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(agent)
          yield* AgentSession.prompt(session, "go")
        }).pipe(
          Effect.provide(
            Layer.mergeAll(layer, Layer.succeed(Greeter)({ greet: (who: string) => `hello ${who}` }))
          )
        )
      )

      assert.deepStrictEqual(yield* Ref.get(used), ["hello world"])
    })
  )

  it("omitting the dependency is a type error", () => {
    const toolkit = Agent.toolkit([Greet], {
      greet: ({ who }) => Effect.map(Greeter, (g) => g.greet(who))
    })
    const agent = Agent.make({ toolkit })

    const withoutGreeter = Effect.scoped(
      Effect.gen(function* () {
        const session = yield* AgentSession.make(agent)
        return yield* AgentSession.prompt(session, "go")
      })
    )

    // A type-level assertion rather than a deliberately-failing assignment:
    // the requirement must still contain `Greeter`, so forgetting to provide
    // it cannot compile.
    type Requirements = typeof withoutGreeter extends Effect.Effect<
      any,
      any,
      infer R
    >
      ? R
      : never
    type GreeterRequired = Greeter extends Requirements ? true : false
    const required: GreeterRequired = true
    assert.isTrue(required)
  })
})
