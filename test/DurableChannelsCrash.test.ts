import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Crypto, Deferred, Duration, Effect, Exit, Layer, Ref, Schema } from "effect"
import type { Scope } from "effect"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import { SqlClient } from "effect/unstable/sql"
import { DurableDeferred } from "effect/unstable/workflow"
import * as NodeCrypto from "node:crypto"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as ContextTransform from "../src/ContextTransform.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import { Failpoint } from "../src/internal/failpoint.js"
import * as FakeModel from "./FakeModel.js"

/**
 * A process that dies inside a drain (item 120).
 *
 * A drain is an activity whose `execute` takes the channel's rows out of the
 * store. The store commits that take in its own transaction; the engine
 * journals the activity's result afterwards. A process lost between the two
 * leaves the rows gone and the result unrecorded, and the replacement's
 * re-execution takes again -- from a store that no longer holds them.
 */

const Gate = DurableDeferred.make("ChannelsCrashGate", { success: Schema.String })

const CryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(NodeCrypto.randomBytes(size)),
    digest: (algorithm, data) =>
      Effect.sync(() => new Uint8Array(NodeCrypto.createHash(algorithm.toLowerCase().replace("-", "")).update(data).digest()))
  })
)

const engineFor = (file: string) =>
  ClusterWorkflowEngine.layer.pipe(
    Layer.provide(
      SingleRunner.layer({
        runnerStorage: "sql",
        shardingConfig: { shardLockExpiration: Duration.seconds(1), shardLockRefreshInterval: Duration.millis(200) }
      }).pipe(Layer.provide(SqliteClient.layer({ filename: file })), Layer.provide(CryptoLayer))
    )
  )

const tempDatabase = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "channels-crash-")), "workflow.db")),
  (file) =>
    Effect.sync(() => {
      try {
        NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
      } catch {
        // Still held open on Windows.
      }
    })
)

describe("a process that dies inside a drain", () => {
  it.live("a steer the store gave up before the process died still reaches the model", () =>
    Effect.gen(function*() {
      const file = yield* tempDatabase
      const SESSION = "drain-crash"
      const gateReady = yield* Deferred.make<DurableDeferred.Token>()
      const parked = yield* Deferred.make<void>()
      const suspendOnce = yield* Ref.make(true)
      const turns = yield* Ref.make(0)

      // Suspends before turn 2, so the steer is queued while nothing drains.
      const gating = ContextTransform.make((context) =>
        Effect.gen(function*() {
          const turn = yield* Ref.updateAndGet(turns, (n) => n + 1)
          if (turn === 2 && (yield* Ref.getAndSet(suspendOnce, false))) {
            yield* Deferred.succeed(gateReady, yield* DurableDeferred.token(Gate))
            yield* DurableDeferred.await(Gate)
          }
          return context.prompt
        })
      )
      const agent = Agent.make({
        contextTransform: gating,
        loop: (state) => Effect.succeed(state.turnIndex < 3 ? AgentLoop.Continue : AgentLoop.Stop)
      })

      // A connection of the test's own, open for its whole scope: the store
      // outlives both runners, as a database outlives its processes.
      const connection = yield* Layer.build(SqliteClient.layer({ filename: file }))
      const store = yield* DurableChannels.sqlStoreWithTable().pipe(Effect.provide(connection))
      const durable = DurableAgent.workflow("DrainCrash", agent, { store })
      const turnsScript = [{ text: "one" }, { text: "two" }, { text: "three" }] as const

      // ---- Runner A: journal turn 1, queue a steer, die inside its drain ----
      const armed = yield* Ref.make(false)
      const executionId = yield* Effect.gen(function*() {
        const { layer: model } = yield* FakeModel.layer(turnsScript)
        // Parks -- the process's last act -- at the drain that took the steer:
        // the one after which the store no longer holds it.
        const failpoint = Layer.succeed(Failpoint, {
          hit: (location: string) =>
            Effect.gen(function*() {
              if (location !== DurableChannels.failpoints.qualified("after-take") || !(yield* Ref.get(armed))) return
              if ((yield* Effect.orDie(store.size(`${SESSION}:steering`))) > 0) return
              yield* Deferred.succeed(parked, undefined)
              return yield* Effect.never
            })
        })
        return yield* Effect.gen(function*() {
          const id = yield* DurableAgent.submit(durable, store, SESSION, "go")
          const token = yield* Deferred.await(gateReady)
          yield* Effect.orDie(DurableAgent.steer(store, SESSION, "stay on topic"))
          yield* Ref.set(armed, true)
          yield* DurableDeferred.succeed(Gate, { token, value: "go" })
          yield* Deferred.await(parked).pipe(Effect.timeout(Duration.seconds(20)), Effect.orDie)
          return id
        }).pipe(
          Effect.provide(
            durable.layer.pipe(Layer.provideMerge(engineFor(file)), Layer.provideMerge(model), Layer.provideMerge(failpoint))
          )
        )
      }).pipe(Effect.scoped)

      // Runner A is gone, mid-drain. Wait out its shard lock.
      yield* Effect.sleep(Duration.seconds(2))

      // ---- Runner B: the same database, no failpoint ------------------------
      const { layer: model, recorder } = yield* FakeModel.layer(turnsScript)
      const completed = yield* DurableAgent.result(durable, executionId, { interval: Duration.millis(50) }).pipe(
        Effect.timeout(Duration.seconds(20)),
        Effect.exit,
        Effect.provide(durable.layer.pipe(Layer.provideMerge(engineFor(file)), Layer.provideMerge(model)))
      )
      assert.isTrue(Exit.isSuccess(completed), `the replacement did not finish: ${JSON.stringify(completed)}`)

      const prompts = yield* recorder.prompts
      const steered = prompts.filter((prompt) => FakeModel.userTexts(prompt).includes("stay on topic"))
      assert.isAtLeast(steered.length, 1, "the steer the store gave up was lost with the process")
      // And applied once: the re-take under the same claim is the same take.
      const last = prompts[prompts.length - 1]!
      assert.strictEqual(FakeModel.userTexts(last).filter((text) => text === "stay on topic").length, 1)
    }).pipe(Effect.scoped), 60_000)
})

/** What a claim means, on both stores the module ships. */
const claims = (name: string, make: Effect.Effect<DurableChannels.Store, never, Scope.Scope>) =>
  describe(`${name}: a claimed take`, () => {
    it.effect("under the same claim returns the same rows; under another, the next ones", () =>
      Effect.gen(function*() {
        const store = yield* make
        yield* store.offer("k", "a")
        yield* store.offer("k", "b")
        assert.deepStrictEqual(yield* store.takeAll("k", "drain-0"), ["a", "b"])
        // Claimed rows are not waiting: nothing is pending, and the gate reads closed.
        assert.strictEqual(yield* store.size("k"), 0)
        yield* store.offer("k", "c")
        // The re-execution after a crash: the same rows, and what arrived since.
        assert.deepStrictEqual(yield* store.takeAll("k", "drain-0"), ["a", "b", "c"])
        yield* store.offer("k", "d")
        // The next drain: drain-0 was journalled, so its rows are gone.
        assert.deepStrictEqual(yield* store.takeAll("k", "drain-1"), ["d"])
        assert.deepStrictEqual(yield* store.takeAll("k", "drain-1"), ["d"])
        assert.deepStrictEqual(yield* store.takeAll("k", "drain-2"), [])
      }).pipe(Effect.scoped))

    it.effect("without a claim, a take deletes, as before", () =>
      Effect.gen(function*() {
        const store = yield* make
        yield* store.offer("k", "a")
        assert.deepStrictEqual(yield* store.takeAll("k"), ["a"])
        assert.deepStrictEqual(yield* store.takeAll("k"), [])
      }).pipe(Effect.scoped))
  })

/** A private in-memory database, open for the caller's scope. */
const inMemory = Effect.orDie(Layer.build(SqliteClient.layer({ filename: ":memory:" })))

claims("memoryStore", DurableChannels.memoryStore)
claims("sqlStore", Effect.flatMap(inMemory, (connection) => DurableChannels.sqlStoreWithTable().pipe(Effect.provide(connection))))

describe("the channel table a deployment provides", () => {
  it.effect("is the recorded shape: the claim column included (fixture)", () =>
    Effect.gen(function*() {
      const connection = yield* inMemory
      const columns = yield* Effect.gen(function*() {
        yield* DurableChannels.sqlStoreWithTable()
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly name: string; readonly type: string; readonly notnull: number; readonly pk: number }>`
          PRAGMA table_info(${sql.literal(DurableChannels.sqlStoreTable)})
        `
      }).pipe(Effect.provide(connection), Effect.orDie)
      const recorded = JSON.parse(NodeFs.readFileSync("test/fixtures/channel-input-table.json", "utf8"))
      assert.deepStrictEqual(
        { table: DurableChannels.sqlStoreTable, columns: columns.map(({ name, notnull, pk, type }) => ({ name, type, notnull, pk })) },
        recorded
      )
    }).pipe(Effect.scoped))
})

describe("a channel table from before claims", () => {
  it.effect("gains the column, keeps its rows, and they drain", () =>
    Effect.gen(function*() {
      const connection = yield* inMemory
      const store = yield* Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE ${sql.literal(DurableChannels.sqlStoreTable)} (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_key TEXT NOT NULL, value TEXT NOT NULL)`
        yield* sql`INSERT INTO ${sql.literal(DurableChannels.sqlStoreTable)} (channel_key, value) VALUES ('k', 'queued before the upgrade')`
        return yield* DurableChannels.sqlStoreWithTable()
      }).pipe(Effect.provide(connection), Effect.orDie)
      assert.strictEqual(yield* store.size("k"), 1)
      assert.deepStrictEqual(yield* store.takeAll("k", "drain-0"), ["queued before the upgrade"])
    }).pipe(Effect.scoped))
})
