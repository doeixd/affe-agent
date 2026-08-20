import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Crypto, Deferred, Effect, Exit, Layer, Ref } from "effect"
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

      const Engine = ClusterWorkflowEngine.layer.pipe(
        Layer.provide(
          SingleRunner.layer({ runnerStorage: "sql" }).pipe(
            Layer.provide(SqliteClient.layer({ filename: file })),
            Layer.provide(CryptoLayer)
          )
        )
      )

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
        const executionId = yield* DurableAgent.submit(durable, "sql-1", "go")

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

/**
 * NOT covered here, and deliberately not faked.
 *
 * Tearing down the runner that started a suspended execution, then resuming
 * from a second independently built runner over the same SQLite file, records
 * the execution as `Complete` carrying an `EntityNotAssignedToRunner` defect:
 * the shard assignment is lost with the runner, so the execution is terminalised
 * rather than left resumable.
 *
 * A genuine process restart therefore needs shard reassignment on startup,
 * which is a deployment concern rather than something a test can stub. Until it
 * is demonstrated, "survives a process restart" stays unproven — see
 * WORKFLOW_CLUSTER_PLAN §5.4.
 */
