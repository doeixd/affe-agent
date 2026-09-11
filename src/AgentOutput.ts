import { Effect, Option, Schema } from "effect"
import { dual } from "effect/Function"
import type { Pipeable } from "effect/Pipeable"
import { pipeArguments } from "effect/Pipeable"
import { Tool } from "effect/unstable/ai"
import * as WireValue from "./internal/wireValue.js"
import * as ToolExecution from "./ToolExecution.js"

/**
 * A typed value a submission is expected to end with.
 *
 * The kernel does not own structured output — it is among the things Effect
 * AI already provides, and `LanguageModel.generateObject` remains the right
 * call for a chain that is not agentic. What was missing is the
 * *agentic* case: a run that uses tools, takes steering and follow-ups, and
 * must still end with something better than a string. Dropping to
 * `generateObject` there means giving up the session; routing the value through
 * an `AgentData` channel means the shape is a convention between a tool and its
 * reader rather than a property of the agent.
 *
 * So an output is **a tool the model calls to report its answer**, not a second
 * kind of model call. That choice is what makes everything else fall out:
 *
 * - the value is what the model actually produced, validated against the
 *   schema by the provider and decoded by the toolkit — not a re-reading of
 *   the transcript by a second call that can drift from it;
 * - it costs no extra model call, and no extra billing;
 * - it lands in canonical history as an ordinary tool call and result, so the
 *   answer is auditable, replayable and durable exactly as every other call
 *   is. Note the scope of that claim: it is the *call* that crosses those
 *   boundaries. `Result.value` is a local-session convenience, and neither
 *   `AgentClient`'s `RemoteResult` nor `DurableSubmission`'s `Outcome` carries
 *   it -- a remote or durable caller reads the answer out of history. Carrying
 *   it would mean deciding how a client names the schema to decode it with,
 *   which is a second feature rather than a field;
 * - permission, failure policy, streaming and `ExecutionPlan` need to know
 *   nothing about it -- which cuts both ways: a `Permission` policy that
 *   denies by default denies this tool too, and must allow it by name
 *   (`{ tool: output.toolName, decision: Permission.allow }`).
 *
 * The alternative — one `generateObject` over the finished history after the
 * loop goes idle — was rejected for the first two reasons. A result no turn
 * produced is not a result this kernel can claim history explains.
 *
 * Declared on the `Agent` rather than passed per `prompt`, because an agent
 * that must answer in a shape is *defined* by that shape: its instructions and
 * its schema are written together, and splitting them across two call sites
 * invites an agent told merely to "answer" being handed a schema it was never
 * prompted for. `stream` is per-prompt because it is a delivery concern; this
 * is a contract.
 */
export interface AgentOutput<A, I> extends Pipeable {
  /** The tool the model calls. Its name is model-facing, so it is chosen. */
  readonly toolName: string
  readonly schema: Schema.Codec<A, I>
  /**
   * The tool itself, built once here so every authoring path shares one
   * definition rather than re-deriving it per turn.
   */
  readonly tool: Tool.Any
  /**
   * Ordinary tools whose committed results can *be* the answer, without the
   * model reporting it. Empty unless `fromTool` added some. See `fromTool`.
   */
  readonly projections: ReadonlyArray<Projection<A>>
}

/** What a projection is given: the call's decoded parameters and the tool's decoded success. */
export interface ProjectionInput<T extends Tool.Any> {
  readonly params: Tool.Parameters<T>
  readonly result: Tool.Success<T>
}

/**
 * The compile error a projector returning something other than the output's
 * value type produces: its fields name what was returned and what was needed.
 */
export interface ProjectionDoesNotMatchOutput<Returned, Expected> {
  readonly "the projector returns": Returned
  readonly "but the output needs": Expected
}

/**
 * What `fromTool` reports, as a type error, for a provider-defined tool (plan
 * Q4): its result is shaped by the provider, and an answer must come from a
 * result the host controls.
 */
export interface ProviderDefinedToolCannotProject<Name> {
  readonly "a provider-defined tool cannot complete the submission": Name
}

type Projectable<T extends Tool.Any> = T extends { readonly [Tool.ProviderDefinedTypeId]: unknown }
  ? ProviderDefinedToolCannotProject<T["name"]>
  : unknown

/**
 * One tool whose successful result can complete the submission. The types are
 * checked where `fromTool` builds it; here the input is erased, because an
 * output holds projections for many tools.
 */
export interface Projection<A> {
  readonly tool: Tool.Any
  readonly project: (input: { readonly params: unknown; readonly result: unknown }) => Option.Option<A>
}

/**
 * Describe the shape a submission must end in.
 *
 * ```ts
 * const Quality = AgentOutput.make(Schema.Struct({
 *   hasCallToAction: Schema.Boolean,
 *   clarity: Schema.Number
 * }))
 * ```
 *
 * The schema is the tool's parameter schema, so it must be one a provider can
 * accept there: in practice a struct, since every provider requires a JSON
 * object at the top level of a tool's parameters. A bare `Schema.Number` is
 * accepted by the types and rejected by the provider, which is the provider's
 * rule to state rather than one to re-encode here.
 *
 * Decoding services are `never` by design. A schema that needs a service to
 * decode would make the value's availability depend on the environment at the
 * moment a tool call lands, which is not a dependency an output contract
 * should be able to introduce.
 */
export const make = <A, I>(
  schema: Schema.Codec<A, I>,
  options?: {
    /**
     * The model-facing tool name. Defaults to `submit_output`.
     *
     * Worth setting: the name is one of the few things the model reads when
     * deciding *whether* this is the tool it wants, and `record_evaluation`
     * says more than `submit_output` does.
     */
    readonly name?: string | undefined
    /** The model-facing description. Defaults to a generic instruction. */
    readonly description?: string | undefined
  }
): AgentOutput<A, I> => {
  const toolName = options?.name ?? "submit_output"
  return {
    toolName,
    schema,
    tool: Tool.make(toolName, {
      description: options?.description ??
        "Report your final answer in the required shape. Call this exactly once," +
          " when you have finished. The run ends when you do.",
      parameters: schema,
      // A string rather than void: a tool result is committed to history, and
      // an empty one reads to a later turn as a call that did nothing.
      success: Schema.String
    // The answer ends the run, so an action beside it in the same response is
    // a protocol violation rather than work to do first: the whole batch is
    // rejected before any of it runs, and the model tries again.
    }).annotate(ToolExecution.Alone, true),
    projections: [],
    pipe() {
      return pipeArguments(this, arguments)
    }
  }
}

/**
 * Let an ordinary tool's successful result complete the submission (item 92).
 *
 * ```ts
 * const Created = AgentOutput.make(Schema.Struct({ projectId: Schema.String, url: Schema.String })).pipe(
 *   AgentOutput.fromTool(CreateProject, ({ result }) =>
 *     result.created ? Option.some({ projectId: result.id, url: result.href }) : Option.none()
 *   )
 * )
 * ```
 *
 * "Create the project and give me its URL" used to cost a second model call:
 * the tool returned `{ id, href }`, and the model was asked again only to copy
 * them into the output tool -- where it could also miscopy an id. Now, once a
 * turn commits, each successful result of a projecting tool is offered to its
 * projector; `Some(value)` is the submission's answer and the run stops, as
 * if the model had reported it. `None` continues the run normally.
 *
 * The rules, and why:
 *
 * - **Only committed successes.** A failed result, one returned to the model,
 *   or one from a rolled-back turn is never projected: the answer must be
 *   something that happened.
 * - **Pure.** The projector sees only the call's parameters and the tool's
 *   result, and returns an `Option`. A durable replay re-runs it over the
 *   journalled result, so it must not read the clock or anything else. A
 *   projector that throws is a defect, not a quiet `None`.
 * - **Checked against the output schema**, as a model-reported value is; one
 *   that does not encode is a defect in the projector (the model cannot fix
 *   it).
 * - **First in the response wins** when several projecting tools succeed in
 *   one turn; a value the model reported through the output tool wins over
 *   all of them (it cannot share a turn with them anyway -- it is `Alone`).
 *
 * The model-called output tool remains the general case; this is for agents
 * whose actions already produce the answer.
 */
export const fromTool: {
  /**
   * Pipeable. The projector's value type `R` is inferred on its own and then
   * required to be an `A` of the output it is applied to -- inferring `A`
   * from the projector instead let one that returned too little widen the
   * whole output's type, silently, which is the one thing an output's type
   * must never do.
   */
  <T extends Tool.Any, R>(
    tool: T & Projectable<T>,
    project: (input: ProjectionInput<T>) => Option.Option<R>
  ): <A, I>(self: AgentOutput<A, I> & ([R] extends [A] ? unknown : ProjectionDoesNotMatchOutput<R, A>)) => AgentOutput<A, I>
  <A, I, T extends Tool.Any>(
    self: AgentOutput<A, I>,
    tool: T & Projectable<T>,
    project: (input: ProjectionInput<T>) => Option.Option<A>
  ): AgentOutput<A, I>
} = dual(
  3,
  <A, I, T extends Tool.Any>(
    self: AgentOutput<A, I>,
    tool: T,
    project: (input: ProjectionInput<T>) => Option.Option<A>
  ): AgentOutput<A, I> => {
    // The type refuses it; this catches a tool whose type was widened to
    // `Tool.Any` on the way in.
    if (Tool.isProviderDefined(tool)) {
      throw new TypeError(
        `AgentOutput.fromTool: "${tool.name}" is provider-defined; its result is shaped by the provider, so it cannot complete the submission`
      )
    }
    return projecting(self, tool, project)
  }
)

const projecting = <A, I, T extends Tool.Any>(
  self: AgentOutput<A, I>,
  tool: T,
  project: (input: ProjectionInput<T>) => Option.Option<A>
): AgentOutput<A, I> => ({
  ...self,
  projections: [
    ...self.projections,
    {
      tool,
      // Erased for storage; `AgentTurn` decodes `params` and `result` with
      // this same tool's schemas before calling it.
      project: project as (input: { readonly params: unknown; readonly result: unknown }) => Option.Option<A>
    }
  ]
})

/**
 * The value, in the shape a wire can carry.
 *
 * The mirror of `AgentInput.encode`, and it dies on failure for the same
 * reason that one does: the value came *from* this agent's own run, checked
 * against this agent's own schema, so a value that will not encode is a bug
 * here rather than something a caller could act on.
 */
export const encode = <A, I>(output: AgentOutput<A, I>, value: A): Effect.Effect<unknown> =>
  WireValue.encode(output.schema, value)

/**
 * The value, read back at the far end of a wire.
 *
 * This one *fails*, where `encode` dies, and the asymmetry is the point. A
 * value that does not decode means the thing that answered is not the agent
 * this caller thinks it is -- a different version, a different agent behind
 * the same id -- which is a fact about the far end and not a local defect.
 * `AgentA2A.typed` draws the same line, attributing a bad result to the peer.
 */
export const decode = <A, I>(
  output: AgentOutput<A, I>,
  encoded: unknown
): Effect.Effect<A, Schema.SchemaError> => WireValue.decode(output.schema, encoded)
