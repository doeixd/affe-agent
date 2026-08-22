import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Crypto, Duration, Effect, Layer, Ref, Schedule, Schema } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import * as NodeCrypto from "node:crypto"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient } from "../src/client/index.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import * as FakeModel from "./FakeModel.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * The headline claim of issue #5, made real: a runner dies mid-conversation
 * and a *different* runner, with a *different* `AgentClient` instance and
 * nothing in common but the database, reacquires the logical session and
 * carries it on.
 *
 * Everything durable is on SQLite here — the workflow journal (`SingleRunner`
 * with SQL runner storage), the channels, the session projection, and the
 * delivery log. The memory suite proves the semantics; this proves they do
 * not depend on process memory.
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

const Wipe = Tool.make("wipe", {
  parameters: Schema.Struct({}),
  success: Schema.String
}).setNeedsApproval(true)

describe("DurableAgentClient on SQL storage", () => {
  it.live(
    "a session parked for approval in a lost runner is answered and finished from another",
    () =>
      Effect.gen(function* () {
        const file = yield* tempDatabase
        const wiped = yield* Ref.make(0)
        const agent = Agent.make({
          instructions: "Ask before wiping.",
          toolkit: Agent.toolkit([Wipe], {
            wipe: () => Ref.update(wiped, (n) => n + 1).pipe(Effect.as("wiped"))
          }),
          loop: AgentLoop.bounded(4)
        })

        // ---- Process A: start the prompt, reach the approval, vanish --------
        const requestId = yield* Effect.gen(function* () {
          const a = yield* process_(file, agent, [
            { toolCalls: [{ id: "w1", name: "wipe", params: {} }] }
          ])
          const session = yield* Effect.scoped(
            a.client.createSession({ sessionId: "customer-123" })
          )
          yield* Effect.forkDetach(session.prompt("wipe it"))
          const waiting = yield* until(session.pending, (p) => p.length > 0)
          // The request is projected before the workflow suspends; give the
          // suspension itself time to reach the journal. Tearing the runner
          // down earlier interrupts a live execution rather than losing a
          // parked one, which is a different (and already tested) event.
          yield* Effect.sleep(Duration.millis(500))
          return waiting[0]!.id
        }).pipe(Effect.scoped)

        // Process A is gone; its shard lock outlives it briefly.
        yield* Effect.sleep(Duration.seconds(2))

        // ---- Process B: a different runner, a different client -------------
        yield* Effect.gen(function* () {
          const b = yield* process_(file, agent, [
            { text: "wiped, as asked" },
            { text: "and that too" }
          ])
          const session = yield* b.client.session("customer-123")

          // What A projected is what B sees: the session is still running,
          // still waiting on the same question.
          assert.strictEqual(yield* session.status, "running")
          assert.deepStrictEqual(
            (yield* session.pending).map((r) => [r.id, r.kind]),
            [[requestId, "tool-approval"]]
          )

          assert.isTrue(yield* session.respond({ id: requestId, granted: true }))
          assert.strictEqual(
            yield* until(session.status, (status) => status === "idle"),
            "idle"
          )

          // Turn 1 was journalled under A and replayed under B; the tool ran
          // once; B's model made only turn 2's call.
          assert.strictEqual(yield* Ref.get(wiped), 1)
          assert.strictEqual(yield* b.recorder.calls, 1)
          const history = yield* session.history
          assert.deepStrictEqual(
            history.content.map((m) => m.role),
            ["system", "user", "assistant", "tool", "assistant"]
          )

          // The conversation continues on the same logical session.
          const next = yield* session.prompt("now the other one")
          assert.strictEqual(next.text, "and that too")
          assert.deepStrictEqual(
            TestLanguageModel.userTexts(yield* session.history),
            ["wipe it", "now the other one"]
          )

          // Delivery survived the process boundary with one offset space and
          // nothing duplicated across the replay.
          const events = yield* b.delivery.read("customer-123")
          assert.deepStrictEqual(
            events.map((e) => e.sequence),
            events.map((_, i) => i + 1)
          )
          const tags = events.map((e) => e.event._tag)
          assert.strictEqual(tags.filter((t) => t === "ElicitationRequested").length, 1)
          assert.strictEqual(tags.filter((t) => t === "ElicitationResolved").length, 1)
          assert.strictEqual(tags.filter((t) => t === "ToolCallSucceeded").length, 1)
          assert.strictEqual(tags.filter((t) => t === "SubmissionCompleted").length, 2)
          assert.notInclude(tags, "SubmissionInterrupted")
        }).pipe(Effect.scoped)
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "a claim left undispatched by a lost process is carried out by the next one",
    () =>
      Effect.gen(function* () {
        const file = yield* tempDatabase
        const agent = Agent.make({ loop: AgentLoop.bounded(4) })

        // Process A: claims (the store records the request) and dies before
        // dispatching anything. Nothing ever reached an engine.
        yield* Effect.gen(function* () {
          const a = yield* process_(file, agent, [])
          yield* Effect.scoped(
            Effect.asVoid(a.client.createSession({ sessionId: "claimed" }))
          )
          const outcome = yield* a.sessionStore.claim("claimed", {
            prompt: Prompt.make("do it"),
            stream: false
          })
          assert.strictEqual(outcome._tag, "Claimed")
        }).pipe(Effect.scoped)

        yield* Effect.sleep(Duration.seconds(2))

        // Process B reacquires the session: the recorded claim is dispatched
        // exactly once, and the session settles.
        yield* Effect.gen(function* () {
          const b = yield* process_(file, agent, [{ text: "carried out" }])
          const session = yield* b.client.session("claimed")
          assert.strictEqual(
            yield* until(session.status, (status) => status === "idle"),
            "idle"
          )
          assert.deepStrictEqual(
            TestLanguageModel.userTexts(yield* session.history),
            ["do it"]
          )
          assert.strictEqual(
            (yield* session.history).content.map((m) => m.role).at(-1),
            "assistant"
          )
          // Reacquiring again dispatches nothing new.
          yield* b.client.session("claimed")
          yield* Effect.sleep(Duration.millis(300))
          assert.strictEqual(yield* b.recorder.calls, 1)
        }).pipe(Effect.scoped)
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "two processes racing for one idle session agree on a single winner",
    () =>
      Effect.gen(function* () {
        const file = yield* tempDatabase
        const agent = Agent.make({ loop: AgentLoop.bounded(4) })

        // Whichever runner owns the shard executes, so both carry the same
        // script; the claim race is between two clients over the same rows,
        // which is where SQL has to hold the invariant.
        const a = yield* process_(file, agent, [{ text: "won" }])
        const b = yield* process_(file, agent, [{ text: "won" }])
        yield* Effect.scoped(
          Effect.asVoid(a.client.createSession({ sessionId: "race" }))
        )

        const attempt = (client: AgentClient.Service) =>
          Effect.flatMap(client.session("race"), (session) =>
            Effect.result(session.prompt("go"))
          )
        const outcomes = yield* Effect.all([attempt(a.client), attempt(b.client)], {
          concurrency: "unbounded"
        })
        const accepted = outcomes.filter((o) => o._tag === "Success")
        const refused = outcomes.flatMap((o) =>
          o._tag === "Failure" ? [o.failure._tag] : []
        )
        assert.strictEqual(accepted.length, 1)
        assert.deepStrictEqual(refused, ["AgentBusyError"])
        assert.strictEqual(
          accepted[0]?._tag === "Success" ? accepted[0].success.text : "",
          "won"
        )

        const history = yield* Effect.flatMap(b.client.session("race"), (s) => s.history)
        assert.deepStrictEqual(
          history.content.map((m) => m.role),
          ["user", "assistant"]
        )
        // Once the session is idle it is reusable from either process, but
        // the race itself produced one submission.
        const record = yield* b.sessionStore.get("race")
        assert.strictEqual(record._tag === "Some" ? record.value.submissionCount : 0, 1)
      }).pipe(Effect.scoped),
    30_000
  )
})
