import { Effect, Layer, Schema } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import type { AgentDefinition } from "../Agent.js"

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
 * A child failure is returned to the parent model as a string on the tool's
 * `failure` channel, not raised as a defect: "the researcher could not find
 * it" is something the parent can read and route around, the same choice the
 * coding toolkit makes. Pass `onError: "die"` when a child failure should
 * instead fail the parent run.
 */

/** The tool a subagent presents to the parent model: one prompt in, its answer out. */
export interface SubagentParams {
  readonly prompt: string
}

const Parameters = Schema.Struct({
  /** The task or question to hand to the subagent, in natural language. */
  prompt: Schema.String
})

/** How a child failure reaches the parent. */
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
 */
export const tool = <Tools extends Record<string, Tool.Any>, E, R, LE = never>(
  name: string,
  agent: AgentDefinition<Tools, E, R>,
  options: Options<R, LE>
) => {
  const definition = Tool.make(name, {
    description: options.description,
    parameters: Parameters,
    success: Schema.String,
    failure: Schema.String
  })

  const run = ({ prompt }: SubagentParams) =>
    Agent.run(agent, prompt).pipe(
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
