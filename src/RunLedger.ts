import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import * as Budget from "./budget/Budget.js"
import * as ModelCapabilities from "./model/ModelCapabilities.js"

/**
 * The engine records facts; seams only decide.
 *
 * After every turn the engine writes one `Entry` here -- which run, which
 * turn, how many tool calls, how many tokens, what they cost when a
 * `ModelCapabilities` in context prices the model, and how long the run had
 * been going -- and nothing here decides anything. The loop combinators, the
 * budget ceilings and the context tools *read*; a cross-cutting rule becomes
 * one sentence about what is recorded rather than a property every
 * combinator has to get right on its own:
 *
 * - "a child's turns are the child's": every entry carries the session that
 *   ran it, and a delegated child, running under its parent's context, writes
 *   to the same ledger under its own session id;
 * - "a new context window does not replenish the budget": the ledger is
 *   keyed by run and turn, and a compaction writes nothing here;
 * - "a replayed turn costs what it cost the first time": an entry is keyed
 *   by its `Budget.Occurrence`, and a second write for the same key is
 *   dropped.
 *
 * `AgentLoop.State`'s `turnIndex`, `toolCallsTotal` and `elapsed` are the
 * same facts as this ledger's run view, and `test/RunLedger.test.ts` holds
 * them equal after every turn. The state is built by the engine from its own
 * counters so a session with no ledger in context still has a loop to ask;
 * the ledger is the place those counters can be *read back* from, by
 * anything, after the fact.
 *
 * Optional, like `Budget`: nothing is recorded without a `RunLedger` in
 * context, and the engine pays one context read per turn without one. The
 * `Budget` is charged by the same write (`record` is the one thing the
 * engine calls), so a session under a budget and a ledger records each turn
 * once to both.
 *
 * `plan-context-lessons.md` 5.1, item 60g. Not a policy object: facts only.
 */

/** One turn, as the engine saw it end. */
export const Entry = Schema.Struct({
  sessionId: Schema.String,
  submissionId: Schema.String,
  runId: Schema.String,
  /** 1-based index of the turn within its run. */
  turnIndex: Schema.Natural,
  /** Calls this harness executed for the turn; provider-executed calls excluded. */
  toolCalls: Schema.Natural,
  inputTokens: Schema.Natural,
  outputTokens: Schema.Natural,
  /** Priced from the model's own row when a `ModelCapabilities` in context prices it; absent otherwise. */
  cost: Schema.Option(Schema.Number),
  /** Wall-clock milliseconds since the run started, at the turn's end. Not replay-stable; see `AgentLoop.State.elapsed`. */
  elapsedMillis: Schema.Natural
})
export type Entry = typeof Entry.Type

/** What the entries of one run, or of the whole ledger, add up to. */
export interface Totals {
  readonly turns: number
  readonly toolCalls: number
  readonly inputTokens: number
  readonly outputTokens: number
  /** The sum of every priced turn; `None` when no turn was priced. */
  readonly cost: Option.Option<number>
  /** The latest `elapsedMillis` recorded, 0 for no entries. */
  readonly elapsedMillis: number
}

export class RunLedger extends Context.Service<RunLedger, {
  /** Append one turn. A second entry for the same run and turn is dropped. */
  readonly record: (entry: Entry) => Effect.Effect<void>
  /** Every entry recorded, in the order recorded. */
  readonly entries: Effect.Effect<ReadonlyArray<Entry>>
  /** The entries of one run, added up. */
  readonly run: (runId: string) => Effect.Effect<Totals>
  /** Every entry, added up. */
  readonly totals: Effect.Effect<Totals>
}>()("affe-agent/RunLedger") {}

const empty: Totals = {
  turns: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cost: Option.none(),
  elapsedMillis: 0
}

/** Fold entries into totals. Exported so a reader of `entries` can add up its own selection. */
export const sum = (entries: Iterable<Entry>): Totals => {
  let totals = empty
  for (const entry of entries) {
    totals = {
      turns: totals.turns + 1,
      toolCalls: totals.toolCalls + entry.toolCalls,
      inputTokens: totals.inputTokens + entry.inputTokens,
      outputTokens: totals.outputTokens + entry.outputTokens,
      cost: Option.isSome(entry.cost)
        ? Option.some(Option.getOrElse(totals.cost, () => 0) + entry.cost.value)
        : totals.cost,
      elapsedMillis: Math.max(totals.elapsedMillis, entry.elapsedMillis)
    }
  }
  return totals
}

const make: Effect.Effect<RunLedger["Service"]> = Effect.gen(function* () {
  const state = yield* Ref.make<{
    readonly entries: ReadonlyArray<Entry>
    readonly seen: ReadonlySet<Budget.Occurrence>
  }>({ entries: [], seen: new Set() })
  return {
    // One `Ref.modify`, for the reason `Budget`'s charge is one: two turns
    // settling concurrently must not both find the key absent.
    record: (entry) =>
      Ref.update(state, (current) => {
        const key = Budget.occurrence(entry)
        if (current.seen.has(key)) return current
        return { entries: [...current.entries, entry], seen: new Set(current.seen).add(key) }
      }),
    entries: Effect.map(Ref.get(state), (current) => current.entries),
    run: (runId) =>
      Effect.map(Ref.get(state), (current) => sum(current.entries.filter((entry) => entry.runId === runId))),
    totals: Effect.map(Ref.get(state), (current) => sum(current.entries))
  }
})

/**
 * A fresh ledger. Where it is provided is its scope, exactly as for
 * `Budget.layer`: per session, per application, or -- under `/durable` --
 * outside the workflow, so a replay finds the entries it already wrote.
 */
export const layer: Layer.Layer<RunLedger> = Layer.effect(RunLedger, Effect.suspend(() => make))

/** A ledger built anew every time it is provided; see `Budget.fresh` for why one value is not that. */
export const fresh = (): Layer.Layer<RunLedger> => Layer.effect(RunLedger, Effect.suspend(() => make))

/**
 * What the engine calls after every turn, before the loop is asked: write
 * the turn to the ambient `RunLedger`, if any, and charge the ambient
 * `Budget`, if any. The one recording call the engine makes, so a fact is
 * never recorded to one and not the other.
 */
export const record = (turn: {
  readonly sessionId: string
  readonly submissionId: string
  readonly runId: string
  readonly turnIndex: number
  readonly toolCalls: number
  readonly elapsedMillis: number
  readonly response: LanguageModel.GenerateTextResponse<any, true>
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Budget.record(turn)
    const ledger = yield* Effect.serviceOption(RunLedger)
    if (Option.isNone(ledger)) return
    const capabilities = yield* Effect.serviceOption(ModelCapabilities.ModelCapabilities)
    const cost = Option.isSome(capabilities)
      ? yield* ModelCapabilities.priceOfCurrent(turn.response.usage).pipe(
        Effect.provideService(ModelCapabilities.ModelCapabilities, capabilities.value),
        Effect.option
      )
      : Option.none<number>()
    yield* ledger.value.record({
      sessionId: turn.sessionId,
      submissionId: turn.submissionId,
      runId: turn.runId,
      turnIndex: turn.turnIndex,
      toolCalls: turn.toolCalls,
      inputTokens: turn.response.usage.inputTokens.total ?? 0,
      outputTokens: turn.response.usage.outputTokens.total ?? 0,
      cost,
      elapsedMillis: turn.elapsedMillis
    })
  })
