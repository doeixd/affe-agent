import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Scope } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import type { AgentEventEnvelope } from "../src/AgentEvent.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import * as Ids from "../src/internal/ids.js"

/**
 * The stores' atomicity claims, under the concurrency they were written for:
 * many writers at once, and -- for SQL -- writers on *separate connections*,
 * which is what two processes are. A single connection serialises
 * everything and proves nothing about the transactions.
 */

const tempDatabase = Effect.acquireRelease(
  Effect.sync(() =>
    NodePath.join(
      NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "agent-stores-")),
      "stores.db"
    )
  ),
  (file) =>
    Effect.sync(() => {
      NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
    })
)

const connection = (file: string) => Layer.build(SqliteClient.layer({ filename: file }))

const envelope = (sequence: number): AgentEventEnvelope => ({
  sessionId: Ids.sessionId("s"),
  submissionId: Option.some(Ids.submissionId("sub")),
  runId: Option.none(),
  turn: Option.none(),
  sequence,
  event: { _tag: "TurnStarted" }
})

describe("DeliveryLog under concurrent appends", () => {
  const contract = (
    name: string,
    makeLog: Effect.Effect<DeliveryLog.DeliveryLog, never, Scope.Scope>
  ) =>
    it.live(`${name}: N concurrent appends get N distinct contiguous offsets`, () =>
      Effect.gen(function* () {
        const log = yield* makeLog
        const outcomes = yield* Effect.forEach(
          Array.from({ length: 40 }, (_, i) => i),
          (i) => log.append("s", `k${i}`, envelope(i)),
          { concurrency: "unbounded" }
        )
        const sequences = outcomes.flatMap((o) => (o._tag === "Appended" ? [o.sequence] : []))
        assert.strictEqual(sequences.length, 40)
        assert.deepStrictEqual(
          [...sequences].sort((a, b) => a - b),
          Array.from({ length: 40 }, (_, i) => i + 1)
        )
        const stored = yield* log.read("s")
        assert.deepStrictEqual(stored.map((e) => e.sequence), Array.from({ length: 40 }, (_, i) => i + 1))
        // Every key landed exactly once.
        assert.strictEqual(new Set(stored.map((e) => e.sequence)).size, 40)
      }).pipe(Effect.scoped)
    )

  contract("memory", DeliveryLog.memoryLog)
  contract(
    "sqlite",
    Effect.gen(function* () {
      const file = yield* tempDatabase
      const sql = yield* connection(file)
      return yield* DeliveryLog.sqlLogWithTable().pipe(Effect.provide(sql))
    })
  )

  it.live("sqlite: two connections appending the same key agree on one row", () =>
    Effect.gen(function* () {
      const file = yield* tempDatabase
      const a = yield* DeliveryLog.sqlLogWithTable().pipe(Effect.provide(yield* connection(file)))
      const b = yield* DeliveryLog.sqlLogWithTable().pipe(Effect.provide(yield* connection(file)))
      // Two recorders (an old runner and its replacement) offer the same
      // event. One appends; the other sees a duplicate, never a second row
      // and never a unique-constraint death.
      const [first, second] = yield* Effect.all(
        [a.append("s", "same", envelope(1)), b.append("s", "same", envelope(1))],
        { concurrency: "unbounded" }
      )
      const tagsSeen = [first._tag, second._tag].sort()
      assert.deepStrictEqual(tagsSeen, ["Appended", "Duplicate"])
      assert.strictEqual((yield* a.read("s")).length, 1)
    }).pipe(Effect.scoped)
  )
})

describe("DurableSessionStore across connections", () => {
  it.live("sqlite: claims from two connections yield one Claimed and one Busy", () =>
    Effect.gen(function* () {
      const file = yield* tempDatabase
      const a = yield* DurableSessionStore.sqlStoreWithTables().pipe(
        Effect.provide(yield* connection(file))
      )
      const b = yield* DurableSessionStore.sqlStoreWithTables().pipe(
        Effect.provide(yield* connection(file))
      )
      yield* a.getOrCreate("race", Prompt.empty)
      const outcomes = yield* Effect.all(
        [
          a.claim("race", { prompt: Prompt.make("one"), stream: false }),
          b.claim("race", { prompt: Prompt.make("two"), stream: false })
        ],
        { concurrency: "unbounded" }
      )
      assert.deepStrictEqual(outcomes.map((o) => o._tag).sort(), ["Busy", "Claimed"])
      const record = yield* b.get("race")
      assert.strictEqual(record._tag === "Some" ? record.value.submissionCount : 0, 1)
    }).pipe(Effect.scoped)
  )

  it.live("sqlite: finish from the other connection sees the claim the first one took", () =>
    Effect.gen(function* () {
      const file = yield* tempDatabase
      const a = yield* DurableSessionStore.sqlStoreWithTables().pipe(
        Effect.provide(yield* connection(file))
      )
      const b = yield* DurableSessionStore.sqlStoreWithTables().pipe(
        Effect.provide(yield* connection(file))
      )
      yield* a.getOrCreate("hand-off", Prompt.empty)
      const claimed = yield* a.claim("hand-off", { prompt: Prompt.make("go"), stream: false })
      if (claimed._tag !== "Claimed") return assert.fail(claimed._tag)
      // A stale finish -- wrong submission -- is refused; the right one lands.
      assert.isFalse(yield* b.finish("hand-off", "not-this-one", Prompt.make("x")))
      assert.isTrue(yield* b.finish("hand-off", claimed.claim.submissionId, Prompt.make("x")))
      assert.isFalse(yield* b.finish("hand-off", claimed.claim.submissionId, Prompt.make("x")))
      const record = yield* a.get("hand-off")
      assert.strictEqual(record._tag === "Some" ? record.value.status : "", "idle")
    }).pipe(Effect.scoped)
  )
})

describe("DurableChannels admission across connections", () => {
  it.live("sqlite: offerIfOpen and the closing drain cannot both win", () =>
    Effect.gen(function* () {
      const file = yield* tempDatabase
      const sender = yield* DurableChannels.sqlStoreWithTable().pipe(
        Effect.provide(yield* connection(file))
      )
      const runner = yield* DurableChannels.sqlStoreWithTable().pipe(
        Effect.provide(yield* connection(file))
      )
      const gate = DurableChannels.openKey("s")
      yield* runner.offer(gate, "open")
      // Many senders race one closing drain (close the gate, then drain).
      // Every input the senders were told was admitted must be in the drain,
      // and nothing admitted may be left behind.
      const [admitted, drained] = yield* Effect.all(
        [
          Effect.forEach(
            Array.from({ length: 20 }, (_, i) => `in-${i}`),
            (input) =>
              Effect.map(sender.offerIfOpen("s:followUps", input, gate), (ok) =>
                ok ? [input] : []
              ),
            { concurrency: "unbounded" }
          ).pipe(Effect.map((all) => all.flat())),
          Effect.gen(function* () {
            yield* runner.takeAll(gate)
            return yield* runner.takeAll("s:followUps")
          })
        ],
        { concurrency: "unbounded" }
      )
      const left = yield* runner.takeAll("s:followUps")
      assert.deepStrictEqual(left, [], "admitted input left undrained")
      assert.deepStrictEqual([...drained].sort(), [...admitted].sort())
    }).pipe(Effect.scoped)
  )
})
