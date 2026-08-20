import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as FakeModel from "./FakeModel.js"
import { withSession } from "./helpers.js"

/**
 * `prompt`, `steer` and `followUp` take `Prompt.RawInput`, not `string`.
 *
 * A string is the common case and still works, but restricting the API to it
 * would have excluded exactly the conversations Effect AI exists to support:
 * images, files, prior assistant turns, anything structured.
 */
describe("raw prompt input", () => {
  it.effect("accepts a structured Prompt as well as a string", () =>
    Effect.gen(function* () {
      const structured = Prompt.make([
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            {
              type: "file",
              mediaType: "image/png",
              data: "aGVsbG8=",
              fileName: "shot.png"
            }
          ]
        }
      ])

      const { recorder, session } = yield* withSession(
        [{ text: "a screenshot" }],
        Agent.make({}),
        ({ session }) => AgentSession.prompt(session, structured)
      )

      // The model saw the multimodal message intact.
      const seen = (yield* recorder.prompts)[0]!
      const user = seen.content.find((m) => m.role === "user")
      assert.isDefined(user)
      const parts = (user as Prompt.UserMessage).content.map((p) => p.type)
      assert.deepStrictEqual(parts, ["text", "file"])

      // And canonical history kept it, not a flattened string.
      const history = yield* AgentSession.history(session)
      const committed = history.content.find((m) => m.role === "user")
      assert.strictEqual(
        (committed as Prompt.UserMessage).content.length,
        2
      )
    })
  )

  it.effect("steering accepts structured input too", () =>
    Effect.gen(function* () {
      const sessionRef = yield* Deferred.make<AgentSession.AgentSession<any>>()

      const { recorder } = yield* withSession(
        [
          {
            during: Effect.gen(function* () {
              const s = yield* Deferred.await(sessionRef)
              yield* AgentSession.steer(
                s,
                Prompt.make([
                  {
                    role: "user",
                    content: [{ type: "text", text: "look closer" }]
                  }
                ])
              )
            }).pipe(Effect.orDie),
            toolCalls: []
          },
          { text: "done" }
        ],
        Agent.make({
          loop: (state) =>
            Effect.succeed(
              state.turnIndex < 2 ? { _tag: "Continue" } : { _tag: "Stop" }
            )
        }),
        ({ session }) =>
          Deferred.succeed(sessionRef, session).pipe(
            Effect.andThen(AgentSession.prompt(session, "start"))
          )
      )

      const prompts = yield* recorder.prompts
      assert.deepStrictEqual(FakeModel.userTexts(prompts[1]!), [
        "start",
        "look closer"
      ])
    })
  )
})
