import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as FakeModel from "./FakeModel.js"

/**
 * H7 -- the durable stack runs under virtual time.
 *
 * A capability, pinned rather than used, and the distinction is the point.
 *
 * H7 was written expecting to convert time-dependent paths -- shard lease
 * expiry, reassignment during a call, the 25ms interrupt poll -- from
 * unaffordable real-time tests into fast virtual-time ones. Measuring first
 * dissolved most of that: the interrupt path already has four tests and they
 * run in 627ms together, and the durable suites as a whole are 2.6s to 11.9s,
 * with the slowest spent on deliberate `sleep`s rather than on polling. There
 * was no expensive test waiting to be made cheap.
 *
 * What is genuinely untested is lease expiry and reassignment, and those are
 * not blocked on time. They are blocked on there being a second runner to
 * reassign *to*: `SingleRunner` has no-op runner health checks, so it never
 * concludes a peer has died and never moves a shard. That is H6's fixture, and
 * until it exists the scenario cannot occur at any speed.
 *
 * So this file makes the one claim H7 can still support, because H6 will
 * depend on it: **the cluster's own timing goes through Effect's `Clock`, so a
 * `TestClock` drives it.** `Sharding` reads `clock.currentTimeMillisUnsafe()`
 * rather than `Date.now()`, which is what makes lease timing controllable at
 * all -- and a multi-node fixture that had to wait out real 35-second leases
 * per observation would not be a test anyone runs.
 *
 * Kept small deliberately. It is a load-bearing assumption for the next
 * milestone, and an assumption is worth a test precisely when something is
 * about to be built on it.
 */

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

describe("the durable stack under virtual time (H7)", () => {
  it.effect("a submission runs to completion with no real time passing", () =>
    Effect.gen(function* () {
      const store = yield* DurableChannels.memoryStore
      const { layer: model } = yield* FakeModel.layer([{ text: "done" }])
      const agent = Agent.make({ loop: AgentLoop.bounded(2) })
      const durable = DurableAgent.workflow("VirtualTime", agent, { store })

      /**
       * One clock, built once and shared.
       *
       * The cluster's loops sleep on the clock they were built with, so a
       * second `TestClock.layer()` for the test would advance a different
       * timeline and nothing the workflow waits on would ever fire.
       */
      const clock = Layer.succeedContext(yield* Layer.build(TestClock.layer()))

      const run = Effect.gen(function* () {
        const executionId = yield* DurableAgent.submit(durable, store, "virtual-1", "go")
        return yield* DurableAgent.result(durable, executionId)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(model),
            Layer.provideMerge(clock)
          )
        )
      )

      const fiber = yield* Effect.forkChild(run)
      /**
       * Time moves in steps, not one jump.
       *
       * Nothing progresses on its own under a `TestClock`, and the cluster's
       * loops re-arm after each wake -- so a single large `adjust` fires the
       * currently-scheduled sleep and then stops, with the next one scheduled
       * beyond it. The `yieldNow` lets the woken fibres run before time moves
       * again.
       */
      for (let i = 0; i < 40; i++) {
        yield* Effect.yieldNow
        yield* TestClock.adjust("250 millis").pipe(Effect.provide(clock))
      }

      const exit = yield* Fiber.await(fiber)
      assert.isTrue(Exit.isSuccess(exit))
      /**
       * The model's own answer, so this cannot pass on a run that never
       * happened. `Exit.isSuccess` alone would be satisfied by a submission
       * that completed having done nothing, which is exactly the shape of
       * false pass this suite keeps producing.
       */
      if (Exit.isSuccess(exit)) assert.include(String(exit.value), "done")
    })
  )
})
