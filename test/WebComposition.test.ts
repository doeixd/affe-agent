import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Ref } from "effect"
import type { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { CodingToolkit } from "../src/coding/index.js"
import * as Permission from "../src/Permission.js"
import * as Sandbox from "../src/sandbox/Sandbox.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { TestLanguageModel, TestWebSearch } from "../src/testing/index.js"
import { WebSearch, WebToolkit } from "../src/web/index.js"

type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T
type Not<T extends boolean> = T extends true ? false : true
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2) ? true : false

type Handler = typeof WebToolkit.handlers.web_search
type Params = Parameters<Handler>[0]
type Result = Effect.Success<ReturnType<Handler>>
type Requirements = Effect.Services<ReturnType<Handler>>
type AgentRequirements<T> = T extends Agent.AgentDefinition<infer _Tools, infer _Error, infer R>
  ? R
  : never
type Includes<All, One> = [One] extends [All] ? true : false

export type _ParamsNotAny = Assert<Not<IsAny<Params>>>
export type _QueryIsString = Assert<Equal<Params["query"], string>>
export type _LimitIsOptional = Assert<Equal<Params["limit"], number | undefined>>
export type _ResultNotAny = Assert<Not<IsAny<Result>>>
export type _HandlerRequiresWebSearch = Assert<Equal<Requirements, WebSearch.WebSearch>>
export type _ToolRequiresWebSearch = Assert<
  Equal<Tool.HandlerServices<typeof WebToolkit.Search>, WebSearch.WebSearch>
>

const Coder = Agent.make({ toolkit: CodingToolkit.toolkit() }).pipe(
  Agent.withTool(WebToolkit.search)
)
const Researcher = Agent.make({}).pipe(Agent.withTool(WebToolkit.search))

export type _CoderRequiresWebSearch = Assert<
  Includes<AgentRequirements<typeof Coder>, WebSearch.WebSearch>
>
export type _CoderStillRequiresSandbox = Assert<
  Includes<AgentRequirements<typeof Coder>, Sandbox.Current>
>
export type _ResearcherRequiresOnlySearch = Assert<
  Equal<AgentRequirements<typeof Researcher>, WebSearch.WebSearch>
>

const sources = [
  {
    title: "Effect",
    url: "https://effect.website/",
    snippet: "The Effect documentation."
  }
] as const

describe("WebToolkit composition", () => {
  it("projects the exact outbound query for permission", () => {
    const projection = Permission.projectionOf(WebToolkit.Search)
    assert.strictEqual(projection.action, "net.search")
    assert.strictEqual(
      projection.resource({ query: "Effect HTTP client", limit: 8 }),
      "Effect HTTP client"
    )
  })

  it.effect("the canned provider runs the ordinary handler", () =>
    Effect.gen(function* () {
      const result = yield* WebToolkit.handlers.web_search(
        { query: "Effect", freshness: "month" },
        { preliminary: () => Effect.void }
      ).pipe(Effect.provide(TestWebSearch.layer(sources)))

      assert.deepStrictEqual(result, sources)
    })
  )

  it.effect("maps a provider authentication failure to actionable model text", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        WebToolkit.handlers.web_search(
          { query: "Effect" },
          { preliminary: () => Effect.void }
        ).pipe(
          Effect.provide(
            WebSearch.layer({
              search: () =>
                Effect.fail(new WebSearch.WebSearchAuthenticationError({ status: 401 }))
            })
          )
        )
      )
      assert.include(failure, "misconfigured")
      assert.include(failure, "Do not retry")
    })
  )

  it.effect("an allowed call reaches the provider once and its sources reach the model", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const provider = WebSearch.layer({
        search: () => Ref.updateAndGet(calls, (n) => n + 1).pipe(Effect.as(sources))
      })
      const agent = Agent.make({
        toolkit: WebToolkit.toolkit(),
        loop: AgentLoop.bounded(4),
        permission: Permission.allowAll
      })
      const { layer: model, recorder } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall("web_search", { query: "Effect" }, { id: "s1" }),
        TestLanguageModel.text("found it")
      ])

      const result = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(agent), (session) => session.prompt("search"))
      ).pipe(Effect.provide(Layer.merge(model, provider)))

      assert.strictEqual(result.text, "found it")
      assert.strictEqual(yield* Ref.get(calls), 1)
      assert.include(JSON.stringify(yield* recorder.prompts), "https://effect.website/")
    })
  )

  it.effect("a denied call never reaches the provider", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const provider = WebSearch.layer({
        search: () => Ref.updateAndGet(calls, (n) => n + 1).pipe(Effect.as(sources))
      })
      const agent = Agent.make({
        toolkit: WebToolkit.toolkit(),
        loop: AgentLoop.bounded(4),
        permission: Permission.denyAll
      })
      const { layer: model } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall("web_search", { query: "private topic" }, { id: "s1" })
      ])

      const exit = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(agent), (session) => session.prompt("search"))
      ).pipe(Effect.provide(Layer.merge(model, provider)), Effect.exit)

      assert.isTrue(Exit.isFailure(exit))
      assert.strictEqual(yield* Ref.get(calls), 0)
    })
  )

  it.effect("Ask records one semantic request before any provider can run", () =>
    Effect.gen(function* () {
      const evaluations = yield* Ref.make(0)
      const decided = yield* ToolExecution.decide(
        WebToolkit.Search,
        { id: "s1", name: "web_search", params: { query: "sensitive query" } },
        {
          sessionId: "session-1",
          messages: [],
          permission: Permission.make((request) =>
            Ref.updateAndGet(evaluations, (n) => n + 1).pipe(
              Effect.as(Permission.ask(`sending ${request.resource}`))
            ))
        }
      )

      assert.strictEqual(decided.decision._tag, "Ask")
      assert.strictEqual(decided.request.action, "net.search")
      assert.strictEqual(decided.request.resource, "sensitive query")
      assert.strictEqual(yield* Ref.get(evaluations), 1)
    })
  )

  it("composes search with coding and independently with a research agent", () => {
    assert.isDefined(Coder)
    assert.isDefined(Researcher)
  })
})
