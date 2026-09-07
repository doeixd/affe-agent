import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import * as DurableModel from "../src/durable/DurableModel.js"
import * as DurableToolkit from "../src/durable/DurableToolkit.js"

/**
 * Reconstruction from a recorded outcome, which is the path a replay takes.
 *
 * A replay never re-runs a journalled activity: it reads the recorded value
 * and hands it to the same rule the first run used. Item 73 found that rule
 * turning a recorded tool defect into a typed failure the model then saw,
 * and `plan-streaming-followups.md` §8 asks for the rule to be exercised on
 * the recorded value alone, since no suspension point lets a whole session
 * replay a defect. These rows drive the two rules -- tool and model --
 * with journal-shaped values and hold what each must become.
 */
const failure = (isDefect: boolean) => ({ tag: "Boom", message: "the handler broke", isDefect })

describe("recorded outcomes, reconstructed", () => {
  it.effect("a recorded tool outcome: success is the results, an expected failure is typed, a defect and an unresolved call are defects", () =>
    Effect.gen(function* () {
      const succeeded = yield* DurableToolkit.reraise(
        { _tag: "Succeeded", results: [{ _tag: "Ok", result: 3, encodedResult: 3, preliminary: false }] },
        "add",
        "c1"
      )
      assert.deepStrictEqual(succeeded.map((r) => [r.result, r.isFailure]), [[3, false]])

      const expected = yield* Effect.exit(DurableToolkit.reraise({ _tag: "Failed", failure: failure(false) }, "add", "c1"))
      assert.isTrue(Exit.isFailure(expected))
      if (Exit.isFailure(expected)) {
        const error = Cause.findErrorOption(expected.cause)
        assert.isTrue(error._tag === "Some" && error.value._tag === "DurableToolFailure", "typed, so the failure policy applies")
      }

      const defect = yield* Effect.exit(DurableToolkit.reraise({ _tag: "Failed", failure: failure(true) }, "add", "c1"))
      assert.isTrue(Exit.isFailure(defect))
      if (Exit.isFailure(defect)) {
        assert.isTrue(Cause.findErrorOption(defect.cause)._tag === "None", "a recorded defect is not a typed failure")
        assert.isTrue(Cause.hasDies(defect.cause), "a recorded defect stays a defect")
      }

      const unresolved = yield* Effect.exit(DurableToolkit.reraise({ _tag: "Unresolved" }, "add", "c1"))
      assert.isTrue(Exit.isFailure(unresolved) && Cause.hasDies(unresolved.cause), "an unknown outcome is a defect, never a failure the model acts on")
    })
  )

  it.effect("a recorded model outcome: a response is the response, a provider failure is typed, a defect stays a defect", () =>
    Effect.gen(function* () {
      const response = yield* DurableModel.reraise({ _tag: "Succeeded", parts: [] })
      assert.deepStrictEqual(response.content, [])

      const expected = yield* Effect.exit(DurableModel.reraise({ _tag: "Failed", failure: failure(false) }))
      assert.isTrue(Exit.isFailure(expected))
      if (Exit.isFailure(expected)) {
        const error = Cause.findErrorOption(expected.cause)
        assert.isTrue(error._tag === "Some" && error.value._tag === "DurableModelFailure", "typed, as the provider's own error would be")
      }

      const defect = yield* Effect.exit(DurableModel.reraise({ _tag: "Failed", failure: failure(true) }))
      assert.isTrue(Exit.isFailure(defect))
      if (Exit.isFailure(defect)) {
        assert.isTrue(Cause.findErrorOption(defect.cause)._tag === "None" && Cause.hasDies(defect.cause), "a recorded model defect stays a defect")
      }
    })
  )
})
