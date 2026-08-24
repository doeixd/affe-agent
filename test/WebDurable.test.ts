import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Layer, Ref, Schema } from "effect"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { DurableDeferred } from "effect/unstable/workflow"
import * as Agent from "../src/Agent.js"
import * as ContextTransform from "../src/ContextTransform.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import { WebSearch, WebToolkit } from "../src/web/index.js"
import * as FakeModel from "./FakeModel.js"

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))
const SearchGate = DurableDeferred.make("WebSearchReplayGate", {
  success: Schema.String
})

describe("durable WebToolkit", () => {
  it.live("replay does not repeat a completed provider call", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const gateReady = yield* Deferred.make<DurableDeferred.Token>()
      const suspendOnce = yield* Ref.make(true)
      const store = yield* DurableChannels.memoryStore

      const provider = WebSearch.layer({
        search: (_query, _options) =>
          Ref.updateAndGet(calls, (n) => n + 1).pipe(
            Effect.as([
              {
                title: "Effect",
                url: "https://effect.website/",
                snippet: "Effect documentation"
              }
            ])
          )
      })
      const toolkit = yield* WebToolkit.toolkit().pipe(Effect.provide(provider))

      // Suspend only while deriving turn 2, after turn 1's search activity has
      // completed. Resumption replays turn 1 and must reuse that activity.
      const gateTurnTwo = ContextTransform.make((context) =>
        Effect.gen(function* () {
          const shouldSuspend = context.turnIndex === 2 &&
            (yield* Ref.getAndSet(suspendOnce, false))
          if (shouldSuspend) {
            const token = yield* DurableDeferred.token(SearchGate)
            yield* Deferred.succeed(gateReady, token)
            yield* DurableDeferred.await(SearchGate)
          }
          return context.canonicalPrompt
        }))

      const agent = Agent.make({ toolkit, contextTransform: gateTurnTwo })
      const durable = DurableAgent.workflow("DurableWebSearch", agent, {
        store,
        toolkit
      })
      const { layer: model } = yield* FakeModel.layer([
        {
          toolCalls: [
            { id: "search-1", name: "web_search", params: { query: "Effect" } }
          ]
        },
        { text: "done" }
      ])

      const result = yield* Effect.gen(function* () {
        const executionId = yield* DurableAgent.submit(
          durable,
          store,
          "web-session",
          "find Effect"
        )
        const token = yield* Deferred.await(gateReady)
        yield* DurableDeferred.succeed(SearchGate, { token, value: "continue" })
        return yield* DurableAgent.result(durable, executionId)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(model)
          )
        )
      )

      assert.isTrue(Exit.isSuccess(result), JSON.stringify(result))
      assert.strictEqual(yield* Ref.get(calls), 1)
    })
  )
})
