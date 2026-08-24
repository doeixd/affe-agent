import { Cause, Effect, Exit, Option, Schema, Stream } from "effect"
import { Response } from "effect/unstable/ai"
import type { Prompt, Tool, Toolkit } from "effect/unstable/ai"
import * as AgentEvent from "./AgentEvent.js"
import type { Correlation } from "./AgentEvent.js"
import type { SubmissionId } from "./internal/ids.js"
import { ToolApprovalRequiredError, ToolPermissionDeniedError } from "./Errors.js"
import type * as Elicitation from "./Elicitation.js"
import * as Permission from "./Permission.js"
import * as EventBus from "./internal/eventBus.js"
import * as Telemetry from "./internal/telemetry.js"

/**
 * The errors `ToolExecution` raises *itself*, rather than surfacing from a tool
 * handler: the harness declined a call before running it. Because no tool
 * produces these, they do not appear in `Tool.HandlerError`, so any caller whose
 * error union must be complete (notably `AgentSession.PromptError`) references
 * this alias instead of re-listing the members — add a new harness-raised error
 * here and `execute`'s signature and the session's error flow with it.
 */
export type RaisedError = ToolApprovalRequiredError | ToolPermissionDeniedError

/**
 * How concurrently the tool calls of a single model response are executed.
 *
 * This controls scheduling only. Retries, timeouts and tracing belong on the
 * tool handlers themselves, which are ordinary Effects.
 */
export type Strategy =
  | { readonly _tag: "Sequential" }
  | { readonly _tag: "Parallel" }
  | { readonly _tag: "Concurrency"; readonly limit: number }

export const Sequential: Strategy = { _tag: "Sequential" }
export const Parallel: Strategy = { _tag: "Parallel" }
export const concurrency = (limit: number): Strategy => ({
  _tag: "Concurrency",
  limit
})

/**
 * What happens when a tool handler fails in its error channel.
 *
 * Resolved by the Phase 11 spike. Both policies are implemented and tested;
 * neither is hidden behind an arbitrary default:
 *
 * * `ReturnToModel` commits a failed `ToolResultPart` so the model can react,
 *   which is what an agent that should recover from a bad argument needs.
 * * `FailRun` propagates, which is what a pipeline that must not continue on
 *   bad state needs.
 *
 * Defects are never covered by this choice — see `execute`.
 */
export type FailurePolicy =
  | { readonly _tag: "ReturnToModel" }
  | { readonly _tag: "FailRun" }

export const ReturnToModel: FailurePolicy = { _tag: "ReturnToModel" }
export const FailRun: FailurePolicy = { _tag: "FailRun" }

const concurrencyOption = (strategy: Strategy) =>
  strategy._tag === "Sequential"
    ? { concurrency: 1 as const }
    : strategy._tag === "Parallel"
      ? { concurrency: "unbounded" as const }
      : { concurrency: strategy.limit }

const failureResultPart = (
  call: { readonly id: string; readonly name: string },
  error: unknown
): Response.AnyPart =>
  Response.toolResultPart({
    id: call.id,
    name: call.name,
    result: error,
    // The tool's own failure schema is not available here, so the error is
    // rendered for the model rather than encoded through it.
    encodedResult: renderError(error),
    isFailure: true,
    providerExecuted: false,
    preliminary: false
  }) as Response.AnyPart

const renderError = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : JSON.stringify(error)

/**
 * The session pieces a turn's tool calls need. Constant for the life of a
 * session; the turn adds only its `correlation` and `messages`.
 */
export interface SessionContext {
  readonly id: string
  readonly bus: EventBus.EventBus
  /** Where an `Ask` is asked. See `Elicitation`. */
  readonly elicitation: Elicitation.Elicitor
  /** Allocates the id an elicitation is answered by, namespaced by submission. */
  readonly nextElicitationId: (submissionId: SubmissionId) => Effect.Effect<string>
}

/** The agent policies a turn's tool calls read. Constant for the life of a session. */
export interface AgentContext<R = never> {
  readonly strategy: Strategy
  readonly failurePolicy: FailurePolicy
  /**
   * What happens to a call the policy denied, or whose approval was refused.
   *
   * `FailRun` (the default): the run fails with `ToolPermissionDeniedError`
   * or `ToolApprovalRequiredError` -- the harness declined, and nothing is
   * said to the model. `ReturnToModel`: the refusal is committed as a failed
   * tool result so the model can take another route. The call never runs
   * under either; the choice is only who is told.
   */
  readonly denialPolicy: FailurePolicy
  /** Whether the agent may attempt each call. See `Permission`. */
  readonly permission: Permission.Policy<R>
}

/**
 * Everything one turn's tool execution needs, in one grouped value.
 *
 * The session and the agent parts are constant for the session; `correlation`
 * and `messages` are the turn's. Grouping them -- rather than a flat bag the
 * caller reassembles -- means the assembly lives in one place, and anything
 * that must run a tool call with the harness's semantics (a turn, a future
 * submission handle, a policy dry-run) takes this one value.
 */
export interface TurnContext<R = never> {
  readonly session: SessionContext
  readonly agent: AgentContext<R>
  readonly correlation: Correlation
  /** The conversation the model saw, for `needsApproval` and the policy. */
  readonly messages: ReadonlyArray<Prompt.Message>
}

/**
 * The tool's own requirement, evaluated.
 *
 * Effect AI's `needsApproval` is a boolean or a function of the parameters
 * and the conversation. The harness used to treat any function as `true`;
 * that was safe and wrong, and a tool that asks only for production deploys
 * was asked about every deploy.
 */
export const intrinsicApproval = (
  tool: Tool.Any,
  params: unknown,
  context: Tool.NeedsApprovalContext
): Effect.Effect<boolean> => {
  const requirement = tool.needsApproval
  if (requirement === undefined || typeof requirement === "boolean") {
    return Effect.succeed(requirement === true)
  }
  return Effect.suspend(() => {
    const answer = requirement(params, context)
    return typeof answer === "boolean" ? Effect.succeed(answer) : answer
  })
}

const approvalDetailJson = Schema.toCodecJson(Permission.ApprovalDetail)
const approvalValueJson = Schema.toCodecJson(Permission.ApprovalValue)

/**
 * Recover the concrete parameter schema hidden by Effect AI's `Tool.Any`
 * surface. Spelling the return through Tool's utility types keeps the exact
 * decoding requirement available to callers of `decide`.
 */
const decodePermissionParameters = <T extends Tool.Any>(
  tool: T,
  params: unknown
): Effect.Effect<
  Tool.Parameters<T>,
  Schema.SchemaError,
  Tool.ParametersSchema<T>["DecodingServices"]
> =>
  // `Tool.Any.parametersSchema` is exposed as `Schema.Top`, losing the
  // relationship which Tool's own utility types still know. The assertion
  // restores that relationship without changing the runtime value.
  Schema.decodeUnknownEffect(tool.parametersSchema)(params) as Effect.Effect<
    Tool.Parameters<T>,
    Schema.SchemaError,
    Tool.ParametersSchema<T>["DecodingServices"]
  >

/**
 * Decide one call: the tool's floor, the tool's projection, the policy.
 *
 * Returned as the decision *and* the request it was made for, because an
 * `Ask` carries the action and resource to whoever answers and a remembered
 * grant is keyed by them.
 */
export const decide = Effect.fn("ToolExecution.decide")(function* <
  T extends Tool.Any,
  R
>(
  tool: T,
  call: { readonly id: string; readonly name: string; readonly params: unknown },
  options: {
    readonly sessionId: string
    readonly messages: ReadonlyArray<Prompt.Message>
    readonly permission: Permission.Policy<R>
  }
) {
  const decoded = yield* decodePermissionParameters(tool, call.params).pipe(
    Effect.option
  )

  // Toolkit.handle owns the ordinary validation failure and its model-facing
  // error. Permission must not inspect or authorize a value that did not pass
  // the tool's parameter schema, so signal the caller to continue directly to
  // that existing validation path.
  if (Option.isNone(decoded)) {
    return { _tag: "InvalidParameters" as const }
  }

  const intrinsic = yield* intrinsicApproval(tool, decoded.value, {
    toolCallId: call.id,
    messages: options.messages
  })
  const projection = Permission.projectionOf(tool)
  // A projection that throws is the tool author's bug: die, rather than
  // evaluate a policy against a resource nobody computed.
  const resource = yield* Effect.sync(() => {
    try {
      return projection.resource(decoded.value)
    } catch (cause) {
      throw new Error(`permission projection for tool ${call.name} threw`, { cause })
    }
  })
  if (typeof resource !== "string") {
    return yield* Effect.die(
      new Error(`permission projection for tool ${call.name} returned a non-string resource`)
    )
  }
  const request: Permission.Request = {
    sessionId: options.sessionId,
    toolCallId: call.id,
    tool: { name: call.name, params: call.params },
    action: projection.action,
    resource,
    intrinsicApproval: intrinsic,
    messages: options.messages
  }
  const policy = yield* options.permission.evaluate(request)
  // The floor: the tool's own requirement is at least an `Ask`, whatever
  // the policy said. Nothing here can lower it.
  const decision = Permission.combine(intrinsic ? Permission.ask() : Permission.allow, policy)
  return { _tag: "Decided" as const, decision, request }
})

const executeOne = Effect.fn("ToolExecution.tool")(function* <
  Tools extends Record<string, Tool.Any>,
  R
>(
  handler: Toolkit.WithHandler<Tools>,
  call: Response.ToolCallParts<Tools, true>,
  context: TurnContext<R>
) {
    const { agent, correlation, messages, session } = context
    yield* Telemetry.annotateTool(session.id, call.name, call.id)
    yield* EventBus.emit(session.bus, correlation, {
      _tag: "ToolCallStarted",
      id: call.id,
      name: call.name,
      params: call.params
    })

    // Permission first, and only then the handler. `decide` folds the tool's
    // own `needsApproval` and the application's policy into one of three
    // answers. The tool not being in the toolkit is a bug upstream: the
    // harness only dispatches calls it matched.
    const tool = handler.tools[call.name as keyof Tools]
    if (tool === undefined) {
      return yield* Effect.die(new Error(`Tool ${String(call.name)} is not in the toolkit`))
    }
    const decisionEffect = decide(tool, call, {
      sessionId: session.id,
      messages,
      permission: agent.permission
    })
    // Parameter decoding services are one constituent of HandlerServices, but
    // TypeScript cannot reduce that conditional type after the indexed tool
    // lookup. Widen only the requirement channel to the public handler union.
    const outcome = yield* decisionEffect as Effect.Effect<
      Effect.Success<typeof decisionEffect>,
      Effect.Error<typeof decisionEffect>,
      R | Tool.HandlerServices<Tools[keyof Tools]>
    >

    // A refusal, from the policy or from the person asked. The call never
    // runs; `denialPolicy` decides whether the model hears about it.
    const refuse = (error: ToolApprovalRequiredError | ToolPermissionDeniedError) =>
      Effect.gen(function* () {
        const returnedToModel = agent.denialPolicy._tag === "ReturnToModel"
        yield* EventBus.emit(session.bus, correlation, {
          _tag: "ToolCallFailed",
          id: call.id,
          name: call.name,
          failure: AgentEvent.failureFromCause(Cause.fail(error)),
          returnedToModel
        })
        return returnedToModel ? failureResultPart(call, error) : yield* error
      })

    if (outcome._tag === "Decided" && outcome.decision._tag === "Deny") {
      return yield* refuse(
        new ToolPermissionDeniedError({
          toolName: String(call.name),
          toolCallId: call.id,
          action: outcome.request.action,
          resource: outcome.request.resource,
          ...(outcome.decision.reason === undefined
            ? {}
            : { reason: outcome.decision.reason })
        })
      )
    }

    if (outcome._tag === "Decided" && outcome.decision._tag === "Ask") {
      // Asked, not refused: the run *pauses* until an answer arrives. The
      // default elicitor answers "no", so an agent with no way to ask still
      // fails closed.
      // A tool call only ever runs inside a submission, so the correlation
      // carries one; a call without it is a harness bug, not a case.
      const submissionId = correlation.submissionId
      if (submissionId === undefined) {
        return yield* Effect.die(new Error("tool call outside a submission"))
      }
      const id = yield* session.nextElicitationId(submissionId)
      const detail: Permission.ApprovalDetail = {
        toolName: String(call.name),
        toolCallId: call.id,
        action: outcome.request.action,
        resource: outcome.request.resource,
        ...(outcome.decision.reason === undefined
          ? {}
          : { reason: outcome.decision.reason })
      }
      const elicitationRequest = {
        id,
        kind: "tool-approval",
        detail: Schema.encodeSync(approvalDetailJson)(detail)
      }
      const answer = yield* session.elicitation.elicit(
        elicitationRequest,
        EventBus.emit(session.bus, correlation, {
          _tag: "ElicitationRequested",
          id,
          kind: elicitationRequest.kind,
          detail: elicitationRequest.detail
        })
      )
      yield* EventBus.emit(session.bus, correlation, {
        _tag: "ElicitationResolved",
        id,
        kind: elicitationRequest.kind,
        granted: answer.granted
      })

      if (!answer.granted) {
        return yield* refuse(
          new ToolApprovalRequiredError({
            toolName: String(call.name),
            toolCallId: call.id
          })
        )
      }
      // "Allow always" is two things: this answer, and a grant the policy
      // keeps. The answer is in hand; the grant is the policy's, if it keeps
      // any. A malformed value is an answer for this call only.
      const remember = Schema.decodeUnknownOption(approvalValueJson)(answer.value)
      if (
        Option.isSome(remember) &&
        remember.value.remember &&
        agent.permission.remember !== undefined
      ) {
        yield* agent.permission.remember(outcome.request)
      }
    }

    // A handler returns a stream so it can emit preliminary results before its
    // final one. Only the final result is committed.
    //
    // Folded rather than collected. `Stream.runCollect` buffers everything and
    // yields nothing until the handler finishes, which makes a long-running
    // tool invisible for exactly as long as it is interesting.
    //
    // Progress is emitted the moment a preliminary result arrives, not when
    // the next one displaces it. Deferring by one item looks equivalent and is
    // not: a handler that reports progress and then waits — for a build, a
    // remote call, an approval — would have that last report withheld until it
    // finished, which is precisely when it stops being useful.
    //
    // `preliminary` is Effect AI's own signal for this, set by
    // `context.preliminary`. The final result is the last non-preliminary one;
    // if a handler emits nothing but preliminary results, the last of them is
    // still committed rather than the call being treated as producing nothing.
    const exit = yield* Effect.exit(
      handler
        .handle(call.name, call.params, call.id)
        .pipe(
          Effect.flatMap((stream) =>
            Stream.runFoldEffect(
              stream,
              () => emptyCollected<Tools>(),
              (collected, next) =>
                next.preliminary
                  ? EventBus.emit(session.bus, correlation, {
                      _tag: "ToolCallProgress",
                      id: call.id,
                      name: call.name,
                      result: next.result,
                      encodedResult: next.encodedResult
                    }).pipe(
                      Effect.as({ ...collected, last: Option.some(next) })
                    )
                  : Effect.succeed({
                      final: Option.some(next),
                      last: Option.some(next)
                    })
            ).pipe(
              Effect.map((collected) =>
                Option.orElse(collected.final, () => collected.last)
              )
            )
          ),
          // A finalizer, not an uninterruptible block: once the fiber is
          // interrupted the generator below never resumes, so the terminal
          // event has to be emitted from the interruption path itself.
          Effect.onInterrupt(() =>
            EventBus.emit(session.bus, correlation, {
              _tag: "ToolCallInterrupted",
              id: call.id,
              name: call.name
            })
          )
        ) as Effect.Effect<
        Option.Option<Tool.HandlerResult<Tools[keyof Tools]>>,
        Tool.HandlerError<Tools[keyof Tools]>,
        Tool.HandlerServices<Tools[keyof Tools]>
      >
    )

    if (Exit.isFailure(exit)) {
      // Interruption already emitted its terminal event from the finalizer
      // above, because this continuation may never run.
      if (Cause.hasInterruptsOnly(exit.cause)) {
        return yield* Effect.failCause(exit.cause)
      }

      const failure = Cause.findErrorOption(exit.cause)
      const isDefect = Option.isNone(failure)


      // Defects always fail the run. A defect means the handler is broken, not
      // that the model asked for something the tool could refuse.
      const returnedToModel =
        !isDefect && agent.failurePolicy._tag === "ReturnToModel"

      yield* EventBus.emit(session.bus, correlation, {
        _tag: "ToolCallFailed",
        id: call.id,
        name: call.name,
        failure: AgentEvent.failureFromCause(exit.cause),
        returnedToModel
      })

      if (!returnedToModel) {
        return yield* Effect.failCause(exit.cause)
      }

      return failureResultPart(call, failure.value)
    }

    const result = Option.getOrUndefined(exit.value)
    if (result === undefined) {
      return yield* Effect.die(
        new Error(`Tool ${call.name} produced no result`)
      )
    }

    // A handler may also report failure as a value rather than an error. That
    // is already the model's problem, so it is committed either way.
    yield* EventBus.emit(
      session.bus,
      correlation,
      result.isFailure
        ? {
            _tag: "ToolCallFailed",
            id: call.id,
            name: call.name,
            failure: AgentEvent.failureFromCause(Cause.fail(result.result)),
            returnedToModel: true
          }
        : {
            _tag: "ToolCallSucceeded",
            id: call.id,
            name: call.name,
            result: result.result,
            encodedResult: result.encodedResult
          }
    )

    return Response.toolResultPart({
      id: call.id,
      name: call.name,
      result: result.result,
      encodedResult: result.encodedResult,
      isFailure: result.isFailure,
      providerExecuted: false,
      preliminary: false
    }) as Response.AnyPart
  })

/** What a handler's stream folds into: its final result, and its last. */
interface Collected<Tools extends Record<string, Tool.Any>> {
  readonly final: Option.Option<Tool.HandlerResult<Tools[keyof Tools]>>
  readonly last: Option.Option<Tool.HandlerResult<Tools[keyof Tools]>>
}

const emptyCollected = <
  Tools extends Record<string, Tool.Any>
>(): Collected<Tools> => ({ final: Option.none(), last: Option.none() })

/**
 * Execute every tool call of one model response.
 *
 * Under `FailRun` the first failure interrupts its siblings, which is ordinary
 * `Effect.all` semantics. Under `ReturnToModel` a typed failure is not an error
 * at all, so siblings always run to completion.
 */
export const execute = <Tools extends Record<string, Tool.Any>, R = never>(
  handler: Toolkit.WithHandler<Tools>,
  calls: ReadonlyArray<Response.ToolCallParts<Tools, true>>,
  context: TurnContext<R>
): Effect.Effect<
  ReadonlyArray<Response.AnyPart>,
  Tool.HandlerError<Tools[keyof Tools]> | RaisedError,
  Tool.HandlerServices<Tools[keyof Tools]> | R
> =>
  Effect.all(
    calls.map((call) => executeOne(handler, call, context)),
    concurrencyOption(context.agent.strategy)
  )
