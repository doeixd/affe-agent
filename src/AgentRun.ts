import { Clock, Duration, Effect, Option, Ref, SubscriptionRef } from "effect"
import type { LanguageModel, Tool } from "effect/unstable/ai"
import type { Correlation } from "./AgentEvent.js"
import type * as AgentLoop from "./AgentLoop.js"
import * as AgentTurn from "./AgentTurn.js"
import * as RunLedger from "./RunLedger.js"
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
  /** The reason the loop gave for stopping, when it gave one. */
  readonly stopReason: Option.Option<string>
}

/**
 * Execute one run: turns until the loop says stop.
 *
 * The engine executes turns; the loop decides whether another should happen.
 * Keeping that split means continuation is policy a caller can replace without
 * touching execution.
 *
 * The loop's three answers, as the engine acts on them: `Continue` is another
 * turn; `Stop` is none; `Final` is exactly one more, with the agent's tools
 * withheld, after which the loop is not asked again. That last one is the
 * only place the engine knows a decision has a *next* turn's worth of
 * meaning, and it is kept to two lines so the loop stays the policy.
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

    // Read once: `State.elapsed` is time since *this* run started, whichever
    // clock the environment provides -- a `TestClock` makes `maxDuration` an
    // assertion rather than a race.
    const startedAt = yield* Clock.currentTimeMillis

    let turn = 0
    let toolCallsTotal = 0
    let text = ""
    let response: Option.Option<LanguageModel.GenerateTextResponse<Tools, true>> =
      Option.none()
    let steeringContinuation = false
    let stopReason: Option.Option<string> = Option.none()
    // Set by a `Final` decision; the next turn is the last, tools withheld.
    let finalTurn = false

    while (true) {
      yield* AgentTurn.applySteering(session, { submissionId, runId, turn })

      turn = turn + 1
      yield* SubscriptionRef.update(session.state, (s) => ({ ...s, turn }))

      const result = yield* AgentTurn.execute(
        session,
        submissionId,
        runId,
        turn,
        options,
        { withholdTools: finalTurn }
      )
      response = Option.some(result.response)
      if (result.text.length > 0) {
        text = result.text
      }
      toolCallsTotal = toolCallsTotal + result.toolCalls.length

      // The turn has committed atomically. Record it in the submission's live
      // progress (turns is the submission-wide total, so it increments by one
      // here) so an interrupt during a *later* turn still reports this one.
      yield* Ref.update(session.progress, (p) => ({
        runs: p.runs,
        turns: p.turns + 1,
        text: result.text.length > 0 ? result.text : p.text,
        response: Option.some(result.response),
        // A turn that reported a value replaces the previous one; a turn
        // that did not leaves it alone. Same rule as `text` above, and for
        // the same reason: this is the record of what has landed.
        value: Option.isSome(result.value) ? result.value : p.value
      }))

      // Every turn is recorded -- to the ambient `RunLedger` and against the
      // ambient `Budget`, if either is in context -- before the loop is asked
      // and whether or not it will be: the final turn's tokens count too. The
      // one recording call the engine makes; see `RunLedger` for what is
      // recorded and `Budget.record` for why it is here and not in a loop
      // combinator. `elapsed` is read once and shared with the loop's state,
      // so the ledger and the state cannot disagree about the same turn.
      const elapsedMillis = (yield* Clock.currentTimeMillis) - startedAt
      yield* RunLedger.record({
        sessionId: session.id,
        submissionId,
        runId,
        turnIndex: turn,
        toolCalls: result.toolCalls.length,
        elapsedMillis,
        response: result.response
      })

      // The final turn was the loop's own last word: it is not asked again,
      // and the reason is the one its `Final` carried.
      const decision: AgentLoop.Decision = finalTurn
        ? { _tag: "Stop" }
        // Follow-up state is deliberately not passed: whether more work is
        // scheduled after this run is submission orchestration, not a reason
        // for the current run to keep going.
        : yield* session.agent.loop.decide({
          sessionId: session.id,
          submissionId,
          runId,
          turnIndex: turn,
          toolCallsTotal,
          elapsed: Duration.millis(elapsedMillis),
          response: result.response,
          toolCalls: result.toolCalls
        })

      if (decision._tag === "Final") {
        finalTurn = true
        stopReason = Option.fromNullishOr(decision.reason)
        continue
      }

      if (decision._tag === "Stop") {
        if (!finalTurn) {
          stopReason = Option.fromNullishOr(decision.reason)
        }
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
      turns: turn,
      ...(Option.isSome(stopReason) ? { stopReason: stopReason.value } : {})
    })

    return { runId, turns: turn, text, response, steeringContinuation, stopReason }
  })
