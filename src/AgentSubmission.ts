import { Cause, Effect, Exit, Option, Ref, SubscriptionRef } from "effect"
import type { LanguageModel, Prompt, Tool } from "effect/unstable/ai"
import * as AgentEvent from "./AgentEvent.js"
import type { Correlation } from "./AgentEvent.js"
import * as AgentRun from "./AgentRun.js"
import type * as AgentTurn from "./AgentTurn.js"
import * as EventBus from "./internal/eventBus.js"
import * as History from "./internal/history.js"
import * as Ids from "./internal/ids.js"
import type { SubmissionId } from "./internal/ids.js"
import * as Telemetry from "./internal/telemetry.js"

/** Correlation id for one externally observed unit of work. */
export const Id = Ids.SubmissionId
export type Id = Ids.SubmissionId
import type { Session, SessionState } from "./internal/state.js"

/** Proof that a submission was admitted and now owns its own execution. */
export interface Receipt {
  readonly submissionId: Id
}

/**
 * The outcome of one submission.
 *
 * Structured rather than a bare string: the final response carries usage,
 * finish reason and content parts that a caller would otherwise have to
 * reconstruct from the event stream.
 */
export interface Result<Tools extends Record<string, Tool.Any>, Value = never> {
  readonly submissionId: SubmissionId
  readonly status: "completed" | "interrupted"
  readonly runs: number
  readonly turns: number
  readonly text: string
  /**
   * Why the last run stopped, when its loop said: the bound or rule named by
   * `AgentLoop.stop(reason)` / `final(reason)`. `None` when the policy gave
   * no reason (`untilIdle` stopping on an idle model, a bare `Stop`) and for
   * an interrupted submission, which no loop decided.
   */
  readonly stopReason: Option.Option<string>
  /** The final model response, so usage and finish reason are not discarded. */
  readonly response: Option.Option<LanguageModel.GenerateTextResponse<Tools, true>>
  /**
   * The typed value the model reported, for an agent that declares an output.
   *
   * `Option`, not the value itself, and it stays an `Option` even for a
   * completed submission. A model can stop without calling the tool, a run can
   * be interrupted, and a loop bound can end the run first -- so a signature
   * promising a value would be a promise the harness cannot keep. An agent
   * that declares no output has `Value = never`, making this `Option<never>`:
   * always `none`, and the compiler says so rather than the docs.
   */
  readonly value: Option.Option<Value>
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
  options: AgentTurn.Options = {},
  /** The typed input's encoded form, for `SubmissionStarted`; `None` without an `AgentInput`. */
  typedInput: Option.Option<unknown> = Option.none()
) {
    const correlation: Correlation = { submissionId }
    yield* Telemetry.annotateSubmission(session.id, submissionId)
    yield* EventBus.emit(session.bus, correlation, {
      _tag: "SubmissionStarted",
      ...(Option.isSome(typedInput) ? { input: typedInput.value } : {})
    })

    let next: Prompt.Prompt | undefined = input
    let continueWithoutInput = false
    const pending: Array<Prompt.Prompt> = []
    let runs = 0
    let turns = 0
    let text = ""
    let response: Option.Option<LanguageModel.GenerateTextResponse<Tools, true>> =
      Option.none()
    let stopReason: Option.Option<string> = Option.none()

    // `session.progress` is zeroed for this submission by `AgentSession.prompt`,
    // in the uninterruptible claim before this fibre exists, so an interrupt
    // here never reports a prior submission's totals. Runs increment below;
    // turns and text/usage are updated per committed turn inside `AgentRun`.

    while (next !== undefined || continueWithoutInput) {
      if (runs > 0 && next !== undefined) {
        // Ordering: FollowUpQueued < RunCompleted < FollowUpApplied < RunStarted
        yield* EventBus.emit(session.bus, correlation, {
          _tag: "FollowUpApplied"
        })
      }
      if (next !== undefined) {
        yield* History.commit(session.history, next)
      }
      continueWithoutInput = false
      const runId = yield* session.ids.nextRun
      runs = runs + 1
      yield* Ref.update(session.progress, (p) => ({ ...p, runs }))

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
      // The last run's, not the first's: a follow-up that ran to idle after
      // a bounded first run is a submission that ended by going idle.
      stopReason = exit.value.stopReason

      // Buffered locally rather than re-queued. Putting the tail back on a
      // FIFO one item at a time reverses it, which turned A, B, C into
      // A, C, B; keeping it here preserves the order it was queued in.
      //
      // Under the input gate: `followUp` offers and announces `FollowUpQueued`
      // under the same permit, so this batch cannot contain an input whose
      // acceptance has not been announced yet.
      if (pending.length === 0) {
        pending.push(
          ...(yield* session.inputGate.withPermits(1)(session.followUps.drain))
        )
      }

      // Internal seam (default no-op): act in the window after the first drain
      // and before the close decision. The permit is free here, so a test can
      // offer a follow-up that the closing drain below must still catch.
      yield* session.beforeClose

      if (pending.length === 0 && !exit.value.steeringContinuation) {
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
          //
          // Under `inputGate`, so it is exclusive with `followUp`'s own
          // check-and-offer. A follow-up that read an open gate and has not yet
          // offered holds the permit; this drain waits for it, so its item is
          // still caught. One that starts later finds a closed gate and is
          // refused instead of being accepted and dropped on release.
          pending.push(
            ...(yield* session.inputGate.withPermits(1)(session.followUps.drain))
          )
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
      continueWithoutInput =
        next === undefined && exit.value.steeringContinuation
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

    // Read at the end rather than tracked in a local: the value is written by
    // a tool handler deep inside a turn, and `progress` is the one place this
    // submission's landed work is already collected for exactly that reason.
    const { value } = yield* Ref.get(session.progress)

    return { submissionId, runs, turns, text, response, stopReason, value }
  })
