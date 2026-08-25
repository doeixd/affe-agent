import { Effect, Option, Ref, Schema } from "effect"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import * as NodeStore from "../../../src/tree/NodeStore.js"

/**
 * Where the user was, as a thing that is written down.
 *
 * Resume used to infer it: the node with the greatest capture time, across
 * every line of work. That reads as "the most recent thing that happened",
 * and it is -- but it is not *where the user was*. Rewinding moves the cursor
 * to an older node and creates nothing, and so does switching branches; exit
 * after either and the tip still holds the newest capture time, so the next
 * launch silently undid the rewind. Millisecond ties and a clock that moves
 * backwards make the ordering weaker still.
 *
 * A checkout pointer is the ordinary answer: one record, written after an
 * activation has actually succeeded, read at startup. It is deliberately not
 * part of `NodeStore` -- nodes are immutable and append-only, and this is a
 * single mutable cell whose whole job is to change.
 */
export interface Checkout {
  /** The node last activated, if this store has ever recorded one. */
  readonly read: Effect.Effect<Option.Option<NodeStore.NodeId>>
  /**
   * Record a node as the current one.
   *
   * Failure is deliberately absorbed: losing the pointer costs a resume that
   * falls back to the newest capture, which is exactly the old behaviour and
   * not worth failing an activation the user asked for and watched succeed.
   */
  readonly write: (id: NodeStore.NodeId) => Effect.Effect<void>
}

/** Nothing is remembered. The default, and what a scripted run wants. */
export const none: Checkout = {
  read: Effect.succeed(Option.none()),
  write: () => Effect.void
}

/** In this process only: enough for a test that never restarts. */
export const memory: Effect.Effect<Checkout> = Effect.map(
  Ref.make(Option.none<NodeStore.NodeId>()),
  (ref): Checkout => ({
    read: Ref.get(ref),
    write: (id) => Ref.set(ref, Option.some(id))
  })
)

const KEY = "checkout"

const decodeId = Schema.decodeUnknownEffect(NodeStore.NodeId)

/**
 * Over any `KeyValueStore`, which is what the live backend already has.
 *
 * The same backing as the nodes, under its own key, so a workspace's
 * conversation and the place it was left carry together -- and deleting the
 * directory forgets both, which is what deleting it means.
 */
export const keyValue = (kv: KeyValueStore.KeyValueStore): Checkout => ({
  read: kv.get(KEY).pipe(
    /**
     * Decoded, not cast.
     *
     * `NodeStore.NodeId` is a `Schema`, so a value read back from storage can
     * be turned into one by the same definition that wrote it -- which is the
     * whole reason the brand was declared beside the store rather than beside
     * the tree. Asserting the brand here would be a cast in application code,
     * and would also mean an id from a corrupted or foreign file entering a
     * branded API unchecked.
     */
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.succeed(Option.none<NodeStore.NodeId>())
        : Effect.map(decodeId(value), Option.some)),
    // A pointer that is missing, unreadable or not an id is a first launch,
    // not a failure: the fallback is the newest capture, which is where this
    // started.
    Effect.orElseSucceed(() => Option.none<NodeStore.NodeId>())
  ),
  write: (id) => Effect.ignore(kv.set(KEY, id))
})
