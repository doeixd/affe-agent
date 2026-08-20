import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { withSession } from "./helpers.js"

/**
 * The harness resolves tools itself, which means Effect AI's own safety
 * semantics stop applying unless the harness reimplements them. Silently
 * dropping them is the failure mode these tests exist to prevent.
 */
describe("tool safety semantics", () => {
  it.effect("a tool needing approval is refused, not executed", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make(0)

      const Dangerous = Tool.make("deleteEverything", {
        parameters: Schema.Struct({}),
        success: Schema.String
      }).setNeedsApproval(true)

      const toolkit = Agent.toolkit([Dangerous], {
        deleteEverything: () =>
          Ref.update(ran, (n) => n + 1).pipe(Effect.as("deleted"))
      })

      const { events, value } = yield* withSession(
        [
          {
            toolCalls: [
              { id: "d1", name: "deleteEverything", params: {} }
            ]
          },
          { text: "unreachable" }
        ],
        Agent.make({
          toolkit,
          // Even the forgiving policy must not turn a refusal into a quiet
          // "the tool said no" that the model shrugs off.
          toolFailurePolicy: ToolExecution.FailRun
        }),
        ({ session }) => Effect.exit(AgentSession.prompt(session, "go"))
      )

      assert.isTrue(Exit.isFailure(value))
      assert.strictEqual(yield* Ref.get(ran), 0)

      const failed = events.filter(AgentEvent.is("ToolCallFailed"))
      assert.strictEqual(failed.length, 1)
      assert.strictEqual(failed[0]!.event.failure.tag, "ToolApprovalRequiredError")
    })
  )

  it.effect("a tool without approval requirements still runs", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make(0)
      const Safe = Tool.make("safe", {
        parameters: Schema.Struct({}),
        success: Schema.String
      })
      const toolkit = Agent.toolkit([Safe], {
        safe: () => Ref.update(ran, (n) => n + 1).pipe(Effect.as("ok"))
      })

      yield* withSession(
        [
          { toolCalls: [{ id: "s1", name: "safe", params: {} }] },
          { text: "done" }
        ],
        Agent.make({ toolkit }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      assert.strictEqual(yield* Ref.get(ran), 1)
    })
  )

  it.effect("a provider-executed call is neither run locally nor awaited", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make(0)
      const Search = Tool.make("search", {
        parameters: Schema.Struct({ q: Schema.String }),
        success: Schema.String
      })
      const toolkit = Agent.toolkit([Search], {
        search: ({ q }) => Ref.update(ran, (n) => n + 1).pipe(Effect.as(q))
      })

      const { events } = yield* withSession(
        [
          {
            // The provider already ran this one.
            toolCalls: [
              {
                id: "p1",
                name: "search",
                params: { q: "effect" },
                providerExecuted: true
              }
            ],
            text: "answered using web search"
          }
        ],
        Agent.make({ toolkit }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      // Not executed again locally...
      assert.strictEqual(yield* Ref.get(ran), 0)
      assert.strictEqual(
        events.filter(AgentEvent.is("ToolCallStarted")).length,
        0
      )
      // ...and not treated as outstanding work, so the run stopped at one turn.
      assert.strictEqual(
        events.filter(AgentEvent.is("RunCompleted"))[0]!.event.turns,
        1
      )
    })
  )
})
