import { Cause, Effect, Queue, Scope, Stream } from "effect"
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
 * The size the bound counts: the envelope as the wire carries it. A
 * transport encodes again, so this is a second serialisation per envelope
 * observed remotely; a bound that counted something cheaper would not be a
 * bound on what is retained.
 */
export const wireSize = (envelope: AgentEvent.AgentEventEnvelope): number =>
  JSON.stringify(AgentEvent.toWire(envelope)).length

/**
 * The bounded observation, established on return like the subscription it
 * wraps: the subscription is taken here, on the caller's fibre, and the
 * pump is forked after it. `Stream.unwrap` this where a stream is wanted.
 */
export const bounded = <E, E2>(
  subscribe: Effect.Effect<Stream.Stream<AgentEvent.AgentEventEnvelope, E>, E2, Scope.Scope>,
  options: Bound & { readonly sessionId: string }
): Effect.Effect<Stream.Stream<AgentEvent.AgentEventEnvelope, E | AgentObservationLagError>, E2, Scope.Scope> =>
  Effect.gen(function* () {
    const source = yield* subscribe
    const queue = yield* Queue.unbounded<AgentEvent.AgentEventEnvelope, E | AgentObservationLagError | Cause.Done>()
    // Retained by the queue and not yet taken. Updated by the pump on offer
    // and by the consumer on take; both run on one runtime, and a momentary
    // over-count only makes the bound stricter.
    let envelopes = 0
    let bytes = 0
    let lastDelivered = 0
    yield* Stream.runForEach(source, (envelope) =>
      Effect.gen(function* () {
        const size = wireSize(envelope)
        if (envelopes + 1 > options.maxEnvelopes || bytes + size > options.maxBytes) {
          yield* Queue.fail(
            queue,
            new AgentObservationLagError({
              sessionId: options.sessionId,
              lastDelivered,
              retainedEnvelopes: envelopes,
              retainedBytes: bytes,
              maxEnvelopes: options.maxEnvelopes,
              maxBytes: options.maxBytes
            })
          )
          // Ends the pump; its scope releases the subscription.
          return yield* Effect.interrupt
        }
        envelopes += 1
        bytes += size
        yield* Queue.offer(queue, envelope)
      })
    ).pipe(
      Effect.matchCauseEffect({
        onSuccess: () => Queue.end(queue),
        // A queue already failed with the lag error ignores a second cause.
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
      })
    )
  })
