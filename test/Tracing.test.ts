import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Option } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import { Echo, EchoToolkit, withSession } from "./helpers.js"

describe("tracing", () => {
  it.effect("engine operations produce named, nested spans", () =>
    Effect.gen(function* () {
      const seen = yield* Deferred.make<ReadonlyArray<string>>()

      // Capture the span chain from inside a tool handler: that is the deepest
      // point of the engine, so its ancestry proves the whole nesting.
      const tracingToolkit = EchoToolkit.pipe(
        Effect.provide(
          EchoToolkit.toLayer({
            echo: ({ value }) =>
              Effect.gen(function* () {
                const span = yield* Effect.currentSpan
                const names: Array<string> = []
                let current: any = span
                while (current !== undefined) {
                  names.push(current.name)
                  current =
                    current.parent !== undefined && Option.isSome(current.parent)
                      ? current.parent.value
                      : undefined
                }
                yield* Deferred.succeed(seen, names)
                return value
              }).pipe(Effect.orDie)
          })
        )
      )

      yield* withSession(
        [
          { toolCalls: [{ id: "t1", name: "echo", params: { value: "x" } }] },
          { text: "done" }
        ],
        Agent.make({ toolkit: tracingToolkit }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      const names = yield* Deferred.await(seen)

      // `Effect.fn` names each engine operation, so a trace reads as the
      // execution structure rather than one opaque span.
      assert.include(names, "ToolExecution.tool")
      assert.include(names, "AgentTurn.execute")
      assert.include(names, "AgentRun.execute")
      assert.include(names, "AgentSubmission.execute")

      // Nesting order: tool inside turn inside run inside submission.
      assert.isBelow(
        names.indexOf("ToolExecution.tool"),
        names.indexOf("AgentTurn.execute")
      )
      assert.isBelow(
        names.indexOf("AgentTurn.execute"),
        names.indexOf("AgentRun.execute")
      )
      assert.isBelow(
        names.indexOf("AgentRun.execute"),
        names.indexOf("AgentSubmission.execute")
      )
    })
  )
})
