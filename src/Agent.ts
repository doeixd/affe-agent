import { Effect, Option } from "effect"
import { Toolkit } from "effect/unstable/ai"
import type { Prompt } from "effect/unstable/ai"
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
  /**
   * `R` carries the toolkit's requirements as well as the loop's and the
   * transform's, so a tool declaring `dependencies` makes those services
   * required at `AgentSession.make` rather than failing at the first call.
   */
  readonly toolkit: ToolkitInput<Tools, E, R>
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
 *
 * It may fail, and that failure joins the agent's error type. Acquiring a
 * capability is exactly the kind of thing that fails — connecting to a tenant's
 * MCP server, reading a policy, fetching a credential — and forbidding it would
 * push every such resolver into either dying or pre-resolving outside the
 * agent, which defeats the point of resolving per turn.
 */
export type ToolkitInput<
  Tools extends Record<string, Tool.Any>,
  E = never,
  R = never
> = Toolkit.WithHandler<Tools> | Effect.Effect<Toolkit.WithHandler<Tools>, E, R>

export interface Config<
  Tools extends Record<string, Tool.Any> = {},
  LE = never,
  LR = never,
  TE = never,
  TR = never,
  KE = never,
  KR = never
> {
  readonly instructions?: string | undefined
  readonly toolkit?: ToolkitInput<Tools, KE, KR> | undefined
  /**
   * Defaults to `AgentLoop.untilIdle()`.
   *
   * A bare function is accepted as well as an `AgentLoop`, because writing one
   * inline is how a policy gets its `Tools` by contextual typing — the toolkit
   * on this same object determines them, so `state.toolCalls` is precise
   * without a type argument.
   */
  readonly loop?:
    | AgentLoop.AgentLoop<LE, LR, Tools>
    | ((
        state: AgentLoop.State<Tools>
      ) => Effect.Effect<AgentLoop.Decision, LE, LR>)
    | undefined
  /** Defaults to `ContextTransform.identity`. A bare function is accepted. */
  readonly contextTransform?:
    | ContextTransform.ContextTransform<TE, TR>
    | ((
        context: ContextTransform.Context
      ) => Effect.Effect<Prompt.Prompt, TE, TR>)
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
/**
 * Build a toolkit and bind its handlers in one step.
 *
 * The two-step form is easy to get wrong in a way nothing catches:
 *
 * ```ts
 * Toolkit.make(Search).pipe(Effect.provide(Toolkit.make(Search).toLayer(...)))
 * ```
 *
 * That creates two unrelated toolkits and binds the handlers to the one that is
 * not used, so every tool call resolves to nothing and *succeeds* — a green
 * test that proves nothing. Naming the toolkit once is the fix, and this makes
 * it the only thing you can do.
 *
 * Handler parameters and results are inferred from the tools' schemas.
 */
export const toolkit = <const Tools extends ReadonlyArray<Tool.Any>>(
  tools: Tools,
  handlers: Toolkit.HandlersFrom<Toolkit.ToolsByName<Tools>>
): Effect.Effect<
  Toolkit.WithHandler<Toolkit.ToolsByName<Tools>>,
  never,
  Tool.HandlerServices<
    Toolkit.ToolsByName<Tools>[keyof Toolkit.ToolsByName<Tools>]
  >
> => {
  const built = Toolkit.make(...tools)
  return built.pipe(Effect.provide(built.toLayer(handlers))) as Effect.Effect<
    Toolkit.WithHandler<Toolkit.ToolsByName<Tools>>,
    never,
    Tool.HandlerServices<
      Toolkit.ToolsByName<Tools>[keyof Toolkit.ToolsByName<Tools>]
    >
  >
}

export const make = <
  Tools extends Record<string, Tool.Any> = {},
  LE = never,
  LR = never,
  TE = never,
  TR = never,
  KE = never,
  KR = never
>(
  config: Config<Tools, LE, LR, TE, TR, KE, KR> = {}
  // The toolkit's resolution failure joins the agent's error type, alongside
  // the loop's and the transform's. Acquiring a capability can fail; saying so
  // is what lets a caller handle it.
): AgentDefinition<Tools, LE | TE | KE, LR | TR | KR> => ({
  instructions: Option.fromUndefinedOr(config.instructions),
  // Always a toolkit, never `undefined`. An agent without tools gets an empty
  // one, so the engine has a single code path and the model call keeps its tool
  // types instead of collapsing across a branch.
  //
  // The assertion is safe by construction: this branch is only reached when
  // `toolkit` was absent, in which case `Tools` was inferred as `{}` — but that
  // is a fact about inference the compiler cannot restate here.
  toolkit: config.toolkit ?? (Toolkit.empty as unknown as ToolkitInput<Tools>),
  loop:
    config.loop === undefined
      ? AgentLoop.untilIdle()
      : typeof config.loop === "function"
        ? AgentLoop.make(config.loop)
        : config.loop,
  contextTransform:
    config.contextTransform === undefined
      ? ContextTransform.identity
      : typeof config.contextTransform === "function"
        ? ContextTransform.make(config.contextTransform)
        : config.contextTransform,
  toolExecution: config.toolExecution ?? ToolExecution.Parallel,
  toolFailurePolicy: config.toolFailurePolicy ?? ToolExecution.ReturnToModel
})
