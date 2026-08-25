import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import * as NodeStore from "../src/tree/NodeStore.js"
import { contract } from "./NodeStoreContract.js"

/**
 * Both implementations against one contract, plus what is true of only one.
 *
 * The key-value store is built over `KeyValueStore.layerMemory` here rather
 * than a real backing: what is under test is the *adapter* -- the indexes it
 * maintains, because a key-value interface cannot scan -- and that is the same
 * code whether the map is in memory, on disk, or in Postgres.
 */

contract("memory", NodeStore.memory)

const freshKv = KeyValueStore.KeyValueStore.use(Effect.succeed).pipe(
  Effect.provide(KeyValueStore.layerMemory)
)

const keyValueStore = Effect.map(freshKv, (kv) => NodeStore.keyValue(kv))

contract("key-value", keyValueStore)

describe("NodeStore, in memory", () => {
  it.effect("keeps the conversation it was given, object for object", () =>
    Effect.gen(function*() {
      const store = yield* NodeStore.memory
      const history = Prompt.fromMessages([
        Prompt.userMessage({ content: [Prompt.textPart({ text: "hello" })] })
      ])
      yield* store.put(
        {
          id: "a" as NodeStore.NodeId,
          parent: Option.none(),
          cause: "root",
          at: 0,
          label: Option.none()
        },
        history
      )
      const found = Option.getOrThrow(yield* store.get("a" as NodeStore.NodeId))

      /**
       * The *messages* by identity, which is the property that matters.
       *
       * This is the whole reason a separate in-memory store exists rather
       * than pointing the key-value one at a map: a prompt shares its message
       * objects with its parent's, so keeping those references costs a
       * pointer where encoding would deep-copy every conversation on every
       * write and throw the sharing away.
       *
       * The prompt *wrapper* is deliberately a new object: the store holds
       * its own message list so that a caller mutating the array it handed
       * over cannot rewrite a stored conversation. One array per node is not
       * the cost this store exists to avoid.
       */
      assert.strictEqual(found.history.content[0], history.content[0])
      assert.notStrictEqual(found.history.content, history.content)
    }))
})

describe("NodeStore, key-value", () => {

  /**
   * R43 -- the index append is a read-modify-write, so it needs a writer.
   *
   * The contract suite's concurrent case cannot show this: a memory-backed
   * `KeyValueStore` answers synchronously, so `Effect.all` runs the puts one
   * after another and there is no interleaving to lose anything in. Here every
   * read and write yields first, which is what any real backing does -- a
   * file, a socket, a database -- and two unserialised puts then read the same
   * order list and write back over each other.
   *
   * Falsified by removing the permit from `keyValue.put`: the second node
   * disappears from `nodes` while remaining perfectly retrievable by id, which
   * is the shape of the defect.
   */
  it.effect("interleaved writes do not lose a node from the index", () =>
    Effect.gen(function*() {
      const inner = yield* freshKv
      const slow = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.andThen(Effect.yieldNow, effect)
      const kv: KeyValueStore.KeyValueStore = {
        ...inner,
        get: (key) => slow(inner.get(key)),
        set: (key, value) => slow(inner.set(key, value))
      }
      const store = NodeStore.keyValue(kv)

      const node = (id: string): NodeStore.Node => ({
        id: id as NodeStore.NodeId,
        parent: Option.none(),
        cause: "root",
        at: 0,
        label: Option.none()
      })
      const history = Prompt.fromMessages([
        Prompt.userMessage({ content: [Prompt.textPart({ text: "x" })] })
      ])

      yield* Effect.all(
        [store.put(node("one"), history), store.put(node("two"), history)],
        { concurrency: "unbounded" }
      )

      const listed = (yield* store.nodes).map((found) => found.id).sort()
      assert.deepStrictEqual(listed, ["one", "two"])
      const roots = (yield* store.roots).map((found) => found.id).sort()
      assert.deepStrictEqual(roots, ["one", "two"])
    }))

  it.effect("namespaces let two trees share one backing", () =>
    Effect.gen(function*() {
      const kv = yield* freshKv
      const left = NodeStore.keyValue(kv, { prefix: "left" })
      const right = NodeStore.keyValue(kv, { prefix: "right" })

      const node = (id: string): NodeStore.Node => ({
        id: id as NodeStore.NodeId,
        parent: Option.none(),
        cause: "root",
        at: 0,
        label: Option.none()
      })
      const history = Prompt.fromMessages([
        Prompt.userMessage({ content: [Prompt.textPart({ text: "x" })] })
      ])

      // The same id in both, which is exactly what two trees numbering from
      // one produce. Without namespacing the second would overwrite the first.
      yield* left.put(node("node-1"), history)
      yield* right.put(node("node-1"), history)

      assert.strictEqual((yield* left.nodes).length, 1)
      assert.strictEqual((yield* right.nodes).length, 1)
      assert.isTrue(Option.isSome(yield* left.get("node-1" as NodeStore.NodeId)))
    }))

  it.effect("survives being rebuilt over the same backing", () =>
    Effect.gen(function*() {
      const kv = yield* freshKv
      const before = NodeStore.keyValue(kv)
      yield* before.put(
        {
          id: "a" as NodeStore.NodeId,
          parent: Option.none(),
          cause: "root",
          at: 42,
          label: Option.some("start")
        },
        Prompt.fromMessages([
          Prompt.userMessage({ content: [Prompt.textPart({ text: "remembered" })] })
        ])
      )

      // A second adapter over the same store, holding nothing of its own --
      // which is what a restart looks like from here. Everything answered
      // below comes off the backing, indexes included.
      const after = NodeStore.keyValue(kv)
      const found = Option.getOrThrow(yield* after.get("a" as NodeStore.NodeId))
      assert.strictEqual(found.node.at, 42)
      assert.strictEqual(Option.getOrThrow(found.node.label), "start")
      assert.strictEqual(found.history.content.length, 1)
      assert.deepStrictEqual((yield* after.roots).map((node) => node.id), ["a"])
      assert.deepStrictEqual((yield* after.nodes).map((node) => node.id), ["a"])
    }))
})
