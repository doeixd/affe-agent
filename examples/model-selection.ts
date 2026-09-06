/**
 * Capability-driven model selection — an example, deliberately not a feature.
 *
 * `plan-model-capabilities.md` §4.5 and `plan-execution-plan.md` both settle
 * the same point, from different directions: choosing a model *before* the call
 * is ordinary wiring, not a mechanism the library should own.
 *
 * An `ExecutionPlan` is the wrong tool for it. A plan is **failure-driven** —
 * it moves to the next step because the current one failed — while "this
 * prompt has an image in it, so use the model that can see" is a decision taken
 * when nothing has failed at all. What that decision actually needs is a
 * `LanguageModel` layer built from an effect that reads a service and returns
 * one model or another, which is `Layer.unwrap` over layers that already exist.
 *
 * So this file adds no API. It is here because the *absence* of an API is
 * easier to trust when someone has shown the wiring once.
 *
 * Two selectors are shown, because they answer different questions:
 *
 *  1. **by capability** — the prompt needs vision, so pick a model with it;
 *  2. **by budget** — enough has been spent, so step down to a cheaper one.
 *
 * Both are the same shape: an `Effect` that returns a `Layer`, unwrapped.
 */
import { Config, Effect, Layer } from "effect"
import { Prompt } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { Budget } from "../src/budget/index.js"
import * as ModelCapabilities from "../src/model/ModelCapabilities.js"

// ---------------------------------------------------------------------------
// The models, as ordinary layers
// ---------------------------------------------------------------------------

const client = AnthropicClient.layerConfig({
  apiKey: Config.redacted("ANTHROPIC_API_KEY")
}).pipe(Layer.provide(FetchHttpClient.layer))

/** Cheap and fast. */
const haiku = AnthropicLanguageModel.model("claude-haiku-4-5").pipe(Layer.provide(client))

/** Expensive and capable. */
const sonnet = AnthropicLanguageModel.model("claude-sonnet-4-5").pipe(Layer.provide(client))

// ---------------------------------------------------------------------------
// 1. Selection by capability
// ---------------------------------------------------------------------------

/** Does this prompt contain anything a text-only model could not read? */
const needsVision = (prompt: Prompt.Prompt): boolean =>
  prompt.content.some((message) =>
    message.role !== "system" &&
    message.content.some((part) => part.type === "file" && part.mediaType.startsWith("image/"))
  )

/**
 * Pick the model from the work, not from a failure.
 *
 * `Layer.unwrap` is the whole mechanism: the effect runs once when the layer is
 * built, reads whatever it needs, and returns the layer to use. Nothing here
 * knows about agents.
 *
 * Note what this does *not* do: it does not ask the capability table which
 * models have vision and choose one. Selecting from a table would make the
 * table load-bearing for correctness, and a row that is merely missing would
 * silently change which model runs. The table's job is to answer questions
 * about a *named* model — `ModelCapabilities.preflight` uses it that way, to
 * refuse work the chosen model cannot do. Choosing stays explicit.
 */
export const byCapability = (prompt: Prompt.Prompt) =>
  needsVision(prompt) ? sonnet : haiku

// ---------------------------------------------------------------------------
// 2. Selection by budget
// ---------------------------------------------------------------------------

/**
 * Step down to the cheap model once the session has spent enough.
 *
 * The correction `plan-execution-plan.md` records, made concrete: this reads
 * `Budget` at layer-construction time and picks. An `ExecutionPlan` could not
 * express it, because nothing has failed.
 */
export const byBudget = (stepDownAt: number) =>
  Layer.unwrap(
    Effect.map(
      Effect.flatMap(Budget.Budget, (budget) => budget.spent),
      (spent) => (spent >= stepDownAt ? haiku : sonnet)
    )
  )

// ---------------------------------------------------------------------------
// Using them
// ---------------------------------------------------------------------------

/**
 * The agent names no model, as always. What changes between these two runs is
 * only which layer is provided — the definition is identical.
 */
const Assistant = Agent.make({
  instructions: "Answer briefly.",
  loop: AgentLoop.bounded(8),
  // Refuses an image against a text-only model *before* the call, naming both.
  // Selection above tries to make that unnecessary; this is what catches the
  // case where a caller wired the cheap model by hand anyway.
  contextTransform: ModelCapabilities.preflight()
})

const question = Prompt.make([{ role: "user", content: [{ type: "text", text: "Summarise Effect." }] }])

export const main = Agent.run(Assistant, question).pipe(
  Effect.tap((result) => Effect.log(result.text)),
  Effect.provide(
    Layer.mergeAll(
      byCapability(question),
      // The table `preflight` consults. `builtin` covers Anthropic; a
      // deployment naming models through a gateway builds its own with
      // `ModelCapabilities.fromTable`.
      ModelCapabilities.builtin
    )
  )
)

/**
 * The budget-driven variant, for reference. Not run: it needs a `Budget`
 * layer whose scope is a decision the caller makes — per session for a
 * per-conversation cap, or one shared layer for a whole application.
 */
export const budgeted = Agent.run(Assistant, question).pipe(
  Effect.provide(
    // `provideMerge`, not `mergeAll`: `byBudget` *reads* `Budget`, and
    // `mergeAll` builds its arguments in parallel, so a `Budget.layer` sitting
    // beside it would not satisfy it. The Effect language service says so
    // outright, which is the kind of wiring mistake that is otherwise found at
    // run time.
    Layer.mergeAll(byBudget(100_000), ModelCapabilities.builtin).pipe(
      Layer.provideMerge(Budget.layer)
    )
  )
)

