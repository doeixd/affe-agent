import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Crypto, Deferred, Duration, Effect, Layer, Ref, Schedule, Schema } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import * as NodeCrypto from "node:crypto"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as PromptWire from "../src/PromptWire.js"
import { AgentClient } from "../src/client/index.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import { Failpoint } from "../src/internal/failpoint.js"
import { turnFailpoints } from "../src/internal/turnFailpoints.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * The durability oracle (item 104): a run that crashed at a boundary and was
 * recovered by another process must be indistinguishable from a run that
 * never crashed.
 *
 * The existing crash tests compare narrower things -- a delivery log's rows,
 * the last prompt's texts, whether a tool ran once. A recovery that rebuilt a
 * slightly different conversation (a lost part, a reordered result, a field
 * spelled `[]` on one path and absent on the other) passes all of them. This
 * compares the thing itself: the canonical history, encoded as the wire
 * encodes it, and the result, and how many times the model and each tool
 * were actually called across both processes.
 *
 * A crash is real here, not simulated in-process: each process has its own
 * engine, client and model over one SQLite file, and the crashed one is
 * *parked* at the armed boundary and then has its scope closed -- which is
 * what a process dying there looks like to the journal. The next process takes
 * the shard over and must finish the submission. `AgentTurn`'s in-turn
 * boundaries (`internal/turnFailpoints.ts`) are the crash points; the
 * scripted model picks its turn by the conversation (`select: "history"`), so
 * the replacement answers the turn the run is actually at.
 */

const CryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(NodeCrypto.randomBytes(size)),
    digest: (algorithm, data) =>
      Effect.sync(() =>
        new Uint8Array(
          NodeCrypto.createHash(algorithm.toLowerCase().replace("-", "")).update(data).digest()
        )
      )
  })
)

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

const tempDatabase = Effect.acquireRelease(
  Effect.sync(() =>
    NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "equivalence-")), "agent.db")
  ),
  (file) =>
    Effect.sync(() => {
      try {
        NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
      } catch {
        // Still held open on Windows; best effort.
      }
    })
)

const Lookup = Tool.make("lookup", {
  parameters: Schema.Struct({ of: Schema.String }),
  success: Schema.String
})

/** Two lookups in one response, then an answer: a turn with work on both sides of every boundary. */
const script: ReadonlyArray<TestLanguageModel.Turn> = [
  {
    text: "Looking both up.",
    toolCalls: [
      { id: "l1", name: "lookup", params: { of: "orders" } },
      { id: "l2", name: "lookup", params: { of: "refunds" } }
    ]
  },
  { text: "Three orders, one refund." }
]

/** Handler runs by call subject, shared across every process of one scenario. */
const agentFor = (runs: Ref.Ref<ReadonlyArray<string>>) =>
  Agent.make({
    tools: [
      Agent.tool(Lookup, ({ of }) =>
        Effect.as(Ref.update(runs, (all) => [...all, of]), of === "orders" ? "3 orders" : "1 refund"))
    ],
    loop: AgentLoop.bounded(4)
  })

/**
 * One process over the database. With `park`, the armed boundary holds this
 * process there forever and reports that it arrived -- the scope closing
 * afterwards is the process dying at exactly that point.
 */
const processOver = (
  file: string,
  agent: Agent.AgentDefinition<any, any, any>,
  park?: { readonly location: string; readonly occurrence: number; readonly arrived: Deferred.Deferred<void> }
) =>
  Effect.gen(function*() {
    const sql = yield* Layer.build(SqliteClient.layer({ filename: file }))
    const stores = yield* Effect.all({
      store: DurableChannels.sqlStoreWithTable(),
      sessionStore: DurableSessionStore.sqlStoreWithTables(),
      delivery: DeliveryLog.sqlLogWithTable()
    }).pipe(Effect.provide(sql))
    const { layer: model, recorder } = yield* TestLanguageModel.script(script, { select: "history" })
    const reached = yield* Ref.make(0)
    const failpoint = Layer.succeed(Failpoint, {
      hit: (location: string) =>
        park === undefined || location !== park.location
          ? Effect.void
          : Effect.gen(function*() {
            const count = yield* Ref.updateAndGet(reached, (n) => n + 1)
            if (count !== park.occurrence) return
            yield* Deferred.succeed(park.arrived, undefined)
            return yield* Effect.never
          })
    })
    const runtime = yield* Layer.build(
      DurableAgentClient.layer("EquivalenceAgent", agent, {
        ...stores,
        pollInterval: Duration.millis(50)
      }).pipe(
        Layer.provideMerge(engineFor(file)),
        Layer.provideMerge(model),
        Layer.provideMerge(failpoint)
      )
    )
    const client = yield* Effect.service(AgentClient.AgentClient).pipe(Effect.provide(runtime))
    return { client, recorder }
  })

const SESSION = "equivalence"

/** What the oracle compares, normalised to what is meant to be deterministic. */
const observe = (
  history: Prompt.Prompt,
  result: { readonly status: string; readonly text: string; readonly turns: number },
  modelCalls: number,
  handlerRuns: ReadonlyArray<string>
) =>
  Effect.map(Schema.encodeEffect(PromptWire.Prompt)(history), (encoded) => ({
    history: encoded,
    status: result.status,
    text: result.text,
    turns: result.turns,
    modelCalls,
    // Sorted: two lookups run concurrently, so the order they *ran* in may
    // vary. The order their results were *committed* in is in `history`.
    handlerRuns: [...handlerRuns].sort()
  }))

type Observed = Effect.Success<ReturnType<typeof observe>>

/**
 * The uninterrupted run, once per mode: it is the same for every crash point,
 * and each run costs a real engine over a real database.
 */
const baselines = new Map<boolean, Observed>()
const baseline = (stream: boolean) =>
  Effect.suspend(() => {
    const known = baselines.get(stream)
    return known !== undefined
      ? Effect.succeed(known)
      : Effect.tap(straightRun(stream), (observed) => Effect.sync(() => baselines.set(stream, observed)))
  })

const straightRun = (stream: boolean) => Effect.scoped(
  Effect.gen(function*() {
    const file = yield* tempDatabase
    const runs = yield* Ref.make<ReadonlyArray<string>>([])
    const { client, recorder } = yield* processOver(file, agentFor(runs))
    const session = yield* client.createSession({ sessionId: SESSION })
    const result = yield* session.prompt("how many orders and refunds?", { stream })
    return yield* observe(yield* session.history, result, yield* recorder.calls, yield* Ref.get(runs))
  })
)

const crashedRun = (location: string, occurrence: number, stream: boolean) =>
  Effect.scoped(
    Effect.gen(function*() {
      const file = yield* tempDatabase
      const runs = yield* Ref.make<ReadonlyArray<string>>([])
      const arrived = yield* Deferred.make<void>()

      const { calls: firstCalls, submissionId } = yield* Effect.scoped(
        Effect.gen(function*() {
          const { client, recorder } = yield* processOver(file, agentFor(runs), { location, occurrence, arrived })
          const session = yield* client.createSession({ sessionId: SESSION })
          const receipt = yield* session.submit("how many orders and refunds?", { stream })
          // A boundary the run never reaches would leave this waiting, and a
          // crash nowhere is not a crash test: fail by name rather than pass.
          yield* Deferred.await(arrived).pipe(
            Effect.timeoutOrElse({
              duration: Duration.seconds(20),
              orElse: () => Effect.die(new Error(`the run never reached ${location} #${occurrence}`))
            })
          )
          return { calls: yield* recorder.calls, submissionId: receipt.submissionId }
        })
      )
      // That scope is closed: the first process died at the boundary.

      return yield* Effect.scoped(
        Effect.gen(function*() {
          const { client, recorder } = yield* processOver(file, agentFor(runs))
          const session = yield* client.session(SESSION)
          const result = yield* session.awaitSubmission(submissionId).pipe(
            Effect.retry({ schedule: Schedule.spaced(Duration.millis(100)), times: 200 })
          )
          const secondCalls = yield* recorder.calls
          const observed = yield* observe(
            yield* session.history,
            result,
            firstCalls + secondCalls,
            yield* Ref.get(runs)
          )
          return { observed, split: [firstCalls, secondCalls] as const }
        })
      )
    })
  )

describe("durable recovery is indistinguishable from never having crashed (item 104)", () => {
  /**
   * Each crash point, with the model calls each process should make: the
   * first process's calls are journalled before it dies, so the second must
   * make exactly the rest. A replacement that re-issued a journalled call, or
   * a "crash" that never stopped anything, shows up here before the history
   * comparison does.
   */
  const boundaries: ReadonlyArray<readonly [string, number, readonly [number, number]]> = [
    [turnFailpoints.qualified("after-model-response"), 1, [1, 1]],
    // The first of the turn's two calls has settled; the second may not have.
    [turnFailpoints.qualified("after-tool-call"), 1, [1, 1]],
    [turnFailpoints.qualified("before-commit"), 1, [1, 1]],
    [turnFailpoints.qualified("after-commit"), 1, [1, 1]],
    // The second turn's commit: both model calls are behind it.
    [turnFailpoints.qualified("after-commit"), 2, [2, 0]]
  ]

  it.live("every in-turn boundary is declared here, so a new one cannot go uncrashed", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        [...new Set(boundaries.map(([location]) => location))].sort(),
        [...turnFailpoints.all].sort()
      )
    }))

  /**
   * Which cells run. Every crash costs two real engines and a shard-lock
   * takeover (~15s), so `npm test` runs two representative cells -- one per
   * mode, one mid-batch and one mid-response -- and the whole matrix runs
   * under `AFFE_EQUIVALENCE=full`, which `npm run verify:durability` sets
   * (its D8 row breaks a replay-only path and expects every streamed cell to
   * fail). A test-tier switch, so read from the environment directly.
   */
  const full = process.env["AFFE_EQUIVALENCE"] === "full"
  const representative = (stream: boolean, location: string, occurrence: number) =>
    occurrence === 1 &&
    (stream
      ? location === turnFailpoints.qualified("after-model-response")
      : location === turnFailpoints.qualified("after-tool-call"))

  // Streamed as well as batch: a streamed replay re-expresses the journal as a
  // stream of its own (`DurableModel.streamPartsFor`), a path the first run
  // never takes, so it is where a replay-only loss would live.
  for (const stream of [false, true])
  for (const [location, occurrence, split] of boundaries) {
    if (!full && !representative(stream, location, occurrence)) continue
    it.live(`${stream ? "streamed" : "batch"}: a crash at ${location} #${occurrence} recovers to the run that never crashed`, () =>
      Effect.gen(function*() {
        const straight = yield* baseline(stream)
        const recovered = yield* crashedRun(location, occurrence, stream)

        // Not vacuous: the uninterrupted run did real work on both sides.
        assert.strictEqual(straight.modelCalls, 2)
        assert.deepStrictEqual(straight.handlerRuns, ["orders", "refunds"])
        // The crash was real, and the replacement did only what was left.
        assert.deepStrictEqual(recovered.split, split, "model calls made by the first and second process")

        assert.deepStrictEqual(recovered.observed, straight)
      }), 90_000)
  }
})
