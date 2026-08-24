import { Effect, Layer } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import { CodingToolkit } from "../src/coding/index.js"
import * as MemorySandbox from "../src/sandbox/memory.js"
import * as Sandbox from "../src/sandbox/Sandbox.js"
import { TestWebSearch } from "../src/testing/index.js"
import { WebToolkit } from "../src/web/index.js"

/**
 * `/web` is a separate battery: the coding agent has filesystem/process and
 * search capabilities, while the researcher receives search and nothing else.
 * Neither composition needs casts or hand-annotated handler parameters.
 */
const Coder = Agent.make({
  instructions: "Work in the repository and verify unfamiliar APIs against current sources.",
  toolkit: CodingToolkit.toolkit()
}).pipe(Agent.withTool(WebToolkit.search))

const Researcher = Agent.make({
  instructions: "Research from current public sources and preserve their URLs."
}).pipe(Agent.withTool(WebToolkit.search))

const results = TestWebSearch.layer([
  {
    title: "Effect documentation",
    url: "https://effect.website/",
    snippet: "Documentation for Effect."
  }
])

const searchOnly = Effect.scoped(
  Effect.flatMap(AgentSession.make(Researcher), (session) =>
    session.prompt("Find the current Effect documentation."))
).pipe(Effect.provide(results))

const workspace = Sandbox.currentLayer(Sandbox.workspace("web-agent")).pipe(
  Layer.provide(MemorySandbox.layer({ seed: {} }))
)

const codingAndSearch = Effect.scoped(
  Effect.flatMap(AgentSession.make(Coder), (session) =>
    session.prompt("Check the current API, then update the implementation."))
).pipe(Effect.provide(Layer.merge(results, workspace)))

void searchOnly
void codingAndSearch
