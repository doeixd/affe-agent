/**
 * Two ways to write the same agent.
 *
 * This file exists to be type-checked: the README's authoring snippets are
 * lifted from here, so a signature change breaks the build rather than
 * quietly leaving the documentation wrong.
 */
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as ContextTransform from "../src/ContextTransform.js"

const SearchTool = Tool.make("search", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String
})
const ReadFile = Tool.make("read_file", {
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.String
})

const search = (query: string) => Effect.succeed(`hits for ${query}`)
const today = Effect.sync(() => `Today is ${new Date().toDateString()}.`)

// A bound tool: an Effect AI Tool paired with its handler, and nothing more.
// `query` is inferred from the schema.
export const Search = Agent.tool(SearchTool, ({ query }) => search(query))

export const Researcher = Agent.make().pipe(
  Agent.withInstructions("Cite sources."),
  Agent.withTool(Search),
  Agent.withTool(ReadFile, ({ path }) => Effect.succeed(`contents of ${path}`)),
  Agent.withContextTransform(ContextTransform.instructions(today)),
  Agent.withLoop(AgentLoop.bounded(20))
)

// The same agent, object style.
export const Researcher2 = Agent.make({
  instructions: "Cite sources.",
  tools: [Search, Agent.tool(ReadFile, ({ path }) => Effect.succeed(`contents of ${path}`))],
  contextTransform: ContextTransform.instructions(today),
  loop: AgentLoop.bounded(20)
})

// A bundle is an ordinary function over agents, generic in the channels so
// the accumulated tool record stays precise.
export const withResearchTools = <Tools extends Record<string, Tool.Any>, E, R>(
  agent: Agent.AgentDefinition<Tools, E, R>
) => agent.pipe(Agent.withTools(Search))

// One-shot: the scoped session prompt, requirements and errors intact.
export const program = Agent.run(Researcher, "What changed in Effect 4?")

// --- Type assertions -------------------------------------------------------

type Assert<T extends true> = T
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

type Tools = typeof Researcher extends Agent.AgentDefinition<infer T, any, any> ? T : never
export type _ToolNames = Assert<Equal<keyof Tools, "search" | "read_file">>
type Tools2 = typeof Researcher2 extends Agent.AgentDefinition<infer T, any, any> ? T : never
export type _SameNames = Assert<Equal<keyof Tools2, keyof Tools>>
