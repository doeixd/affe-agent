import { Effect, Option, Ref } from "effect"
import { LanguageModel, Prompt } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import type { AgentDefinition } from "../Agent.js"
import * as AgentSession from "../AgentSession.js"

/**
 * Behavioural evals (issue #4 / ADDITIONAL §9).
 *
 * A test asks "does the code do the thing"; an eval asks "does the agent behave
 * the way we want" -- did it call the right tool, stay under a turn budget,
 * answer with the right shape. This package is the second, kept separate from
 * `/testing` as the brief asks.
 *
 * Everything here runs through the **public** session interface -- `prompt`, the
 * committed `history`, the `Result` -- never internals, so an eval written
 * against a scripted model runs unchanged against a real provider: swap the
 * `LanguageModel` layer and nothing else. Paired with `/testing`'s deterministic
 * scripted model, infra evals become exactly reproducible.
 *
 * ```ts
 * const weather = Evals.defineEval({
 *   name: "reports the weather",
 *   agent: WeatherAgent,
 *   test: (t) => Effect.gen(function* () {
 *     const result = yield* t.send("what's the weather in Paris?")
 *     yield* t.succeeded()
 *     yield* t.calledTool("get_weather")
 *     yield* t.reply(Evals.includes("Sunny"))
 *     yield* t.turns(Evals.atMost(3))
 *   })
 * })
 *
 * const results = yield* Evals.runAll([weather], { concurrency: 4 })
 * console.log(Evals.formatText(results))
 * ```
 *
 * Checks are recorded, not thrown: every check in a test runs, and the
 * `EvalResult` collects them all, so one failure never hides the next.
 */

// ---------------------------------------------------------------------------
// Matchers
// ---------------------------------------------------------------------------

/** A named predicate over a value, so a failed check can say what it wanted. */
export interface Matcher<in A> {
  readonly describe: string
  readonly test: (actual: A) => boolean
}

export const includes = (substring: string): Matcher<string> => ({
  describe: `includes "${substring}"`,
  test: (actual) => actual.includes(substring)
})

export const matchesRegex = (regex: RegExp): Matcher<string> => ({
  describe: `matches ${regex}`,
  test: (actual) => regex.test(actual)
})

export const equals = <A>(expected: A): Matcher<A> => ({
  describe: `equals ${JSON.stringify(expected)}`,
  test: (actual) => JSON.stringify(actual) === JSON.stringify(expected)
})

export const atMost = (bound: number): Matcher<number> => ({
  describe: `at most ${bound}`,
  test: (actual) => actual <= bound
})

export const atLeast = (bound: number): Matcher<number> => ({
  describe: `at least ${bound}`,
  test: (actual) => actual >= bound
})

/** An arbitrary predicate with a description, for anything the built-ins miss. */
export const satisfying = <A>(describe: string, test: (actual: A) => boolean): Matcher<A> => ({
  describe,
  test
})

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** One recorded assertion within an eval. */
export interface Check {
  readonly label: string
  readonly passed: boolean
  /** Present on failure: what was wanted versus what happened. */
  readonly detail?: string | undefined
}

/** The outcome of one eval: every check it recorded, and whether all passed. */
export interface EvalResult {
  readonly name: string
  readonly passed: boolean
  readonly checks: ReadonlyArray<Check>
}

// ---------------------------------------------------------------------------
// The eval context
// ---------------------------------------------------------------------------

const toolCallsOf = (history: Prompt.Prompt): ReadonlyArray<{ readonly name: string; readonly params: unknown }> =>
  history.content.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((part) =>
        part.type === "tool-call" ? [{ name: part.name, params: part.params }] : []
      )
      : []
  )

const totalTokens = <Tools extends Record<string, Tool.Any>>(
  result: AgentSession.Result<Tools>
): Option.Option<number> =>
  Option.map(result.response, (response) => (response.usage.inputTokens.total ?? 0) + (response.usage.outputTokens.total ?? 0))

/**
 * What a test drives and asserts against. Every assertion returns an Effect
 * that records a check; `send` drives the session and returns its `Result`.
 */
export interface EvalContext<Tools extends Record<string, Tool.Any>, E> {
  /** Prompt the agent, recording nothing; returns the run's `Result`. */
  readonly send: (
    input: Prompt.RawInput,
    options?: AgentSession.PromptOptions
  ) => Effect.Effect<AgentSession.Result<Tools>, AgentSession.PromptError<Tools, E>>
  /** The last send completed rather than being interrupted. */
  readonly succeeded: () => Effect.Effect<void>
  /** The named tool was called at least once in the conversation. */
  readonly calledTool: (name: string) => Effect.Effect<void>
  /** The named tool was never called. */
  readonly notCalledTool: (name: string) => Effect.Effect<void>
  /** The named tool was called with params matching. */
  readonly calledToolWith: (name: string, matcher: Matcher<unknown>) => Effect.Effect<void>
  /** How many tool calls the conversation made, matched. */
  readonly toolCalls: (matcher: Matcher<number>) => Effect.Effect<void>
  /** The last send's turn count, matched. */
  readonly turns: (matcher: Matcher<number>) => Effect.Effect<void>
  /** The last send's total token usage, matched (fails if the provider reported none). */
  readonly tokens: (matcher: Matcher<number>) => Effect.Effect<void>
  /** The last send's reply text, matched. */
  readonly reply: (matcher: Matcher<string>) => Effect.Effect<void>
  /** An arbitrary value, matched -- the escape hatch. */
  readonly check: <A>(label: string, actual: A, matcher: Matcher<A>) => Effect.Effect<void>
  /** Ask the model to judge the last reply against a rubric; records PASS/FAIL. */
  readonly judge: (rubric: string) => Effect.Effect<void, never, LanguageModel.LanguageModel>
}

/**
 * Read a PASS/FAIL verdict from a judge reply, fail-closed. The judge is asked
 * to answer with *only* `PASS` or `FAIL`; the verdict is the reply's first word,
 * and it passes only when that word is exactly `PASS`. A substring check would
 * be fooled by prose like "this does not PASS the bar" (a failing verdict that
 * happens to contain the word PASS); anchoring to the leading token is not.
 */
export const parseVerdict = (text: string): boolean =>
  text.trim().toUpperCase().match(/^[A-Z]+/)?.[0] === "PASS"

// ---------------------------------------------------------------------------
// Defining and running
// ---------------------------------------------------------------------------

export interface Eval<Tools extends Record<string, Tool.Any>, E, R, TE, TR> {
  readonly name: string
  readonly agent: AgentDefinition<Tools, E, R>
  /**
   * The test body. Its error `TE` is inferred from what the body actually raises
   * (a bare `t.send` surfaces the agent's `PromptError`; a body that only records
   * checks raises nothing) -- honest, never `unknown`. `run` discharges it: any
   * failure or defect is caught and recorded as a failed check.
   */
  readonly test: (t: EvalContext<Tools, E>) => Effect.Effect<void, TE, TR>
}

/** Define an eval. Identity at runtime; it exists so `t` infers the agent's tools. */
export const defineEval = <Tools extends Record<string, Tool.Any>, E, R, TE = never, TR = never>(
  options: Eval<Tools, E, R, TE, TR>
): Eval<Tools, E, R, TE, TR> => options

/**
 * Run one eval to an `EvalResult`. Never fails: a send that errors, or a defect
 * in the test, is recorded as a failed check so the report is always complete.
 */
export const run = <Tools extends Record<string, Tool.Any>, E, R, TE, TR>(
  evaluation: Eval<Tools, E, R, TE, TR>
): Effect.Effect<EvalResult, never, LanguageModel.LanguageModel | R | TR> =>
  Effect.scoped(
    Effect.gen(function* () {
      const checks = yield* Ref.make<ReadonlyArray<Check>>([])
      const last = yield* Ref.make<Option.Option<AgentSession.Result<Tools>>>(Option.none())
      const record = (label: string, passed: boolean, detail?: string) =>
        Ref.update(checks, (all) => [...all, { label, passed, ...(detail === undefined ? {} : { detail }) }])

      const session = yield* AgentSession.make(evaluation.agent)

      const withLast = <R2 = never>(
        label: string,
        use: (result: AgentSession.Result<Tools>) => Effect.Effect<void, never, R2>
      ): Effect.Effect<void, never, R2> =>
        Effect.flatMap(Ref.get(last), Option.match({
          onNone: () => record(label, false, "no send yet"),
          onSome: use
        }))

      const withCalls = (use: (calls: ReadonlyArray<{ readonly name: string; readonly params: unknown }>) => Effect.Effect<void>) =>
        Effect.flatMap(AgentSession.history(session), (history) => use(toolCallsOf(history)))

      const t: EvalContext<Tools, E> = {
        send: (input, options) =>
          AgentSession.prompt(session, input, options ?? {}).pipe(
            Effect.tap((result) => Ref.set(last, Option.some(result)))
          ),
        succeeded: () =>
          withLast("succeeded", (result) =>
            record("succeeded", result.status === "completed", result.status === "completed" ? undefined : `status was ${result.status}`)),
        calledTool: (name) =>
          withCalls((calls) =>
            record(`calledTool ${name}`, calls.some((call) => call.name === name), `tools called: ${calls.map((c) => c.name).join(", ") || "none"}`)),
        notCalledTool: (name) =>
          withCalls((calls) =>
            record(`notCalledTool ${name}`, !calls.some((call) => call.name === name), `${name} was called`)),
        calledToolWith: (name, matcher) =>
          withCalls((calls) => {
            const matched = calls.some((call) => call.name === name && matcher.test(call.params))
            return record(`calledToolWith ${name} (${matcher.describe})`, matched, matched ? undefined : `no ${name} call matched`)
          }),
        toolCalls: (matcher) =>
          withCalls((calls) =>
            record(`toolCalls ${matcher.describe}`, matcher.test(calls.length), `count was ${calls.length}`)),
        turns: (matcher) =>
          withLast(`turns ${matcher.describe}`, (result) =>
            record(`turns ${matcher.describe}`, matcher.test(result.turns), `turns was ${result.turns}`)),
        tokens: (matcher) =>
          withLast(`tokens ${matcher.describe}`, (result) =>
            Option.match(totalTokens(result), {
              onNone: () => record(`tokens ${matcher.describe}`, false, "the provider reported no usage"),
              onSome: (total) => record(`tokens ${matcher.describe}`, matcher.test(total), `tokens was ${total}`)
            })),
        reply: (matcher) =>
          withLast(`reply ${matcher.describe}`, (result) =>
            record(`reply ${matcher.describe}`, matcher.test(result.text), `reply was ${JSON.stringify(result.text)}`)),
        check: (label, actual, matcher) =>
          record(`${label} ${matcher.describe}`, matcher.test(actual), `was ${JSON.stringify(actual)}`),
        judge: (rubric) =>
          withLast(`judge: ${rubric}`, (result) =>
            Effect.flatMap(LanguageModel.LanguageModel, (model) =>
              model.generateText({
                prompt: `${rubric}\n\nThe reply to judge:\n${result.text}\n\nRespond with only PASS or FAIL.`
              })).pipe(
              Effect.map((response) => parseVerdict(response.text)),
              Effect.flatMap((passed) => record(`judge: ${rubric}`, passed, passed ? undefined : "the judge said FAIL")),
              Effect.catchCause((cause) => record(`judge: ${rubric}`, false, `the judge could not run: ${String(cause)}`))
            ))
      }

      yield* evaluation.test(t).pipe(
        Effect.catchCause((cause) => record("eval run", false, `the test errored: ${String(cause)}`))
      )

      // An eval that recorded nothing asserted nothing, and `every` on an empty
      // array is `true` -- so a test body that returned before its first check
      // (or never had one) reported PASS in the CI report, which is the one
      // outcome an eval must never produce by omission. Recorded as a failed
      // check rather than a bare `passed: false`, so the reporters say why.
      const recorded = yield* Ref.get(checks)
      const checked = recorded.length === 0
        ? [{ label: "recorded at least one check", passed: false, detail: "the eval asserted nothing" }]
        : recorded
      return { name: evaluation.name, passed: checked.every((check) => check.passed), checks: checked }
    })
  )

/** Run many evals, optionally concurrently. Each result is independent. */
export const runAll = <Tools extends Record<string, Tool.Any>, E, R, TE, TR>(
  evaluations: ReadonlyArray<Eval<Tools, E, R, TE, TR>>,
  options?: { readonly concurrency?: number | "unbounded" | undefined }
): Effect.Effect<ReadonlyArray<EvalResult>, never, LanguageModel.LanguageModel | R | TR> =>
  Effect.all(evaluations.map(run), { concurrency: options?.concurrency ?? 1 })

// ---------------------------------------------------------------------------
// Reporters
// ---------------------------------------------------------------------------

/** A human-readable report: one block per eval, failing checks called out. */
export const formatText = (results: ReadonlyArray<EvalResult>): string => {
  const lines: Array<string> = []
  for (const result of results) {
    lines.push(`${result.passed ? "PASS" : "FAIL"}  ${result.name}`)
    for (const check of result.checks) {
      if (!check.passed) {
        lines.push(`      ✗ ${check.label}${check.detail === undefined ? "" : ` -- ${check.detail}`}`)
      }
    }
  }
  const passed = results.filter((result) => result.passed).length
  lines.push(`${passed}/${results.length} evals passed`)
  return lines.join("\n")
}

const escapeXml = (text: string): string =>
  text.replace(/[<>&"']/g, (char) =>
    char === "<" ? "&lt;" : char === ">" ? "&gt;" : char === "&" ? "&amp;" : char === "\"" ? "&quot;" : "&apos;")

/** JUnit XML, one testcase per check, so CI shows check-level pass/fail. */
export const formatJUnit = (results: ReadonlyArray<EvalResult>): string => {
  const failures = results.reduce((sum, result) => sum + result.checks.filter((check) => !check.passed).length, 0)
  const total = results.reduce((sum, result) => sum + result.checks.length, 0)
  const cases = results.flatMap((result) =>
    result.checks.map((check) =>
      check.passed
        ? `    <testcase classname="${escapeXml(result.name)}" name="${escapeXml(check.label)}"/>`
        : `    <testcase classname="${escapeXml(result.name)}" name="${escapeXml(check.label)}">\n` +
          `      <failure>${escapeXml(check.detail ?? "failed")}</failure>\n` +
          `    </testcase>`
    ))
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuite name="evals" tests="${total}" failures="${failures}">`,
    ...cases,
    `</testsuite>`
  ].join("\n")
}
