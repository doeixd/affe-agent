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
      "ToolApprovalRequiredError",
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

describe("durable and cluster surfaces", () => {
  it("exports the durable vocabulary and nothing beyond it", async () => {
    const durable = await import("../src/durable/index.js")
    // Guards against a helper leaking out by accident, and against one being
    // dropped: both are breaking for a published package.
    assert.deepStrictEqual(Object.keys(durable).sort(), [
      "DurableAgent",
      "DurableChannels",
      "DurableModel",
      "DurableToolkit"
    ])
  })

  it("exports the cluster vocabulary and nothing beyond it", async () => {
    const cluster = await import("../src/cluster/index.js")
    assert.deepStrictEqual(Object.keys(cluster).sort(), [
      "AgentEntity",
      "EntityClient",
      "ScheduledAgent"
    ])
  })

  it("keeps the durable entry points a deployment needs", async () => {
    const { DurableAgent, DurableChannels } = await import(
      "../src/durable/index.js"
    )
    // Named individually because these are what the README documents; a rename
    // is a breaking change and should read as one here.
    for (const name of [
      "workflow",
      "submit",
      "steer",
      "followUp",
      "result",
      "executionIdFor",
      "open",
      "DurableAgentFailure"
    ]) {
      assert.property(DurableAgent, name)
    }
    for (const name of ["memoryStore", "sqlStore", "sqlStoreWithTable"]) {
      assert.property(DurableChannels, name)
    }
  })

  it("exports the testing vocabulary and nothing beyond it", async () => {
    const testing = await import("../src/testing/index.js")
    assert.deepStrictEqual(Object.keys(testing).sort(), [
      "AgentProbe",
      "TestLanguageModel"
    ])
  })

  it("exports the compaction vocabulary and nothing beyond it", async () => {
    const compaction = await import("../src/compaction/index.js")
    assert.deepStrictEqual(Object.keys(compaction).sort(), ["Compaction"])
  })
})
