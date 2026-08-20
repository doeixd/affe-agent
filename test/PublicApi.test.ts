import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as Harness from "../src/index.js"

/**
 * PLAN §4 and §42: the exported vocabulary, and its size.
 */
describe("public API", () => {
  it("exports the core vocabulary and nothing beyond it", () => {
    assert.deepStrictEqual(Object.keys(Harness).sort(), [
      "Agent",
      "AgentBusyError",
      "AgentClosedError",
      "AgentEvent",
      "AgentIdleError",
      "AgentLoop",
      "AgentRun",
      "AgentSession",
      "AgentSubmission",
      "ContextTransform",
      "InputChannel",
      "ToolExecution"
    ])
  })

  it("keeps the convenience surface small and named for its use", () => {
    // Sugar is allowed to exist only where it removes real, repeated friction:
    // `Agent.toolkit` makes a silent footgun unrepresentable, `AgentLoop.bounded`
    // is the loop nearly every agent wants, the system-message transforms are
    // the canonical dynamic-instruction case, and `AgentEvent.match` replaces a
    // hand-written switch that silently stops covering new events.
    assert.deepStrictEqual(Object.keys(Harness.Agent).sort(), [
      "make",
      "toolkit"
    ])
    assert.isTrue(typeof Harness.AgentEvent.match === "function")
  })

  it("exposes the operations §42 targets", () => {
    assert.deepStrictEqual(
      Object.keys(Harness.AgentSession).sort(),
      [
        "Id",
        "events",
        "followUp",
        "history",
        "interrupt",
        "make",
        "prompt",
        "state",
        "status",
        "steer"
      ]
    )
    assert.deepStrictEqual(Object.keys(Harness.AgentLoop).sort(), [
      "Continue",
      "Stop",
      "and",
      "bounded",
      "make",
      "maxTurns",
      "or",
      "untilIdle"
    ])
    assert.deepStrictEqual(Object.keys(Harness.ContextTransform).sort(), [
      "appendSystem",
      "compose",
      "identity",
      "make",
      "prependSystem"
    ])
  })

  it.effect("namespaced ids are usable as Schemas", () =>
    Effect.gen(function* () {
      // §4: AgentSession.Id, AgentSubmission.Id, AgentRun.Id
      const session = yield* Schema.decodeEffect(Harness.AgentSession.Id)(
        "session-1"
      )
      const submission = yield* Schema.decodeEffect(Harness.AgentSubmission.Id)(
        "submission-1"
      )
      const run = yield* Schema.decodeEffect(Harness.AgentRun.Id)("run-1")
      assert.strictEqual(`${session}/${submission}/${run}`, "session-1/submission-1/run-1")
    })
  )
})
