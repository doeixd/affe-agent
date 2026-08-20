import { Effect, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { Entity } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { AgentIdleError } from "../Errors.js"
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
  // `Prompt` rather than `string`: steering a multimodal conversation with an
  // image is the same operation as steering it with a sentence, and `Prompt`
  // carries its own Schema, so it crosses the wire as cleanly as text did.
  Rpc.make("submit", {
    payload: { input: Prompt.Prompt },
    success: Schema.String
  }),
  // Admission is a real answer, not a crash. A client that steers a session
  // which has already finished should be able to tell that apart from a runner
  // falling over, and `AgentIdleError` is a `Schema.TaggedError`, so it
  // serialises across the cluster without further ceremony.
  Rpc.make("steer", {
    payload: { input: Prompt.Prompt },
    error: AgentIdleError
  }),
  Rpc.make("followUp", {
    payload: { input: Prompt.Prompt },
    error: AgentIdleError
  }),
  // No payload. The execution id is a pure function of the session, and the
  // entity id *is* the session, so asking the caller for one only created a
  // way to interrupt the wrong thing.
  Rpc.make("interrupt")
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
            const prompt = payload.input
            const executionId = yield* agent.definition.executionId({
              sessionId,
              prompt
            })
            // Admission opens before dispatch, so a client that steers straight
            // after submitting is not told the session is idle.
            yield* store.offer(`${sessionId}:open`, "open")
            yield* Effect.forkDetach(
              DurableAgent.throughShardReassignment(
                agent.definition.execute({ sessionId, prompt }, { discard: true })
              )
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
        // Admission failures cross as `AgentIdleError`, declared by the RPCs
        // above, so a remote caller gets the same answer a local one would.
        steer: ({ payload }) =>
          DurableAgent.steer(store, sessionId, payload.input),
        followUp: ({ payload }) =>
          DurableAgent.followUp(store, sessionId, payload.input),
        interrupt: () =>
          DurableAgent.executionIdFor(agent, sessionId).pipe(
            Effect.flatMap((executionId) =>
              DurableAgent.throughShardReassignment(
                agent.definition.interrupt(executionId)
              )
            )
          )
      }
    })
  )

export type AgentEntity = typeof AgentEntity
