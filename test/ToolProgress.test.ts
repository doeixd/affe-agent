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

describe("parallel tool ordering", () => {
  const Slow = Tool.make("slow", {
    parameters: Schema.Struct({}),
    success: Schema.String
  })
  const Fast = Tool.make("fast", {
    parameters: Schema.Struct({}),
    success: Schema.String
  })

  it.effect("commits in model call order while events follow completion", () =>
    Effect.gen(function* () {
      // The invariant that matters: tools run concurrently, and whatever order
      // they finish in, the transcript sent back to the model matches the
      // order the model asked in. Getting that wrong corrupts the
      // conversation.
      //
      // `slow` is requested first and cannot finish until `fast` has, so the
      // two tools genuinely overlap and completion order is the reverse of
      // call order.
      const finished = yield* Deferred.make<void>()

      const toolkit = yield* Agent.toolkit([Slow, Fast], {
        slow: (_params, context) =>
          context.preliminary("slow-progress").pipe(
            // Waits for `fast` to have completed, so completion order is the
            // reverse of call order every run, not just usually.
            Effect.andThen(Deferred.await(finished)),
            Effect.as("slow-done")
          ),
        fast: (_params, context) =>
          context.preliminary("fast-progress").pipe(
            Effect.andThen(Deferred.succeed(finished, undefined)),
            Effect.as("fast-done")
          )
      })

      const { events, session } = yield* withSession(
        [
          {
            toolCalls: [
              { id: "s1", name: "slow", params: {} },
              { id: "f1", name: "fast", params: {} }
            ]
          },
          { text: "done" }
        ],
        Agent.make({ toolkit }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      // Both terminal events are present. Their *order* is deliberately not
      // asserted: the issue makes completion order permissive, not guaranteed,
      // and the handoff between two concurrent fibers is genuinely racy — an
      // earlier version of this test pinned an order and was pinning its own
      // scheduling luck.
      assert.deepStrictEqual(
        events
          .filter(AgentEvent.is("ToolCallSucceeded"))
          .map((entry) => entry.event.name)
          .sort(),
        ["fast", "slow"]
      )

      // Progress arrived from both while they were still running.
      assert.deepStrictEqual(
        events
          .filter(AgentEvent.is("ToolCallProgress"))
          .map((entry) => entry.event.result)
          .sort(),
        ["fast-progress", "slow-progress"]
      )

      // Canonical history: still the order the model asked in.
      const history = yield* AgentSession.history(session)
      assert.deepStrictEqual(
        history.content.flatMap((message) =>
          message.role === "tool"
            ? message.content.flatMap((part) =>
                part.type === "tool-result" ? [part.name] : []
              )
            : []
        ),
        ["slow", "fast"]
      )
    })
  )
})
