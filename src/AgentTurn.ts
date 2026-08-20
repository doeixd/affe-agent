import { Effect } from "effect"
import { LanguageModel, Prompt, Response } from "effect/unstable/ai"
import type { AiError, Tool, Toolkit } from "effect/unstable/ai"
import type { Correlation } from "./AgentEvent.js"
import * as ToolExecution from "./ToolExecution.js"
import * as EventBus from "./internal/eventBus.js"
import * as History from "./internal/history.js"
import type { RunId, SubmissionId } from "./internal/ids.js"
import type { Session } from "./internal/state.js"

export interface Result<Tools extends Record<string, Tool.Any>> {
  /**
   * Tool parameters are encoded; see `AgentLoop.State`.
   *
   * `toolCalls` are the calls the harness must execute — provider-executed
   * calls are excluded, since nothing is owed for them.
   */
  readonly response: LanguageModel.GenerateTextResponse<Tools, true>
  readonly toolCalls: ReadonlyArray<Response.ToolCallParts<Tools, true>>
  readonly text: string
}

/**
 * Drain pending steering into canonical history.
 *
 * This is the only place steering is observed. A steer changes future
 * reasoning; it never changes the semantics of an already-started turn.
 */
export const applySteering = <Tools extends Record<string, Tool.Any>>(
  session: Session<Tools>,
  correlation: Correlation
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const inputs = yield* session.steering.drain
    if (inputs.length === 0) return
    for (const input of inputs) {
      yield* History.commit(session.history, input)
    }
    yield* EventBus.emit(session.bus, correlation, {
      _tag: "SteeringApplied",
      count: inputs.length
    })
  })

/**
 * Resolve the agent's toolkit for this turn.
 *
 * Done per turn, so an Effect-valued toolkit can vary with runtime state. Its
 * requirements are met by the environment the session captured.
 */
const resolveToolkit = <Tools extends Record<string, Tool.Any>>(
  session: Session<Tools>
): Effect.Effect<Toolkit.WithHandler<Tools>> =>
  Effect.gen(function* () {
    const toolkit = session.agent.toolkit
    return Effect.isEffect(toolkit) ? yield* toolkit : toolkit
  }) as Effect.Effect<Toolkit.WithHandler<Tools>>

/**
 * Execute one turn: derive context, call the model, run its tool calls, and
 * commit the whole thing exactly once.
 *
 * The commit is atomic on purpose. Committing the assistant message before the
 * tools have run would leave an interrupted turn half-recorded — an assistant
 * message requesting tools whose results never arrive — which is a state no
 * subsequent model call can make sense of.
 */
export const execute = Effect.fn("AgentTurn.execute")(function* <
  Tools extends Record<string, Tool.Any>,
  E,
  R
>(
  session: Session<Tools, E, R>,
  submissionId: SubmissionId,
  runId: RunId,
  turn: number
) {
    // Correlation is passed down rather than read back from state: the caller
    // already knows it, and state is shared mutable data that may have moved on.
    const correlation: Correlation = { submissionId, runId, turn }
    yield* Effect.annotateCurrentSpan({ runId, turn })

    // Ordering per PLAN §14: steering has already been drained and committed by
    // the run, so the snapshot includes it. The prompt is derived before
    // `TurnStarted` is emitted, so a transform that fails cannot leave an
    // orphaned `TurnStarted` with no matching `TurnCompleted`.
    const canonicalPrompt = yield* History.snapshot(session.history)
    // Ephemeral: the transform's output feeds this model call and nothing else.
    const context = yield* session.agent.contextTransform.transform({
      sessionId: session.id,
      submissionId,
      runId,
      turnIndex: turn,
      canonicalPrompt,
      prompt: canonicalPrompt
    })
    const handler = yield* resolveToolkit(session)

    yield* EventBus.emit(session.bus, correlation, { _tag: "TurnStarted" })

    const response = yield* LanguageModel.generateText({
      prompt: context,
      toolkit: handler,
      // The harness owns tool execution so that it can emit the lifecycle
      // events, choose the concurrency, and commit results itself.
      disableToolCallResolution: true
    })

    // Calls the provider already executed are resolved: their results are in
    // the response, and Effect AI's own resolver skips them too. Running them
    // locally would repeat a side effect the provider performed, and counting
    // them as outstanding work would keep the loop going with nothing to do.
    const toolCalls = response.toolCalls.filter(
      (call) => call.providerExecuted !== true
    )

    let toolResults: ReadonlyArray<Response.AnyPart> = []
    if (toolCalls.length > 0) {
      toolResults = yield* ToolExecution.execute(handler, toolCalls, {
        bus: session.bus,
        correlation,
        strategy: session.agent.toolExecution,
        failurePolicy: session.agent.toolFailurePolicy
      })
    }

    // One commit, after all work for the turn has succeeded.
    const committed = Prompt.concat(
      History.fromResponseParts(response.content),
      History.fromResponseParts(toolResults)
    )
    yield* History.commit(session.history, committed)

    const text = response.text
    if (text.length > 0) {
      yield* EventBus.emit(session.bus, correlation, {
        _tag: "MessageCompleted",
        text
      })
    }

    yield* EventBus.emit(session.bus, correlation, { _tag: "TurnCompleted" })

    return { response, toolCalls, text }
  })
