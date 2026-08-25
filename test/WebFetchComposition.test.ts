import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Ref } from "effect"
import type { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Permission from "../src/Permission.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { TestLanguageModel, TestWebFetch } from "../src/testing/index.js"
import { WebFetch, WebToolkit } from "../src/web/index.js"

type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T
type Not<T extends boolean> = T extends true ? false : true
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2) ? true : false

type Handler = typeof WebToolkit.handlers.web_fetch
type Params = Parameters<Handler>[0]
type Result = Effect.Success<ReturnType<Handler>>
type Requirements = Effect.Services<ReturnType<Handler>>
type AgentRequirements<T> = T extends Agent.AgentDefinition<infer _Tools, infer _Error, infer R>
  ? R
  : never

export type _FetchParamsNotAny = Assert<Not<IsAny<Params>>>
export type _FetchUrlIsDecoded = Assert<Equal<Params["url"], URL>>
export type _FetchResultNotAny = Assert<Not<IsAny<Result>>>
export type _FetchResultIsPrecise = Assert<Equal<Result, WebFetch.FetchResult>>
export type _FetchHandlerRequiresOnlyFetch = Assert<Equal<Requirements, WebFetch.WebFetch>>
export type _FetchToolRequiresOnlyFetch = Assert<
  Equal<Tool.HandlerServices<typeof WebToolkit.Fetch>, WebFetch.WebFetch>
>

const Fetcher = Agent.make({}).pipe(Agent.withTool(WebToolkit.fetch))
export type _FetchAgentRequiresOnlyFetch = Assert<
  Equal<AgentRequirements<typeof Fetcher>, WebFetch.WebFetch>
>

const fetched: WebFetch.FetchResult = {
  finalUrl: "https://example.com/docs",
  status: 200,
  mediaType: "text/plain",
  format: "text",
  body: "external text"
}

describe("WebToolkit fetch composition", () => {
  it.effect("decodes and canonicalizes URL permission resources", () =>
    Effect.gen(function* () {
      const evaluations = yield* Ref.make<Array<Permission.Request>>([])
      const outcome = yield* ToolExecution.decide(
        WebToolkit.Fetch,
        {
          id: "f1",
          name: "web_fetch",
          params: { url: "HTTPS://Example.COM:443/docs#section" }
        },
        {
          sessionId: "session-1",
          messages: [],
          permission: Permission.make((request) =>
            Ref.update(evaluations, (all) => [...all, request]).pipe(
              Effect.as(Permission.ask("the URL will leave this machine"))
            ))
        }
      )

      assert.strictEqual(outcome._tag, "Decided")
      if (outcome._tag !== "Decided") return
      assert.strictEqual(outcome.request.action, "net.fetch")
      assert.strictEqual(outcome.request.resource, "https://example.com")
      assert.strictEqual(outcome.decision._tag, "Ask")
      assert.deepStrictEqual(outcome.request.tool.params, {
        url: "HTTPS://Example.COM:443/docs#section"
      })
      assert.strictEqual((yield* Ref.get(evaluations)).length, 1)
    })
  )

  it.effect("invalid URL parameters invoke no permission policy", () =>
    Effect.gen(function* () {
      const evaluations = yield* Ref.make(0)
      const outcome = yield* ToolExecution.decide(
        WebToolkit.Fetch,
        { id: "f1", name: "web_fetch", params: { url: "not a URL" } },
        {
          sessionId: "session-1",
          messages: [],
          permission: Permission.make(() =>
            Ref.updateAndGet(evaluations, (count) => count + 1).pipe(
              Effect.as(Permission.allow)
            ))
        }
      )
      assert.strictEqual(outcome._tag, "InvalidParameters")
      assert.strictEqual(yield* Ref.get(evaluations), 0)

      const providerCalls = yield* Ref.make(0)
      const provider = WebFetch.layer({
        fetch: () => Ref.updateAndGet(providerCalls, (count) => count + 1).pipe(
          Effect.as(fetched)
        )
      })
      const agent = Agent.make({
        toolkit: WebToolkit.fetchToolkit(),
        loop: AgentLoop.bounded(3),
        permission: Permission.make(() =>
          Ref.updateAndGet(evaluations, (count) => count + 1).pipe(
            Effect.as(Permission.allow)
          ))
      })
      const { layer: model } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall(
          "web_fetch",
          { url: "still not a URL" },
          { id: "invalid-fetch" }
        ),
        TestLanguageModel.text("continued")
      ])
      const result = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(agent), (session) => session.prompt("fetch"))
      ).pipe(Effect.provide(Layer.merge(model, provider)))
      assert.strictEqual(result.text, "continued")
      assert.strictEqual(yield* Ref.get(evaluations), 0)
      assert.strictEqual(yield* Ref.get(providerCalls), 0)
    })
  )

  it.effect("the canned provider runs the handler and delimits untrusted content", () =>
    Effect.gen(function* () {
      const result = yield* WebToolkit.handlers.web_fetch(
        { url: new URL("https://example.com/docs") },
        { preliminary: () => Effect.void }
      ).pipe(Effect.provide(TestWebFetch.layer(fetched)))

      assert.include(result.body, "BEGIN UNTRUSTED WEB CONTENT")
      assert.include(result.body, "external text")
      assert.include(result.body, "END UNTRUSTED WEB CONTENT")
    })
  )

  it.effect("Allow reaches the provider once and Deny never reaches it", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const provider = WebFetch.layer({
        fetch: () => Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.as(fetched)
        )
      })
      const allowed = Agent.make({
        toolkit: WebToolkit.fetchToolkit(),
        loop: AgentLoop.bounded(4),
        permission: Permission.allowAll
      })
      const { layer: allowedModel, recorder } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall(
          "web_fetch",
          { url: "https://example.com/docs" },
          { id: "f1" }
        ),
        TestLanguageModel.text("used it")
      ])
      yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(allowed), (session) => session.prompt("fetch"))
      ).pipe(Effect.provide(Layer.merge(allowedModel, provider)))
      assert.strictEqual(yield* Ref.get(calls), 1)
      assert.include(JSON.stringify(yield* recorder.prompts), "UNTRUSTED WEB CONTENT")

      const denied = Agent.make({
        toolkit: WebToolkit.fetchToolkit(),
        loop: AgentLoop.bounded(2),
        permission: Permission.denyAll
      })
      const { layer: deniedModel } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall(
          "web_fetch",
          { url: "https://example.com/docs" },
          { id: "f2" }
        )
      ])
      const exit = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(denied), (session) => session.prompt("fetch"))
      ).pipe(Effect.provide(Layer.merge(deniedModel, provider)), Effect.exit)
      assert.isTrue(Exit.isFailure(exit))
      assert.strictEqual(yield* Ref.get(calls), 1)
    })
  )

  it.effect("an explicit redirected-origin call receives a fresh permission decision", () =>
    Effect.gen(function* () {
      const resources = yield* Ref.make<Array<string>>([])
      const providerCalls = yield* Ref.make(0)
      const provider = WebFetch.layer({
        fetch: (url) => Ref.updateAndGet(providerCalls, (count) => count + 1).pipe(
          Effect.flatMap(() =>
            url.origin === "https://example.com"
              ? Effect.fail(
                new WebFetch.WebFetchCrossOriginRedirectError({
                  from: url.href,
                  to: "https://cdn.example.net/docs"
                })
              )
              : Effect.succeed({
                ...fetched,
                finalUrl: "https://cdn.example.net/docs"
              })
          )
        )
      })
      const agent = Agent.make({
        toolkit: WebToolkit.fetchToolkit(),
        loop: AgentLoop.bounded(5),
        permission: Permission.make((request) =>
          Ref.update(resources, (all) => [...all, request.resource]).pipe(
            Effect.as(Permission.allow)
          ))
      })
      const { layer: model } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall(
          "web_fetch",
          { url: "https://example.com/start" },
          { id: "f1" }
        ),
        TestLanguageModel.toolCall(
          "web_fetch",
          { url: "https://cdn.example.net/docs" },
          { id: "f2" }
        ),
        TestLanguageModel.text("done")
      ])

      yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(agent), (session) => session.prompt("fetch"))
      ).pipe(Effect.provide(Layer.merge(model, provider)))

      assert.deepStrictEqual(yield* Ref.get(resources), [
        "https://example.com",
        "https://cdn.example.net"
      ])
      assert.strictEqual(yield* Ref.get(providerCalls), 2)
    })
  )
})
