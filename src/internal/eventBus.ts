import { Effect, Option, PubSub, Ref, Scope, Semaphore, Stream } from "effect"
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
  /**
   * Observers attached after construction, invoked under the same permit.
   *
   * `sink` covers the consumer that exists before the session does. This
   * covers the one that arrives later and still cannot afford to lag --
   * anything whose job is to read session state *as of* an event.
   *
   * That distinction is not pedantic. `TurnCompleted` carries no payload, so a
   * consumer that wants the history at that boundary has to go and read it;
   * read it from a fibre scheduled later and it gets the history as of
   * *whenever that fibre ran*, which after a lag is a different conversation
   * entirely. A `Stream` subscriber cannot avoid this, because the whole point
   * of a stream is that it consumes at its own pace.
   *
   * Mutable, and deliberately so: attaching is `Set.add` under the emit
   * permit, so it is atomic with respect to publication -- an observer is
   * either attached before an envelope or after it, never during.
   */
  readonly observers: Set<(envelope: AgentEventEnvelope) => Effect.Effect<void>>
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
      sink,
      observers: new Set()
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
        Effect.andThen(bus.sink !== undefined ? bus.sink(envelope) : Effect.void),
        Effect.andThen(
          bus.observers.size === 0
            ? Effect.void
            : Effect.forEach([...bus.observers], (observe) => observe(envelope), {
              discard: true
            })
        )
      )
    }),
    Semaphore.withPermit(bus.order),
    Effect.asVoid
  )

/**
 * Attach an observer for the life of the scope.
 *
 * Attachment and detachment both take the emit permit, so they cannot
 * interleave with a publication: an observer sees a contiguous run of
 * envelopes, with no half-delivered one at either end.
 */
export const observe = (
  bus: EventBus,
  observer: (envelope: AgentEventEnvelope) => Effect.Effect<void>
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Semaphore.withPermit(bus.order)(Effect.sync(() => bus.observers.add(observer))),
    () => Semaphore.withPermit(bus.order)(Effect.sync(() => bus.observers.delete(observer)))
  ).pipe(Effect.asVoid)

/**
 * The live feed, ending with the session.
 *
 * `SessionClosed` is the last thing a session says, so the stream ends once
 * it has been delivered. A feed that stayed open past it left every remote
 * observer -- an SSE response, an RPC stream -- hanging on a session that no
 * longer existed, until the connection itself was torn down.
 */
export const events = (bus: EventBus): Stream.Stream<AgentEventEnvelope> =>
  Stream.fromPubSub(bus.pubsub).pipe(
    Stream.takeUntil((envelope) => envelope.event._tag === "SessionClosed")
  )
