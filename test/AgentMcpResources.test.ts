import { NodeHttpServer } from "@effect/platform-node"
import {
  Client as V2Client,
  StreamableHTTPClientTransport as V2HttpTransport
} from "@modelcontextprotocol/client"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { McpProtocol, McpServer } from "effect/unstable/ai"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import { AgentMcp } from "../src/mcp/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * The two resources `docs/plan-mcp-frontend.md` phase 4 could not ship until
 * the host had an enumeration seam and a finite event-log read:
 * `agent://sessions` and `agent://session/{id}/events[/after/{n}]`, read by
 * the official v2 client over Streamable HTTP.
 */
const promise = <A>(evaluate: () => PromiseLike<A>) => Effect.promise(evaluate)

const Host = AgentSessionHost.Tag<string>("test/AgentMcpResources/host")

const fixture = Effect.fn("AgentMcpResources.fixture")(function* (
  turns: ReadonlyArray<TestLanguageModel.Turn>,
  maxRetainedEvents?: number
) {
  const { layer: model } = yield* TestLanguageModel.script(turns)
  const client = AgentClient.layer(Agent.make({ loop: AgentLoop.bounded(1) })).pipe(Layer.provide(model))
  const host = AgentSessionHost.layer(Host, {
    principal: {
      resolve: ({ headers, operation }) =>
        headers.authorization === "Bearer resources"
          ? Effect.succeed(headers.authorization)
          : Effect.fail(new AgentProtocol.AgentUnauthorizedError({ operation }))
    },
    authorization: AgentSessionHost.allowAll(),
    maxSessions: 2,
    maxRequestsPerSession: 16,
    ...(maxRetainedEvents === undefined ? {} : { maxRetainedEvents })
  }).pipe(Layer.provide(client))
  const mcp = McpServer.layerHttp({
    name: "effect-harness-resources",
    version: "1.0.0",
    path: "/mcp",
    protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18]
  })
  const routes = AgentMcp.serverLayer({ host: Host }).pipe(Layer.provide(mcp), Layer.provide(host))
  const server = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, gracefulShutdownTimeout: 100 }))
  )
  return { server }
})

const connect = Effect.fn("AgentMcpResources.connect")(function* (url: URL) {
  return yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const client = new V2Client({ name: "official-v2", version: "2.0.0" }, { versionNegotiation: { mode: "auto" } })
      yield* promise(() =>
        client.connect(new V2HttpTransport(url, { requestInit: { headers: { authorization: "Bearer resources" } } }))
      )
      return client
    }),
    (client) => promise(() => client.close()).pipe(Effect.ignore)
  )
})

const textOf = (result: { readonly contents: ReadonlyArray<unknown> }): string => {
  const first = result.contents[0]
  if (first === undefined || typeof first !== "object" || first === null || !("text" in first) || typeof first.text !== "string") {
    assert.fail("expected the resource to contain text")
  }
  return first.text
}

const decodeLog = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.toCodecJson(AgentProtocol.EventLogResponse)))
const decodeSessions = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(AgentProtocol.SessionSummary)))

describe("AgentMcp resources over the shared host", () => {
  it.live("agent://sessions lists the host's sessions and the events resource reads the log finitely, with a cursor", () =>
    Effect.gen(function* () {
      const { server } = yield* fixture([TestLanguageModel.text("answered")])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const address = HttpServer.formatAddress((yield* HttpServer.HttpServer).address)
          const client = yield* connect(new URL("/mcp", address))

          // Nothing hosted yet.
          assert.deepStrictEqual(decodeSessions(textOf(yield* promise(() => client.readResource({ uri: "agent://sessions" })))), [])

          yield* promise(() => client.callTool({ name: "ask_agent", arguments: { prompt: "hello", sessionId: "s-1" } }))

          const sessions = decodeSessions(textOf(yield* promise(() => client.readResource({ uri: "agent://sessions" }))))
          assert.deepStrictEqual(sessions.map((entry) => [entry.sessionId, entry.status]), [["s-1", "idle"]])

          const log = decodeLog(textOf(yield* promise(() => client.readResource({ uri: "agent://session/s-1/events" }))))
          const tags = log.events.map((envelope) => envelope.event._tag)
          // Held since hosting: `SessionStarted` precedes any host's subscription.
          assert.strictEqual(log.oldest, 2)
          assert.strictEqual(tags[0], "SubmissionStarted")
          assert.include(tags, "MessageCompleted")
          assert.strictEqual(tags[tags.length - 1], "SubmissionCompleted")
          assert.strictEqual(log.latest, log.events[log.events.length - 1]?.sequence)

          // The cursor form: the same number the reader was handed.
          const rest = decodeLog(textOf(yield* promise(() => client.readResource({ uri: `agent://session/s-1/events/after/${log.latest - 2}` }))))
          assert.deepStrictEqual(rest.events.map((envelope) => envelope.sequence), [log.latest - 1, log.latest])
          const none = decodeLog(textOf(yield* promise(() => client.readResource({ uri: `agent://session/s-1/events/after/${log.latest}` }))))
          assert.deepStrictEqual(none.events, [])
        }).pipe(Effect.provide(server))
      )
    }),
    30_000
  )

  it.live("a read from before what the host still holds is refused, not downgraded", () =>
    Effect.gen(function* () {
      const { server } = yield* fixture([TestLanguageModel.text("answered")], 3)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const address = HttpServer.formatAddress((yield* HttpServer.HttpServer).address)
          const client = yield* connect(new URL("/mcp", address))
          yield* promise(() => client.callTool({ name: "ask_agent", arguments: { prompt: "hello", sessionId: "s-1" } }))

          const outcome = yield* Effect.exit(promise(() => client.readResource({ uri: "agent://session/s-1/events" })))
          assert.isTrue(outcome._tag === "Failure")
          if (outcome._tag === "Failure") {
            assert.include(String(outcome.cause), "no longer retained")
          }
          // What is held is still readable from its edge.
          const held = decodeLog(textOf(yield* promise(() => client.readResource({ uri: "agent://session/s-1/events/after/1000" }))))
          assert.deepStrictEqual(held.events, [])
        }).pipe(Effect.provide(server))
      )
    }),
    30_000
  )
})
