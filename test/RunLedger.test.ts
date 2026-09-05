import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Layer, Option, Ref, Schema } from "effect"
import { Model, Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { Budget } from "../src/budget/index.js"
import * as ModelCapabilities from "../src/model/ModelCapabilities.js"
import * as RunLedger from "../src/RunLedger.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Item 60g: the engine records facts; seams only decide.
 *
 * Every row reads the ledger back after a run the engine drove, so what is
 * asserted is what the engine wrote, not what a test wrote. The first row is
 * the property the module claims for `AgentLoop.State`: the state a loop is
 * handed and the ledger's view of the same run agree after every turn.
 */

const Noop = Tool.make("noop", { parameters: Schema.Struct({}), success: Schema.String })
const noop = Agent.tool(Noop, () => Effect.succeed("ok"))
const call = (id: string) => ({ id, name: "noop", params: {} })

const ledger = Effect.flatMap(RunLedger.RunLedger, (l) => l.entries)
const totals = Effect.flatMap(RunLedger.RunLedger, (l) => l.totals)

describe("the run ledger", () => {
  it.effect("the state a loop is handed and the ledger's run view agree after every turn", () =>
    Effect.gen(function* () {
      // Two tool turns then text: three turns, two tool calls. The loop sees
      // each state; the ledger's `run(runId)` at that moment must add up to
      // exactly it -- same turn, same tool-call total, same elapsed.
      const seen = yield* Ref.make<Array<{ state: [number, number, number]; ledger: [number, number, number] }>>([])
      const watching = AgentLoop.make((state) =>
        Effect.gen(function* () {
          const view = yield* (yield* RunLedger.RunLedger).run(state.runId)
          const stateRow: [number, number, number] = [state.turnIndex, state.toolCallsTotal, Duration.toMillis(state.elapsed)]
          const ledgerRow: [number, number, number] = [view.turns, view.toolCalls, view.elapsedMillis]
          yield* Ref.update(seen, (all) => [...all, { state: stateRow, ledger: ledgerRow }])
          return yield* AgentLoop.untilIdle().decide(state)
        })
      )
      const { layer: model } = yield* TestLanguageModel.script([
        { toolCalls: [call("a")], usage: { input: 10, output: 1 } },
        { toolCalls: [call("b")], usage: { input: 20, output: 2 } },
        { text: "done", usage: { input: 30, output: 3 } }
      ])
      yield* Effect.scoped(
        Effect.flatMap(
          AgentSession.make(Agent.make({ tools: [noop], loop: watching })),
          (session) => AgentSession.prompt(session, "go")
        )
      ).pipe(Effect.provide(Layer.merge(model, RunLedger.layer)))
      const rows = yield* Ref.get(seen)
      assert.strictEqual(rows.length, 3)
      for (const row of rows) assert.deepStrictEqual(row.ledger, row.state)
      assert.deepStrictEqual(rows.map((row) => row.state.slice(0, 2)), [[1, 1], [2, 2], [3, 2]])
    })
  )

  it.effect("every turn is a fact: tokens, tool calls, run and session, whether or not a loop asked", () =>
    Effect.gen(function* () {
      const { layer: model } = yield* TestLanguageModel.script([
        { toolCalls: [call("a"), call("b")], usage: { input: 10, output: 1 } },
        { text: "done", usage: { input: 20, output: 2 } }
      ])
      const sessionId = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({ tools: [noop], loop: AgentLoop.untilIdle() }))
          yield* AgentSession.prompt(session, "go")
          return session.id
        })
      ).pipe(Effect.provide(model))
      const entries = yield* ledger
      assert.deepStrictEqual(
        entries.map((entry) => [entry.turnIndex, entry.toolCalls, entry.inputTokens, entry.outputTokens]),
        [[1, 2, 10, 1], [2, 0, 20, 2]]
      )
      assert.isTrue(entries.every((entry) => entry.sessionId === sessionId))
      assert.strictEqual(new Set(entries.map((entry) => entry.runId)).size, 1)
      // Nothing priced the model, so nothing is a cost -- not zero, absent.
      assert.isTrue(entries.every((entry) => Option.isNone(entry.cost)))
      const all = yield* totals
      assert.deepStrictEqual(
        [all.turns, all.toolCalls, all.inputTokens, all.outputTokens, all.cost],
        [2, 2, 30, 3, Option.none()]
      )
      // The entry is a Schema: it round-trips through JSON as recorded.
      const json = Schema.toCodecJson(Schema.Array(RunLedger.Entry))
      assert.deepStrictEqual(Schema.decodeUnknownSync(json)(Schema.encodeSync(json)(entries)), entries)
    }).pipe(Effect.provide(RunLedger.layer))
  )

  it.effect("a child's turns are the child's: one ledger, two session ids, and a run view that does not mix them", () =>
    Effect.gen(function* () {
      // The child runs inside the parent's tool, under the parent's context,
      // and so writes to the same ledger -- under its own session and run.
      // The parent's run view is the parent's two turns and no more.
      const child = yield* TestLanguageModel.script([{ text: "child answer", usage: { input: 5, output: 5 } }])
      const Delegate = Tool.make("delegate", { parameters: Schema.Struct({}), success: Schema.String })
      const childSession = yield* Ref.make<Option.Option<string>>(Option.none())
      const delegate = Agent.tool(Delegate, () =>
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* AgentSession.make(Agent.make({}))
            yield* Ref.set(childSession, Option.some(session.id))
            return (yield* AgentSession.prompt(session, "q")).text
          })
        ).pipe(Effect.provide(child.layer), Effect.orDie)
      )
      const parent = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "d1", name: "delegate", params: {} }], usage: { input: 100, output: 1 } },
        { text: "parent answer", usage: { input: 200, output: 2 } }
      ])
      const parentSession = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({ tools: [delegate] }))
          yield* AgentSession.prompt(session, "go")
          return session.id
        })
      ).pipe(Effect.provide(parent.layer))

      const entries = yield* ledger
      const childId = Option.getOrThrow(yield* Ref.get(childSession))
      assert.notStrictEqual(childId, parentSession)
      assert.deepStrictEqual(
        entries.map((entry) => [entry.sessionId === parentSession ? "parent" : entry.sessionId === childId ? "child" : "?", entry.turnIndex, entry.inputTokens]),
        [["child", 1, 5], ["parent", 1, 100], ["parent", 2, 200]]
      )
      const parentRun = entries.find((entry) => entry.sessionId === parentSession)!.runId
      const view = yield* Effect.flatMap(RunLedger.RunLedger, (l) => l.run(parentRun))
      assert.deepStrictEqual([view.turns, view.inputTokens, view.toolCalls], [2, 300, 1])
      assert.strictEqual((yield* totals).inputTokens, 305)
    }).pipe(Effect.provide(RunLedger.layer))
  )

  it.effect("a turn is recorded once: the same occurrence written twice is one entry", () =>
    Effect.gen(function* () {
      // The property a durable replay relies on, checked at the service so it
      // holds whoever writes. `Budget` keys its charges the same way.
      const l = yield* RunLedger.RunLedger
      const entry: RunLedger.Entry = {
        sessionId: "s", submissionId: "s:submission-1", runId: "s:run-1", turnIndex: 1,
        toolCalls: 1, inputTokens: 10, outputTokens: 2, cost: Option.some(0.5), elapsedMillis: 7
      }
      yield* l.record(entry)
      yield* l.record({ ...entry, inputTokens: 999 })
      yield* l.record({ ...entry, turnIndex: 2, cost: Option.none() })
      const all = yield* l.totals
      assert.deepStrictEqual([all.turns, all.inputTokens, all.cost], [2, 20, Option.some(0.5)])
      assert.deepStrictEqual(RunLedger.sum([]), {
        turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cost: Option.none(), elapsedMillis: 0
      })
    }).pipe(Effect.provide(RunLedger.layer))
  )

  it.effect("the same write charges the budget and prices the turn when a table can", () =>
    Effect.gen(function* () {
      // One engine call feeds both. $1 per million input tokens: a turn of a
      // million is a cost of 1 in the ledger and on the budget alike.
      const priced = ModelCapabilities.fromTable({
        test: { "priced-model": { contextWindow: 200_000, maxOutputTokens: 64_000, cost: { input: 1, output: 10 } } }
      })
      const { layer: model } = yield* TestLanguageModel.script([{ text: "done", usage: { input: 1_000_000 } }])
      yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(Agent.make({})), (session) => AgentSession.prompt(session, "go"))
      ).pipe(Effect.provide(Layer.mergeAll(model, priced, Model.make("test", "priced-model", Layer.empty))))
      const [entry] = yield* ledger
      assert.deepStrictEqual(entry!.cost, Option.some(1))
      assert.strictEqual(yield* Effect.flatMap(Budget.Budget, (b) => b.costSpent), 1)
      assert.strictEqual(yield* Effect.flatMap(Budget.Budget, (b) => b.spent), 1_000_000)
    }).pipe(Effect.provide(Layer.merge(RunLedger.layer, Budget.layer)))
  )

  it.effect("without a ledger in context nothing is recorded and nothing fails", () =>
    Effect.gen(function* () {
      const { layer: model } = yield* TestLanguageModel.script([{ text: "done" }])
      const result = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(Agent.make({})), (session) => AgentSession.prompt(session, "go"))
      ).pipe(Effect.provide(model))
      assert.strictEqual(result.text, "done")
    })
  )
})
