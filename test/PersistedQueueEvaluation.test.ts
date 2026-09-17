import { assert, describe, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Fiber, Layer, Ref, Schedule, Schema } from "effect"
import { PersistedQueue } from "effect/unstable/persistence"

const MemoryPersistedQueue = PersistedQueue.layer.pipe(
  Layer.provide(PersistedQueue.layerStoreMemory)
)

describe("PersistedQueue scheduling evaluation", () => {
  it.effect("retains a custom id after acknowledgement", () =>
    Effect.gen(function* () {
      const queue = yield* PersistedQueue.make({
        name: "evaluation/dedupe-after-ack",
        schema: Schema.String
      })

      yield* queue.offer("first", { id: "stable-id" })
      yield* queue.offer("duplicate-before-ack", { id: "stable-id" })
      assert.strictEqual(yield* queue.take(Effect.succeed), "first")

      yield* queue.offer("duplicate-after-ack", { id: "stable-id" })
      yield* queue.offer("next", { id: "next-id" })
      assert.strictEqual(yield* queue.take(Effect.succeed), "next")
    }).pipe(Effect.provide(MemoryPersistedQueue))
  )

  it.effect("requeues a failed take and increments its attempt metadata", () =>
    Effect.gen(function* () {
      const queue = yield* PersistedQueue.make({
        name: "evaluation/retry",
        schema: Schema.String,
        // The subject here is attempt counting, not delays: a backoff sleep
        // would never elapse under the test clock.
        retrySchedule: Schedule.spaced(Duration.zero)
      })
      yield* queue.offer("work", { id: "retry-id" })

      yield* Effect.flip(queue.take(() => Effect.fail("try again")))
      const metadata = yield* queue.take((value, item) => Effect.succeed({ value, attempts: item.attempts }))

      // Attempts are 1-based: claiming counts, so the first claim is attempt
      // 1 and the retry after one failure is attempt 2.
      assert.deepStrictEqual(metadata, { value: "work", attempts: 2 })
    }).pipe(Effect.provide(MemoryPersistedQueue))
  )

  it.effect("requeues an interrupted take without consuming an attempt", () =>
    Effect.gen(function* () {
      const queue = yield* PersistedQueue.make({
        name: "evaluation/interruption",
        schema: Schema.String
      })
      const started = yield* Deferred.make<void>()
      const attempts = yield* Ref.make<number | undefined>(undefined)
      yield* queue.offer("work", { id: "interrupted-id" })

      const taking = yield* Effect.forkChild(queue.take((_value, _metadata) =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
      ))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(taking)

      yield* queue.take((_value, metadata) => Ref.set(attempts, metadata.attempts))
      // An interruption releases the claim without consuming it, so the next
      // take is attempt 1 -- where a failure would have made it attempt 2.
      assert.strictEqual(yield* Ref.get(attempts), 1)
    }).pipe(Effect.provide(MemoryPersistedQueue))
  )
})
