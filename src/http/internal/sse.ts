import { Effect, Stream } from "effect"

/**
 * How many encoded SSE frames one request may hold ahead of its reader.
 *
 * A slow or stalled reader must not grant its request an unbounded memory
 * claim, which is what `capacity: "unbounded"` did: an `EventSource` that
 * stopped reading -- a laptop asleep, a tab throttled -- let the session's
 * events accumulate in this process for as long as the connection stayed open.
 *
 * Bounded, and neither dropping nor sliding. Both would corrupt the stream in
 * ways the far side cannot detect: SSE carries the session's sequence numbers,
 * and a consumer that silently loses the middle of a tool call has no way to
 * find out. Backpressuring the producer is the honest answer, and request-scope
 * interruption releases a blocked producer when the client disconnects.
 *
 * 256 is AG-UI's number, and deliberately the same one: the two transports face
 * the same question -- absorb ordinary token bursts, impose a fixed per-request
 * ceiling -- and two different answers would only be two numbers to explain.
 * See the bounded queue in `AgentAgUi.serverLayer` for the sibling comment.
 */
export const frameCapacity = 256

/**
 * Run `frames` into a bounded queue and serve the queue as the response body.
 *
 * The subscription is acquired *eagerly*: the source runs into the queue from
 * the moment the response starts, so a client that has connected is observing
 * from then, not from its second read. (`concat` would start the source only
 * once the leading comment had been consumed.)
 *
 * The leading comment goes out first so the response headers are flushed before
 * the first event exists. A body that writes nothing until the session emits
 * leaves the client waiting on headers -- `fetch` does not resolve,
 * `EventSource` does not open -- for as long as the session stays quiet, which
 * for a subscription opened *before* the prompt is exactly the interesting case.
 */
export const body = <E>(
  frames: Stream.Stream<string, E>
): Stream.Stream<Uint8Array, E> =>
  Stream.unwrap(
    Effect.map(
      Stream.toQueue(frames, { capacity: frameCapacity }),
      (queue) => Stream.fromQueue(queue).pipe(Stream.prepend([": connected\n\n"]))
    )
  ).pipe(Stream.encodeText)
