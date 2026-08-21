import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Ref, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentSession from "../src/AgentSession.js"
import { withSession } from "./helpers.js"

/**
 * A tool handler may call `context.preliminary` to report intermediate results
 * during a long-running call. Those used to be collected and discarded, which
 * made a long-running tool invisible for exactly as long as it was
 * interesting.
 *
 * The rule that makes this safe to expose is that progress is observational:
 * only the tool's final result is committed to canonical history.
 */
const Build = Tool.make("build", {
  parameters: Schema.Struct({}),
  success: Schema.String
})

const buildTurns = [
  { toolCalls: [{ id: "b1", name: "build", params: {} }] },
  { text: "done" }
]

describe("tool progress", () => {
  it.effect("reports intermediate results, and commits only the last", () =>
    Effect.gen(function* () {
      const toolkit = yield* Agent.toolkit([Build], {
        build: (_params, context) =>
          context.preliminary("10%").pipe(
            Effect.andThen(context.preliminary("60%")),
            Effect.as("built")
          )
      })

      const { events, session } = yield* withSession(
        buildTurns,
        Agent.make({ toolkit }),
        ({ session }) => AgentSession.prompt(session, "build it")
      )

      assert.deepStrictEqual(
        events
          .filter(AgentEvent.is("ToolCallProgress"))
          .map((entry) => entry.event.result),
        ["10%", "60%"]
      )

      // The final result is reported once, as a terminal event, and never
      // repeated as progress.
      assert.deepStrictEqual(
        events
          .filter(AgentEvent.is("ToolCallSucceeded"))
          .map((entry) => entry.event.result),
        ["built"]
      )

      // Canonical history carries only that final result: the intermediate
      // ones never become part of the conversation.
      const history = yield* AgentSession.history(session)
      assert.deepStrictEqual(
        history.content.flatMap((message) =>
          message.role === "tool"
            ? message.content.flatMap((part) =>
                part.type === "tool-result" ? [part.result] : []
              )
            : []
        ),
        ["built"]
      )
    })
  )

  it.effect("emits progress before the tool has finished", () =>
    Effect.gen(function* () {
      // The whole point of folding rather than collecting. If progress were
      // still buffered until the handler returned, this would deadlock: the
      // handler only completes once its progress has been observed.
      const observed = yield* Deferred.make<void>()
      const seen = yield* Ref.make<Array<unknown>>([])

      const toolkit = yield* Agent.toolkit([Build], {
        build: (_params, context) =>
          context.preliminary("step-1").pipe(
            Effect.andThen(Deferred.await(observed)),
            Effect.as("built")
          )
      })

      yield* withSession(
        buildTurns,
        Agent.make({ toolkit }),
        ({ session }) =>
          Effect.gen(function* () {
            const watcher = yield* Effect.forkChild(
              Stream.runForEach(AgentSession.events(session), (entry) =>
                // `is` narrows the envelope, so `result` is reachable without
                // a cast.
                AgentEvent.is("ToolCallProgress")(entry)
                  ? Ref.update(seen, (all) => [
                      ...all,
                      entry.event.result
                    ]).pipe(
                      Effect.andThen(Deferred.succeed(observed, undefined))
                    )
                  : Effect.void
              )
            )
            yield* AgentSession.prompt(session, "build it")
            yield* Fiber.interrupt(watcher)
          })
      )

      assert.deepStrictEqual(yield* Ref.get(seen), ["step-1"])
    })
  )
})
