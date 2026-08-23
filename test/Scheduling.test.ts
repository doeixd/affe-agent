import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Option, Schedule } from "effect"
import { TestClock } from "effect/testing"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { Scheduling } from "../src/scheduling/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Scheduling over Effect's own primitives, driven by TestClock so no real time
 * passes. Runs are synchronised through the scripted model's `started` Deferred
 * (fires when a turn begins), so every assertion is exact: a dispatched job runs
 * only after its delay, and a recurring run fires per interval and survives a
 * failing run.
 */

const Simple = Agent.make({ loop: AgentLoop.bounded(2) })

describe("Scheduling.local dispatcher", () => {
  it.effect("a job with no delay runs promptly", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const { layer: model } = yield* TestLanguageModel.script([{ text: "done", started }])
      yield* Effect.gen(function* () {
        yield* Scheduling.dispatch({ input: "go" })
        // Reaching here means the forked run reached the model -> it ran.
        yield* Deferred.await(started)
      }).pipe(
        Effect.provide(Layer.merge(Scheduling.local(Simple).pipe(Layer.provide(model)), TestClock.layer())),
        Effect.scoped
      )
    })
  )

  it.effect("a delayed job runs only after its delay elapses", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const { layer: model } = yield* TestLanguageModel.script([{ text: "done", started }])
      // One TestClock shared by the dispatcher's fibre (which sleeps on it) and
      // this test's `adjust` -- built once so both see the same virtual time.
      const clock = Layer.succeedContext(yield* Layer.build(TestClock.layer()))
      yield* Effect.gen(function* () {
        yield* Scheduling.dispatch({ input: "go", delay: "1 hour" })
        yield* Effect.yieldNow // let the job reach its delay
        // Half the delay in: still waiting.
        yield* TestClock.adjust("30 minutes")
        assert.isTrue(Option.isNone(yield* Deferred.poll(started)))
        // The delay elapses: the job wakes and runs.
        yield* TestClock.adjust("30 minutes")
        yield* Deferred.await(started)
      }).pipe(
        Effect.provide(Layer.merge(
          Scheduling.local(Simple).pipe(Layer.provide(Layer.merge(model, clock))),
          clock
        )),
        Effect.scoped
      )
    }).pipe(Effect.scoped)
  )
})

describe("Scheduling.recurring", () => {
  it.effect("fires once per interval and a failing run does not stop the schedule", () =>
    Effect.gen(function* () {
      const s1 = yield* Deferred.make<void>()
      const s2 = yield* Deferred.make<void>()
      const s3 = yield* Deferred.make<void>()
      // The first run starts, then dies; recurring must catch it and keep going.
      const { layer: model } = yield* TestLanguageModel.script([
        { fail: "boom", started: s1 },
        { text: "two", started: s2 },
        { text: "three", started: s3 }
      ])
      yield* Effect.gen(function* () {
        yield* Effect.forkScoped(Scheduling.recurring(Simple, "tick", Schedule.fixed("1 hour")))
        // Run 1 (the failing one) fires immediately.
        yield* Deferred.await(s1)
        yield* Effect.yieldNow // let the fibre reach the next scheduled sleep
        // The schedule continued despite the failure: run 2, then run 3.
        yield* TestClock.adjust("1 hour")
        yield* Deferred.await(s2)
        yield* Effect.yieldNow
        yield* TestClock.adjust("1 hour")
        yield* Deferred.await(s3)
      }).pipe(
        Effect.provide(Layer.merge(model, TestClock.layer())),
        Effect.scoped
      )
    })
  )
})
