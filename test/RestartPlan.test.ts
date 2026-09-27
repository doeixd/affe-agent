import { assert, describe, it } from "@effect/vitest"
import * as RestartPlan from "../src/internal/restartPlan.js"
import type { Supervisor } from "../src/sessions/index.js"

/**
 * The Supervisor's rules as tables: who restarts with a failed child, whether
 * a restart fits the window, and what a template's child is named.
 * `Supervisor.test.ts` holds the loop to them through real child exits.
 */

const children: ReadonlyArray<{ readonly id: string; readonly restart: Supervisor.Restart }> = [
  { id: "a", restart: "permanent" },
  { id: "b", restart: "temporary" },
  { id: "c", restart: "transient" },
  { id: "d", restart: "permanent" }
]
const allRunning = () => true

describe("siblingsOf", () => {
  it("one_for_one restarts the child alone", () => {
    assert.deepStrictEqual(RestartPlan.siblingsOf("one_for_one", children, "b", allRunning), { stop: [], start: ["b"] })
  })

  it("one_for_all stops every running sibling, last first, and starts all but the temporary in spec order", () => {
    assert.deepStrictEqual(RestartPlan.siblingsOf("one_for_all", children, "c", allRunning), {
      stop: ["d", "b", "a"],
      start: ["a", "c", "d"]
    })
  })

  it("rest_for_one takes only the siblings after it", () => {
    assert.deepStrictEqual(RestartPlan.siblingsOf("rest_for_one", children, "a", allRunning), {
      stop: ["d", "c", "b"],
      start: ["a", "c", "d"]
    })
    assert.deepStrictEqual(RestartPlan.siblingsOf("rest_for_one", children, "d", allRunning), { stop: [], start: ["d"] })
  })

  it("a sibling that is not running is neither stopped nor started", () => {
    const running = (id: string) => id !== "d"
    assert.deepStrictEqual(RestartPlan.siblingsOf("one_for_all", children, "a", running), {
      stop: ["c", "b"],
      start: ["a", "c"]
    })
  })

  it("the failed child restarts even when it is temporary: its own restart type was checked before", () => {
    assert.deepStrictEqual(RestartPlan.siblingsOf("one_for_all", children, "b", allRunning), {
      stop: ["d", "c", "a"],
      start: ["a", "b", "c", "d"]
    })
  })
})

describe("intensity", () => {
  it("admits below the limit and prunes what fell out of the window", () => {
    assert.deepStrictEqual(RestartPlan.intensity([100, 900, 950], 1000, 200, 3), { admitted: true, recent: [900, 950] })
  })

  it("refuses at the limit", () => {
    assert.deepStrictEqual(RestartPlan.intensity([900, 950, 990], 1000, 200, 3), { admitted: false, recent: [900, 950, 990] })
  })

  it("the window's edge is outside it", () => {
    assert.deepStrictEqual(RestartPlan.intensity([800], 1000, 200, 1), { admitted: true, recent: [] })
  })

  it("a limit of zero admits nothing", () => {
    assert.isFalse(RestartPlan.intensity([], 1000, 200, 0).admitted)
  })
})

describe("freshId", () => {
  it("takes the first free number", () => {
    assert.strictEqual(RestartPlan.freshId("worker", new Set()), "worker-1")
    assert.strictEqual(RestartPlan.freshId("worker", new Set(["worker-1", "worker-3"])), "worker-2")
  })
})
