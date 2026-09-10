import { Cause, Effect, Exit, Option, PubSub, Ref, Scope, Semaphore, Stream } from "effect"
import { AgentObservationLagError } from "../Errors.js"
import * as Failpoint from "./failpoint.js"
import * as Observation from "./observation.js"
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
  /**
   * Bounded observers, checked by the publisher. The bus is unbounded and
   * never waits on a subscriber, so
   * this is where a lagging one is *seen*: after each publish, every watched
   * subscription's backlog is read and the bytes it retains are counted, and
   * one past its bound is ended with `AgentObservationLagError` through its
   * `killed` deferred. Enforced here rather than by a pump per observer,
   * because a pump is a fibre hop the consumer's delivery then lags by, and
   * the host's own record read one hop stale.
   */
  readonly watchers: Set<Watcher>
  /** The wire size of each published envelope, while a watcher may still hold it. */
  readonly sizes: WeakMap<AgentEventEnvelope, number>
}

/**
 * The one boundary a test may hold open: registration of a subscription.
 *
 * Not a crash site. Subscribe-before-submit
 * is the property `stream` exists for, and it survived being broken because
 * in-process scheduling publishes nothing before a receipt returns. A test
 * that holds this gate while other fibres run makes the swapped order
 * provably miss `SubmissionStarted`, without changing what admission
 * publishes, which is the proof the reviewer asked for.
 */
export const failpoints = Failpoint.group("EventBus", ["before-subscribe"])

export interface Watcher {
  readonly subscription: PubSub.Subscription<AgentEventEnvelope>
  /** The subscription's own scope: closing it releases the backlog, from either side. */
  readonly release: Scope.Closeable
  readonly bound: Observation.Bound
  readonly sessionId: string
  /** The bus sequence when this watcher was registered: only envelopes above it are charged or credited. */
  readonly since: number
  /** Bytes published to this subscription and not yet delivered. */
  retainedBytes: number
  lastDelivered: number
  /** Set by the publisher when it ends this observation; the consumer builds the error at delivery. */
  killed: Observation.Killed | undefined
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
      closed,
      watchers: new Set(),
      sizes: new WeakMap()
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
        // Weighed before it is published, so a watcher that delivers it
        // before the charge below still finds its size and credits it.
        Effect.andThen(Effect.sync(() => {
          if (bus.watchers.size > 0) bus.sizes.set(envelope, Observation.wireSize(envelope))
        })),
        Effect.andThen(PubSub.publish(bus.pubsub, envelope)),
        Effect.andThen(Effect.suspend(() => bus.watchers.size === 0 ? Effect.void : enforce(bus, envelope))),
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
 * After a publish: charge every watched subscription that received the
 * envelope and end the ones past their bound. Reading a subscription's
 * backlog is exact (`PubSub.remainingUnsafe`); the bytes are this bus's own
 * count, decremented as the observer delivers. A watcher registered after
 * this envelope was published never received it and is not charged: its
 * `since` says so. One uninterruptible step per watcher, so a publisher
 * interrupted mid-way cannot leave a subscription unwatched and unreleased.
 * The consumer builds the error at delivery, with the cursor as it is then.
 */
const enforce = (bus: EventBus, envelope: AgentEventEnvelope): Effect.Effect<void> =>
  Effect.suspend(() => {
    const size = bus.sizes.get(envelope) ?? Observation.wireSize(envelope)
    const ended: Array<Effect.Effect<void>> = []
    for (const watcher of bus.watchers) {
      if (envelope.sequence <= watcher.since) continue
      const backlog = PubSub.remainingUnsafe(watcher.subscription)
      if (Option.isNone(backlog)) {
        // Shut down from the consumer's side already; nothing to watch.
        bus.watchers.delete(watcher)
        continue
      }
      watcher.retainedBytes += size
      if (backlog.value > watcher.bound.maxEnvelopes || watcher.retainedBytes > watcher.bound.maxBytes) {
        bus.watchers.delete(watcher)
        watcher.killed = { retainedEnvelopes: backlog.value, retainedBytes: watcher.retainedBytes }
        // Released here, by the publisher: the backlog is freed now, not
        // when the stalled consumer next looks. Its next pull finds the
        // subscription gone and the failure recorded.
        ended.push(Scope.close(watcher.release, Exit.void))
      }
    }
    return ended.length === 0
      ? Effect.void
      : Effect.uninterruptible(Effect.forEach(ended, (end) => end, { discard: true }))
  })

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
  Stream.unwrap(subscribeEvents(bus))

/**
 * `events`, established on return: the subscription is taken on the
 * caller's fibre before this effect completes, so a publish that follows
 * cannot be missed. What `events` does at its first pull, as an effect a
 * caller can sequence -- the bounded observation seam needs exactly this.
 */
export function subscribeEvents(bus: EventBus): Effect.Effect<Stream.Stream<AgentEventEnvelope>, never, Scope.Scope>
export function subscribeEvents(
  bus: EventBus,
  bound: Observation.Bound & { readonly sessionId: string }
): Effect.Effect<Stream.Stream<AgentEventEnvelope, AgentObservationLagError>, never, Scope.Scope>
export function subscribeEvents(
  bus: EventBus,
  bound?: (Observation.Bound & { readonly sessionId: string }) | undefined
): Effect.Effect<Stream.Stream<AgentEventEnvelope, AgentObservationLagError>, never, Scope.Scope> {
  return Effect.gen(function* () {
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
    // The subscription lives in a scope of its own, closed with this one --
    // or, for a watched subscription, by the publisher when the bound is
    // broken. Either way PubSub's own release runs: the backlog is dropped
    // and a pull in flight is cut.
    const release = yield* Scope.make()
    yield* Effect.addFinalizer((exit) => Scope.close(release, exit))
    yield* failpoints.hit("before-subscribe")
    const subscription = yield* Scope.provide(PubSub.subscribe(bus.pubsub), release)
    const closed = yield* Ref.get(bus.closed)
    if (Option.isSome(closed)) return Stream.make(closed.value)
    const live = Stream.fromSubscription(subscription).pipe(
      Stream.takeUntil((envelope) => envelope.event._tag === "SessionClosed")
    )
    if (bound === undefined) return live
    // Watched by the publisher from now until this scope ends. Delivery is
    // the consumer's own pull with nothing between it and the bus -- no
    // pump, no race per pull -- which is what keeps the host's own record
    // as prompt as an unwatched subscriber. A watcher the publisher ended
    // sees its subscription cut on the next pull and fails with what was
    // recorded, rather than ending as if the session had closed.
    const watcher: Watcher = {
      subscription,
      release,
      bound,
      sessionId: bound.sessionId,
      // Read after subscribing: an envelope published between the subscribe
      // and this read is received but never charged, and never credited.
      since: yield* Ref.get(bus.sequence),
      retainedBytes: 0,
      lastDelivered: 0,
      killed: undefined
    }
    bus.watchers.add(watcher)
    yield* Effect.addFinalizer(() => Effect.sync(() => void bus.watchers.delete(watcher)))
    const failure = () => Observation.lagError(bound.sessionId, bound, watcher.killed!, watcher.lastDelivered)
    return live.pipe(
      Stream.map((envelope) => {
        if (envelope.sequence > watcher.since) watcher.retainedBytes -= bus.sizes.get(envelope) ?? 0
        watcher.lastDelivered = envelope.sequence
        return envelope
      }),
      Stream.catchCause((cause) => watcher.killed === undefined ? Stream.failCause(cause) : Stream.fail(failure())),
      Stream.concat(Stream.suspend(() => watcher.killed === undefined ? Stream.empty : Stream.fail(failure())))
    )
  })
}
