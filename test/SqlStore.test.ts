import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect } from "effect"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as DurableChannels from "../src/durable/DurableChannels.js"

/**
 * `memoryStore` is a map in one process, which under the cluster is silently
 * wrong rather than merely limited: a `steer` routed to one node is written to
 * that node's map and drained from the node that owns the session. Nothing
 * fails; the input disappears. `sqlStore` is what a real deployment uses, so
 * the properties callers depend on are pinned here against real SQLite.
 */
const tempDatabase = Effect.acquireRelease(
  Effect.sync(() =>
    NodePath.join(
      NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "agent-store-")),
      "store.db"
    )
  ),
  (file) =>
    Effect.sync(() => {
      NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
    })
)

const withStore = <A, E>(
  use: (store: DurableChannels.Store) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const file = yield* tempDatabase
    return yield* DurableChannels.sqlStoreWithTable().pipe(
      Effect.flatMap(use),
      Effect.provide(SqliteClient.layer({ filename: file }))
    )
  }).pipe(Effect.scoped)

describe("sqlStore", () => {
  it.effect("round-trips values and reports size", () =>
    withStore((store) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* store.size("s:followUps"), 0)
        yield* store.offer("s:followUps", "one")
        yield* store.offer("s:followUps", "two")
        assert.strictEqual(yield* store.size("s:followUps"), 2)

        assert.deepStrictEqual(yield* store.takeAll("s:followUps"), [
          "one",
          "two"
        ])
        // Draining empties it: a drained batch must never be handed out twice.
        assert.deepStrictEqual(yield* store.takeAll("s:followUps"), [])
        assert.strictEqual(yield* store.size("s:followUps"), 0)
      })
    )
  )

  it.effect("preserves the order values were offered in", () =>
    withStore((store) =>
      Effect.gen(function* () {
        // Callers depend on this: follow-ups run in the order they were
        // queued, and a reordering bug of exactly this kind turned A, B, C
        // into A, C, B once already.
        const values = Array.from({ length: 25 }, (_, i) => `v${i}`)
        yield* Effect.forEach(values, (value) =>
          store.offer("s:followUps", value)
        )
        assert.deepStrictEqual(yield* store.takeAll("s:followUps"), values)
      })
    )
  )

  it.effect("keeps channels and sessions apart", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.offer("a:steering", "for a")
        yield* store.offer("b:steering", "for b")
        yield* store.offer("a:followUps", "later")

        assert.deepStrictEqual(yield* store.takeAll("a:steering"), ["for a"])
        // Draining one key leaves the others untouched.
        assert.deepStrictEqual(yield* store.takeAll("b:steering"), ["for b"])
        assert.deepStrictEqual(yield* store.takeAll("a:followUps"), ["later"])
      })
    )
  )

  it.effect("a concurrent drain hands each value to exactly one caller", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const values = Array.from({ length: 40 }, (_, i) => `v${i}`)
        yield* Effect.forEach(values, (value) => store.offer("s:x", value))

        // A drain that read and then deleted in separate statements could hand
        // the same value to two callers, or lose one offered in between. The
        // transaction is what makes that impossible, and losing accepted input
        // is precisely what this module exists to prevent.
        const batches = yield* Effect.all(
          [store.takeAll("s:x"), store.takeAll("s:x"), store.takeAll("s:x")],
          { concurrency: "unbounded" }
        )
        const seen = batches.flat()
        assert.deepStrictEqual([...seen].sort(), [...values].sort())
        assert.strictEqual(new Set(seen).size, values.length)
        assert.strictEqual(yield* store.size("s:x"), 0)
      })
    )
  )

  it.effect("refuses a table name that is not a plain identifier", () =>
    Effect.gen(function* () {
      // The table name reaches `sql.literal`, which does not parameterise.
      // Refusing outright is the right answer: a table name from an untrusted
      // source is a bug, and quoting it would be pretending otherwise.
      const file = yield* tempDatabase
      const outcome = yield* DurableChannels.sqlStore({
        table: "x; DROP TABLE y"
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: file })),
        Effect.exit
      )
      assert.strictEqual(outcome._tag, "Failure")
    }).pipe(Effect.scoped)
  )
})
