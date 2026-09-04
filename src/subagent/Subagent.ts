import { Effect, Layer, Option, Schema } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import type { AgentDefinition } from "../Agent.js"
import * as InputBoundary from "../internal/inputBoundary.js"
import * as InternalToolkit from "../internal/toolkit.js"

/**
 * Subagents (issue #4 item 4): ergonomics for the pattern the library already
 * has, not a new concept.
 *
 * The design position is deliberate -- "a subagent is a tool that opens a
 * child session" -- and the pieces compose without any core support: a tool
 * handler makes an `AgentSession` and prompts it. What it does *not* compose
 * is cheaply. The raw form is a `Tool.make`, a `Toolkit`, a `toLayer`, an
 * `Effect.scoped`, an `Effect.provide` for the child's model and an
 * `Effect.gen` that threads a session -- a dozen lines to say "delegate this
 * question to that agent." `Subagent.tool` is that dozen lines, once.
 *
 * It changes nothing about the engine. What it returns is an ordinary
 * `Agent.BoundTool`, so it drops into `Agent.make({ tools: [...] })` beside
 * hand-written tools and composes with permissions, loops and everything else
 * exactly as they do. Two properties come for free from the structured
 * pieces underneath and are worth stating:
 *
 * - **Isolation.** The child runs under its own model layer, supplied here and
 *   nowhere else, so parent and child never share a conversation. A cheaper
 *   model for a narrow subtask is one layer argument.
 * - **Interruption.** The child session is opened inside the handler's scope,
 *   which is the parent submission's scope. Interrupting the parent interrupts
 *   the child through ordinary structured concurrency -- no cancellation
 *   protocol crosses the boundary.
 *
 * A child *failure* -- a typed error on the child run's error channel -- is
 * returned to the parent model as a string on the tool's `failure` channel,
 * not raised as a defect: "the researcher could not find it" is something the
 * parent can read and route around, the same choice the coding toolkit makes.
 * Pass `onError: "die"` when a child failure should instead fail the parent
 * run.
 *
 * A child *defect* is still a defect, under either setting, and it kills the
 * parent run. That is deliberate rather than an omission. `onError` is about
 * what an *answer* looks like when the child could not produce one, and a
 * defect is not an answer -- it is a bug in the child's tools or wiring, with
 * no reason to believe the child is in a state to be asked anything else.
 * Widening `"return"` to swallow defects would hand the parent model a string
 * to reason about and leave the bug unreported, which is the one outcome worse
 * than the run failing. A child that has a recoverable failure mode should say
 * so on its error channel, which is what makes it recoverable.
 */

/** The tool a subagent presents to the parent model: one prompt in, its answer out. */
export interface SubagentParams {
  readonly prompt: string
}

const Parameters = Schema.Struct({
  /** The task or question to hand to the subagent, in natural language. */
  prompt: Schema.String
})

/**
 * What the parent model fills in to delegate: `{ prompt }` for a child asked
 * with a prompt, or the child's own input schema when it declares an
 * `AgentInput` -- the parent model then writes the value, and the child
 * renders it as it would for any other caller. The schema must describe an
 * object, as every tool's parameters must.
 */
const parametersOf = (declared: InputBoundary.Declared): Schema.Codec<unknown, unknown> =>
  Option.match(declared, {
    onNone: (): Schema.Codec<unknown, unknown> => Parameters,
    onSome: (input): Schema.Codec<unknown, unknown> => input.schema
  })

/**
 * The child, asked with what the tool decoded: the value itself for a
 * typed child, the `prompt` field otherwise -- the two shapes
 * `parametersOf` declares, so the reads here are exact.
 */
const askChild = <Tools extends Record<string, Tool.Any>, E, R, Value, Input>(
  agent: AgentDefinition<Tools, E, R, LanguageModel.LanguageModel, Value, Input>,
  params: unknown
) =>
  Agent.run(
    agent,
    InputBoundary.asked<Input>(
      Option.isSome(agent.input) ? params : (params as SubagentParams).prompt
    )
  )

/** How a child failure reaches the parent. Defects are not covered: see the module doc. */
export type OnError =
  /** Return the child's failure to the parent model as a string it can act on. Default. */
  | "return"
  /** Turn a child failure into a defect that fails the parent run. */
  | "die"

export interface Options<R, LE = never> {
  /**
   * What the subagent is for, written for the parent model. This is the only
   * thing the parent knows about the child -- make it a capability
   * description ("Research a question using web search and return findings"),
   * not an implementation note.
   */
  readonly description: string
  /**
   * The child's world: its model, and any services its tools or policy need.
   * Supplied here and nowhere else, which is exactly what keeps the child's
   * conversation and the parent's apart. `R` is the child agent's own
   * requirement, so the compiler holds you to providing everything it needs.
   *
   * The layer may fail to build (`LE`) -- reading an API key from config, say.
   * That failure is treated exactly like a child failure: returned to the
   * parent as a string, or turned into a defect under `onError: "die"`.
   */
  readonly provide: Layer.Layer<LanguageModel.LanguageModel | R, LE>
  /** What a child failure does. Defaults to `"return"`. */
  readonly onError?: OnError | undefined
}

const describeError = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    if ("message" in error && typeof error.message === "string") {
      return error.message
    }
    if ("_tag" in error && typeof error._tag === "string") {
      return error._tag
    }
  }
  return String(error)
}

/**
 * A child's approval-requiring tools, if its toolkit can be read now.
 *
 * Nobody can answer an approval a delegated agent asks for. A tool marked
 * `needsApproval` asks through the session's elicitation seam, and the child
 * is opened with `Agent.run`, which has no elicitor: the parent's is not
 * passed down and nothing else supplies one, so the request is refused and
 * the tool never runs. The child's policy does not decide it -- `allowAll`
 * changes nothing -- which is what separates this from an ordinary denial.
 * Marking a tool as needing approval *disables* it, and the only report is a
 * string the parent model reads three delegations in.
 *
 * So it is refused here instead, before the agent starts, the way
 * `Agent.make` refuses two toolkits. That is a decision about *when* the
 * fault is reported and deliberately not about what the answer should be:
 * forwarding the parent's elicitor is the obvious fix and has a real question
 * inside it -- the parent's user is asked to approve a tool call from an agent
 * they cannot see, named by a tool they did not choose. Until that is
 * decided, loud beats silent.
 *
 * A `needsApproval` given as a function counts. It may ask, and nobody could
 * answer it either; deciding at construction that it never will would need
 * the parameters.
 *
 * A toolkit resolved per turn from runtime state declares nothing before it
 * runs, so that child cannot be checked here and keeps the runtime refusal;
 * the doc on `tool` says so. Everything built from a static list --
 * `tools: [...]`, `Agent.toolkit`, `withTools`, the presets -- declares.
 */
const unapprovable = (agent: { readonly toolkit: Agent.ToolkitInput<any, any, any> }): ReadonlyArray<string> =>
  Option.match(InternalToolkit.declaredTools(agent.toolkit), {
    onNone: () => [],
    onSome: (tools: Readonly<Record<string, Tool.Any>>) =>
      Object.values(tools)
        .filter((tool) => tool.needsApproval !== undefined && tool.needsApproval !== false)
        .map((tool) => tool.name)
  })

const refuseUnapprovable = (name: string, agent: { readonly toolkit: Agent.ToolkitInput<any, any, any> }): void => {
  const names = unapprovable(agent)
  if (names.length > 0) {
    throw new Error(
      `Subagent "${name}": the child holds ${names.length === 1 ? "a tool" : "tools"} marked needsApproval ` +
        `(${names.map((n) => `"${n}"`).join(", ")}) and nobody can answer for a delegated agent, ` +
        `so ${names.length === 1 ? "it" : "they"} would be refused on every call. ` +
        `Drop the annotation on the child's tool, or wrap it in a tool of the parent's that asks instead.`
    )
  }
}

/**
 * A tool that delegates one prompt to a child agent and returns its answer.
 *
 * ```ts
 * const research = Subagent.tool("research", Researcher, {
 *   description: "Research a question and return a short findings summary.",
 *   provide: OpenAiLanguageModel.model("gpt-4o-mini")
 * })
 *
 * const Lead = Agent.make({
 *   instructions: "Delegate research, then decide.",
 *   tools: [research]
 * })
 * ```
 *
 * The result is an `Agent.BoundTool` with no residual requirements: the child
 * agent's `LanguageModel | R` is discharged by `options.provide` inside the
 * handler, so nothing leaks up to the parent's wiring. Add it to any agent's
 * `tools`, alongside ordinary tools. A policy can gate it by tool name -- it
 * carries no action/resource projection, since a delegated prompt has no
 * natural resource to project (unlike a file path or a shell command).
 *
 * **`provide` is built per delegation.** `Effect.provide` runs inside the
 * handler, so two `research` calls in one parent run build the child's layer
 * twice and tear it down twice. That is what keeps this function pure -- it
 * returns a plain `BoundTool`, with no scope to own the built services and no
 * `Effect` for the caller to run. For a cheap layer (a model client the
 * provider already memoises) it costs nothing; for one that opens a connection
 * pool or reads config it is the whole cost of delegating. Use
 * {@link toolScoped} there, which builds once and shares.
 *
 * **A child whose tools need approval is refused here**, by throwing, the
 * way `Agent.make` refuses a misconfigured agent. Nobody can answer an
 * approval a delegated agent asks for -- the child has no elicitor -- so a
 * tool marked `needsApproval` would be refused on every call and the only
 * report would be a string in the parent model's context. Better a wiring
 * fault before the agent starts. The one child this cannot inspect is one
 * whose toolkit is resolved per turn from runtime state and so declares no
 * tools up front; that child keeps the runtime refusal. **That includes a
 * child whose tools come from an MCP server** (`McpToolkit.bind`,
 * `ToolSource.bind`): the listing is remote, and the server's
 * `requiresApproval` annotation becomes `needsApproval` only at bind time,
 * so there is nothing to read here and the annotation is where approval
 * requirements most often come from. Such a child's annotated tools are
 * still dead until B's second half forwards an elicitor.
 */
export const tool = <Tools extends Record<string, Tool.Any>, E, R, Value, Input, LE = never>(
  name: string,
  agent: AgentDefinition<Tools, E, R, LanguageModel.LanguageModel, Value, Input>,
  options: Options<R, LE>
) => {
  refuseUnapprovable(name, agent)
  const definition = Tool.make(name, {
    description: options.description,
    parameters: parametersOf(agent.input),
    success: Schema.String,
    failure: Schema.String
  })

  const run = (params: unknown) =>
    askChild(agent, params).pipe(
      Effect.map((result) => result.text),
      // The child's `LanguageModel | R` is discharged here and only here, so
      // the tool carries no requirement of its own and parent and child never
      // share a context.
      Effect.provide(options.provide)
    )

  const handler: Agent.Handler<typeof definition> = (params) =>
    options.onError === "die"
      ? run(params).pipe(Effect.orDie)
      : run(params).pipe(Effect.mapError(describeError))

  return Agent.tool(definition, handler)
}

/**
 * {@link tool}, with the child's layer built once and shared by every
 * delegation.
 *
 * Same tool, same isolation, same interruption story; the difference is where
 * `options.provide` is built. Here it is built at construction, into the
 * `Scope` this effect asks for, and every call is given the resulting services
 * directly. N delegations, one build.
 *
 * ```ts
 * const lead = Effect.gen(function*() {
 *   const research = yield* Subagent.toolScoped("research", Researcher, {
 *     description: "Research a question and return a short findings summary.",
 *     provide: ExpensiveClient.layer
 *   })
 *   return Agent.make({ instructions: "Delegate research.", tools: [research] })
 * })
 * ```
 *
 * Two consequences follow from building early, and both are the point rather
 * than a caveat.
 *
 * The layer's own failure (`LE`) is reported *here*, when the tool is built,
 * instead of reaching the parent model as a string on the first delegation.
 * A missing API key is a wiring fault, and finding it before the agent starts
 * is better than finding it in the middle of a run -- so `onError` no longer
 * has anything to say about it, and covers only child run failures.
 *
 * The child's services live as long as the scope, not as long as a call. That
 * is why this is a separate function and not a flag: the caller has to choose
 * that lifetime, and scoping is how Effect asks them to.
 */
export const toolScoped = <Tools extends Record<string, Tool.Any>, E, R, Value, Input, LE = never>(
  name: string,
  agent: AgentDefinition<Tools, E, R, LanguageModel.LanguageModel, Value, Input>,
  options: Options<R, LE>
) =>
  // The same refusal as `tool`, and before the layer is built: a wiring
  // fault should not cost a connection pool to discover.
  Effect.suspend(() => {
    refuseUnapprovable(name, agent)
    return Layer.build(options.provide)
  }).pipe(Effect.map((services) => {
    const definition = Tool.make(name, {
      description: options.description,
      parameters: parametersOf(agent.input),
      success: Schema.String,
      failure: Schema.String
    })

    const run = (params: unknown) =>
      askChild(agent, params).pipe(
        Effect.map((result) => result.text),
        // The already-built services, not the layer: this is the whole
        // difference from `tool`. The child's `LanguageModel | R` is still
        // discharged here and only here, so parent and child share no context.
        Effect.provideContext(services)
      )

    const handler: Agent.Handler<typeof definition> = (params) =>
      options.onError === "die"
        ? run(params).pipe(Effect.orDie)
        : run(params).pipe(Effect.mapError(describeError))

    return Agent.tool(definition, handler)
  }))
