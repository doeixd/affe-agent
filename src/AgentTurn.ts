import { Cause, Effect, Option, Stream } from "effect"
import { LanguageModel, Prompt, Response } from "effect/unstable/ai"
import { AiError } from "effect/unstable/ai"
import type { Tool, Toolkit } from "effect/unstable/ai"
import * as AgentEvent from "./AgentEvent.js"
import type { Correlation } from "./AgentEvent.js"
import * as ToolExecution from "./ToolExecution.js"
import * as EventBus from "./internal/eventBus.js"
import * as History from "./internal/history.js"
import * as InternalToolkit from "./internal/toolkit.js"
import type { RunId, SubmissionId } from "./internal/ids.js"
import type { Session } from "./internal/state.js"
import * as Accumulator from "./internal/streamAccumulator.js"
import * as Telemetry from "./internal/telemetry.js"

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
 *
 * Under the input gate, which `steer`'s offer-and-announce also holds: the
 * drained batch therefore cannot contain an input whose `SteeringQueued` has
 * not been published yet.
 */
export const applySteering = <Tools extends Record<string, Tool.Any>>(
  session: Session<Tools>,
  correlation: Correlation
): Effect.Effect<number> =>
  session.inputGate.withPermits(1)(
    Effect.gen(function* () {
      const inputs = yield* session.steering.drain
      if (inputs.length === 0) return 0
      for (const input of inputs) {
        yield* History.commit(session.history, input)
      }
      yield* EventBus.emit(session.bus, correlation, {
        _tag: "SteeringApplied",
        count: inputs.length
      })
      return inputs.length
    })
  )

/**
 * Resolve the agent's toolkit for this turn.
 *
 * Done per turn, so an Effect-valued toolkit can vary with runtime state. Its
 * requirements are met by the environment the session captured.
 */
const resolveToolkit = <Tools extends Record<string, Tool.Any>>(
  session: Session<Tools>
): Effect.Effect<Toolkit.WithHandler<Tools>> =>
  // The session env satisfies the toolkit's requirements, so the shared
  // resolver's `E`/`R` are discharged to `never` here.
  InternalToolkit.resolveToolkitInput(session.agent.toolkit) as Effect.Effect<Toolkit.WithHandler<Tools>>

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

/**
 * Run the model call under the agent's `ExecutionPlan`, if it has one.
 *
 * **Only the model call.** A turn is a model call *and the tool calls it asked
 * for*; a plan around the turn would retry tools -- side effects on the world
 * -- because a different part of the turn failed. Confining it here also makes
 * retry safe by construction: nothing the harness commits has happened yet
 * while the plan is still choosing, so falling back cannot disturb canonical
 * history, the event ordering, or the atomic turn commit.
 *
 * The streaming path has its own version below, `withPlanStream`, because
 * falling back mid-stream is a different question -- see there.
 */
const withPlan = <A, E, R>(
  session: Session<any, any, any>,
  call: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Option.match(session.agent.executionPlan, {
    onNone: () => call,
    onSome: (plan) =>
      Effect.withExecutionPlan(call, plan, {
        onEvent: Telemetry.recordAttempt
      })
  })

/**
 * The same, for the streamed model call.
 *
 * Streaming is the hard case: `MessageDelta` is emitted *as the stream runs*,
 * so a fallback after partial output would leave an observer holding text the
 * transcript will never contain. `preventFallbackOnPartialStream` is exactly
 * the policy that forbids it -- once a step has emitted, its failure is final
 * and the ladder stops. Effect ships the option, so this is a choice we
 * declare rather than a mechanism we build.
 *
 * That is the conservative side of the trade, deliberately. It gives up the
 * cases where a fallback might have helped -- and a provider that died
 * halfway through a message is rarely rescued by a retry that starts over,
 * while a viewer shown two `MessageStarted` events for one turn is a bug in
 * every case.
 *
 * Slightly more conservative than strictly necessary, and worth knowing: the
 * option counts any emitted *stream part*, while we only emit a `MessageDelta`
 * for some of them. A part that produced no delta still blocks the fallback.
 * Erring toward "do not mix partial output with a retry" is the right
 * direction for a rule whose whole purpose is that.
 *
 * `MessageStarted` sits outside this, emitted once before the stream is run,
 * so a fallback that happens before any part is invisible to an observer --
 * which is the outcome worth having.
 */
const withPlanStream = <A, E, R>(
  session: Session<any, any, any>,
  stream: Stream.Stream<A, E, R>
): Stream.Stream<A, E, R> =>
  Option.match(session.agent.executionPlan, {
    onNone: () => stream,
    onSome: (plan) =>
      Stream.withExecutionPlan(stream, plan, {
        preventFallbackOnPartialStream: true,
        onEvent: Telemetry.recordAttempt
      })
  })

const streamResponse = <Tools extends Record<string, Tool.Any>>(
  session: Session<Tools, any, any>,
  correlation: Correlation,
  context: Prompt.Prompt,
  handler: Toolkit.WithHandler<Tools>
): Effect.Effect<LanguageModel.GenerateTextResponse<Tools, true>, any, any> =>
  Effect.gen(function* () {
    // Uninterruptible, so the open always precedes the close the finalizer
    // below owes: an interrupt landing while this emit waited on the bus
    // permit produced a `MessageInterrupted` for a message never started.
    yield* Effect.uninterruptible(
      EventBus.emit(session.bus, correlation, { _tag: "MessageStarted" })
    )

    const final = yield* Stream.runFoldEffect(
      withPlanStream(
        session,
        LanguageModel.streamText({
          prompt: context,
          toolkit: handler,
          disableToolCallResolution: true
        })
      ),
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
              description: Accumulator.describeStreamError(next.error)
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
    // Every opened message owes a terminal event, and there are two ways for
    // one not to arrive. Interruption was handled; failure was not, so a
    // provider error left a consumer rendering a message that never resolved
    // while the run itself reported `RunFailed`.
    //
    // `onExit` rather than `onInterrupt` because the continuation does not run
    // in either case.
    Effect.onExit((exit) =>
      exit._tag === "Success"
        ? Effect.void
        : EventBus.emit(
            session.bus,
            correlation,
            Cause.hasInterruptsOnly(exit.cause)
              ? { _tag: "MessageInterrupted" }
              : {
                  _tag: "MessageFailed",
                  failure: AgentEvent.failureFromCause(exit.cause)
                }
          )
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
    yield* Telemetry.annotateTurn(session.id, runId, turn)

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
      : yield* withPlan(
          session,
          LanguageModel.generateText({
            prompt: context,
            toolkit: handler,
            // The harness owns tool execution so that it can emit the lifecycle
            // events, choose the concurrency, and commit results itself.
            disableToolCallResolution: true
          })
        )

    // Calls the provider already executed are resolved: their results are in
    // the response, and Effect AI's own resolver skips them too. Running them
    // locally would repeat a side effect the provider performed, and counting
    // them as outstanding work would keep the loop going with nothing to do.
    const toolCalls = response.toolCalls.filter(
      (call) => call.providerExecuted !== true
    )

    /**
     * A response must not name one call id twice.
     *
     * The whole correlation story rests on this: a tool result is matched to
     * its call by id, `internal/toolActivity.ts` states outright that provider
     * call ids are unique within one response, and `DurableToolkit` and
     * `DurablePermission` key replay identity on `(tool name, call id,
     * occurrence)`. Nothing checked it.
     *
     * Two concurrent calls sharing an id both read occurrence zero before
     * either updates its wrapper-local counter, so they ask for the same
     * workflow activity -- which can replay one sibling's result into the
     * other, suppress one side effect entirely, or conflict depending on the
     * engine's semantics. Outside durability the same response is still
     * ambiguous: a UI patches the wrong row, and history cannot say which
     * result belonged to which call.
     *
     * Refused rather than deduplicated. Dropping one of two calls silently
     * decides that the model meant one thing when it said two, and a provider
     * emitting this is malformed in a way the run should stop for -- not one
     * the model can be asked to correct, since it did not choose the ids.
     */
    const seenIds = new Set<string>()
    for (const call of toolCalls) {
      if (seenIds.has(call.id)) {
        return yield* Effect.die(
          new Error(
            `The model's response contains two tool calls with the id ${call.id}.` +
              ` Call ids identify a result, a permission decision and a durable` +
              ` activity, so two calls sharing one cannot be told apart.`
          )
        )
      }
      seenIds.add(call.id)
    }

    let toolResults: ReadonlyArray<Response.AnyPart> = []
    if (toolCalls.length > 0) {
      toolResults = yield* ToolExecution.execute(handler, toolCalls, {
        session: {
          id: session.id,
          bus: session.bus,
          elicitation: session.elicitation,
          nextElicitationId: session.ids.nextElicitation
        },
        agent: {
          strategy: session.agent.toolExecution,
          failurePolicy: session.agent.toolFailurePolicy,
          denialPolicy: session.agent.toolDenialPolicy,
          permission: session.agent.permission
        },
        correlation,
        // What the model saw, plus what it said: the conversation up to
        // the call, as Effect AI's own resolver would hand `needsApproval`.
        messages: [...context.content, ...History.fromResponseParts(response.content).content]
      })
    }

    // One commit, after all work for the turn has succeeded — and an
    // uninterruptible one. Once the tools have run, their side effects are
    // real; an interrupt landing between their completion and this commit
    // would drop the assistant message and the results of calls the event
    // stream has already reported as succeeded. The commit does not block,
    // so holding interruption off for it costs nothing.
    const committed = Prompt.concat(
      History.fromResponseParts(response.content),
      History.fromResponseParts(toolResults)
    )
    /**
     * The commit *and* the events that announce it, as one step.
     *
     * The commit alone was uninterruptible, and the two emissions were back in
     * the interruptible region. `SessionTree.capture` records a node only when
     * it observes `TurnCompleted`, so an interrupt landing after the history
     * write but before that event left a real committed turn with *no tree
     * node* -- and no way to recover the boundary, because a later turn's
     * capture folds both turns into one snapshot. The submission could also
     * report itself interrupted while its response was already canonical.
     *
     * Neither emission blocks: publication is to an unbounded PubSub, and the
     * observers under the permit are the tree's capture and whatever the
     * application attached. Holding interruption off across them costs the
     * same nothing the commit already cost, and buys the invariant that a
     * committed turn is always a turn the tree saw.
     */
    const text = response.text
    yield* Effect.uninterruptible(
      Effect.gen(function*() {
        yield* History.commit(session.history, committed)

        if (text.length > 0) {
          yield* EventBus.emit(session.bus, correlation, {
            _tag: "MessageCompleted",
            text
          })
        }

        yield* EventBus.emit(session.bus, correlation, { _tag: "TurnCompleted" })
      })
    )

    return { response, toolCalls, text }
  })
