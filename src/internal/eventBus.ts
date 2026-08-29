import { Cause, Effect, Option, PubSub, Ref, Scope, Semaphore, Stream } from "effect"
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
  /**
   * The fibre currently inside `emit`, if any.
   *
   * Only for detecting re-entry. `emit` holds a one-permit semaphore across
   * publication *and* every observer, so an observer that calls back into a
   * session operation which emits — `prompt`, `close`, or anything awaiting
   * either — waits for a permit that cannot be released until it returns. That
   * is a deadlock, not a slow observer, and the difference matters because the
   * documentation used to warn only about the latter.
   *
   * Comparing the fibre is what separates the two cases that look alike: a
   * *different* fibre emitting while this one holds the permit is ordinary
   * contention and must wait, which is the whole point of the permit.
   */
  readonly emitting: Ref.Ref<Option.Option<number>>
  /**
   * The terminal envelope, retained once it has been published.
   *
   * `events` ends on `SessionClosed`, which works only for a subscriber that
   * was attached when it went out. A client reconnecting to a session that
   * closed while it was away subscribed to a PubSub that would never speak
   * again, and waited forever -- no error, no end of stream.
   *
   * Retaining the envelope rather than short-circuiting to an empty stream is
   * the choice that answers the question the late subscriber actually asked:
   * it *sees* `SessionClosed`, and then the same `takeUntil` ends its stream,
   * so live and late subscribers observe the same terminal event by the same
   * rule. Read and written under `order`, so subscribing is atomic with
   * respect to publication and there is no window between the two.
   */
  readonly closed: Ref.Ref<Option.Option<AgentEventEnvelope>>
}

export const make = (
  sessionId: SessionId,
  sink?: ((envelope: AgentEventEnvelope) => Effect.Effect<void>) | undefined
) =>
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<AgentEventEnvelope>()
    const sequence = yield* Ref.make(0)
    const order = yield* Semaphore.make(1)
    const emitting = yield* Ref.make(Option.none<number>())
    const closed = yield* Ref.make(Option.none<AgentEventEnvelope>())
    return {
      sessionId,
      pubsub,
      sequence,
      order,
      sink,
      observers: new Set(),
      emitting,
      closed
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
      // Retained *before* it is published, and that order is what `events`
      // relies on: a subscriber that registers and then finds this empty knows
      // the publish has not happened yet, so its own subscription will carry
      // the close. Retaining after publishing left a window between the two
      // in which a subscriber saw neither, and closing that window by making
      // subscribers take the emit permit starved them instead -- a busy
      // emitter re-takes the semaphore before a queued subscriber is
      // scheduled, and the subscriber missed every event emitted meanwhile.
      return (event._tag === "SessionClosed"
        ? Ref.set(bus.closed, Option.some(envelope))
        : Effect.void
      ).pipe(
        Effect.andThen(PubSub.publish(bus.pubsub, envelope)),
        /**
         * The sink is a *participant*, and its failure is the emit's failure.
         *
         * Deliberate, and the opposite of the observers below. A sink is the
         * interpreter's recorder -- the thing that makes a durable session's
         * event log complete -- so an event it did not record is an event that
         * did not happen as far as a restart is concerned. Continuing past
         * that would produce a session whose log has a hole in it and no
         * indication of one.
         */
        Effect.andThen(bus.sink !== undefined ? bus.sink(envelope) : Effect.void),
        Effect.andThen(
          bus.observers.size === 0
            ? Effect.void
            : Effect.forEach([...bus.observers], (observe) => notify(bus, observe, envelope), {
              discard: true
            })
        )
      )
    }),
    Effect.asVoid,
    // `holding` *inside* the permit, not around it. Marking before the permit
    // was acquired made the marker a shared last-writer-wins slot: a second
    // emitter blocked on the permit had already overwritten the holder's mark,
    // and the holder's `ensuring` then cleared it -- so the fibre that went on
    // to run the observers was recorded as nobody, and a re-entrant observer
    // hung on the permit instead of being refused. Under the permit only one
    // fibre can be inside `holding` at a time, which is what the marker claims.
    //
    // `guardReentry` stays outermost, so it reads the marker *before* this call
    // sets it -- and, being outside the permit, a re-entrant call is refused
    // rather than queued behind the permit it is itself holding.
    holding(bus),
    Semaphore.withPermit(bus.order),
    guardReentry(bus)
  )

/**
 * One observer's turn, isolated from the agent and from the others.
 *
 * An observer's typed error channel is `never`, but a *defect* or an
 * interruption still escapes the callback -- and it used to fail `emit`, which
 * failed the model call, tool call or submission that was in the middle of
 * announcing what it had done. Subscribers had already received the envelope,
 * later observers were skipped, and whether canonical state had moved depended
 * on which event it was.
 *
 * `SessionTree.capture` already wrapped its own storage write for exactly this
 * reason: an unwritable disk must not take the agent down with it. That local
 * defence is the tell -- if every observer has to defend itself, the seam has
 * the coupling the wrong way round.
 *
 * So: an observer is an observability consumer, not a participant. A broken one
 * loses its own notification and says so in the log. Interruption is *not*
 * absorbed: that is the fibre being cancelled, not the observer misbehaving,
 * and swallowing it would break structured cancellation.
 */
const notify = (
  bus: EventBus,
  observe: (envelope: AgentEventEnvelope) => Effect.Effect<void>,
  envelope: AgentEventEnvelope
): Effect.Effect<void> =>
  Effect.catchCause(observe(envelope), (cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : Effect.logError("An event observer failed; the event was still published", cause).pipe(
        Effect.annotateLogs({
          sessionId: bus.sessionId,
          event: envelope.event._tag,
          sequence: envelope.sequence
        })
      ))

/**
 * Refuse a re-entrant emit rather than deadlocking on it.
 *
 * `emit` holds the ordering permit across publication and every observer, so
 * an observer that calls a session operation which emits waits for a permit
 * only it can release. The failure mode is a hang with no diagnostic -- the
 * worst possible way to learn a contract.
 *
 * A defect, not a typed failure: this is a bug in the observer, not a
 * condition the agent can act on. It names what to do instead, because the
 * answer is always the same -- fork the work, or observe the stream.
 *
 * A child fibre spawned by an observer is not caught: it has its own id, so it
 * blocks on the permit like any other emitter and deadlocks the same way. That
 * is the limit of what a fibre comparison can see, and the observer contract
 * says so in `AgentSession.observe`.
 */
const guardReentry = (bus: EventBus) => <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.zip(Ref.get(bus.emitting), Effect.fiberId), ([holder, me]) =>
    Option.isSome(holder) && holder.value === me
      ? Effect.die(
        new Error(
          "An event observer re-entered the session it is observing." +
            " Observers run inside the event bus's ordering permit, so an" +
            " operation that emits cannot complete until the observer" +
            " returns. Fork the work, or use the event stream instead."
        )
      )
      : self)

/** Record which fibre is inside `emit`, and stop recording however it ends. */
const holding = (bus: EventBus) => <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.fiberId, (me) =>
    Ref.set(bus.emitting, Option.some(me)).pipe(
      Effect.andThen(self),
      Effect.ensuring(Ref.set(bus.emitting, Option.none()))
    ))

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
  Stream.unwrap(
    // Subscribe first, then read the marker; no permit. The two cases are
    // exhaustive because `emit` retains the close *before* publishing it:
    // reading `None` after subscribing proves the publish is still to come,
    // and this subscription is already registered to receive it; reading
    // `Some` means it may already have gone out, so the retained envelope is
    // replayed and the subscription is left unread -- seen once either way.
    //
    // Not under `bus.order`. It was, briefly, and a subscriber queued behind
    // an emitting fibre was starved for as long as that fibre kept emitting,
    // which for a subscriber joining mid-run meant missing the events it
    // subscribed for. Ordering the retention before the publish is what makes
    // the permit unnecessary.
    Effect.flatMap(PubSub.subscribe(bus.pubsub), (subscription) =>
      Effect.map(Ref.get(bus.closed), (closed) =>
        Option.isSome(closed)
          ? Stream.make(closed.value)
          : Stream.fromSubscription(subscription).pipe(
            Stream.takeUntil((envelope) => envelope.event._tag === "SessionClosed")
          )
      )
    )
  )
