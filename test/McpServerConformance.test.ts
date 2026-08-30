import { NodeHttpServer } from "@effect/platform-node"
import {
  Client as V2Client,
  StreamableHTTPClientTransport as V2HttpTransport
} from "@modelcontextprotocol/client"
import {
  StdioClientTransport as V2StdioTransport,
  type StdioServerParameters as V2StdioServerParameters
} from "@modelcontextprotocol/client/stdio"
import { assert, describe, it } from "@effect/vitest"
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Ref,
  Result,
  Schedule,
  Schema,
  Stream
} from "effect"
import {
  McpProtocol,
  McpServer,
  Prompt,
  Tool
} from "effect/unstable/ai"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as Elicitation from "../src/Elicitation.js"
import * as Permission from "../src/Permission.js"
import { AgentClient, AgentProtocol } from "../src/client/index.js"
import { AgentSessionHost } from "../src/client/index.js"
import { AgentHttp } from "../src/http/index.js"
import { AgentMcp } from "../src/mcp/index.js"
import { McpClientV1 } from "../src/mcp/v1/index.js"
import { TestLanguageModel } from "../src/testing/index.js"
import * as McpStdioFixture from "./mcp/stdioFixtures.js"

const promise = <A>(evaluate: () => PromiseLike<A>) => Effect.promise(evaluate)

const stdioFixtureDirectory = fileURLToPath(
  new URL("./mcp/fixtures/", import.meta.url)
)

const harnessStdioServer = (
  lifecycleDirectory: string,
  mode?: "approval"
): V2StdioServerParameters => ({
  command: process.execPath,
  args: [
    "--no-warnings",
    "--loader",
    pathToFileURL(
      join(stdioFixtureDirectory, "typescript-loader.mjs")
    ).href,
    join(stdioFixtureDirectory, "harness-stdio-server.ts"),
    lifecycleDirectory,
    ...(mode === undefined ? [] : [mode])
  ],
  stderr: "pipe"
})

const TextResult = Schema.Struct({
  content: Schema.Array(Schema.Struct({
    type: Schema.String,
    text: Schema.optional(Schema.String)
  }))
})

const callText = (result: unknown): string => {
  const decoded = Schema.decodeUnknownResult(TextResult)(result)
  if (Result.isFailure(decoded)) {
    assert.fail("expected an MCP result containing content blocks")
  }
  const first = decoded.success.content[0]
  if (first?.type !== "text" || first.text === undefined) {
    assert.fail("expected one MCP text content block")
  }
  return first.text
}

const StartedAgent = Schema.Struct({
  sessionId: AgentProtocol.SessionId,
  requestId: AgentProtocol.RequestId
})

const decodeStartedAgent = Schema.decodeUnknownSync(
  Schema.fromJsonString(StartedAgent)
)

const decodeRemoteResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(AgentProtocol.RemoteResult)
)

const decodeBoolean = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Boolean)
)

const AgentStatus = Schema.Struct({
  status: AgentProtocol.SessionStatus,
  pending: Schema.Array(Elicitation.Request)
})

const decodeAgentStatus = Schema.decodeUnknownSync(
  Schema.fromJsonString(AgentStatus)
)

const serverFixture = Effect.fn("McpServerConformance.serverFixture")(
  function* () {
    const opened = yield* Ref.make<ReadonlyArray<string>>([])
    const released = yield* Ref.make<ReadonlyArray<string>>([])
    const calls = yield* Ref.make<ReadonlyArray<string>>([])
    const anonymousCounter = yield* Ref.make(0)

    const client = Layer.succeed(
      AgentClient.AgentClient,
      AgentClient.AgentClient.of({
      createSession: (options) =>
        Effect.gen(function* () {
          const id = options?.sessionId ?? (yield* Ref.modify(
            anonymousCounter,
            (count): readonly [string, number] => [`anonymous-${count + 1}`, count + 1]
          ))
          const promptCount = yield* Ref.make(0)
          yield* Ref.update(opened, (all) => [...all, id])
          yield* Effect.addFinalizer(() =>
            Ref.update(released, (all) => [...all, id])
          )

          return {
            id,
            prompt: (input) =>
              Effect.gen(function* () {
                const text = typeof input === "string" ? input : "non-text"
                const count = yield* Ref.updateAndGet(
                  promptCount,
                  (current) => current + 1
                )
                yield* Ref.update(
                  calls,
                  (all) => [...all, `${id}:${count}:${text}`]
                )
                if (text === "fail") {
                  return yield* new AgentClient.AgentExecutionError({
                    sessionId: id,
                    tag: "FixtureFailure",
                    detail: "fixture refused",
                    isDefect: false
                  })
                }
                return {
                  submissionId: AgentProtocol.SubmissionId.make(
                    `${id}-submission-${count}`
                  ),
                  status: "completed",
                  runs: 1,
                  turns: count,
                  text: `${id}:${count}:${text}`,
                  content: []
                }
              }),
            submit: () => Effect.die("submit is not part of this fixture"),
            awaitSubmission: () => Effect.die("awaitSubmission is not part of this fixture"),
            steer: () => Effect.void,
            followUp: () => Effect.void,
            interrupt: () => Effect.void,
            respond: () => Effect.succeed(false),
            pending: Effect.succeed([]),
            history: Effect.succeed(Prompt.make([])),
            status: Effect.succeed("idle"),
            events: () => Stream.empty
          }
        }),
      session: (id) =>
        Effect.fail(
          new AgentClient.AgentSessionNotFoundError({ sessionId: id })
        )
      })
    )

    const mcp = McpServer.layerHttp({
      name: "effect-harness-conformance",
      version: "1.0.0",
      path: "/mcp",
      protocols: [
        McpProtocol.v2025_11_25,
        McpProtocol.v2025_06_18,
        McpProtocol.v2025_03_26,
        McpProtocol.v2024_11_05
      ]
    })
    const routes = AgentMcp.layer.pipe(
      Layer.provide(mcp),
      Layer.provide(client)
    )
    const server = HttpRouter.serve(routes, {
      disableLogger: true,
      disableListenLog: true
    }).pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(createServer, {
          port: 0,
          gracefulShutdownTimeout: 100
        })
      )
    )

    return {
      server,
      opened,
      released,
      calls
    }
  }
)

const v2Client = Effect.fn("McpServerConformance.v2Client")(function* (
  url: URL,
  mode: "legacy" | "auto",
  requestInit?: RequestInit,
  configure?: (client: V2Client) => void
) {
  return yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const client = new V2Client(
        { name: "official-v2", version: "2.0.0" },
        { versionNegotiation: { mode } }
      )
      configure?.(client)
      yield* promise(() =>
        client.connect(
          new V2HttpTransport(
            url,
            requestInit === undefined ? undefined : { requestInit }
          )
        )
      )
      return client
    }),
    (client) => promise(() => client.close()).pipe(Effect.ignore)
  )
})

const v2StdioClient = Effect.fn("McpServerConformance.v2StdioClient")(
  function* (
    server: V2StdioServerParameters,
    configure?: (client: V2Client) => void
  ) {
    return yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const client = new V2Client(
          { name: "official-v2", version: "2.0.0" },
          {
            versionNegotiation: {
              mode: "auto",
              probe: { timeoutMs: 500 }
            }
          }
        )
        configure?.(client)
        yield* promise(() => client.connect(new V2StdioTransport(server)))
        return client
      }),
      (client) => promise(() => client.close()).pipe(Effect.ignore)
    )
  }
)

const SharedHost = AgentSessionHost.Tag<string>(
  "test/McpServerConformance/shared-host"
)

const sharedHostFixture = Effect.fn(
  "McpServerConformance.sharedHostFixture"
)(function* (
  turns: ReadonlyArray<TestLanguageModel.Turn>,
  options?: {
    readonly maxSessions?: number
    readonly maxRequestsPerSession?: number
    readonly onResolve?: (
      operation: AgentProtocol.Operation
    ) => Effect.Effect<void>
  }
) {
  const { layer: model, recorder } = yield* TestLanguageModel.script(turns)
  const client = AgentClient.layer(
    Agent.make({ loop: AgentLoop.bounded(2) })
  ).pipe(Layer.provide(model))
  const host = AgentSessionHost.layer(SharedHost, {
    principal: {
      resolve: ({ headers, operation }) =>
        headers.authorization === "Bearer shared-host"
          ? Effect.succeed(headers.authorization).pipe(
              Effect.tap(() => options?.onResolve?.(operation) ?? Effect.void)
            )
          : Effect.fail(new AgentProtocol.AgentUnauthorizedError({ operation }))
    },
    authorization: AgentSessionHost.allowAll(),
    maxSessions: options?.maxSessions ?? 1,
    maxRequestsPerSession: options?.maxRequestsPerSession ?? 16
  }).pipe(Layer.provide(client))
  const mcp = McpServer.layerHttp({
    name: "effect-harness-shared-host",
    version: "1.0.0",
    path: "/mcp",
    protocols: [
      McpProtocol.v2025_11_25,
      McpProtocol.v2025_06_18,
      McpProtocol.v2025_03_26,
      McpProtocol.v2024_11_05
    ]
  })
  const routes = Layer.mergeAll(
    AgentMcp.serverLayer({ host: SharedHost }).pipe(Layer.provide(mcp)),
    AgentHttp.serverLayer({ host: SharedHost })
  ).pipe(Layer.provide(host))
  const server = HttpRouter.serve(routes, {
    disableLogger: true,
    disableListenLog: true
  }).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(createServer, {
        port: 0,
        gracefulShutdownTimeout: 100
      })
    )
  )
  return { server, recorder }
})

const ApprovalHost = AgentSessionHost.Tag<string>(
  "test/McpServerConformance/approval-host"
)

const Dangerous = Permission.annotate(
  Tool.make("dangerous", {
    parameters: Schema.Struct({ command: Schema.String }),
    success: Schema.String
  }),
  { action: "shell", resource: ({ command }) => command }
)

const approvalHostFixture = Effect.fn(
  "McpServerConformance.approvalHostFixture"
)(function* (options?: {
  readonly onUnsupportedElicitation?: "pending" | "deny" | "fail"
}) {
  const ran = yield* Ref.make<ReadonlyArray<string>>([])
  const { layer: model, recorder } = yield* TestLanguageModel.script([
    {
      toolCalls: [{
        id: "danger-1",
        name: "dangerous",
        params: { command: "deploy production" }
      }]
    },
    TestLanguageModel.text("deployment finished")
  ])
  const agent = Agent.make({
    toolkit: Agent.toolkit([Dangerous], {
      dangerous: ({ command }) =>
        Ref.update(ran, (all) => [...all, command]).pipe(
          Effect.as(`ran ${command}`)
        )
    }),
    loop: AgentLoop.bounded(4),
    permission: Permission.askAll
  })
  const client = AgentClient.layer(agent, {
    elicitation: Elicitation.memory
  }).pipe(Layer.provide(model))
  const host = AgentSessionHost.layer(ApprovalHost, {
    principal: {
      resolve: ({ headers, operation }) =>
        headers.authorization === "Bearer shared-host"
          ? Effect.succeed(headers.authorization)
          : Effect.fail(new AgentProtocol.AgentUnauthorizedError({ operation }))
    },
    authorization: AgentSessionHost.allowAll(),
    maxSessions: 2,
    maxRequestsPerSession: 16
  }).pipe(Layer.provide(client))
  const mcp = McpServer.layerHttp({
    name: "effect-harness-approval-host",
    version: "1.0.0",
    path: "/mcp",
    protocols: [
      McpProtocol.v2025_11_25,
      McpProtocol.v2025_06_18,
      McpProtocol.v2025_03_26,
      McpProtocol.v2024_11_05
    ]
  })
  const routes = AgentMcp.serverLayer({
    host: ApprovalHost,
    ...(options?.onUnsupportedElicitation === undefined
      ? {}
      : { onUnsupportedElicitation: options.onUnsupportedElicitation })
  }).pipe(Layer.provide(mcp), Layer.provide(host))
  const server = HttpRouter.serve(routes, {
    disableLogger: true,
    disableListenLog: true
  }).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(createServer, {
        port: 0,
        gracefulShutdownTimeout: 100
      })
    )
  )
  return { server, ran, recorder }
})

const json = <S extends Schema.Constraint>(response: Response, schema: S) =>
  promise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(schema)))
  )

describe("Harness MCP server conformance", () => {
  it.effect("serves an official v1 client with named-session continuity", () =>
    Effect.gen(function* () {
      const fixture = yield* serverFixture()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* McpClientV1.streamableHttp({
            url: new URL("/mcp", HttpServer.formatAddress(server.address)),
            clientInfo: { name: "official-v1", version: "1.0.0" }
          })
          assert.deepStrictEqual(
            (yield* client.listTools).map((tool) => tool.name),
            ["ask_agent"]
          )
          assert.strictEqual(
            yield* client.callTool("ask_agent", {
              prompt: "first",
              sessionId: "shared"
            }),
            '"shared:1:first"'
          )
          assert.strictEqual(
            yield* client.callTool("ask_agent", {
              prompt: "second",
              sessionId: "shared"
            }),
            '"shared:2:second"'
          )
        }).pipe(Effect.provide(fixture.server))
      )
      assert.deepStrictEqual(yield* Ref.get(fixture.calls), [
        "shared:1:first",
        "shared:2:second"
      ])
      assert.deepStrictEqual(yield* Ref.get(fixture.opened), ["shared"])
      assert.deepStrictEqual(yield* Ref.get(fixture.released), ["shared"])
    })
  )

  it.effect("shares one authenticated host registry with the HTTP adapter", () =>
    Effect.gen(function* () {
      const fixture = yield* sharedHostFixture([
        TestLanguageModel.text("answered through the shared host")
      ])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const address = HttpServer.formatAddress(server.address)
          const authorization = "Bearer shared-host"

          // Create through ordinary Agent HTTP first. With separate adapter
          // registries, an MCP prompt under this name would open a second
          // session and the HTTP history below would remain empty.
          const created = yield* promise(() =>
            fetch(`${address}/sessions`, {
              method: "POST",
              headers: {
                authorization,
                "content-type": "application/json"
              },
              body: JSON.stringify({
                requestId: "http-create",
                sessionId: "shared-session"
              })
            })
          )
          assert.strictEqual(created.status, 200)

          const client = yield* v2Client(
            new URL("/mcp", address),
            "legacy",
            { headers: { authorization } }
          )
          assert.strictEqual(
            callText(yield* promise(() => client.callTool({
              name: "ask_agent",
              arguments: {
                prompt: "prompted through MCP",
                sessionId: "shared-session"
              }
            }))),
            '"answered through the shared host"'
          )

          const historyResponse = yield* promise(() =>
            fetch(`${address}/sessions/shared-session/history`, {
              headers: { authorization }
            })
          )
          assert.strictEqual(historyResponse.status, 200)
          const history = yield* json(
            historyResponse,
            AgentProtocol.HistoryResponse
          )
          assert.deepStrictEqual(
            TestLanguageModel.userTexts(history.history),
            ["prompted through MCP"]
          )
        }).pipe(Effect.provide(fixture.server))
      )
      assert.strictEqual(yield* fixture.recorder.calls, 1)
    }),
    30_000
  )

  it.effect("exposes authenticated history and pending resource templates", () =>
    Effect.gen(function* () {
      const fixture = yield* sharedHostFixture([
        TestLanguageModel.text("resource-backed answer")
      ])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const address = HttpServer.formatAddress(server.address)
          const client = yield* v2Client(
            new URL("/mcp", address),
            "legacy",
            { headers: { authorization: "Bearer shared-host" } }
          )
          assert.strictEqual(
            callText(yield* promise(() => client.callTool({
              name: "ask_agent",
              arguments: { prompt: "resource prompt", sessionId: "resource-session" }
            }))),
            '"resource-backed answer"'
          )

          const history = yield* promise(() => client.readResource({
            uri: "agent://session/resource-session/history"
          }))
          const pending = yield* promise(() => client.readResource({
            uri: "agent://session/resource-session/pending"
          }))
          const historyText = history.contents[0]
          const pendingText = pending.contents[0]
          if (historyText === undefined || !("text" in historyText)) {
            assert.fail("expected the history resource to contain text")
          }
          if (pendingText === undefined || !("text" in pendingText)) {
            assert.fail("expected the pending resource to contain text")
          }
          const decodedHistory = Schema.decodeUnknownSync(
            Schema.Struct({ content: Schema.Array(Schema.Unknown) })
          )(JSON.parse(historyText.text))
          const decodedPending = JSON.parse(pendingText.text)
          assert.isArray(decodedHistory.content)
          assert.deepStrictEqual(decodedPending, [])
        }).pipe(Effect.provide(fixture.server))
      )
    }),
    30_000
  )

  it.effect("releases each anonymous shared-host session after its MCP call", () =>
    Effect.gen(function* () {
      const fixture = yield* sharedHostFixture([
        TestLanguageModel.text("first one-shot"),
        TestLanguageModel.text("second one-shot")
      ])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* v2Client(
            new URL("/mcp", HttpServer.formatAddress(server.address)),
            "legacy",
            { headers: { authorization: "Bearer shared-host" } }
          )
          const call = (prompt: string) =>
            promise(() => client.callTool({
              name: "ask_agent",
              arguments: { prompt }
            })).pipe(Effect.map(callText))

          assert.strictEqual(yield* call("first"), '"first one-shot"')
          // The host capacity is one. This can succeed only if the anonymous
          // session from the first call was closed before the second creates
          // its own session.
          assert.strictEqual(yield* call("second"), '"second one-shot"')
        }).pipe(Effect.provide(fixture.server))
      )

      const prompts = yield* fixture.recorder.prompts
      const first = prompts[0]
      const second = prompts[1]
      assert.isDefined(first)
      assert.isDefined(second)
      assert.deepStrictEqual(TestLanguageModel.userTexts(first), ["first"])
      assert.deepStrictEqual(TestLanguageModel.userTexts(second), ["second"])
    }),
    30_000
  )

  it.effect("keeps ask_agent failure text stable on the shared-host path", () =>
    Effect.gen(function* () {
      const fixture = yield* sharedHostFixture([{
        fail: "fixture provider failure"
      }])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* v2Client(
            new URL("/mcp", HttpServer.formatAddress(server.address)),
            "legacy",
            { headers: { authorization: "Bearer shared-host" } }
          )
          const failed = yield* promise(() => client.callTool({
            name: "ask_agent",
            arguments: {
              prompt: "fail exactly once",
              sessionId: "failed-ask"
            }
          }))
          assert.isTrue(failed.isError)
          assert.strictEqual(
            callText(failed),
            "Session failed-ask failed: Error: fixture provider failure"
          )
        }).pipe(Effect.provide(fixture.server))
      )
      assert.strictEqual(yield* fixture.recorder.calls, 1)
    }),
    30_000
  )

  it.effect("starts once and lets two authorized callers await the same run", () =>
    Effect.gen(function* () {
      const modelEntered = yield* Deferred.make<void>()
      const releaseModel = yield* Deferred.make<void>()
      const awaitCount = yield* Ref.make(0)
      const bothAwaiting = yield* Deferred.make<void>()
      const fixture = yield* sharedHostFixture(
        [{
          text: "one retained result",
          started: modelEntered,
          during: Deferred.await(releaseModel)
        }],
        {
          onResolve: (operation) =>
            operation === "getSession"
              ? Ref.updateAndGet(awaitCount, (count) => count + 1).pipe(
                  Effect.flatMap((count) =>
                    count === 2
                      ? Deferred.succeed(bothAwaiting, void 0).pipe(Effect.asVoid)
                      : Effect.void
                  )
                )
              : Effect.void
        }
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const url = new URL("/mcp", HttpServer.formatAddress(server.address))
          const authorized = yield* v2Client(url, "legacy", {
            headers: { authorization: "Bearer shared-host" }
          })
          const unauthorized = yield* v2Client(url, "legacy")
          const started = decodeStartedAgent(callText(
            yield* promise(() => authorized.callTool({
              name: "agent_start",
              arguments: { prompt: "run once" }
            }))
          ))

          // `agent_start` has already returned even though the provider is
          // still blocked. A request id is not a bearer token: awaiting it
          // through a connection without the required principal must fail.
          yield* Deferred.await(modelEntered)
          const refused = yield* promise(() => unauthorized.callTool({
            name: "agent_await",
            arguments: { requestId: started.requestId }
          }))
          assert.isTrue(refused.isError)

          const awaitStarted = () =>
            promise(() => authorized.callTool({
              name: "agent_await",
              arguments: { requestId: started.requestId }
            })).pipe(Effect.map(callText), Effect.map(decodeRemoteResult))
          const first = yield* Effect.forkChild(awaitStarted())
          const second = yield* Effect.forkChild(awaitStarted())
          yield* Deferred.await(bothAwaiting)
          yield* Deferred.succeed(releaseModel, void 0)

          const results = yield* Effect.all([
            Fiber.join(first),
            Fiber.join(second)
          ])
          assert.deepStrictEqual(results[0], results[1])
          assert.strictEqual(results[0].status, "completed")
          assert.strictEqual(results[0].text, "one retained result")

          const closed = decodeBoolean(callText(
            yield* promise(() => authorized.callTool({
              name: "agent_close",
              arguments: { sessionId: started.sessionId }
            }))
          ))
          assert.isTrue(closed)
        }).pipe(Effect.provide(fixture.server))
      )
      assert.strictEqual(yield* fixture.recorder.calls, 1)
    }),
    30_000
  )

  it.effect("answers an await from its ticket after the host evicts the request", () =>
    Effect.gen(function* () {
      const fixture = yield* sharedHostFixture([
        TestLanguageModel.text("original result"),
        TestLanguageModel.text("later result")
      ], { maxRequestsPerSession: 1 })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* v2Client(
            new URL("/mcp", HttpServer.formatAddress(server.address)),
            "legacy",
            { headers: { authorization: "Bearer shared-host" } }
          )
          const started = decodeStartedAgent(callText(
            yield* promise(() => client.callTool({
              name: "agent_start",
              arguments: {
                prompt: "first",
                sessionId: "eviction-guard"
              }
            }))
          ))
          const awaitOriginal = () =>
            promise(() => client.callTool({
              name: "agent_await",
              arguments: { requestId: started.requestId }
            })).pipe(Effect.map(callText), Effect.map(decodeRemoteResult))

          assert.strictEqual((yield* awaitOriginal()).text, "original result")
          // This second mutation fills the host's one-entry request table and
          // evicts the completed prompt record owned by `agent_start`.
          assert.strictEqual(
            callText(yield* promise(() => client.callTool({
              name: "ask_agent",
              arguments: {
                prompt: "second",
                sessionId: "eviction-guard"
              }
            }))),
            '"later result"'
          )
          // Await must read the adapter ticket. Reissuing host.prompt here
          // would become a new owner and consume a third model turn.
          assert.strictEqual((yield* awaitOriginal()).text, "original result")
        }).pipe(Effect.provide(fixture.server))
      )
      assert.strictEqual(yield* fixture.recorder.calls, 2)
    }),
    30_000
  )

  it.effect("keeps an old ticket when the host refuses a new session", () =>
    Effect.gen(function* () {
      const fixture = yield* sharedHostFixture([
        TestLanguageModel.text("still retained")
      ], { maxSessions: 1, maxRequestsPerSession: 1 })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* v2Client(
            new URL("/mcp", HttpServer.formatAddress(server.address)),
            "legacy",
            { headers: { authorization: "Bearer shared-host" } }
          )
          const started = decodeStartedAgent(callText(
            yield* promise(() => client.callTool({
              name: "agent_start",
              arguments: { prompt: "first", sessionId: "retained" }
            }))
          ))
          const awaitOriginal = () =>
            promise(() => client.callTool({
              name: "agent_await",
              arguments: { requestId: started.requestId }
            })).pipe(Effect.map(callText), Effect.map(decodeRemoteResult))
          assert.strictEqual((yield* awaitOriginal()).text, "still retained")

          const refused = yield* promise(() => client.callTool({
            name: "agent_start",
            arguments: { prompt: "second", sessionId: "over-capacity" }
          }))
          assert.isTrue(refused.isError)
          // Session acquisition happens before ticket eviction. A failed host
          // admission therefore cannot consume the old settled ticket.
          assert.strictEqual((yield* awaitOriginal()).text, "still retained")
        }).pipe(Effect.provide(fixture.server))
      )
      assert.strictEqual(yield* fixture.recorder.calls, 1)
    }),
    30_000
  )

  it.effect("refuses a new start when every bounded ticket is in flight", () =>
    Effect.gen(function* () {
      const modelEntered = yield* Deferred.make<void>()
      const releaseModel = yield* Deferred.make<void>()
      const fixture = yield* sharedHostFixture(
        [{
          text: "finished",
          started: modelEntered,
          during: Deferred.await(releaseModel)
        }],
        { maxRequestsPerSession: 1 }
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* v2Client(
            new URL("/mcp", HttpServer.formatAddress(server.address)),
            "legacy",
            { headers: { authorization: "Bearer shared-host" } }
          )
          const started = decodeStartedAgent(callText(
            yield* promise(() => client.callTool({
              name: "agent_start",
              arguments: { prompt: "first", sessionId: "bounded" }
            }))
          ))
          yield* Deferred.await(modelEntered)

          const refused = yield* promise(() => client.callTool({
            name: "agent_start",
            arguments: { prompt: "second", sessionId: "bounded" }
          }))
          assert.isTrue(refused.isError)

          yield* Deferred.succeed(releaseModel, void 0)
          const awaited = yield* promise(() => client.callTool({
            name: "agent_await",
            arguments: { requestId: started.requestId }
          }))
          assert.isFalse(
            awaited.isError,
            callText(awaited)
          )
          const result = decodeRemoteResult(callText(awaited))
          assert.strictEqual(result.text, "finished")
        }).pipe(Effect.provide(fixture.server))
      )
      assert.strictEqual(yield* fixture.recorder.calls, 1)
    }),
    30_000
  )

  it.effect("steers a started run before awaiting its retained result", () =>
    Effect.gen(function* () {
      const modelEntered = yield* Deferred.make<void>()
      const releaseModel = yield* Deferred.make<void>()
      const fixture = yield* sharedHostFixture([
        {
          text: "draft",
          started: modelEntered,
          during: Deferred.await(releaseModel)
        },
        TestLanguageModel.text("revised")
      ])

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* v2Client(
            new URL("/mcp", HttpServer.formatAddress(server.address)),
            "legacy",
            { headers: { authorization: "Bearer shared-host" } }
          )
          const started = decodeStartedAgent(callText(
            yield* promise(() => client.callTool({
              name: "agent_start",
              arguments: { prompt: "go", sessionId: "steered" }
            }))
          ))
          yield* Deferred.await(modelEntered)
          assert.isTrue(decodeBoolean(callText(
            yield* promise(() => client.callTool({
              name: "agent_steer",
              arguments: {
                sessionId: started.sessionId,
                prompt: "go left"
              }
            }))
          )))
          yield* Deferred.succeed(releaseModel, void 0)

          const awaited = yield* promise(() => client.callTool({
            name: "agent_await",
            arguments: { requestId: started.requestId }
          }))
          assert.isFalse(
            awaited.isError,
            callText(awaited)
          )
          const result = decodeRemoteResult(callText(awaited))
          assert.strictEqual(result.text, "revised")
        }).pipe(Effect.provide(fixture.server))
      )

      const prompts = yield* fixture.recorder.prompts
      assert.strictEqual(prompts.length, 2)
      const revised = prompts[1]
      assert.isDefined(revised)
      assert.deepStrictEqual(TestLanguageModel.userTexts(revised), [
        "go",
        "go left"
      ])
    }),
    30_000
  )

  it.effect("queues a follow-up under the ticket's original submission", () =>
    Effect.gen(function* () {
      const modelEntered = yield* Deferred.make<void>()
      const releaseModel = yield* Deferred.make<void>()
      const fixture = yield* sharedHostFixture([
        {
          text: "first answer",
          started: modelEntered,
          during: Deferred.await(releaseModel)
        },
        TestLanguageModel.text("follow-up answer")
      ])

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* v2Client(
            new URL("/mcp", HttpServer.formatAddress(server.address)),
            "legacy",
            { headers: { authorization: "Bearer shared-host" } }
          )
          const started = decodeStartedAgent(callText(
            yield* promise(() => client.callTool({
              name: "agent_start",
              arguments: { prompt: "first", sessionId: "followed" }
            }))
          ))
          yield* Deferred.await(modelEntered)
          assert.isTrue(decodeBoolean(callText(
            yield* promise(() => client.callTool({
              name: "agent_follow_up",
              arguments: {
                sessionId: started.sessionId,
                prompt: "then verify"
              }
            }))
          )))
          yield* Deferred.succeed(releaseModel, void 0)

          const result = decodeRemoteResult(callText(
            yield* promise(() => client.callTool({
              name: "agent_await",
              arguments: { requestId: started.requestId }
            }))
          ))
          assert.strictEqual(result.runs, 2)
          assert.strictEqual(result.text, "follow-up answer")
        }).pipe(Effect.provide(fixture.server))
      )

      const prompts = yield* fixture.recorder.prompts
      const followUp = prompts[1]
      assert.isDefined(followUp)
      assert.deepStrictEqual(TestLanguageModel.userTexts(followUp), [
        "first",
        "then verify"
      ])
    }),
    30_000
  )

  it.effect("interrupts a started run without treating await as the canceller", () =>
    Effect.gen(function* () {
      const modelEntered = yield* Deferred.make<void>()
      const fixture = yield* sharedHostFixture([
        { text: "never returned", hang: true, started: modelEntered }
      ])

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* v2Client(
            new URL("/mcp", HttpServer.formatAddress(server.address)),
            "legacy",
            { headers: { authorization: "Bearer shared-host" } }
          )
          const started = decodeStartedAgent(callText(
            yield* promise(() => client.callTool({
              name: "agent_start",
              arguments: { prompt: "wait", sessionId: "interrupted" }
            }))
          ))
          yield* Deferred.await(modelEntered)
          assert.isTrue(decodeBoolean(callText(
            yield* promise(() => client.callTool({
              name: "agent_interrupt",
              arguments: { sessionId: started.sessionId }
            }))
          )))

          const result = decodeRemoteResult(callText(
            yield* promise(() => client.callTool({
              name: "agent_await",
              arguments: { requestId: started.requestId }
            }))
          ))
          assert.strictEqual(result.status, "interrupted")
          assert.strictEqual(result.text, "")
        }).pipe(Effect.provide(fixture.server))
      )
      assert.strictEqual(yield* fixture.recorder.calls, 1)
    }),
    30_000
  )

  it.effect("bridges tool approval through native MCP elicitation over stdio", () =>
    Effect.scoped(Effect.gen(function* () {
      const fixture = yield* McpStdioFixture.lifecycle()
      const messages: Array<string> = []

      yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* v2StdioClient(
            harnessStdioServer(fixture.directory, "approval"),
            (client) => {
              client.registerCapabilities({ elicitation: { form: {} } })
              client.setRequestHandler("elicitation/create", (request) => {
                messages.push(request.params.message)
                return Promise.resolve({
                  action: "accept",
                  content: { remember: false }
                })
              })
            }
          )
          const started = decodeStartedAgent(callText(
            yield* promise(() => client.callTool({
              name: "agent_start",
              arguments: { prompt: "approval", sessionId: "native-approval" }
            }))
          ))
          const awaited = yield* promise(() => client.callTool({
            name: "agent_await",
            arguments: { requestId: started.requestId }
          }))
          assert.isFalse(
            awaited.isError,
            `${callText(awaited)}; elicitations=${JSON.stringify(messages)}`
          )
          const result = decodeRemoteResult(callText(awaited))
          assert.strictEqual(result.status, "completed")
          assert.strictEqual(result.text, "native-approval:1:approval")
        })
      )

      const events = yield* fixture.waitFor((all) =>
        all.includes("approved:native-approval") &&
        all.includes("released:native-approval") &&
        all.includes("server:released")
      )
      assert.include(events, "approved:native-approval")
      assert.strictEqual(messages.length, 1)
      assert.include(messages[0], "dangerous")
      assert.include(messages[0], "deploy production")
    })),
    15_000
  )

  it.effect("keeps HTTP elicitation manual even when the client advertises forms", () =>
    Effect.gen(function* () {
      const fixture = yield* approvalHostFixture()
      const nativeRequests: Array<string> = []

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* v2Client(
            new URL("/mcp", HttpServer.formatAddress(server.address)),
            "legacy",
            { headers: { authorization: "Bearer shared-host" } },
            (client) => {
              client.registerCapabilities({ elicitation: { form: {} } })
              client.setRequestHandler("elicitation/create", (request) => {
                nativeRequests.push(request.params.message)
                return Promise.resolve({ action: "decline" })
              })
            }
          )
          const started = decodeStartedAgent(callText(
            yield* promise(() => client.callTool({
              name: "agent_start",
              arguments: { prompt: "deploy", sessionId: "manual-approval" }
            }))
          ))
          const readStatus = () =>
            promise(() => client.callTool({
              name: "agent_status",
              arguments: { sessionId: started.sessionId }
            })).pipe(Effect.map(callText), Effect.map(decodeAgentStatus))
          const waiting = yield* Effect.repeat(readStatus(), {
            until: (status) => status.pending.length === 1,
            schedule: Schedule.recurs(100)
          })
          const request = waiting.pending[0]
          assert.isDefined(request)
          assert.strictEqual(waiting.status, "running")
          assert.strictEqual(request.kind, "tool-approval")

          assert.isTrue(decodeBoolean(callText(
            yield* promise(() => client.callTool({
              name: "agent_respond",
              arguments: {
                sessionId: started.sessionId,
                id: request.id,
                granted: true,
                value: { remember: false }
              }
            }))
          )))
          const result = decodeRemoteResult(callText(
            yield* promise(() => client.callTool({
              name: "agent_await",
              arguments: { requestId: started.requestId }
            }))
          ))
          assert.strictEqual(result.text, "deployment finished")
          assert.deepStrictEqual((yield* readStatus()).pending, [])
        }).pipe(Effect.provide(fixture.server))
      )

      assert.deepStrictEqual(yield* Ref.get(fixture.ran), [
        "deploy production"
      ])
      assert.deepStrictEqual(nativeRequests, [])
      assert.strictEqual(yield* fixture.recorder.calls, 2)
    }),
    30_000
  )

  it.effect("denies unsupported elicitation without executing the tool", () =>
    Effect.gen(function* () {
      const fixture = yield* approvalHostFixture({
        onUnsupportedElicitation: "deny"
      })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* v2Client(
            new URL("/mcp", HttpServer.formatAddress(server.address)),
            "legacy",
            { headers: { authorization: "Bearer shared-host" } }
          )
          const started = decodeStartedAgent(callText(
            yield* promise(() => client.callTool({
              name: "agent_start",
              arguments: { prompt: "deploy", sessionId: "denied-approval" }
            }))
          ))
          const awaited = yield* promise(() => client.callTool({
            name: "agent_await",
            arguments: { requestId: started.requestId }
          }))
          assert.isTrue(awaited.isError)
          assert.include(callText(awaited).toLowerCase(), "denied")

          const status = decodeAgentStatus(callText(
            yield* promise(() => client.callTool({
              name: "agent_status",
              arguments: { sessionId: started.sessionId }
            }))
          ))
          assert.deepStrictEqual(status.pending, [])
        }).pipe(Effect.provide(fixture.server))
      )

      assert.deepStrictEqual(yield* Ref.get(fixture.ran), [])
      assert.strictEqual(yield* fixture.recorder.calls, 1)
    }),
    30_000
  )

  it.effect("fails only the unsupported await and leaves the run answerable", () =>
    Effect.gen(function* () {
      const fixture = yield* approvalHostFixture({
        onUnsupportedElicitation: "fail"
      })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* v2Client(
            new URL("/mcp", HttpServer.formatAddress(server.address)),
            "legacy",
            { headers: { authorization: "Bearer shared-host" } }
          )
          const started = decodeStartedAgent(callText(
            yield* promise(() => client.callTool({
              name: "agent_start",
              arguments: { prompt: "deploy", sessionId: "failed-observer" }
            }))
          ))
          const unsupported = yield* promise(() => client.callTool({
            name: "agent_await",
            arguments: { requestId: started.requestId }
          }))
          assert.isTrue(unsupported.isError)
          assert.include(callText(unsupported), "cannot present tool-approval")

          const status = decodeAgentStatus(callText(
            yield* promise(() => client.callTool({
              name: "agent_status",
              arguments: { sessionId: started.sessionId }
            }))
          ))
          const request = status.pending[0]
          assert.isDefined(request)
          assert.isTrue(decodeBoolean(callText(
            yield* promise(() => client.callTool({
              name: "agent_respond",
              arguments: {
                sessionId: started.sessionId,
                id: request.id,
                granted: true,
                value: { remember: false }
              }
            }))
          )))

          const result = decodeRemoteResult(callText(
            yield* promise(() => client.callTool({
              name: "agent_await",
              arguments: { requestId: started.requestId }
            }))
          ))
          assert.strictEqual(result.status, "completed")
          assert.strictEqual(result.text, "deployment finished")
        }).pipe(Effect.provide(fixture.server))
      )

      assert.deepStrictEqual(yield* Ref.get(fixture.ran), [
        "deploy production"
      ])
      assert.strictEqual(yield* fixture.recorder.calls, 2)
    }),
    30_000
  )

  it.effect("serves an official v2 legacy client and isolates one-shot calls", () =>
    Effect.gen(function* () {
      const fixture = yield* serverFixture()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* v2Client(
            new URL("/mcp", HttpServer.formatAddress(server.address)),
            "legacy"
          )
          assert.strictEqual(
            callText(yield* promise(() => client.callTool({
              name: "ask_agent",
              arguments: { prompt: "one" }
            }))),
            '"anonymous-1:1:one"'
          )
          assert.strictEqual(
            callText(yield* promise(() => client.callTool({
              name: "ask_agent",
              arguments: { prompt: "two" }
            }))),
            '"anonymous-2:1:two"'
          )
        }).pipe(Effect.provide(fixture.server))
      )
      assert.deepStrictEqual(yield* Ref.get(fixture.opened), [
        "anonymous-1",
        "anonymous-2"
      ])
      assert.deepStrictEqual(
        [...(yield* Ref.get(fixture.released))].sort(),
        ["anonymous-1", "anonymous-2"]
      )
    })
  )

  it.effect("falls an official v2 auto client back to the latest legacy revision", () =>
    Effect.gen(function* () {
      const fixture = yield* serverFixture()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* v2Client(
            new URL("/mcp", HttpServer.formatAddress(server.address)),
            "auto"
          )
          assert.strictEqual(client.getProtocolEra(), "legacy")
          assert.strictEqual(
            client.getNegotiatedProtocolVersion(),
            "2025-11-25"
          )
          assert.strictEqual(
            callText(yield* promise(() => client.callTool({
              name: "ask_agent",
              arguments: { prompt: "auto" }
            }))),
            '"anonymous-1:1:auto"'
          )
        }).pipe(Effect.provide(fixture.server))
      )
    })
  )

  it.effect("reports declared tool failure and rejects malformed input", () =>
    Effect.gen(function* () {
      const fixture = yield* serverFixture()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* v2Client(
            new URL("/mcp", HttpServer.formatAddress(server.address)),
            "legacy"
          )
          const failed = yield* promise(() => client.callTool({
            name: "ask_agent",
            arguments: { prompt: "fail" }
          }))
          assert.isTrue(failed.isError)

          const malformed = yield* promise(() => client.callTool({
            name: "ask_agent",
            arguments: { prompt: 42 }
          }))
          assert.isTrue(malformed.isError)
          assert.include(callText(malformed), "Invalid parameters")
        }).pipe(Effect.provide(fixture.server))
      )
    })
  )

  it.effect("serves an official v1 stdio client and releases named sessions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* McpStdioFixture.lifecycle()
        yield* Effect.scoped(
          Effect.gen(function* () {
            // The v1 SDK's stdio transport is exercised through the adapter
            // because it also contains the SDK's exact-optional type mismatch.
            const connection = yield* McpClientV1.stdio({
              server: harnessStdioServer(fixture.directory),
              clientInfo: { name: "official-v1", version: "1.0.0" }
            })
            assert.deepStrictEqual(
              (yield* connection.listTools).map((tool) => tool.name),
              ["ask_agent"]
            )
            assert.strictEqual(
              yield* connection.callTool("ask_agent", {
                prompt: "first",
                sessionId: "shared"
              }),
              '"shared:1:first"'
            )
            assert.strictEqual(
              yield* connection.callTool("ask_agent", {
                prompt: "second",
                sessionId: "shared"
              }),
              '"shared:2:second"'
            )

          })
        )

        const events = yield* fixture.waitFor((all) =>
          all.includes("released:shared") &&
          all.includes("server:released")
        )
        assert.include(events, "opened:shared")
        assert.include(events, "call:shared:1:first")
        assert.include(events, "call:shared:2:second")
      })
    ),
    15_000
  )

  it.effect("falls v2 stdio back to legacy and cleans up the server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* McpStdioFixture.lifecycle()
        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* v2StdioClient(
              harnessStdioServer(fixture.directory)
            )
            assert.strictEqual(client.getProtocolEra(), "legacy")
            assert.strictEqual(
              client.getNegotiatedProtocolVersion(),
              "2025-11-25"
            )

            assert.strictEqual(
              callText(yield* promise(() => client.callTool({
                name: "ask_agent",
                arguments: {
                  prompt: "v2-stdio",
                  sessionId: "v2-session"
                }
              }))),
              '"v2-session:1:v2-stdio"'
            )
          })
        )

        const events = yield* fixture.waitFor((all) =>
          all.includes("released:v2-session") &&
          all.includes("server:released")
        )
        assert.include(events, "call:v2-session:1:v2-stdio")
      })
    ),
    15_000
  )

})
