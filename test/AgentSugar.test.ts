import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { LanguageModel, Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as ContextTransform from "../src/ContextTransform.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { TestLanguageModel } from "../src/testing/index.js"
import { tags, withSession } from "./helpers.js"

/**
 * Sugar lowers to the primitives and behaves identically; that is the whole
 * claim, and it is checked two ways. Type assertions prove inference stayed
 * precise (`any` would compile just as happily), and runtime comparisons
 * prove there is no sugar-specific execution branch.
 */

// --- Fixtures --------------------------------------------------------------

class SearchClient extends Context.Service<SearchClient, {
  readonly find: (query: string) => Effect.Effect<string>
}>()("test/SearchClient") {}

const Search = Tool.make("search", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String,
  dependencies: [SearchClient]
})

const Bash = Tool.make("bash", {
  parameters: Schema.Struct({ command: Schema.String }),
  success: Schema.String,
  failure: Schema.Literal("denied")
})

const ReadFile = Tool.make("read_file", {
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.String
})

// Handlers destructure with no annotation: inference from the schema.
const search = Agent.tool(Search, ({ query }) =>
  Effect.flatMap(SearchClient, (client) => client.find(query))
)
const bash = Agent.tool(Bash, ({ command }) =>
  command === "rm -rf /" ? Effect.fail("denied" as const) : Effect.succeed(`ran ${command}`)
)
const readFile = Agent.tool(ReadFile, ({ path }) => Effect.succeed(`contents of ${path}`))

const SearchLive = Layer.succeed(SearchClient, {
  find: (query) => Effect.succeed(`hits for ${query}`)
})

// --- Type assertions -------------------------------------------------------

type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

const piped = Agent.make().pipe(
  Agent.withInstructions("Be precise."),
  Agent.withTool(search),
  Agent.withTool(Bash, ({ command }) =>
    command === "rm -rf /" ? Effect.fail("denied" as const) : Effect.succeed(`ran ${command}`)
  ),
  Agent.withTools(readFile),
  Agent.withLoop(AgentLoop.bounded(4))
)

type PipedTools = typeof piped extends Agent.AgentDefinition<infer T, any, any> ? T : never
type PipedServices = typeof piped extends Agent.AgentDefinition<any, any, infer R> ? R : never

// Tool names accumulate as a literal union, never `string`.
export type _Names = Assert<Equal<keyof PipedTools, "search" | "bash" | "read_file">>
export type _NamesNotString = Assert<string extends keyof PipedTools ? false : true>
// Each entry is the exact tool, not widened.
export type _SearchExact = Assert<Equal<PipedTools["search"], typeof Search>>
export type _ToolsNotAny = Assert<IsAny<PipedTools> extends false ? true : false>
// A tool's declared dependencies become the agent's requirements.
export type _RequiresSearchClient = Assert<SearchClient extends PipedServices ? true : false>

// `run` is the scoped session prompt, channel for channel.
type RunEffect = ReturnType<typeof Agent.run<PipedTools, never, PipedServices>>
type RunErr = RunEffect extends Effect.Effect<any, infer E, any> ? E : never
type RunReq = RunEffect extends Effect.Effect<any, any, infer R> ? R : never
type RunOk = RunEffect extends Effect.Effect<infer A, any, any> ? A : never
export type _RunRequiresModelAndServices = Assert<
  Equal<RunReq, LanguageModel.LanguageModel | SearchClient>
>
// The bash tool's declared failure is catchable by the caller of `run`.
export type _RunErrorCarriesToolFailure = Assert<"denied" extends RunErr ? true : false>
export type _RunErrorNotUnknown = Assert<unknown extends RunErr ? false : true>
export type _RunResultIsResult = Assert<Equal<RunOk, AgentSession.Result<PipedTools>>>

// Object style and pipe style expose the same public type.
const objectStyle = Agent.make({
  instructions: "Be precise.",
  tools: [search, bash, readFile],
  loop: AgentLoop.bounded(4)
})
type ObjectTools = typeof objectStyle extends Agent.AgentDefinition<infer T, any, any> ? T : never
export type _ObjectPipeEquivalent = Assert<Equal<keyof ObjectTools, keyof PipedTools>>

// An explicit toolkit bound in bulk agrees with the bound-tool form.
const bulk = Agent.make({
  toolkit: Agent.toolkit([Search, Bash, ReadFile], {
    search: search.handler,
    bash: bash.handler,
    read_file: readFile.handler
  }),
  loop: AgentLoop.bounded(4)
})
type BulkTools = typeof bulk extends Agent.AgentDefinition<infer T, any, any> ? T : never
export type _BulkEquivalent = Assert<Equal<keyof BulkTools, keyof PipedTools>>

// Loop and transform errors/requirements accumulate through the combinators.
class Flag extends Context.Service<Flag, { readonly on: boolean }>()("test/Flag") {}
const withTransformAndLoop = Agent.make().pipe(
  Agent.withContextTransform(
    ContextTransform.instructions(Effect.map(Flag, (flag) => (flag.on ? "on" : "off")))
  ),
  Agent.withLoop((state) =>
    state.turnIndex > 100 ? Effect.fail("too long" as const) : Effect.succeed(AgentLoop.Stop)
  )
)
type TLErr = typeof withTransformAndLoop extends Agent.AgentDefinition<any, infer E, any> ? E : never
type TLReq = typeof withTransformAndLoop extends Agent.AgentDefinition<any, any, infer R> ? R : never
export type _TransformRequirementAccumulates = Assert<Equal<TLReq, Flag>>
export type _LoopErrorAccumulates = Assert<Equal<TLErr, "too long">>

// --- Runtime equivalence ---------------------------------------------------

describe("Agent sugar lowers to the primitives", () => {
  it.effect("bound tools and a bulk toolkit produce the same lifecycle and history", () =>
    Effect.gen(function* () {
      const turns = [
        TestLanguageModel.toolCalls([
          { id: "b1", name: "bash", params: { command: "ls" } },
          { id: "r1", name: "read_file", params: { path: "a.ts" } }
        ]),
        TestLanguageModel.text("done")
      ]
      // Service-free tools, so the harness can run both without providing
      // anything; requirement accumulation is asserted at the type level.
      const viaSugar = Agent.make().pipe(
        Agent.withTool(bash),
        Agent.withTools(readFile),
        Agent.withLoop(AgentLoop.bounded(4))
      )
      const viaBulk = Agent.make({
        toolkit: Agent.toolkit([Bash, ReadFile], {
          bash: bash.handler,
          read_file: readFile.handler
        }),
        loop: AgentLoop.bounded(4)
      })
      const runWith = (agent: Agent.AgentDefinition<any, never, never>) =>
        withSession(turns, agent, ({ session }) => AgentSession.prompt(session, "go"))

      const sugar = yield* runWith(viaSugar)
      const explicit = yield* runWith(viaBulk)

      assert.deepStrictEqual(tags(sugar.events), tags(explicit.events))
      assert.deepStrictEqual(
        yield* AgentSession.history(sugar.session),
        yield* AgentSession.history(explicit.session)
      )
      assert.strictEqual(sugar.value.turns, explicit.value.turns)
      assert.strictEqual(sugar.value.runs, explicit.value.runs)
      assert.strictEqual(sugar.value.text, "done")
      // And the tools really ran through their bound handlers.
      const toolResults = (yield* AgentSession.history(sugar.session)).content.filter(
        (message) => message.role === "tool"
      )
      assert.strictEqual(toolResults.length, 1)
    })
  )

  it.effect("a tool failure under the bound form follows the same failure policy", () =>
    Effect.gen(function* () {
      const turns = [
        TestLanguageModel.toolCall("bash", { command: "rm -rf /" }, { id: "b1" }),
        TestLanguageModel.text("ok then")
      ]
      const failing = Agent.make().pipe(
        Agent.withTool(bash),
        Agent.withToolFailurePolicy(ToolExecution.FailRun),
        Agent.withLoop(AgentLoop.bounded(4))
      )
      const explicit = Agent.make({
        toolkit: Agent.toolkit([Bash], { bash: bash.handler }),
        toolFailurePolicy: ToolExecution.FailRun,
        loop: AgentLoop.bounded(4)
      })
      const outcome = (agent: Agent.AgentDefinition<any, never, never>) =>
        withSession(turns, agent, ({ session }) =>
          Effect.flip(AgentSession.prompt(session, "go"))
        )
      const sugar = yield* outcome(failing)
      const bulkRun = yield* outcome(explicit)
      assert.deepStrictEqual(tags(sugar.events), tags(bulkRun.events))
      assert.include(tags(sugar.events), "ToolCallFailed")
      assert.include(tags(sugar.events), "SubmissionFailed")
    })
  )

  it.effect("run is the scoped session prompt", () =>
    Effect.gen(function* () {
      const agent = Agent.make().pipe(
        Agent.withInstructions("hi"),
        Agent.withLoop(AgentLoop.bounded(2))
      )
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.text("one"),
        TestLanguageModel.text("two")
      ])
      const viaRun = yield* Agent.run(agent, "go").pipe(Effect.provide(layer))
      const viaSession = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(agent), (session) =>
          AgentSession.prompt(session, "go")
        )
      ).pipe(Effect.provide(layer))
      assert.strictEqual(viaRun.status, viaSession.status)
      assert.strictEqual(viaRun.turns, viaSession.turns)
      assert.strictEqual(viaRun.runs, viaSession.runs)
      assert.strictEqual(viaRun.text, "one")
      assert.strictEqual(viaSession.text, "two")
    })
  )

  it.effect("withContextTransform and withLoop are make({ contextTransform, loop })", () =>
    Effect.gen(function* () {
      const transform = ContextTransform.instructions(Effect.succeed("today is Tuesday"))
      const loop = AgentLoop.bounded(1)
      const sugar = Agent.make().pipe(
        Agent.withContextTransform(transform),
        Agent.withLoop(loop)
      )
      const explicit = Agent.make({ contextTransform: transform, loop })
      const turns = [TestLanguageModel.text("a"), TestLanguageModel.text("b")]

      const a = yield* withSession(turns, sugar, ({ session, recorder }) =>
        Effect.flatMap(AgentSession.prompt(session, "go"), () => recorder.prompts)
      )
      const b = yield* withSession(turns, explicit, ({ session, recorder }) =>
        Effect.flatMap(AgentSession.prompt(session, "go"), () => recorder.prompts)
      )
      assert.deepStrictEqual(a.value, b.value)
      assert.deepStrictEqual(tags(a.events), tags(b.events))
      // The transform ran per turn: the model saw the appended system line.
      const roles = a.value[0]!.content.map((m) => m.role)
      assert.include(roles, "system")
    })
  )

  it.effect("updateLoop and updateContextTransform combine with what is there", () =>
    Effect.gen(function* () {
      const base = Agent.make({
        contextTransform: ContextTransform.instructions(Effect.succeed("first")),
        loop: AgentLoop.bounded(5)
      })
      const combined = base.pipe(
        Agent.updateContextTransform((current) =>
          ContextTransform.compose(
            current,
            ContextTransform.instructions(Effect.succeed("second"))
          )
        ),
        Agent.updateLoop((current) => AgentLoop.and(current, AgentLoop.maxTurns(1)))
      )
      const turns = [TestLanguageModel.text("a"), TestLanguageModel.text("b")]
      const ran = yield* withSession(turns, combined, ({ session, recorder }) =>
        Effect.flatMap(AgentSession.prompt(session, "go"), (result) =>
          Effect.map(recorder.prompts, (prompts) => ({ result, prompts }))
        )
      )
      // maxTurns(1) combined with bounded(5): one turn.
      assert.strictEqual(ran.value.result.turns, 1)
      const systems = ran.value.prompts[0]!.content
        .filter((m) => m.role === "system")
        .map((m) => m.content)
      assert.deepStrictEqual(systems, ["first", "second"])
    })
  )

  it.effect("withTools extends a toolkit that is resolved per turn", () =>
    Effect.gen(function* () {
      // The existing toolkit stays an Effect -- dynamic capability is
      // ordinary Effect -- and the bound tool is merged into whatever it
      // resolves to, each turn.
      const dynamic = Effect.succeed(
        yield* Agent.toolkit([ReadFile], { read_file: readFile.handler })
      )
      const agent = Agent.make({ toolkit: dynamic, loop: AgentLoop.bounded(4) }).pipe(
        Agent.withTools(bash)
      )
      const turns = [
        TestLanguageModel.toolCalls([
          { id: "r1", name: "read_file", params: { path: "x" } },
          { id: "b1", name: "bash", params: { command: "ls" } }
        ]),
        TestLanguageModel.text("done")
      ]
      const ran = yield* withSession(turns, agent, ({ session }) =>
        AgentSession.prompt(session, "go")
      )
      assert.strictEqual(ran.value.text, "done")
      assert.strictEqual(tags(ran.events).filter((t) => t === "ToolCallSucceeded").length, 2)
    })
  )

  it.effect("a tool named like an Object.prototype member is not a false duplicate", () =>
    Effect.gen(function* () {
      // `"constructor" in {}` is true; the checks must look at own names.
      const Constructor = Tool.make("constructor", {
        parameters: Schema.Struct({}),
        success: Schema.String
      })
      const constructorTool = Agent.tool(Constructor, () => Effect.succeed("built"))
      const agent = Agent.make({ tools: [constructorTool] }).pipe(
        Agent.withTool(readFile),
        Agent.withLoop(AgentLoop.bounded(4))
      )
      const turns = [
        TestLanguageModel.toolCall("constructor", {}, { id: "c1" }),
        TestLanguageModel.text("done")
      ]
      const ran = yield* withSession(turns, agent, ({ session }) =>
        AgentSession.prompt(session, "go")
      )
      assert.strictEqual(ran.value.text, "done")
      assert.include(tags(ran.events), "ToolCallSucceeded")
    })
  )

  it("rejects a duplicate tool name at construction", () => {
    assert.throws(
      () => Agent.make({ tools: [bash, bash] }),
      /duplicate tool name "bash"/
    )
    assert.throws(
      () => Agent.make({ toolkit: Agent.toolkit([Bash], { bash: bash.handler }), tools: [bash] }),
      /either `toolkit` or `tools`/
    )
  })

  it.effect("a duplicate name added to an existing toolkit is a defect at resolution", () =>
    Effect.gen(function* () {
      const agent = Agent.make({ tools: [bash] }).pipe(Agent.withTool(bash))
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("x")])
      const exit = yield* Effect.exit(Agent.run(agent, "go").pipe(Effect.provide(layer)))
      assert.isTrue(exit._tag === "Failure")
    })
  )

  it("reusable bundles are ordinary functions over agents", () => {
    // Generic in the agent's channels, so the accumulated record stays
    // precise through the bundle: `A extends AgentDefinition<any, ...>`
    // would erase it to `any`.
    const coding = <Tools extends Record<string, Tool.Any>, E, R>(
      agent: Agent.AgentDefinition<Tools, E, R>
    ) => agent.pipe(Agent.withTools(readFile, bash))
    const coder = Agent.make().pipe(Agent.withInstructions("code"), coding)
    assert.deepStrictEqual(coder.instructions, Option.some("code"))
    type CoderTools = typeof coder extends Agent.AgentDefinition<infer T, any, any> ? T : never
    type _Bundle = Assert<Equal<keyof CoderTools, "read_file" | "bash">>
  })
})
