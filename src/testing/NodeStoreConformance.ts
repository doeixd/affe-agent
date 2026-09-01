import { Effect, Option, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import type * as NodeStore from "../tree/NodeStore.js"
import { checks, report, type Report } from "./internal/conformance.js"

/**
 * The conformance suite every `NodeStore` must pass.
 *
 * Two implementations ship for reasons that have nothing to do with each
 * other -- one keeps object identity because a tree that never leaves the
 * process should not pay to encode, the other survives a restart -- and the
 * whole risk of having two is that they quietly disagree. Written once, run
 * against both, and shipped so a third -- yours, over your own backing --
 * is held to the same answers.
 *
 * The store is deliberately *not* given a way to update or delete. An
 * ancestor never changes, so a tree only ever grows at its leaves; the one
 * exception is re-writing a node under its own id, which is a label being
 * applied to a node already there rather than a second node.
 *
 * Framework-agnostic, as `SandboxConformance` is: a case is a named Effect,
 * a runner wires them with one line each, and `run` reports.
 */

export class Failure extends Schema.TaggedError<Failure>()(
  "NodeStoreConformanceFailure",
  { case: Schema.String, detail: Schema.String }
) {
  override get message() {
    return `node store conformance: ${this.case}: ${this.detail}`
  }
}

export interface Case<E> {
  readonly name: string
  readonly run: Effect.Effect<void, Failure | E>
}

const { equal, that } = checks((name, detail) => new Failure({ case: name, detail }))

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

const nodeId = (id: string): NodeStore.NodeId => id as NodeStore.NodeId

const history = (...texts: ReadonlyArray<string>): Prompt.Prompt =>
  Prompt.fromMessages(
    texts.map((text) => Prompt.userMessage({ content: [Prompt.textPart({ text })] }))
  )

/** The encoded form, so conversations compare by content rather than identity. */
const textOf = (prompt: Prompt.Prompt): string =>
  JSON.stringify(Schema.encodeUnknownSync(Prompt.Prompt)(prompt))

const ids = (nodes: ReadonlyArray<NodeStore.Node>): ReadonlyArray<string> => nodes.map((n) => n.id)

/**
 * Every case, over a fresh store per case. `store` must yield an
 * *independent* store each time it is run -- the last case checks exactly
 * that -- so pass the constructor, not a store you already built.
 */
export const cases = <E, SE>(
  store: Effect.Effect<NodeStore.NodeStore<E>, SE>
): ReadonlyArray<Case<E | SE>> => {
  const make = (name: string, body: (store: NodeStore.NodeStore<E>) => Effect.Effect<void, Failure | E>): Case<E | SE> => ({
    name,
    run: Effect.flatMap(store, body)
  })
  return [
    make("a stored node reads back with its conversation", (store) =>
      Effect.gen(function* () {
        const name = "a stored node reads back with its conversation"
        yield* store.put(node("a"), history("first", "second"))
        const found = yield* store.get(nodeId("a"))
        yield* that(name)(Option.isSome(found), "the node was not found")
        const held = Option.getOrThrow(found)
        yield* equal(name)(held.node.id, "a", "id")
        yield* equal(name)(held.node.cause, "root", "cause")
        yield* that(name)(Option.isNone(held.node.parent), "a root has no parent")
        yield* equal(name)(textOf(held.history), textOf(history("first", "second")), "conversation")
      })),

    make("an absent node is None, not a failure", (store) =>
      Effect.gen(function* () {
        const name = "an absent node is None, not a failure"
        // A tree asks about nodes it may not have -- a stale id from a
        // client, a parent from a different tree. That is an answer.
        const found = yield* store.get(nodeId("nope"))
        yield* that(name)(Option.isNone(found), `expected None, got ${Option.isSome(found) ? "Some" : "None"}`)
      })),

    make("children are the nodes that name this one as parent", (store) =>
      Effect.gen(function* () {
        const name = "children are the nodes that name this one as parent"
        yield* store.put(node("a"), history("root"))
        yield* store.put(node("b", "a"), history("root", "left"))
        yield* store.put(node("c", "a"), history("root", "right"))
        yield* store.put(node("d", "b"), history("root", "left", "deeper"))
        yield* equal(name)(ids(yield* store.children(nodeId("a"))), ["b", "c"], "children of a")
        // Children, not descendants: `d` is below `a` but is not its child,
        // and a store that conflated them would make a fan look like a chain.
        yield* equal(name)(ids(yield* store.children(nodeId("b"))), ["d"], "children of b")
        yield* equal(name)(ids(yield* store.children(nodeId("d"))), [], "children of a leaf")
      })),

    make("roots are the parentless nodes", (store) =>
      Effect.gen(function* () {
        const name = "roots are the parentless nodes"
        yield* store.put(node("a"), history("one"))
        yield* store.put(node("b", "a"), history("one", "two"))
        // Two unrelated conversations in one store: representable, because a
        // tree records whatever sessions it is given.
        yield* store.put(node("z"), history("other"))
        yield* equal(name)(ids(yield* store.roots), ["a", "z"], "roots")
      })),

    make("nodes come back in the order they were stored", (store) =>
      Effect.gen(function* () {
        const name = "nodes come back in the order they were stored"
        for (const id of ["a", "b", "c"]) {
          yield* store.put(node(id, id === "a" ? undefined : "a"), history(id))
        }
        // Insertion order is the tree's chronology, and a renderer listing
        // branch points shows them in the order they happened.
        yield* equal(name)(ids(yield* store.nodes), ["a", "b", "c"], "order")
      })),

    make("re-storing an id replaces the node without duplicating it", (store) =>
      Effect.gen(function* () {
        const name = "re-storing an id replaces the node without duplicating it"
        yield* store.put(node("a"), history("one"))
        yield* store.put(node("b", "a"), history("one", "two"))
        // What `commit({ label })` does to an unchanged conversation: mark
        // the node that is already there.
        yield* store.put(node("b", "a", { label: "before refactor", cause: "manual" }), history("one", "two"))
        yield* equal(name)(ids(yield* store.nodes), ["a", "b"], "nodes")
        yield* equal(name)(ids(yield* store.children(nodeId("a"))), ["b"], "children of a")
        const found = Option.getOrThrow(yield* store.get(nodeId("b")))
        yield* equal(name)(Option.getOrThrow(found.node.label), "before refactor", "label")
        yield* equal(name)(found.node.cause, "manual", "cause")
      })),

    /**
     * A familiar id must not be a way to move an ancestor. `put` accepts an
     * id it has already seen because `commit` uses it to apply a label or a
     * cause; a different parent or a different conversation under that id
     * is two pieces of code disagreeing about what the id names, and is
     * refused as a defect rather than applied.
     */
    make("re-storing an id may change its mark, never its ancestry", (store) =>
      Effect.gen(function* () {
        const name = "re-storing an id may change its mark, never its ancestry"
        yield* store.put(node("a"), history("one"))
        yield* store.put(node("b", "a"), history("one", "two"))
        yield* store.put(node("b", "a", { label: "kept" }), history("one", "two"))

        const reparented = yield* Effect.exit(store.put(node("b"), history("one", "two")))
        yield* that(name)(reparented._tag === "Failure", "a different parent under a familiar id was accepted")
        const rewritten = yield* Effect.exit(store.put(node("b", "a"), history("one", "different")))
        yield* that(name)(rewritten._tag === "Failure", "a different conversation under a familiar id was accepted")

        yield* equal(name)(ids(yield* store.nodes), ["a", "b"], "nodes after the refusals")
        yield* equal(name)(ids(yield* store.children(nodeId("a"))), ["b"], "children after the refusals")
        const found = Option.getOrThrow(yield* store.get(nodeId("b")))
        yield* equal(name)(Option.getOrThrow(found.node.label), "kept", "label")
        yield* equal(name)(textOf(found.history), textOf(history("one", "two")), "conversation")
      })),

    /**
     * Concurrent writes leave one consistent store: twenty at once, half of
     * them the same id, and afterwards an id appears once, every distinct
     * node is listed, and the indexes agree with `get`.
     */
    make("concurrent puts leave every node listed exactly once", (store) =>
      Effect.gen(function* () {
        const name = "concurrent puts leave every node listed exactly once"
        yield* store.put(node("root"), history("root"))
        const writes = Array.from({ length: 10 }, (_, index) => index).flatMap((index) => [
          store.put(node(`n${index}`, "root"), history("root", `n${index}`)),
          store.put(node(`n${index}`, "root", { label: `l${index}` }), history("root", `n${index}`))
        ])
        yield* Effect.all(writes, { concurrency: "unbounded" })

        const all = ids(yield* store.nodes)
        yield* that(name)(new Set(all).size === all.length, "an id was listed twice")
        yield* that(name)(all.length === 11, `a node was lost from the order index: ${all.length} of 11`)
        const children = ids(yield* store.children(nodeId("root")))
        yield* that(name)(new Set(children).size === children.length, "a child was listed twice")
        yield* that(name)(children.length === 10, `a node was lost from the children index: ${children.length} of 10`)
        for (const id of all) {
          yield* that(name)(Option.isSome(yield* store.get(nodeId(id))), `${id} is indexed but not stored`)
        }
      })),

    make("an empty store answers rather than failing", (store) =>
      Effect.gen(function* () {
        const name = "an empty store answers rather than failing"
        yield* equal(name)(yield* store.nodes, [], "nodes")
        yield* equal(name)(yield* store.roots, [], "roots")
        yield* equal(name)(yield* store.children(nodeId("a")), [], "children")
      })),

    {
      name: "stores are independent of one another",
      run: Effect.gen(function* () {
        const name = "stores are independent of one another"
        const one = yield* store
        const two = yield* store
        yield* one.put(node("a"), history("mine"))
        // Two trees in one process must not see each other's nodes; for a
        // shared backing that is what the namespace is for.
        yield* equal(name)(yield* two.nodes, [], "the second store's nodes")
      })
    }
  ]
}

/** Every case against a store constructor, reported. Never fails. */
export const run = <E, SE>(
  store: Effect.Effect<NodeStore.NodeStore<E>, SE>
): Effect.Effect<Report> => report(cases(store))
