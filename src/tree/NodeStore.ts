import { Effect, Option, Ref, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"

/**
 * Where a tree's nodes live.
 *
 * The tree talks to this and to nothing else about storage, which is what T1's
 * discipline of keeping `history` off `Node` was for: a node carries bounded
 * metadata, the conversation is reached through an operation, and so the
 * representation is the store's business rather than the API's.
 *
 * **This is not a new storage abstraction.** The persistent implementation is
 * an adapter over `effect/unstable/persistence`'s `KeyValueStore`, which
 * already ships memory, filesystem, SQL and web-storage backings. What lives
 * here is the *vocabulary a tree needs* -- get a node, list its children, find
 * the roots -- which a key-value interface cannot express on its own because
 * it has no scan. Those queries are served from indexes this module maintains.
 */

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/**
 * A node's identity, branded.
 *
 * Declared here rather than beside the tree because the store is what has to
 * *persist* one, and a persisted id has to be decodable back into the same
 * brand. Keeping the schema next to the thing that writes it is what stops the
 * two definitions drifting.
 */
export const NodeId = Schema.String.pipe(
  Schema.brand("@doeixd/effect-agent/tree/NodeId")
)
export type NodeId = typeof NodeId.Type

/** Why a node exists. A renderer picks a glyph from this. */
export const NodeCause = Schema.Literals(["root", "prompt", "fork", "manual"])
export type NodeCause = typeof NodeCause.Type

/**
 * A point in the conversation.
 *
 * **Bounded metadata lives on the value; unbounded content lives behind an
 * operation.** There is deliberately no `history` or `snapshot` field: a field
 * would force every node to hold a fully materialised transcript for ever and
 * would make delta storage a breaking change. `SessionTree.historyOf` is an
 * `Effect` instead, so a store can hold whole snapshots, walk deltas to the
 * root, or read a database -- and can fail when a node is gone, which a field
 * cannot express.
 */
export const Node = Schema.Struct({
  id: NodeId,
  parent: Schema.Option(NodeId),
  cause: NodeCause,
  /** When the node was captured, in epoch milliseconds. */
  at: Schema.Number,
  label: Schema.Option(Schema.String)
})
export type Node = typeof Node.Type

/** A node together with the conversation it holds. */
export interface Held {
  readonly node: Node
  readonly history: Prompt.Prompt
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

/**
 * A store failed at something that is not "the node is not there".
 *
 * Separate from `NodeMissing` because they call for different responses: a
 * missing node is an answer about the tree, and this is the storage underneath
 * it being unavailable or holding something that will not decode. Collapsing
 * them would have a disk failure read as an empty tree.
 */
export class StoreError extends Schema.TaggedError<StoreError>()(
  "@doeixd/effect-agent/tree/StoreError",
  {
    /** What was being attempted, e.g. `read`, `write index`. */
    operation: Schema.String,
    /** The node or index key it concerned, where one applies. */
    id: Schema.optional(Schema.String),
    detail: Schema.String
  }
) {
  override get message() {
    const where = this.id === undefined ? "" : ` for ${this.id}`
    return `Node store operation ${this.operation}${where} failed: ${this.detail}`
  }
}

/**
 * Storage for one tree.
 *
 * `E` is the store's failure, and it defaults to `never` so the in-memory case
 * -- which cannot fail -- costs nothing in the tree's signatures. A persistent
 * store carries `StoreError`, and the tree's operations then say so. That is
 * the point of parameterising rather than fixing it: a caller who never
 * persists should not have to handle a failure that cannot happen.
 *
 * Every operation is append-or-read. There is no update and no delete, because
 * IT3 says an ancestor never changes -- a tree grows at the leaves, and a node
 * that could be rewritten would silently rewrite history for every branch
 * below it.
 */
export interface NodeStore<E = never> {
  readonly put: (node: Node, history: Prompt.Prompt) => Effect.Effect<void, E>
  readonly get: (id: NodeId) => Effect.Effect<Option.Option<Held>, E>
  /**
   * Nodes whose parent is `id`, in insertion order.
   *
   * An operation rather than a filter over `nodes`, because a key-value
   * backing cannot scan: this is served from an index the store maintains on
   * write, and a caller filtering `nodes` itself would work in memory and
   * quietly become a full table read everywhere else.
   */
  readonly children: (id: NodeId) => Effect.Effect<ReadonlyArray<Node>, E>
  /** Nodes with no parent, in insertion order. Usually one. */
  readonly roots: Effect.Effect<ReadonlyArray<Node>, E>
  /** Every node, in insertion order. */
  readonly nodes: Effect.Effect<ReadonlyArray<Node>, E>
}

// ---------------------------------------------------------------------------
// In memory
// ---------------------------------------------------------------------------

/**
 * The default: keep everything as it was handed over.
 *
 * No encoding, and that is the reason this exists alongside a key-value
 * backing rather than being replaced by `KeyValueStore.layerMemory`. Prompts
 * are immutable and their message objects are already shared between a node
 * and its parent, so holding them costs a pointer per node. Routing them
 * through a JSON codec would deep-copy every conversation on every write and
 * throw the sharing away, to persist into a map that dies with the process.
 */
export const memory: Effect.Effect<NodeStore> = Effect.gen(function*() {
  const held = yield* Ref.make(new Map<string, Held>())
  // Insertion order, kept separately: a `Map` preserves it, but relying on
  // that would make the order an accident of the implementation rather than
  // something the interface promises.
  const order = yield* Ref.make<ReadonlyArray<string>>([])

  const listing = Effect.gen(function*() {
    const all = yield* Ref.get(held)
    return (yield* Ref.get(order)).flatMap((id) => {
      const found = all.get(id)
      return found === undefined ? [] : [found.node]
    })
  })

  return {
    put: (node, history) =>
      Effect.gen(function*() {
        const existed = (yield* Ref.get(held)).has(node.id)
        yield* Ref.update(held, (all) => new Map(all).set(node.id, { node, history }))
        // A re-`put` of the same id is a mark being applied to a node already
        // there, not a new node -- see `commit`'s dedup. It must not appear
        // twice in the order.
        if (!existed) yield* Ref.update(order, (ids) => [...ids, node.id])
      }),

    get: (id) => Effect.map(Ref.get(held), (all) => Option.fromNullishOr(all.get(id))),

    children: (id) =>
      Effect.map(listing, (all) =>
        all.filter((node) => Option.isSome(node.parent) && node.parent.value === id)),

    roots: Effect.map(listing, (all) => all.filter((node) => Option.isNone(node.parent))),

    nodes: listing
  }
})

// ---------------------------------------------------------------------------
// Key-value backed
// ---------------------------------------------------------------------------

/** What one node occupies under its own key. */
const Entry = Schema.Struct({
  node: Node,
  /**
   * The conversation, encoded.
   *
   * Whole rather than a delta from the parent. The plan offers delta storage
   * as the alternative and it is the better representation for a deep tree --
   * O(depth) to materialise, no write amplification -- but it needs a cache in
   * front of it to be worth having, and correctness first: whole snapshots are
   * obviously right, and swapping in deltas changes this module and nothing
   * else, which is what keeping `history` off `Node` bought.
   *
   * `Prompt.Prompt` rather than `Schema.Unknown`: a prompt is not a plain JSON
   * value -- its parts carry type ids -- so the schema is what makes it one,
   * and using it here means a stored conversation is decoded back into a real
   * prompt rather than cast into the shape of one.
   */
  history: Prompt.Prompt
})

const nodeKey = (id: string) => `node:${id}`
const childrenKey = (id: string) => `children:${id}`
const ROOTS = "roots"
const ORDER = "order"

const Ids = Schema.Array(Schema.String)

/**
 * A store over any `KeyValueStore`: memory, filesystem, SQL, or web storage.
 *
 * The indexes are the whole design. A key-value interface has `get` and `set`
 * and no scan, so "the children of this node" and "every node" have to be
 * written down as they happen rather than discovered later. Each `put`
 * therefore appends to at most three lists.
 *
 * That makes a write several operations where a database would do one, and the
 * lists are read and rewritten whole. It is the price of running over an
 * interface that promises nothing but a map -- and the reason `memory` above
 * exists, since none of it earns anything for a tree that never leaves the
 * process.
 */
export const keyValue = (
  kv: KeyValueStore.KeyValueStore,
  options?: {
    /** Namespace, so several trees can share one backing. */
    readonly prefix?: string | undefined
  }
): NodeStore<StoreError> => {
  const scoped = options?.prefix === undefined ? kv : KeyValueStore.prefix(kv, `${options.prefix}:`)
  const entries = KeyValueStore.toSchemaStore(scoped, Entry)
  const ids = KeyValueStore.toSchemaStore(scoped, Ids)

  // A string rather than the cause object, matching `Errors.StorageError`:
  // these travel over the wire to clients that cannot reconstruct a defect.
  const fail = (operation: string, id?: string) => (cause: unknown) =>
    new StoreError({
      operation,
      ...(id === undefined ? {} : { id }),
      detail: cause instanceof Error ? cause.message : String(cause)
    })

  const readIds = (key: string): Effect.Effect<ReadonlyArray<string>, StoreError> =>
    ids.get(key).pipe(
      Effect.map(Option.getOrElse(() => [] as ReadonlyArray<string>)),
      Effect.mapError(fail("read index", key))
    )

  const append = (key: string, id: string): Effect.Effect<void, StoreError> =>
    readIds(key).pipe(
      Effect.flatMap((existing) =>
        existing.includes(id)
          ? Effect.void
          : ids.set(key, [...existing, id]).pipe(Effect.mapError(fail("write index", key)))
      )
    )

  const nodesOf = (key: string): Effect.Effect<ReadonlyArray<Node>, StoreError> =>
    readIds(key).pipe(
      Effect.flatMap((found) =>
        Effect.forEach(found, (id) =>
          entries.get(nodeKey(id)).pipe(
            Effect.mapError(fail("read", id)),
            Effect.map(Option.map((entry) => entry.node))
          ))
      ),
      // An index naming a node that is not there is a torn write, not an empty
      // tree: reporting it as a gap would hide the damage.
      Effect.flatMap((found) =>
        found.some(Option.isNone)
          ? Effect.fail(
            new StoreError({
              operation: "read index",
              id: key,
              detail: "the index names a node that is not stored"
            })
          )
          : Effect.succeed(found.map((node) => Option.getOrThrow(node)))
      )
    )

  return {
    put: (node, history) =>
      entries.set(nodeKey(node.id), { node, history }).pipe(
        Effect.mapError(fail("write", node.id)),
        // The node first, then the indexes. The other order can leave an index
        // pointing at a node that was never written, which reads as corruption
        // rather than as an interrupted write.
        Effect.andThen(append(ORDER, node.id)),
        Effect.andThen(
          Option.isSome(node.parent)
            ? append(childrenKey(node.parent.value), node.id)
            : append(ROOTS, node.id)
        )
      ),

    get: (id) =>
      entries.get(nodeKey(id)).pipe(
        Effect.mapError(fail("read", id)),
        Effect.map(Option.map((entry) => ({ node: entry.node, history: entry.history })))
      ),

    children: (id) => nodesOf(childrenKey(id)),
    roots: nodesOf(ROOTS),
    nodes: nodesOf(ORDER)
  }
}
