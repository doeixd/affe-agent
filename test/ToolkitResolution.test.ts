import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * A toolkit may be an Effect, so capabilities can vary with runtime state. That
 * only works if acquiring them is allowed to *fail* — connecting to a tenant's
 * MCP server, reading a policy, fetching a credential. Forbidding it pushed
 * every such resolver into dying, or into pre-resolving outside the agent,
 * which defeats the point of resolving per turn.
 */
class CapabilityUnavailable extends Schema.TaggedError<CapabilityUnavailable>()(
  "CapabilityUnavailable",
  { detail: Schema.String }
) {}

const Ping = Tool.make("ping", {
  parameters: Schema.Struct({}),
  success: Schema.String
})

describe("toolkit resolution", () => {
  it.effect("a failing resolver surfaces as the agent's own error", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.text("never reached")
      ])

      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({
              toolkit: Effect.fail(
                new CapabilityUnavailable({ detail: "tenant offline" })
              ),
              loop: AgentLoop.bounded(1)
            })
          )
          // Catching by tag is the assertion: it only compiles because the
          // resolver's failure joined the agent's error type, and `catchTag`
          // on an absent tag is a type error rather than a silent no-op.
          return yield* session.prompt("go").pipe(
            Effect.map(() => "completed" as const),
            Effect.catchTag("CapabilityUnavailable", (error) =>
              Effect.succeed(error.detail)
            )
          )
        })
      ).pipe(Effect.provide(layer))

      assert.strictEqual(outcome, "tenant offline")
    })
  )

  it.effect("a resolver that succeeds is unaffected", () =>
    Effect.gen(function* () {
      // The Effect form still resolves per turn, which is the reason it exists.
      const resolutions = yield* Ref.make(0)
      const { layer } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "p1", name: "ping", params: {} }] },
        TestLanguageModel.text("done")
      ])

      const text = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({
              toolkit: Ref.update(resolutions, (n) => n + 1).pipe(
                Effect.andThen(
                  Agent.toolkit([Ping], { ping: () => Effect.succeed("pong") })
                )
              ),
              loop: AgentLoop.bounded(4)
            })
          )
          const result = yield* session.prompt("go")
          return result.text
        })
      ).pipe(Effect.provide(layer))

      assert.strictEqual(text, "done")
      // Two turns, two resolutions: capabilities really are re-read.
      assert.strictEqual(yield* Ref.get(resolutions), 2)
    })
  )
})
