import { Cause, Effect, Exit, Option, Stream } from "effect"
import { Response } from "effect/unstable/ai"
import type { Tool, Toolkit } from "effect/unstable/ai"
import * as AgentEvent from "./AgentEvent.js"
import type { Correlation } from "./AgentEvent.js"
import { ToolApprovalRequiredError } from "./Errors.js"
import * as EventBus from "./internal/eventBus.js"

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

export interface Options {
  readonly bus: EventBus.EventBus
  readonly correlation: Correlation
  readonly strategy: Strategy
  readonly failurePolicy: FailurePolicy
}

const executeOne = Effect.fn("ToolExecution.tool")(function* <
  Tools extends Record<string, Tool.Any>
>(
  handler: Toolkit.WithHandler<Tools>,
  call: Response.ToolCallParts<Tools, true>,
  options: Options
) {
    yield* Effect.annotateCurrentSpan({
      tool: call.name,
      toolCallId: call.id
    })
    yield* EventBus.emit(options.bus, options.correlation, {
      _tag: "ToolCallStarted",
      id: call.id,
      name: call.name,
      params: call.params
    })

    // Effect AI's own resolver honours `needsApproval`; because the harness
    // resolves tools itself, it has to honour it too. A dynamic requirement is
    // treated as requiring approval — deciding otherwise would mean evaluating
    // it and then acting on the answer, which is the feature that does not
    // exist yet.
    //
    // This is never returned to the model: it is the harness refusing, not a
    // tool outcome the model could correct by trying again.
    const tool = handler.tools[call.name as keyof Tools]
    if (tool?.needsApproval !== undefined && tool.needsApproval !== false) {
      const error = new ToolApprovalRequiredError({
        toolName: String(call.name),
        toolCallId: call.id
      })
      yield* EventBus.emit(options.bus, options.correlation, {
        _tag: "ToolCallFailed",
        id: call.id,
        name: call.name,
        failure: AgentEvent.failureFromCause(Cause.fail(error)),
        returnedToModel: false
      })
      return yield* error
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
                  ? EventBus.emit(options.bus, options.correlation, {
                      _tag: "ToolCallProgress",
                      id: call.id,
                      name: call.name,
                      result: next.result
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
            EventBus.emit(options.bus, options.correlation, {
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
        !isDefect && options.failurePolicy._tag === "ReturnToModel"

      yield* EventBus.emit(options.bus, options.correlation, {
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
      options.bus,
      options.correlation,
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
            result: result.result
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
export const execute = <Tools extends Record<string, Tool.Any>>(
  handler: Toolkit.WithHandler<Tools>,
  calls: ReadonlyArray<Response.ToolCallParts<Tools, true>>,
  options: Options
): Effect.Effect<
  ReadonlyArray<Response.AnyPart>,
  Tool.HandlerError<Tools[keyof Tools]> | ToolApprovalRequiredError,
  Tool.HandlerServices<Tools[keyof Tools]>
> =>
  Effect.all(
    calls.map((call) => executeOne(handler, call, options)),
    concurrencyOption(options.strategy)
  )
