import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as AgentLoop from "../src/AgentLoop.js"
import { Compaction } from "../src/compaction/index.js"

/**
 * Configuration numbers are read once and then govern a loop or a cache for
 * the life of the process, so a bad one produces behaviour that looks like a
 * bug somewhere else entirely: `maxTurns(0)` is a run that cannot take a turn,
 * `maxTurns(2.5)` compares against a counter that never equals it.
 */
describe("configuration validation", () => {
  const rejected = (thunk: () => unknown) => {
    try {
      thunk()
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  it("refuses loop bounds that cannot mean anything", () => {
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      const message = rejected(() => AgentLoop.maxTurns(bad))
      assert.isDefined(message, `maxTurns(${bad}) was accepted`)
      assert.include(message!, "positive integer")
    }
    // And the sensible case still works.
    assert.isDefined(AgentLoop.maxTurns(1))
    assert.isDefined(AgentLoop.bounded(20))
  })

  it("refuses compaction settings that cannot mean anything", () => {
    for (const bad of [0, -3, 1.5]) {
      assert.isDefined(
        rejected(() => Compaction.whenLongerThan(bad)),
        `threshold ${bad} was accepted`
      )
      assert.isDefined(
        rejected(() => Compaction.whenLongerThan(10, { retain: bad })),
        `retain ${bad} was accepted`
      )
    }
    assert.isDefined(Compaction.whenLongerThan(40, { retain: 10 }))
  })

  it.effect("refuses a checkpoint cache that cannot hold anything", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.exit(
        Compaction.make({
          policy: Compaction.whenLongerThan(4),
          summarise: () => Effect.succeed("x"),
          maxSessions: 0
        })
      )
      assert.strictEqual(outcome._tag, "Failure")
    })
  )
})
