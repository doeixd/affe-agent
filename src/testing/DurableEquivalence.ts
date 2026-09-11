import { Crypto, Deferred, Duration, Effect, Layer, Option, Ref, Schedule, Schema } from "effect"
import type { Scope } from "effect"
import type { LanguageModel, Prompt, Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import type { SqlClient } from "effect/unstable/sql"
import type { AgentDefinition } from "../Agent.js"
import * as PromptWire from "../PromptWire.js"
import * as ToolScheduling from "../ToolScheduling.js"
import { AgentClient } from "../client/index.js"
import * as DeliveryLog from "../durable/DeliveryLog.js"
import * as DurableAgentClient from "../durable/DurableAgentClient.js"
import * as DurableChannels from "../durable/DurableChannels.js"
import * as DurableSessionStore from "../durable/DurableSessionStore.js"
import { Failpoint } from "../internal/failpoint.js"
import { turnFailpoints } from "../internal/turnFailpoints.js"
import * as TestLanguageModel from "./TestLanguageModel.js"

/**
 * The durability oracle: a submission that crashed at a boundary and was
 * finished by another process must be indistinguishable from one that never
 * crashed.
 *
 * Narrower crash tests -- a delivery log's rows, the last prompt's texts,
 * whether a tool ran once -- all pass for a recovery that rebuilt a slightly
 * different conversation. This compares the thing itself: the canonical
 * history as the wire encodes it, the result, how many model calls each
 * process made, and every side effect the agent recorded.
 *
 * The crash is real. Each "process" is its own workflow engine, client, stores
 * and model over one database; the crashed one is parked at the armed
 * boundary and its scope is closed, which is what a process dying there looks
 * like to the journal, and the next one takes the shard over and finishes.
 *
 * **Portable by construction.** Everything durable here -- the workflow
 * journal (`SingleRunner` with SQL runner storage), the channels, the session
 * store, the delivery log -- speaks Effect's `SqlClient`, so the caller hands
 * in the database and the harness never names a driver: SQLite under Node,
 * D1 or Postgres elsewhere.
 *
 * ```ts
 * const database = Effect.acquireRelease(makeTempFile, removeIt).pipe(
 *   Effect.map((file) => SqliteClient.layer({ filename: file }))
 * )
 * const straight = yield* DurableEquivalence.straight(scenario, { database })
 * const crashed = yield* DurableEquivalence.crashed(scenario, {
 *   database,
 *   at: DurableEquivalence.boundaries[1]
 * })
 * assert.deepStrictEqual(crashed.observation, straight)
 * ```
 */

/** Every in-turn boundary a crash can be armed at, qualified. */
export const boundaries: ReadonlyArray<string> = turnFailpoints.all

/**
 * The agent's side effects, recorded by label and shared by every process of
 * one run -- so a tool that ran again after a takeover shows up twice.
 */
export interface Effects {
  readonly record: (label: string) => Effect.Effect<void>
}

/**
 * Which process of a run is building the agent: the one that runs first (and,
 * in a crashed run, dies), or the one that takes over. A straight run has only
 * a first.
 */
export type Process = "first" | "second"

export interface Scenario<Tools extends Record<string, Tool.Any>, Value, Input> {
  /**
   * The agent, built afresh in each process. Its tools should report what
   * they did through `effects`, which is how "each ran once" is checked.
   *
   * `process` lets the replacement be configured differently -- a new
   * deployment taking over an old run -- to check that what a submission was
   * admitted with outlives the process that admitted it.
   */
  readonly agent: (effects: Effects, process: Process) => AgentDefinition<Tools, any, any, LanguageModel.LanguageModel, Value, Input>
  /**
   * The model's turns. Picked by the conversation, not by call count
   * (`TestLanguageModel`'s `select: "history"`), so a process that takes over
   * half-way answers the turn the run is actually at.
   */
  readonly turns: ReadonlyArray<TestLanguageModel.Turn>
  /**
   * How the model picks its turn. Default `"history"`; `"results"` for a run
   * whose context is compacted (see `TestLanguageModel.Options.select`).
   */
  readonly select?: "history" | "results" | undefined
  readonly prompt: string
  readonly stream?: boolean | undefined
  /**
   * The host's `ToolScheduling` in each process, when the scenario is about
   * a replacement host scheduling differently (item 105). Default: none.
   */
  readonly hostScheduling?: ((process: Process) => ToolScheduling.ToolScheduling) | undefined
}

/**
 * A scenario, with its types inferred from the agent rather than written out.
 * An identity at runtime.
 */
export const scenario = <Tools extends Record<string, Tool.Any>, Value, Input>(
  definition: Scenario<Tools, Value, Input>
): Scenario<Tools, Value, Input> => definition

export interface Options {
  /**
   * A fresh, empty database for one run, as the `SqlClient` layer that opens
   * it. Built once per process of the run, so each process holds its own
   * connection and closing one does not close the other's.
   */
  readonly database: Effect.Effect<Layer.Layer<SqlClient.SqlClient>, never, Scope.Scope>
  /**
   * How long a dead process's shard lock lasts before the next can take it.
   * Default one second: a test wants a quick takeover, and nothing else here
   * contends for the lock.
   */
  readonly lockExpiration?: Duration.Input | undefined
}

/** What is compared. Everything here is meant to be deterministic. */
export interface Observation {
  /** Canonical history, encoded with `PromptWire.Prompt`. */
  readonly history: unknown
  readonly status: string
  readonly text: string
  readonly turns: number
  /** The agent's declared output, encoded, when it reached one. */
  readonly value: unknown
  /** Model calls, across every process of the run. */
  readonly modelCalls: number
  /**
   * Side effects, sorted: calls in one batch may run concurrently, so the
   * order they *ran* in is not meant to be stable. The order their results
   * were committed in is in `history`.
   */
  readonly effects: ReadonlyArray<string>
  /**
   * Every event the session's delivery log holds, as tags in delivery order
   * (item 104). A crashed run's first process and its replacement share one
   * log, and a replayed emission is deduplicated by its key, so a recovery
   * that re-announced a turn, dropped a terminal event or reordered a tool's
   * result shows here even when history and result agree.
   */
  readonly events: ReadonlyArray<string>
  /**
   * The session record the store holds after the run (item 104): its status,
   * how many submissions it accepted, and whether a claim is still held. A
   * recovery that finished the run but left the session claimed -- or
   * counted the submission twice -- differs here, and would lock the
   * session out of its next prompt.
   */
  readonly session: { readonly status: string; readonly submissionCount: number; readonly claimed: boolean }
}

const SESSION = "durable-equivalence"
const NAME = "DurableEquivalence"

/** Runner identity needs `Crypto`; Web Crypto is on every runtime this library targets. */
const CryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () =>
        new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, data.slice().buffer))
      )
  })
)

interface Park {
  readonly location: string
  readonly occurrence: number
  readonly arrived: Deferred.Deferred<void>
}

/**
 * One process. With `park`, the armed boundary holds it there forever and
 * reports that it arrived; the caller closing the scope afterwards is the
 * process dying at exactly that point.
 */
const processOver = <Tools extends Record<string, Tool.Any>, Value, Input>(
  scenario: Scenario<Tools, Value, Input>,
  sql: Layer.Layer<SqlClient.SqlClient>,
  effects: Effects,
  lockExpiration: Duration.Input,
  process: Process,
  park?: Park
) =>
  Effect.gen(function*() {
    const connection = yield* Layer.build(sql)
    const stores = yield* Effect.all({
      store: DurableChannels.sqlStoreWithTable(),
      sessionStore: DurableSessionStore.sqlStoreWithTables(),
      delivery: DeliveryLog.sqlLogWithTable()
    }).pipe(Effect.provide(connection))
    const { layer: model, recorder } = yield* TestLanguageModel.script(scenario.turns, { select: scenario.select ?? "history" })
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
    const engine = ClusterWorkflowEngine.layer.pipe(
      Layer.provide(
        SingleRunner.layer({
          runnerStorage: "sql",
          shardingConfig: {
            shardLockExpiration: Duration.fromInputUnsafe(lockExpiration),
            shardLockRefreshInterval: Duration.millis(200)
          }
        }).pipe(Layer.provide(Layer.succeedContext(connection)), Layer.provide(CryptoLayer))
      )
    )
    const runtime = yield* Layer.build(
      DurableAgentClient.layer(NAME, scenario.agent(effects, process), {
        ...stores,
        pollInterval: Duration.millis(50)
      }).pipe(
        Layer.provideMerge(engine),
        Layer.provideMerge(model),
        Layer.provideMerge(failpoint),
        Layer.provideMerge(
          scenario.hostScheduling === undefined
            ? Layer.empty
            : ToolScheduling.layer(scenario.hostScheduling(process))
        )
      )
    )
    const client = yield* Effect.service(AgentClient.AgentClient).pipe(Effect.provide(runtime))
    return { client, recorder, delivery: stores.delivery, sessionStore: stores.sessionStore }
  })

const recording = Effect.map(Ref.make<ReadonlyArray<string>>([]), (log) => ({
  effects: { record: (label: string) => Ref.update(log, (all) => [...all, label]) } satisfies Effects,
  recorded: Ref.get(log)
}))

const observe = (
  history: Prompt.Prompt,
  result: { readonly status: string; readonly text: string; readonly turns: number; readonly value?: unknown },
  modelCalls: number,
  effects: ReadonlyArray<string>,
  delivery: DeliveryLog.DeliveryLog,
  sessionStore: DurableSessionStore.DurableSessionStore
): Effect.Effect<Observation> =>
  Effect.all([
    Effect.orDie(Schema.encodeEffect(PromptWire.Prompt)(history)),
    Effect.orDie(delivery.read(SESSION)),
    Effect.orDie(sessionStore.get(SESSION))
  ]).pipe(Effect.map(([encoded, delivered, record]) => ({
    history: encoded,
    status: result.status,
    text: result.text,
    turns: result.turns,
    value: result.value,
    modelCalls,
    effects: [...effects].sort(),
    events: delivered.map((envelope) => envelope.event._tag),
    session: Option.match(record, {
      onNone: () => ({ status: "missing", submissionCount: 0, claimed: false }),
      onSome: (r) => ({ status: r.status, submissionCount: r.submissionCount, claimed: Option.isSome(r.claim) })
    })
  })))

/** The scenario, run once, straight through, in one process. The baseline. */
export const straight = <Tools extends Record<string, Tool.Any>, Value, Input>(
  scenario: Scenario<Tools, Value, Input>,
  options: Options
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const sql = yield* options.database
      const { effects, recorded } = yield* recording
      const { client, delivery, recorder, sessionStore } = yield* processOver(scenario, sql, effects, options.lockExpiration ?? "1 second", "first")
      const session = yield* client.createSession({ sessionId: SESSION })
      const result = yield* session.prompt(scenario.prompt, { stream: scenario.stream ?? false })
      return yield* observe(yield* session.history, result, yield* recorder.calls, yield* recorded, delivery, sessionStore)
    })
  )

/**
 * The scenario, crashed at `at` (its `occurrence`th arrival, default the
 * first) and finished by a second process over the same database.
 *
 * `split` is the model calls each process made. Everything the first process
 * finished is journalled, so the second must make exactly the rest: a
 * replacement that re-issued a journalled call, or a crash that stopped
 * nothing, shows up there before the history comparison does.
 *
 * Dies, by name, if the run never reaches the armed boundary: a crash nowhere
 * is not a crash test.
 */
export const crashed = <Tools extends Record<string, Tool.Any>, Value, Input>(
  scenario: Scenario<Tools, Value, Input>,
  options: Options & {
    readonly at: string
    readonly occurrence?: number | undefined
    /** How long to wait for the boundary, and for the takeover. Default 20 seconds each. */
    readonly timeout?: Duration.Input | undefined
  }
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const sql = yield* options.database
      const { effects, recorded } = yield* recording
      const arrived = yield* Deferred.make<void>()
      const occurrence = options.occurrence ?? 1
      const lock = options.lockExpiration ?? "1 second"
      const timeout = options.timeout ?? "20 seconds"

      const first = yield* Effect.scoped(
        Effect.gen(function*() {
          const { client, recorder } = yield* processOver(scenario, sql, effects, lock, "first", {
            location: options.at,
            occurrence,
            arrived
          })
          const session = yield* client.createSession({ sessionId: SESSION })
          const receipt = yield* session.submit(scenario.prompt, { stream: scenario.stream ?? false })
          yield* Deferred.await(arrived).pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () => Effect.die(new Error(`the run never reached ${options.at} #${occurrence}`))
            })
          )
          return { calls: yield* recorder.calls, submissionId: receipt.submissionId }
        })
      )
      // That scope is closed: the first process died at the boundary.

      return yield* Effect.scoped(
        Effect.gen(function*() {
          const { client, delivery, recorder, sessionStore } = yield* processOver(scenario, sql, effects, lock, "second")
          const session = yield* client.session(SESSION)
          // Retried: until the dead process's shard lock expires, the
          // submission is not this process's to finish. Not an agent failure,
          // though -- a submission that *failed* is an outcome, and the caller
          // gets it (a refused replay, say) rather than a timeout.
          const result = yield* session.awaitSubmission(first.submissionId).pipe(
            Effect.retry({
              schedule: Schedule.spaced(Duration.millis(100)),
              while: (error) => error._tag !== "AgentExecutionError"
            }),
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () => Effect.die(new Error(`no process finished the submission crashed at ${options.at}`))
            })
          )
          const secondCalls = yield* recorder.calls
          const observation = yield* observe(
            yield* session.history,
            result,
            first.calls + secondCalls,
            yield* recorded,
            delivery,
            sessionStore
          )
          return { observation, split: [first.calls, secondCalls] as const }
        })
      )
    })
  )
