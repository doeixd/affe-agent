import { NodeHttpServer } from "@effect/platform-node"
import { Client as V2Client, StreamableHTTPClientTransport as V2HttpTransport } from "@modelcontextprotocol/client"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { McpProtocol, McpServer } from "effect/unstable/ai"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import { AgentMcp } from "../src/mcp/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * The agent as MCP tools, over the shared host -- the only path since the
 * client-backed `AgentMcp.layer` / `handlers` were removed (2026-08-30).
 * What that removal decided: at capacity the host *refuses* a newcomer and
 * never evicts a live session, where the old path evicted the oldest idle
 * one. A conversation a client can still address must not vanish because
 * another client opened one; capacity is the operator's number to raise.
 */
const promise = <A>(evaluate: () => PromiseLike<A>) => Effect.promise(evaluate)

const Host = AgentSessionHost.Tag<string>("test/AgentMcp/host")

const fixture = Effect.fn("AgentMcp.fixture")(function* (
  turns: ReadonlyArray<TestLanguageModel.Turn>,
  options?: { readonly maxSessions?: number }
) {
  const { layer: model, recorder } = yield* TestLanguageModel.script(turns)
  const client = AgentClient.layer(Agent.make({ loop: AgentLoop.bounded(2) })).pipe(Layer.provide(model))
  const host = AgentSessionHost.layer(Host, {
    principal: { resolve: () => Effect.succeed("mcp") },
    authorization: AgentSessionHost.allowAll(),
    maxSessions: options?.maxSessions ?? 8,
    maxRequestsPerSession: 16
  }).pipe(Layer.provide(client))
  const mcp = McpServer.layerHttp({
    name: "effect-harness-agent-mcp",
    version: "1.0.0",
    path: "/mcp",
    protocols: [McpProtocol.v2025_11_25]
  })
  const routes = AgentMcp.serverLayer({ host: Host }).pipe(Layer.provide(mcp), Layer.provide(host))
  const server = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, gracefulShutdownTimeout: 100 }))
  )
  return { server, recorder }
})

const connect = Effect.fn("AgentMcp.connect")(function* () {
  const address = HttpServer.formatAddress((yield* HttpServer.HttpServer).address)
  return yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const client = new V2Client({ name: "agent-mcp-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } })
      yield* promise(() => client.connect(new V2HttpTransport(new URL("/mcp", address))))
      return client
    }),
    (client) => promise(() => client.close()).pipe(Effect.ignore)
  )
})

const textOf = (result: { readonly content?: unknown }): string => {
  const first: unknown = Array.isArray(result.content) ? result.content[0] : undefined
  return typeof first === "object" && first !== null && "text" in first && typeof first.text === "string" ? first.text : ""
}

// `ask_agent` succeeds with a `Schema.String`, which the MCP server encodes as
// JSON text; a failure's text is the reason, verbatim.
const ask = (client: V2Client, args: { readonly prompt: string; readonly sessionId?: string }) =>
  promise(() => client.callTool({ name: "ask_agent", arguments: args })).pipe(
    Effect.map((result) => {
      const isError = result.isError === true
      const text = textOf(result)
      return { text: isError ? text : String(JSON.parse(text)), isError }
    })
  )

const decodeSessions = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(AgentProtocol.SessionSummary)))
const listSessions = (client: V2Client) =>
  promise(() => client.readResource({ uri: "agent://sessions" })).pipe(
    Effect.map((result) => {
      const first: unknown = result.contents[0]
      return decodeSessions(typeof first === "object" && first !== null && "text" in first ? String(first.text) : "[]")
    })
  )

const over = <A, E, LE>(server: Layer.Layer<HttpServer.HttpServer, LE>, use: (client: V2Client) => Effect.Effect<A, E>) =>
  Effect.scoped(Effect.flatMap(connect(), use).pipe(Effect.provide(server)))

describe("agent over MCP", () => {
  it.live("answers a one-shot question", () =>
    Effect.gen(function* () {
      const { server } = yield* fixture([TestLanguageModel.text("the answer is 42")])
      yield* over(server, (client) =>
        Effect.gen(function* () {
          const answer = yield* ask(client, { prompt: "what is the answer?" })
          assert.deepStrictEqual(answer, { text: "the answer is 42", isError: false })
        }))
    })
  )

  it.live("continues a conversation when given the same session id", () =>
    Effect.gen(function* () {
      const { server, recorder } = yield* fixture([TestLanguageModel.text("noted"), TestLanguageModel.text("you said 41")])
      yield* over(server, (client) =>
        Effect.gen(function* () {
          yield* ask(client, { prompt: "remember 41", sessionId: "chat-1" })
          yield* ask(client, { prompt: "what did I say?", sessionId: "chat-1" })
        }))
      const second = (yield* recorder.prompts)[1]
      assert.isDefined(second)
      assert.deepStrictEqual(TestLanguageModel.userTexts(second!), ["remember 41", "what did I say?"])
    })
  )

  it.live("gives an unnamed call its own session, released when the call returns", () =>
    Effect.gen(function* () {
      const { server, recorder } = yield* fixture([TestLanguageModel.text("first"), TestLanguageModel.text("second")])
      yield* over(server, (client) =>
        Effect.gen(function* () {
          yield* ask(client, { prompt: "unrelated one" })
          yield* ask(client, { prompt: "unrelated two" })
          // Nothing named, nothing kept: the host holds no session afterwards.
          assert.deepStrictEqual(yield* listSessions(client), [])
        }))
      const second = (yield* recorder.prompts)[1]
      assert.isDefined(second)
      assert.deepStrictEqual(TestLanguageModel.userTexts(second!), ["unrelated two"])
    })
  )

  it.live("a named call keeps its session alive between calls", () =>
    Effect.gen(function* () {
      const { server } = yield* fixture([TestLanguageModel.text("kept")])
      yield* over(server, (client) =>
        Effect.gen(function* () {
          yield* ask(client, { prompt: "hold this", sessionId: "durable-chat" })
          const sessions = yield* listSessions(client)
          assert.deepStrictEqual(sessions.map((entry) => [entry.sessionId, entry.status]), [["durable-chat", "idle"]])
        }))
    })
  )

  it.live("concurrent calls for one session id reach one session: the second is busy, not a second run", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const { server } = yield* fixture([
        { text: "a", started: entered, during: Deferred.await(release) },
        TestLanguageModel.text("b")
      ])
      yield* over(server, (client) =>
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(ask(client, { prompt: "one", sessionId: "shared" }))
          yield* Deferred.await(entered)
          const second = yield* ask(client, { prompt: "two", sessionId: "shared" })
          assert.isTrue(second.isError, "the second call ran instead of being refused as busy")
          assert.include(second.text, "already running")
          yield* Deferred.succeed(release, void 0)
          const firstOutcome = yield* Fiber.join(first)
          assert.deepStrictEqual(firstOutcome, { text: "a", isError: false })
        }))
    })
  )

  it.live("at capacity the host refuses a newcomer and never evicts a live conversation", () =>
    Effect.gen(function* () {
      const { server, recorder } = yield* fixture(
        Array.from({ length: 6 }, (_, i) => TestLanguageModel.text(`r${i}`)),
        { maxSessions: 2 }
      )
      yield* over(server, (client) =>
        Effect.gen(function* () {
          yield* ask(client, { prompt: "first", sessionId: "one" })
          yield* ask(client, { prompt: "second", sessionId: "two" })
          const third = yield* ask(client, { prompt: "third", sessionId: "three" })
          assert.isTrue(third.isError)
          assert.include(third.text, "capacity")
          // The sessions that exist are exactly the ones that were admitted;
          // nothing was dropped to make room.
          const held = (yield* listSessions(client)).map((entry) => entry.sessionId).sort()
          assert.deepStrictEqual(held, ["one", "two"])
          // And "one" is still the conversation it was.
          yield* ask(client, { prompt: "again", sessionId: "one" })
          // Releasing one explicitly is what makes room.
          yield* promise(() => client.callTool({ name: "agent_close", arguments: { sessionId: "two" } }))
          const admitted = yield* ask(client, { prompt: "now", sessionId: "three" })
          assert.isFalse(admitted.isError)
        }))
      const prompts = yield* recorder.prompts
      assert.deepStrictEqual(TestLanguageModel.userTexts(prompts[2]!), ["first", "again"])
    })
  )
})
