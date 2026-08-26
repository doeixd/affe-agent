import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { WorkflowEngine } from "effect/unstable/workflow"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import { AgentClient } from "../src/client/index.js"
import * as FakeModel from "./FakeModel.js"

/**
 * SD3 -- every activity boundary is a known boundary.
 *
 * An `Activity` is where durability actually happens: its result is journalled,
 * so a replay returns the recorded value instead of doing the work again. Every
 * guarantee about not repeating a billed model call or a refund is a statement
 * about these boundaries and no others.
 *
 * Which means the dangerous change is not a broken one, it is a *new* one. A
 * boundary added later inherits none of the reasoning that went into the
 * existing ones, and nothing in the suite would notice: the tests assert that
 * particular things do not repeat, not that the set of things which could
 * repeat is the set anybody has thought about.
 *
 * So this file asserts the census. `activityExecute` is the one place every
 * activity in the process passes through, whoever created it, so wrapping the
 * engine records them all -- including any added by a module this test does not
 * import.
 */

/** A tool with a side effect worth not repeating. */
const Refund = Tool.make("refund", {
  parameters: Schema.Struct({ amount: Schema.String }),
  success: Schema.String
})

/**
 * An engine that records the name of every activity it runs.
 *
 * A decorator on the real engine rather than a stub: the recording must not
 * change what the workflow does, or the census would be of a different run
 * than the one the guarantees are about.
 */
const observing = (seen: Ref.Ref<ReadonlyArray<string>>) =>
  Layer.effect(
    WorkflowEngine.WorkflowEngine,
    Effect.map(WorkflowEngine.WorkflowEngine, (inner) => ({
      ...inner,
      activityExecute: (activity, attempt) =>
        Effect.andThen(
          Ref.update(seen, (all) => [...all, activity.name]),
          inner.activityExecute(activity, attempt)
        )
    }))
  )

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

/**
 * The families a boundary can belong to, and what each one protects.
 *
 * Compared as *shapes* rather than exact names: the names carry a submission
 * id and an index, which vary per run, while the families do not. A new family
 * appears here as `unclassified`, which is the case this test exists to catch.
 */
const familyOf = (name: string): string => {
  // Both separators, because the two entry points prefix differently: the
  // agent workflow scopes with `/`, the client with `:`. Matching only one of
  // them reported the other as unclassified -- which is the classifier working,
  // and is how this line came to be written.
  if (/(^|[/:])model-\d+$/.test(name)) return "model call"
  if (/permission-\d+-/.test(name)) return "permission decision"
  if (/-drain-\d+$/.test(name)) return "channel drain"
  if (/\/finish$/.test(name)) return "session projection"
  if (/^tool-|-tool-/.test(name)) return "tool call"
  return `unclassified: ${name}`
}

describe("SD3 -- activity boundaries are enumerated, not discovered", () => {
  it.live("a representative submission crosses only known boundaries", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const refunds = yield* Ref.make(0)

      const toolkit = yield* Agent.toolkit([Refund], {
        refund: ({ amount }) =>
          Effect.as(
            Ref.update(refunds, (n) => n + 1),
            `refunded ${amount}`
          )
      })
      const agent = Agent.make({ toolkit, loop: AgentLoop.bounded(4) })

      const store = yield* DurableChannels.memoryStore
      const { layer: model } = yield* FakeModel.layer([
        { toolCalls: [{ id: "r1", name: "refund", params: { amount: "500" } }] },
        { text: "settled" }
      ])
      const durable = DurableAgent.workflow("Census", agent, { store, toolkit })

      yield* Effect.gen(function* () {
        const executionId = yield* DurableAgent.submit(durable, store, "census-1", "refund it")
        yield* DurableAgent.result(durable, executionId)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(observing(seen)),
            Layer.provideMerge(Engine),
            Layer.provideMerge(model)
          )
        )
      )

      const names = yield* Ref.get(seen)
      const families = [...new Set(names.map(familyOf))].sort()

      /**
       * The census itself, and it is not the list I expected to write.
       *
       * `permission decision` and `channel drain` are here without being asked
       * for: a durable agent journals a decision per tool call whether or not
       * a policy was configured, and drains the steering channel at the turn
       * boundary. Both are correct and both are boundaries -- which is the
       * point. A guess at this list would have been wrong in two places, so
       * guessing at which boundaries exist is exactly what no reviewer should
       * be doing.
       *
       * `session projection` is absent because it belongs to the *other* path.
       * `DurableAgent.workflow` runs a submission; the durable client's
       * `DurableSubmission` also writes the session record, and the census
       * below covers it. Two entry points, two censuses.
       *
       * A new `Activity.make` anywhere reachable from either puts a new family
       * in one of these lists, and the assertion fails until somebody decides
       * what it means for replay. The failure is the notification.
       */
      assert.deepStrictEqual(families, [
        "channel drain",
        "model call",
        "permission decision",
        "tool call"
      ])

      // A representative run, not a trivial one: it really did call a model
      // twice and run the side-effecting tool.
      assert.isAtLeast(names.filter((n) => familyOf(n) === "model call").length, 2)
      assert.strictEqual(names.filter((n) => familyOf(n) === "tool call").length, 1)
      assert.strictEqual(yield* Ref.get(refunds), 1)
    })
  )

  it.live("the durable client's submission crosses only known boundaries", () =>
    Effect.gen(function* () {
      /**
       * The same census for the other entry point.
       *
       * `DurableAgentClient` runs `DurableSubmission`, which does everything
       * the agent workflow does *and* writes the session record -- the claim,
       * the history, the admission marker. That last one is the `session
       * projection` boundary, and it is the one R173 is about, so it being
       * journalled is load-bearing rather than incidental.
       */
      const seen = yield* Ref.make<ReadonlyArray<string>>([])

      const store = yield* DurableChannels.memoryStore
      const sessionStore = yield* DurableSessionStore.memoryStore
      const delivery = yield* DeliveryLog.memoryLog
      const { layer: model } = yield* FakeModel.script([{ text: "done" }])

      const runtime = yield* Layer.build(
        DurableAgentClient.layer(
          "CensusClient",
          Agent.make({ loop: AgentLoop.bounded(2) }),
          { store, sessionStore, delivery }
        ).pipe(
          Layer.provideMerge(observing(seen)),
          Layer.provideMerge(Engine),
          Layer.provideMerge(model)
        )
      )

      yield* Effect.service(AgentClient.AgentClient).pipe(
        Effect.flatMap((client) =>
          Effect.scoped(
            Effect.flatMap(client.createSession({ sessionId: "census-2" }), (session) =>
              session.prompt("go"))
          )),
        Effect.provide(runtime)
      )

      const families = [...new Set((yield* Ref.get(seen)).map(familyOf))].sort()
      assert.deepStrictEqual(families, [
        "channel drain",
        "model call",
        "session projection"
      ])
    })
  )
})
