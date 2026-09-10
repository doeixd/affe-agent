import { Cause, Effect, ExecutionPlan, Option, Ref, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/unstable/ai"
import { AiError } from "effect/unstable/ai"
import * as Catalog from "./code/Catalog.js"
import { CurrentPrincipal } from "./Principal.js"
import * as ToolExposure from "./ToolExposure.js"
import * as AgentEvent from "./AgentEvent.js"
import type * as AgentOutput from "./AgentOutput.js"
import type { Correlation } from "./AgentEvent.js"
import * as ToolExecution from "./ToolExecution.js"
import * as EventBus from "./internal/eventBus.js"
import * as History from "./internal/history.js"
import * as InternalToolkit from "./internal/toolkit.js"
import type { RunId, SubmissionId } from "./internal/ids.js"
import type { Session } from "./internal/state.js"
import * as Accumulator from "./internal/streamAccumulator.js"
import * as Telemetry from "./internal/telemetry.js"
import { turnFailpoints } from "./internal/turnFailpoints.js"

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
  /**
   * The value the output tool recorded during this turn, if it was called.
   *
   * Returned rather than written to `progress` here, so that a value is
   * visible to the submission only once its turn has committed.
   */
  readonly value: Option.Option<unknown>
  /** How `value` arrived, when it did. */
  readonly answeredBy: Option.Option<AgentEvent.AnsweredBy>
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
 * Resolve the agent's toolkit for this turn, plus the output tool if the agent
 * declares one.
 *
 * Done per turn, so an Effect-valued toolkit can vary with runtime state. Its
 * requirements are met by the environment the session captured.
 *
 * The output tool is merged in here rather than folded into the agent's
 * toolkit at definition time, because its handler has to close over *this*
 * session's progress -- an `Agent` is a value that many sessions share, and a
 * handler bound at definition time would write one session's answer into
 * another's. Merging is `mergeHandled`, the same delegation `Agent.withTools`
 * uses, so the output tool is dispatched, decoded, executed, committed and
 * announced exactly as any other tool is. A duplicate name is a defect at
 * resolution, which is what `mergeHandled` already reports.
 */
const resolveToolkit = <Tools extends Record<string, Tool.Any>>(
  session: Session<Tools>,
  withholdTools: boolean,
  history: Prompt.Prompt,
  principal: Option.Option<string>
): Effect.Effect<{
  readonly handler: Toolkit.WithHandler<Tools>
  /** The names this turn exposes (`ToolExposure`), or `None` when nothing is restricted. */
  readonly exposed: Option.Option<ReadonlySet<string>>
}> =>
  Effect.gen(function* () {
    const resolved = withholdTools
      ? yield* withheld<Tools>()
      // The session env satisfies the toolkit's requirements, so the shared
      // resolver's `E`/`R` are discharged to `never` here.
      : yield* (InternalToolkit.resolveToolkitInput(session.agent.toolkit) as Effect.Effect<
        Toolkit.WithHandler<Tools>
      >)
    const registered: ReadonlyArray<Tool.Any> = Object.values(resolved.tools)
    const exposure = session.agent.toolExposure
    // The harness's own tools, merged per turn: the output tool, and under
    // progressive exposure the discovery tool -- never on a `Final` turn.
    const discovery = !withholdTools && exposure._tag === "Progressive"
      ? Option.some(yield* discoveryToolkit(exposure, registered, principal))
      : Option.none()
    const output = yield* Effect.transposeOption(Option.map(session.agent.output, (o) => outputToolkit(session, o)))
    const extra = Option.isSome(output) && Option.isSome(discovery)
      ? Option.some(InternalToolkit.mergeHandled(output.value, discovery.value))
      : Option.orElse(output, () => discovery)
    const handler = Option.match(extra, {
      onNone: () => resolved,
      onSome: (tools) => InternalToolkit.mergeHandled(resolved, tools) as unknown as Toolkit.WithHandler<Tools>
    })
    const exposed = withholdTools
      ? Option.none()
      : ToolExposure.exposed(
        exposure,
        registered.map((tool) => tool.name),
        Option.match(session.agent.output, { onNone: () => [], onSome: (o) => [o.toolName] }),
        principal,
        history
      )
    return { handler, exposed }
  })

/**
 * The model call's `toolChoice` for an exposure: `oneOf` the exposed names, so
 * the provider is sent only their schemas, while the response is still
 * decoded against the whole toolkit -- a call to an unexposed tool then
 * reaches `ToolExecution` and is refused there by name, rather than failing
 * the turn as an undecodable response. Nothing when exposure restricts
 * nothing, so an eager agent's requests are unchanged.
 */
const choiceFor = (exposed: Option.Option<ReadonlySet<string>>): { readonly toolChoice?: { readonly oneOf: ReadonlyArray<any> } } =>
  Option.match(exposed, {
    onNone: () => ({}),
    onSome: (names) => ({ toolChoice: { oneOf: [...names] } })
  })

/**
 * `discover_tools`, handled for one turn: a search over the tools this caller
 * may see (`ToolExposure.eligible`), never a hidden one, returning each
 * match's parameters so it is callable next turn without another lookup. The
 * result is the selection; `ToolExposure.selectionFrom` reads it back out of
 * history. A pure function of the declarations, so a durable replay that runs
 * it again finds the same thing.
 */
const discoveryToolkit = (
  exposure: Extract<ToolExposure.ToolExposure, { readonly _tag: "Progressive" }>,
  registered: ReadonlyArray<Tool.Any>,
  principal: Option.Option<string>
): Effect.Effect<Toolkit.WithHandler<Record<string, Tool.Any>>> => {
  // Built over `Tool.Any`, as `outputToolkit` is, so the two protocol
  // toolkits share a type and merge; the handler's input is the tool's own
  // parameters, decoded by `Toolkit.handle` before it is called.
  const tool: Tool.Any = ToolExposure.DiscoverTools
  const built = Toolkit.make(tool)
  const pool = ToolExposure.eligible(exposure, registered, principal)
  const byName = new Map(pool.map((tool) => [tool.name, tool]))
  return built.pipe(
    Effect.provide(built.toLayer({
      discover_tools: ({ query }: { readonly query: string }) =>
        Effect.sync(() => {
          const found = Catalog.search({ tools: { tools: Object.fromEntries(byName) } }, query, {
            limit: exposure.maxResults
          })
          const tools = found.results.flatMap((entry) => {
            const tool = byName.get(entry.name)
            return tool === undefined
              ? []
              : [{
                name: tool.name,
                ...(tool.description === undefined ? {} : { description: tool.description }),
                parameters: Tool.getJsonSchema(tool)
              }]
          })
          return { tools, selected: tools.map((tool) => tool.name), more: found.next !== undefined }
        })
    } as Toolkit.HandlersFrom<Toolkit.ToolsByName<[Tool.Any]>>))
  )
}

/**
 * The toolkit a `Final` turn sees: nothing.
 *
 * `AgentLoop.Final` asks for one more turn in which the model can only answer,
 * so the agent's tools are withheld; an `AgentOutput`'s tool is merged back
 * in by `resolveToolkit` exactly as it is on any other turn, so the answer is
 * typed. Withholding is done here, by toolkit, rather than through a
 * provider's tool-choice option: it then means the same thing on every
 * provider, and under `/durable`'s replay, where the journalled model call is
 * re-expressed rather than re-issued.
 *
 * The erasing cast is the second in this file: an empty
 * toolkit is not a `WithHandler<Tools>`, and the type cannot say "the
 * agent's tools, minus all of them" -- `WithHandler` is invariant in its
 * tools. The value is exactly what the turn is documented to offer, and no
 * caller sees the type: the turn's result is still typed by the agent's
 * tools, of which a `Final` turn can have called none.
 */
const withheld = <Tools extends Record<string, Tool.Any>>(): Effect.Effect<
  Toolkit.WithHandler<Tools>
> =>
  Toolkit.empty.pipe(Effect.provide(Toolkit.empty.toLayer({}))) as unknown as Effect.Effect<
    Toolkit.WithHandler<Tools>
  >

/**
 * The output tool, handled, for one session.
 *
 * The handler is the whole mechanism: it stages the decoded value and returns
 * a confirmation.
 *
 * The tool is annotated `ToolExecution.Alone` (`AgentOutput.make`), so it is
 * only ever handled as the sole application call of its turn: a response
 * carrying two answers, or an answer beside an action, is rejected whole
 * before anything runs, and the model tries again. That is the generic rule
 * for a tool that decides what happens next, not an arity rule of this tool's
 * own -- and it is why this handler never has to choose between two answers.
 *
 * The parameters arrive decoded: `Toolkit.handle` decodes against the tool's
 * parameter schema before calling this, so a value that does not fit the shape
 * fails the call rather than reaching here. Under the default
 * `ToolExecution.ReturnToModel`, that failure is committed as a failed tool
 * result and the model gets to try again -- which is the right outcome for a
 * malformed answer, and one the injection gets for free by being a tool.
 */
const outputToolkit = <Tools extends Record<string, Tool.Any>>(
  session: Session<Tools>,
  output: AgentOutput.AgentOutput<any, any>
): Effect.Effect<Toolkit.WithHandler<Record<string, Tool.Any>>> => {
  const built = Toolkit.make(output.tool)
  const handlers = {
    [output.tool.name]: (value: unknown) =>
      Effect.as(
        Ref.set(session.pendingOutput, Option.some(value)),
        "Recorded."
      )
  }
  // An Effect rather than a `runSync`: binding handlers builds a layer, and
  // running a layer synchronously is a promise about its acquisition that
  // this module is in no position to make. The caller is already resolving a
  // toolkit effectfully, so there is nothing to gain by forcing it here.
  return built.pipe(
    Effect.provide(
      built.toLayer(handlers as Toolkit.HandlersFrom<Toolkit.ToolsByName<[Tool.Any]>>)
    )
  )
}

/**
 * The first successful result of a projecting tool, in response order, as
 * the output value (`AgentOutput.fromTool`).
 *
 * Only successes: a failed or refused call has no result to project. The
 * call's parameters arrive encoded (tool-call resolution is disabled), so
 * they are decoded with the projecting tool's own schema; the result part
 * holds the decoded success. A projector that throws, or returns a value the
 * output schema will not encode, is a defect in the projector -- the model
 * could not have done anything differently -- and dies naming the tool.
 */
const projectedOutput = (
  output: Option.Option<AgentOutput.AgentOutput<any, any>>,
  toolCalls: ReadonlyArray<{ readonly id: string; readonly name: string; readonly params: unknown }>,
  toolResults: ReadonlyArray<Response.AnyPart>
): Effect.Effect<Option.Option<{ readonly value: unknown; readonly toolName: string; readonly toolCallId: string }>> =>
  Effect.gen(function* () {
    if (Option.isNone(output) || output.value.projections.length === 0) return Option.none()
    const { projections, schema } = output.value
    for (const call of toolCalls) {
      const projection = projections.find((candidate) => candidate.tool.name === call.name)
      if (projection === undefined) continue
      const settled = toolResults.find((part) => part.type === "tool-result" && part.id === call.id)
      if (settled === undefined || settled.type !== "tool-result" || settled.isFailure) continue
      // `Tool.Any` exposes the schema as `Schema.Top`, erasing its decoding
      // services. A projecting tool's parameters decode without any, by the
      // same rule `AgentOutput` sets for its own schema: whether a turn has
      // an answer must not depend on a service being in reach at commit.
      const params = yield* (Schema.decodeUnknownEffect(projection.tool.parametersSchema)(call.params) as Effect.Effect<
        unknown,
        Schema.SchemaError
      >).pipe(Effect.orDie)
      // A projector that throws dies here, as the defect it is.
      const value = yield* Effect.sync(() => projection.project({ params, result: settled.result }))
      if (Option.isNone(value)) continue
      // Checked as a reported value is; one the schema rejects is the
      // projector's bug, and the schema's error says what is wrong.
      yield* Effect.orDie(Schema.encodeUnknownEffect(schema)(value.value))
      return Option.some({ value: value.value, toolName: call.name, toolCallId: call.id })
    }
    return Option.none()
  })

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
      Stream.withExecutionPlan(stream, withoutStepRetries(plan), {
        preventFallbackOnPartialStream: true,
        onEvent: Telemetry.recordAttempt
      })
  })

/**
 * The plan with each step's own retries removed.
 *
 * `preventFallbackOnPartialStream` guards the move to the *next* step, and
 * only that: a step's `attempts` or `schedule` retry the same provider
 * underneath the guard, so a stream that emitted a part and then failed was
 * re-subscribed into the same fold -- the abandoned attempt's text stayed,
 * a reused tool-call id merged fragments across attempts, and the viewer
 * saw one ordinary message. The second reviewer's reproduction on rc.112.
 * So on the streaming path a step gets one attempt: a failure before the
 * first part still falls through to the next step, and a failure after it
 * is final, which is the rule the guard was meant to state. The batch path
 * keeps its retries; nothing has been shown there.
 */
const withoutStepRetries = <P extends ExecutionPlan.ExecutionPlan<any>>(plan: P): P => ({
  ...plan,
  steps: plan.steps.map((step) => ({ ...step, attempts: 1, schedule: undefined }))
})

const streamResponse = <Tools extends Record<string, Tool.Any>>(
  session: Session<Tools, any, any>,
  correlation: Correlation,
  context: Prompt.Prompt,
  handler: Toolkit.WithHandler<Tools>,
  exposed: Option.Option<ReadonlySet<string>>
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
          disableToolCallResolution: true,
          ...choiceFor(exposed)
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
        // A file arrives whole, so it is announced whole; see the event.
        const announced = part.type === "file"
          ? EventBus.emit(session.bus, correlation, {
              _tag: "MessagePartCompleted",
              part: History.filePart(part)
            })
          : Effect.void
        // A fragment of a tool call's arguments is reported and nothing more;
        // the assembled call, and everything the harness does with it, comes
        // with the `tool-call` part that follows.
        const fragment = next.toolCallDelta === undefined
          ? Effect.void
          : EventBus.emit(session.bus, correlation, {
              _tag: "ToolCallDelta",
              id: next.toolCallDelta.id,
              ...(next.toolCallDelta.name === undefined ? {} : { name: next.toolCallDelta.name }),
              delta: next.toolCallDelta.delta
            })
        const output = next.delta === undefined
          ? Effect.void
          : EventBus.emit(session.bus, correlation, {
              _tag: "MessageDelta",
              kind: next.delta.kind,
              delta: next.delta.delta
            })
        // One part yields at most one of these today; emitting whichever are
        // present, in this order, does not depend on that staying true.
        return announced.pipe(Effect.andThen(fragment), Effect.andThen(output), Effect.as(next.state))
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
  turn: number,
  options: Options = {},
  /**
   * Engine-internal, not a `PromptOptions`: whether this is the one turn an
   * `AgentLoop.Final` decision asked for, on which the agent's tools are
   * withheld. `AgentRun` sets it; a caller never does.
   */
  kind: { readonly withholdTools: boolean } = { withholdTools: false }
) {
    // Correlation is passed down rather than read back from state: the caller
    // already knows it, and state is shared mutable data that may have moved on.
    const correlation: Correlation = { submissionId, runId, turn }
    yield* Telemetry.annotateTurn(session.id, runId, turn)

    // Cleared per turn: the ref stages *this* turn's value, and a leftover
    // from a turn that was rolled back must not be promoted by the next one.
    yield* Ref.set(session.pendingOutput, Option.none())

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
    // Exposure is read from canonical history -- the latest discovery's
    // selection -- and the caller's principal, so replay rebuilds it.
    const { exposed, handler } = yield* resolveToolkit(
      session,
      kind.withholdTools,
      canonicalPrompt,
      yield* CurrentPrincipal
    )

    yield* EventBus.emit(session.bus, correlation, { _tag: "TurnStarted" })

    const response = options.stream === true
      ? yield* streamResponse(session, correlation, context, handler, exposed)
      : yield* withPlan(
          session,
          LanguageModel.generateText({
            prompt: context,
            toolkit: handler,
            // The harness owns tool execution so that it can emit the lifecycle
            // events, choose the concurrency, and commit results itself.
            disableToolCallResolution: true,
            ...choiceFor(exposed)
          })
        )

    const inputTokens = response.usage.inputTokens.total ?? 0
    const outputTokens = response.usage.outputTokens.total ?? 0
    const reportedTotal = Reflect.get(response.usage, "totalTokens")
    const totalTokens = typeof reportedTotal === "number" && Number.isSafeInteger(reportedTotal) && reportedTotal >= 0 ? reportedTotal : inputTokens + outputTokens
    yield* EventBus.emit(session.bus, correlation, {
      _tag: "ModelCallCompleted",
      usage: {
        inputTokens,
        outputTokens,
        totalTokens
      },
      finishReason: response.finishReason
    })
    yield* turnFailpoints.hit("after-model-response")

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
          nextElicitationId: session.ids.nextElicitation,
          toolProgressBytes: session.toolProgressBytes,
          toolProgressLimit: session.toolProgressLimit
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
        messages: [...context.content, ...History.fromResponseParts(response.content).content],
        exposed
      })
    }

    // An answer an ordinary tool's result already is (`AgentOutput.fromTool`),
    // computed from this turn's successes and promoted with the commit below
    // -- so it too exists exactly when the turn that produced it does.
    const projected = yield* projectedOutput(session.agent.output, toolCalls, toolResults)

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
    const content = History.assistantContent(response.content)
    // Read inside the same uninterruptible region as the commit, so a value
    // is promoted exactly when the turn that produced it becomes canonical.
    let value: Option.Option<unknown> = Option.none()
    let answeredBy: Option.Option<AgentEvent.AnsweredBy> = Option.none()
    yield* turnFailpoints.hit("before-commit")
    yield* Effect.uninterruptible(
      Effect.gen(function*() {
        yield* History.commit(session.history, committed)
        // A value the model reported wins; it cannot share a turn with a
        // projecting tool anyway, the output tool being `Alone`.
        const reported = yield* Ref.get(session.pendingOutput)
        if (Option.isSome(reported)) {
          value = reported
          // The output tool is `Alone`, so its call is the turn's only one.
          const call = toolCalls.find((c) => Option.exists(session.agent.output, (o) => o.toolName === c.name))
          answeredBy = Option.map(Option.fromUndefinedOr(call), (c) => ({ _tag: "OutputTool" as const, toolCallId: c.id }))
        } else if (Option.isSome(projected)) {
          value = Option.some(projected.value.value)
          answeredBy = Option.some({
            _tag: "Projected" as const,
            toolName: projected.value.toolName,
            toolCallId: projected.value.toolCallId
          })
        }

        // A message is worth announcing when it says something or carries a
        // file. Reasoning alone is not one: it is the model's working, and a
        // turn that produced only that and a tool call was never reported as
        // a message before.
        if (text.length > 0 || content.some((part) => part.type === "file")) {
          yield* EventBus.emit(session.bus, correlation, {
            _tag: "MessageCompleted",
            text,
            content
          })
        }

        yield* EventBus.emit(session.bus, correlation, { _tag: "TurnCompleted" })
      })
    )
    yield* turnFailpoints.hit("after-commit")

    return { response, toolCalls, text, value, answeredBy }
  })
