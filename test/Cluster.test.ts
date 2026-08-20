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
      yield* DurableAgent.steer(store, "session-a", "for a")
      yield* DurableAgent.followUp(store, "session-b", "for b")

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

      const executionId = yield* client.submit({ input: "hello" })
      assert.isString(executionId)

      yield* client.steer({ input: "stay on topic" })
      yield* client.followUp({ input: "and then this" })

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
})
