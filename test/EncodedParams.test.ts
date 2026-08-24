import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Permission from "../src/Permission.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { withSession } from "./helpers.js"

/**
 * The harness runs with `disableToolCallResolution: true`, and Effect AI
 * deliberately leaves tool parameters in their **encoded** schema form in that
 * mode — decoding is the handler's job.
 *
 * For `{ query: Schema.String }` encoded and decoded coincide, so a wrong type
 * here is invisible. A transforming schema is where it bites: the loop would be
 * typed as holding a `Date` while actually holding a string.
 */
const Remind = Tool.make("remind", {
  parameters: Schema.Struct({ at: Schema.DateFromString }),
  success: Schema.String
})

describe("encoded tool parameters", () => {
  it.effect("permission and dynamic approval receive decoded parameters", () =>
    Effect.gen(function* () {
      const approvalSaw = yield* Ref.make<Array<Date>>([])
      const policyCalls = yield* Ref.make(0)
      const DecodedRemind = Permission.annotate(
        Tool.make("decoded_remind", {
          parameters: Schema.Struct({ at: Schema.DateFromString }),
          success: Schema.String,
          needsApproval: ({ at }) =>
            Ref.update(approvalSaw, (all) => [...all, at]).pipe(
              Effect.as(false)
            )
        }),
        {
          action: "schedule",
          resource: ({ at }) => at.toISOString()
        }
      )

      const valid = yield* ToolExecution.decide(
        DecodedRemind,
        {
          id: "r1",
          name: "decoded_remind",
          params: { at: "2026-01-01T00:00:00.000Z" }
        },
        {
          sessionId: "session-1",
          messages: [],
          permission: Permission.make(() =>
            Ref.updateAndGet(policyCalls, (count) => count + 1).pipe(
              Effect.as(Permission.allow)
            ))
        }
      )

      assert.strictEqual(valid._tag, "Decided")
      if (valid._tag !== "Decided") return
      assert.strictEqual(valid.request.resource, "2026-01-01T00:00:00.000Z")
      const seen = yield* Ref.get(approvalSaw)
      assert.strictEqual(seen.length, 1)
      assert.instanceOf(seen[0], Date)
      assert.strictEqual(yield* Ref.get(policyCalls), 1)

      const invalid = yield* ToolExecution.decide(
        DecodedRemind,
        {
          id: "r2",
          name: "decoded_remind",
          params: { at: "not-a-date" }
        },
        {
          sessionId: "session-1",
          messages: [],
          permission: Permission.make(() =>
            Ref.updateAndGet(policyCalls, (count) => count + 1).pipe(
              Effect.as(Permission.allow)
            ))
        }
      )

      assert.strictEqual(invalid._tag, "InvalidParameters")
      assert.strictEqual((yield* Ref.get(approvalSaw)).length, 1)
      assert.strictEqual(yield* Ref.get(policyCalls), 1)
    })
  )

  it.effect("a loop observes encoded params, and is typed for them", () =>
    Effect.gen(function* () {
      const seenByLoop = yield* Ref.make<Array<unknown>>([])
      const seenByHandler = yield* Ref.make<Array<unknown>>([])

      const toolkit = yield* Agent.toolkit([Remind], {
        // The handler receives the *decoded* value: schema decoding happens
        // here, which is exactly why the harness must not claim it already did.
        remind: ({ at }) =>
          Ref.update(seenByHandler, (all) => [...all, at]).pipe(
            Effect.as("scheduled")
          )
      })

      yield* withSession(
        [
          {
            toolCalls: [
              {
                id: "r1",
                name: "remind",
                params: { at: "2026-01-01T00:00:00.000Z" }
              }
            ]
          },
          { text: "done" }
        ],
        Agent.make({
          toolkit,
          // Written inline so `state` is typed by this object's toolkit.
          loop: (state) =>
            Effect.gen(function* () {
              for (const call of state.toolCalls) {
                // Typed `string` — the encoded form. This line is the test:
                // it would not compile if the harness claimed decoded params.
                const at: string = call.params.at
                yield* Ref.update(seenByLoop, (all) => [...all, at])
              }
              return state.toolCalls.length > 0
                ? AgentLoop.Continue
                : AgentLoop.Stop
            })
        }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      // The loop saw the raw string off the wire...
      assert.deepStrictEqual(yield* Ref.get(seenByLoop), [
        "2026-01-01T00:00:00.000Z"
      ])

      // ...while the handler saw a decoded Date. Typing the loop as decoded
      // would have been a lie about both.
      const decoded = yield* Ref.get(seenByHandler)
      assert.strictEqual(decoded.length, 1)
      assert.instanceOf(decoded[0], Date)
    })
  )
})
