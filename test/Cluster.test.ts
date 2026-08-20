import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Agent from "../src/Agent.js"
import { AgentEntity } from "../src/cluster/AgentEntity.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"

/**
 * WORKFLOW_CLUSTER_PLAN Phase 6 — the session as a cluster entity.
 *
 * What is asserted here is the routing contract: the entity exposes the four
 * session operations, and out-of-band input is keyed by the entity id, which is
 * the session id. That is the part of Phase 6 that belongs to this project.
 *
 * A full sharded round-trip is NOT covered — see the plan's Phase 6 notes. The
 * entity and its handlers are implemented; standing up `Entity.makeTestClient`
 * alongside `ClusterWorkflowEngine` in one process is unresolved.
 */
describe("agent entity", () => {
  it("exposes the session operations as entity RPCs", () => {
    // The surface a remote client sees, and the reason no core change was
    // needed: these map one-to-one onto AgentSession's module functions.
    assert.deepStrictEqual(
      Array.from((AgentEntity.protocol as any).requests.keys()).sort(),
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

      assert.deepStrictEqual(yield* store.takeAll("session-a:steering"), [
        "for a"
      ])
      assert.deepStrictEqual(yield* store.takeAll("session-b:followUps"), [
        "for b"
      ])
      assert.deepStrictEqual(yield* store.takeAll("session-b:steering"), [])
    })
  )
})
