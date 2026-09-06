import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport as V1InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server as V1Server } from "@modelcontextprotocol/sdk/server/index.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js"
import {
  Client as V2Client,
  InMemoryTransport as V2InMemoryTransport
} from "@modelcontextprotocol/client"
import { McpServer as V2Server } from "@modelcontextprotocol/server"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Option, Scope, Stream } from "effect"
import { z as z4 } from "zod/v4"
import { McpClient, McpToolkit } from "../src/mcp/index.js"
import { McpClientV1 } from "../src/mcp/v1/index.js"
import { McpClientV2 } from "../src/mcp/v2/index.js"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false
type Assert<T extends true> = T

const promise = <A>(evaluate: () => PromiseLike<A>) => Effect.promise(evaluate)

describe("official MCP client adapters", () => {
  it("keeps scoped transport construction precisely typed", () => {
    type _CallToolError = Assert<
      Equal<
        Effect.Error<ReturnType<McpClient.Connection["callTool"]>>,
        | McpToolkit.McpTransportError
        | McpToolkit.McpToolError
        | McpToolkit.McpUnsupportedContentError
      >
    >

    const v1Http = McpClientV1.streamableHttp({
      url: new URL("http://localhost:3000/mcp"),
      clientInfo: { name: "type-test", version: "1.0.0" }
    })
    type _V1Success = Assert<
      Equal<Effect.Success<typeof v1Http>, McpClient.Connection>
    >
    type _V1Error = Assert<
      Equal<Effect.Error<typeof v1Http>, McpToolkit.McpTransportError>
    >
    type _V1Requirements = Assert<
      Equal<Effect.Services<typeof v1Http>, Scope.Scope>
    >

    const v1Stdio = McpClientV1.stdio({
      server: { command: process.execPath },
      clientInfo: { name: "type-test", version: "1.0.0" }
    })
    type _V1StdioSuccess = Assert<
      Equal<Effect.Success<typeof v1Stdio>, McpClient.Connection>
    >
    type _V1StdioError = Assert<
      Equal<Effect.Error<typeof v1Stdio>, McpToolkit.McpTransportError>
    >
    type _V1StdioRequirements = Assert<
      Equal<Effect.Services<typeof v1Stdio>, Scope.Scope>
    >

    const v2Http = McpClient.streamableHttp({
      url: new URL("http://localhost:3000/mcp"),
      clientInfo: { name: "type-test", version: "2.0.0" }
    })
    type _V2Success = Assert<
      Equal<Effect.Success<typeof v2Http>, McpClient.Connection>
    >
    type _V2Error = Assert<
      Equal<Effect.Error<typeof v2Http>, McpToolkit.McpTransportError>
    >
    type _V2Requirements = Assert<
      Equal<Effect.Services<typeof v2Http>, Scope.Scope>
    >

    const v2Stdio = McpClient.stdio({
      server: { command: process.execPath },
      clientInfo: { name: "type-test", version: "2.0.0" }
    })
    type _V2StdioSuccess = Assert<
      Equal<Effect.Success<typeof v2Stdio>, McpClient.Connection>
    >
    type _V2StdioError = Assert<
      Equal<Effect.Error<typeof v2Stdio>, McpToolkit.McpTransportError>
    >
    type _V2StdioRequirements = Assert<
      Equal<Effect.Services<typeof v2Stdio>, Scope.Scope>
    >

    assert.isTrue(Effect.isEffect(v1Http))
    assert.isTrue(Effect.isEffect(v1Stdio))
    assert.isTrue(Effect.isEffect(v2Http))
    assert.isTrue(Effect.isEffect(v2Stdio))
  })

  it.effect("adapts an SDK v1 client without leaking its nominal type", () =>
    Effect.gen(function* () {
      const server = new V1Server(
        { name: "v1-fixture", version: "1.0.0" },
        { capabilities: { tools: { listChanged: true } } }
      )
      server.setRequestHandler(ListToolsRequestSchema, () =>
        Promise.resolve({
          tools: [
            {
              name: "echo",
              description: "Echo a value",
              annotations: { title: "Echo", readOnlyHint: true, destructiveHint: false },
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"]
              }
            },
            { name: "refuse", inputSchema: { type: "object" } }
          ]
        })
      )
      server.setRequestHandler(CallToolRequestSchema, (request) => {
        if (request.params.name === "refuse") {
          return Promise.resolve({
            isError: true,
            content: [{ type: "text", text: "refused" }]
          })
        }
        const value = request.params.arguments?.value
        return Promise.resolve({
          content: [{ type: "text", text: String(value) }]
        })
      })
      const client = new V1Client({ name: "v1-client", version: "1.0.0" })
      const [clientTransport, serverTransport] =
        V1InMemoryTransport.createLinkedPair()
      yield* promise(() => server.connect(serverTransport))
      yield* promise(() => client.connect(clientTransport))

      const adapted = McpClientV1.fromSdkClient(client)
      type _Success = Assert<
        Equal<Effect.Success<typeof adapted>, McpClient.Connection>
      >
      type _Error = Assert<Equal<Effect.Error<typeof adapted>, never>>
      type _Requirements = Assert<
        Equal<Effect.Services<typeof adapted>, Scope.Scope>
      >

      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* adapted
          const tools = yield* connection.listTools
          assert.deepStrictEqual(
            tools.map((tool) => tool.name).sort(),
            ["echo", "refuse"]
          )
          assert.deepStrictEqual(tools.find((tool) => tool.name === "echo")?.annotations, {
            title: "Echo", readOnlyHint: true, destructiveHint: false
          })
          assert.strictEqual(tools.find((tool) => tool.name === "refuse")?.annotations, undefined)
          assert.deepStrictEqual(
            yield* connection.callTool("echo", { value: "hello" }),
            "hello"
          )
          const refused = yield* Effect.flip(
            connection.callTool("refuse", {})
          )
          if (refused._tag !== "McpToolError") {
            assert.fail(`expected McpToolError, got ${refused._tag}`)
          }
          assert.strictEqual(refused.error, "refused")

          const metadata = yield* connection.metadata
          assert.strictEqual(metadata.sdk, "v1")
          assert.deepStrictEqual(metadata.era, Option.some("legacy"))
          assert.deepStrictEqual(metadata.protocolVersion, Option.none())

          const changed = yield* connection.toolListChanges.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild
          )
          yield* Effect.yieldNow
          yield* promise(() => server.sendToolListChanged())
          assert.strictEqual((yield* Fiber.join(changed)).length, 1)
        })
      )

      yield* promise(() => server.close())
    })
  )

  it.effect("adapts an SDK v2 client through the same neutral connection", () =>
    Effect.gen(function* () {
      const server = new V2Server(
        { name: "v2-fixture", version: "2.0.0" },
        { capabilities: { tools: { listChanged: true } } }
      )
      server.registerTool(
        "echo",
        {
          description: "Echo a value",
          inputSchema: { value: z4.string() },
          outputSchema: { value: z4.string() }
        },
        ({ value }) =>
          Promise.resolve({
            content: [{ type: "text", text: value }],
            structuredContent: { value }
          })
      )
      const client = new V2Client(
        { name: "v2-client", version: "2.0.0" },
        { versionNegotiation: { mode: "legacy" } }
      )
      const [clientTransport, serverTransport] =
        V2InMemoryTransport.createLinkedPair()
      yield* promise(() => server.connect(serverTransport))
      yield* promise(() => client.connect(clientTransport))

      const adapted = McpClientV2.fromSdkClient(client)
      type _V2AdapterSuccess = Assert<
        Equal<Effect.Success<typeof adapted>, McpClient.Connection>
      >
      type _V2AdapterError = Assert<
        Equal<Effect.Error<typeof adapted>, McpToolkit.McpTransportError>
      >
      type _V2AdapterRequirements = Assert<
        Equal<Effect.Services<typeof adapted>, Scope.Scope>
      >
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* adapted
          assert.deepStrictEqual(
            yield* connection.callTool("echo", { value: "hello-v2" }),
            { value: "hello-v2" }
          )
          const metadata = yield* connection.metadata
          assert.strictEqual(metadata.sdk, "v2")
          assert.deepStrictEqual(metadata.era, Option.some("legacy"))
          assert.isTrue(Option.isSome(metadata.protocolVersion))
        })
      )

      yield* promise(() => server.close())

      if (false) {
        // @ts-expect-error SDK v2 clients cannot enter the v1 adapter.
        const invalidV1Adapter = McpClientV1.fromSdkClient(client)
        const v1 = new V1Client({ name: "wrong-client", version: "1.0.0" })
        // @ts-expect-error SDK v1 clients cannot enter the v2 adapter.
        const invalidV2Adapter = McpClientV2.fromSdkClient(v1)
        assert.isDefined(invalidV1Adapter)
        assert.isDefined(invalidV2Adapter)
      }
    })
  )
})
