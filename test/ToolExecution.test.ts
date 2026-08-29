import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { withSession } from "./helpers.js"

/**
 * `perTool` is the strategy with a lookup keyed by a name the application did
 * not necessarily choose, and the strategy whose limits used to multiply. Both
 * of those are behaviour, so both are pinned here.
 */

const succeeded = (events: ReadonlyArray<AgentEvent.AgentEventEnvelope>) =>
  events.filter(AgentEvent.is("ToolCallSucceeded"))

/**
 * Give every runnable fiber a chance to start before reading the peak: the
 * assertion is that no *more* handlers ran, and a peak read the instant the
 * expected ones arrive would pass whether or not the limit held.
 */
const settle = Effect.gen(function*() {
  for (let tick = 0; tick < 50; tick++) yield* Effect.yieldNow
})

/** Counts concurrent handlers, releasing them all once `expected` are running. */
const gate = (expected: number) =>
  Effect.gen(function*() {
    const active = yield* Ref.make(0)
    const peak = yield* Ref.make(0)
    const reached = yield* Deferred.make<void>()
    const open = yield* Deferred.make<void>()
    const enter = Effect.acquireUseRelease(
      Ref.updateAndGet(active, (n) => n + 1).pipe(
        Effect.tap((now) => Ref.update(peak, (max) => Math.max(max, now))),
        Effect.tap((now) =>
          now >= expected ? Deferred.succeed(reached, void 0) : Effect.void
        )
      ),
      () => Deferred.await(open).pipe(Effect.as("done")),
      () => Ref.update(active, (n) => n - 1)
    )
    return { enter, peak: Ref.get(peak), reached: Deferred.await(reached), open: Deferred.succeed(open, void 0) }
  })

describe("ToolExecution.perTool", () => {
  it.effect("a tool named `constructor` gets the default limit, not Object.prototype", () =>
    Effect.gen(function*() {
      // Tool names arrive from MCP servers, OpenAPI operationIds and GraphQL
      // fields. On a plain object literal `limits["constructor"]` is a
      // *function*, which `??` does not rescue, and it reached `Effect.all` as
      // its concurrency.
      // Two calls at `defaultLimit: 2`: the *leak* is visible because
      // `Effect.all` given a function as its concurrency falls back to running
      // them one at a time, so the pair never overlaps.
      const counter = yield* gate(2)
      const Constructor = Tool.make("constructor", {
        parameters: Schema.Struct({}),
        success: Schema.String
      })
      const toolkit = Agent.toolkit([Constructor], {
        constructor: () => counter.enter
      })

      const { events } = yield* withSession(
        [
          {
            toolCalls: [
              { id: "c1", name: "constructor", params: {} },
              { id: "c2", name: "constructor", params: {} }
            ]
          },
          { text: "done" }
        ],
        Agent.make({
          toolkit,
          toolExecution: ToolExecution.perTool({ limits: {}, defaultLimit: 2 })
        }),
        ({ session }) =>
          Effect.gen(function*() {
            const prompt = yield* Effect.forkChild(AgentSession.prompt(session, "go"))
            yield* counter.reached
            yield* settle
            // The default limit applies, rather than `Object.prototype`.
            assert.strictEqual(yield* counter.peak, 2)
            yield* counter.open
            yield* Fiber.join(prompt)
          })
      )

      assert.strictEqual(succeeded(events).length, 2)
      assert.strictEqual(yield* counter.peak, 2)
    }))

  it.effect("`total` bounds the whole response, across names", () =>
    Effect.gen(function*() {
      // Distinct names run concurrently with each other, so without a ceiling
      // three unlisted tools at `defaultLimit: 2` permit six at once.
      const counter = yield* gate(2)
      const A = Tool.make("a", { parameters: Schema.Struct({}), success: Schema.String })
      const B = Tool.make("b", { parameters: Schema.Struct({}), success: Schema.String })
      const C = Tool.make("c", { parameters: Schema.Struct({}), success: Schema.String })
      const toolkit = Agent.toolkit([A, B, C], {
        a: () => counter.enter,
        b: () => counter.enter,
        c: () => counter.enter
      })

      const { events } = yield* withSession(
        [
          {
            toolCalls: [
              { id: "a1", name: "a", params: {} },
              { id: "b1", name: "b", params: {} },
              { id: "c1", name: "c", params: {} },
              { id: "a2", name: "a", params: {} },
              { id: "b2", name: "b", params: {} },
              { id: "c2", name: "c", params: {} }
            ]
          },
          { text: "done" }
        ],
        Agent.make({
          toolkit,
          toolExecution: ToolExecution.perTool({ limits: {}, defaultLimit: 2, total: 2 })
        }),
        ({ session }) =>
          Effect.gen(function*() {
            const prompt = yield* Effect.forkChild(AgentSession.prompt(session, "go"))
            yield* counter.reached
            yield* settle
            assert.strictEqual(yield* counter.peak, 2)
            yield* counter.open
            yield* Fiber.join(prompt)
          })
      )

      // All six ran, and never more than two together.
      assert.strictEqual(succeeded(events).length, 6)
      assert.strictEqual(yield* counter.peak, 2)
    }))

  it("`total` is validated like every other limit", () => {
    assert.throws(() => ToolExecution.perTool({ limits: {}, total: 0 }))
    assert.throws(() => ToolExecution.perTool({ limits: {}, total: 1.5 }))
  })
})
