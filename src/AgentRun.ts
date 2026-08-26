import { Effect, Option, Ref, SubscriptionRef } from "effect"
import type { LanguageModel, Tool } from "effect/unstable/ai"
import type { Correlation } from "./AgentEvent.js"
import * as AgentTurn from "./AgentTurn.js"
import * as EventBus from "./internal/eventBus.js"
import * as Ids from "./internal/ids.js"
import type { RunId, SubmissionId } from "./internal/ids.js"
import * as Telemetry from "./internal/telemetry.js"

/** Correlation id for one run within a submission. */
export const Id = Ids.RunId
export type Id = Ids.RunId
import type { Session } from "./internal/state.js"

export interface Result<Tools extends Record<string, Tool.Any>> {
  readonly runId: RunId
  readonly turns: number
  readonly text: string
  readonly response: Option.Option<LanguageModel.GenerateTextResponse<Tools, true>>
  /** Steering accepted after this run's stopping decision needs a later run. */
  readonly steeringContinuation: boolean
}

/**
 * Execute one run: turns until the loop says stop.
 *
 * The engine executes turns; the loop decides whether another should happen.
 * Keeping that split means continuation is policy a caller can replace without
 * touching execution.
 */
export const execute = Effect.fn("AgentRun.execute")(function* <
  Tools extends Record<string, Tool.Any>,
  E,
  R
>(
  session: Session<Tools, E, R>,
  submissionId: SubmissionId,
  runId: RunId,
  options: AgentTurn.Options = {}
) {
    const correlation: Correlation = { submissionId, runId }
    yield* Telemetry.annotateRun(session.id, submissionId, runId)

    yield* SubscriptionRef.update(session.state, (s) => ({
      ...s,
      activeRunId: Option.some(runId),
      acceptingSteering: true,
      turn: 0
    }))
    yield* session.admitSteering(session.id, true)
    yield* EventBus.emit(session.bus, correlation, { _tag: "RunStarted" })

    let turn = 0
    let text = ""
    let response: Option.Option<LanguageModel.GenerateTextResponse<Tools, true>> =
      Option.none()
    let steeringContinuation = false

    while (true) {
      yield* AgentTurn.applySteering(session, { submissionId, runId, turn })

      turn = turn + 1
      yield* SubscriptionRef.update(session.state, (s) => ({ ...s, turn }))

      const result = yield* AgentTurn.execute(
        session,
        submissionId,
        runId,
        turn,
        options
      )
      response = Option.some(result.response)
      if (result.text.length > 0) {
        text = result.text
      }

      // The turn has committed atomically. Record it in the submission's live
      // progress (turns is the submission-wide total, so it increments by one
      // here) so an interrupt during a *later* turn still reports this one.
      yield* Ref.update(session.progress, (p) => ({
        runs: p.runs,
        turns: p.turns + 1,
        text: result.text.length > 0 ? result.text : p.text,
        response: Option.some(result.response)
      }))

      // Follow-up state is deliberately not passed: whether more work is
      // scheduled after this run is submission orchestration, not a reason for
      // the current run to keep going.
      const decision = yield* session.agent.loop.decide({
        sessionId: session.id,
        submissionId,
        runId,
        turnIndex: turn,
        response: result.response,
        toolCalls: result.toolCalls
      })

      if (decision._tag === "Stop") {
        // Close remote and local admission before the final drain. An input
        // that won the race is already in the channel and is applied below;
        // one that arrived later is refused instead of being accepted into a
        // run that has stopped looking. This is the steering counterpart of
        // AgentSubmission's closing follow-up drain.
        yield* session.inputGate.withPermits(1)(
          SubscriptionRef.update(session.state, (state) => ({
            ...state,
            acceptingSteering: false
          })).pipe(
            Effect.andThen(session.admitSteering(session.id, false))
          )
        )
        const late = yield* AgentTurn.applySteering(session, {
          submissionId,
          runId,
          turn
        })
        if (late === 0) break

        // The loop's Stop is authoritative -- in particular, maxTurns is a
        // hard per-run spend bound. The submission starts a fresh sequential
        // run so the accepted steer still changes future reasoning without
        // adding a turn that this run's policy refused.
        steeringContinuation = true
        break
      }
    }

    yield* EventBus.emit(session.bus, correlation, {
      _tag: "RunCompleted",
      turns: turn
    })

    return { runId, turns: turn, text, response, steeringContinuation }
  })
