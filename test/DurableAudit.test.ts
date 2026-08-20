import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Option, Ref, Schema } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as ToolExecution from "../src/ToolExecution.js"
import * as FakeModel from "./FakeModel.js"
import { countingModel } from "./helpers.js"

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

const Ping = Tool.make("ping", {
  parameters: Schema.Struct({ n: Schema.String }),
  success: Schema.String
})
const PingToolkit = Toolkit.make(Ping)

describe("durable edge cases", () => {
  it.live("a tool call id reused across turns still executes each time", () =>
    Effect.gen(function* () {
      // A provider is only obliged to make tool call ids unique within one
      // response. If activity identity is derived from the id alone, the second
      // turn's call collides with the first and is silently replayed — the tool
      // never runs, and nobody notices.
      const calls = yield* Ref.make<Array<string>>([])

      const toolkit = yield* PingToolkit.pipe(
        Effect.provide(
          PingToolkit.toLayer({
            ping: ({ n }) =>
              Ref.update(calls, (all) => [...all, n]).pipe(Effect.as(n))
          })
        )
      )

      const reusedId = "call-1"
      const { layer: modelLayer } = yield* FakeModel.layer([
        { toolCalls: [{ id: reusedId, name: "ping", params: { n: "first" } }] },
        { toolCalls: [{ id: reusedId, name: "ping", params: { n: "second" } }] },
        { text: "done" }
      ])

      const store = yield* DurableChannels.memoryStore
      const agent = Agent.make({
        toolkit,
        loop: AgentLoop.and(AgentLoop.untilIdle(), AgentLoop.maxTurns(3))
      })
      const durable = DurableAgent.workflow("ReusedId", agent, {
        store,
        toolkit
      })

      yield* Effect.gen(function* () {
        const id = yield* DurableAgent.submit(durable, store, "reuse-1", "go")
        yield* DurableAgent.result(durable, id)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(modelLayer)
          )
        )
      )

      assert.deepStrictEqual(
        yield* Ref.get(calls),
        ["first", "second"],
        "both calls must execute; the second must not replay the first"
      )
    })
  )

  it.live("a failed submission surfaces as Complete carrying a failed exit", () =>
    Effect.gen(function* () {
      // `result` reports the workflow's terminal Result. A failure is still a
      // *completion* from the engine's point of view, so a caller that only
      // checks `_tag === "Complete"` would read a failure as success. Pinning
      // it here so the shape cannot drift silently.
      const { layer: modelLayer } = yield* FakeModel.layer([
        { fail: "provider exploded" }
      ])
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("Failing", Agent.make({}), { store })

      const outcome = yield* Effect.gen(function* () {
        const id = yield* DurableAgent.submit(durable, store, "fail-1", "go")
        return yield* DurableAgent.result(durable, id)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(modelLayer)
          )
        )
      )

      // A failed submission is still a completed workflow; the exit is where
      // the failure lives, which is why `result` hands back the exit itself.
      assert.isTrue(Exit.isFailure(outcome))
    })
  )

  it.live("a second submit for a session rejoins the live execution", () =>
    Effect.gen(function* () {
      // The idempotency key is session-scoped, which is what makes retrying a
      // submit safe. The consequence is that a *different* input for the same
      // session does not start a second submission — it returns the existing
      // execution. That matches PLAN 11's one-submission-per-session rule, but
      // it is silent, so it is worth asserting rather than discovering.
      const calls = yield* Ref.make(0)
      const { layer: baseModel } = yield* FakeModel.layer([
        { text: "first" },
        { text: "second" }
      ])
      const counting = countingModel(baseModel, calls)

      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("Rejoin", Agent.make({}), { store })

      const [first, second] = yield* Effect.gen(function* () {
        const a = yield* DurableAgent.submit(durable, store, "same", "input-a")
        const b = yield* DurableAgent.submit(durable, store, "same", "input-b")
        yield* DurableAgent.result(durable, a)
        return [a, b] as const
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(counting)
          )
        )
      )

      assert.strictEqual(first, second, "same session means same execution")
      // And only one submission actually ran, so "input-b" was never processed.
      assert.strictEqual(yield* Ref.get(calls), 1)
    })
  )

  it.live("concurrent tool activities do not deadlock", () =>
    Effect.gen(function* () {
      // PLAN §17 executes a turn's tool calls at unbounded concurrency, and
      // effect#6014 reported concurrent `Activity.make` deadlocking. If that
      // reproduced, durable tool execution would have to fall back to
      // `Sequential`, so this guards the default rather than the plumbing.
      const ran = yield* Ref.make<Array<string>>([])

      const toolkit = yield* PingToolkit.pipe(
        Effect.provide(
          PingToolkit.toLayer({
            ping: ({ n }) =>
              Ref.update(ran, (all) => [...all, n]).pipe(Effect.as(n))
          })
        )
      )

      const store = yield* DurableChannels.memoryStore
      const agent = Agent.make({ toolkit, loop: AgentLoop.bounded(2) })
      const durable = DurableAgent.workflow("Parallel", agent, {
        store,
        toolkit
      })

      const outcome = yield* Effect.gen(function* () {
        const id = yield* DurableAgent.submit(durable, store, "par-1", "go")
        return yield* DurableAgent.result(durable, id)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(
              (yield* FakeModel.layer([
                {
                  toolCalls: [
                    { id: "a", name: "ping", params: { n: "a" } },
                    { id: "b", name: "ping", params: { n: "b" } },
                    { id: "c", name: "ping", params: { n: "c" } }
                  ]
                },
                { text: "done" }
              ])).layer
            )
          )
        ),
        Effect.timeoutOption("10 seconds")
      )

      assert.isTrue(
        Option.isSome(outcome),
        "concurrent activities deadlocked — see effect#6014"
      )
      assert.deepStrictEqual((yield* Ref.get(ran)).sort(), ["a", "b", "c"])
    })
  )

  it.live("durable steer honours the same admission contract as core", () =>
    Effect.gen(function* () {
      // The durable convenience functions must not be a weaker sibling of the
      // core API: input for a session that is not running is rejected, not
      // written to a store nobody will drain.
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("Admit", Agent.make({}), { store })

      const beforeSubmit = yield* Effect.exit(
        DurableAgent.steer(store, "admit-1", "too early")
      )
      assert.isTrue(Exit.isFailure(beforeSubmit))

      const { layer: modelLayer } = yield* FakeModel.layer([{ text: "done" }])

      yield* Effect.gen(function* () {
        const id = yield* DurableAgent.submit(durable, store, "admit-1", "go")

        // Accepted while the submission is live.
        yield* DurableAgent.steer(store, "admit-1", "while running")

        yield* DurableAgent.result(durable, id)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(modelLayer)
          )
        )
      )

      // And rejected again once the submission has finished.
      const afterFinish = yield* Effect.exit(
        DurableAgent.followUp(store, "admit-1", "too late")
      )
      assert.isTrue(Exit.isFailure(afterFinish))
    })
  )

  it.live("a failing submission surfaces as a failed exit, not a success", () =>
    Effect.gen(function* () {
      // `orDie` at the boundary would turn this into an opaque defect. The
      // tag is what a caller needs to tell a provider fault from a bad request.
      // A tool that fails in its error channel, under the policy that lets
      // that failure end the run: a *typed* failure, not a defect.
      const Boom = Tool.make("boom", {
        parameters: Schema.Struct({}),
        success: Schema.String,
        failure: Schema.String
      })
      const failing = Agent.toolkit([Boom], {
        boom: () => Effect.fail("declined")
      })

      const { layer: modelLayer } = yield* FakeModel.layer([
        { toolCalls: [{ id: "b1", name: "boom", params: {} }] }
      ])
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow(
        "Typed",
        Agent.make({
          toolkit: failing,
          toolFailurePolicy: ToolExecution.FailRun
        }),
        { store, toolkit: yield* failing }
      )

      const outcome = yield* Effect.gen(function* () {
        const id = yield* DurableAgent.submit(durable, store, "typed-1", "go")
        return yield* DurableAgent.result(durable, id)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(modelLayer)
          )
        )
      )

      // The submission fails rather than quietly succeeding. The failure
      // currently arrives as a defect: giving the workflow a typed error
      // channel ends in a SchemaError, and that is recorded as an open gap
      // rather than papered over.
      assert.isTrue(Exit.isFailure(outcome))
    })
  )
})
