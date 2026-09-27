import { Effect, Option } from "effect"
import type { AgentEventEnvelope } from "../AgentEvent.js"

/**
 * A bounded, in-memory record of one session's most recent envelopes, so an
 * in-process session can answer `events({ after })` and `eventLog` from a
 * cursor (item 130).
 *
 * Fed from the session's synchronous `eventSink`, which sees every envelope
 * in sequence order before anyone can report the outcome it describes. A
 * `Stream` subscriber could not be the feed: it attaches asynchronously and
 * misses what came before it.
 *
 * **A cursor behind the window is refused, never answered with a hole.**
 * `since` answers `None` when an envelope after `after` was evicted. The
 * caller turns that into an error: resuming silently from a later point loses
 * events the reader has no way to know about, which is exactly what `after`
 * exists to prevent.
 */
export interface EventRing {
  readonly record: (envelope: AgentEventEnvelope) => Effect.Effect<void>
  /** The retained envelopes after `after`, or `None` when some were evicted. */
  readonly since: (after: number) => Effect.Effect<Option.Option<ReadonlyArray<AgentEventEnvelope>>>
  /** The oldest and newest retained sequences; `oldest` is `None` while empty. */
  readonly bounds: Effect.Effect<{ readonly oldest: Option.Option<number>; readonly latest: number }>
}

/**
 * A mutable buffer behind `Effect.sync`, not a `Ref` of an immutable array:
 * every streamed token is an envelope, and copying the whole window per token
 * would make recording O(capacity). Each operation is one synchronous step, so
 * nothing interleaves inside it.
 */
export const make = (capacity: number): Effect.Effect<EventRing> =>
  Effect.sync(() => {
    const entries: Array<AgentEventEnvelope> = []
    let evicted = false
    return {
      record: (envelope) =>
        Effect.sync(() => {
          entries.push(envelope)
          if (entries.length > capacity) {
            entries.shift()
            evicted = true
          }
        }),
      since: (after) =>
        Effect.sync(() => {
          const oldest = entries[0]?.sequence
          // Evicted, and the cursor is behind the oldest held: something
          // after the cursor is gone. A cursor inside the window is answerable.
          if (evicted && oldest !== undefined && after < oldest - 1) return Option.none()
          return Option.some(entries.filter((envelope) => envelope.sequence > after))
        }),
      bounds: Effect.sync(() => ({
        oldest: Option.fromNullishOr(entries[0]?.sequence),
        latest: entries[entries.length - 1]?.sequence ?? 0
      }))
    }
  })
