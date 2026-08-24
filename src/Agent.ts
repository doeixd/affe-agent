import { Effect, Option } from "effect"
import type * as ExecutionPlan from "effect/ExecutionPlan"
import type { Pipeable } from "effect/Pipeable"
import { pipeArguments } from "effect/Pipeable"
import { Toolkit } from "effect/unstable/ai"
import type { LanguageModel, Prompt } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import * as AgentLoop from "./AgentLoop.js"
import * as AgentSession from "./AgentSession.js"
import * as ContextTransform from "./ContextTransform.js"
import * as InternalToolkit from "./internal/toolkit.js"
import * as Permission from "./Permission.js"
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
  R = never,
  /**
   * What the session must still be given to resolve a model.
   *
   * `LanguageModel.LanguageModel` by default -- the model arrives through the
   * environment, which is the invariant this library is built on. An agent
   * carrying an `ExecutionPlan` names its own models, so `withExecutionPlan`
   * sets this to `never` and `AgentSession.make` stops asking for one.
   *
   * A parameter rather than a flag because it is the *signature* that has to
   * change: requiring a model an agent will not consult is a lie the compiler
   * should not tell. Defaulted, so no existing reference to
   * `AgentDefinition<Tools, E, R>` moves.
   */
  Model = LanguageModel.LanguageModel
> extends Pipeable {
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
  /**
   * Whether the agent may attempt each tool call. See `Permission`.
   *
   * `R` carries the policy's requirements too: a policy that consults a
   * service makes it required at `AgentSession.make`.
   */
  readonly permission: Permission.Policy<R>
  /** What a denied or refused call does to the run. See `ToolExecution.Options`. */
  readonly toolDenialPolicy: ToolExecution.FailurePolicy
  /**
   * An ordered fallback ladder for the model call. See `withExecutionPlan`.
   *
   * Absent by default: the model comes from the environment and there is
   * nothing to fall back to.
   */
  readonly executionPlan: Option.Option<ExecutionPlan.ExecutionPlan<any>>
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
  KR = never,
  Bound extends ReadonlyArray<BoundTool<Tool.Any>> = [],
  PR = never
> {
  readonly instructions?: string | undefined
  readonly toolkit?: ToolkitInput<Tools, KE, KR> | undefined
  /**
   * Bound tools, as an alternative to `toolkit`.
   *
   * Lowered to one toolkit with one handler set -- exactly what
   * `Agent.toolkit(tools, handlers)` builds -- so the two spellings are the
   * same agent. Supplying both is a configuration error and is reported at
   * construction.
   */
  readonly tools?: Bound | undefined
  /**
   * Defaults to `AgentLoop.untilIdle()`.
   *
   * A bare function is accepted as well as an `AgentLoop`, because writing one
   * inline is how a policy gets its `Tools` by contextual typing — the toolkit
   * on this same object determines them, so `state.toolCalls` is precise
   * without a type argument.
   */
  readonly loop?:
    /**
     * `any` in the tool slot, deliberately, and this is the only place it
     * appears in the loop surface.
     *
     * `AgentLoop.State` is invariant in `Tools` — it carries a
     * `GenerateTextResponse<Tools, true>`, which Effect AI makes invariant — so
     * a policy written for one tool record is not assignable to another. That
     * would make `AgentLoop.bounded(20)` unusable with any agent that has
     * tools, even though it never looks at them.
     *
     * Confining the escape here keeps the combinators honest about the tools
     * they accept, and leaves the *function* form below fully precise: an
     * inline policy still gets its `state` typed by this agent's toolkit.
     */
    | AgentLoop.AgentLoop<LE, LR, any>
    | ((
        state: AgentLoop.State<Tools & ToolsOf<Bound>>
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
  /**
   * Defaults to `Permission.allowAll`: without a policy, the only thing
   * between the model and a tool is the tool's own `needsApproval`, which
   * is honoured regardless.
   */
  readonly permission?: Permission.Policy<PR> | undefined
  /**
   * Defaults to `ToolExecution.FailRun`: a denied or refused call ends the
   * run, and the model is told nothing. `ReturnToModel` commits the refusal
   * as a failed tool result instead, so the model can take another route.
   */
  readonly toolDenialPolicy?: ToolExecution.FailurePolicy | undefined
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

/**
 * The one place an `AgentDefinition` value is assembled.
 *
 * `pipe` carries no semantics: it is syntax for passing the value through
 * functions, which is what makes `Agent.make().pipe(Agent.withTool(...))` and
 * reusable bundles (`agent => agent.pipe(...)`) possible without a builder
 * or a registry.
 *
 * The fields are accepted with their channels erased and the result asserted,
 * in this one internal place: every combinator states its own precise result
 * type, and the loop's `Tools` slot is invariant (see `Config.loop`), so the
 * compiler cannot relate a field typed for one agent to the next agent's
 * parameters even when the value is exactly right. A spread of a definition
 * keeps `pipe` as an own property, so derived values pipe too.
 */
const definition = <Tools extends Record<string, Tool.Any>, E, R, Model = LanguageModel.LanguageModel>(fields: {
  readonly instructions: Option.Option<string>
  readonly toolkit: ToolkitInput<any, any, any>
  readonly loop: AgentLoop.AgentLoop<any, any, any>
  readonly contextTransform: ContextTransform.ContextTransform<any, any>
  readonly toolExecution: ToolExecution.Strategy
  readonly toolFailurePolicy: ToolExecution.FailurePolicy
  readonly permission: Permission.Policy<any>
  readonly toolDenialPolicy: ToolExecution.FailurePolicy
  readonly executionPlan: Option.Option<ExecutionPlan.ExecutionPlan<any>>
}): AgentDefinition<Tools, E, R, Model> =>
  ({
    instructions: fields.instructions,
    toolkit: fields.toolkit,
    loop: fields.loop,
    contextTransform: fields.contextTransform,
    toolExecution: fields.toolExecution,
    toolFailurePolicy: fields.toolFailurePolicy,
    permission: fields.permission,
    toolDenialPolicy: fields.toolDenialPolicy,
    executionPlan: fields.executionPlan,
    pipe() {
      return pipeArguments(this, arguments)
    }
  }) as AgentDefinition<Tools, E, R, Model>

export const make = <
  Tools extends Record<string, Tool.Any> = {},
  LE = never,
  LR = never,
  TE = never,
  TR = never,
  KE = never,
  KR = never,
  const Bound extends ReadonlyArray<BoundTool<Tool.Any>> = [],
  PR = never
>(
  config?: Config<Tools, LE, LR, TE, TR, KE, KR, Bound, PR>
  // The toolkit's resolution failure joins the agent's error type, alongside
  // the loop's and the transform's. Acquiring a capability can fail; saying so
  // is what lets a caller handle it. Bound tools contribute their record and
  // their handlers' requirements exactly as `withTools` would.
): AgentDefinition<
  Tools & ToolsOf<Bound>,
  LE | TE | KE,
  LR | TR | KR | ServicesOf<Bound> | PR
> => {
  if (config?.toolkit !== undefined && config?.tools !== undefined) {
    throw new Error("Agent.make: supply either `toolkit` or `tools`, not both")
  }
  return definition({
    instructions: Option.fromUndefinedOr(config?.instructions),
    // Always a toolkit, never `undefined`. An agent without tools gets an
    // empty one, so the engine has a single code path and the model call
    // keeps its tool types instead of collapsing across a branch.
    //
    // The assertion is safe by construction: the empty branch is only
    // reached when neither `toolkit` nor `tools` was given, in which case
    // `Tools` was inferred as `{}` — a fact about inference the compiler
    // cannot restate here. The `tools` branch is the same lowering
    // `withTools` performs, typed by `Config` rather than re-derived.
    toolkit:
      config?.toolkit ??
        (config?.tools === undefined
          ? (Toolkit.empty as unknown as ToolkitInput<Tools>)
          : boundToolkit(config.tools)),
    loop:
      config?.loop === undefined
        ? AgentLoop.untilIdle()
        : typeof config.loop === "function"
          ? AgentLoop.make(config.loop)
          : config.loop,
    contextTransform:
      config?.contextTransform === undefined
        ? ContextTransform.identity
        : typeof config.contextTransform === "function"
          ? ContextTransform.make(config.contextTransform)
          : config.contextTransform,
    toolExecution: config?.toolExecution ?? ToolExecution.Parallel,
    toolFailurePolicy: config?.toolFailurePolicy ?? ToolExecution.ReturnToModel,
    permission: config?.permission ?? Permission.allowAll,
    toolDenialPolicy: config?.toolDenialPolicy ?? ToolExecution.FailRun,
    // Not in `Config`, deliberately. A plan is a combinator
    // (`withExecutionPlan`) because it changes the *signature* -- it
    // discharges `LanguageModel` -- and `Config` cannot express that.
    executionPlan: Option.none()
  })
}

// ---------------------------------------------------------------------------
// Bound tools
// ---------------------------------------------------------------------------

/** The handler an Effect AI tool expects: parameters in, typed result out. */
export type Handler<T extends Tool.Any> =
  Toolkit.HandlersFrom<Record<Tool.Name<T>, T>>[Tool.Name<T>]

/**
 * An Effect AI `Tool` paired with its handler.
 *
 * Inert: a declarative value with no execution semantics of its own. It
 * lowers into the same `Toolkit`/handler machinery that `Agent.toolkit`
 * builds, so a bound tool runs exactly as one bound in bulk would -- same
 * decoding, same approval, same failure policy, same events.
 */
export interface BoundTool<T extends Tool.Any> {
  readonly tool: T
  readonly handler: Handler<T>
}

/**
 * Pair one tool with its handler.
 *
 * Parameters and results are inferred from the tool's schema; the handler's
 * requirements are the tool's declared `dependencies`, and join the agent's
 * `R` when the tool is added. Nothing here wraps the handler: timeouts,
 * retries and spans belong on the handler's own Effect, where they already
 * compose.
 */
export const tool = <T extends Tool.Any>(
  tool: T,
  handler: Handler<T>
): BoundTool<T> => ({ tool, handler })

/** The tool record a tuple of bound tools contributes. */
export type ToolsOf<Bound extends ReadonlyArray<BoundTool<Tool.Any>>> = {
  readonly [B in Bound[number] as Tool.Name<B["tool"]>]: B["tool"]
}

/** The handler requirements a tuple of bound tools contributes. */
export type ServicesOf<Bound extends ReadonlyArray<BoundTool<Tool.Any>>> =
  Tool.HandlerServices<Bound[number]["tool"]>

/**
 * Lower bound tools to one toolkit with one handler set.
 *
 * Exactly `Agent.toolkit(tools, handlers)`: the bound form is a different
 * spelling of the same construction, not a second path through the engine.
 */
const boundToolkit = <const Bound extends ReadonlyArray<BoundTool<Tool.Any>>>(
  bound: Bound
): Effect.Effect<Toolkit.WithHandler<ToolsOf<Bound>>, never, ServicesOf<Bound>> => {
  const handlers: Record<string, unknown> = {}
  for (const { tool, handler } of bound) {
    // `Object.hasOwn`, not `in`: a tool named `constructor` or `toString`
    // is a legitimate tool, not a duplicate of Object.prototype's.
    if (Object.hasOwn(handlers, tool.name)) {
      // Deterministic and early: two handlers under one name would make the
      // toolkit's dispatch ambiguous, which nothing downstream could detect.
      throw new Error(`Agent: duplicate tool name "${tool.name}"`)
    }
    handlers[tool.name] = handler
  }
  // The handlers record was built from exactly these tools by name, which is
  // what `HandlersFrom<ToolsByName<...>>` describes; the compiler cannot see
  // that through the loop above, so the relationship is asserted here, once.
  return toolkit(
    bound.map((entry) => entry.tool),
    handlers as Toolkit.HandlersFrom<Toolkit.ToolsByName<ReadonlyArray<Tool.Any>>>
  ) as unknown as Effect.Effect<
    Toolkit.WithHandler<ToolsOf<Bound>>,
    never,
    ServicesOf<Bound>
  >
}

/**
 * Combine two handled toolkits into one, by delegation.
 *
 * Effect AI composes toolkits before their handlers are bound; once bound, a
 * `WithHandler` is a closed value. Adding a tool to an agent that already has
 * some therefore merges at the `handle` level: the name decides which
 * toolkit answers. Solved once here, so every authoring path shares it.
 */
const mergeHandled = <
  A extends Record<string, Tool.Any>,
  B extends Record<string, Tool.Any>
>(
  left: Toolkit.WithHandler<A>,
  right: Toolkit.WithHandler<B>
): Toolkit.WithHandler<A & B> => {
  for (const name of Object.keys(right.tools)) {
    if (Object.hasOwn(left.tools, name)) {
      throw new Error(`Agent: duplicate tool name "${name}"`)
    }
  }
  const tools = { ...left.tools, ...right.tools } as A & B
  // Dispatch by own name only (`Object.hasOwn`): `"toString" in right.tools`
  // would be true of any object and route a tool of that name wrongly. The
  // `any` on the two `handle` calls is this module's documented structural
  // cast: each side's `handle` is typed for its own record, and the merged
  // signature is exactly their union by name.
  const handle = ((name: string, params: unknown, toolCallId?: string) =>
    Object.hasOwn(right.tools, name)
      ? (right.handle as any)(name, params, toolCallId)
      : (left.handle as any)(name, params, toolCallId)) as Toolkit.WithHandler<
    A & B
  >["handle"]
  return { tools, handle }
}

const resolveToolkit = <Tools extends Record<string, Tool.Any>, E, R>(
  input: ToolkitInput<Tools, E, R>
): Effect.Effect<Toolkit.WithHandler<Tools>, E, R> =>
  InternalToolkit.resolveToolkitInput(input)

// ---------------------------------------------------------------------------
// Pipeable combinators
//
// Each is a pure function from one agent value to another, and each `withX`
// has one meaning: replace. Combining with what is there is `updateX`.
// ---------------------------------------------------------------------------

/** Replace the instructions. */
export const withInstructions =
  (instructions: string) =>
  <Tools extends Record<string, Tool.Any>, E, R>(
    agent: AgentDefinition<Tools, E, R>
  ): AgentDefinition<Tools, E, R> =>
    definition({ ...agent, instructions: Option.some(instructions) })

/**
 * Replace the toolkit.
 *
 * The Effect form keeps its power: a toolkit resolved per turn from runtime
 * state is ordinary Effect, and this combinator does not make it static.
 */
export const withToolkit =
  <Tools extends Record<string, Tool.Any>, KE = never, KR = never>(
    toolkit: ToolkitInput<Tools, KE, KR>
  ) =>
  <_Tools extends Record<string, Tool.Any>, E, R>(
    agent: AgentDefinition<_Tools, E, R>
  ): AgentDefinition<Tools, E | KE, R | KR> =>
    definition<Tools, E | KE, R | KR>({ ...agent, toolkit })

/**
 * Add bound tools to an agent, accumulating the tool record precisely.
 *
 * Lowered to one toolkit: the new tools become a handled toolkit of their
 * own and are merged into the agent's by delegation, whether that one is a
 * value or an Effect resolved per turn. A duplicate name is a defect at
 * resolution.
 */
export const withTools =
  <const Bound extends ReadonlyArray<BoundTool<Tool.Any>>>(...bound: Bound) =>
  <Tools extends Record<string, Tool.Any>, E, R>(
    agent: AgentDefinition<Tools, E, R>
  ): AgentDefinition<Tools & ToolsOf<Bound>, E, R | ServicesOf<Bound>> => {
    const added = boundToolkit(bound)
    const merged: Effect.Effect<
      Toolkit.WithHandler<Tools & ToolsOf<Bound>>,
      E,
      R | ServicesOf<Bound>
    > = Effect.flatMap(resolveToolkit(agent.toolkit), (existing) =>
      Effect.map(added, (extra) => mergeHandled(existing, extra))
    )
    return definition<Tools & ToolsOf<Bound>, E, R | ServicesOf<Bound>>({
      ...agent,
      toolkit: merged
    })
  }

/**
 * Add one tool: bound, or a tool and its handler inline.
 *
 * Overloads over the one implementation (`withTools`).
 */
export const withTool: {
  <T extends Tool.Any>(
    bound: BoundTool<T>
  ): <Tools extends Record<string, Tool.Any>, E, R>(
    agent: AgentDefinition<Tools, E, R>
  ) => AgentDefinition<Tools & ToolsOf<[BoundTool<T>]>, E, R | Tool.HandlerServices<T>>
  <T extends Tool.Any>(
    tool: T,
    handler: Handler<T>
  ): <Tools extends Record<string, Tool.Any>, E, R>(
    agent: AgentDefinition<Tools, E, R>
  ) => AgentDefinition<Tools & ToolsOf<[BoundTool<T>]>, E, R | Tool.HandlerServices<T>>
} = <T extends Tool.Any>(first: BoundTool<T> | T, handler?: Handler<T>) => {
  if (isBound(first)) return withTools(first)
  if (handler === undefined) {
    // Unreachable through the overloads; stated rather than asserted away.
    throw new Error(`Agent.withTool: tool "${first.name}" needs a handler`)
  }
  return withTools(tool(first, handler))
}

/** A bound tool carries its tool and handler; a bare tool carries a name. */
const isBound = <T extends Tool.Any>(
  value: BoundTool<T> | T
): value is BoundTool<T> => "tool" in value && "handler" in value

/** Replace the context transform. A bare function is accepted. */
export const withContextTransform =
  <TE = never, TR = never>(
    transform:
      | ContextTransform.ContextTransform<TE, TR>
      | ((
          context: ContextTransform.Context
        ) => Effect.Effect<Prompt.Prompt, TE, TR>)
  ) =>
  <Tools extends Record<string, Tool.Any>, E, R>(
    agent: AgentDefinition<Tools, E, R>
  ): AgentDefinition<Tools, E | TE, R | TR> =>
    definition<Tools, E | TE, R | TR>({
      ...agent,
      contextTransform:
        typeof transform === "function"
          ? ContextTransform.make(transform)
          : transform
    })

/**
 * Combine with the current context transform, left to right.
 *
 * `withContextTransform` replaces; this composes, and says so.
 */
export const updateContextTransform =
  <Tools extends Record<string, Tool.Any>, E, R, TE = never, TR = never>(
    update: (
      current: ContextTransform.ContextTransform<E, R>
    ) => ContextTransform.ContextTransform<TE, TR>
  ) =>
  (agent: AgentDefinition<Tools, E, R>): AgentDefinition<Tools, E | TE, R | TR> =>
    definition<Tools, E | TE, R | TR>({
      ...agent,
      contextTransform: update(agent.contextTransform)
    })

/**
 * Replace the loop policy. A bare function is accepted.
 *
 * In pipe position the agent's tools are not yet known to the combinator,
 * so an inline policy sees `state` over `any` tools. A policy that inspects
 * `state.toolCalls` by name should name its tools (`AgentLoop.make<Tools>`)
 * or use the object form, where the toolkit on the same object types it.
 */
export const withLoop =
  <LE = never, LR = never, LTools extends Record<string, Tool.Any> = any>(
    loop:
      | AgentLoop.AgentLoop<LE, LR, LTools>
      | ((state: AgentLoop.State<LTools>) => Effect.Effect<AgentLoop.Decision, LE, LR>)
  ) =>
  <Tools extends LTools, E, R>(
    agent: AgentDefinition<Tools, E, R>
  ): AgentDefinition<Tools, E | LE, R | LR> =>
    definition<Tools, E | LE, R | LR>({
      ...agent,
      loop: typeof loop === "function" ? AgentLoop.make(loop) : loop
    })

/**
 * Derive the loop from the current one -- `AgentLoop.and(current, ...)`, say.
 *
 * `withLoop` replaces; this combines, and says so.
 */
export const updateLoop =
  <Tools extends Record<string, Tool.Any>, E, R, LE = never, LR = never>(
    update: (
      current: AgentLoop.AgentLoop<E, R, Tools>
    ) => AgentLoop.AgentLoop<LE, LR, Tools>
  ) =>
  (agent: AgentDefinition<Tools, E, R>): AgentDefinition<Tools, E | LE, R | LR> =>
    definition<Tools, E | LE, R | LR>({ ...agent, loop: update(agent.loop) })

/** Replace the tool execution strategy. */
export const withToolExecution =
  (strategy: ToolExecution.Strategy) =>
  <Tools extends Record<string, Tool.Any>, E, R>(
    agent: AgentDefinition<Tools, E, R>
  ): AgentDefinition<Tools, E, R> =>
    definition({ ...agent, toolExecution: strategy })

/** Replace the tool failure policy. */
export const withToolFailurePolicy =
  (policy: ToolExecution.FailurePolicy) =>
  <Tools extends Record<string, Tool.Any>, E, R>(
    agent: AgentDefinition<Tools, E, R>
  ): AgentDefinition<Tools, E, R> =>
    definition({ ...agent, toolFailurePolicy: policy })

/**
 * Replace the permission policy.
 *
 * Replace, not merge: an agent has one policy, and composing several is
 * `Permission.all`, stated at the call site where the merge can be read.
 * The policy's requirements join the agent's.
 */
export const withPermission =
  <PR>(policy: Permission.Policy<PR>) =>
  <Tools extends Record<string, Tool.Any>, E, R>(
    agent: AgentDefinition<Tools, E, R>
  ): AgentDefinition<Tools, E, R | PR> =>
    definition({ ...agent, permission: policy })

/**
 * Give the agent an ordered ladder of models to try.
 *
 * The model still does not appear in the `Agent`: every step in the plan names
 * one, and the plan is supplied at the edge exactly as a layer would be. What
 * changes is that the agent no longer needs one from its environment --
 * `AgentSession.make` stops requiring `LanguageModel`, because requiring a
 * model the agent will not consult is a lie the signature should not tell.
 *
 * ```ts
 * const plan = ExecutionPlan.make(
 *   { provide: Anthropic, attempts: 2, schedule: Schedule.exponential("200 millis") },
 *   { provide: OpenAi }
 * )
 * const agent = Agent.make({ toolkit, loop }).pipe(Agent.withExecutionPlan(plan))
 * ```
 *
 * **The plan wraps the model call and nothing wider.** A turn is a model call
 * *and the tool calls it asked for*, so a plan around the turn would retry
 * tools -- side effects on the world -- because a different part of the turn
 * failed. Confining it to the call also makes retry safe by construction:
 * nothing the harness guarantees has happened yet while the plan is still
 * choosing. See `docs/plan-execution-plan.md`.
 *
 * A combinator rather than a `Config` field, per AGENTS.md §42.1 -- and here
 * the rule earns itself twice over, because this is the one cross-cutting
 * concern that changes what the session *requires*.
 */
export const withExecutionPlan =
  <
    Types extends {
      provides: any
      input: any
      error: any
      requirements: any
    }
  >(
    // Generic over the plan's whole type rather than over `provides` alone.
    // Naming only `provides` and widening the rest to `any` reads as more
    // permissive and is in fact *stricter*: `ExecutionPlan` is invariant in
    // those slots, so a real `ExecutionPlan.make(...)` -- which infers
    // `input: unknown, error: never` -- would not be assignable, and the
    // combinator would compile while being impossible to call.
    plan: ExecutionPlan.ExecutionPlan<Types>
  ) =>
  <Tools extends Record<string, Tool.Any>, E, R, Model>(
    agent: AgentDefinition<Tools, E, R, Model>
  ): AgentDefinition<
    Tools,
    E,
    Exclude<R, Types["provides"]>,
    Exclude<Model, Types["provides"]>
  > =>
    definition({ ...agent, executionPlan: Option.some(plan) })

/** Replace what a denied or refused call does to the run. */
export const withToolDenialPolicy =
  (policy: ToolExecution.FailurePolicy) =>
  <Tools extends Record<string, Tool.Any>, E, R>(
    agent: AgentDefinition<Tools, E, R>
  ): AgentDefinition<Tools, E, R> =>
    definition({ ...agent, toolDenialPolicy: policy })

// ---------------------------------------------------------------------------
// One-shot
// ---------------------------------------------------------------------------

/**
 * Run one prompt to quiescence in a session that lives for the call.
 *
 * Literally the scoped sequence it replaces -- `AgentSession.make`, then
 * `prompt` -- with the same result, errors, requirements, interruption and
 * quiescence. Reach for `AgentSession` when the conversation continues:
 * steering, follow-ups, interruption, answers, observation, identity.
 */
export const run = <Tools extends Record<string, Tool.Any>, E, R>(
  agent: AgentDefinition<Tools, E, R>,
  input: Prompt.RawInput,
  options?: AgentSession.PromptOptions
): Effect.Effect<
  AgentSession.Result<Tools>,
  AgentSession.PromptError<Tools, E>,
  LanguageModel.LanguageModel | R
> =>
  Effect.scoped(
    Effect.flatMap(AgentSession.make(agent), (session) =>
      AgentSession.prompt(session, input, options)
    )
  )

