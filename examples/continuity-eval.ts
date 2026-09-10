import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Config, Effect, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as NodeFs from "node:fs"
import * as NodePath from "node:path"
import { Continuity } from "../src/evals/index.js"

/**
 * The live tier of the continuity evaluation (item 106).
 *
 * The same standard scenario the suite runs under the reference model --
 * a dozen folds, three restarts, a fact, a correction and an open task asked
 * about long after they left the window -- against a real model. Scored the
 * same way, programmatically; no LLM judge.
 *
 * Opt-in and release/nightly only: it needs a key and costs money, so it is
 * not part of `npm run check`.
 *
 *   ANTHROPIC_API_KEY=... npm run eval:continuity
 *   AFFE_EVAL_MODEL=claude-opus-5 npm run eval:continuity
 *
 * Writes `docs/reports/continuity-<date>.json` and exits non-zero on a fail.
 */

const program = Effect.gen(function*() {
  const model = yield* Config.string("AFFE_EVAL_MODEL").pipe(Config.withDefault("claude-sonnet-5"))
  const report = yield* Continuity.run(Continuity.standard).pipe(
    Effect.provide(
      AnthropicLanguageModel.layer({ model }).pipe(
        Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
        Layer.provide(FetchHttpClient.layer)
      )
    )
  )
  const written = {
    model,
    at: new Date().toISOString(),
    ...report,
    asks: report.asks.map((a) => ({ ...a, provenance: Option.getOrNull(a.provenance) }))
  }
  const file = NodePath.join("docs", "reports", `continuity-${written.at.slice(0, 10)}.json`)
  NodeFs.writeFileSync(file, JSON.stringify(written, null, 2) + "\n")
  yield* Effect.log(
    `${report.passed ? "PASS" : "FAIL"} ${model}: ${report.folds} folds, ${report.restarts} restarts; ` +
      report.asks.map((a) => `${a.id}=${a.correct ? "ok" : "wrong"}${a.inView ? "(in view)" : ""}`).join(" ") +
      ` -> ${file}`
  )
  if (!report.passed) return yield* Effect.die(new Error("continuity: the standard scenario did not pass"))
})

void Effect.runPromise(program).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
