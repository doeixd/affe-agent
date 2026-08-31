/**
 * Persisting a durable agent and resuming it in another process.
 *
 * The question this answers: *can a server agent's state be saved, and
 * picked up somewhere else?* Yes — and "somewhere else" is meant
 * literally here. Each act below builds its **own** client, its own
 * workflow engine and its own model, sharing nothing but a SQLite file.
 * Closing a scope is a process dying.
 *
 * Three claims, each asserted rather than printed:
 *
 * 1. **A conversation outlives the process that started it.** A second
 *    client reads the history the first one left and continues it.
 * 2. **A submission interrupted mid-flight is finished by whoever comes
 *    next.** No coordination, no handoff: the next process to hold the
 *    shard resumes the workflow from its journal.
 * 3. **Completed work is not repeated.** The model call the first
 *    process already made is replayed from the journal, not re-issued --
 *    which is the whole reason durability exists, since the alternative
 *    is paying for it twice and, for a tool, doing it twice.
 *
 * Everything durable is on SQLite: the workflow journal, the channels,
 * the session projection and the delivery log.
 *
 * Run: `npx tsx examples/durable-resume.ts`
 */

import { SqliteClient } from "@effect/sql-sqlite-node"
import {
  Console,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Layer,
  References,
  Schedule,
  Schema
} from "effect"
import { Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"

import { Agent, AgentLoop } from "@doeixd/effect-agent"
import { AgentClient } from "@doeixd/effect-agent/client"
import {
  DeliveryLog,
  DurableAgentClient,
  DurableChannels,
  DurableSessionStore
} from "@doeixd/effect-agent/durable"
import { TestLanguageModel } from "@doeixd/effect-agent/testing"

// ---------------------------------------------------------------------------
// The shared state: one file, and nothing else
// ---------------------------------------------------------------------------

const database = Effect.acquireRelease(
  Effect.sync(() =>
    NodePath.join(
      NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "durable-resume-")),
      "agent.db"
    )
  ),
  (file) =>
    Effect.sync(() => {
      NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
    })
)

/**
 * Runner identity needs a `Crypto`. Web Crypto is on every runtime this
 * library targets, so no `node:crypto` is involved.
 */
const CryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () =>
        new Uint8Array(
          await globalThis.crypto.subtle.digest(algorithm, data.slice().buffer)
        )
      )
  })
)

/**
 * A workflow engine over the database.
 *
 * The shard lock expires quickly here so a replacement can take over in
 * seconds rather than the production default. Leave that default alone
 * outside a demonstration: a short lock means a slow process can be
 * declared dead while it is merely busy.
 */
const engineFor = (file: string) =>
  ClusterWorkflowEngine.layer.pipe(
    Layer.provide(
      SingleRunner.layer({
        runnerStorage: "sql",
        shardingConfig: {
          shardLockExpiration: Duration.seconds(1),
          shardLockRefreshInterval: Duration.millis(200)
        }
      }).pipe(Layer.provide(SqliteClient.layer({ filename: file })), Layer.provide(CryptoLayer))
    )
  )

/**
 * One process: its own stores, engine, client and model, built into the
 * enclosing scope. Closing that scope is the process dying -- which is
 * how each act below "loses" a machine.
 */
const processOver = (
  file: string,
  agent: Agent.AgentDefinition<any, any, any>,
  turns: ReadonlyArray<TestLanguageModel.Turn>
) =>
  Effect.gen(function*() {
    const sql = yield* Layer.build(SqliteClient.layer({ filename: file }))
    const stores = yield* Effect.all({
      store: DurableChannels.sqlStoreWithTable(),
      sessionStore: DurableSessionStore.sqlStoreWithTables(),
      delivery: DeliveryLog.sqlLogWithTable()
    }).pipe(Effect.provide(sql))
    const { layer: model, recorder } = yield* TestLanguageModel.script(turns)
    const runtime = yield* Layer.build(
      DurableAgentClient.layer("ResumeExample", agent, {
        ...stores,
        pollInterval: Duration.millis(50)
      }).pipe(Layer.provideMerge(engineFor(file)), Layer.provideMerge(model))
    )
    const client = yield* Effect.service(AgentClient.AgentClient).pipe(Effect.provide(runtime))
    return { client, recorder }
  })

const SESSION = "invoice-run"

const expect = (claim: string, held: boolean) =>
  held ? Effect.void : Effect.die(new Error(`durable-resume: ${claim}`))

// ---------------------------------------------------------------------------

const program = Effect.gen(function*() {
  const file = yield* database

  // -- Act 1: a process starts a conversation, then dies -------------------
  yield* Console.log("--- process A: starts the conversation ---")
  const plain = Agent.make({ loop: AgentLoop.bounded(2) })

  yield* Effect.scoped(
    Effect.gen(function*() {
      const { client } = yield* processOver(file, plain, [
        TestLanguageModel.text("Invoice 41 is overdue.")
      ])
      const session = yield* client.createSession({ sessionId: SESSION })
      const first = yield* session.prompt("which invoice is overdue?")
      yield* Console.log(`A: ${first.text}`)
    })
  )
  // Scope closed: process A is gone, along with its client, its engine and
  // its model. Only the file remains.

  // -- Act 2: a different process picks the conversation up ----------------
  yield* Console.log("\n--- process B: a different client, same database ---")
  const continued = yield* Effect.scoped(
    Effect.gen(function*() {
      const { client } = yield* processOver(file, plain, [
        TestLanguageModel.text("It was invoice 41, as I said.")
      ])
      // Addressed by id. B never saw A, and holds no state of its own.
      const session = yield* client.session(SESSION)
      const history = yield* session.history
      const second = yield* session.prompt("remind me which one?")
      yield* Console.log(`B: ${second.text}`)
      return { history, text: second.text }
    })
  )

  yield* expect(
    "the conversation outlived the process that started it",
    JSON.stringify(continued.history.content).includes("Invoice 41 is overdue.")
  )

  // -- Act 3: a process dies mid-submission, another finishes it -----------
  yield* Console.log("\n--- process C: dies while a tool is running ---")
  const started = yield* Deferred.make<void>()

  const Settle = Tool.make("settle_invoice", {
    parameters: Schema.Struct({ id: Schema.Number }),
    success: Schema.String
  })

  // C's handler announces that it began, then never returns: the process
  // is lost with the submission in flight.
  const hanging = Agent.make({
    toolkit: Agent.toolkit([Settle], {
      settle_invoice: () => Effect.andThen(Deferred.succeed(started, undefined), Effect.never)
    }),
    loop: AgentLoop.bounded(3)
  })

  const submissionId = yield* Effect.scoped(
    Effect.gen(function*() {
      const { client, recorder } = yield* processOver(file, hanging, [
        TestLanguageModel.toolCall("settle_invoice", { id: 41 }, { id: "s1" }),
        TestLanguageModel.text("unreachable in this process")
      ])
      const session = yield* client.session(SESSION)
      // `submit` returns a receipt rather than waiting, which is what lets
      // this process walk away from work it has already accepted.
      const receipt = yield* session.submit("settle invoice 41")
      yield* Deferred.await(started)
      yield* Console.log(`C: accepted ${receipt.submissionId}, then died mid-tool`)
      yield* expect(
        "process C called the model once before dying",
        (yield* recorder.calls) === 1
      )
      return receipt.submissionId
    })
  )

  yield* Console.log("\n--- process D: finishes what C started ---")
  const finished = yield* Effect.scoped(
    Effect.gen(function*() {
      const settled = yield* Deferred.make<void>()
      const working = Agent.make({
        toolkit: Agent.toolkit([Settle], {
          settle_invoice: ({ id }) =>
            Effect.andThen(Deferred.succeed(settled, undefined), Effect.succeed(`settled ${id}`))
        }),
        loop: AgentLoop.bounded(3)
      })
      // D's script holds only the turn that has *not* happened yet. If the
      // journal were ignored and the run started over, D would be asked for
      // the first turn too -- and would answer with the wrong one.
      const { client, recorder } = yield* processOver(file, working, [
        TestLanguageModel.text("Invoice 41 is settled.")
      ])
      const session = yield* client.session(SESSION)
      const result = yield* session.awaitSubmission(submissionId).pipe(
        Effect.retry({
          schedule: Schedule.spaced(Duration.millis(100)),
          times: 100
        })
      )
      return { calls: yield* recorder.calls, result }
    })
  ).pipe(Effect.timeout(Duration.seconds(60)))

  yield* Console.log(`D: ${JSON.stringify(finished.result).slice(0, 120)}`)
  yield* expect(
    "a submission interrupted mid-flight was finished by the next process",
    JSON.stringify(finished.result).includes("settled")
  )
  yield* expect(
    "the model call process C already made was replayed, not re-issued",
    finished.calls === 1
  )

  yield* Console.log(
    "\nTwo processes, one database. The conversation, the submission and the" +
      "\njournalled work all crossed the gap; nothing completed was done twice."
  )
})

/**
 * Quietened on purpose. While process D waits to take over, the cluster
 * logs "No healthy runners available" until C's shard lock expires --
 * which is the takeover working, not a fault, and it drowns out the
 * three lines this example is actually about.
 */
void Effect.runPromise(
  Effect.scoped(program).pipe(Effect.provideService(References.MinimumLogLevel, "Error"))
).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
