/**
 * The post-commit review assistant (item 63, `plan-next-milestone.md` §2.1):
 * the maintainer's own daily job, done by a consumer of the published
 * library, so that whether it earns its place can be measured rather than
 * argued.
 *
 * Given a commit and review instructions, it inspects the diff, reads the
 * source and tests it needs, and records a review whose every finding carries
 * its evidence -- the file, the line, and the code the claim rests on. The
 * maintainer reads the review, challenges a finding at the prompt, and the
 * reviewer re-examines in the same session rather than restarting -- as many
 * times as it takes; an empty line accepts. Ctrl+C interrupts a bad
 * investigation.
 *
 * Built only from `affe-agent/*`, as `examples/pr-review.ts` is -- this is that
 * reviewer made real: a real repository instead of a seeded one, a real diff,
 * a real provider, and a log of what each review was, which is the
 * milestone's measure (reviewed commits; later, accepted findings and false
 * positives against it).
 *
 *     # live, against this repository's HEAD (needs ANTHROPIC_API_KEY)
 *     npx tsx examples/review-assistant.ts HEAD
 *     # or with the challenges scripted, in order, instead of typed
 *     npx tsx examples/review-assistant.ts HEAD --challenge "finding 2 is wrong: the lock is taken in the caller"
 *
 *     # with no key, the same program over the scripted model and a seeded workspace
 *     npx tsx examples/review-assistant.ts
 *
 * A live review appends one line to `.review-log.jsonl` in the working
 * directory. It never changes the repository: reads and searches run, and
 * everything else -- writes, the shell -- is refused.
 */
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline/promises"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Config, Console, Effect, Fiber, Layer, Option, Redacted, Schema } from "effect"
import type { Scope } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Agent, AgentLoop, AgentOutput, AgentSession, Permission } from "affe-agent"
import { Budget } from "affe-agent/budget"
import { CodingToolkit } from "affe-agent/coding"
import { Presets } from "affe-agent/presets"
import { MemorySandbox, Sandbox } from "affe-agent/sandbox"
import * as LocalSandbox from "affe-agent/sandbox/local"
import { TestLanguageModel } from "affe-agent/testing"

// ---------------------------------------------------------------------------
// The review, as a shape. Evidence is a field, not a hope: a finding the
// reviewer cannot quote code for is one the maintainer should not have to
// chase.

const Finding = Schema.Struct({
  path: Schema.String,
  line: Schema.Number,
  severity: Schema.Literals(["nit", "should-fix", "must-fix"]),
  claim: Schema.String,
  /** The code the claim rests on, quoted from the file as it is now. */
  evidence: Schema.String
})

const Review = AgentOutput.make(
  Schema.Struct({
    verdict: Schema.Literals(["approve", "request-changes"]),
    summary: Schema.String,
    findings: Schema.Array(Finding)
  }),
  {
    name: "record_review",
    description:
      "Record the review. Call once you have read what the findings need; call again after a challenge, with the review as it now stands."
  }
)
type Review = typeof Review.schema.Type

/** The repository's own post-commit review checklist, from `CLAUDE.md`. */
const CHECKLIST = [
  "correctness and edge cases",
  "TypeScript DX: no casts a caller would need, inference that stays precise",
  "performance",
  "hardening against misuse and failure",
  "Effect idiom (services, typed errors, no swallowed causes)",
  "tests that are robust, correct, and would actually catch the bug they are for",
  "no filler: comments and names that say something"
]

const INSTRUCTIONS =
  "You review one commit that has already landed. The diff is in the prompt; read the source and tests" +
  " it touches -- and whatever they depend on -- before you claim anything about them. Report only what" +
  " you can back: every finding names the file and line and quotes the code as evidence. Prefer a few" +
  " findings that matter over many that do not; an approve with no findings is a fine review. Record the" +
  " review with the tool provided."

const readOnly = Permission.rules(
  [
    { action: "read", decision: Permission.allow },
    { action: "search", decision: Permission.allow },
    { tool: Review.toolName, decision: Permission.allow }
  ],
  { otherwise: Permission.deny("a reviewer does not change the repository") }
)

const reviewerOver = (sandbox: Layer.Layer<Sandbox.SandboxProvider>) =>
  Presets.coding({
    toolkit: CodingToolkit.toolkit(),
    sandbox,
    workspace: "review",
    instructions: INSTRUCTIONS,
    permission: readOnly,
    output: Review,
    // Bounded work: a review that has not converged in twenty turns or
    // 150k tokens is an investigation to interrupt, not to fund.
    loop: Budget.within(150_000, AgentLoop.bounded(20))
  })

// ---------------------------------------------------------------------------
// One review, and optionally one challenge to it, in one session.

/** A diff too large to put in a prompt whole is cut, and says so. */
const MAX_DIFF_CHARS = 60_000

const promptFor = (ref: string, diff: string) => {
  const cut = diff.length > MAX_DIFF_CHARS
  return [
    `Review commit ${ref}.`,
    "",
    "Check for:",
    ...CHECKLIST.map((item) => `- ${item}`),
    "",
    "The commit:",
    "```diff",
    cut ? `${diff.slice(0, MAX_DIFF_CHARS)}\n... (diff cut at ${MAX_DIFF_CHARS} characters; read the files for the rest)` : diff,
    "```"
  ].join("\n")
}

const challengeFor = (challenge: string) =>
  [
    `The maintainer challenges the review: ${challenge}`,
    "",
    "Re-read the code the challenge concerns. Then record the review again: withdraw a finding the",
    "evidence does not support, keep one it does, and say in the summary which you changed and why."
  ].join("\n")

const render = (label: string, value: Option.Option<Review>): string =>
  Option.match(value, {
    onNone: () => `${label}: no review was recorded`,
    onSome: (review) =>
      [
        `${label}: ${review.verdict} -- ${review.summary}`,
        ...review.findings.map((finding, index) =>
          `  ${index + 1}. [${finding.severity}] ${finding.path}:${finding.line} ${finding.claim}\n     evidence: ${finding.evidence}`
        )
      ].join("\n")
  })

interface Outcome {
  readonly review: Option.Option<Review>
  readonly challenges: number
  readonly turns: number
}

/**
 * One review, then as many challenges as `nextChallenge` yields, in one
 * session. A challenge is read *after* the review it concerns is shown --
 * challenging a review nobody has seen is not challenging it.
 */
const reviewCommit = <E, R, CE, CR>(
  agent: ReturnType<typeof reviewerOver>["agent"],
  options: {
    readonly ref: string
    readonly diff: Effect.Effect<string, E, R>
    /** The next challenge to the review just shown, or `None` when the maintainer is done. */
    readonly nextChallenge: Effect.Effect<Option.Option<string>, CE, CR>
  }
) =>
  Effect.gen(function* () {
    const diff = yield* options.diff
    const session = yield* AgentSession.make(agent)
    const first = yield* session.prompt(promptFor(options.ref, diff))
    yield* Console.log(render("review", first.value))
    let outcome: Outcome = { review: first.value, challenges: 0, turns: first.turns }
    while (true) {
      const challenge = yield* options.nextChallenge
      if (Option.isNone(challenge)) return outcome
      const revised = yield* session.prompt(challengeFor(challenge.value))
      yield* Console.log(render("after the challenge", revised.value))
      outcome = { review: revised.value, challenges: outcome.challenges + 1, turns: outcome.turns + revised.turns }
    }
  })

/**
 * Challenges typed at the terminal, one per line, until an empty line. In
 * the scripted path the challenges are a fixed list instead.
 */
const fromTerminal = Effect.acquireRelease(
  Effect.sync(() => createInterface({ input: process.stdin, output: process.stdout })),
  (lines) => Effect.sync(() => lines.close())
).pipe(
  Effect.map((lines) =>
    Effect.promise(() => lines.question("\nchallenge a finding (enter to accept the review): ")).pipe(
      Effect.map((answer) => (answer.trim() === "" ? Option.none<string>() : Option.some(answer.trim())))
    )
  )
)

const fromList = (challenges: ReadonlyArray<string>) =>
  Effect.map(Effect.sync(() => [...challenges]), (queue) =>
    Effect.sync(() => Option.fromNullishOr(queue.shift())))

// ---------------------------------------------------------------------------
// Live: this repository, the commit named on the command line, a real model.

class DiffUnavailable extends Schema.TaggedError<DiffUnavailable>()("DiffUnavailable", {
  ref: Schema.String,
  detail: Schema.String
}) {
  override get message() {
    return `could not read commit ${this.ref}: ${this.detail}`
  }
}

/** `git show`, run through the sandbox rather than the shell tool the model is refused. */
const gitShow = (ref: string) =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox.Current
    const shown = yield* sandbox.exec(Sandbox.command("git", ["show", "--stat", "--patch", "--no-color", ref])).pipe(
      Effect.mapError((error) => new DiffUnavailable({ ref, detail: error.message }))
    )
    if (shown.exitCode !== 0) return yield* new DiffUnavailable({ ref, detail: shown.stderr.trim() })
    return shown.stdout
  })

const live = (apiKey: Redacted.Redacted<string>, ref: string, challenges: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const reviewer = reviewerOver(LocalSandbox.layer({ workspaceRoot: process.cwd() }))
    const model = AnthropicLanguageModel.layer({ model: "claude-sonnet-5" }).pipe(
      Layer.provide(AnthropicClient.layer({ apiKey })),
      Layer.provide(FetchHttpClient.layer)
    )
    const started = Date.now()
    // Challenges given on the command line are for scripting; otherwise the
    // maintainer reads the review and types a challenge, or accepts it.
    const nextChallenge = challenges.length > 0 ? yield* fromList(challenges) : yield* fromTerminal
    const outcome = yield* reviewCommit(reviewer.agent, { ref, diff: gitShow(ref), nextChallenge }).pipe(
      Effect.provide(Layer.mergeAll(reviewer.workspace, model, Budget.layer))
    )
    // The measure: one line per review, so "does the maintainer keep using
    // it" has data. Accepted findings and false positives are marked against
    // these lines by hand, later -- the reviewer cannot grade itself.
    appendFileSync(
      ".review-log.jsonl",
      `${JSON.stringify({
        at: new Date().toISOString(),
        commit: ref,
        model: "claude-sonnet-5",
        verdict: Option.match(outcome.review, { onNone: () => "none", onSome: (review) => review.verdict }),
        findings: Option.match(outcome.review, { onNone: () => [], onSome: (review) => review.findings.map((f) => f.severity) }),
        challenges: outcome.challenges,
        turns: outcome.turns,
        ms: Date.now() - started
      })}\n`
    )
    yield* Console.log("logged to .review-log.jsonl")
  })

// ---------------------------------------------------------------------------
// No key: the same program over a seeded workspace and the scripted model,
// so the path runs in CI and a reader can watch it without spending money.

const SEEDED_DIFF = [
  "commit 0000000 (seeded)",
  "    fix(refund): refund by negating the charge",
  "",
  "--- a/src/refund.ts",
  "+++ b/src/refund.ts",
  "@@ -1,3 +1,4 @@",
  " export const refund = (amount: number) => {",
  "+  // TODO: idempotency key",
  "   return charge(-amount)",
  " }"
].join("\n")

const scripted = Effect.gen(function* () {
  const reviewer = reviewerOver(MemorySandbox.layer({
    seed: {
      "src/refund.ts": "export const refund = (amount: number) => {\n  // TODO: idempotency key\n  return charge(-amount)\n}\n"
    }
  }))
  const read = { toolCalls: [{ id: "r1", name: "read_file", params: { path: "src/refund.ts" } }] }
  const { layer: model } = yield* TestLanguageModel.script([
    read,
    {
      toolCalls: [{
        id: "r2",
        name: "record_review",
        params: {
          verdict: "request-changes",
          summary: "A retried refund refunds twice: nothing dedupes it.",
          findings: [
            { path: "src/refund.ts", line: 3, severity: "must-fix", claim: "No idempotency key, so a retry refunds twice.", evidence: "return charge(-amount)" },
            { path: "src/refund.ts", line: 2, severity: "nit", claim: "A TODO in shipped code.", evidence: "// TODO: idempotency key" }
          ]
        }
      }]
    },
    { ...read, toolCalls: [{ id: "r3", name: "read_file", params: { path: "src/refund.ts" } }] },
    {
      toolCalls: [{
        id: "r4",
        name: "record_review",
        params: {
          verdict: "request-changes",
          summary: "Withdrew the TODO nit, which the must-fix already covers; kept the missing idempotency key.",
          findings: [
            { path: "src/refund.ts", line: 3, severity: "must-fix", claim: "No idempotency key, so a retry refunds twice.", evidence: "return charge(-amount)" }
          ]
        }
      }]
    }
  ])
  const outcome = yield* reviewCommit(reviewer.agent, {
    ref: "seeded",
    diff: Effect.succeed(SEEDED_DIFF),
    nextChallenge: yield* fromList(["finding 2 repeats finding 1"])
  }).pipe(Effect.provide(Layer.mergeAll(reviewer.workspace, model, Budget.layer)))
  // The scripted run is the CI check that the whole path holds: a review,
  // a challenge, and a revised review that withdrew what it said it withdrew.
  const findings = Option.match(outcome.review, { onNone: () => -1, onSome: (review) => review.findings.length })
  if (outcome.challenges !== 1 || findings !== 1) {
    return yield* Effect.die(new Error(`the scripted review did not revise as scripted (findings: ${findings})`))
  }
})

// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const apiKey = yield* Config.option(Config.Redacted("ANTHROPIC_API_KEY"))
  const args = process.argv.slice(2)
  // Every `--challenge "..."` given, in order; each value's index is skipped
  // when looking for the commit.
  const challengeAt = args.flatMap((arg, index) => (arg === "--challenge" && args[index + 1] !== undefined ? [index + 1] : []))
  const challenges = challengeAt.map((index) => args[index] ?? "")
  const ref = args.find((arg, index) => !arg.startsWith("--") && !challengeAt.includes(index)) ?? "HEAD"
  // `--scripted` forces the scripted path even with a key present, so the
  // smoke run in `npm run check` can never spend money on someone's machine.
  if (args.includes("--scripted")) return yield* scripted
  return yield* Option.match(apiKey, {
    onNone: () => Effect.andThen(Console.log("no ANTHROPIC_API_KEY: running the scripted review"), scripted),
    onSome: (key) => live(key, ref, challenges)
  })
})

// --- Type assertions -------------------------------------------------------
type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T
type ReviewValue = ReturnType<typeof reviewerOver>["agent"] extends Agent.AgentDefinition<any, any, any, any, infer V> ? V : never
export type _ReviewIsTyped = Assert<ReviewValue extends { readonly findings: ReadonlyArray<{ readonly evidence: string }> } ? true : false>
export type _ReviewNotAny = Assert<IsAny<ReviewValue> extends false ? true : false>
export type _MainNeedsOnlyAScope = Assert<[Effect.Services<typeof main>] extends [Scope.Scope] ? true : false>

// Ctrl+C interrupts a bad investigation: the fibre is interrupted, the
// session's scope closes, and the run in flight is interrupted with it.
const fiber = Effect.runFork(Effect.scoped(main))
process.once("SIGINT", () => Effect.runFork(Fiber.interrupt(fiber)))
fiber.addObserver((exit) => {
  if (exit._tag === "Failure") {
    console.error(exit.cause)
    process.exitCode = 1
  }
})
