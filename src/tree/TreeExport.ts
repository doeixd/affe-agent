import { Effect, Option } from "effect"
import * as Export from "../export/Export.js"
import { type Node, NodeMissing, TreeCorrupt } from "./SessionTree.js"
import type { SessionTree } from "./SessionTree.js"

/**
 * Exporting a piece of a tree.
 *
 * Once conversations branch, the whole tree is the one unit nobody wants: it
 * is every path not taken, and pasting it somewhere is unreadable. The two
 * units that *are* useful are a **path** -- root to a node, one conversation --
 * and a **subtree** -- a node and everything below it, one exploration.
 *
 * Both fall out of parent pointers, which is why this is a hundred lines
 * rather than a format: `historyOf(node)` already *is* the root-to-node
 * conversation, so a path export is an ordinary export with its lineage
 * filled in.
 *
 * The dependency runs tree -> export, deliberately. An export is the more
 * general thing and knows nothing about nodes; a tree knows what a node is and
 * can say so.
 */

/**
 * One conversation: the path from the root to this node.
 *
 * `provenance.parent` records where in the tree it came from, so a transcript
 * that was branched from another can say so -- which is the whole reason Pi
 * carries `parentSessionId`. A reader who has both files can then line them
 * up; a reader with one still knows there was another.
 */
export const path = <Tools extends Record<string, any>, E, SE>(
  tree: SessionTree<Tools, E, SE>,
  node: Node,
  provenance: Export.Provenance
): Effect.Effect<Export.Export, NodeMissing | SE> =>
  Effect.gen(function*() {
    /**
     * The tree's node, not the caller's.
     *
     * `historyOf` looks a node up by id and returns canonical history, but
     * everything *around* that history used to come from the argument: its
     * id, and its parent. A `Node` is a plain value a caller can construct,
     * so an existing id carrying a fabricated parent exported real
     * conversation under false lineage -- and lineage is exactly what an
     * export exists to be trusted about.
     *
     * Looked up once and used for both, so there is no version of this where
     * the history and the metadata describe different nodes.
     */
    const found = yield* tree.node(node.id)
    if (Option.isNone(found)) return yield* new NodeMissing({ id: node.id })
    const canonical = found.value
    const history = yield* tree.historyOf(canonical)
    return yield* Export.of(
      { sessionId: canonical.id, history },
      {
        ...provenance,
        parent: Option.isNone(canonical.parent)
          ? provenance.parent
          : // A node with no parent is a root and inherits whatever lineage
            // the caller supplied, which is how a tree grown from an imported
            // transcript keeps its ancestry.
            //
            // `nodeId` only: the parent is a node in this tree, and it is not
            // a session id. Writing it into both fields said something false
            // about a field a reader is meant to be able to line up against
            // another export's `sessionId`.
            { nodeId: canonical.parent.value }
      }
    )
  })

/**
 * An exploration: this node and everything below it.
 *
 * One export per node, in breadth-first order, so a reader meets a branch
 * point before the branches. Each is a complete conversation rather than a
 * delta, because the files are meant to be read one at a time -- a bundle
 * whose members only make sense together is a format, and a format is a
 * promise this does not need to make.
 *
 * The cost is real and is the reason `path` exists: a subtree of *n* nodes
 * repeats the shared prefix *n* times. Export the path when one conversation
 * is what is wanted.
 */
export const subtree = <Tools extends Record<string, any>, E, SE>(
  tree: SessionTree<Tools, E, SE>,
  node: Node,
  provenance: Export.Provenance
): Effect.Effect<ReadonlyArray<Export.Export>, NodeMissing | TreeCorrupt | SE> =>
  Effect.gen(function*() {
    const exports: Array<Export.Export> = []
    // Breadth-first, so the ordering of the files matches the shape of what
    // they describe. Iterative rather than recursive: a long branch is a deep
    // tree, and a conversation is exactly the sort of thing that gets long.
    //
    // A read cursor rather than `shift`, which re-indexes the whole queue on
    // every step and made walking a wide tree quadratic in its own bookkeeping.
    const queue: Array<Node> = [node]
    const seen = new Set<string>()
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]!
      // A node reached twice means the store is not describing a tree. Left
      // undetected this loops forever on a custom or damaged store; caught
      // here it is an answer.
      if (seen.has(current.id)) {
        return yield* new TreeCorrupt({
          id: current.id,
          detail: "a node appears twice below one root"
        })
      }
      seen.add(current.id)
      exports.push(yield* path(tree, current, provenance))
      queue.push(...(yield* tree.children(current)))
    }
    return exports
  })

/**
 * Every leaf below a node, as one export each.
 *
 * The useful middle ground, and usually what "export my explorations" means:
 * each leaf's export already contains the whole path to it, so the set covers
 * everything that was said without repeating a branch point as its own file.
 */
export const leaves = <Tools extends Record<string, any>, E, SE>(
  tree: SessionTree<Tools, E, SE>,
  node: Node,
  provenance: Export.Provenance
): Effect.Effect<ReadonlyArray<Export.Export>, NodeMissing | TreeCorrupt | SE> =>
  Effect.gen(function*() {
    const found: Array<Node> = []
    const queue: Array<Node> = [node]
    const seen = new Set<string>()
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]!
      if (seen.has(current.id)) {
        return yield* new TreeCorrupt({
          id: current.id,
          detail: "a node appears twice below one root"
        })
      }
      seen.add(current.id)
      const children = yield* tree.children(current)
      if (children.length === 0) found.push(current)
      else queue.push(...children)
    }
    return yield* Effect.forEach(found, (leaf) => path(tree, leaf, provenance))
  })
