import { Cause, Effect, Exit, Option, Schema, Semaphore, Stream } from "effect"
import { Response } from "effect/unstable/ai"
import type { Prompt, Tool, Toolkit } from "effect/unstable/ai"
import * as AgentEvent from "./AgentEvent.js"
import type { Correlation } from "./AgentEvent.js"
import type { SubmissionId } from "./internal/ids.js"
import { ToolApprovalRequiredError, ToolPermissionDeniedError } from "./Errors.js"
import * as Elicitation from "./Elicitation.js"
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
  | {
      readonly _tag: "PerTool"
      readonly limits: Readonly<Record<string, number | "unbounded">>
      readonly defaultLimit: number | "unbounded"
      /** The ceiling across all names. See `PerToolOptions.total`. */
      readonly total: number | "unbounded"
    }

export const Sequential: Strategy = { _tag: "Sequential" }
export const Parallel: Strategy = { _tag: "Parallel" }
export const concurrency = (limit: number): Strategy => ({
  _tag: "Concurrency",
  limit
})

export interface PerToolOptions {
  /**
   * Limits by exact tool name. Unlisted tools use `defaultLimit`.
   *
   * **Scoped to one model response.** See `perTool` for what that does and
   * does not promise.
   */
  readonly limits: Readonly<Record<string, number | "unbounded">>
  /** Default for an unlisted tool. Default: unbounded. */
  readonly defaultLimit?: number | "unbounded" | undefined
  /**
   * A ceiling across *all* names, within the same one response. Default:
   * unbounded.
   *
   * Without it the per-name limits multiply: `defaultLimit: 4` with ten
   * distinct tools in one response permits forty concurrent handlers, which is
   * rarely what someone writing a limit meant. `total: 8` with
   * `defaultLimit: 4` reads as "at most eight tools running, at most four of
   * any one name".
   */
  readonly total?: number | "unbounded" | undefined
}

const validLimit = (limit: number | "unbounded"): boolean =>
  limit === "unbounded" ||
  (Number.isSafeInteger(limit) && limit > 0)

/**
 * Limit calls independently by tool name, **within one model response**.
 *
 * ```ts
 * ToolExecution.perTool({
 *   limits: { read_file: 10, http_get: 2 },
 *   defaultLimit: 4,
 *   total: 8
 * })
 * ```
 *
 * ## What a limit is scoped to
 *
 * `execute` runs once per model response, so every number here bounds calls
 * *within* that response and nothing beyond it. Across turns, and across
 * concurrent sessions sharing one `Agent`, there is no coordination: a limit of
 * `1` means "not twice in the same response", not "never twice at once".
 *
 * That is why the example above is not `shell: 1`. Someone who writes that
 * wants a real guarantee -- one child process, no contention on a working
 * directory -- and this cannot give it. A process-wide guarantee belongs in the
 * handler, around the work itself: a `Semaphore` closed over by the tool, which
 * holds for every turn and every session that shares it. `PartitionedSemaphore`
 * was rejected for the keyed version of this because its keys share one global
 * permit count.
 *
 * `total` bounds the whole response across names; without it the per-name
 * limits multiply, since distinct names run concurrently with each other.
 *
 * Construction rejects zero, negative, fractional and non-finite limits so a
 * typo cannot turn a tool group into work that waits forever.
 */
export const perTool = (options: PerToolOptions): Strategy => {
  const defaultLimit = options.defaultLimit ?? "unbounded"
  if (!validLimit(defaultLimit)) {
    throw new RangeError("ToolExecution.perTool: defaultLimit must be a positive integer or unbounded")
  }
  const total = options.total ?? "unbounded"
  if (!validLimit(total)) {
    throw new RangeError("ToolExecution.perTool: total must be a positive integer or unbounded")
  }
  for (const [name, limit] of Object.entries(options.limits)) {
    if (!validLimit(limit)) {
      throw new RangeError(
        `ToolExecution.perTool: limit for ${JSON.stringify(name)} must be a positive integer or unbounded`
      )
    }
  }
  const limits: Record<string, number | "unbounded"> = Object.create(null)
  Object.assign(limits, options.limits)
  return {
    _tag: "PerTool",
    // Null-prototype, so a *lookup* is safe rather than each reader having to
    // remember to make it so. Tool names are not always written by the
    // application -- `bindDiscovered` takes whatever an MCP server, an OpenAPI
    // `operationId` or a GraphQL root field offers -- and on a plain object
    // literal a tool named `constructor` or `toString` resolves a function from
    // `Object.prototype`, which `?? defaultLimit` does not rescue because a
    // function is not nullish. That value then reaches `Effect.all` as its
    // concurrency.
    limits: Object.freeze(limits),
    defaultLimit,
    total
  }
}

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
      : strategy._tag === "Concurrency"
        ? { concurrency: strategy.limit }
        : { concurrency: "unbounded" as const }

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

/**
 * The failure, as a string the model can read. Never a throw.
 *
 * This runs *after* `ToolCallFailed` has announced `returnedToModel: true`, so
 * a throw here does not merely lose the rendering -- it defects the run that
 * has already promised the model would get a chance to recover, and leaves
 * history and events disagreeing about whether the failure was returned.
 *
 * `JSON.stringify` is not a total function, and the values it refuses are not
 * exotic: it throws outright on a `bigint` and on a cycle, and returns
 * `undefined` -- not a string -- for `undefined`, a symbol or a function. A
 * tool's declared failure schema can produce any of them.
 *
 * The result is also bounded. A failure is a *message to a model*, and a
 * megabyte of it is both useless and expensive; the tool's real value is
 * still carried unrendered in `result` for any caller that wants it.
 */
const MAX_RENDERED_FAILURE = 4096

const renderError = (error: unknown): string => {
  if (typeof error === "string") return bounded(error)
  if (error instanceof Error) {
    try {
      if (typeof error.message === "string" && error.message.length > 0) {
        return bounded(error.message)
      }
    } catch {
      // A subclass computing `message` from something broken.
    }
  }
  try {
    const rendered = JSON.stringify(error)
    // `undefined` for a symbol, a function, or `undefined` itself -- and the
    // part's `encodedResult` must be a string.
    if (typeof rendered === "string") return bounded(rendered)
  } catch {
    // A cycle, a bigint, or a throwing `toJSON`.
  }
  try {
    return bounded(String(error))
  } catch {
    return "the tool failed, and its failure could not be rendered"
  }
}

const bounded = (text: string): string =>
  text.length <= MAX_RENDERED_FAILURE
    ? text
    : `${text.slice(0, MAX_RENDERED_FAILURE)}… (truncated)`

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
  /**
   * What a person will be shown, when it is narrower than the scope.
   *
   * Computed under the same rules as `resource`: a `describe` that throws is
   * the tool author's bug. Omitted when it would repeat the resource, so a
   * renderer can treat its presence as "there is more to say here".
   */
  const described = projection.describe === undefined
    ? undefined
    : yield* Effect.sync(() => {
      try {
        const value = projection.describe!(decoded.value)
        return typeof value === "string" ? value : undefined
      } catch (cause) {
        throw new Error(`permission description for tool ${call.name} threw`, { cause })
      }
    })
  const request: Permission.Request = {
    sessionId: options.sessionId,
    toolCallId: call.id,
    tool: { name: call.name, params: call.params },
    action: projection.action,
    resource,
    ...(described === undefined || described === resource ? {} : { subject: described }),
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

    /**
     * `ToolCallStarted` owes a terminal event, whatever happens next.
     *
     * Interruption is announced from a finalizer rather than from the code
     * below, because once the fiber is interrupted the generator never
     * resumes. The finalizer used to be installed around the *handler* only,
     * so a submission interrupted while decoding parameters, evaluating the
     * policy, or -- most likely of all -- waiting for a person to answer an
     * approval left `ToolCallStarted` with nothing after it: observability
     * bookkeeping never closed, and every projection free to show the call as
     * running for the rest of the session.
     *
     * Each awaiting step below carries it. They are mutually exclusive -- a
     * fiber is interrupted in exactly one of them -- so the event is emitted
     * once.
     */
    const announceInterrupted = EventBus.emit(session.bus, correlation, {
      _tag: "ToolCallInterrupted",
      id: call.id,
      name: call.name
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
    const outcome = yield* (decisionEffect as Effect.Effect<
      Effect.Success<typeof decisionEffect>,
      Effect.Error<typeof decisionEffect>,
      R | Tool.HandlerServices<Tools[keyof Tools]>
    >).pipe(Effect.onInterrupt(() => announceInterrupted))

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
        ...(outcome.request.subject === undefined
          ? {}
          : { subject: outcome.request.subject }),
        ...(outcome.decision.reason === undefined
          ? {}
          : { reason: outcome.decision.reason })
      }
      const elicitationRequest = {
        id,
        kind: "tool-approval",
        detail: Schema.encodeSync(approvalDetailJson)(detail)
      }
      // The longest wait in the whole call, and the one most likely to be
      // interrupted: a person is being asked a question.
      const answer = yield* session.elicitation.elicit(
        elicitationRequest,
        EventBus.emit(session.bus, correlation, {
          _tag: "ElicitationRequested",
          id,
          kind: elicitationRequest.kind,
          detail: elicitationRequest.detail
        })
      ).pipe(Effect.onInterrupt(() => announceInterrupted))
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
    // What a delegation forwards a child's approval through. Announced here
    // as well as by the asker: the child announces on its own bus, and the
    // parent's consumers -- the ones who can answer -- watch this one.
    const forwardable: Elicitation.Elicitor = {
      elicit: (request, announce) =>
        session.elicitation
          .elicit(
            request,
            announce.pipe(
              Effect.andThen(
                EventBus.emit(session.bus, correlation, {
                  _tag: "ElicitationRequested",
                  id: request.id,
                  kind: request.kind,
                  detail: request.detail
                })
              )
            )
          )
          .pipe(
            Effect.tap((answer) =>
              EventBus.emit(session.bus, correlation, {
                _tag: "ElicitationResolved",
                id: request.id,
                kind: request.kind,
                granted: answer.granted
              })
            )
          ),
      respond: (response) => session.elicitation.respond(response),
      pending: session.elicitation.pending
    }

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
          // Around the fold as well as the handle: a streaming handler's body
          // runs when its stream is consumed, which is here, not above.
          Effect.provideService(Elicitation.Current, Option.some(forwardable)),
          // A finalizer, not an uninterruptible block: once the fiber is
          // interrupted the generator below never resumes, so the terminal
          // event has to be emitted from the interruption path itself.
          Effect.onInterrupt(() => announceInterrupted)
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

const executePerTool = <
  Tools extends Record<string, Tool.Any>,
  R
>(
  handler: Toolkit.WithHandler<Tools>,
  calls: ReadonlyArray<Response.ToolCallParts<Tools, true>>,
  context: TurnContext<R>,
  strategy: Extract<Strategy, { readonly _tag: "PerTool" }>
): Effect.Effect<
  ReadonlyArray<Response.AnyPart>,
  Tool.HandlerError<Tools[keyof Tools]> | RaisedError,
  Tool.HandlerServices<Tools[keyof Tools]> | R
> =>
  Effect.gen(function* () {
    // A semaphore, not the outer `Effect.all`'s concurrency: that would bound
    // the number of *groups* in flight, and a group is many calls, so `total`
    // would still multiply by the per-name limits. A permit per call is what
    // "at most N tool calls running" actually means.
    const ceiling = strategy.total === "unbounded"
      ? undefined
      : yield* Semaphore.make(strategy.total)

    const groups = new Map<
      string,
      Array<{
        readonly index: number
        readonly call: Response.ToolCallParts<Tools, true>
      }>
    >()
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index]!
      const group = groups.get(call.name)
      const indexed = { index, call }
      if (group === undefined) groups.set(call.name, [indexed])
      else group.push(indexed)
    }

    return yield* Effect.map(
      Effect.all(
        Array.from(groups, ([name, group]) =>
          Effect.all(
            group.map(({ call, index }) => {
              const one = Effect.map(
                executeOne(handler, call, context),
                (part) => ({ index, part })
              )
              return ceiling === undefined
                ? one
                : Semaphore.withPermits(ceiling, 1)(one)
            }),
            {
              // `Object.hasOwn` rather than `?? defaultLimit`, because
              // `Strategy` is a public union anyone can build by hand -- only
              // the value `perTool` returns has the null prototype that makes
              // a plain lookup safe.
              concurrency: Object.hasOwn(strategy.limits, name)
                ? strategy.limits[name]!
                : strategy.defaultLimit
            }
          )
        ),
        { concurrency: "unbounded" }
      ),
      (completed) =>
        completed
          .flat()
          .sort((left, right) => left.index - right.index)
          .map(({ part }) => part)
    )
  })

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
  context.agent.strategy._tag === "PerTool"
    ? executePerTool(handler, calls, context, context.agent.strategy)
    : Effect.all(
        calls.map((call) => executeOne(handler, call, context)),
        concurrencyOption(context.agent.strategy)
      )
