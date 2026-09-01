import { Context, Effect, Layer, Ref } from "effect"
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

/** Total tokens in one model response, both directions. */
const tokensOf = <Tools extends Record<string, Tool.Any>>(
  response: LanguageModel.GenerateTextResponse<Tools, true>
): number => (response.usage.inputTokens.total ?? 0) + (response.usage.outputTokens.total ?? 0)

/**
 * A session's cumulative token spend. Provided as a Layer, so where you provide
 * it decides the scope: per session (an independent cap per conversation) or
 * once for the whole application (a shared pool).
 */
export class Budget extends Context.Service<Budget, {
  /** Add a turn's tokens to the running total and return the new total. */
  readonly spend: (tokens: number) => Effect.Effect<number>
  /** The tokens spent so far. */
  readonly spent: Effect.Effect<number>
  /**
   * Add a turn's cost to the running total and return the new total.
   *
   * A second counter rather than a second service: a token ceiling and a money
   * ceiling are two readings of the same session's spend, and one `Budget`
   * layer is what makes "provide it per session or per application" mean the
   * same thing for both. `within` and `cost` may be used together on one
   * agent, each capping its own axis.
   */
  readonly spendCost: (amount: number) => Effect.Effect<number>
  /** The cost spent so far, in the caller's own unit. */
  readonly costSpent: Effect.Effect<number>
}>()("@doeixd/effect-agent/budget/Budget") {}

/** A fresh, zeroed budget. Provide per session for a per-conversation cap. */
export const layer: Layer.Layer<Budget> = Layer.effect(
  Budget,
  Effect.gen(function* () {
    const total = yield* Ref.make(0)
    const money = yield* Ref.make(0)
    return {
      spend: (tokens) => Ref.updateAndGet(total, (n) => n + tokens),
      spent: Ref.get(total),
      spendCost: (amount) => Ref.updateAndGet(money, (n) => n + amount),
      costSpent: Ref.get(money)
    }
  })
)

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
  AgentLoop.make((state) =>
    Effect.flatMap(Budget, (budget) =>
      Effect.flatMap(budget.spend(tokensOf(state.response)), (total) =>
        total >= limit ? Effect.succeed(AgentLoop.Stop) : inner.decide(state)
      )
    )
  )

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
  AgentLoop.make((state) =>
    Effect.gen(function*() {
      const price = yield* ModelCapabilities.priceOfCurrent(state.response.usage)
      const budget = yield* Budget
      // Recorded before the ceiling is checked and before `inner` runs, so
      // every turn counts regardless of what `inner` decides -- the same
      // ordering `within` relies on, and for the same reason.
      const total = yield* budget.spendCost(price)
      return total >= limit ? AgentLoop.Stop : yield* inner.decide(state)
    })
  )
