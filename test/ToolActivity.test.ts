import { assert, describe, it } from "@effect/vitest"
import {
  activityName,
  nextOccurrence
} from "../src/internal/toolActivity.js"

/**
 * Activity identity has to survive a turn's tools being interleaved
 * differently on replay than they were on the original run. PLAN §17 runs them
 * at unbounded concurrency, so nothing guarantees the order matches.
 *
 * This is tested here rather than end-to-end because an end-to-end test passes
 * by luck: the scheduler has to actually pick the other order, and nothing
 * makes it do that on demand.
 */

/** Assign names to a batch of calls, in the given order. */
const namesFor = (calls: ReadonlyArray<readonly [string, string]>) => {
  let seen = new Map<string, number>()
  const out = new Map<string, string>()
  for (const [name, id] of calls) {
    const [index, next] = nextOccurrence(name, id)(seen)
    seen = next
    out.set(`${name}-${id}`, activityName(index, name, id))
  }
  return out
}

describe("durable tool activity identity", () => {
  it("is unchanged when concurrent calls arrive in a different order", () => {
    const batch = [
      ["search", "call-1"],
      ["fetch", "call-2"],
      ["write", "call-3"]
    ] as const

    const forwards = namesFor(batch)
    const backwards = namesFor([...batch].reverse())

    // Every call keeps the same activity name regardless of arrival order.
    // A global counter would have given these three names 0, 1, 2 in whichever
    // order the scheduler happened to start them -- so a replay that picked the
    // other order would look up a sibling's journal entry, re-running the tool
    // or returning the wrong result.
    assert.deepStrictEqual(
      Object.fromEntries(forwards),
      Object.fromEntries(backwards)
    )
    assert.deepStrictEqual(forwards.get("search-call-1"), "tool-0-search-call-1")
    assert.deepStrictEqual(forwards.get("write-call-3"), "tool-0-write-call-3")
  })

  it("still separates a tool call id reused across turns", () => {
    // The reason identity is not just the id. A provider only has to make ids
    // unique within one response; reuse across turns must not replay the
    // earlier result.
    let seen = new Map<string, number>()
    const names: Array<string> = []
    for (let turn = 0; turn < 3; turn++) {
      const [index, next] = nextOccurrence("search", "reused")(seen)
      seen = next
      names.push(activityName(index, "search", "reused"))
    }
    assert.deepStrictEqual(names, [
      "tool-0-search-reused",
      "tool-1-search-reused",
      "tool-2-search-reused"
    ])
  })

  it("keeps distinct tools with the same id apart", () => {
    const names = namesFor([
      ["search", "same"],
      ["fetch", "same"]
    ])
    assert.notStrictEqual(names.get("search-same"), names.get("fetch-same"))
  })
})
