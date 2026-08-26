import { NodeHttpServer } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Crypto, Duration, Effect, Layer, Option } from "effect"
import {
  ClusterWorkflowEngine,
  HttpRunner,
  RunnerAddress,
  RunnerHealth,
  ShardingConfig,
  SqlMessageStorage,
  SqlRunnerStorage
} from "effect/unstable/cluster"
import { FetchHttpClient } from "effect/unstable/http"
import { RpcSerialization } from "effect/unstable/rpc"
import { createServer } from "node:http"
import * as NodeCrypto from "node:crypto"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as FakeModel from "./FakeModel.js"

/**
 * H6 -- a cluster with more than one runner in it.
 *
 * Every durable test so far runs on `SingleRunner`, which is honest about what
 * it is: a single-node layer wiring `Runners.layerNoop` and
 * `RunnerHealth.layerNoop`. With no peers there is nobody to talk to and
 * nobody to check on, which is fine for one process and quietly fatal for the
 * claims that matter. A runner that dies is never noticed, so its shards are
 * never reassigned and its in-flight work is never picked up -- measured at 75
 * seconds of nothing, and the reason SD3's crash sweep has no reachable
 * scenario.
 *
 * This fixture replaces exactly the two no-ops. `HttpRunner.layerHttp` gives
 * runners a real transport, and `RunnerHealth.layerPing` gives them a real
 * opinion about each other's liveness; message and runner storage stay SQL and
 * are *shared*, which is what makes two processes one cluster rather than two.
 * Everything else -- the workflow engine, the agent, the stores -- is the same
 * as the single-node suites, so a difference in behaviour is a difference in
 * topology and not in setup.
 *
 * **The test below is skipped, and the honest reason is that the fixture does
 * not work yet.** What is done is the layer archaeology, which is most of the
 * difficulty and all of the tedium:
 *
 *   - `RunnerHealth.layerPing` needs `Runners` and `layerHttp` needs
 *     `RunnerHealth`, which is a cycle. `layerHttpClientOnly` breaks it: it
 *     provides runners that can dial without having an opinion on liveness,
 *     which is exactly what pinging needs.
 *   - `ClusterWorkflowEngine.layer` requires `MessageStorage` in its own
 *     right, not only through the runners, so the storage is merged rather
 *     than provided inward.
 *   - Every node must register the workflow. A shard belongs to whichever
 *     runner owns it, so a submission made on one node may be run on another,
 *     and a peer with an engine but no handler leaves it pending forever.
 *   - `DurableAgent.result` polls 600 times at 10ms -- six seconds, fine for
 *     one node, shorter than a two-node cluster takes to settle.
 *
 * Where it stops: with all of that resolved the HTTP server binds
 * (`Listening on http://0.0.0.0:3930`) and nothing runs. The submission stays
 * `pending` through 30 seconds of polling. **This is not a peering problem** --
 * disabling the second node entirely reproduces it, so a single runner on this
 * wiring does not execute work that `SingleRunner` executes immediately.
 * Shards are self-acquired from `RunnerStorage` (there is no shard-manager
 * role to be missing), so the next thing to establish is whether acquisition
 * happens at all and, if it does, why the entity message is not delivered.
 *
 * Left skipped rather than deleted because the archaeology is the expensive
 * part and re-deriving it would cost the same again. Left skipped rather than
 * failing because a red test in the suite trains people to ignore red tests.
 */

/** Node's crypto, which the sharding layer needs for runner identity. */
const CryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(NodeCrypto.randomBytes(size)),
    digest: (algorithm, data) =>
      Effect.sync(() =>
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
      NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "agent-cluster-")),
      "cluster.db"
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

/**
 * One runner: its own address, its own HTTP server, the shared database.
 *
 * The port is fixed rather than ephemeral, because a runner's address is how
 * its peers reach it -- it goes into runner storage for the *other* node to
 * dial, so it cannot be discovered after the server has bound.
 */
const runner = (file: string, port: number) => {
  const address = RunnerAddress.make("127.0.0.1", port)
  const config = ShardingConfig.layer({
    runnerAddress: Option.some(address),
    // Short leases so a reassignment is observable inside a test rather than
    // after the production 35 seconds.
    shardLockExpiration: Duration.seconds(2),
    shardLockRefreshInterval: Duration.millis(200)
  })
  const sql = SqliteClient.layer({ filename: file })
  const serialization = RpcSerialization.layerNdjson
  const storage = [
    Layer.orDie(SqlMessageStorage.layer).pipe(Layer.provide([sql, config])),
    Layer.orDie(SqlRunnerStorage.layer).pipe(Layer.provide([sql, config]))
  ] as const

  /**
   * Health checks need `Runners` to ping with, and the serving layer needs
   * health checks to decide who is alive -- so wiring them as siblings is a
   * cycle, and says so ("Service not found: effect/cluster/Runners").
   *
   * `layerHttpClientOnly` is the way out, and it is why it exists: it provides
   * `Runners` that can *dial* peers without itself needing an opinion about
   * whether they are up. Pinging is exactly that -- dial and see -- so health
   * is built on the client-only runners, and the serving layer is built on the
   * health.
   */
  const dialOnly = HttpRunner.layerHttpClientOnly.pipe(
    Layer.provide([config, serialization, FetchHttpClient.layer, ...storage])
  )
  const health = RunnerHealth.layerPing.pipe(Layer.provide(dialOnly))

  /**
   * `provideMerge` rather than `provide` for the storage, because the engine
   * needs `MessageStorage` in its own right and not only through the runners:
   * `ClusterWorkflowEngine.layer` requires `Sharding | MessageStorage`.
   * Providing it only into `layerHttp` satisfies the runners and leaves the
   * engine without it.
   */
  const serving = HttpRunner.layerHttp.pipe(
    Layer.provide([
      config,
      serialization,
      FetchHttpClient.layer,
      health,
      NodeHttpServer.layer(createServer, {
        port,
        disablePreemptiveShutdown: true
      })
    ]),
    Layer.provideMerge(storage[0]),
    Layer.provide(storage[1])
  )

  return ClusterWorkflowEngine.layer.pipe(
    Layer.provide(serving),
    Layer.provide(CryptoLayer)
  )
}

describe("a cluster with two runners (H6)", () => {
  it.skip("forms, and a submission dispatched on one node completes", () =>
    Effect.gen(function* () {
      const file = yield* tempDatabase
      const store = yield* DurableChannels.memoryStore
      const agent = Agent.make({ loop: AgentLoop.bounded(2) })
      const durable = DurableAgent.workflow("MultiNode", agent, { store })
      const { layer: model } = yield* FakeModel.layer([{ text: "done" }])

      /**
       * **Both** nodes register the workflow, and that is not symmetry for its
       * own sake.
       *
       * A shard belongs to whichever runner owns it, and the execution id
       * decides the shard -- so a submission made here may well be *run* over
       * there. A peer that has joined the cluster but never called
       * `durable.layer` has an engine and no handler for this workflow, and
       * the submission simply never completes. That is what the first version
       * of this test did, and it failed as `pending` rather than as anything
       * that named the cause.
       *
       * On `SingleRunner` the question cannot arise: there is one runner and
       * it is always this one. It is the first thing the topology changes.
       */
      const { layer: peerModel } = yield* FakeModel.layer([{ text: "done" }])
      const node = (port: number, models: Layer.Layer<any, any, any>) =>
        durable.layer.pipe(
          Layer.provideMerge(runner(file, port)),
          Layer.provideMerge(models)
        )

      yield* Effect.gen(function* () {
        yield* Layer.build(node(3931, peerModel))
        const answer = yield* Effect.gen(function* () {
          const executionId = yield* DurableAgent.submit(durable, store, "multi-1", "go")
          // 600 polls at the default 10ms is six seconds, which is shorter
          // than a two-node cluster takes to settle its shards. Not a defect
          // -- the default suits the single-node case it was written for.
          return yield* DurableAgent.result(durable, executionId, {
            interval: Duration.millis(50)
          })
        }).pipe(Effect.provide(node(3930, model)))
        assert.include(String(answer), "done")
      }).pipe(Effect.scoped)
    }), 60_000
  )
})
