/**
 * A pull-request reviewer, from parts that already exist
 * (`docs/plan-effect-agent-comparison.md` §3.7): `Presets.coding` for the
 * workspace and the read-only tools, an `AgentOutput` so the review is a
 * typed value and not prose to parse, `Budget.within` for the ceiling, and
 * `Evals` to report what the run spent. A reference to read and copy, not
 * a package: a package would be a dependency on a preset.
 *
 * Runs against the scripted model, so no key:
 *
 *     npx tsx examples/pr-review.ts
 */
import { Console, Effect, Layer, Option, Schema } from "effect"
import type { Scope } from "effect"
import { Agent, AgentLoop, AgentOutput, Permission } from "affe-agent"
import { Budget } from "affe-agent/budget"
import { CodingToolkit } from "affe-agent/coding"
import { Evals } from "affe-agent/evals"
import { Presets } from "affe-agent/presets"
import { MemorySandbox } from "affe-agent/sandbox"
import { TestLanguageModel } from "affe-agent/testing"

// ---------------------------------------------------------------------------
// The review, as a shape. The model reports it through a tool; the value
// comes back decoded, and the run ends when it does.

const Finding = Schema.Struct({
  path: Schema.String,
  line: Schema.Number,
  severity: Schema.Literals(["nit", "should-fix", "must-fix"]),
  note: Schema.String
})

const Review = AgentOutput.make(
  Schema.Struct({
    verdict: Schema.Literals(["approve", "request-changes"]),
    summary: Schema.String,
    findings: Schema.Array(Finding)
  }),
  {
    name: "record_review",
    description: "Record the review. Call exactly once, when you have read what you need."
  }
)

// ---------------------------------------------------------------------------
// A reviewer only reads. The preset's policy asks before writing; this one
// refuses outright, so a model that reaches for `edit_file` is told no and
// the run goes on. Read-only code mode is the same policy (README, "Code mode").

const readOnly = Permission.rules(
  [
    { action: "read", decision: Permission.allow },
    { action: "search", decision: Permission.allow },
    // The output is a tool like any other, and a default-deny policy would
    // refuse the review itself. Named, so the refusal stays for everything
    // that changes the branch and nothing that reports on it.
    { tool: Review.toolName, decision: Permission.allow }
  ],
  { otherwise: Permission.deny("a reviewer does not change the branch") }
)

const reviewer = Presets.coding({
  toolkit: CodingToolkit.toolkit(),
  sandbox: MemorySandbox.layer({
    seed: {
      "src/refund.ts": [
        "export const refund = (amount: number) => {",
        "  // TODO: idempotency key",
        "  return charge(-amount)",
        "}"
      ].join("\n"),
      "PR.md": "Adds refunds. Negative charges reverse a payment."
    }
  }),
  workspace: "pr-review",
  instructions:
    "You review a pull request. Read the diff and the files it touches, then" +
    " record your review with the tool provided: a verdict, a one-paragraph" +
    " summary, and findings with a path, line and severity.",
  permission: readOnly,
  output: Review,
  // A review is bounded work: eight turns, or forty thousand tokens,
  // whichever comes first. The token ceiling is a Layer, so it is per run
  // here and could be per application.
  loop: Budget.within(40_000, AgentLoop.bounded(8))
})

// ---------------------------------------------------------------------------
// The scripted model plays the reviewer: read the PR, read the file, record.

const script = TestLanguageModel.script([
  { toolCalls: [{ id: "r1", name: "read_file", params: { path: "PR.md" } }], usage: { input: 900, output: 40 } },
  { toolCalls: [{ id: "r2", name: "read_file", params: { path: "src/refund.ts" } }], usage: { input: 1200, output: 40 } },
  {
    toolCalls: [{
      id: "r3",
      name: "record_review",
      params: {
        verdict: "request-changes",
        summary: "Refunds reverse a charge by negating the amount, with no idempotency key: a retried request refunds twice.",
        findings: [
          { path: "src/refund.ts", line: 2, severity: "must-fix", note: "Take an idempotency key and dedupe on it before charging." },
          { path: "src/refund.ts", line: 3, severity: "should-fix", note: "A negative charge is a refund by convention only; call the refund API." }
        ]
      }
    }],
    usage: { input: 1500, output: 120 }
  }
])

// ---------------------------------------------------------------------------
// One eval: the review lands, only reads happened, and what it cost.

const evaluation = Evals.defineEval({
  name: "reviews the refund PR without touching it",
  agent: reviewer.agent,
  test: (t) =>
    Effect.gen(function* () {
      const result = yield* t.send("Review the open pull request.")
      yield* t.succeeded()
      yield* t.calledTool("read_file")
      yield* t.notCalledTool("edit_file")
      yield* t.notCalledTool("shell")
      yield* t.turns(Evals.atMost(8))
      yield* t.tokens(Evals.atMost(40_000))
      yield* Option.match(result.value, {
        onNone: () => Console.log("no review was recorded"),
        onSome: (review) =>
          Console.log(
            `${review.verdict}: ${review.summary}\n` +
              review.findings.map((f) => `  ${f.severity} ${f.path}:${f.line} — ${f.note}`).join("\n")
          )
      })
    })
})

export const main = Effect.gen(function* () {
  const { layer: model } = yield* script
  const report = yield* Evals.run(evaluation).pipe(
    Effect.provide(Layer.mergeAll(model, reviewer.workspace, Budget.layer))
  )
  for (const check of report.checks) {
    yield* Console.log(`${check.passed ? "ok " : "FAIL"} ${check.label}${check.detail === undefined ? "" : ` -- ${check.detail}`}`)
  }
  if (!report.passed) {
    return yield* new EvalFailed({ name: report.name })
  }
})

class EvalFailed extends Schema.TaggedError<EvalFailed>()("EvalFailed", { name: Schema.String }) {
  override get message() {
    return `eval failed: ${this.name}`
  }
}

// --- Type assertions -------------------------------------------------------
type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T
type ReviewValue = typeof reviewer.agent extends Agent.AgentDefinition<any, any, any, any, infer V> ? V : never
export type _ReviewIsTyped = Assert<ReviewValue extends { readonly verdict: "approve" | "request-changes" } ? true : false>
export type _ReviewNotAny = Assert<IsAny<ReviewValue> extends false ? true : false>
/** Nothing but a scope, for the workspace the preset acquires. */
export type _MainNeedsOnlyAScope = Assert<[Effect.Services<typeof main>] extends [Scope.Scope] ? true : false>

Effect.runPromise(Effect.scoped(main)).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
