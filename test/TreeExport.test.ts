import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Export from "../src/export/Export.js"
import * as SessionTree from "../src/tree/SessionTree.js"
import * as TreeExport from "../src/tree/TreeExport.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * E5 -- exporting a piece of a tree.
 *
 * The whole tree is the one unit nobody wants: it is every path not taken. The
 * useful units are a path (one conversation) and a subtree (one exploration),
 * and both fall out of parent pointers.
 */

const agent = Agent.make({
  instructions: "You answer briefly.",
  loop: AgentLoop.bounded(2)
})

const script = (...replies: ReadonlyArray<string>) =>
  TestLanguageModel.script(replies.map((reply) => TestLanguageModel.text(reply)))

const provenance: Export.Provenance = { harnessVersion: "0.0.0-test" }

const textOf = (self: Export.Export): string =>
  JSON.stringify(Export.historyOf(self).content)

/** A trunk with two branches, the left one two turns deep. */
const grown = Effect.gen(function*() {
  const tree = yield* SessionTree.make(agent)
  const trunk = yield* AgentSession.make(agent)
  yield* trunk.prompt("the trunk")
  const root = yield* tree.commit(trunk)

  const left = yield* tree.branch(root)
  yield* left.prompt("down the left")
  const leftOne = yield* tree.commit(left)
  yield* left.prompt("further left")
  const leftTwo = yield* tree.commit(left)

  const right = yield* tree.branch(root)
  yield* right.prompt("down the right")
  const rightOne = yield* tree.commit(right)

  return { tree, root, leftOne, leftTwo, rightOne }
})

describe("TreeExport", () => {
  it.effect("a path export is one conversation, root to node", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("trunk", "left one", "left two", "right one")

      const out = yield* Effect.gen(function*() {
        const { leftTwo, rightOne, tree } = yield* grown
        return {
          left: yield* TreeExport.path(tree, leftTwo, provenance),
          right: yield* TreeExport.path(tree, rightOne, provenance)
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      // The shared prefix is in both, because each file is a whole
      // conversation -- a reader opens one and needs nothing else.
      assert.include(textOf(out.left), "the trunk")
      assert.include(textOf(out.right), "the trunk")

      // And the path not taken is in neither. This is the point of exporting a
      // path rather than the tree.
      assert.include(textOf(out.left), "further left")
      assert.notInclude(textOf(out.right), "further left")
      assert.notInclude(textOf(out.left), "down the right")
    }))

  it.effect("lineage is recorded, so a branch says what it branched from", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("trunk", "left one", "left two", "right one")

      const out = yield* Effect.gen(function*() {
        const { leftOne, root, tree } = yield* grown
        return {
          root: yield* TreeExport.path(tree, root, provenance),
          branch: yield* TreeExport.path(tree, leftOne, provenance),
          rootNode: root
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      // A reader with both files can line them up; a reader with one still
      // knows there was another. That is what Pi's `parentSessionId` buys.
      const parent = out.branch.provenance.parent
      assert.isDefined(parent)
      assert.strictEqual(parent?.nodeId, out.rootNode.id)

      // A root has no parent and does not invent one.
      assert.isUndefined(out.root.provenance.parent)
    }))

  it.effect("a subtree is the exploration below a node", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("trunk", "left one", "left two", "right one")

      const out = yield* Effect.gen(function*() {
        const { root, tree } = yield* grown
        return {
          all: yield* TreeExport.subtree(tree, root, provenance),
          leaves: yield* TreeExport.leaves(tree, root, provenance)
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      // Four nodes: the root, two on the left, one on the right.
      assert.strictEqual(out.all.length, 4)
      // Breadth-first, so a reader meets a branch point before its branches.
      assert.include(textOf(out.all[0]!), "the trunk")
      assert.notInclude(textOf(out.all[0]!), "down the left")

      // The two tips. Each already contains its whole path, so between them
      // they cover everything said without filing a branch point separately.
      assert.strictEqual(out.leaves.length, 2)
      const said = out.leaves.map(textOf).join("")
      assert.include(said, "further left")
      assert.include(said, "down the right")
    }))

  it.effect("a leaf's subtree is just itself", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("trunk", "left one", "left two", "right one")

      const out = yield* Effect.gen(function*() {
        const { leftTwo, tree } = yield* grown
        return yield* TreeExport.subtree(tree, leftTwo, provenance)
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.strictEqual(out.length, 1)
    }))

  it.effect("every exported piece is an ordinary export", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("trunk", "left one", "left two", "right one")

      const out = yield* Effect.gen(function*() {
        const { leftTwo, tree } = yield* grown
        const exported = yield* TreeExport.path(tree, leftTwo, provenance)
        const text = yield* Export.encode(exported)
        // Nothing tree-shaped in the file: it is a transcript with its lineage
        // noted, which is why it can be read by something that knows nothing
        // about trees -- and restored into a plain session.
        const parsed = yield* Export.parse(text)
        const session = yield* AgentSession.restore(agent, parsed.session)
        return { parsed, history: yield* session.history }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.strictEqual(out.parsed.version, Export.VERSION)
      assert.isAbove(out.history.content.length, 0)
    }))

  it.effect("a node from another tree is refused, not answered", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("trunk", "left one", "left two", "right one", "other")

      const failure = yield* Effect.gen(function*() {
        const { tree } = yield* grown
        const stranger = yield* SessionTree.make(agent)
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("elsewhere")
        const elsewhere = yield* stranger.commit(session)
        // Ids are minted per tree, so asking one tree about another's node has
        // to fail rather than answer with whatever it holds under that id.
        return yield* Effect.flip(TreeExport.path(tree, elsewhere, provenance))
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.strictEqual(failure._tag, "affe-agent/tree/NodeMissing")
    }))

  /**
   * R84 -- an export's lineage comes from the tree, not from the caller.
   *
   * `Node` is a plain value: nothing stops a caller building one with a real
   * id and a fabricated parent, label or cause. `historyOf` looked the id up
   * and returned canonical history, and then everything printed *around* that
   * history came from the argument -- so a forged node exported real
   * conversation under false ancestry. Lineage is the one thing an export
   * exists to be trusted about.
   */
  it.effect("a forged node cannot rewrite what an export says about it", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("root answer", "left answer")
      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("start")
        const root = yield* tree.commit(session)
        const left = yield* tree.branch(root)
        yield* left.prompt("go left")
        const leftOne = yield* tree.commit(left)

        // Real id, invented ancestry.
        const forged: SessionTree.Node = {
          ...leftOne,
          parent: Option.some("a-node-that-never-existed" as SessionTree.NodeId),
          label: Option.some("not what this is called"),
          cause: "manual"
        }
        return {
          honest: yield* TreeExport.path(tree, leftOne, provenance),
          forgedExport: yield* TreeExport.path(tree, forged, provenance),
          rootId: root.id
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      // Identical: the forgery changed nothing, because nothing it carried
      // was read.
      assert.strictEqual(
        out.forgedExport.provenance.parent?.nodeId,
        out.rootId
      )
      assert.deepStrictEqual(
        out.forgedExport.provenance.parent,
        out.honest.provenance.parent
      )
      assert.strictEqual(out.forgedExport.session.sessionId, out.honest.session.sessionId)
    }))

  it.effect("and an id that is not in the tree is refused", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("root answer")
      const outcome = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("start")
        yield* tree.commit(session)
        return yield* Effect.flip(
          TreeExport.path(
            tree,
            {
              id: "not-here" as SessionTree.NodeId,
              parent: Option.none(),
              cause: "root",
              at: 0,
              label: Option.none()
            },
            provenance
          )
        )
      }).pipe(Effect.provide(layer), Effect.scoped)
      assert.strictEqual(outcome._tag, "affe-agent/tree/NodeMissing")
    }))
})
