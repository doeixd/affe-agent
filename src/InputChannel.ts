import { Effect, Queue } from "effect"

/**
 * Where out-of-band input to a running submission is held.
 *
 * Steering and follow-ups are the only values a run consumes that do not come
 * from the model, the tools, or canonical history — which makes them the only
 * inputs a stronger runtime cannot reproduce on its own.
 *
 * A durable interpreter replays model and tool results from its journal, so a
 * turn re-derives the same prompt it derived the first time. But a queue drain
 * reads whatever happens to be pending at that instant: on replay the queue is
 * empty, the turn derives a *different* prompt from the one whose model result
 * is being replayed, and canonical history silently diverges from the journal.
 *
 * Making the channel substitutable is what lets a durable interpreter record
 * the drained batch alongside the turn that consumed it. It is the one seam the
 * Layer boundary could not already express — model and tool interception are
 * ordinary Layer substitution, and need nothing here.
 */
export interface InputChannel {
  readonly offer: (input: string) => Effect.Effect<void>
  /**
   * Take everything pending, without waiting.
   *
   * A drain must never block: it happens at every turn boundary, and the queue
   * is usually empty.
   */
  readonly drain: Effect.Effect<ReadonlyArray<string>>
  readonly size: Effect.Effect<number>
}

/**
 * Builds the channels a session needs.
 *
 * `name` identifies the channel within its session — `"steering"`,
 * `"followUps"` — so an implementation that needs durable identity can derive
 * one from the session and the name.
 */
export interface Factory {
  readonly make: (
    sessionId: string,
    name: string
  ) => Effect.Effect<InputChannel>
}

/** Backed by an unbounded in-memory queue. The default. */
export const memory: Factory = {
  make: () =>
    Effect.map(
      Queue.unbounded<string>(),
      (queue): InputChannel => ({
        offer: (input) => Queue.offer(queue, input).pipe(Effect.asVoid),
        // `clear` rather than `takeAll`: the latter waits for an element.
        drain: Queue.clear(queue),
        size: Queue.size(queue)
      })
    )
}
