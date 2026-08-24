import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Schedule } from "effect"
import * as Schedules from "../src/internal/schedules.js"

/**
 * The retry shapes, asserted on their delays rather than on their behaviour
 * under a clock -- a schedule is a function from attempt to delay, so that is
 * the thing to check.
 *
 * These exist because `Schedule` was imported six times and composed in none of
 * them: every site was `Schedule.spaced(<a constant>)`. See
 * `docs/audit-effect-ecosystem.md` E16.
 */

/** The first `n` delays a schedule produces, in milliseconds. */
const delaysOf = <Output>(
  schedule: Schedule.Schedule<Output>,
  n: number
): Effect.Effect<ReadonlyArray<number>> =>
  Effect.gen(function* () {
    const step = yield* Schedule.toStep(schedule)
    const out: Array<number> = []
    for (let i = 0; i < n; i = i + 1) {
      const [, delay] = yield* step(i, undefined)
      out.push(Duration.toMillis(delay))
    }
    return out
  }).pipe(Effect.orDie)

describe("internal/schedules", () => {
  it.effect("backoff grows from `start` and never exceeds `cap`", () =>
    Effect.gen(function* () {
      const start = Duration.millis(10)
      const cap = Duration.millis(200)
      const delays = yield* delaysOf(Schedules.backoff({ start, cap }), 12)

      // The fast path is preserved: the first delay is `start` give or take
      // jitter's 20%, which keeps a submission that finishes in milliseconds
      // still observed in milliseconds.
      assert.isAtMost(delays[0]!, 12)

      // The cap is the point. Without it, attempt 12 at factor 2 from 10ms
      // would be about 20 seconds.
      for (const delay of delays) assert.isAtMost(delay, 200)

      // And it does actually grow -- a cap on a schedule that never grew would
      // pass the assertion above while doing nothing.
      const late = delays.slice(6)
      assert.isTrue(late.some((delay) => delay > 10))
    })
  )

  it.effect("backoff is jittered, so many clients do not align", () =>
    Effect.gen(function* () {
      // Two independent instances of the same schedule must not produce the
      // same delays. That is the whole reason for jitter: N waiters retrying a
      // recovering store in lockstep can knock it over again.
      const make = () =>
        delaysOf(
          Schedules.backoff({
            start: Duration.millis(50),
            cap: Duration.seconds(5)
          }),
          8
        )
      const a = yield* make()
      const b = yield* make()
      assert.isTrue(a.some((delay, i) => delay !== b[i]))
    })
  )

  it.effect("steady varies around its interval without growing", () =>
    Effect.gen(function* () {
      // `steady` deliberately does not grow: its call sites bound retries by
      // count, so growing the delay would silently turn a one-minute ceiling
      // into a twenty-minute one. It only removes the lockstep, and it does so
      // symmetrically -- jitter is +/-20%, not a reduction.
      const delays = yield* delaysOf(Schedules.steady(Duration.millis(100)), 20)
      for (const delay of delays) {
        assert.isAtLeast(delay, 80)
        assert.isAtMost(delay, 120)
      }
      assert.isTrue(delays.some((delay) => delay !== 100))
    })
  )
})
