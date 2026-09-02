/**
 * The getting-started agent, verbatim from `docs/getting-started.md`.
 *
 * `test/GettingStarted.test.ts` pins the two together: the document's code
 * block is this file with the package imports substituted for the relative
 * ones, so the first thing a reader copies is a thing that typechecks, runs,
 * and needs no cast. Runs against the scripted model, so no key is needed:
 *
 *     npx tsx examples/getting-started.ts
 */
import { Effect, Layer, Option, Schema } from "effect"
import { Agent, AgentLoop, AgentOutput } from "../src/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

// What the agent must answer with. The schema is the contract: the model is
// handed it as a tool, and the value comes back decoded, not re-parsed.
const Triage = Schema.Struct({
  severity: Schema.Literals(["low", "medium", "high", "critical"]),
  explanation: Schema.String
})

const Classifier = Agent.make({
  instructions:
    "Classify the bug report. Report its severity and a one-sentence" +
    " explanation with the tool provided.",
  output: AgentOutput.make(Triage, { name: "record_triage" }),
  // Stop when the model stops calling tools, and never past two turns.
  loop: AgentLoop.bounded(2)
})

// `Agent.run` opens a session for one prompt and closes it at quiescence.
// The result's `value` is an `Option`: a model can stop without answering,
// and the signature says so rather than the docs.
export const classify = (report: string) =>
  Effect.map(Agent.run(Classifier, report), (result) => result.value)

// An agent names no model. This one is scripted -- it plays the provider's
// part -- so the program runs with no key. Swap the layer for a real
// provider and nothing above changes.
const ScriptedModel = Layer.unwrap(
  Effect.map(
    TestLanguageModel.script([
      TestLanguageModel.toolCall("record_triage", {
        severity: "critical",
        explanation: "Every sign-in fails, so nobody can use the product."
      })
    ]),
    ({ layer }) => layer
  )
)

export const main = classify("All users get a 500 error when signing in").pipe(
  Effect.map((verdict) =>
    Option.match(verdict, {
      onNone: () => "the model gave no verdict",
      onSome: (triage) => `${triage.severity}: ${triage.explanation}`
    })
  ),
  Effect.tap((line) => Effect.log(line)),
  Effect.provide(ScriptedModel)
)

// --- Type assertions -------------------------------------------------------
// Compile-time only: `any` would satisfy the code above silently, so these
// assert that inference is precise rather than merely accepted.

type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T

type Verdict = Effect.Success<ReturnType<typeof classify>>
export type _VerdictNotAny = Assert<IsAny<Verdict> extends false ? true : false>
export type _VerdictIsTheSchema = Assert<
  Verdict extends Option.Option<{ readonly severity: "low" | "medium" | "high" | "critical"; readonly explanation: string }>
    ? true
    : false
>
/** The example needs nothing: every requirement is discharged. */
export type _MainNeedsNoServices = Assert<
  [Effect.Services<typeof main>] extends [never] ? true : false
>

Effect.runPromise(main).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
