import { Cause, Effect, Exit, Queue, Scope, Stream } from "effect"
import * as AgentEvent from "../AgentEvent.js"
import { AgentObservationLagError } from "../Errors.js"
import { positiveInteger } from "./positive.js"

/**
 * Bounded observation (`plan-streaming-followups.md` §4, item 75): the
 * vocabulary, the wire size, and the pumped form for a delivery log.
 *
 * The bus is unbounded and a subscriber that stops reading retains every
 * envelope until its scope ends -- which for a hosted SSE or RPC stream is
 * until the connection dies. A sliding buffer would corrupt what it drops:
 * a text delta or an argument fragment lost from the middle of a message
 * leaves a consumer with a prefix presented as whole. So the bound is on the
 * *observation*: past `maxEnvelopes` or `maxBytes` outstanding, the stream
 * fails with `AgentObservationLagError` naming the last sequence it
 * delivered and the subscription is released. Execution and the journal
 * sink are never involved: the bus never waited on this subscriber.
 *
 * Two forms, because two seams own subscriptions. **In-process**, the bus
 * enforces it at publish (`EventBus.subscribeEvents` with a bound): after
 * each publish it reads every watched subscription's backlog, charges the
 * envelope's wire size, and releases one past its bound from the
 * publisher's side, so the consumer's delivery stays its own pull with no
 * fibre between it and the bus. **For a delivery log**, `bounded` below
 * pumps the log's established subscription into a queue and counts what the
 * consumer has not taken. Two designs were tried and rejected on the way:
 * a pump around the host's stream moved the subscription one fibre hop
 * later than `events` promised, and the A2A adapter's elicitation listener
 * missed the request it waited for; and a per-pull race against a kill
 * signal made the host's own record lag a hop behind the run. Only the seam
 * that takes the subscription can bound it without either.
 *
 * "Delivered" means handed to the consumer, in the chunks a stream hands
 * out, not received by the peer. A client that resumes must use the last
 * sequence it *parsed*, which is what SSE's `Last-Event-ID` carries; the
 * error's `lastDelivered` is an upper bound on that.
 */
export interface Bound {
  readonly maxEnvelopes: number
  readonly maxBytes: number
}

/** The option as a client accepts it; either part may be omitted. */
export interface LagOptions {
  readonly envelopes?: number | undefined
  readonly bytes?: number | undefined
}

/** 2048 envelopes, 8 MiB of wire JSON. */
export const defaultBound: Bound = { maxEnvelopes: 2048, maxBytes: 8 * 1024 * 1024 }

export const boundOf = (where: string, options: LagOptions | undefined): Bound => ({
  maxEnvelopes: positiveInteger(`${where} maxObservationLag.envelopes`, options?.envelopes ?? defaultBound.maxEnvelopes),
  maxBytes: positiveInteger(`${where} maxObservationLag.bytes`, options?.bytes ?? defaultBound.maxBytes)
})

/**
 * The size the bound counts: the envelope as the wire carries it, in UTF-8
 * bytes -- `String.length` counts UTF-16 units and undercounts anything
 * outside ASCII by up to a factor of three. A transport encodes again, so
 * this is a second serialisation per envelope observed remotely; a bound
 * that counted something cheaper would not be a bound on what is retained.
 */
export const wireSize = (envelope: AgentEvent.AgentEventEnvelope): number =>
  utf8Length(JSON.stringify(AgentEvent.toWire(envelope)))

/** UTF-8 byte length of a string, without allocating the encoding. */
export const utf8Length = (text: string): number => {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      // A surrogate pair is one four-byte code point.
      bytes += 4
      i += 1
    } else bytes += 3
  }
  return bytes
}

/** What the publisher records when it ends an observation; the consumer builds the error at delivery, with an accurate cursor. */
export interface Killed {
  readonly retainedEnvelopes: number
  readonly retainedBytes: number
}

export const lagError = (
  sessionId: string,
  bound: Bound,
  killed: Killed,
  lastDelivered: number
): AgentObservationLagError =>
  new AgentObservationLagError({
    sessionId,
    lastDelivered,
    retainedEnvelopes: killed.retainedEnvelopes,
    retainedBytes: killed.retainedBytes,
    maxEnvelopes: bound.maxEnvelopes,
    maxBytes: bound.maxBytes
  })

/**
 * The bounded observation for a subscription the bus cannot watch -- a
 * delivery log's -- established on return like the subscription it wraps.
 *
 * The subscription is taken here, on the caller's fibre, into a scope of
 * its own, and a pump forked after it drains it into a queue, counting
 * what the consumer has not taken. Past the bound the pump records why,
 * **closes the subscription's scope** so the backlog is freed now, and
 * shuts the queue down so nothing buffered is delivered after the fact:
 * the consumer's next pull fails with the error built then, so its cursor
 * is what was really handed out. (A first version failed the queue instead
 * and stopped the pump: `Queue.fail` on a non-empty queue delivers the
 * buffer first, so the cursor it had recorded was below what the consumer
 * then received, and ending the pump released nothing -- the subscription
 * belonged to the caller's scope. The second reviewer caught both.)
 */
export const bounded = <E, E2>(
  subscribe: Effect.Effect<Stream.Stream<AgentEvent.AgentEventEnvelope, E>, E2, Scope.Scope>,
  options: Bound & { readonly sessionId: string }
): Effect.Effect<Stream.Stream<AgentEvent.AgentEventEnvelope, E | AgentObservationLagError>, E2, Scope.Scope> =>
  Effect.gen(function* () {
    const release = yield* Scope.make()
    yield* Effect.addFinalizer((exit) => Scope.close(release, exit))
    const source = yield* Scope.provide(subscribe, release)
    const queue = yield* Queue.unbounded<AgentEvent.AgentEventEnvelope, E | Cause.Done>()
    // Retained by the queue and not yet taken. Updated by the pump on offer
    // and by the consumer on take; both run on one runtime, and a momentary
    // over-count only makes the bound stricter.
    let envelopes = 0
    let bytes = 0
    let lastDelivered = 0
    let killed: Killed | undefined
    yield* Stream.runForEach(source, (envelope) =>
      Effect.gen(function* () {
        const size = wireSize(envelope)
        if (envelopes + 1 > options.maxEnvelopes || bytes + size > options.maxBytes) {
          killed = { retainedEnvelopes: envelopes + 1, retainedBytes: bytes + size }
          // One uninterruptible step: the backlog is freed and the queue
          // is cut, or neither is.
          yield* Effect.uninterruptible(
            Effect.andThen(Scope.close(release, Exit.void), Queue.shutdown(queue))
          )
          return yield* Effect.interrupt
        }
        envelopes += 1
        bytes += size
        yield* Queue.offer(queue, envelope)
      })
    ).pipe(
      Effect.matchCauseEffect({
        onSuccess: () => Queue.end(queue),
        onFailure: (cause) => Queue.failCause(queue, cause)
      }),
      Effect.forkScoped
    )
    return Stream.fromQueue(queue).pipe(
      Stream.map((envelope) => {
        envelopes -= 1
        bytes -= wireSize(envelope)
        lastDelivered = envelope.sequence
        return envelope
      }),
      // A shut-down queue cuts the pull; when this observation was ended,
      // that cut is the failure, built now so the cursor is accurate.
      Stream.catchCause((cause): Stream.Stream<never, E | AgentObservationLagError> =>
        killed === undefined
          ? Stream.failCause(cause)
          : Stream.fail(lagError(options.sessionId, options, killed, lastDelivered))),
      Stream.concat(Stream.suspend((): Stream.Stream<never, AgentObservationLagError> =>
        killed === undefined ? Stream.empty : Stream.fail(lagError(options.sessionId, options, killed, lastDelivered))))
    )
  })
