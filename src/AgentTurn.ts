import { Effect, Stream } from "effect"
import { LanguageModel, Prompt, Response } from "effect/unstable/ai"
import { AiError } from "effect/unstable/ai"
import type { Tool, Toolkit } from "effect/unstable/ai"
import type { Correlation } from "./AgentEvent.js"
import * as ToolExecution from "./ToolExecution.js"
import * as EventBus from "./internal/eventBus.js"
import * as History from "./internal/history.js"
import type { RunId, SubmissionId } from "./internal/ids.js"
import type { Session } from "./internal/state.js"
import * as Accumulator from "./internal/streamAccumulator.js"

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
/** Per-request execution options, chosen at `prompt` time. */
export interface Options {
  /**
   * Stream the model call, emitting `MessageDelta` as output arrives.
   *
   * A request-level choice, deliberately not part of the `Agent`. The same
   * agent should be usable from an interactive UI and from a batch job, and
   * which one it is depends on the caller, not the definition.
   */
  readonly stream?: boolean | undefined
}

/** An error part carries an unconstrained payload; render it for the message. */
const describeStreamError = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const described = error as { message?: unknown }
    if (typeof described.message === "string" && described.message.length > 0) {
      return described.message
    }
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

/**
 * Run the model call as a stream, folding it back into the response the rest
 * of the turn expects.
 *
 * Everything after this point is identical to the batch path — the same tool
 * execution, the same single atomic commit. Streaming changes when output is
 * *observed*, never what is recorded.
 *
 * `MessageInterrupted` is emitted from a finalizer rather than after the fold,
 * because on interruption the continuation never runs. A consumer that had a
 * message open needs it closed, and the turn's own interruption handling takes
 * care of history: nothing partial is committed.
 */
const streamResponse = <Tools extends Record<string, Tool.Any>>(
  session: Session<Tools, any, any>,
  correlation: Correlation,
  context: Prompt.Prompt,
  handler: Toolkit.WithHandler<Tools>
): Effect.Effect<LanguageModel.GenerateTextResponse<Tools, true>, any, any> =>
  Effect.gen(function* () {
    yield* EventBus.emit(session.bus, correlation, { _tag: "MessageStarted" })

    const final = yield* Stream.runFoldEffect(
      LanguageModel.streamText({
        prompt: context,
        toolkit: handler,
        disableToolCallResolution: true
      }),
      () => Accumulator.empty<Tools>(),
      (state, part: Response.StreamPart<Tools, true>) => {
        const next = Accumulator.step(state, part)
        if (next._tag === "Failed") {
          // A typed failure, not a defect. The same condition on the batch
          // path -- the provider reporting that it could not complete the
          // call -- arrives as an `AiError`, and a caller should not have to
          // handle it differently depending on whether it asked to stream.
          return Effect.fail(
            new AiError.InternalProviderError({
              description: describeStreamError(next.error)
            })
          )
        }
        return next.delta === undefined
          ? Effect.succeed(next.state)
          : EventBus.emit(session.bus, correlation, {
              _tag: "MessageDelta",
              kind: next.delta.kind,
              delta: next.delta.delta
            }).pipe(Effect.as(next.state))
      }
    )

    yield* EventBus.emit(session.bus, correlation, {
      _tag: "MessageStreamCompleted"
    })

    return new LanguageModel.GenerateTextResponse<Tools, true>([
      ...Accumulator.finish(final)
    ])
  }).pipe(
    Effect.onInterrupt(() =>
      EventBus.emit(session.bus, correlation, { _tag: "MessageInterrupted" })
    )
  )

export const execute = Effect.fn("AgentTurn.execute")(function* <
  Tools extends Record<string, Tool.Any>,
  E,
  R
>(
  session: Session<Tools, E, R>,
  submissionId: SubmissionId,
  runId: RunId,
  turn: number,
  options: Options = {}
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

    const response = options.stream === true
      ? yield* streamResponse(session, correlation, context, handler)
      : yield* LanguageModel.generateText({
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
