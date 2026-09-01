/**
 * The "generate, evaluate, maybe regenerate" chain, twice — once at each level,
 * because the two levels answer different questions.
 *
 * `generateMarketingCopy` is the plain version: three sequential model calls,
 * no tools, nothing looping on the model's own decisions. `LanguageModel` is
 * the right level for that, and an `AgentSession` would buy nothing.
 *
 * `Critic` is the version that needs the kernel: an agent that may use tools
 * and take steering, and must still end in a typed value. That is what
 * `AgentOutput` is for — see `docs/plan-structured-output.md`.
 *
 * Neither names a model. It arrives as a Layer at the bottom of the file, so
 * the same functions run against a test double.
 */
import { Config, Effect, Layer, Option, Schema } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import * as Agent from "../src/Agent.js"
import * as AgentOutput from "../src/AgentOutput.js"

const Score = Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 10 }))

const QualityMetrics = Schema.Struct({
  hasCallToAction: Schema.Boolean,
  emotionalAppeal: Score,
  clarity: Score
})

type QualityMetrics = typeof QualityMetrics.Type

const passes = (metrics: QualityMetrics) =>
  metrics.hasCallToAction && metrics.emotionalAppeal >= 7 && metrics.clarity >= 7

/** Only the failing dimensions become instructions. */
const fixesFor = (metrics: QualityMetrics) =>
  [
    metrics.hasCallToAction ? undefined : "- A clear call to action",
    metrics.emotionalAppeal < 7 ? "- Stronger emotional appeal" : undefined,
    metrics.clarity < 7 ? "- Improved clarity and directness" : undefined
  ].filter((line) => line !== undefined)

// ---------------------------------------------------------------------------
// The plain chain: three calls, no session
// ---------------------------------------------------------------------------

export const generateMarketingCopy = Effect.fn("generateMarketingCopy")(
  function*(input: string) {
    const first = yield* LanguageModel.generateText({
      prompt:
        `Write persuasive marketing copy for: ${input}.` +
        ` Focus on benefits and emotional appeal.`
    })
    const copy = first.text

    const evaluation = yield* LanguageModel.generateObject({
      schema: QualityMetrics,
      objectName: "quality_metrics",
      prompt: `Evaluate this marketing copy for:
    1. Presence of call to action (true/false)
    2. Emotional appeal (1-10)
    3. Clarity (1-10)

    Copy to evaluate: ${copy}`
    })
    const qualityMetrics = evaluation.value

    if (passes(qualityMetrics)) return { copy, qualityMetrics }

    const rewrite = yield* LanguageModel.generateText({
      prompt: `Rewrite this marketing copy with:
${fixesFor(qualityMetrics).join("\n")}

    Original copy: ${copy}`
    })

    return { copy: rewrite.text, qualityMetrics }
  }
)

// ---------------------------------------------------------------------------
// The same evaluation, as an agent that ends in a typed value
// ---------------------------------------------------------------------------

const Quality = AgentOutput.make(QualityMetrics, {
  name: "record_evaluation",
  description:
    "Record your evaluation of the copy. Call this once, when you have finished."
})

/**
 * Worth an agent rather than a `generateObject` as soon as evaluating means
 * *doing* something first — fetching the brand guidelines, reading the last
 * campaign, asking a human. The result is typed either way.
 */
export const Critic = Agent.make({
  instructions:
    "Evaluate marketing copy for call to action, emotional appeal and clarity." +
    " Report your evaluation with the tool provided.",
  output: Quality
})

export const evaluate = (copy: string) =>
  Effect.map(
    Agent.run(Critic, `Copy to evaluate: ${copy}`),
    // An `Option`, and it stays one: a model can stop without answering, and a
    // signature promising a value would be a promise the harness cannot keep.
    (result) => result.value
  )

// ---------------------------------------------------------------------------

const AnthropicLayer = AnthropicLanguageModel.layer({
  model: "claude-sonnet-4-5"
}).pipe(
  Layer.provide(
    AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })
  ),
  Layer.provide(FetchHttpClient.layer)
)

export const main = Effect.gen(function*() {
  const { copy } = yield* generateMarketingCopy(
    "a standing desk for people who hate standing desks"
  )
  const verdict = yield* evaluate(copy)
  yield* Effect.log(copy, Option.getOrElse(verdict, () => "no evaluation given"))
}).pipe(Effect.provide(AnthropicLayer))
