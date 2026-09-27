import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect } from "effect"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import { turnFailpoints } from "../src/internal/turnFailpoints.js"
import { DurableEquivalence } from "../src/testing/index.js"

/**
 * Item 134: a store of your own, certified the way the shipped ones are.
 * `sweep` crashes the stock scenario at every in-turn boundary, over the
 * stores it is given, and compares each recovery with the straight run.
 */

const database = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "sweep-")), "agent.db")),
  (file) =>
    Effect.sync(() => {
      try {
        NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
      } catch {
        // Still held open on Windows.
      }
    })
).pipe(Effect.map((file) => SqliteClient.layer({ filename: file })))

/**
 * A delivery log that forgets what it was given: every append is new. A
 * replacement re-emitting a turn it replays then records it twice, which is
 * the failure the log's key exists to prevent.
 */
const forgetful = (log: DeliveryLog.DeliveryLog): DeliveryLog.DeliveryLog => {
  let n = 0
  return { ...log, append: (sessionId, key, envelope) => log.append(sessionId, `${key}#${++n}`, envelope) }
}

describe("DurableEquivalence.sweep (item 134)", () => {
  it.live("in-memory stores of one's own pass at every boundary", () =>
    Effect.gen(function*() {
      const { rows, straight } = yield* DurableEquivalence.sweep(DurableEquivalence.certification, {
        database,
        // A fresh backing per run, and one instance for both of its
        // processes: the backing two deployments share.
        stores: Effect.map(
          Effect.all({
            channels: DurableChannels.memoryStore,
            sessionStore: DurableSessionStore.memoryStore,
            delivery: DeliveryLog.memoryLog
          }),
          (stores) => () => Effect.succeed(stores)
        )
      })
      assert.deepStrictEqual(rows.map((row) => row.at), DurableEquivalence.boundaries)
      assert.deepStrictEqual(straight.effects, ["orders", "refunds"])
      for (const row of rows) {
        assert.isTrue(row.equivalent, `${row.at}: ${JSON.stringify(row.observation)}`)
      }
    }), 180_000)

  it.live("a delivery log that does not deduplicate is found", () =>
    Effect.gen(function*() {
      const { rows, straight } = yield* DurableEquivalence.sweep(DurableEquivalence.certification, {
        database,
        stores: Effect.map(
          Effect.all({ sessionStore: DurableSessionStore.memoryStore, delivery: Effect.map(DeliveryLog.memoryLog, forgetful) }),
          (stores) => () => Effect.succeed(stores)
        ),
        at: [turnFailpoints.qualified("after-commit")]
      })
      assert.strictEqual(rows.length, 1)
      assert.isFalse(rows[0]!.equivalent)
      assert.isAbove(rows[0]!.observation.events.length, straight.events.length)
    }), 120_000)
})
