import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as WireValue from "./internal/wireValue.js"

/**
 * A typed value a submission is expected to end with.
 *
 * The kernel does not own structured output — `PLAN.md` §1 lists it among the
 * things Effect AI already provides, and `LanguageModel.generateObject` remains
 * the right call for a chain that is not agentic. What was missing is the
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
export interface AgentOutput<A, I> {
  /** The tool the model calls. Its name is model-facing, so it is chosen. */
  readonly toolName: string
  readonly schema: Schema.Codec<A, I>
  /**
   * The tool itself, built once here so every authoring path shares one
   * definition rather than re-deriving it per turn.
   */
  readonly tool: Tool.Any
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
    })
  }
}

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
