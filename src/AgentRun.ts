import { Effect, Option, SubscriptionRef } from "effect"
import type { AiError, LanguageModel, Tool } from "effect/unstable/ai"
import type { Correlation } from "./AgentEvent.js"
import * as AgentTurn from "./AgentTurn.js"
import * as EventBus from "./internal/eventBus.js"
import * as Ids from "./internal/ids.js"
import type { RunId, SubmissionId } from "./internal/ids.js"

/** Correlation id for one run within a submission. */
export const Id = Ids.RunId
export type Id = Ids.RunId
import type { Session } from "./internal/state.js"

export interface Result<Tools extends Record<string, Tool.Any>> {
  readonly runId: RunId
  readonly turns: number
  readonly text: string
  readonly response: Option.Option<LanguageModel.GenerateTextResponse<Tools>>
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
>(session: Session<Tools, E, R>, submissionId: SubmissionId, runId: RunId) {
    const correlation: Correlation = { submissionId, runId }
    yield* Effect.annotateCurrentSpan({ runId, submissionId })

    yield* SubscriptionRef.update(session.state, (s) => ({
      ...s,
      activeRunId: Option.some(runId),
      turn: 0
    }))
    yield* EventBus.emit(session.bus, correlation, { _tag: "RunStarted" })

    let turn = 0
    let text = ""
    let response: Option.Option<LanguageModel.GenerateTextResponse<Tools>> =
      Option.none()

    while (true) {
      yield* AgentTurn.applySteering(session, { submissionId, runId, turn })

      turn = turn + 1
      yield* SubscriptionRef.update(session.state, (s) => ({ ...s, turn }))

      const result = yield* AgentTurn.execute(
        session,
        submissionId,
        runId,
        turn
      )
      response = Option.some(result.response)
      if (result.text.length > 0) {
        text = result.text
      }

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

      if (decision._tag === "Stop") break
    }

    yield* EventBus.emit(session.bus, correlation, {
      _tag: "RunCompleted",
      turns: turn
    })

    return { runId, turns: turn, text, response }
  })
