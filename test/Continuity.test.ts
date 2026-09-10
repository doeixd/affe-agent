import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { Continuity } from "../src/evals/index.js"

/**
 * Item 106's deterministic tier: the standard continuity scenario, run under
 * the reference model, in the ordinary suite. The reference model can only
 * answer what the harness lets it find, so a pass here says the pipeline --
 * repeated folds, restarts between submissions, search over canonical history
 * -- carries a fact across the lifetime; a live model's failure on the same
 * scenario is then the model's.
 */

const runStandard = (options?: Continuity.Options) =>
  Continuity.run(Continuity.standard, options).pipe(Effect.provide(Continuity.referenceModel))

describe("continuity over a long lifetime (item 106)", () => {
  it.effect("the standard scenario: recall, the latest correction and the open task survive a dozen folds and three restarts", () =>
    Effect.gen(function*() {
      const report = yield* runStandard()

      // The scenario is only a test if the lifetime was long.
      assert.isAtLeast(report.folds, 12, "too few folds for the facts to have left the window")
      assert.strictEqual(report.restarts, 3)

      const byId = new Map(report.asks.map((a) => [a.id, a]))
      for (const id of ["original-fact", "latest-correction", "unfinished-task"]) {
        const a = byId.get(id)
        assert.isDefined(a, id)
        // Out of view: answerable only by finding it, not by reading the prompt.
        assert.isFalse(a!.inView, `${id}: the fact was still in the prompt`)
        assert.isTrue(a!.correct, `${id}: wrong answer ${JSON.stringify(a!.answer)}`)
        assert.isTrue(Option.isSome(a!.provenance), `${id}: no search hit pointed at the statement`)
      }
      assert.isTrue(report.passed)
    }))

  it.effect("control: with no folds the facts stay in view, and the scenario does not count as a pass", () =>
    Effect.gen(function*() {
      // What makes the scoring able to fail: an agent that could read every
      // answer off its prompt is not recalling anything.
      const report = yield* runStandard({ foldAfter: 10_000 })
      assert.strictEqual(report.folds, 0)
      assert.isTrue(report.asks.some((a) => a.inView))
      assert.isFalse(report.passed)
    }))

  it.effect("known limit, pinned: a correction that is the fourth mention is never found (item 109)", () =>
    Effect.gen(function*() {
      // `search_context` returns the *first* three matches in history order
      // and stops. Three earlier mentions of the deploy window fill every
      // slot, so the correction is never returned and the latest-value
      // question is answered with a stale one. When item 109 makes the search
      // report that more matches exist (or return the latest), flip this.
      const scenario: Continuity.Scenario = {
        name: "correction-after-three-mentions",
        steps: [
          Continuity.say("The deploy window is Tuesday at noon."),
          Continuity.say("Reminder: the deploy window is Tuesday at noon."),
          Continuity.say("Again, the deploy window is Tuesday at noon."),
          Continuity.say("Correction: the deploy window is Thursday at 3pm, not Tuesday."),
          ...Array.from({ length: 10 }, (_, i) => Continuity.say(`Status note ${i}: routine progress.`)),
          Continuity.ask({
            id: "latest-correction",
            phrase: "deploy window",
            question: "When is the deploy window?",
            expect: "Thursday at 3pm",
            stale: ["Tuesday at noon"],
            source: "Correction: the deploy window is Thursday at 3pm"
          })
        ]
      }
      const report = yield* Continuity.run(scenario).pipe(Effect.provide(Continuity.referenceModel))
      const [answer] = report.asks
      assert.isFalse(answer!.inView)
      assert.isFalse(answer!.correct, "the fourth mention was found -- item 109 may have landed; flip this row")
      assert.isTrue(Option.isNone(answer!.provenance))
    }))
})
