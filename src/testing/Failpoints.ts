import { Effect, Layer, Ref } from "effect"
import * as Failpoint from "../internal/failpoint.js"

/**
 * Crash a durable pass at a named boundary, and see what the next one does.
 *
 * The seam itself is `src/internal/failpoint.ts`: a no-op `Context.Reference`
 * called at named durable boundaries. This is the half a test provides. It
 * answers the question `test/DurableStorageFaults.test.ts` cannot -- that one
 * makes a store *fail*, which exercises error handling, where this stops the
 * process *between* two durable writes and asks whether the second pass
 * recovers.
 *
 * The shape to reach for:
 *
 * ```ts
 * const crash = yield* Failpoints.at("DeliveryLog:after-append")
 * yield* firstPass.pipe(Effect.provide(crash.layer), Effect.exit)
 * // ... a second pass, with no failpoint provided, must put it right
 * assert.deepStrictEqual(yield* crash.hits, ["DeliveryLog:after-append"])
 * ```
 */

export interface Crash {
  /** Provide this to the pass that should stop. */
  readonly layer: Layer.Layer<never>
  /** Every boundary reached, in order, including ones that did not crash. */
  readonly hits: Effect.Effect<ReadonlyArray<string>>
  /** How many times the armed location was reached. */
  readonly reached: Effect.Effect<number>
}

export interface Options {
  /**
   * Which occurrence to crash on, counting from one. Default 1.
   *
   * A retried pass reaches the same boundary again, and a test that wants to
   * watch the *second* attempt get further needs to let the first one through.
   */
  readonly occurrence?: number | undefined
  /**
   * How to stop. Default `"die"`, which is what losing a process looks like
   * from inside: a defect no handler was written for, rather than a typed
   * failure the code under test may already recover from and thereby hide the
   * question being asked.
   *
   * There is deliberately no typed-failure option. A failpoint is not part of
   * anyone's error channel, and widening one to carry a test's crash would
   * change the very signature under test.
   */
  readonly as?: "die" | "interrupt" | undefined
}

/**
 * Arm one boundary.
 *
 * Every boundary reached is recorded whether or not it crashed, because the
 * order in which they were reached is usually the actual assertion: a test
 * saying "the intent was persisted before the launch" is a statement about
 * `hits`, not about the crash.
 */
export const at = (location: string, options?: Options): Effect.Effect<Crash> =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<string>>([])
    const occurrence = options?.occurrence ?? 1
    const as = options?.as ?? "die"

    const stop = (): Effect.Effect<void> =>
      as === "interrupt" ? Effect.interrupt : Effect.die(new FailpointCrash(location))

    const service: Failpoint.Service = {
      hit: (reached) =>
        Effect.gen(function* () {
          const all = yield* Ref.updateAndGet(seen, (previous) => [...previous, reached])
          if (reached !== location) return
          const count = all.filter((entry) => entry === location).length
          if (count === occurrence) yield* stop()
        })
    }

    return {
      layer: Layer.succeed(Failpoint.Failpoint, service),
      hits: Ref.get(seen),
      reached: Effect.map(Ref.get(seen), (all) => all.filter((entry) => entry === location).length)
    }
  })

/** What a `"die"` crash dies with, so a test can recognise its own. */
export class FailpointCrash extends Error {
  constructor(readonly location: string) {
    super(`failpoint ${location} stopped this pass`)
    this.name = "FailpointCrash"
  }
}
