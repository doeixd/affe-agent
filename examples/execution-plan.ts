import { Config, Effect, ExecutionPlan, Layer, Schedule } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"

/**
 * Provider fallback: try one model, then another.
 *
 * Typechecked, not executed — running it needs live credentials. Its job is to
 * show the property that makes `withExecutionPlan` worth having rather than
 * merely possible: **the agent still names no provider**, and the compiler
 * knows it no longer needs one.
 */

/**
 * Two rungs of the same ladder.
 *
 * In a real deployment these would be different providers; using two Anthropic
 * models keeps the example to one dependency while the shape stays honest —
 * every step is a `Layer` providing a `LanguageModel`, whatever builds it.
 */
const anthropic = AnthropicClient.layerConfig({
  apiKey: Config.redacted("ANTHROPIC_API_KEY")
}).pipe(Layer.provide(FetchHttpClient.layer))

const primary = AnthropicLanguageModel.layer({
  model: "claude-sonnet-4-5"
}).pipe(Layer.provide(anthropic))

const secondary = AnthropicLanguageModel.layer({
  model: "claude-haiku-4-5"
}).pipe(Layer.provide(anthropic))

/**
 * The ladder.
 *
 * `attempts` and `schedule` are per step: the primary is worth retrying twice
 * with backoff, because the failures a good provider has are usually transient.
 * The fallback gets one attempt — if it is also down, failing is more useful
 * than continuing to wait.
 */
const plan = ExecutionPlan.make(
  {
    provide: primary,
    attempts: 3,
    schedule: Schedule.exponential("200 millis")
  },
  { provide: secondary }
)

const Researcher = Agent.make({
  instructions: "Research carefully and cite evidence.",
  loop: AgentLoop.bounded(20)
}).pipe(Agent.withExecutionPlan(plan))

/**
 * Note what is *not* here: no `Effect.provide(someModel)`.
 *
 * The combinator discharges `LanguageModel`, so the requirement is gone from
 * the type as well as from the runtime — the plan names every model, and it is
 * supplied at the edge exactly as a layer would be.
 *
 * The assertion below is what actually checks that. Merely *compiling* proves
 * nothing here: an exported `Effect` may carry requirements nobody has met yet,
 * so this file would compile just as happily without the plan, with
 * `LanguageModel` sitting unsatisfied in `R`. Naming `R` is the only way to
 * tell the two apart.
 */
export const program = Effect.scoped(
  Effect.flatMap(AgentSession.make(Researcher), (session) =>
    AgentSession.prompt(session, "Research Effect AI.")
  )
)

// --- Type assertions -------------------------------------------------------
// Compile-time only, in the style of `typed-agent.ts`, and for the same
// reason: the code above would look correct either way.

type Assert<T extends true> = T
type Requirements = typeof program extends Effect.Effect<any, any, infer R>
  ? R
  : never

/**
 * The claim, stated so the compiler can refuse it.
 *
 * Remove `Agent.withExecutionPlan(plan)` above and this line fails: `R` becomes
 * `LanguageModel.LanguageModel` and the program needs a model the plan was
 * supposed to have supplied.
 */
export type _NeedsNoModel = Assert<[Requirements] extends [never] ? true : false>

/**
 * What a plan is *not* for: choosing a model by cost.
 *
 * An `ExecutionPlan` is failure-driven — it moves to the next step because the
 * current one failed. "This run has spent enough, use the cheap model" is a
 * decision taken *before* the call, when nothing has failed, and no plan
 * expresses it.
 *
 * It needs no new API either. A `LanguageModel` layer built from an effect that
 * reads whatever holds the budget is ordinary wiring:
 *
 * ```ts
 * const byBudget = Layer.unwrap(
 *   Effect.map(Budget, (budget) =>
 *     budget.spent > 100_000 ? secondary : primary
 *   )
 * )
 * ```
 *
 * The two compose: a budget-chosen model can still sit at the top of a ladder
 * that falls back when it fails.
 */
