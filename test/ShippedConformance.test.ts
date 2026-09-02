import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient } from "../src/client/index.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import {
  AgentClientConformance,
  DeliveryLogConformance,
  DurableSessionStoreConformance,
  NodeStoreConformance,
  TestLanguageModel
} from "../src/testing/index.js"
import * as NodeStore from "../src/tree/NodeStore.js"

/**
 * The four shipped suites, held to the falsification discipline the sandbox
 * and channel suites already meet: each passes against an in-tree
 * implementation from its published entry, and a deliberately wrong
 * implementation fails exactly the promise it breaks -- named in the
 * report, and nothing else.
 *
 * The wrong implementations are the real ones with one method replaced, so
 * what is being falsified is the suite's ability to see that one lie.
 */

describe("DeliveryLogConformance", () => {
  it.live("the memory log passes", () =>
    Effect.gen(function* () {
      const report = yield* DeliveryLogConformance.run({ log: DeliveryLog.memoryLog })
      assert.deepStrictEqual(report.failed, [])
      assert.strictEqual(report.passed.length, 4)
    })
  )

  it.live("a log that hides a conflict as a duplicate fails exactly that case", () =>
    Effect.gen(function* () {
      const lying = Effect.map(DeliveryLog.memoryLog, (real): DeliveryLog.DeliveryLog => ({
        ...real,
        append: (sessionId, key, envelope) =>
          Effect.map(real.append(sessionId, key, envelope), (outcome) =>
            outcome._tag === "Conflict" ? { _tag: "Duplicate" } : outcome
          )
      }))
      const report = yield* DeliveryLogConformance.run({ log: lying })
      assert.deepStrictEqual(
        report.failed.map((failure) => failure.name),
        ["a replayed event is a duplicate; a disagreeing one is a conflict"]
      )
      assert.include(report.failed[0]!.detail, "Conflict")
    })
  )
})

describe("NodeStoreConformance", () => {
  it.effect("the memory store passes", () =>
    Effect.gen(function* () {
      const report = yield* NodeStoreConformance.run(NodeStore.memory)
      assert.deepStrictEqual(report.failed, [])
      assert.strictEqual(report.passed.length, 10)
    })
  )

  it.effect("a store whose roots are every node fails exactly that case", () =>
    Effect.gen(function* () {
      const lying = Effect.map(NodeStore.memory, (real): NodeStore.NodeStore<never> => ({
        ...real,
        roots: real.nodes
      }))
      const report = yield* NodeStoreConformance.run(lying)
      assert.deepStrictEqual(
        report.failed.map((failure) => failure.name),
        ["roots are the parentless nodes"]
      )
    })
  )
})

describe("DurableSessionStoreConformance", () => {
  it.effect("the memory store passes", () =>
    Effect.gen(function* () {
      const report = yield* DurableSessionStoreConformance.run({ store: DurableSessionStore.memoryStore })
      assert.deepStrictEqual(report.failed, [])
      assert.strictEqual(report.passed.length, 16)
    })
  )

  it.effect("a store that accepts a replayed finish fails exactly that case", () =>
    Effect.gen(function* () {
      const lying = Effect.map(
        DurableSessionStore.memoryStore,
        (real): DurableSessionStore.DurableSessionStore => ({
          ...real,
          // Reports success whether or not a claim was there to finish.
          finish: (sessionId, submissionId, history) =>
            Effect.as(real.finish(sessionId, submissionId, history), true)
        })
      )
      const report = yield* DurableSessionStoreConformance.run({ store: lying })
      assert.deepStrictEqual(
        report.failed.map((failure) => failure.name),
        ["finish restores idle, advances history, and refuses a replay"]
      )
      assert.include(report.failed[0]!.detail, "replayed finish")
    })
  )
})

describe("AgentClientConformance", () => {
  const wiring = (
    decorate: (real: AgentClient.Service) => AgentClient.Service
  ): AgentClientConformance.Options => ({
    layer: ({ agent, turns, elicitation, maxRetainedSubmissions }) =>
      Effect.map(TestLanguageModel.script(turns), ({ layer: model }) =>
        Layer.effect(
          AgentClient.AgentClient,
          Effect.map(AgentClient.AgentClient, decorate)
        ).pipe(
          Layer.provide(
            AgentClient.layer(agent, {
              ...(elicitation === undefined ? {} : { elicitation }),
              ...(maxRetainedSubmissions === undefined ? {} : { maxRetainedSubmissions })
            }).pipe(Layer.provide(model))
          )
        )
      )
  })

  it.live("the in-process client passes, from the published entry", () =>
    Effect.gen(function* () {
      const report = yield* AgentClientConformance.run(wiring((real) => real))
      assert.deepStrictEqual(report.failed, [])
      assert.strictEqual(report.passed.length, 19)
    })
  )

  it.live("a client that cannot reach a session again by id fails exactly that case", () =>
    Effect.gen(function* () {
      const report = yield* AgentClientConformance.run(
        wiring((real) => ({
          ...real,
          session: (sessionId) => Effect.fail(new AgentClient.AgentSessionNotFoundError({ sessionId }))
        }))
      )
      assert.deepStrictEqual(
        report.failed.map((failure) => failure.name),
        ["opens a session and reaches it again by id"]
      )
    })
  )

  it.live("the report names the client's own error when a case fails through it", () =>
    Effect.gen(function* () {
      // A client built over the wrong agent: the tool-calling case fails
      // through the client's own typed error, and the report carries that
      // error's detail rather than a defect dump.
      const report = yield* AgentClientConformance.run({
        layer: ({ turns }) =>
          Effect.map(TestLanguageModel.script(turns), ({ layer: model }) =>
            AgentClient.layer(Agent.make({ loop: AgentLoop.bounded(1) })).pipe(Layer.provide(model))
          )
      })
      const names = report.failed.map((failure) => failure.name)
      assert.include(names, "runs a tool-calling prompt and exposes observations")
      const failure = report.failed.find((f) => f.name === "runs a tool-calling prompt and exposes observations")
      assert.isDefined(failure)
      assert.notInclude(failure!.detail, "defect:")
      assert.isAbove(failure!.detail.length, 0)
    })
  )
})
