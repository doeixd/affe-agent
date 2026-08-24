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

      // Identity, not equality. This is the whole reason a separate in-memory
      // store exists rather than pointing the key-value one at a map: a prompt
      // shares its message objects with its parent's, so keeping the reference
      // costs a pointer where encoding would deep-copy every conversation on
      // every write and throw the sharing away.
      assert.strictEqual(found.history, history)
    }))
})

describe("NodeStore, key-value", () => {
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
