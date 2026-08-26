import { Effect, Queue } from "effect"
import { Prompt } from "effect/unstable/ai"

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
  readonly offer: (input: Prompt.Prompt) => Effect.Effect<void>
  /**
   * Take everything pending, without waiting.
   *
   * A drain must never block: it happens at every turn boundary, and the queue
   * is usually empty.
   */
  readonly drain: Effect.Effect<ReadonlyArray<Prompt.Prompt>>
  readonly size: Effect.Effect<number>
}

/**
 * Builds the channels a session needs.
 *
 * `name` identifies the channel within its session — `"steering"`,
 * `"followUps"` — so an implementation that needs durable identity can derive
 * one from the session and the name.
 *
 * Inputs are `Prompt`s rather than strings: steering a multimodal conversation
 * with an image is the same operation as steering it with a sentence, and the
 * channel should not be the thing that forbids it. `Prompt` has a Schema, so a
 * durable channel can still encode what it holds.
 */
export interface Factory {
  readonly make: (
    sessionId: string,
    name: string
  ) => Effect.Effect<InputChannel>
  /**
   * Told when the session starts and stops accepting out-of-band input.
   *
   * In-process callers do not need this: `steer` and `followUp` read the
   * session's own state, so they see the gate close the instant it closes. A
   * caller in *another process* cannot, and that is the whole problem — it has
   * to consult something the session publishes.
   *
   * Whatever it publishes will lag the real gate unless the session says when
   * to change it, which is what this hook is for. Without it, a durable
   * `followUp` is accepted for as long as the published marker is stale: it
   * returns success, writes to a queue, and `AgentSession.release` — whose job
   * is to drop whatever is left over — discards it. The caller is told the work
   * was accepted and it never runs.
   *
   * Optional, because an in-memory channel has nothing to publish.
   */
  readonly setAdmitting?: (
    sessionId: string,
    admitting: boolean
  ) => Effect.Effect<void>
  /**
   * Publishes the narrower gate for steering the active run.
   *
   * Follow-ups may remain admissible after a run has stopped taking steering,
   * so durable callers need a distinct marker. Closing it before the run's
   * final drain makes every race resolve honestly: the input is either in the
   * drain, or the caller is refused.
   */
  readonly setSteeringAdmitting?: (
    sessionId: string,
    admitting: boolean
  ) => Effect.Effect<void>
}

/** Backed by an unbounded in-memory queue. The default. */
export const memory: Factory = {
  make: () =>
    Effect.map(
      Queue.unbounded<Prompt.Prompt>(),
      (queue): InputChannel => ({
        offer: (input) => Queue.offer(queue, input).pipe(Effect.asVoid),
        // `clear` rather than `takeAll`: the latter waits for an element.
        drain: Queue.clear(queue),
        size: Queue.size(queue)
      })
    )
}
