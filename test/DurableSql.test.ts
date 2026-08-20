import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Crypto, Deferred, Duration, Effect, Exit, Layer, Ref } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import { DurableDeferred } from "effect/unstable/workflow"
import { Schema } from "effect"
import * as NodeCrypto from "node:crypto"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as ContextTransform from "../src/ContextTransform.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as FakeModel from "./FakeModel.js"
import { countingModel } from "./helpers.js"

/**
 * WORKFLOW_CLUSTER_PLAN Phase 5 — production wiring on SQL storage.
 *
 * The other durable tests run on `TestRunner`, whose storage is in memory. Here
 * the workflow journal is a SQLite file written by `SingleRunner`, which is the
 * shape a single-node deployment actually uses.
 *
 * What this proves: a submission suspends and resumes against a real SQL
 * journal, and the persisted model result is replayed rather than re-issued.
 *
 * What it does not prove is recorded at the end of this file, and in the plan.
 */
const Gate = DurableDeferred.make("SqlGate", { success: Schema.String })
const LossGate = DurableDeferred.make("LossGate", { success: Schema.String })

/** Node's crypto, which `SingleRunner` needs for runner identity. */
const CryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(NodeCrypto.randomBytes(size)),
    digest: (algorithm, data) =>
      Effect.sync(
        () =>
          new Uint8Array(
            NodeCrypto.createHash(algorithm.toLowerCase().replace("-", ""))
              .update(data)
              .digest()
          )
      )
  })
)

/**
 * A runner over the given database.
 *
 * The shard lock TTL is the whole story for process loss. A runner holds its
 * shards under a lock with a default 35s expiration, so a replacement started
 * immediately after the first one disappears is correctly refused the shards —
 * that is the lock doing its job, not a failure. A replacement that starts
 * after the lock expires takes them over.
 *
 * Tests shorten the TTL rather than waiting 35 seconds; production should leave
 * it alone, since a short expiration risks two runners believing they own the
 * same shard during a network partition.
 */
const engineFor = (file: string, lockSeconds = 35) =>
  ClusterWorkflowEngine.layer.pipe(
    Layer.provide(
      SingleRunner.layer({
        runnerStorage: "sql",
        shardingConfig: {
          shardLockExpiration: Duration.seconds(lockSeconds),
          shardLockRefreshInterval: Duration.millis(200)
        }
      }).pipe(
        Layer.provide(SqliteClient.layer({ filename: file })),
        Layer.provide(CryptoLayer)
      )
    )
  )

const tempDatabase = Effect.acquireRelease(
  Effect.sync(() =>
    NodePath.join(
      NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "effect-agent-")),
      "workflow.db"
    )
  ),
  (file) =>
    Effect.sync(() => {
      try {
        NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
      } catch {
        // The database may still be held open; cleanup is best effort.
      }
    })
)

describe("durable submissions on SQL storage", () => {
  it.live("suspends and resumes against a SQLite-backed journal", () =>
    Effect.gen(function* () {
      const file = yield* tempDatabase

      const Engine = engineFor(file)

      const modelCalls = yield* Ref.make(0)
      const gateReady = yield* Deferred.make<DurableDeferred.Token>()
      const suspendOnce = yield* Ref.make(true)
      const turns = yield* Ref.make(0)

      // Suspend before turn 2, so turn 1's model result is already journalled.
      const gating = ContextTransform.make((context) =>
        Effect.gen(function* () {
            const turn = yield* Ref.updateAndGet(turns, (n) => n + 1)
            if (turn === 2 && (yield* Ref.getAndSet(suspendOnce, false))) {
              const token = yield* DurableDeferred.token(Gate)
              yield* Deferred.succeed(gateReady, token)
              yield* DurableDeferred.await(Gate)
            }
          return context.canonicalPrompt
        })
      )

      const store = yield* DurableChannels.memoryStore
      const Suspending = Agent.make({
        contextTransform: gating,
        loop: AgentLoop.make((state) =>
          Effect.succeed(
            state.turnIndex < 2 ? AgentLoop.Continue : AgentLoop.Stop
          )
        )
      })

      const { layer: baseModel } = yield* FakeModel.layer([
        { text: "first" },
        { text: "second" }
      ])
      const model = countingModel(baseModel, modelCalls)

      const durable = DurableAgent.workflow("SqlBacked", Suspending, { store })

      const completed = yield* Effect.gen(function* () {
        const executionId = yield* DurableAgent.submit(durable, store, "sql-1", "go")

        const token = yield* Deferred.await(gateReady)
        yield* DurableDeferred.succeed(Gate, { token, value: "resume" })

        return yield* DurableAgent.result(durable, executionId)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(model)
          )
        )
      )

      assert.isTrue(Exit.isSuccess(completed))

      // Turn 1's model call was journalled before the suspension and replayed
      // afterwards: two turns, two calls, not three.
      assert.strictEqual(
        yield* Ref.get(modelCalls),
        2,
        "the resumed turn must not re-issue turn 1"
      )

      // And the journal really is on disk.
      assert.isTrue(NodeFs.existsSync(file))
      assert.isAbove(NodeFs.statSync(file).size, 0)
    }).pipe(Effect.scoped) as Effect.Effect<void>
  )
})

describe("process loss", () => {
  it.live(
    "a submission resumes in a replacement runner after the first is lost",
    () =>
      Effect.gen(function* () {
        const file = yield* tempDatabase
        const modelCalls = yield* Ref.make(0)
        const gateReady = yield* Deferred.make<DurableDeferred.Token>()
        const suspendOnce = yield* Ref.make(true)
        const turns = yield* Ref.make(0)

        // Suspends before turn 2, so turn 1's model result is journalled to
        // SQLite while the first runner is still alive.
        const gating = ContextTransform.make((context) =>
          Effect.gen(function* () {
            const turn = yield* Ref.updateAndGet(turns, (n) => n + 1)
            if (turn === 2 && (yield* Ref.getAndSet(suspendOnce, false))) {
              const token = yield* DurableDeferred.token(LossGate)
              yield* Deferred.succeed(gateReady, token)
              yield* DurableDeferred.await(LossGate)
            }
            return context.prompt
          })
        )

        const store = yield* DurableChannels.memoryStore
        const agent = Agent.make({
          contextTransform: gating,
          // Forced to two turns: `bounded` would stop after turn 1 here,
          // because the scripted model returns text and no tool calls.
          loop: (state) =>
            Effect.succeed(
              state.turnIndex < 2 ? AgentLoop.Continue : AgentLoop.Stop
            )
        })
        const durable = DurableAgent.workflow("Lost", agent, { store })

        const modelFor = () =>
          Effect.map(
            FakeModel.layer([{ text: "first" }, { text: "second" }]),
            ({ layer }) => countingModel(layer, modelCalls)
          )

        // ---- Runner A: start, journal turn 1, then vanish ----------------
        const executionId = yield* Effect.gen(function* () {
          const model = yield* modelFor()
          return yield* Effect.gen(function* () {
            const id = yield* DurableAgent.submit(durable, store, "loss-1", "go")
            yield* Deferred.await(gateReady)
            // `gateReady` fires when the token is published, which is *before*
            // the workflow has journaled its suspension. Tearing the runner
            // down inside that window is not process loss — it interrupts a
            // live execution, and the engine records that as a terminal
            // failure. Let the suspension become durable first: that is the
            // state a lost process actually leaves behind.
            yield* Effect.sleep(Duration.millis(500))
            return id
          }).pipe(
            Effect.provide(
              durable.layer.pipe(
                Layer.provideMerge(engineFor(file, 1)),
                Layer.provideMerge(model)
              )
            )
          )
        })

        // Runner A is gone: its layers were released with the scope above.
        // Its shard lock outlives it, so wait for the lease to expire before a
        // replacement can claim the shards.
        yield* Effect.sleep(Duration.seconds(2))

        // ---- Runner B: a different runner over the same database ---------
        const completed = yield* Effect.gen(function* () {
          const model = yield* modelFor()
          return yield* Effect.gen(function* () {
            const token = yield* Deferred.await(gateReady)
            yield* DurableDeferred.succeed(LossGate, {
              token,
              value: "resume"
            })
            return yield* DurableAgent.result(durable, executionId, {
              interval: Duration.millis(50)
            })
          }).pipe(
            Effect.provide(
              durable.layer.pipe(
                Layer.provideMerge(engineFor(file, 1)),
                Layer.provideMerge(model)
              )
            )
          )
        })

        assert.isTrue(
          Exit.isSuccess(completed),
          `replacement runner did not finish the submission: ${JSON.stringify(completed)}`
        )

        // Turn 1 ran under runner A and was journalled; runner B replayed it
        // and only had to make turn 2's call. Three would mean the journal was
        // not consulted across the process boundary.
        assert.strictEqual(
          yield* Ref.get(modelCalls),
          2,
          "the replacement runner must not re-issue turn 1"
        )
      }).pipe(Effect.scoped) as Effect.Effect<void>,
    30_000
  )
})
