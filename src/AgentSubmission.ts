import { Cause, Effect, Exit, Option, SubscriptionRef } from "effect"
import type { AiError, LanguageModel, Prompt, Tool } from "effect/unstable/ai"
import * as AgentEvent from "./AgentEvent.js"
import type { Correlation } from "./AgentEvent.js"
import * as AgentRun from "./AgentRun.js"
import type * as AgentTurn from "./AgentTurn.js"
import * as EventBus from "./internal/eventBus.js"
import * as History from "./internal/history.js"
import * as Ids from "./internal/ids.js"
import type { SubmissionId } from "./internal/ids.js"

/** Correlation id for one externally observed unit of work. */
export const Id = Ids.SubmissionId
export type Id = Ids.SubmissionId
import type { Session, SessionState } from "./internal/state.js"

/**
 * The outcome of one submission.
 *
 * Structured rather than a bare string: the final response carries usage,
 * finish reason and content parts that a caller would otherwise have to
 * reconstruct from the event stream.
 */
export interface Result<Tools extends Record<string, Tool.Any>> {
  readonly submissionId: SubmissionId
  readonly status: "completed" | "interrupted"
  readonly runs: number
  readonly turns: number
  readonly text: string
  /** The final model response, so usage and finish reason are not discarded. */
  readonly response: Option.Option<LanguageModel.GenerateTextResponse<Tools, true>>
}

/**
 * Execute a submission: the initial input, then a further run for each
 * follow-up queued before the session goes quiet.
 *
 * Follow-ups never modify the run that is executing; they schedule later runs
 * under the same submission, which is what keeps `prompt` pending until the
 * whole chain settles.
 */
export const execute = Effect.fn("AgentSubmission.execute")(function* <
  Tools extends Record<string, Tool.Any>,
  E,
  R
>(
  session: Session<Tools, E, R>,
  submissionId: SubmissionId,
  input: Prompt.Prompt,
  options: AgentTurn.Options = {}
) {
    const correlation: Correlation = { submissionId }
    yield* Effect.annotateCurrentSpan({ submissionId })
    yield* EventBus.emit(session.bus, correlation, {
      _tag: "SubmissionStarted"
    })

    let next: Prompt.Prompt | undefined = input
    const pending: Array<Prompt.Prompt> = []
    let runs = 0
    let turns = 0
    let text = ""
    let response: Option.Option<LanguageModel.GenerateTextResponse<Tools, true>> =
      Option.none()

    while (next !== undefined) {
      if (runs > 0) {
        // Ordering: FollowUpQueued < RunCompleted < FollowUpApplied < RunStarted
        yield* EventBus.emit(session.bus, correlation, {
          _tag: "FollowUpApplied"
        })
      }
      yield* History.commit(session.history, next)
      const runId = yield* session.ids.nextRun
      runs = runs + 1

      const exit = yield* Effect.exit(
        AgentRun.execute(session, submissionId, runId, options)
      )

      yield* SubscriptionRef.update(session.state, (s) => ({
        ...s,
        activeRunId: Option.none()
      }))

      if (Exit.isFailure(exit)) {
        yield* EventBus.emit(
          session.bus,
          { submissionId, runId },
          Cause.hasInterruptsOnly(exit.cause)
            ? { _tag: "RunInterrupted" }
            : {
                _tag: "RunFailed",
                failure: AgentEvent.failureFromCause(exit.cause)
              }
        )
        // A failed run ends its submission but never the session.
        return yield* Effect.failCause(exit.cause)
      }

      turns = turns + exit.value.turns
      if (exit.value.text.length > 0) {
        text = exit.value.text
      }
      response = Option.orElse(exit.value.response, () => response)

      // Buffered locally rather than re-queued. Putting the tail back on a
      // FIFO one item at a time reverses it, which turned A, B, C into
      // A, C, B; keeping it here preserves the order it was queued in.
      if (pending.length === 0) {
        pending.push(...(yield* session.followUps.drain))
      }

      if (pending.length === 0) {
        // Nothing left, so close this submission's input. Until this flips,
        // `followUp` may still be accepted, and anything accepted after the
        // drain above would be silently discarded on release.
        const closed = yield* SubscriptionRef.modify(
          session.state,
          (state): [boolean, SessionState] =>
            state.acceptingFollowUps
              ? [true, { ...state, acceptingFollowUps: false }]
              : [false, state]
        )

        if (closed) {
          // Publish the close before the drain below, not after.
          //
          // An out-of-process caller reads the published marker, so until this
          // lands its `followUp` still succeeds. Doing it here means anything
          // accepted while the marker was stale was necessarily offered before
          // this point, and the drain that follows therefore catches it;
          // anything after is refused outright. Publishing after the drain
          // would leave precisely the gap this ordering removes.
          yield* session.admit(session.id, false)

          // One more drain, now that nothing further can be accepted: this
          // catches anything that slipped in before the close.
          pending.push(...(yield* session.followUps.drain))
          if (pending.length > 0) {
            // Late work arrived, so re-open and keep going.
            yield* SubscriptionRef.update(session.state, (state) => ({
              ...state,
              acceptingFollowUps: true
            }))
            yield* session.admit(session.id, true)
          }
        }
      }

      next = pending.shift()
      if (next !== undefined) {
        yield* SubscriptionRef.update(session.state, (state) => ({
          ...state,
          acceptingFollowUps: true
        }))
        yield* session.admit(session.id, true)
      }
    }

    yield* EventBus.emit(session.bus, correlation, {
      _tag: "SubmissionCompleted",
      runs
    })

    return { submissionId, runs, turns, text, response }
  })
