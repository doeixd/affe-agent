import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Ref, Schema } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { DurableDeferred } from "effect/unstable/workflow"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import * as Agent from "../src/Agent.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as FakeModel from "./FakeModel.js"

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

/**
 * WORKFLOW_CLUSTER_PLAN Phases 1–3.
 *
 * The claim under test is the plan's central one: the *same* agent definition
 * runs durably, and a resumed submission replays completed model and tool calls
 * instead of repeating them.
 */

const Gate = DurableDeferred.make("DurableTestGate", { success: Schema.String })
const Gate2 = DurableDeferred.make("DurableTestGate2", { success: Schema.String })

const Refund = Tool.make("refund", {
  parameters: Schema.Struct({ amount: Schema.String }),
  success: Schema.String
})
const RefundToolkit = Toolkit.make(Refund)

describe("durable submissions", () => {
  it.live("a submission runs durably with no change to the agent", () =>
    Effect.gen(function* () {
      const { layer: modelLayer } = yield* FakeModel.layer([{ text: "done" }])
      const store = yield* DurableChannels.memoryStore

      // The very same value an embedded session would take.
      const Researcher = Agent.make({ instructions: "Be brief." })

      const durable = DurableAgent.workflow("Researcher", Researcher, { store })

      const text = yield* Effect.gen(function* () {
        const executionId = yield* DurableAgent.submit(durable, "s1", "hello")
        const result = yield* DurableAgent.result(durable, executionId)
        return result
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(modelLayer)
          )
        )
      )

      assert.strictEqual(text._tag, "Complete")
    })
  )

  it.live("a resumed submission does not repeat a completed tool call", () =>
    Effect.gen(function* () {
      // The scenario the plan names: a refund must not go out twice.
      const refunds = yield* Ref.make<Array<string>>([])
      const modelCalls = yield* Ref.make(0)
      const gateReady = yield* Deferred.make<DurableDeferred.Token>()

      const refundToolkit = yield* RefundToolkit.pipe(
        Effect.provide(
          RefundToolkit.toLayer({
            refund: ({ amount }) =>
              Ref.update(refunds, (all) => [...all, amount]).pipe(
                Effect.as(`refunded ${amount}`)
              )
          })
        )
      )

      // Turn 1 calls the tool; the agent then suspends on a durable gate;
      // turn 2 finishes after resumption.
      const script: Array<FakeModel.Turn> = [
        { toolCalls: [{ id: "r1", name: "refund", params: { amount: "500" } }] },
        { text: "settled" }
      ]

      const { layer: baseModel } = yield* FakeModel.layer(script)
      const countingModel = Layer.effect(
        LanguageModel.LanguageModel,
        Effect.gen(function* () {
          const inner = yield* LanguageModel.LanguageModel
          return {
            ...inner,
            generateText: ((options: any) =>
              Ref.update(modelCalls, (n) => n + 1).pipe(
                Effect.andThen(inner.generateText(options))
              )) as LanguageModel.Service["generateText"]
          }
        })
      ).pipe(Layer.provide(baseModel))

      const store = yield* DurableChannels.memoryStore

      // A context transform is a convenient place to suspend mid-submission:
      // it runs inside the workflow, before turn 2's model call.
      const suspendOnce = yield* Ref.make(true)
      const gating = {
        transform: (context: { canonicalPrompt: unknown }) =>
          Effect.gen(function* () {
            const shouldSuspend = yield* Ref.getAndSet(suspendOnce, false)
            if (shouldSuspend) {
              const token = yield* DurableDeferred.token(Gate)
              yield* Deferred.succeed(gateReady, token)
              yield* DurableDeferred.await(Gate)
            }
            return context.canonicalPrompt
          }) as any
      }

      const Support = Agent.make({
        toolkit: refundToolkit,
        contextTransform: gating as any
      })

      const durable = DurableAgent.workflow("Support", Support, {
        store,
        toolkit: refundToolkit
      })

      yield* Effect.gen(function* () {
        const executionId = yield* DurableAgent.submit(durable, "s2", "refund")

        // Wait for the suspension, then wake it as an external actor would.
        const token = yield* Deferred.await(gateReady)
        yield* DurableDeferred.succeed(Gate, { token, value: "go" })

        yield* DurableAgent.result(durable, executionId)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(countingModel)
          )
        )
      )

      // The decisive assertions: the refund happened once, and turn 1's model
      // call was replayed rather than re-issued.
      assert.deepStrictEqual(yield* Ref.get(refunds), ["500"])
      assert.strictEqual(
        yield* Ref.get(modelCalls),
        2,
        "each model call should execute once across the resumption"
      )
    })
  )

  it.live("steering survives a suspension and is applied exactly once", () =>
    Effect.gen(function* () {
      // Phase 3: the drain must be replay-stable. If it were not, the resumed
      // turn would derive a prompt without the steer — or apply it twice.
      const gateReady = yield* Deferred.make<DurableDeferred.Token>()
      const store = yield* DurableChannels.memoryStore

      const { layer: modelLayer, recorder } = yield* FakeModel.layer([
        { text: "first" },
        { text: "second" }
      ])

      const suspendOnce = yield* Ref.make(true)
      const gating = {
        transform: (context: { canonicalPrompt: unknown }) =>
          Effect.gen(function* () {
            const shouldSuspend = yield* Ref.getAndSet(suspendOnce, false)
            if (shouldSuspend) {
              const token = yield* DurableDeferred.token(Gate2)
              yield* Deferred.succeed(gateReady, token)
              yield* DurableDeferred.await(Gate2)
            }
            return context.canonicalPrompt
          }) as any
      }

      const Looping = Agent.make({
        contextTransform: gating as any,
        loop: {
          decide: (state: any) =>
            Effect.succeed(
              state.turnIndex < 2 ? { _tag: "Continue" } : { _tag: "Stop" }
            )
        } as any
      })

      const durable = DurableAgent.workflow("Steered", Looping, { store })

      yield* Effect.gen(function* () {
        const executionId = yield* DurableAgent.submit(durable, "s3", "go")

        const token = yield* Deferred.await(gateReady)
        // Queued while the submission is suspended — the realistic case.
        yield* DurableAgent.steer(store, "s3", "stay on topic")
        yield* DurableDeferred.succeed(Gate2, { token, value: "go" })

        yield* DurableAgent.result(durable, executionId)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(modelLayer)
          )
        )
      )

      const prompts = yield* recorder.prompts
      const steered = prompts.filter((prompt) =>
        FakeModel.userTexts(prompt).includes("stay on topic")
      )
      // Applied, and applied once: it appears from the turn that drained it
      // onward, and is never drained a second time.
      assert.isAtLeast(steered.length, 1)
      const last = prompts[prompts.length - 1]!
      assert.strictEqual(
        FakeModel.userTexts(last).filter((t) => t === "stay on topic").length,
        1
      )
    })
  )
})
