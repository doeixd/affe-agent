import { Effect, Option } from "effect"
import type * as ExecutionPlan from "effect/ExecutionPlan"
import type { Pipeable } from "effect/Pipeable"
import { pipeArguments } from "effect/Pipeable"
import { Toolkit } from "effect/unstable/ai"
import type { AiError, LanguageModel, Prompt } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import * as AgentLoop from "./AgentLoop.js"
import * as AgentInput from "./AgentInput.js"
import * as AgentOutput from "./AgentOutput.js"
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
  Model = LanguageModel.LanguageModel,
  /**
   * The typed value a submission ends with, or `never` when the agent
   * declares no output. See `output` below and `AgentOutput`.
   *
   * Defaulted and last, so every existing reference to
   * `AgentDefinition<Tools, E, R>` or `<Tools, E, R, Model>` still means what
   * it did.
   *
   * Carried in the type reference only, and not in the `output` field below.
   * Referencing it there gives inference a second site for the same variable,
   * and piping an agent through a combinator then leaves it unresolved --
   * `Agent.run(Researcher, ...)` stopped compiling on an agent that declares
   * no output at all.
   *
   * Invariant (`in out`) rather than left to inference, which is the
   * difference between this and `Model`. A parameter that appears in no field
   * is bivariant, so two definitions differing only here would be mutually
   * assignable -- and a caller could pass an agent whose output is `A` where
   * one producing `B` was expected, then read `result.value` as `Option<B>`
   * holding an `A`. `Model` erasure does not have that failure mode: it is a
   * *requirement* slot, and a mismatch there is caught at `Effect.provide`.
   * This is a *data* slot the caller reads, with nothing downstream to catch
   * it, so the variance is declared.
   */
  in out Value = never,
  /**
   * The typed value this agent's submissions are asked with, or `never` for
   * `Prompt.RawInput`. Invariant for the same reason `Value` is: a caller
   * passes it, and nothing downstream would catch a mismatch.
   */
  in out Input = never
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
  /**
   * The shape this agent's submissions end in, if it declares one.
   *
   * Absent by default: an agent that answers in prose is the common case, and
   * an output contract no caller reads is a tool the model can waste a turn
   * on. See `AgentOutput` for why this is a tool rather than a second kind of
   * model call.
   */
  readonly output: Option.Option<AgentOutput.AgentOutput<any, any>>
  /**
   * The shape this agent's submissions are asked in, if it declares one.
   *
   * Absent by default: `prompt` takes `Prompt.RawInput`. See `AgentInput`
   * for the value/rendering split it introduces and what reads the value.
   */
  readonly input: Option.Option<AgentInput.AgentInput<Input, any, E, R>>
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
  PR = never,
  Value = never,
  Input = never,
  IE = never,
  IR = never
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
  /**
   * The shape every submission must end in. See `AgentOutput.make`.
   *
   * Declaring it does three things: the model is given a tool to report the
   * value through, the run stops as soon as it calls that tool, and
   * `Result.value` becomes `Option<Value>` instead of `Option<never>`.
   *
   * The stop is a policy composed onto whatever loop the agent has, not a
   * special case in the engine -- see `outputStop`.
   */
  readonly output?: AgentOutput.AgentOutput<Value, any> | undefined
  /**
   * The shape submissions are asked in, and how the model sees it.
   *
   * Declaring it makes `prompt` and `Agent.run` take the schema's type
   * instead of `Prompt.RawInput`, puts the encoded value on the submission's
   * fibre (`AgentInput.Current`) and on `SubmissionStarted`, and commits the
   * *rendering* to history. The renderer's failure and requirements join the
   * agent's. In-process only for now: see `AgentInput`.
   */
  readonly input?: AgentInput.AgentInput<Input, any, IE, IR> | undefined
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
): InternalToolkit.Declared<
  Toolkit.ToolsByName<Tools>,
  never,
  Tool.HandlerServices<
    Toolkit.ToolsByName<Tools>[keyof Toolkit.ToolsByName<Tools>]
  >
> => {
  const built = Toolkit.make(...tools)
  // Still an Effect, and it also says what it holds: the list is static
  // here, so a reader that needs the tools before the agent runs (a wiring
  // check in `Subagent`, say) can have them. See `InternalToolkit.Declared`.
  return InternalToolkit.declare(
    built.pipe(Effect.provide(built.toLayer(handlers))) as Effect.Effect<
      Toolkit.WithHandler<Toolkit.ToolsByName<Tools>>,
      never,
      Tool.HandlerServices<
        Toolkit.ToolsByName<Tools>[keyof Toolkit.ToolsByName<Tools>]
      >
    >,
    built.tools
  )
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
const definition = <Tools extends Record<string, Tool.Any>, E, R, Model = LanguageModel.LanguageModel, Value = never, Input = never>(fields: {
  readonly instructions: Option.Option<string>
  readonly toolkit: ToolkitInput<any, any, any>
  readonly loop: AgentLoop.AgentLoop<any, any, any>
  readonly contextTransform: ContextTransform.ContextTransform<any, any>
  readonly toolExecution: ToolExecution.Strategy
  readonly toolFailurePolicy: ToolExecution.FailurePolicy
  readonly permission: Permission.Policy<any>
  readonly toolDenialPolicy: ToolExecution.FailurePolicy
  readonly executionPlan: Option.Option<ExecutionPlan.ExecutionPlan<any>>
  readonly output: Option.Option<AgentOutput.AgentOutput<any, any>>
  readonly input: Option.Option<AgentInput.AgentInput<any, any, any, any>>
}): AgentDefinition<Tools, E, R, Model, Value, Input> =>
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
    output: fields.output,
    input: fields.input,
    pipe() {
      return pipeArguments(this, arguments)
    }
  }) as AgentDefinition<Tools, E, R, Model, Value, Input>

/**
 * Stop the run once the model has reported its output.
 *
 * Composed onto the agent's own loop rather than special-cased in the engine:
 * "the run is over when the answer has been given" is a continuation decision,
 * and continuation decisions live in `AgentLoop`. Nothing in `AgentRun` or
 * `AgentTurn` learns that outputs exist.
 *
 * The inner policy is consulted first and its `Stop` short-circuits, which is
 * exactly `AgentLoop.and(loop, ...)` — written out here only because `and`
 * cannot relate one agent's invariant `Tools` slot to another's (see
 * `Config.loop`). A policy that counts turns or records telemetry therefore
 * still sees the turn that produced the value.
 *
 * Without this, `untilIdle` would see a turn that made a tool call, continue,
 * and spend one more model call on a closing remark nobody reads.
 */
const withOutputStop = <E, R>(
  loop: AgentLoop.AgentLoop<E, R, any>,
  output: AgentOutput.AgentOutput<any, any> | undefined
): AgentLoop.AgentLoop<E, R, any> =>
  output === undefined
    ? loop
    : AgentLoop.make((state) =>
        Effect.map(loop.decide(state), (decision) =>
          // The answer has been given: stop, whatever the inner policy said
          // -- a `Final` turn after the output would only ask for it again.
          state.toolCalls.some((call) => call.name === output.toolName)
            ? AgentLoop.stop("output reported")
            : decision
        )
      )

export const make = <
  Tools extends Record<string, Tool.Any> = {},
  LE = never,
  LR = never,
  TE = never,
  TR = never,
  KE = never,
  KR = never,
  const Bound extends ReadonlyArray<BoundTool<Tool.Any>> = [],
  PR = never,
  Value = never,
  Input = never,
  IE = never,
  IR = never
>(
  config?: Config<Tools, LE, LR, TE, TR, KE, KR, Bound, PR, Value, Input, IE, IR>
  // The toolkit's resolution failure joins the agent's error type, alongside
  // the loop's and the transform's. Acquiring a capability can fail; saying so
  // is what lets a caller handle it. Bound tools contribute their record and
  // their handlers' requirements exactly as `withTools` would.
): AgentDefinition<
  Tools & ToolsOf<Bound>,
  LE | TE | KE | IE,
  LR | TR | KR | ServicesOf<Bound> | PR | IR,
  LanguageModel.LanguageModel,
  Value,
  Input
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
    loop: withOutputStop(
      config?.loop === undefined
        ? AgentLoop.untilIdle()
        : typeof config.loop === "function"
          ? AgentLoop.make(config.loop)
          : config.loop,
      config?.output
    ),
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
    output: Option.fromUndefinedOr(config?.output),
    input: Option.fromUndefinedOr(config?.input),
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
/**
 * The typed input an agent declares (`AgentInput`), or `never` for one
 * asked with `Prompt.RawInput`.
 *
 * Written once here because the obvious spelling is a trap:
 * `A extends AgentDefinition<any, any, any, any, any, infer I>` fails to
 * match -- `Value` is invariant, and `never` is not `any` in both directions
 * -- so its false branch yields `never`, and `never extends T` is true for
 * every `T`. A type assertion built on it passes vacuously. This infers
 * every invariant parameter.
 */
export type InputOf<A> = A extends AgentDefinition<any, any, any, infer _Model, infer _Value, infer Input> ? Input : never

/** The typed output an agent declares (`AgentOutput`), or `never`. See `InputOf` for why it is spelled this way. */
export type ValueOf<A> = A extends AgentDefinition<any, any, any, infer _Model, infer Value, infer _Input> ? Value : never

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
): InternalToolkit.Declared<ToolsOf<Bound>, never, ServicesOf<Bound>> => {
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
  ) as unknown as InternalToolkit.Declared<ToolsOf<Bound>, never, ServicesOf<Bound>>
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
  <Tools extends Record<string, Tool.Any>, E, R, Model, Value, Input>(
    agent: AgentDefinition<Tools, E, R, Model, Value, Input>
  ): AgentDefinition<Tools, E, R, Model, Value, Input> =>
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
  <_Tools extends Record<string, Tool.Any>, E, R, Model, Value, Input>(
    agent: AgentDefinition<_Tools, E, R, Model, Value, Input>
  ): AgentDefinition<Tools, E | KE, R | KR, Model, Value, Input> =>
    definition<Tools, E | KE, R | KR, Model, Value, Input>({ ...agent, toolkit })

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
  <Tools extends Record<string, Tool.Any>, E, R, Model, Value, Input>(
    agent: AgentDefinition<Tools, E, R, Model, Value, Input>
  ): AgentDefinition<Tools & ToolsOf<Bound>, E, R | ServicesOf<Bound>, Model, Value, Input> => {
    const added = boundToolkit(bound)
    const merged: Effect.Effect<
      Toolkit.WithHandler<Tools & ToolsOf<Bound>>,
      E,
      R | ServicesOf<Bound>
    > = Effect.flatMap(resolveToolkit(agent.toolkit), (existing) =>
      Effect.map(added, (extra) => InternalToolkit.mergeHandled(existing, extra))
    )
    // The declaration follows the merge: known when what it was added to was
    // known, and the same union `mergeHandled` will produce. A toolkit
    // resolved per turn stays undeclared, since its tools are not known yet.
    const declared = InternalToolkit.declaredTools(agent.toolkit)
    return definition<Tools & ToolsOf<Bound>, E, R | ServicesOf<Bound>, Model, Value, Input>({
      ...agent,
      toolkit: Option.isSome(declared)
        ? InternalToolkit.declare(merged, { ...declared.value, ...added.tools })
        : merged
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
  ): <Tools extends Record<string, Tool.Any>, E, R, Model, Value, Input>(
    agent: AgentDefinition<Tools, E, R, Model, Value, Input>
  ) => AgentDefinition<Tools & ToolsOf<[BoundTool<T>]>, E, R | Tool.HandlerServices<T>, Model, Value, Input>
  <T extends Tool.Any>(
    tool: T,
    handler: Handler<T>
  ): <Tools extends Record<string, Tool.Any>, E, R, Model, Value, Input>(
    agent: AgentDefinition<Tools, E, R, Model, Value, Input>
  ) => AgentDefinition<Tools & ToolsOf<[BoundTool<T>]>, E, R | Tool.HandlerServices<T>, Model, Value, Input>
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
  <Tools extends Record<string, Tool.Any>, E, R, Model, Value, Input>(
    agent: AgentDefinition<Tools, E, R, Model, Value, Input>
  ): AgentDefinition<Tools, E | TE, R | TR, Model, Value, Input> =>
    definition<Tools, E | TE, R | TR, Model, Value, Input>({
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
  <Tools extends Record<string, Tool.Any>, E, R, Model, Value, Input, TE = never, TR = never>(
    update: (
      current: ContextTransform.ContextTransform<E, R>
    ) => ContextTransform.ContextTransform<TE, TR>
  ) =>
  (
    agent: AgentDefinition<Tools, E, R, Model, Value, Input>
  ): AgentDefinition<Tools, E | TE, R | TR, Model, Value, Input> =>
    definition<Tools, E | TE, R | TR, Model, Value, Input>({
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
  <Tools extends LTools, E, R, Model, Value, Input>(
    agent: AgentDefinition<Tools, E, R, Model, Value, Input>
  ): AgentDefinition<Tools, E | LE, R | LR, Model, Value, Input> =>
    definition<Tools, E | LE, R | LR, Model, Value, Input>({
      ...agent,
      // Re-applied, not inherited: the stop rule belongs to the agent's
      // output contract, not to whichever loop happened to carry it. Without
      // this, replacing the loop of an agent that declares an output would
      // silently drop the rule and leave the run spending a turn after the
      // answer had already been given.
      loop: withOutputStop(
        typeof loop === "function" ? AgentLoop.make(loop) : loop,
        Option.getOrUndefined(agent.output)
      )
    })

/**
 * Derive the loop from the current one -- `AgentLoop.and(current, ...)`, say.
 *
 * `withLoop` replaces; this combines, and says so.
 */
export const updateLoop =
  <Tools extends Record<string, Tool.Any>, E, R, Model, Value, Input, LE = never, LR = never>(
    update: (
      current: AgentLoop.AgentLoop<E, R, Tools>
    ) => AgentLoop.AgentLoop<LE, LR, Tools>
  ) =>
  (
    agent: AgentDefinition<Tools, E, R, Model, Value, Input>
  ): AgentDefinition<Tools, E | LE, R | LR, Model, Value, Input> =>
    definition<Tools, E | LE, R | LR, Model, Value, Input>({
      ...agent,
      // As `withLoop`: the update receives the loop the agent is running --
      // stop rule included -- and its result is re-wrapped, so a policy that
      // composes with `AgentLoop.and` cannot lose the contract.
      loop: withOutputStop(update(agent.loop), Option.getOrUndefined(agent.output))
    })

/** Replace the tool execution strategy. */
export const withToolExecution =
  (strategy: ToolExecution.Strategy) =>
  <Tools extends Record<string, Tool.Any>, E, R, Model, Value, Input>(
    agent: AgentDefinition<Tools, E, R, Model, Value, Input>
  ): AgentDefinition<Tools, E, R, Model, Value, Input> =>
    definition({ ...agent, toolExecution: strategy })

/** Replace the tool failure policy. */
export const withToolFailurePolicy =
  (policy: ToolExecution.FailurePolicy) =>
  <Tools extends Record<string, Tool.Any>, E, R, Model, Value, Input>(
    agent: AgentDefinition<Tools, E, R, Model, Value, Input>
  ): AgentDefinition<Tools, E, R, Model, Value, Input> =>
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
  <Tools extends Record<string, Tool.Any>, E, R, Model, Value, Input>(
    agent: AgentDefinition<Tools, E, R, Model, Value, Input>
  ): AgentDefinition<Tools, E, R | PR, Model, Value, Input> =>
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
  <Tools extends Record<string, Tool.Any>, E, R, Model, Value, Input>(
    agent: AgentDefinition<Tools, E, R, Model, Value, Input>
  ): AiError.AiError extends Types["input"] ? AgentDefinition<
    Tools,
    /**
     * The plan's own failures are the agent's failures.
     *
     * `Effect.withExecutionPlan` adds the plan's error channel to whatever it
     * wraps -- a provider layer that can fail to build says so there -- and
     * this combinator used to add neither that nor the requirements below. A
     * plan whose layer reads configuration was advertised as infallible and
     * self-contained, and the erasure held only because the plan is stored as
     * `ExecutionPlan<any>`.
     */
    E | Types["error"],
    /**
     * `R` is untouched, plus whatever the plan itself needs.
     *
     * It used to be `Exclude<R, Types["provides"]>`, which is unsound: the
     * plan is applied around `LanguageModel.generateText` and nothing wider,
     * while toolkit resolution, context transforms, permission evaluation and
     * tool handlers all run outside it. A service the plan's layer happens to
     * provide was struck from the session's requirement even though it is not
     * available where the rest of the agent uses it.
     */
    R | Types["requirements"],
    /**
     * Recomputed from the model requirement itself, not subtracted from the
     * residual.
     *
     * `Exclude<Model, provides>` compounds: a first plan providing
     * `LanguageModel` makes `Model` `never`, and a *second* plan that provides
     * no model then computes `Exclude<never, ...>`, which is still `never`.
     * The agent then requires no ambient model and its plan supplies none, so
     * the call fails at runtime with the types saying everything is fine.
     *
     * A plan is a replacement rather than an accumulation, and the requirement
     * before any plan is always the same thing -- an ambient `LanguageModel` --
     * so the answer can be recomputed from that constant every time.
     */
    Exclude<LanguageModel.LanguageModel, Types["provides"]>,
    Value,
    Input
  >
    /**
     * R28 -- the plan's predicates are handed the *model call's* failures.
     *
     * `Effect.withExecutionPlan` requires the wrapped effect's error to extend
     * the plan's `input`, because that is what `while` and the schedules
     * receive. This combinator accepted any `input` at all and then applied
     * the plan to `LanguageModel.generateText`, so a plan whose `while`
     * assumed some narrower, unrelated error shape was handed an `AiError` at
     * runtime with the callback's static type insisting otherwise.
     *
     * Stated as a conditional on the *return* type rather than a constraint on
     * the parameter, because a constraint there destroys the inference that
     * makes `ExecutionPlan.make(...)` assignable at all -- and the message a
     * caller gets is the one below, at the point of use, rather than a
     * mismatch buried in the plan's type.
     */
    : "This execution plan's `input` does not accept the model call's AiError,"
      & "so its `while` and schedules would be handed a failure they do not describe." =>
    // `as never`, and it is in the cast inventory rather than hidden.
    //
    // The return type above is a conditional on `Plan`, which is still
    // unresolved here, so the compiler cannot reduce it and will not accept a
    // value against either branch -- `never` is the only thing assignable to
    // an unreduced conditional. The alternative is stating the constraint on
    // the parameter instead, and that was tried: it destroys the inference
    // that makes `ExecutionPlan.make(...)` assignable at all, and moves the
    // diagnostic from the call site to somewhere inside the plan's type.
    //
    // Confined to this one expression, and the value is exactly the branch the
    // condition selects: `definition` is typed, so what is returned is checked
    // even though the checker cannot be told which branch it belongs to.
    definition({ ...agent, executionPlan: Option.some(plan) }) as never

/** Replace what a denied or refused call does to the run. */
export const withToolDenialPolicy =
  (policy: ToolExecution.FailurePolicy) =>
  <Tools extends Record<string, Tool.Any>, E, R, Model, Value, Input>(
    agent: AgentDefinition<Tools, E, R, Model, Value, Input>
  ): AgentDefinition<Tools, E, R, Model, Value, Input> =>
    definition({ ...agent, toolDenialPolicy: policy })

/**
 * Declare the shape submissions are asked in (`Config.input`, pipeable).
 *
 * Replaces any input already declared, and changes the agent's `Input` --
 * which is why it is the one combinator that discards the previous slot
 * rather than threading it.
 */
export const withInput =
  <A, I, IE = never, IR = never>(input: AgentInput.AgentInput<A, I, IE, IR>) =>
  <Tools extends Record<string, Tool.Any>, E, R, Model, Value, _Input>(
    agent: AgentDefinition<Tools, E, R, Model, Value, _Input>
  ): AgentDefinition<Tools, E | IE, R | IR, Model, Value, A> =>
    definition<Tools, E | IE, R | IR, Model, Value, A>({ ...agent, input: Option.some(input) })

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
export const run = <Tools extends Record<string, Tool.Any>, E, R, Value = never, Input = never>(
  agent: AgentDefinition<Tools, E, R, LanguageModel.LanguageModel, Value, Input>,
  input: NoInfer<AgentSession.PromptInput<Input>>,
  options?: AgentSession.PromptOptions
): Effect.Effect<
  AgentSession.Result<Tools, Value>,
  AgentSession.PromptError<Tools, E>,
  LanguageModel.LanguageModel | R
> =>
  Effect.scoped(
    Effect.flatMap(AgentSession.make(agent), (session) =>
      AgentSession.prompt(session, input, options)
    )
  )

