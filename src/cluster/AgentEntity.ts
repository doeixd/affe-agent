import { Effect, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { Entity } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { AgentIdleError } from "../Errors.js"
import * as Elicitation from "../Elicitation.js"
import * as DurableAgent from "../durable/DurableAgent.js"
import * as DurableElicitation from "../durable/DurableElicitation.js"
import * as DurableChannels from "../durable/DurableChannels.js"

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
  Rpc.make("interrupt"),
  // Answering a paused run. Without this the cluster can suspend a submission
  // for approval and offer no way to approve it, which is the deployment where
  // a durable pause matters most.
  //
  // Returns nothing rather than whether the answer landed. `DurableDeferred`
  // does not report that, and a boolean that is always the same value is a
  // claim rather than an answer. A caller learns the truth from whether the
  // run resumes.
  Rpc.make("respond", { payload: { response: Elicitation.Response } })
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

      /**
       * Carry forward anything a previous attempt was acknowledged for and
       * never dispatched.
       *
       * In an entity handler rather than a background sweep because an
       * entity's handlers for one session are serialised by its mailbox, and
       * the entity id *is* the session -- so this is the one place where a
       * leftover row can be examined with nothing else touching it. A sweeper
       * would need that exclusion built from scratch.
       *
       * Re-dispatching is safe: the execution id is a pure function of the
       * session, so the engine answers a repeat with the execution it already
       * holds rather than starting a second one. A row that was in fact
       * dispatched before the process died therefore costs a no-op, and one
       * that was not gets its submission.
       *
       * **Run from every handler, not only `submit` (R172).** The recovery
       * used to happen on the next submission and nowhere else, so a lost
       * submission whose caller went on to steer, interrupt, or answer an
       * elicitation -- rather than submit again -- sat in the outbox with a
       * live client talking to it. Any message to the session now carries it
       * forward, which is as wide as this exclusion reaches. **What it still
       * does not cover: a session nobody ever contacts again.** Closing that
       * needs a sweeper with an exclusion story of its own.
       *
       * Best-effort on purpose. This is opportunistic recovery of work from a
       * previous process, and it must not be able to fail the operation that
       * triggered it: an `interrupt` has nothing to do with an old outbox row
       * and should not become a defect because reading one failed.
       */
      const carryForward = Effect.gen(function* () {
        const owed = yield* DurableChannels.takePendingDispatches(store, sessionId)
        yield* Effect.forEach(owed, (pending) =>
          Effect.forkDetach(
            Effect.catchCause(
              DurableAgent.throughShardReassignment(
                agent.definition.execute(
                  { sessionId, prompt: pending },
                  { discard: true }
                )
              ),
              (cause) =>
                Effect.logError("a recorded submission failed to dispatch", {
                  sessionId,
                  cause
                })
            )
          ), { discard: true })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("could not read the dispatch outbox", { sessionId, cause })
        )
      )

      return {
        // Forked deliberately. An entity handler occupies the session's
        // mailbox while it runs, and starting a workflow routes back through
        // the same runner — waiting here deadlocks the two against each other.
        // The execution id is derived without dispatching, so the caller still
        // gets it synchronously.
        submit: ({ payload }) =>
          Effect.gen(function* () {
            yield* carryForward

            const prompt = payload.input
            const executionId = yield* agent.definition.executionId({
              sessionId,
              prompt
            })
            // Admission opens before dispatch, so a client that steers straight
            // after submitting is not told the session is idle.
            //
            // A second submit for a session whose execution already completed
            // is not recognised here: polling the engine from inside the
            // entity routes through this runner, like execution does. The
            // key is the session, so the engine returns the finished
            // execution and the marker stays open until the next one. Use
            // `DurableAgentClient` for a conversation that continues across
            // submissions.
            yield* DurableAgent.open(store, sessionId)
            /**
             * R173's sibling, R172: this acknowledgement runs ahead of the
             * work, and the fork is why -- and why it cannot simply be
             * awaited.
             *
             * The caller is handed an execution id the instant admission
             * opens, before anything durable exists. Process loss in that
             * window loses the submission outright and leaves the admission
             * marker open with no execution behind it, so steering and
             * follow-ups are accepted into channels nothing will ever drain.
             * An in-process dispatch failure is only logged, after the caller
             * has already been told the submission started.
             *
             * Awaiting the dispatch instead was tried and deadlocks:
             * `execute` routes back through *this* runner, so the handler
             * would be waiting on work only the handler can process. The
             * comment above about polling the engine from inside the entity
             * is the same fact from the other side.
             *
             * The outbox row below closes it: written before the caller is
             * told anything, cleared once dispatch has landed, and carried
             * forward by the drain at the top of this handler. The row is what
             * makes the acknowledgement honest -- dispatch is still forked,
             * because it must be, but it is no longer the only record that a
             * submission exists.
             */
            yield* DurableChannels.recordPendingDispatch(store, sessionId, prompt)
            yield* Effect.forkDetach(
              DurableAgent.throughShardReassignment(
                agent.definition.execute({ sessionId, prompt }, { discard: true })
              )
                .pipe(
                  // Dispatch landed, so the outbox row has done its job. A row
                  // surviving this is a dispatch that never happened, which is
                  // exactly what the drain above looks for.
                  Effect.andThen(
                    Effect.asVoid(store.takeAll(DurableChannels.dispatchKey(sessionId)))
                  ),
                  // The caller already has its execution id, so a dispatch
                  // failure cannot be returned to it. Log rather than discard:
                  // a silently dropped submission is the worst outcome here.
                  Effect.catchCause((cause) =>
                    // And admission closes again: an open marker with no
                    // execution behind it would accept steering and
                    // follow-ups into channels nothing will ever drain.
                    //
                    // The outbox row is deliberately *left* -- an in-process
                    // failure and a dead process are the same thing from the
                    // row's point of view, and the next submit carries it
                    // forward either way.
                    Effect.logError("agent submission failed to dispatch", {
                      sessionId,
                      cause
                    }).pipe(
                      Effect.andThen(
                        Effect.asVoid(
                          store.takeAll(DurableChannels.openKey(sessionId))
                        )
                      )
                    )
                  )
                )
            )
            return executionId
          }).pipe(Effect.orDie),
        // Admission failures cross as `AgentIdleError`, declared by the RPCs
        // above, so a remote caller gets the same answer a local one would.
        // A store failure dies here rather than crossing the wire -- and only
        // a store failure. `Effect.orDie` was wrong: it took `AgentIdleError`
        // with it, which is the one error this Rpc *does* declare and the one
        // a caller can act on. Caught by `test/Cluster.test.ts`, which asserts
        // steering an idle session is a typed error and not a defect.
        //
        // These handlers implement an `Rpc` whose error schema declares
        // `AgentIdleError` and nothing else. Reporting a `StorageError` to the
        // caller would mean adding a variant to that schema -- a protocol
        // change, and one every peer has to agree to -- which is a bigger
        // decision than this triage should make on its own. The cluster
        // transport already models infrastructure failure separately from an
        // entity's declared errors, and `EntityClient` retries what it judges
        // transient, so the caller is not left without a story.
        //
        // Recorded as the open half of E14: widening the entity's error schema
        // is the better answer, and it belongs with whoever owns the wire.
        steer: ({ payload }) =>
          carryForward.pipe(
            Effect.andThen(DurableAgent.steer(store, sessionId, payload.input)),
            Effect.catchTag("StorageError", (error) => Effect.die(error))
          ),
        followUp: ({ payload }) =>
          carryForward.pipe(
            Effect.andThen(DurableAgent.followUp(store, sessionId, payload.input)),
            Effect.catchTag("StorageError", (error) => Effect.die(error))
          ),
        // Routed to the session's own execution, so a caller needs only the
        // session id it already used to submit.
        respond: ({ payload }) =>
          carryForward.pipe(
            Effect.andThen(DurableAgent.executionIdFor(agent, sessionId)),
            Effect.flatMap((executionId) =>
              DurableAgent.throughShardReassignment(
                DurableElicitation.respond({
                  workflow: agent.definition,
                  executionId,
                  response: payload.response
                })
              )
            ),
            Effect.asVoid
          ),
        interrupt: () =>
          carryForward.pipe(
            Effect.andThen(DurableAgent.executionIdFor(agent, sessionId)),
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
