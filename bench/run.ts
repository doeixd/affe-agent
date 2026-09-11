/**
 * The benchmark scenarios (item 100), run in-process against one ref's source.
 *
 * `scripts/bench.mjs` runs this file inside a worktree of each ref and
 * compares; run it directly to see one ref's numbers:
 *
 *   npx tsx bench/run.ts --samples 15
 *
 * Every scenario is deterministic -- the scripted model, no network -- so what
 * varies between refs is the library. Each prints one JSON line: the wall
 * time of every sample, and model-independent measures where a scenario has
 * them (requests, tools and schema bytes sent). Timing is an observation, not
 * a verdict: the runner reports medians and spreads and makes no claim about
 * significance.
 *
 * The modules every ref has are imported statically. One a scenario needs
 * that an older ref may lack (`ToolExposure`) is imported inside it, so that
 * scenario reports itself unavailable instead of failing the run -- or worse,
 * running as something else: an old `Agent.make` would ignore an exposure it
 * does not know and run eagerly under the progressive label.
 */
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import type { LanguageModel, Prompt } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as TestLanguageModel from "../src/testing/TestLanguageModel.js"

interface Sample {
  readonly ms: number
  readonly metrics?: Readonly<Record<string, number>> | undefined
}

interface Scenario {
  readonly name: string
  readonly run: () => Promise<Sample>
}

const argument = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : Number(process.argv[at + 1])
}
const samples = argument("samples", 10)
const warmup = argument("warmup", 2)
const only = (() => {
  const at = process.argv.indexOf("--only")
  // `|`-separated: scenario names contain commas.
  return at === -1 ? undefined : new Set(String(process.argv[at + 1]).split("|"))
})()

const timed = async (work: () => Promise<Readonly<Record<string, number>> | void>): Promise<Sample> => {
  const start = performance.now()
  const metrics = await work()
  return { ms: performance.now() - start, ...(metrics ? { metrics } : {}) }
}

const toolsNamed = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    Tool.make(`tool_${i}`, {
      description: `routine operation number ${i}, which takes an id and a limit`,
      parameters: Schema.Struct({ id: Schema.String, limit: Schema.optional(Schema.Number) }),
      success: Schema.String
    }))

const bound = (count: number) => toolsNamed(count).map((tool) => Agent.tool(tool, () => Effect.succeed("ok")))

/** Drive one agent through a scripted conversation; return what the model was sent. */
const drive = <Tools extends Record<string, Tool.Any>, Value>(
  agent: Agent.AgentDefinition<Tools, never, never, LanguageModel.LanguageModel, Value>,
  turns: ReadonlyArray<TestLanguageModel.Turn>,
  prompts: ReadonlyArray<string>,
  options?: { readonly stream?: boolean }
) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const { layer, recorder } = yield* TestLanguageModel.script(turns)
      yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* AgentSession.make(agent)
          for (const prompt of prompts) {
            yield* AgentSession.prompt<Tools, never, Value, Prompt.RawInput>(session, prompt, {
              stream: options?.stream ?? false
            })
          }
        }).pipe(Effect.provide(layer))
      )
      // `tools` arrived in the recorder after the first release; a ref
      // without it reports none rather than failing the timing scenarios.
      const tools: ReadonlyArray<ReadonlyArray<string>> = "tools" in recorder ? yield* recorder.tools : []
      return { calls: yield* recorder.calls, tools }
    })
  )

/** Bytes of the JSON Schemas the requests carried, by the names the recorder saw. */
const schemaBytes = (offered: ReadonlyArray<ReadonlyArray<string>>, tools: ReadonlyArray<Tool.Any>): number => {
  const byName = new Map(tools.map((tool) => [tool.name, JSON.stringify(Tool.getJsonSchema(tool)).length]))
  return offered.reduce((sum, names) => sum + names.reduce((s, name) => s + (byName.get(name) ?? 0), 0), 0)
}

const round = (ms: number) => Math.round(ms * 10) / 10

/**
 * A fresh SQLite file, and a way to open a durable "process" over it: its own
 * connection, stores, runner and client, for the enclosing scope. Imported
 * inside, as the other durable scenarios are, so an older ref without these
 * modules reports the scenario unavailable.
 */
const durableWorkspace = async (prefix: string) => {
  const { AgentClient } = await import("../src/client/index.js")
  const DurableAgentClient = await import("../src/durable/DurableAgentClient.js")
  const DurableChannels = await import("../src/durable/DurableChannels.js")
  const DurableSessionStore = await import("../src/durable/DurableSessionStore.js")
  const DeliveryLog = await import("../src/durable/DeliveryLog.js")
  const { SqliteClient } = await import("@effect/sql-sqlite-node")
  const { ClusterWorkflowEngine, SingleRunner } = await import("effect/unstable/cluster")
  const { Crypto, Duration, Layer } = await import("effect")
  const NodeFs = await import("node:fs")
  const NodeOs = await import("node:os")
  const NodePath = await import("node:path")
  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), prefix))
  const file = NodePath.join(dir, "a.db")
  const crypto = Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
      digest: (algorithm, data) =>
        Effect.promise(async () => new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, data.slice().buffer)))
    })
  )
  const agent = Agent.make({ loop: AgentLoop.bounded(1) })
  const openProcess = (turns: ReadonlyArray<TestLanguageModel.Turn>) =>
    Effect.gen(function*() {
      const connection = yield* Layer.build(SqliteClient.layer({ filename: file }))
      const stores = yield* Effect.all({
        store: DurableChannels.sqlStoreWithTable(),
        sessionStore: DurableSessionStore.sqlStoreWithTables(),
        delivery: DeliveryLog.sqlLogWithTable()
      }).pipe(Effect.provide(connection))
      const { layer: model } = yield* TestLanguageModel.script(turns)
      const engine = ClusterWorkflowEngine.layer.pipe(
        Layer.provide(
          SingleRunner.layer({
            runnerStorage: "sql",
            shardingConfig: { shardLockExpiration: Duration.seconds(1), shardLockRefreshInterval: Duration.millis(200) }
          }).pipe(Layer.provide(Layer.succeedContext(connection)), Layer.provide(crypto))
        )
      )
      const runtime = yield* Layer.build(
        DurableAgentClient.layer("BenchDurable", agent, { ...stores, pollInterval: Duration.millis(20) }).pipe(
          Layer.provideMerge(engine),
          Layer.provideMerge(model)
        )
      )
      return yield* Effect.service(AgentClient.AgentClient).pipe(Effect.provide(runtime))
    })
  const remove = () => {
    try {
      NodeFs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Still held open on Windows.
    }
  }
  return { openProcess, remove }
}

const scenarios: ReadonlyArray<Scenario> = [
  {
    name: "one-turn run",
    run: () => timed(async () => void (await drive(Agent.make({}), [{ text: "done" }], ["go"])))
  },
  ...[64, 1024].map((chunks): Scenario => ({
    name: `stream ${chunks} chunks`,
    run: () =>
      timed(async () =>
        void (await drive(
          Agent.make({}),
          [{ text: "x".repeat(chunks), chunks: Array.from({ length: chunks }, () => "x") }],
          ["go"],
          { stream: true }
        )))
  })),
  {
    name: "8 parallel tools",
    run: () =>
      timed(async () =>
        void (await drive(
          Agent.make({ tools: bound(8) }),
          [
            { toolCalls: Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, name: `tool_${i}`, params: { id: "x" } })) },
            { text: "done" }
          ],
          ["go"]
        )))
  },
  {
    name: "4 tool rounds",
    run: () =>
      timed(async () =>
        void (await drive(
          Agent.make({ tools: bound(1), loop: AgentLoop.bounded(8) }),
          [
            ...Array.from({ length: 4 }, (_, i) => ({ toolCalls: [{ id: `r${i}`, name: "tool_0", params: { id: "x" } }] })),
            { text: "done" }
          ],
          ["go"]
        )))
  },
  {
    name: "40 prompts of history, then one more",
    run: () =>
      timed(async () =>
        void (await drive(
          Agent.make({}),
          Array.from({ length: 41 }, (_, i) => ({ text: `answer ${i} `.repeat(20) })),
          Array.from({ length: 41 }, (_, i) => `question ${i}`)
        )))
  },
  // What durability costs a run (item 100): the same two tool rounds and an
  // answer, submitted through the durable client over a fresh SQLite file --
  // journal, session store, channels and delivery log all real. The harness
  // is imported inside, so a ref without it reports this unavailable.
  {
    name: "durable: two tool rounds over SQLite",
    run: () =>
      timed(async () => {
        const { DurableEquivalence } = await import("../src/testing/index.js")
        const { SqliteClient } = await import("@effect/sql-sqlite-node")
        const NodeFs = await import("node:fs")
        const NodeOs = await import("node:os")
        const NodePath = await import("node:path")
        const database = Effect.acquireRelease(
          Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "bench-durable-")), "a.db")),
          (file) =>
            Effect.sync(() => {
              try {
                NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
              } catch {
                // Still held open on Windows.
              }
            })
        ).pipe(Effect.map((file) => SqliteClient.layer({ filename: file })))
        const [tool] = toolsNamed(1)
        const scenario = DurableEquivalence.scenario({
          agent: (effects) =>
            Agent.make({
              tools: [Agent.tool(tool!, () => Effect.as(effects.record("x"), "ok"))],
              loop: AgentLoop.bounded(4)
            }),
          turns: [
            { toolCalls: [{ id: "r0", name: "tool_0", params: { id: "x" } }] },
            { toolCalls: [{ id: "r1", name: "tool_0", params: { id: "y" } }] },
            { text: "done" }
          ],
          prompt: "go"
        })
        await Effect.runPromise(DurableEquivalence.straight(scenario, { database }))
      })
  },
  // What a reconnecting client pays (item 100): 500 events appended to a
  // SQLite delivery log, then read back after offset 0 -- whole, and in
  // pages of 100 by the `limit` item 109 added (a ref without it reads the
  // whole log on the first page, and the loop ends there). The appends
  // dominate the wall time; `readMs` is the catch-up alone.
  ...(["whole", "paged"] as const).map((mode): Scenario => ({
    name: `durable: append 500 events, then catch up ${mode}`,
    run: () =>
      timed(async () => {
        const DeliveryLog = await import("../src/durable/DeliveryLog.js")
        const { DeliveryLogConformance } = await import("../src/testing/index.js")
        const { SqliteClient } = await import("@effect/sql-sqlite-node")
        const NodeFs = await import("node:fs")
        const NodeOs = await import("node:os")
        const NodePath = await import("node:path")
        const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "bench-log-"))
        const read = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const log = yield* DeliveryLog.sqlLogWithTable()
              for (let i = 1; i <= 500; i++) {
                yield* log.append("s", `k${i}`, DeliveryLogConformance.envelope(i, { _tag: "RunStarted" }))
              }
              const started = performance.now()
              let after = 0
              let total = 0
              while (true) {
                const page = mode === "whole" ? yield* log.read("s", { after }) : yield* log.read("s", { after, limit: 100 })
                total += page.length
                if (mode === "whole" || page.length < 100) break
                after = page[page.length - 1]!.sequence
              }
              return { total, readMs: Math.round((performance.now() - started) * 10) / 10 }
            })
          ).pipe(Effect.provide(SqliteClient.layer({ filename: NodePath.join(dir, "log.db") })))
        )
        try {
          NodeFs.rmSync(dir, { recursive: true, force: true })
        } catch {
          // Still held open on Windows.
        }
        return { eventsRead: read.total, readMs: read.readMs }
      })
  })),
  // Cold recovery against history length (item 100's first decided scenario;
  // its threshold reopens item 112): N one-turn submissions settled through
  // the durable client over a fresh SQLite file, that process closed, then a
  // second process over the same file. `recoveryMs` is from building the
  // second client until the session reads back idle -- what history length
  // costs a replacement. `nextMs` is one more prompt after that, which also
  // waits out the first runner's shard lock (it outlives a closed runner;
  // see `test/DurableSql.test.ts`), so it is mostly that constant.
  // 1000 only on request (BENCH_RECOVERY_LARGE=1): its setup alone takes minutes.
  ...[10, 100, ...(process.env["BENCH_RECOVERY_LARGE"] === "1" ? [1000] : [])].map((submissions): Scenario => ({
    name: `durable: cold recovery after ${submissions} submissions`,
    run: () =>
      timed(async () => {
        const { openProcess, remove } = await durableWorkspace("bench-recovery-")
        await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
          const client = yield* openProcess(Array.from({ length: submissions }, (_, i) => ({ text: `answer ${i}` })))
          const session = yield* client.createSession({ sessionId: "recovered" })
          for (let i = 0; i < submissions; i++) yield* session.prompt(`question ${i}`)
        })))
        const measured = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
          const started = performance.now()
          const client = yield* openProcess([{ text: "after recovery" }])
          const session = yield* client.session("recovered")
          yield* session.status
          const recoveredAt = performance.now()
          yield* session.prompt("one more")
          return { recoveryMs: recoveredAt - started, nextMs: performance.now() - recoveredAt }
        })))
        remove()
        return { submissions, recoveryMs: round(measured.recoveryMs), nextMs: round(measured.nextMs) }
      })
  })),
  // Write contention (item 100's second decided scenario): 1, 2 and 4
  // sessions submitting at once -- five prompts each -- through one durable
  // client over one SQLite file. Not separate processes: `SingleRunner`s
  // sharing a file contend for shard locks rather than forwarding, and
  // multi-process deployment is the HTTP-runner cluster. Here every
  // session's journal, session record, channel drains and delivery log land
  // in the same file. Any `SQLITE_BUSY` a caller sees is a bug, not a
  // number: `busyErrors` must stay 0.
  ...[1, 2, 4].map((sessions): Scenario => ({
    name: `durable: ${sessions} sessions submitting at once over SQLite`,
    run: () =>
      timed(async () => {
        const { openProcess, remove } = await durableWorkspace("bench-contention-")
        const each = 5
        const measured = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
          const client = yield* openProcess(Array.from({ length: sessions * each }, (_, i) => ({ text: `answer ${i}` })))
          const started = performance.now()
          const errors = yield* Effect.forEach(
            Array.from({ length: sessions }, (_, s) => s),
            (s) =>
              Effect.gen(function*() {
                const session = yield* client.createSession({ sessionId: `writer-${s}` })
                let failed: ReadonlyArray<string> = []
                for (let i = 0; i < each; i++) {
                  const exit = yield* Effect.exit(session.prompt(`question ${i}`))
                  if (exit._tag === "Failure") failed = [...failed, String(exit.cause)]
                }
                return failed
              }),
            { concurrency: "unbounded" }
          )
          const all = errors.flat()
          return {
            ms: performance.now() - started,
            failed: all.length,
            busy: all.filter((error) => /SQLITE_BUSY|database is locked/i.test(error)).length
          }
        })))
        remove()
        return {
          sessions,
          submissionsPerSec: round((sessions * each) / (measured.ms / 1000)),
          failed: measured.failed,
          busyErrors: measured.busy
        }
      })
  })),
  // The effect-uai adapter's cost (item 100): the "stream 1024 chunks" run,
  // with the chunks coming from a scripted effect-uai provider through
  // `EffectUaiModel` instead of from Effect AI's scripted model. Compare with
  // that scenario. Imported inside, so a ref without the adapter reports this
  // unavailable.
  {
    name: "stream 1024 chunks, through the effect-uai adapter",
    run: () =>
      timed(async () => {
        const { Layer, Stream } = await import("effect")
        const { IdGenerator } = await import("effect/unstable/ai")
        const UaiLanguageModel = await import("@effect-uai/core/LanguageModel")
        const EffectUaiModel = await import("../src/effect-uai/EffectUaiModel.js")
        const events = [
          ...Array.from({ length: 1024 }, () => ({ _tag: "TextDelta" as const, text: "x" })),
          { _tag: "TurnComplete" as const, turn: { items: [], usage: {}, stop_reason: "stop" as const } }
        ]
        const streamTurn = () => Stream.fromIterable(events)
        const provider = Layer.succeed(UaiLanguageModel.LanguageModel, {
          streamTurn,
          turn: UaiLanguageModel.turnFromStream(streamTurn)
        })
        const model = Layer.mergeAll(
          EffectUaiModel.layer({ model: "bench" }).pipe(Layer.provide(provider)),
          Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator)
        )
        await Effect.runPromise(
          Effect.scoped(
            Effect.flatMap(AgentSession.make(Agent.make({})), (session) => session.prompt("go", { stream: true }))
          ).pipe(Effect.provide(model))
        )
      })
  },
  // Item 93's question: is progressive exposure worth a discovery turn? The
  // timings are the scripted model's; the model-independent measures -- how
  // many requests, how many tools and schema bytes they carried -- are the
  // part a real provider would bill.
  ...(["eager", "progressive"] as const).map((mode): Scenario => ({
    name: `100 tools, ${mode}`,
    run: () =>
      timed(async () => {
        const ToolExposure = await import("../src/ToolExposure.js")
        const agent = Agent.make({
          tools: bound(100),
          loop: AgentLoop.bounded(6),
          toolExposure: mode === "eager" ? ToolExposure.eager() : ToolExposure.progressive({ maxTools: 8 })
        })
        const call = { toolCalls: [{ id: "t", name: "tool_42", params: { id: "x" } }] }
        const turns: ReadonlyArray<TestLanguageModel.Turn> = mode === "eager"
          ? [call, { text: "done" }]
          : [
            { toolCalls: [{ id: "d", name: "discover_tools", params: { query: "routine operation number 42" } }] },
            call,
            { text: "done" }
          ]
        const { calls, tools: offered } = await drive(agent, turns, ["go"])
        return {
          requests: calls,
          toolsSent: offered.reduce((sum, names) => sum + names.length, 0),
          // `discover_tools` is counted too: every progressive request carries it.
          schemaBytesSent: schemaBytes(offered, [...toolsNamed(100), ToolExposure.DiscoverTools])
        }
      })
  }))
]

for (const scenario of scenarios) {
  if (only !== undefined && !only.has(scenario.name)) continue
  try {
    for (let i = 0; i < warmup; i++) await scenario.run()
    const results: Array<Sample> = []
    for (let i = 0; i < samples; i++) results.push(await scenario.run())
    console.log(JSON.stringify({
      scenario: scenario.name,
      ok: true,
      samples: results.map((r) => Math.round(r.ms * 1000) / 1000),
      metrics: results[0]?.metrics ?? {}
    }))
  } catch (error) {
    console.log(JSON.stringify({ scenario: scenario.name, ok: false, error: String(error).slice(0, 300) }))
  }
}
