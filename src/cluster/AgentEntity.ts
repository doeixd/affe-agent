import { Effect, Schema } from "effect"
import { Entity } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import * as DurableAgent from "../durable/DurableAgent.js"
import type * as DurableChannels from "../durable/DurableChannels.js"

/**
 * A session, addressed as a cluster entity.
 *
 * PLAN §11's "at most one run per session" is exactly an entity invariant, and
 * `AgentSession.Id` is exactly a routing key. Making the session an entity
 * therefore buys two things the harness would otherwise have to invent:
 *
 * * single ownership across nodes, without the harness adding locking; and
 * * a home for out-of-band input — a `steer` arriving on any node is routed to
 *   the node that owns the session, by the same mechanism as everything else.
 *
 * The harness itself gains nothing and knows nothing about this.
 */
export const AgentEntity = Entity.make("AgentSession", [
  Rpc.make("submit", {
    payload: { input: Schema.String },
    success: Schema.String
  }),
  Rpc.make("steer", { payload: { input: Schema.String } }),
  Rpc.make("followUp", { payload: { input: Schema.String } }),
  Rpc.make("interrupt", { payload: { executionId: Schema.String } })
])

/**
 * Handlers backed by the durable interpreter.
 *
 * The entity id *is* the session id, which is what keeps a submission and the
 * steering aimed at it on the same node.
 */
export const layer = <W extends ReturnType<typeof DurableAgent.workflow>>(
  agent: W,
  store: DurableChannels.Store
) =>
  AgentEntity.toLayer(
    Effect.gen(function* () {
      const address = yield* Entity.CurrentAddress
      const sessionId = address.entityId

      return {
        submit: ({ payload }) =>
          DurableAgent.submit(agent, sessionId, payload.input).pipe(
            Effect.orDie
          ),
        steer: ({ payload }) =>
          DurableAgent.steer(store, sessionId, payload.input),
        followUp: ({ payload }) =>
          DurableAgent.followUp(store, sessionId, payload.input),
        interrupt: ({ payload }) =>
          agent.definition.interrupt(payload.executionId)
      }
    })
  ) as unknown as ReturnType<typeof AgentEntity.toLayer>

export type AgentEntity = typeof AgentEntity
