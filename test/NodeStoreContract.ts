import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import type * as NodeStore from "../src/tree/NodeStore.js"

/**
 * What every node store must agree on.
 *
 * Two implementations exist for reasons that have nothing to do with each
 * other -- one keeps object identity because a tree that never leaves the
 * process should not pay to encode, the other survives a restart -- and the
 * whole risk of having two is that they quietly disagree. Written once, run
 * against both.
 *
 * The store is deliberately *not* given a way to update or delete. IT3 says an
 * ancestor never changes, so a tree only ever grows at its leaves; the one
 * exception is re-writing a node under its own id, which is a label being
 * applied to a node already there rather than a second node.
 */

const node = (
  id: string,
  parent?: string,
  extra?: { readonly label?: string; readonly cause?: NodeStore.NodeCause }
): NodeStore.Node => ({
  id: id as NodeStore.NodeId,
  parent: Option.fromNullishOr(parent as NodeStore.NodeId | undefined),
  cause: extra?.cause ?? (parent === undefined ? "root" : "prompt"),
  at: 1_700_000_000_000,
  label: Option.fromNullishOr(extra?.label)
})

const history = (...texts: ReadonlyArray<string>): Prompt.Prompt =>
  Prompt.fromMessages(
    texts.map((text) => Prompt.userMessage({ content: [Prompt.textPart({ text })] }))
  )

const textOf = (prompt: Prompt.Prompt): string =>
  JSON.stringify(Schema.encodeUnknownSync(Prompt.Prompt)(prompt))

export const contract = <E>(
  name: string,
  makeStore: Effect.Effect<NodeStore.NodeStore<E>>
) =>
  describe(`NodeStore (${name})`, () => {
    it.effect("a stored node reads back with its conversation", () =>
      Effect.gen(function*() {
        const store = yield* makeStore
        yield* store.put(node("a"), history("first", "second"))

        const found = yield* store.get("a" as NodeStore.NodeId)
        assert.isTrue(Option.isSome(found))
        const held = Option.getOrThrow(found)
        assert.strictEqual(held.node.id, "a")
        assert.strictEqual(held.node.cause, "root")
        assert.isTrue(Option.isNone(held.node.parent))
        // Through the encoded form, so this compares conversations rather than
        // object identity -- which is the one thing the two implementations
        // are allowed to differ on.
        assert.strictEqual(textOf(held.history), textOf(history("first", "second")))
      }))

    it.effect("an absent node is None, not a failure", () =>
      Effect.gen(function*() {
        const store = yield* makeStore
        // A tree asks about nodes it may not have -- a stale id from a client,
        // a parent from a different tree. That is an answer, not an error.
        const found = yield* store.get("nope" as NodeStore.NodeId)
        assert.isTrue(Option.isNone(found))
      }))

    it.effect("children are the nodes that name this one as parent", () =>
      Effect.gen(function*() {
        const store = yield* makeStore
        yield* store.put(node("a"), history("root"))
        yield* store.put(node("b", "a"), history("root", "left"))
        yield* store.put(node("c", "a"), history("root", "right"))
        yield* store.put(node("d", "b"), history("root", "left", "deeper"))

        const children = yield* store.children("a" as NodeStore.NodeId)
        assert.deepStrictEqual(children.map((child) => child.id), ["b", "c"])
        // Children, not descendants: `d` is below `a` but is not its child,
        // and a store that conflated them would make a fan look like a chain.
        assert.deepStrictEqual(
          (yield* store.children("b" as NodeStore.NodeId)).map((child) => child.id),
          ["d"]
        )
        assert.deepStrictEqual(yield* store.children("d" as NodeStore.NodeId), [])
      }))

    it.effect("roots are the parentless nodes", () =>
      Effect.gen(function*() {
        const store = yield* makeStore
        yield* store.put(node("a"), history("one"))
        yield* store.put(node("b", "a"), history("one", "two"))
        // Two unrelated conversations in one store: representable, because a
        // tree records whatever sessions it is given.
        yield* store.put(node("z"), history("other"))

        assert.deepStrictEqual((yield* store.roots).map((root) => root.id), ["a", "z"])
      }))

    it.effect("nodes come back in the order they were stored", () =>
      Effect.gen(function*() {
        const store = yield* makeStore
        for (const id of ["a", "b", "c"]) {
          yield* store.put(node(id, id === "a" ? undefined : "a"), history(id))
        }
        // Insertion order is the tree's chronology, and a renderer listing
        // branch points shows them in the order they happened.
        assert.deepStrictEqual((yield* store.nodes).map((found) => found.id), ["a", "b", "c"])
      }))

    it.effect("re-storing an id replaces the node without duplicating it", () =>
      Effect.gen(function*() {
        const store = yield* makeStore
        yield* store.put(node("a"), history("one"))
        yield* store.put(node("b", "a"), history("one", "two"))
        // What `commit({ label })` does to an unchanged conversation: mark the
        // node that is already there.
        yield* store.put(node("b", "a", { label: "before refactor", cause: "manual" }), history("one", "two"))

        const all = yield* store.nodes
        assert.deepStrictEqual(all.map((found) => found.id), ["a", "b"])
        assert.deepStrictEqual(
          (yield* store.children("a" as NodeStore.NodeId)).map((child) => child.id),
          ["b"]
        )
        const found = Option.getOrThrow(yield* store.get("b" as NodeStore.NodeId))
        assert.strictEqual(Option.getOrThrow(found.node.label), "before refactor")
        assert.strictEqual(found.node.cause, "manual")
      }))


    /**
     * R77 -- a familiar id must not be a way to move an ancestor.
     *
     * `put` accepts an id it has already seen because `commit` uses it to
     * apply a label or a cause. It used to accept anything else too: a
     * different parent, or a different conversation, overwrote the node while
     * the root/order/children indexes -- written once, at insertion -- went on
     * describing the node that used to be there.
     *
     * A defect rather than a typed failure: it is not a condition a caller
     * encounters, it is two pieces of code disagreeing about what an id names.
     */
    it.effect("re-storing an id may change its mark, never its ancestry", () =>
      Effect.gen(function*() {
        const store = yield* makeStore
        yield* store.put(node("a"), history("one"))
        yield* store.put(node("b", "a"), history("one", "two"))

        // Legal: the same node, marked. Already covered above, restated here
        // so the boundary is visible in one place.
        yield* store.put(node("b", "a", { label: "kept" }), history("one", "two"))

        // Illegal: a different parent under a familiar id.
        const reparented = yield* Effect.exit(
          store.put(node("b"), history("one", "two"))
        )
        assert.strictEqual(reparented._tag, "Failure")

        // Illegal: a different conversation under a familiar id.
        const rewritten = yield* Effect.exit(
          store.put(node("b", "a"), history("one", "different"))
        )
        assert.strictEqual(rewritten._tag, "Failure")

        // And nothing was damaged on the way through.
        assert.deepStrictEqual((yield* store.nodes).map((found) => found.id), ["a", "b"])
        assert.deepStrictEqual(
          (yield* store.children("a" as NodeStore.NodeId)).map((child) => child.id),
          ["b"]
        )
        const found = Option.getOrThrow(yield* store.get("b" as NodeStore.NodeId))
        assert.strictEqual(Option.getOrThrow(found.node.label), "kept")
        assert.strictEqual(textOf(found.history), textOf(history("one", "two")))
      }))

    /**
     * R43 -- concurrent writes leave one consistent store.
     *
     * The memory store read "does this id exist" and then appended to a
     * separate order `Ref`, so two puts of one id could both see absence and
     * both append. The key-value adapter's index append is a
     * read-modify-write with no lock, so two puts of *different* nodes could
     * each read the same list and each write back only their own id -- a node
     * still stored and no longer reachable.
     *
     * Twenty at once, half of them the same id: an id appears once, every
     * distinct node is listed, and the indexes agree with `get`.
     */
    it.effect("concurrent puts leave every node listed exactly once", () =>
      Effect.gen(function*() {
        const store = yield* makeStore
        yield* store.put(node("root"), history("root"))

        const writes = Array.from({ length: 10 }, (_, index) => index).flatMap(
          (index) => [
            store.put(node(`n${index}`, "root"), history("root", `n${index}`)),
            // The same node again, as a mark: a re-put must not duplicate it.
            store.put(
              node(`n${index}`, "root", { label: `l${index}` }),
              history("root", `n${index}`)
            )
          ]
        )
        yield* Effect.all(writes, { concurrency: "unbounded" })

        const all = yield* store.nodes
        const ids = all.map((found) => found.id)
        assert.strictEqual(new Set(ids).size, ids.length, "an id was listed twice")
        assert.strictEqual(ids.length, 11, "a node was lost from the order index")

        const children = (yield* store.children("root" as NodeStore.NodeId)).map((c) => c.id)
        assert.strictEqual(new Set(children).size, children.length)
        assert.strictEqual(children.length, 10, "a node was lost from the children index")

        // Every listed node is really there.
        for (const id of ids) {
          assert.isTrue(Option.isSome(yield* store.get(id)), `${id} is indexed but not stored`)
        }
      }))

    it.effect("an empty store answers rather than failing", () =>
      Effect.gen(function*() {
        const store = yield* makeStore
        assert.deepStrictEqual(yield* store.nodes, [])
        assert.deepStrictEqual(yield* store.roots, [])
        assert.deepStrictEqual(yield* store.children("a" as NodeStore.NodeId), [])
      }))

    it.effect("stores are independent of one another", () =>
      Effect.gen(function*() {
        const one = yield* makeStore
        const two = yield* makeStore
        yield* one.put(node("a"), history("mine"))
        // Two trees in one process must not see each other's nodes; for a
        // shared backing that is what the namespace is for.
        assert.deepStrictEqual(yield* two.nodes, [])
      }))
  })
