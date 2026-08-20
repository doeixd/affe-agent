import { Option } from "effect"
import type { Effect } from "effect"
import { Toolkit } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import * as AgentLoop from "./AgentLoop.js"
import * as ContextTransform from "./ContextTransform.js"
import * as ToolExecution from "./ToolExecution.js"

/**
 * A reusable description of agent behaviour.
 *
 * An `Agent` is a value, not a running instance, and it deliberately carries no
 * model. The model arrives through the Effect environment, so the same agent
 * runs against any provider, a test double, or a routing layer without being
 * redefined — and a subagent can run under an entirely different model.
 */
export interface AgentDefinition<
  Tools extends Record<string, Tool.Any> = {},
  E = never,
  R = never
> {
  readonly instructions: Option.Option<string>
  readonly toolkit: ToolkitInput<Tools>
  readonly loop: AgentLoop.AgentLoop<E, R, Tools>
  readonly contextTransform: ContextTransform.ContextTransform<E, R>
  readonly toolExecution: ToolExecution.Strategy
  readonly toolFailurePolicy: ToolExecution.FailurePolicy
}

/**
 * A toolkit, or an Effect producing one.
 *
 * The Effect form is how capabilities vary with runtime state: it is ordinary
 * effectful computation, resolved per turn, rather than a dynamic-capability
 * DSL of the harness's own invention.
 */
export type ToolkitInput<Tools extends Record<string, Tool.Any>> =
  | Toolkit.WithHandler<Tools>
  | Effect.Effect<Toolkit.WithHandler<Tools>, never, any>

export interface Config<
  Tools extends Record<string, Tool.Any> = {},
  LE = never,
  LR = never,
  TE = never,
  TR = never
> {
  readonly instructions?: string | undefined
  readonly toolkit?: ToolkitInput<Tools> | undefined
  /** Defaults to `AgentLoop.untilIdle()`. */
  readonly loop?: AgentLoop.AgentLoop<LE, LR, Tools> | undefined
  /** Defaults to `ContextTransform.identity`. */
  readonly contextTransform?:
    | ContextTransform.ContextTransform<TE, TR>
    | undefined
  /** Defaults to `ToolExecution.Parallel`. */
  readonly toolExecution?: ToolExecution.Strategy | undefined
  /**
   * Defaults to `ToolExecution.ReturnToModel`: a tool that fails on a bad
   * argument should let the model try again rather than destroy the run.
   * Defects still fail the run regardless.
   */
  readonly toolFailurePolicy?: ToolExecution.FailurePolicy | undefined
}

/**
 * The loop's and the transform's errors and requirements are unioned onto the
 * agent, so a policy or a transform can declare its own dependencies and the
 * session's type reflects them.
 */
export const make = <
  Tools extends Record<string, Tool.Any> = {},
  LE = never,
  LR = never,
  TE = never,
  TR = never
>(
  config: Config<Tools, LE, LR, TE, TR> = {}
): AgentDefinition<Tools, LE | TE, LR | TR> => ({
  instructions: Option.fromUndefinedOr(config.instructions),
  // Always a toolkit, never `undefined`. An agent without tools gets an empty
  // one, so the engine has a single code path and the model call keeps its tool
  // types instead of collapsing across a branch.
  //
  // The assertion is safe by construction: this branch is only reached when
  // `toolkit` was absent, in which case `Tools` was inferred as `{}` — but that
  // is a fact about inference the compiler cannot restate here.
  toolkit: config.toolkit ?? (Toolkit.empty as unknown as ToolkitInput<Tools>),
  loop: config.loop ?? AgentLoop.untilIdle(),
  contextTransform: config.contextTransform ?? ContextTransform.identity,
  toolExecution: config.toolExecution ?? ToolExecution.Parallel,
  toolFailurePolicy: config.toolFailurePolicy ?? ToolExecution.ReturnToModel
})
