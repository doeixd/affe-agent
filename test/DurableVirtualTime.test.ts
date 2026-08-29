import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer } from "effect"
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
 * Lease expiry and reassignment were untested, and not for want of time: they
 * need a second runner to reassign *to*, and `SingleRunner` has no-op runner
 * health checks, so it never concludes a peer has died and never moves a
 * shard. **`ClusterMultiNode.test.ts` has since closed that**, and a peer does
 * take over a submission whose owner is lost mid-activity.
 *
 * So this file makes the claim that fixture stands on: **the cluster's own
 * timing goes through Effect's `Clock`, so a `TestClock` drives it.**
 * `Sharding` reads `clock.currentTimeMillisUnsafe()` rather than `Date.now()`,
 * which is what makes lease timing controllable at all -- a multi-node fixture
 * that had to wait out real 35-second leases per observation would not be a
 * test anyone runs.
 *
 * It stays because the assumption stays load-bearing: `ClusterMultiNode` is
 * the most expensive file in the suite at ~15s of real time, and moving it
 * onto virtual time is the obvious next economy if it grows.
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
       * Time moves in steps, not one jump, and the budget fails rather than
       * hangs.
       *
       * Nothing progresses on its own under a `TestClock`, and the cluster's
       * loops re-arm after each wake -- so a single large `adjust` fires the
       * currently-scheduled sleep and then stops, with the next one scheduled
       * beyond it. The `yieldNow` lets the woken fibres run before time moves
       * again.
       *
       * Because this loop is the only thing advancing time, a workflow that
       * has not finished when it stops never will. A bare `Fiber.await` here
       * would block until the runner's own timeout and report nothing about
       * why; polling turns "needed more than 40 steps" into a sentence.
       */
      const steps = 40
      // Typed from the fiber rather than annotated, so the nesting below is
      // the compiler's account of it and not the test's assumption.
      let settled: ReturnType<typeof fiber.pollUnsafe> = undefined
      for (let i = 0; i < steps && settled === undefined; i++) {
        yield* Effect.yieldNow
        yield* TestClock.adjust("250 millis").pipe(Effect.provide(clock))
        settled = fiber.pollUnsafe()
      }
      assert.isDefined(
        settled,
        `the submission did not complete within ${steps} virtual-time steps`
      )
      if (settled === undefined) return

      /**
       * Two exits, and both are load-bearing.
       *
       * `DurableAgent.result` yields an `Exit`, so the fiber's exit *contains*
       * one. Checking only the outer says the fiber did not die -- it says
       * nothing about whether the submission succeeded. Unwrapping is what
       * makes this a test of the durable run rather than of the test harness.
       */
      assert.isTrue(Exit.isSuccess(settled), "the driving fiber must not die")
      if (!Exit.isSuccess(settled)) return
      const inner = settled.value
      assert.isTrue(
        Exit.isSuccess(inner),
        "the durable submission itself must succeed"
      )
      if (!Exit.isSuccess(inner)) return
      /**
       * The model's own answer, exactly. A substring match on a stringified
       * exit would pass on a failure whose message happened to contain the
       * word, which is the same shape of false pass this file was written to
       * rule out.
       */
      assert.strictEqual(inner.value, "done")
    })
  )
})
