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
  Effect,
  Layer,
  Ref,
  Result,
  Schema,
  Stream
} from "effect"
import {
  McpProtocol,
  McpServer,
  Prompt
} from "effect/unstable/ai"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { AgentClient, AgentProtocol } from "../src/client/index.js"
import { AgentMcp } from "../src/mcp/index.js"
import { McpClientV1 } from "../src/mcp/v1/index.js"
import * as McpStdioFixture from "./mcp/stdioFixtures.js"

const promise = <A>(evaluate: () => PromiseLike<A>) => Effect.promise(evaluate)

const stdioFixtureDirectory = fileURLToPath(
  new URL("./mcp/fixtures/", import.meta.url)
)

const harnessStdioServer = (
  lifecycleDirectory: string
): V2StdioServerParameters => ({
  command: process.execPath,
  args: [
    "--no-warnings",
    "--loader",
    pathToFileURL(
      join(stdioFixtureDirectory, "typescript-loader.mjs")
    ).href,
    join(stdioFixtureDirectory, "harness-stdio-server.ts"),
    lifecycleDirectory
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
                  text: `${id}:${count}:${text}`
                }
              }),
            steer: () => Effect.void,
            followUp: () => Effect.void,
            interrupt: () => Effect.void,
            respond: () => Effect.succeed(false),
            pending: Effect.succeed([]),
            history: Effect.succeed(Prompt.make([])),
            status: Effect.succeed("idle"),
            events: Stream.empty
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
  mode: "legacy" | "auto"
) {
  return yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const client = new V2Client(
        { name: "official-v2", version: "2.0.0" },
        { versionNegotiation: { mode } }
      )
      yield* promise(() => client.connect(new V2HttpTransport(url)))
      return client
    }),
    (client) => promise(() => client.close()).pipe(Effect.ignore)
  )
})

const v2StdioClient = Effect.fn("McpServerConformance.v2StdioClient")(
  function* (server: V2StdioServerParameters) {
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
        yield* promise(() => client.connect(new V2StdioTransport(server)))
        return client
      }),
      (client) => promise(() => client.close()).pipe(Effect.ignore)
    )
  }
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
