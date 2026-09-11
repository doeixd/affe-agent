import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentOutput from "../src/AgentOutput.js"
import { Compaction } from "../src/compaction/index.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { turnFailpoints } from "../src/internal/turnFailpoints.js"
import { DurableEquivalence } from "../src/testing/index.js"

/**
 * Item 104's oracle, driven: a submission crashed at each in-turn boundary
 * and finished by another process must be indistinguishable from one that
 * never crashed. The harness is `affe-agent/testing`'s `DurableEquivalence`,
 * which speaks only `SqlClient`; this file supplies SQLite and the scenario.
 */

/** A fresh database per run, removed afterwards (best effort: Windows may still hold it). */
const database = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "equivalence-")), "agent.db")),
  (file) =>
    Effect.sync(() => {
      try {
        NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
      } catch {
        // Still held open on Windows.
      }
    })
).pipe(Effect.map((file) => SqliteClient.layer({ filename: file })))

const Lookup = Tool.make("lookup", {
  parameters: Schema.Struct({ of: Schema.String }),
  success: Schema.String
})

/** Two lookups in one response, then an answer: work on both sides of every boundary. */
const scenario = (stream: boolean) => DurableEquivalence.scenario({
  agent: (effects) =>
    Agent.make({
      tools: [
        Agent.tool(Lookup, ({ of }) => Effect.as(effects.record(of), of === "orders" ? "3 orders" : "1 refund"))
      ],
      loop: AgentLoop.bounded(4)
    }),
  turns: [
    {
      text: "Looking both up.",
      toolCalls: [
        { id: "l1", name: "lookup", params: { of: "orders" } },
        { id: "l2", name: "lookup", params: { of: "refunds" } }
      ]
    },
    { text: "Three orders, one refund." }
  ],
  prompt: "how many orders and refunds?",
  stream
})

/** The uninterrupted run, once per mode: the same for every crash point, and each costs a real engine. */
const baselines = new Map<boolean, DurableEquivalence.Observation>()
const baseline = (stream: boolean) =>
  Effect.suspend(() => {
    const known = baselines.get(stream)
    return known !== undefined
      ? Effect.succeed(known)
      : Effect.tap(
        DurableEquivalence.straight(scenario(stream), { database }),
        (observed) => Effect.sync(() => baselines.set(stream, observed))
      )
  })

describe("a recovered run keeps the tool strategy it was admitted with (item 105)", () => {
  it.live("a replacement configured Parallel still runs a Sequential submission's batch one call at a time", () =>
    Effect.gen(function*() {
      // The first process runs the agent Sequential and dies after the model
      // answered, before either tool ran. The replacement's agent is
      // Parallel. The strategy was journalled at the first execution, so the
      // recovered batch runs as admitted -- and the whole run equals the
      // uninterrupted Sequential one.
      const flight = yield* Ref.make({ now: 0, max: 0 })
      const Slow = Tool.make("slow", { parameters: Schema.Struct({ id: Schema.String }), success: Schema.String })
      const scenario = DurableEquivalence.scenario({
        agent: (effects, process) =>
          Agent.make({
            tools: [
              Agent.tool(Slow, ({ id }) =>
                Effect.acquireUseRelease(
                  Ref.update(flight, (f) => ({ now: f.now + 1, max: Math.max(f.max, f.now + 1) })),
                  () => Effect.andThen(Effect.sleep("40 millis"), effects.record(id)),
                  () => Ref.update(flight, (f) => ({ ...f, now: f.now - 1 }))
                ).pipe(Effect.as(`done ${id}`)))
            ],
            toolExecution: process === "first" ? ToolExecution.Sequential : ToolExecution.Parallel,
            loop: AgentLoop.bounded(4)
          }),
        turns: [
          { toolCalls: [{ id: "s1", name: "slow", params: { id: "a" } }, { id: "s2", name: "slow", params: { id: "b" } }] },
          { text: "both done" }
        ],
        prompt: "do both"
      })

      const straight = yield* DurableEquivalence.straight(scenario, { database })
      assert.strictEqual((yield* Ref.get(flight)).max, 1, "the Sequential baseline overlapped")
      yield* Ref.set(flight, { now: 0, max: 0 })

      const recovered = yield* DurableEquivalence.crashed(scenario, {
        database,
        at: turnFailpoints.qualified("after-model-response")
      })
      assert.deepStrictEqual(recovered.split, [1, 1])
      assert.strictEqual((yield* Ref.get(flight)).max, 1, "the replacement ran the recovered batch with its own strategy")
      assert.deepStrictEqual(recovered.observation, straight)
    }), 90_000)
})

describe("durable recovery is indistinguishable from never having crashed (item 104)", () => {
  /**
   * Each crash point, with the model calls each process should make: the
   * first process's calls are journalled before it dies, so the second must
   * make exactly the rest.
   */
  const cells: ReadonlyArray<readonly [string, number, readonly [number, number]]> = [
    [turnFailpoints.qualified("after-model-response"), 1, [1, 1]],
    // The first of the turn's two calls has settled; the second may not have.
    [turnFailpoints.qualified("after-tool-call"), 1, [1, 1]],
    [turnFailpoints.qualified("before-commit"), 1, [1, 1]],
    [turnFailpoints.qualified("after-commit"), 1, [1, 1]],
    // The second turn's commit: both model calls are behind it.
    [turnFailpoints.qualified("after-commit"), 2, [2, 0]]
  ]

  it("every in-turn boundary is a cell, so a new one cannot go uncrashed", () => {
    assert.deepStrictEqual(
      [...new Set(cells.map(([location]) => location))].sort(),
      [...DurableEquivalence.boundaries].sort()
    )
  })

  /**
   * Which cells run. Every crash costs two engines and a shard-lock takeover
   * (~15s), so `npm test` runs one per mode -- one mid-batch, one
   * mid-response -- and the whole matrix runs under `AFFE_EQUIVALENCE=full`,
   * which `npm run verify:durability` sets (its D8 row breaks a replay-only
   * path and every streamed cell must fail). A test-tier switch, so read from
   * the environment directly.
   */
  const full = process.env["AFFE_EQUIVALENCE"] === "full"
  const representative = (stream: boolean, location: string, occurrence: number) =>
    occurrence === 1 &&
    location === turnFailpoints.qualified(stream ? "after-model-response" : "after-tool-call")

  // Streamed as well as batch: a streamed replay re-expresses the journal as a
  // stream of its own (`DurableModel.streamPartsFor`), a path the first run
  // never takes, so it is where a replay-only loss would live.
  for (const stream of [false, true]) {
    for (const [at, occurrence, split] of cells) {
      if (!full && !representative(stream, at, occurrence)) continue
      it.live(`${stream ? "streamed" : "batch"}: a crash at ${at} #${occurrence} recovers to the run that never crashed`, () =>
        Effect.gen(function*() {
          const straight = yield* baseline(stream)
          const recovered = yield* DurableEquivalence.crashed(scenario(stream), { database, at, occurrence })

          // Not vacuous: the uninterrupted run did real work on both sides.
          assert.strictEqual(straight.modelCalls, 2)
          assert.deepStrictEqual(straight.effects, ["orders", "refunds"])
          // And it left the session as a finished one: idle, one submission,
          // no claim held -- what the recovered run must also leave.
          assert.deepStrictEqual(straight.session, { status: "idle", submissionCount: 1, claimed: false })
          // The crash was real, and the replacement did only what was left.
          assert.deepStrictEqual(recovered.split, split, "model calls made by the first and second process")

          assert.deepStrictEqual(recovered.observation, straight)
        }), 90_000)
    }
  }
})

describe("a run answered through its output tool recovers to the same value (item 104, b)", () => {
  const Verdict = Schema.Struct({ approved: Schema.Boolean, reason: Schema.String })
  const verdict = DurableEquivalence.scenario({
    agent: (effects) =>
      Agent.make({
        output: AgentOutput.make(Verdict),
        tools: [Agent.tool(Lookup, ({ of }) => Effect.as(effects.record(of), "clean history"))],
        loop: AgentLoop.bounded(4)
      }),
    turns: [
      { toolCalls: [{ id: "l1", name: "lookup", params: { of: "customer" } }] },
      { toolCalls: [{ id: "o1", name: AgentOutput.make(Verdict).toolName, params: { approved: true, reason: "clean" } }] }
    ],
    prompt: "approve the refund?"
  })

  // Every in-turn boundary, including the output tool's own turn: a crash
  // there must not lose the value, report it twice, or ask the model again.
  // One cell in `npm test` -- after the commit that holds the answer -- and
  // the rest under `AFFE_EQUIVALENCE=full`, as above.
  const everyBoundary = process.env["AFFE_EQUIVALENCE"] === "full"
  for (const at of DurableEquivalence.boundaries) {
    if (!everyBoundary && at !== turnFailpoints.qualified("after-commit")) continue
    it.live(`a crash at ${at} recovers the same answer`, () =>
      Effect.gen(function*() {
        const straight = yield* DurableEquivalence.straight(verdict, { database })
        assert.deepStrictEqual(straight.value, { approved: true, reason: "clean" })
        const recovered = yield* DurableEquivalence.crashed(verdict, { database, at })
        assert.deepStrictEqual(recovered.observation, straight)
      }), 120_000)
  }
})

describe("a run that compacts as it goes recovers to the same run (item 104, b)", () => {
  // Three tool rounds against a threshold of two messages, so the transform
  // folds on most turns. The summary is derived and never canonical; the
  // replacement rebuilds it from history in its own process, and nothing a
  // client or the journal holds may differ for it. The model follows the
  // run by its tool results, which compaction keeps (`select: "results"`).
  const compacting = DurableEquivalence.scenario({
    agent: (effects) =>
      Agent.make({
        contextTransform: Effect.runSync(Compaction.make({
          policy: Compaction.whenLongerThan(2, { retain: 2 }),
          summarise: ({ messages }) => Effect.succeed(`folded ${messages.content.length} messages`)
        })),
        tools: [Agent.tool(Lookup, ({ of }) => Effect.as(effects.record(of), `${of}: ok`))],
        loop: AgentLoop.bounded(6)
      }),
    turns: [
      { toolCalls: [{ id: "a", name: "lookup", params: { of: "one" } }] },
      { toolCalls: [{ id: "b", name: "lookup", params: { of: "two" } }] },
      { toolCalls: [{ id: "c", name: "lookup", params: { of: "three" } }] },
      { text: "all three are ok" }
    ],
    select: "results",
    prompt: "check all three"
  })

  it.live("a crash after the second turn commits recovers the same history, events and effects", () =>
    Effect.gen(function*() {
      const straight = yield* DurableEquivalence.straight(compacting, { database })
      assert.deepStrictEqual(straight.effects, ["one", "three", "two"])
      const recovered = yield* DurableEquivalence.crashed(compacting, {
        database,
        at: turnFailpoints.qualified("after-commit"),
        occurrence: 2
      })
      assert.deepStrictEqual(recovered.observation, straight)
    }), 120_000)
})
