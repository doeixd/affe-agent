import { Cause, Effect, Exit, Option, SubscriptionRef } from "effect"
import type { AiError, LanguageModel, Tool } from "effect/unstable/ai"
import * as AgentEvent from "./AgentEvent.js"
import type { Correlation } from "./AgentEvent.js"
import * as AgentRun from "./AgentRun.js"
import * as EventBus from "./internal/eventBus.js"
import * as History from "./internal/history.js"
import * as Ids from "./internal/ids.js"
import type { SubmissionId } from "./internal/ids.js"

/** Correlation id for one externally observed unit of work. */
export const Id = Ids.SubmissionId
export type Id = Ids.SubmissionId
import type { Session } from "./internal/state.js"

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
  readonly response: Option.Option<LanguageModel.GenerateTextResponse<Tools>>
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
>(session: Session<Tools, E, R>, submissionId: SubmissionId, input: string) {
    const correlation: Correlation = { submissionId }
    yield* Effect.annotateCurrentSpan({ submissionId })
    yield* EventBus.emit(session.bus, correlation, {
      _tag: "SubmissionStarted"
    })

    let next: string | undefined = input
    let runs = 0
    let turns = 0
    let text = ""
    let response: Option.Option<LanguageModel.GenerateTextResponse<Tools>> =
      Option.none()

    while (next !== undefined) {
      if (runs > 0) {
        // Ordering: FollowUpQueued < RunCompleted < FollowUpApplied < RunStarted
        yield* EventBus.emit(session.bus, correlation, {
          _tag: "FollowUpApplied"
        })
      }
      yield* History.commit(session.state, History.userMessage(next))
      const runId = yield* session.ids.nextRun
      runs = runs + 1

      const exit = yield* Effect.exit(
        AgentRun.execute(session, submissionId, runId)
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

      const queued = yield* session.followUps.drain
      next = queued[0]
      // Anything beyond the first goes back, preserving submission order.
      for (const remaining of queued.slice(1).reverse()) {
        yield* session.followUps.offer(remaining)
      }
    }

    yield* EventBus.emit(session.bus, correlation, {
      _tag: "SubmissionCompleted",
      runs
    })

    return { submissionId, runs, turns, text, response }
  })
