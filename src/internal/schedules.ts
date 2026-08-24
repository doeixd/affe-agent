import { Duration, Effect, Schedule } from "effect"

/**
 * The two retry shapes this library needs, and why they are different.
 *
 * `Schedule` was imported in six places and composed in none of them: every
 * one was `Schedule.spaced(<a hand-picked constant>)`. Fixed intervals are
 * wrong for two different reasons depending on what is being waited for, and
 * the fixes are not the same, so both live here rather than being re-derived.
 *
 * @see `docs/audit-effect-ecosystem.md` E16
 */

/**
 * Retry at a steady rate, but never in lockstep with anybody else.
 *
 * For retrying an operation against **shared infrastructure** — a SQL store, a
 * cluster node — where the wait is bounded by an attempt count and the timing
 * envelope is deliberate.
 *
 * The problem with `Schedule.spaced` here is not the interval, it is that every
 * waiter uses the same one. When the thing they are all waiting for recovers,
 * they retry in a synchronised wave and can knock it over again; the more
 * clients, the worse the wave.
 *
 * `Schedule.jittered` spreads them across +/-20% of the interval (it multiplies
 * by a factor in `[0.8, 1.2]`), so an individual delay may be a little longer
 * as well as a little shorter -- the *mean* is unchanged, which is what keeps
 * an attempt budget meaning roughly what its author intended.
 *
 * Deliberately *not* exponential: these call sites bound retries by count
 * (`times: 600`), so growing the delay would silently turn a one-minute
 * ceiling into a twenty-minute one. Changing the timing envelope is a separate
 * decision from removing the herd.
 */
export const steady = (interval: Duration.Duration): Schedule.Schedule<number> =>
  Schedule.jittered(Schedule.spaced(interval))

/**
 * Start fast, then back off, and never poll harder than the cap.
 *
 * For **polling for a state change** that may arrive immediately or in a week.
 * `DurableAgentClient.awaitOutcome` is the case that motivated this: it polled
 * a workflow every 10ms with no upper bound, and its own comment said
 * *"Unbounded by design: a submission parked for a human may take days."*
 * Those two facts together are about 8.6 million polls per waiting client per
 * day, for an answer that is not coming until somebody wakes up.
 *
 * Exponential growth from the same starting interval keeps the fast path fast
 * — the first retry is still `start`, so a submission that finishes in
 * milliseconds is observed just as quickly — while a long wait costs
 * `1000 / cap` polls a second instead of a hundred. The cap is what stops
 * backoff from turning a five-minute wait into a five-minute *and then some*
 * wait: once the delay reaches the ceiling it stays there, so the worst-case
 * lateness of an answer is one cap, not one doubling.
 *
 * Jittered for the same reason `steady` is: many clients polling one engine
 * should not align.
 */
export const backoff = (options: {
  /** The first delay, and the floor. Fast-path latency is preserved at this. */
  readonly start: Duration.Duration
  /** The longest this will ever wait between polls. */
  readonly cap: Duration.Duration
  /** Growth per attempt. Default 2. */
  readonly factor?: number | undefined
}): Schedule.Schedule<Duration.Duration> =>
  Schedule.exponential(options.start, options.factor ?? 2).pipe(
    // Jitter first, cap second. `Schedule.jittered` multiplies by a factor in
    // `[0.8, 1.2]`, so capping first and jittering after would let a delay
    // exceed the cap by 20% -- the cap would be a suggestion rather than a
    // ceiling. Found by asserting it: the first version of this returned 223ms
    // against a 200ms cap.
    Schedule.jittered,
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.min(duration, options.cap))
    )
  )

/**
 * The default ceiling for a poll that waits on human-scale work.
 *
 * One second: high enough that a submission parked overnight costs a few
 * thousand polls rather than millions, low enough that nobody perceives the
 * added latency on an answer that does arrive.
 */
export const defaultPollCap: Duration.Duration = Duration.seconds(1)
