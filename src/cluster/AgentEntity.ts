import { Effect, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
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
        // Forked deliberately. An entity handler occupies the session's
        // mailbox while it runs, and starting a workflow routes back through
        // the same runner — waiting here deadlocks the two against each other.
        // The execution id is derived without dispatching, so the caller still
        // gets it synchronously.
        submit: ({ payload }) =>
          Effect.gen(function* () {
            const prompt = Prompt.make(payload.input)
            const executionId = yield* agent.definition.executionId({
              sessionId,
              prompt
            })
            // Admission opens before dispatch, so a client that steers straight
            // after submitting is not told the session is idle.
            yield* store.offer(`${sessionId}:open`, "open")
            yield* Effect.forkDetach(
              agent.definition
                .execute({ sessionId, prompt }, { discard: true })
                .pipe(
                  // The caller already has its execution id, so a dispatch
                  // failure cannot be returned to it. Log rather than discard:
                  // a silently dropped submission is the worst outcome here.
                  Effect.catchCause((cause) =>
                    Effect.logError("agent submission failed to dispatch", {
                      sessionId,
                      cause
                    })
                  )
                )
            )
            return executionId
          }).pipe(Effect.orDie),
        // Admission failures are reported as defects here: the entity's RPCs
        // declare no error type, and inventing one is a protocol decision that
        // belongs with the AG-UI/RPC surface rather than with this adapter.
        steer: ({ payload }) =>
          DurableAgent.steer(store, sessionId, payload.input).pipe(
            Effect.orDie
          ),
        followUp: ({ payload }) =>
          DurableAgent.followUp(store, sessionId, payload.input).pipe(
            Effect.orDie
          ),
        interrupt: ({ payload }) =>
          agent.definition.interrupt(payload.executionId)
      }
    })
  ) as unknown as ReturnType<typeof AgentEntity.toLayer>

export type AgentEntity = typeof AgentEntity
