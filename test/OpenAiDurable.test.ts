import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient } from "../src/client/index.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import { OpenAiAgent } from "../src/openai/index.js"
import * as FakeModel from "./FakeModel.js"
import { TestLanguageModel } from "../src/testing/index.js"
import { completion, errorBody, post, readStream } from "./OpenAiHelpers.js"

/**
 * The load-bearing property of #8: the OpenAI layer is unchanged over the
 * durable client. Two HTTP nodes -- separate adapters, separate memory
 * idempotency stores -- share one durable runtime, as two processes would.
 */

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

const fixture = (
  agent: Agent.AgentDefinition<any, any, any>,
  turns: ReadonlyArray<TestLanguageModel.Turn>
) =>
  Effect.gen(function* () {
    const stores = yield* Effect.all({
      store: DurableChannels.memoryStore,
      sessionStore: DurableSessionStore.memoryStore,
      delivery: DeliveryLog.memoryLog
    })
    const { layer: model, recorder } = yield* FakeModel.script(turns)
    const runtime = yield* Layer.build(
      DurableAgentClient.layer("OpenAiDurable", agent, stores).pipe(
        Layer.provideMerge(Engine),
        Layer.provideMerge(model)
      )
    )
    const shared: Layer.Layer<AgentClient.AgentClient> = Layer.succeedContext(runtime)
    const node = Effect.gen(function* () {
      const http = yield* Layer.build(
        HttpRouter.serve(
          OpenAiAgent.serverLayer({ model: "agent" }).pipe(Layer.provide(shared)),
          { disableLogger: true, disableListenLog: true }
        ).pipe(
          Layer.provideMerge(
            NodeHttpServer.layer(createServer, { port: 0, disablePreemptiveShutdown: true })
          )
        )
      )
      return HttpServer.formatAddress(
        (yield* Effect.service(HttpServer.HttpServer).pipe(Effect.provide(http))).address
      )
    })
    const client = yield* AgentClient.AgentClient.pipe(Effect.provide(runtime))
    return { ...stores, recorder, client, a: yield* node, b: yield* node }
  })

const user = (content: string) => ({ role: "user", content })

describe("OpenAiAgent over the durable client", () => {
  it.live("non-streaming and streaming completions run as durable submissions", () =>
    Effect.gen(function* () {
      const f = yield* fixture(Agent.make({ loop: AgentLoop.bounded(2) }), [
        TestLanguageModel.text("durable one"),
        { text: "durable two", chunks: ["durable", " two"] }
      ])
      const plain = yield* post(f.a, { model: "agent", messages: [user("one")] })
      assert.strictEqual(plain.status, 200)
      assert.strictEqual((yield* completion(plain)).choices[0]?.message.content, "durable one")
      const streamed = yield* post(f.b, { model: "agent", messages: [user("two")], stream: true })
      assert.strictEqual(streamed.status, 200)
      const stream = yield* readStream(streamed)
      assert.isTrue(stream.done)
      assert.strictEqual(stream.text, "durable two")
      assert.deepStrictEqual(stream.finish, ["stop"])
      // Streamed from the delivery log, live: the provider's chunks reach
      // the log from inside the journalled activity as they arrive, so the
      // durable backend streams at the same granularity as the local one.
      // Role, "durable", " two", finish.
      assert.strictEqual(stream.chunks[0]?.choices[0]?.delta.role, "assistant")
      assert.strictEqual(stream.chunks.length, 4, `${stream.chunks.length} chunks`)
      assert.deepStrictEqual(
        stream.chunks.slice(1, 3).map((c) => c.choices[0]?.delta.content),
        ["durable", " two"]
      )
      assert.strictEqual(yield* f.recorder.calls, 2)
    }).pipe(Effect.scoped),
    30_000
  )

  it.live("a stateful session is shared by both nodes and grows by the delta only", () =>
    Effect.gen(function* () {
      const f = yield* fixture(Agent.make({ loop: AgentLoop.bounded(2) }), [
        TestLanguageModel.text("A"),
        TestLanguageModel.text("B"),
        TestLanguageModel.text("C")
      ])
      const headers = { "x-agent-session-id": "cust-1" }
      const first = yield* post(f.a, { model: "agent", messages: [user("1")] }, headers)
      assert.strictEqual((yield* completion(first)).choices[0]?.message.content, "A")
      const second = yield* post(
        f.b,
        {
          model: "agent",
          messages: [user("1"), { role: "assistant", content: "A" }, user("2")]
        },
        headers
      )
      assert.strictEqual((yield* completion(second)).choices[0]?.message.content, "B")
      const third = yield* post(
        f.a,
        { model: "agent", messages: [user("irrelevant copy"), user("3")], stream: true },
        headers
      )
      assert.strictEqual((yield* readStream(third)).text, "C")
      const record = yield* f.sessionStore.get("cust-1")
      assert.strictEqual(record._tag === "Some" ? record.value.submissionCount : 0, 3)
      const history = yield* Effect.flatMap(f.client.session("cust-1"), (s) => s.history)
      assert.deepStrictEqual(TestLanguageModel.userTexts(history), ["1", "2", "irrelevant copy", "3"])
    }).pipe(Effect.scoped),
    30_000
  )

  it.live("an idempotent retry on the other node is refused while in flight and replayed once done", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const f = yield* fixture(Agent.make({ loop: AgentLoop.bounded(2) }), [
        { text: "exactly once", started: entered, during: Deferred.await(release) },
        TestLanguageModel.text("never")
      ])
      const request = { model: "agent", messages: [user("charge the card")] }
      const headers = { "idempotency-key": "order-42" }
      const original = yield* Effect.forkChild(post(f.a, request, headers))
      yield* Deferred.await(entered)
      // Node B has never seen the key. The key names the session, so the
      // durable backend finds the work in progress and refuses to start it
      // again.
      const inFlight = yield* post(f.b, request, headers)
      assert.strictEqual(inFlight.status, 409)
      assert.strictEqual((yield* errorBody(inFlight)).error.code, "AgentBusyError")
      yield* Deferred.succeed(release, void 0)
      const done = yield* Effect.flatMap(Fiber.join(original), completion)
      assert.strictEqual(done.choices[0]?.message.content, "exactly once")
      // Retried on B after completion: the answer comes from the session's
      // history, in either shape, and the model is not called again.
      const replayed = yield* post(f.b, request, headers)
      assert.strictEqual(replayed.status, 200)
      assert.strictEqual((yield* completion(replayed)).choices[0]?.message.content, "exactly once")
      const streamed = yield* readStream(yield* post(f.b, { ...request, stream: true }, headers))
      assert.strictEqual(streamed.text, "exactly once")
      assert.isTrue(streamed.done)
      assert.strictEqual(yield* f.recorder.calls, 1)
      const record = yield* f.sessionStore.get("openai:order-42")
      assert.strictEqual(record._tag === "Some" ? record.value.submissionCount : 0, 1)
    }).pipe(Effect.scoped),
    30_000
  )

  it.live("many strict-mode requests across both nodes complete independently", () =>
    Effect.gen(function* () {
      const count = 8
      const f = yield* fixture(
        Agent.make({ loop: AgentLoop.bounded(2) }),
        Array.from({ length: count }, () => TestLanguageModel.text("ok"))
      )
      const results = yield* Effect.forEach(
        Array.from({ length: count }, (_, i) => i),
        (i) =>
          post(i % 2 === 0 ? f.a : f.b, {
            model: "agent",
            messages: [user(`req ${i}`)],
            stream: i % 3 === 0
          }).pipe(
            Effect.flatMap((response) =>
              i % 3 === 0
                ? Effect.map(readStream(response), (s) => s.text)
                : Effect.map(completion(response), (c) => c.choices[0]?.message.content ?? "")
            )
          ),
        { concurrency: "unbounded" }
      )
      assert.deepStrictEqual(results, Array.from({ length: count }, () => "ok"))
      assert.strictEqual(yield* f.recorder.calls, count)
    }).pipe(Effect.scoped),
    30_000
  )
})
