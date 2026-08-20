import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import {
  ClusterWorkflowEngine,
  Entity,
  ShardingConfig,
  TestRunner
} from "effect/unstable/cluster"
import * as Agent from "../src/Agent.js"
import type { AgentIdleError } from "../src/Errors.js"
import * as AgentClient from "../src/cluster/AgentClient.js"
import {
  AgentEntity,
  layer as entityLayer
} from "../src/cluster/AgentEntity.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as FakeModel from "./FakeModel.js"

/**
 * WORKFLOW_CLUSTER_PLAN Phase 6 — the session as a cluster entity.
 *
 * What is asserted here is the routing contract: the entity exposes the four
 * session operations, and out-of-band input is keyed by the entity id, which is
 * the session id. That is the part of Phase 6 that belongs to this project.
 *
 */
/** Decodes what a store holds back into plain text, for assertions. */
const textsIn = (store: DurableChannels.Store, key: string) =>
  Effect.map(store.takeAll(key), (encoded) =>
    encoded.flatMap((json) =>
      FakeModel.userTexts(
        Schema.decodeUnknownSync(Prompt.Prompt)(JSON.parse(json))
      )
    )
  )

describe("agent entity", () => {
  it("exposes the session operations as entity RPCs", () => {
    // The surface a remote client sees, and the reason no core change was
    // needed: these map one-to-one onto AgentSession's module functions.
    assert.deepStrictEqual(
      // Reaching into Effect's RpcGroup internals deliberately: there is no
      // public way to enumerate an entity's operations, and the surface a
      // remote client sees is worth pinning.
      Array.from(AgentEntity.protocol.requests.keys()).sort(),
      ["followUp", "interrupt", "steer", "submit"]
    )
    assert.strictEqual(AgentEntity.type, "AgentSession")
  })

  it.effect("out-of-band input is keyed by session id", () =>
    Effect.gen(function* () {
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("Keyed", Agent.make({}), { store })
      void durable

      // What the entity handlers do with `address.entityId`: a steer for one
      // session is invisible to another, which is what makes the entity the
      // right home for routing.
      // Keying is what this test is about, so write through the channel
      // directly rather than the admission-checked convenience functions.
      yield* DurableChannels.offer(store, "session-a", "steering", "for a")
      yield* DurableChannels.offer(store, "session-b", "followUps", "for b")

      // The store holds encoded prompts, so compare their text rather than
      // their wire form.
      assert.deepStrictEqual(
        yield* textsIn(store, "session-a:steering"),
        ["for a"]
      )
      assert.deepStrictEqual(
        yield* textsIn(store, "session-b:followUps"),
        ["for b"]
      )
      assert.deepStrictEqual(yield* textsIn(store, "session-b:steering"), [])
    })
  )

  it.live("submits and steers through a sharded entity client", () =>
    Effect.gen(function* () {
      const { layer: modelLayer } = yield* FakeModel.layer([{ text: "done" }])
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("Sharded", Agent.make({}), { store })

      const runtime = durable.layer.pipe(
        Layer.provideMerge(ClusterWorkflowEngine.layer),
        Layer.provideMerge(modelLayer)
      )
      const handlers = entityLayer(durable, store).pipe(
        Layer.provideMerge(runtime)
      )

      // A client reaches the session by id; sharding routes it to the owner.
      const makeClient = yield* Entity.makeTestClient(AgentEntity, handlers)
      const client = yield* makeClient("session-alpha")

      const executionId = yield* client.submit({ input: Prompt.make("hello") })
      assert.isString(executionId)

      yield* client.steer({ input: Prompt.make("stay on topic") })
      yield* client.followUp({ input: Prompt.make("and then this") })

      // Routed input landed under this session's keys.
      assert.deepStrictEqual(
        yield* textsIn(store, "session-alpha:followUps"),
        ["and then this"]
      )

      // And the submission the entity started actually runs to completion.
      const result = yield* Effect.retry(
        Effect.flatMap(durable.definition.poll(executionId), (polled) =>
          Option.isSome(polled) && polled.value._tag === "Complete"
            ? Effect.succeed(polled.value)
            : Effect.fail("pending" as const)
        ),
        { times: 400, schedule: Schedule.spaced(Duration.millis(10)) }
      ).pipe(Effect.provide(runtime))

      assert.strictEqual(result._tag, "Complete")
    }).pipe(
      Effect.provide(
        Layer.mergeAll(TestRunner.layer, ShardingConfig.layerDefaults)
      )
    )
  )

  it.effect("derives a session's execution id without dispatching", () =>
    Effect.gen(function* () {
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("Derived", Agent.make({}), { store })

      // The idempotency key is the session, so the prompt cannot affect the id.
      // This is what lets the entity interrupt a submission it never started,
      // and what makes `interrupt` safe to expose with no payload at all.
      const fromSession = yield* DurableAgent.executionIdFor(durable, "s-1")
      const fromPrompt = yield* durable.definition.executionId({
        sessionId: "s-1",
        prompt: Prompt.make("something entirely different")
      })
      assert.strictEqual(fromSession, fromPrompt)

      // ...and it is still per-session, not one id for everything.
      const other = yield* DurableAgent.executionIdFor(durable, "s-2")
      assert.notStrictEqual(fromSession, other)
    })
  )

  it.live("steering an idle session fails as a typed error, not a defect", () =>
    Effect.gen(function* () {
      const { layer: modelLayer } = yield* FakeModel.layer([{ text: "done" }])
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("Idle", Agent.make({}), { store })

      const handlers = entityLayer(durable, store).pipe(
        Layer.provideMerge(
          durable.layer.pipe(
            Layer.provideMerge(ClusterWorkflowEngine.layer),
            Layer.provideMerge(modelLayer)
          )
        )
      )

      const makeClient = yield* Entity.makeTestClient(AgentEntity, handlers)
      const client = yield* makeClient("never-submitted")

      // Nothing was ever submitted for this session, so there is no admission
      // marker. A remote caller must be able to tell that apart from a runner
      // falling over — which is exactly what the declared error buys.
      // `flip` succeeds with the error, so it is typed here without a cast --
      // which is the whole point of declaring it on the RPC.
      const error = yield* Effect.flip(
        client.steer({ input: Prompt.make("too late") })
      )
      assert.strictEqual(error._tag, "AgentIdleError")
      assert.strictEqual(error.operation, "steer")
    }).pipe(
      Effect.provide(
        Layer.mergeAll(TestRunner.layer, ShardingConfig.layerDefaults)
      )
    )
  )
})

describe("agent client", () => {
  it.live("takes RawInput, and normalises it before it reaches the wire", () =>
    Effect.gen(function* () {
      const { layer: modelLayer } = yield* FakeModel.layer([{ text: "done" }])
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("Wrapped", Agent.make({}), { store })

      const runtime = durable.layer.pipe(
        Layer.provideMerge(ClusterWorkflowEngine.layer),
        Layer.provideMerge(modelLayer)
      )
      const handlers = entityLayer(durable, store).pipe(
        Layer.provideMerge(runtime)
      )

      const makeRaw = yield* Entity.makeTestClient(AgentEntity, handlers)
      const client = AgentClient.wrap(yield* makeRaw("session-wrapped"))

      // A bare string is what a caller reaches for. On the generated client
      // this compiles and then fails at encode time, because `Prompt.Prompt`'s
      // type-level input is looser than what it will actually encode.
      const executionId = yield* client.submit("hello")
      assert.isString(executionId)

      // Structured input goes through the same door, unchanged.
      yield* client.steer([{ role: "user", content: [{ type: "text", text: "stay on topic" }] }])
      yield* client.followUp("and then this")

      assert.deepStrictEqual(
        yield* textsIn(store, "session-wrapped:steering"),
        ["stay on topic"]
      )
      assert.deepStrictEqual(
        yield* textsIn(store, "session-wrapped:followUps"),
        ["and then this"]
      )
    }).pipe(
      Effect.provide(
        Layer.mergeAll(TestRunner.layer, ShardingConfig.layerDefaults)
      )
    )
  )

  it.live("keeps the one error a caller can act on, and drops the rest", () =>
    Effect.gen(function* () {
      const { layer: modelLayer } = yield* FakeModel.layer([{ text: "done" }])
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("WrappedIdle", Agent.make({}), {
        store
      })

      const handlers = entityLayer(durable, store).pipe(
        Layer.provideMerge(
          durable.layer.pipe(
            Layer.provideMerge(ClusterWorkflowEngine.layer),
            Layer.provideMerge(modelLayer)
          )
        )
      )

      const makeRaw = yield* Entity.makeTestClient(AgentEntity, handlers)
      const client = AgentClient.wrap(yield* makeRaw("never-submitted"))

      // `steer` is typed as failing with `AgentIdleError` and nothing else:
      // the cluster's own transport failures are retried and then died on,
      // rather than being pushed into every call site's error handling.
      const error: AgentIdleError = yield* Effect.flip(client.steer("too late"))
      assert.strictEqual(error._tag, "AgentIdleError")
      assert.strictEqual(error.operation, "steer")

      // And `submit` has no error channel at all, so a caller writes no
      // handling for it.
      const noFailure: Effect.Effect<string, never> = client.submit("go")
      void noFailure
    }).pipe(
      Effect.provide(
        Layer.mergeAll(TestRunner.layer, ShardingConfig.layerDefaults)
      )
    )
  )
})
