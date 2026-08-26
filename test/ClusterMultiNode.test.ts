import { NodeHttpServer } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Cause, Crypto, Deferred, Duration, Effect, Exit, Layer, Option, Queue, Ref, Schedule, Schema, Scope } from "effect"
import {
  ClusterWorkflowEngine,
  HttpRunner,
  RunnerAddress,
  RunnerHealth,
  Runners,
  ShardingConfig,
  SqlMessageStorage,
  SqlRunnerStorage
} from "effect/unstable/cluster"
import { FetchHttpClient } from "effect/unstable/http"
import { Tool } from "effect/unstable/ai"
import { RpcSerialization } from "effect/unstable/rpc"
import { Workflow, WorkflowEngine } from "effect/unstable/workflow"
import { FastCheck } from "effect/testing"
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

type ActivityPhase = "before" | "after"
type CrashCommand = {
  readonly kind: "steer" | "followUp"
  readonly value: string
}
type CrashSchedule = {
  readonly position: number
  readonly commands: ReadonlyArray<CrashCommand>
  readonly extraResumes: number
}
type PropertyRequest = {
  readonly schedule: CrashSchedule
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
}

/** Decorate the real engine without changing the activity being executed. */
const aroundActivities = (
  onBoundary: (name: string, phase: ActivityPhase) => Effect.Effect<void>
) =>
  Layer.effect(
    WorkflowEngine.WorkflowEngine,
    Effect.map(WorkflowEngine.WorkflowEngine, (inner) => ({
      ...inner,
      activityExecute: (activity, attempt) =>
        onBoundary(activity.name, "before").pipe(
          Effect.andThen(inner.activityExecute(activity, attempt)),
          Effect.tap(() => onBoundary(activity.name, "after"))
        )
    }))
  )

/** Park the workflow at one exact journal boundary, as a lost process would. */
const suspendAtActivity = (
  position: number,
  completed: Ref.Ref<number>,
  reached: Deferred.Deferred<void>,
  names: Ref.Ref<ReadonlyArray<string>>
) =>
  Layer.effect(
    WorkflowEngine.WorkflowEngine,
    Effect.map(WorkflowEngine.WorkflowEngine, (inner) => ({
      ...inner,
      activityExecute: (activity, attempt) =>
        Effect.gen(function* () {
          yield* Ref.update(names, (all) => [...all, activity.name])
          if (position === 0 && (yield* Ref.get(completed)) === 0) {
            yield* Deferred.succeed(reached, void 0)
            return new Workflow.Suspended({})
          }
          const result = yield* inner.activityExecute(activity, attempt)
          if (result._tag !== "Complete") return result
          const count = yield* Ref.updateAndGet(completed, (n) => n + 1)
          if (count !== position) return result
          yield* Deferred.succeed(reached, void 0)
          return new Workflow.Suspended({})
        })
    }))
  )

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
 * The layer cycle is the non-obvious part of the fixture:
 *
 *   - `RunnerHealth.layerPing` needs `Runners` and `layerHttp` needs
 *     `RunnerHealth`. Building ping through `layerHttpClientOnly` looks like it
 *     breaks the cycle, but that layer also builds a second `Sharding` runtime;
 *     the nested runtime never becomes operational and the serving one remains
 *     unassigned. Health instead gets the lower-level `Runners.layerRpc`, which
 *     can dial peers without constructing sharding.
 *   - `ClusterWorkflowEngine.layer` requires `MessageStorage` in its own
 *     right, not only through the runners, so the storage is merged rather
 *     than provided inward.
 *   - Every node must register the workflow. A shard belongs to whichever
 *     runner owns it, so a submission made on one node may be run on another,
 *     and a peer with an engine but no handler leaves it pending forever.
 * With short test intervals a two-node cluster forms and executes in about a
 * second. The second test kills the owner after the model activity has started,
 * proving the case `SingleRunner` cannot represent.
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

let nextRunnerPort = 3930
const runnerPorts = () => {
  const owner = nextRunnerPort
  nextRunnerPort += 2
  return { owner, peer: owner + 1 }
}

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
    shardLockRefreshInterval: Duration.millis(200),
    entityMessagePollInterval: Duration.millis(50),
    entityReplyPollInterval: Duration.millis(25),
    entityTerminationTimeout: Duration.seconds(2),
    refreshAssignmentsInterval: Duration.millis(50),
    runnerHealthCheckInterval: Duration.millis(100),
    sendRetryInterval: Duration.millis(10),
    shardsPerGroup: 16
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
   * `Runners.layerRpc` is the way out: it needs the wire protocol and message
   * storage, but not `Sharding` or `RunnerHealth`. Pinging is exactly dial and
   * see, so health is built on that lower-level client and the serving layer is
   * built on health.
   */
  const clientProtocol = HttpRunner.layerClientProtocolHttpDefault.pipe(
    Layer.provide([serialization, FetchHttpClient.layer])
  )
  const pingRunners = Runners.layerRpc.pipe(
    Layer.provide([config, clientProtocol, storage[0]])
  )
  const health = RunnerHealth.layerPing.pipe(Layer.provide(pingRunners))

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
        gracefulShutdownTimeout: Duration.millis(50)
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
  it.live("forms, and a submission dispatched on one node completes", () =>
    Effect.gen(function* () {
      const file = yield* tempDatabase
      const ports = runnerPorts()
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
      const node = (port: number) =>
        durable.layer.pipe(
          Layer.provideMerge(runner(file, port))
        )
      const peer = node(ports.peer).pipe(Layer.provideMerge(peerModel))
      const local = node(ports.owner).pipe(Layer.provideMerge(model))

      yield* Effect.gen(function* () {
        yield* Layer.build(peer)
        const answer = yield* Effect.gen(function* () {
          const executionId = yield* DurableAgent.submit(durable, store, "multi-1", "go")
          return yield* DurableAgent.result(durable, executionId)
        }).pipe(Effect.provide(local))
        assert.include(String(answer), "done")
      }).pipe(Effect.scoped)
    }), 15_000
  )

  it.live("a peer takes over a submission whose owner is lost mid-activity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* tempDatabase
        const ports = runnerPorts()
        const store = yield* DurableChannels.memoryStore
        const started = yield* Deferred.make<void>()
        const agent = Agent.make({ loop: AgentLoop.bounded(2) })
        const durable = DurableAgent.workflow("MultiNodeFailover", agent, { store })
        const ownerModel = yield* FakeModel.layer([{ started, hang: true }])
        const peerModel = yield* FakeModel.layer([{ text: "recovered" }])

        const node = (port: number) =>
          durable.layer.pipe(
            Layer.provideMerge(runner(file, port))
          )

        const ownerScope = yield* Scope.make()
        const peerScope = yield* Scope.make()
        yield* Effect.addFinalizer(() =>
          Effect.all([
            Scope.close(ownerScope, Exit.void),
            Scope.close(peerScope, Exit.void)
          ], { discard: true })
        )

        const owner = yield* Layer.buildWithScope(
          node(ports.owner).pipe(Layer.provideMerge(ownerModel.layer)),
          ownerScope
        )
        const executionId = yield* DurableAgent.submit(
          durable,
          store,
          "multi-failover",
          "go"
        ).pipe(Effect.provide(owner))
        yield* Deferred.await(started)

        const peer = yield* Layer.buildWithScope(
          node(ports.peer).pipe(Layer.provideMerge(peerModel.layer)),
          peerScope
        )

        // This scope is the runner process. Closing it while the model
        // activity is in flight removes the owner and interrupts the activity;
        // the peer must acquire the shard and redeliver the durable request.
        yield* Scope.close(ownerScope, Exit.void)

        const answer = yield* DurableAgent.result(durable, executionId, {
          interval: Duration.millis(25)
        }).pipe(Effect.provide(peer))

        assert.include(String(answer), "recovered")
        assert.strictEqual(yield* ownerModel.recorder.calls, 1)
        assert.strictEqual(yield* peerModel.recorder.calls, 1)
      })
    ), 20_000
  )

  it.live("recovers D1-D4 before the first and after every completed activity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const run = Effect.fn("ClusterMultiNode.crashPoint")(function* (
          position: number,
          collectOnly: boolean,
          commands: ReadonlyArray<CrashCommand> = [],
          extraResumes = 0
        ) {
          const followUpCount = commands.filter((command) =>
            command.kind === "followUp").length
          const scriptedTurns = [
            {
              toolCalls: [{ id: "refund-1", name: "refund", params: { amount: "500" } }]
            },
            ...Array.from({ length: followUpCount + 1 }, () => ({ text: "settled" }))
          ] satisfies ReadonlyArray<FakeModel.Turn>
          const file = yield* tempDatabase
          const ports = runnerPorts()
          const store = yield* DurableChannels.memoryStore
          const toolCalls = yield* Ref.make(0)
          const completed = yield* Ref.make(0)
          const names = yield* Ref.make<ReadonlyArray<string>>([])
          const accepted = yield* Ref.make<ReadonlyArray<CrashCommand>>([])
          const crashReached = yield* Deferred.make<void>()

          const Refund = Tool.make("refund", {
            parameters: Schema.Struct({ amount: Schema.String }),
            success: Schema.String
          })
          const toolkit = yield* Agent.toolkit(
            [Refund],
            {
              refund: ({ amount }) =>
                Ref.update(toolCalls, (n) => n + 1).pipe(
                  Effect.as(`refunded ${amount}`)
                )
            }
          )
          const agent = Agent.make({ toolkit, loop: AgentLoop.bounded(4) })
          const durable = DurableAgent.workflow("CrashSweep", agent, { store, toolkit })
          const ownerModel = yield* FakeModel.layer(scriptedTurns)

          const observer = collectOnly
            ? aroundActivities((name, phase) =>
                phase === "before"
                  ? Ref.update(names, (all) => [...all, name])
                  : Effect.void
              )
            : suspendAtActivity(position, completed, crashReached, names)

          const ownerScope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void))
          const owner = yield* Layer.buildWithScope(
            durable.layer.pipe(
              Layer.provideMerge(observer),
              Layer.provideMerge(runner(file, ports.owner)),
              Layer.provideMerge(ownerModel.layer)
            ),
            ownerScope
          )

          const executionId = yield* DurableAgent.submit(
            durable,
            store,
            `crash-${position}`,
            "refund it"
          ).pipe(Effect.provide(owner))

          if (collectOnly) {
            const answer = yield* DurableAgent.result(durable, executionId).pipe(
              Effect.provide(owner)
            )
            assert.include(String(answer), "settled")
            assert.strictEqual(yield* ownerModel.recorder.calls, 2)
            assert.strictEqual(yield* Ref.get(toolCalls), 1)
            const activityNames = yield* Ref.get(names)
            yield* Scope.close(ownerScope, Exit.void)
            return activityNames
          }

          yield* Deferred.await(crashReached)
          yield* Effect.repeat(durable.definition.poll(executionId), {
            until: (result) =>
              Option.isSome(result) && result.value._tag === "Suspended",
            schedule: Schedule.spaced(Duration.millis(10))
          }).pipe(Effect.provide(owner))
          for (const command of commands) {
            yield* (command.kind === "steer"
              ? DurableAgent.steer(store, `crash-${position}`, command.value)
              : DurableAgent.followUp(store, `crash-${position}`, command.value)).pipe(
                Effect.tap(() => Ref.update(accepted, (all) => [...all, command])),
                Effect.catchTag("AgentIdleError", () => Effect.void)
              )
          }
          yield* Scope.close(ownerScope, Exit.void)
          const ownerCalls = yield* ownerModel.recorder.calls
          const peerModel = yield* FakeModel.layer(scriptedTurns.slice(ownerCalls))
          const peerScope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(peerScope, Exit.void))
          const peer = yield* Layer.buildWithScope(
            durable.layer.pipe(
              Layer.provideMerge(
                aroundActivities((name, phase) =>
                  phase === "before"
                    ? Ref.update(names, (all) => [...all, name])
                    : Effect.void
                )
              ),
              Layer.provideMerge(runner(file, ports.peer)),
              Layer.provideMerge(peerModel.layer)
            ),
            peerScope
          )
          for (let resume = 0; resume <= extraResumes; resume++) {
            yield* durable.definition.resume(executionId).pipe(Effect.provide(peer))
          }

          const answer = yield* DurableAgent.result(durable, executionId, {
            interval: Duration.millis(25)
          }).pipe(Effect.provide(peer))

          assert.include(String(answer), "settled")
          const activityNames = yield* Ref.get(names)
          const modelActivities = new Set(
            activityNames.filter((name) => /(^|\/)model-\d+$/.test(name))
          ).size
          assert.strictEqual(
            ownerCalls + (yield* peerModel.recorder.calls),
            modelActivities
          )
          assert.strictEqual(yield* Ref.get(toolCalls), 1)
          const prompts = [
            ...(yield* ownerModel.recorder.prompts),
            ...(yield* peerModel.recorder.prompts)
          ].flatMap(FakeModel.userTexts)
          for (const command of yield* Ref.get(accepted)) {
            assert.include(
              prompts,
              command.value,
              `activity sequence: ${activityNames.join(", ")}`
            )
          }
          yield* Scope.close(peerScope, Exit.void)
          return []
        })

        const boundaries = yield* run(-1, true)
        assert.isAbove(boundaries.length, 0)

        // N activities have N+1 places to lose the owner: before the first,
        // and immediately after each completed activity. The census is
        // discovered from the representative run, so a newly-added boundary
        // automatically becomes another crash scenario.
        for (let position = 0; position <= boundaries.length; position++) {
          yield* run(position, false)
        }

        // FastCheck originally shrank to this schedule: suspension after the
        // fifth completed activity, then one steer. Session release consumed
        // that accepted steer as cleanup before the peer rebuilt the run.
        // Keep the minimized counterexample independent of the generator.
        yield* run(5, false, [
          { kind: "steer", value: "check the ledger" }
        ])

        const command = FastCheck.record({
          kind: FastCheck.constantFrom<CrashCommand["kind"]>("steer", "followUp"),
          value: FastCheck.constantFrom(
            "check the ledger",
            "notify support",
            "include the receipt"
          )
        })
        const schedule = FastCheck.record({
          position: FastCheck.integer({ min: 0, max: boundaries.length }),
          commands: FastCheck.array(command, { maxLength: 3 }),
          extraResumes: FastCheck.integer({ min: 0, max: 2 })
        })

        // The seed is part of the regression. FastCheck still shrinks a
        // failure to the smallest crash/input/resume schedule, while CI runs
        // the same schedules until a discovered counterexample is pinned as
        // an ordinary test.
        const requests = yield* Queue.unbounded<PropertyRequest>()
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.flatMap(Queue.take(requests), (request) =>
              Effect.flatMap(
                Effect.exit(
                  Effect.scoped(
                    run(
                      request.schedule.position,
                      false,
                      request.schedule.commands,
                      request.schedule.extraResumes
                    ).pipe(Effect.asVoid)
                  )
                ),
                (exit) =>
                  Effect.sync(() => {
                    if (Exit.isSuccess(exit)) request.resolve()
                    else request.reject(Cause.squash(exit.cause))
                  })
              )
            )
          )
        )
        yield* Effect.promise(() =>
          FastCheck.assert(
            FastCheck.asyncProperty(schedule, (generated) =>
              new Promise<void>((resolve, reject) =>
                void Queue.offerUnsafe(requests, {
                  schedule: generated,
                  resolve,
                  reject
                })
              )
            ),
            { seed: 0x5eed, numRuns: 8 }
          )
        )
      })
    ), 120_000
  )
})
