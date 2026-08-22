import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Crypto, Duration, Effect, Layer, Ref, Schedule, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import * as NodeCrypto from "node:crypto"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as Permission from "../src/Permission.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { AgentClient } from "../src/client/index.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import * as FakeModel from "./FakeModel.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Permission decisions are part of what happened (#9). A runner dies with a
 * call parked on an `Ask`; the replacement runs a *stricter* policy. The
 * replay must see the decisions the first runner made -- the allowed call
 * that already ran stays run, the parked question stays the question that
 * was asked -- while anything *new* is decided by the policy now in force.
 *
 * Same fixture as `DurableAgentClientSql.test.ts`: SQLite for everything.
 */

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
 * A runner over the given database. The shard lock TTL is shortened so a
 * replacement can take over in seconds rather than the production 35s; see
 * `DurableSql.test.ts` for why production should leave it alone.
 */
const engineFor = (file: string, lockSeconds: number) =>
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
      NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "agent-client-sql-")),
      "agent.db"
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
 * One process: its own engine, its own client, its own model script. Built
 * into the enclosing scope, so closing that scope is the process dying.
 */
const process_ = (
  file: string,
  agent: Agent.AgentDefinition<any, any, any>,
  turns: ReadonlyArray<TestLanguageModel.Turn>
) =>
  Effect.gen(function* () {
    const sql = yield* Layer.build(SqliteClient.layer({ filename: file }))
    const stores = yield* Effect.all({
      store: DurableChannels.sqlStoreWithTable(),
      sessionStore: DurableSessionStore.sqlStoreWithTables(),
      delivery: DeliveryLog.sqlLogWithTable()
    }).pipe(Effect.provide(sql))
    const { layer: model, recorder } = yield* FakeModel.script(turns)
    const runtime = yield* Layer.build(
      DurableAgentClient.layer("SqlAgent", agent, {
        ...stores,
        pollInterval: Duration.millis(50)
      }).pipe(
        Layer.provideMerge(engineFor(file, 1)),
        Layer.provideMerge(model)
      )
    )
    const client = yield* Effect.service(AgentClient.AgentClient).pipe(
      Effect.provide(runtime)
    )
    return { ...stores, client, recorder }
  })

const until = <A, E>(
  observation: Effect.Effect<A, E>,
  predicate: (value: A) => boolean
): Effect.Effect<A, E> =>
  Effect.repeat(observation, {
    until: predicate,
    schedule: Schedule.spaced(Duration.millis(50))
  })


const Bash = Permission.annotate(
  Tool.make("bash", {
    parameters: Schema.Struct({ command: Schema.String }),
    success: Schema.String
  }),
  { action: "shell", resource: ({ command }) => command }
)

const agentWith = (
  policy: Permission.Policy,
  ran: Ref.Ref<Array<string>>
) =>
  Agent.make({
    toolkit: Agent.toolkit([Bash], {
      bash: ({ command }) =>
        Ref.update(ran, (all) => [...all, command]).pipe(Effect.as(`ran ${command}`))
    }),
    loop: AgentLoop.bounded(6),
    permission: policy,
    toolDenialPolicy: ToolExecution.ReturnToModel
  })

describe("DurablePermission on SQL storage", () => {
  it.live(
    "a replay after process loss keeps the decisions it made; new calls get the policy now in force",
    () =>
      Effect.gen(function* () {
        const file = yield* tempDatabase
        const ran = yield* Ref.make<Array<string>>([])

        // ---- Process A: lenient policy; `ls` allowed and run, `git push` parked
        const requestId = yield* Effect.gen(function* () {
          const lenient = Permission.rules(
            [{ action: "shell", resource: /^git push/, decision: Permission.ask("remote write") }],
            { otherwise: Permission.allow }
          )
          const a = yield* process_(file, agentWith(lenient, ran), [
            { toolCalls: [{ id: "c1", name: "bash", params: { command: "ls" } }] },
            { toolCalls: [{ id: "c2", name: "bash", params: { command: "git push" } }] }
          ])
          const session = yield* Effect.scoped(
            a.client.createSession({ sessionId: "repo-1" })
          )
          yield* Effect.forkDetach(session.prompt("ship it"))
          const waiting = yield* until(session.pending, (p) => p.length > 0)
          assert.deepStrictEqual(yield* Ref.get(ran), ["ls"])
          yield* Effect.sleep(Duration.millis(500))
          return waiting[0]!.id
        }).pipe(Effect.scoped)

        yield* Effect.sleep(Duration.seconds(2))

        // ---- Process B: everything denied from now on ----------------------
        yield* Effect.gen(function* () {
          const b = yield* process_(file, agentWith(Permission.denyAll, ran), [
            { text: "pushed" },
            { toolCalls: [{ id: "c3", name: "bash", params: { command: "ls" } }] },
            { text: "could not" }
          ])
          const session = yield* b.client.session("repo-1")
          assert.strictEqual(yield* session.status, "running")
          assert.deepStrictEqual(
            (yield* session.pending).map((r) => r.id),
            [requestId]
          )
          assert.isTrue(yield* session.respond({ id: requestId, granted: true }))
          assert.strictEqual(
            yield* until(session.status, (status) => status === "idle"),
            "idle"
          )
          // Turn 1's `ls` was journalled as Allow and its call as run: not
          // re-decided under denyAll, not re-run. The parked `git push` was
          // journalled as Ask, answered, and ran exactly once -- here, in B.
          assert.deepStrictEqual(yield* Ref.get(ran), ["ls", "git push"])
          const history = yield* session.history
          assert.deepStrictEqual(
            history.content.map((m) => m.role),
            ["user", "assistant", "tool", "assistant", "tool", "assistant"]
          )
          const events = yield* b.delivery.read("repo-1")
          const tags = events.map((e) => e.event._tag)
          assert.strictEqual(tags.filter((t) => t === "ToolCallSucceeded").length, 2)
          assert.strictEqual(tags.filter((t) => t === "ToolCallFailed").length, 0)

          // A *new* call is decided by B's policy: denied, told to the model.
          const next = yield* session.prompt("list again")
          assert.strictEqual(next.text, "could not")
          assert.deepStrictEqual(yield* Ref.get(ran), ["ls", "git push"])
          const after = yield* b.delivery.read("repo-1")
          const denied = after.filter((e) => e.event._tag === "ToolCallFailed")
          assert.strictEqual(denied.length, 1)
          assert.isTrue(
            denied[0]!.event._tag === "ToolCallFailed" &&
              denied[0]!.event.failure.tag === "ToolPermissionDeniedError"
          )
        }).pipe(Effect.scoped)
      }).pipe(Effect.scoped),
    30_000
  )
})
