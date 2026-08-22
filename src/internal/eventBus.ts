import { Effect, Option, PubSub, Ref, Semaphore, Stream } from "effect"
import type { AgentEvent, AgentEventEnvelope, Correlation } from "../AgentEvent.js"
import type { SessionId } from "./ids.js"

/**
 * The session's live event channel.
 *
 * Publication is non-blocking by construction: the PubSub is unbounded and a
 * subscriber that falls behind must never apply backpressure to the agent loop.
 * That is also why this is not a durability mechanism — see `AgentEvent`.
 */
export interface EventBus {
  readonly sessionId: SessionId
  readonly pubsub: PubSub.PubSub<AgentEventEnvelope>
  readonly sequence: Ref.Ref<number>
  /**
   * Serialises allocate-then-publish.
   *
   * Without it those are two steps, so two concurrent emitters — parallel tool
   * calls, say — could take sequence numbers in one order and publish in the
   * other. Consumers could still sort by `sequence`, but delivery order
   * matching sequence order is the stronger guarantee and costs one permit.
   */
  readonly order: Semaphore.Semaphore
  /**
   * An observer invoked synchronously under the same permit, after publish.
   *
   * This is the earned seam for consumers who cannot afford the race every
   * `Stream` subscriber carries — a recorder that must not miss the envelope
   * between subscribing and the first emission. Absent by default; absent
   * means zero behaviour change.
   */
  readonly sink: ((envelope: AgentEventEnvelope) => Effect.Effect<void>) | undefined
}

export const make = (
  sessionId: SessionId,
  sink?: ((envelope: AgentEventEnvelope) => Effect.Effect<void>) | undefined
) =>
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<AgentEventEnvelope>()
    const sequence = yield* Ref.make(0)
    const order = yield* Semaphore.make(1)
    return {
      sessionId,
      pubsub,
      sequence,
      order,
      sink
    } satisfies EventBus
  })

/**
 * Publish one event.
 *
 * Correlation is passed in by the caller rather than read from session state:
 * the emitting code always knows exactly which run and turn it belongs to,
 * whereas state could have moved on by the time the event is built.
 */
export const emit = (
  bus: EventBus,
  correlation: Correlation,
  event: AgentEvent
): Effect.Effect<void> =>
  Ref.updateAndGet(bus.sequence, (n) => n + 1).pipe(
    Effect.flatMap((sequence) => {
      const envelope: AgentEventEnvelope = {
        sessionId: bus.sessionId,
        submissionId: Option.fromUndefinedOr(correlation.submissionId),
        runId: Option.fromUndefinedOr(correlation.runId),
        turn: Option.fromUndefinedOr(correlation.turn),
        sequence,
        event
      }
      return PubSub.publish(bus.pubsub, envelope).pipe(
        // Under the same permit, so a sink observes envelopes in sequence
        // order exactly as the PubSub delivers them.
        Effect.andThen(bus.sink !== undefined ? bus.sink(envelope) : Effect.void)
      )
    }),
    Semaphore.withPermit(bus.order),
    Effect.asVoid
  )

export const events = (bus: EventBus): Stream.Stream<AgentEventEnvelope> =>
  Stream.fromPubSub(bus.pubsub)
