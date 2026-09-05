import { Context, Effect, Layer, Option, Ref } from "effect"
import type { LanguageModel, Tool } from "effect/unstable/ai"
import * as AgentLoop from "../AgentLoop.js"
import * as ModelCapabilities from "../model/ModelCapabilities.js"

/**
 * Budget enforcement (design-review E1).
 *
 * A ceiling on what a session is allowed to spend, enforced through the existing
 * loop seam -- not a new runtime. Token and turn ceilings otherwise show up only
 * as eval *assertions* (`Evals.tokens` / `Evals.turns`) and `AgentLoop.bounded`;
 * this makes them an *enforcement* capability an agent carries at run time.
 *
 * The pieces are ordinary:
 *
 * - **`Budget`** -- a `Context.Service` holding this session's cumulative token
 *   spend in a `Ref`. Because it is a Layer you provide, the *scope* is yours:
 *   one `Budget.layer` per session caps each conversation independently; one
 *   shared layer caps a whole application against a single pool.
 * - **`within`** -- wraps an inner loop with a token ceiling: it records every
 *   turn's usage against the `Budget` and then either stops (ceiling reached) or
 *   defers to the inner policy. Use it as the outermost loop:
 *   `Budget.within(50_000, AgentLoop.untilIdle())`.
 *
 * The check runs *after* each turn, so the turn that crosses the ceiling is the
 * last one and no further turn is started -- fail-closed on spend, without ever
 * interrupting a turn mid-flight.
 *
 * `within` wraps rather than composes with `AgentLoop.and` on purpose: `and`
 * short-circuits on the first `Stop`, so a bare budget policy placed after
 * `untilIdle` would miss the usage of the very turn that ends the run. Wrapping
 * makes the recording unconditional and independent of composition order.
 */

/** Named once, so `RunCompleted.stopReason` says which ceiling it was. */
const tokenStop = AgentLoop.stop("token budget")
const costStop = AgentLoop.stop("cost budget")

/** Total tokens in one model response, both directions. */
const tokensOf = (
  response: LanguageModel.GenerateTextResponse<any, true>
): number => (response.usage.inputTokens.total ?? 0) + (response.usage.outputTokens.total ?? 0)

/**
 * A session's cumulative token spend. Provided as a Layer, so where you provide
 * it decides the scope: per session (an independent cap per conversation) or
 * once for the whole application (a shared pool).
 */
/**
 * What a charge is *for*: one turn of one run, named so it can be recognised.
 *
 * A durable submission replays its loop. The model is not asked again -- the
 * journal answers -- but the *policy* decides again, on a response it has
 * already been paid for. So a charge has to be idempotent, and the only way to
 * know two charges are the same one is to name what they are for.
 *
 * `AgentLoop.State` already states the rule this obeys. `toolCallsTotal` is
 * accumulated by the engine "so a ceiling on it is a pure function of the state
 * -- and holds under a durable replay, where the loop runs again from the
 * journal and a `Ref` a policy kept would start from zero". This service is
 * that `Ref`. Keying the charge is how it stops being the exception.
 *
 * A semantic coordinate rather than a counter, for the reason `DeliveryLog`'s
 * key is one: a counter is not stable under replay.
 */
export type Occurrence = string

/**
 * The coordinate for a turn: the run it belongs to, and its place in that run.
 *
 * A run id carries the session that minted it (`internal/ids.ts`), which is
 * what makes this key safe for a `Budget` that spans sessions -- "once for
 * the whole application" is one of the two scopes `layer` documents. It was
 * not always so: keyed on a per-session `run-N`, two sessions sharing a
 * budget collided on their first turns and the second's charges were dropped
 * as replays, found when a delegated child silently erased its parent's own
 * turns. `Budget.test` keeps the two-session row that found it.
 */
export const occurrence = (state: {
  readonly runId: string
  readonly turnIndex: number
}): Occurrence => `${state.runId}:${state.turnIndex}`

export class Budget extends Context.Service<Budget, {
  /**
   * Add a turn's tokens to the running total and return the new total.
   *
   * `occurrence` names the turn being charged. A second charge for a turn
   * already counted is dropped and the unchanged total returned, so a replayed
   * turn costs what it cost the first time.
   */
  readonly spend: (tokens: number, occurrence: Occurrence) => Effect.Effect<number>
  /** The tokens spent so far. */
  readonly spent: Effect.Effect<number>
  /**
   * Add a turn's cost to the running total and return the new total.
   *
   * A second counter rather than a second service: a token ceiling and a money
   * ceiling are two readings of the same session's spend, and one `Budget`
   * layer is what makes "provide it per session or per application" mean the
   * same thing for both. `within` and `cost` may be used together on one
   * agent, each capping its own axis -- and each remembers its own
   * occurrences, so an agent using both charges one turn once on each.
   */
  readonly spendCost: (amount: number, occurrence: Occurrence) => Effect.Effect<number>
  /** The cost spent so far, in the caller's own unit. */
  readonly costSpent: Effect.Effect<number>
}>()("affe-agent/budget/Budget") {}

/**
 * A fresh, zeroed budget. Provide per session for a per-conversation cap.
 *
 * **Under `/durable`, provide it outside the workflow.** Built inside, it is
 * rebuilt on every replay and starts from zero, so a submission that suspends
 * often enough never reaches any ceiling -- which is the failure
 * `AgentLoop.State` warns about. Built outside, one counter spans the
 * conversation, and the occurrence keys are what stop a replayed turn being
 * charged against it twice.
 */
export const layer: Layer.Layer<Budget> = Layer.effect(Budget, Effect.suspend(() => make))

/**
 * A budget layer that is built anew every time it is provided.
 *
 * `layer` is one value, and `Effect.provide` builds a layer in the fibre's
 * inherited memo map -- so providing `layer` inside a scope that already
 * provided it further up hands back the *same* counter. That is right for
 * an application sharing one budget, and wrong for the one caller that
 * wants a counter nobody else reads: a delegated child under
 * `inherit.budget: false`, which `Subagent` found charging its parent
 * through exactly this sharing. A fresh layer object per call is a fresh
 * memo key.
 */
export const fresh = (): Layer.Layer<Budget> => Layer.effect(Budget, Effect.suspend(() => make))

const make: Effect.Effect<Budget["Service"]> = Effect.gen(function* () {
    const counted = yield* Ref.make({
      total: 0,
      money: 0,
      tokenTurns: new Set<Occurrence>(),
      costTurns: new Set<Occurrence>()
    })

    /**
     * Charge once per turn, per axis.
     *
     * One `Ref.modify` rather than a read and then a write: two turns settling
     * concurrently would otherwise both find the occurrence absent and both
     * charge, which is the same bug this exists to fix arriving by a different
     * road.
     */
    const charge = (
      amount: number,
      key: Occurrence,
      axis: "tokens" | "cost"
    ): Effect.Effect<number> =>
      Ref.modify(counted, (state) => {
        const seen = axis === "tokens" ? state.tokenTurns : state.costTurns
        const running = axis === "tokens" ? state.total : state.money
        if (seen.has(key)) return [running, state]
        const next = running + amount
        const marked = new Set(seen).add(key)
        return [
          next,
          axis === "tokens"
            ? { ...state, total: next, tokenTurns: marked }
            : { ...state, money: next, costTurns: marked }
        ]
      })

    return {
      spend: (tokens, key) => charge(tokens, key, "tokens"),
      spent: Effect.map(Ref.get(counted), (state) => state.total),
      spendCost: (amount, key) => charge(amount, key, "cost"),
      costSpent: Effect.map(Ref.get(counted), (state) => state.money)
    }
  })

/**
 * Wrap `inner` with a token ceiling: record each turn's usage against the
 * ambient `Budget`, then stop the run if the cumulative total has reached
 * `limit`, otherwise defer to `inner`.
 *
 * Because recording happens before the ceiling is checked and before `inner`
 * runs, every turn is counted regardless of what `inner` decides -- so a budget
 * shared across a submission's follow-up runs (or across sessions, if you
 * provide one layer) caps the whole conversation, not just a single run.
 *
 * ```ts
 * const agent = Agent.make({ loop: Budget.within(50_000, AgentLoop.untilIdle()) })
 * // ...provide Budget.layer at the session.
 * ```
 */
export const within = <E, R, Tools extends Record<string, Tool.Any>>(
  limit: number,
  inner: AgentLoop.AgentLoop<E, R, Tools>
): AgentLoop.AgentLoop<E, R | Budget, Tools> =>
  AgentLoop.make(
    (state) =>
      // A pure decision over the running total: the turn that just ended has
      // already been recorded by the engine (`record`), so `spent` includes it
      // and the ceiling is checked after every turn is counted.
      Effect.flatMap(Budget, (budget) =>
        Effect.map(budget.spent, (total) => (total >= limit ? tokenStop : undefined)).pipe(
          Effect.flatMap((stop) => (stop === undefined ? inner.decide(state) : Effect.succeed(stop)))
        )
      ),
    { _tag: "Custom", name: "Budget.within", details: { limit }, inner: inner.description }
  )

/**
 * Record one turn against the ambient `Budget`, if there is one.
 *
 * **Called by the engine after every turn, before the loop is asked.** Not
 * by a loop combinator, and the reason is what `plan-after-seams.md` 2.4
 * found: a loop is per session, so a combinator that both recorded and
 * decided charged only the turns of the session it wrapped, and a delegated
 * child -- a session of its own, running under the parent's context -- was
 * charged to nobody. With the engine recording, a session under a `Budget`
 * is counted whether or not anything reads the count, a child charges the
 * parent's counter because it runs under the parent's context and for no
 * other reason, and `within` and `cost` are what the docs already said a
 * loop combinator is: a pure function of state.
 *
 * Idempotent per turn through the occurrence key, so a replayed turn costs
 * what it cost the first time. Nothing is recorded without a `Budget` in
 * context, and a session that never provides one pays one context read per
 * turn.
 *
 * Tokens are always recorded. Cost is recorded when a `ModelCapabilities` in
 * context prices the model, and **not otherwise** -- the opposite of
 * `cost`'s rule, deliberately. `cost` fails an unpriced model because its
 * caller declared a money ceiling and silently counting zero would void it.
 * Recording has no ceiling of its own and cannot know whether money is being
 * watched: a table may be in context for the context-window check, and
 * failing every turn under it on an unlisted model would be a worse silence
 * than the one it avoids. So the failure stays with the ceiling: `cost`
 * prices the turn itself, and fails if it cannot.
 */
export const record = (state: {
  readonly runId: string
  readonly turnIndex: number
  readonly response: LanguageModel.GenerateTextResponse<any, true>
}): Effect.Effect<void> =>
  Effect.flatMap(Effect.serviceOption(Budget), (budget) => {
    if (Option.isNone(budget)) return Effect.void
    const key = occurrence(state)
    return Effect.gen(function*() {
      yield* budget.value.spend(tokensOf(state.response), key)
      const capabilities = yield* Effect.serviceOption(ModelCapabilities.ModelCapabilities)
      if (Option.isSome(capabilities)) {
        const price = yield* ModelCapabilities.priceOfCurrent(state.response.usage).pipe(
          Effect.provideService(ModelCapabilities.ModelCapabilities, capabilities.value),
          Effect.option
        )
        if (Option.isSome(price)) yield* budget.value.spendCost(price.value, key)
      }
    })
  })

/**
 * Wrap `inner` with a **money** ceiling: price each turn from the model's own
 * row, record it against the ambient `Budget`, then stop the run if the
 * cumulative cost has reached `limit`.
 *
 * The same combinator as `within` and the same fail-closed timing -- the turn
 * that crosses the ceiling is the last one, and no further turn is started, so
 * a run is never interrupted mid-flight. What differs is the unit.
 *
 * ```ts
 * const agent = Agent.make({ loop: Budget.cost(5, AgentLoop.untilIdle()) })
 * // ...provide Budget.layer and ModelCapabilities.builtin at the session.
 * ```
 *
 * `limit` is in whatever unit the capability table keeps its prices in --
 * dollars, cents, credits. This library does not know which, and says so
 * rather than picking one: `Capabilities.cost` is documented the same way, and
 * a table in cents with a limit in dollars is an error no type could catch.
 *
 * Two consequences worth stating rather than discovering:
 *
 * - **A model with no prices fails the run** with `UnpricedModelError`, naming
 *   the model. The alternative -- treating an unpriced model as free -- turns a
 *   money ceiling into no ceiling at exactly the moment it matters, and does it
 *   silently. A caller who wants the run to continue regardless should cap on
 *   tokens with `within`.
 * - **This accumulates in floating point.** It is a ceiling check, not a
 *   ledger: a fraction of a cent of drift over a long conversation does not
 *   change whether a limit was reached, and a caller doing real accounting
 *   should read `Response.Usage` and bill from it. Said here because a number
 *   called `cost` invites being mistaken for an invoice.
 */
export const cost = <E, R, Tools extends Record<string, Tool.Any>>(
  limit: number,
  inner: AgentLoop.AgentLoop<E, R, Tools>
): AgentLoop.AgentLoop<
  E | ModelCapabilities.UnknownModelError
    | ModelCapabilities.UnknownCurrentModelError
    | ModelCapabilities.UnpricedModelError,
  R | Budget | ModelCapabilities.ModelCapabilities,
  Tools
> =>
  AgentLoop.make(
    (state) =>
      Effect.gen(function*() {
        // The failure rule is the ceiling's: a model this table cannot price,
        // under a money ceiling, fails the run rather than counting as free.
        // The engine's `record` skipped it for exactly that reason, so this is
        // where an unpriced model is caught.
        yield* ModelCapabilities.priceOfCurrent(state.response.usage)
        const budget = yield* Budget
        // Already recorded by the engine for this turn; a pure decision.
        const total = yield* budget.costSpent
        return total >= limit ? costStop : yield* inner.decide(state)
      }),
    { _tag: "Custom", name: "Budget.cost", details: { limit }, inner: inner.description }
  )
