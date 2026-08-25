import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js"
import { Server as V1Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport as V1HttpTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { getRequestListener } from "@hono/node-server"
import {
  createMcpHandler,
  InMemoryServerEventBus,
  McpServer as V2Server,
  Server as V2Protocol,
  type CallToolResult,
  type ProtocolEra
} from "@modelcontextprotocol/server"
import { Deferred, Effect } from "effect"
import {
  createServer,
  type RequestListener,
  type Server as HttpServer
} from "node:http"
import { z } from "zod/v4"

export interface HttpFixture {
  readonly url: URL
}

export interface V2HttpFixture extends HttpFixture {
  /** One entry per request-created official v2 server instance. */
  readonly handledEras: ReadonlyArray<ProtocolEra>
  readonly notifyToolsChanged: () => void
  readonly slowStarted: Deferred.Deferred<void>
  readonly slowCancelled: Deferred.Deferred<void>
  readonly listenerCount: () => number
}

export interface PaginatedHttpFixture extends HttpFixture {
  readonly requestedCursors: ReadonlyArray<string | undefined>
}

const closeHttpServer = (server: HttpServer): Effect.Effect<void> =>
  Effect.callback((resume) => {
    server.close(() => resume(Effect.void))
    server.closeAllConnections()
  })

const listen = Effect.fn("McpHttpFixture.listen")(function* (
  handler: RequestListener
) {
  const server = createServer(handler)
  yield* Effect.addFinalizer(() => closeHttpServer(server))
  yield* Effect.callback<void>((resume) => {
    server.listen(0, "127.0.0.1", () => resume(Effect.void))
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    return yield* Effect.die(new Error("MCP HTTP fixture has no TCP address"))
  }
  return new URL(`http://127.0.0.1:${address.port}/mcp`)
})

const v1Server = (): V1Server => {
  const server = new V1Server(
    { name: "v1-http-fixture", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } }
  )
  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: [
        {
          name: "echo",
          description: "Echo a value through a v1 server",
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
        content: [{ type: "text", text: "v1 refused" }]
      })
    }
    return Promise.resolve({
      content: [
        {
          type: "text",
          text: String(request.params.arguments?.value)
        }
      ]
    })
  })
  return server
}

/** A real Node Streamable HTTP server backed by the monolithic v1 SDK. */
export const v1Http = Effect.fn("McpHttpFixture.v1Http")(function* () {
  const url = yield* listen(
    getRequestListener(
      async (request) => {
        const protocol = v1Server()
        const transport = new V1HttpTransport({ enableJsonResponse: true })
        await protocol.connect(transport)
        try {
          return await transport.handleRequest(request)
        } finally {
          await protocol.close()
        }
      },
      {
        errorHandler: (error) =>
          new Response(error instanceof Error ? error.stack : String(error), {
            status: 500
          })
      }
    )
  )
  return { url } satisfies HttpFixture
})

const makeV2Server = (
  slowStarted: Deferred.Deferred<void>,
  slowCancelled: Deferred.Deferred<void>
): V2Server => {
  const server = new V2Server(
    { name: "v2-http-fixture", version: "2.0.0" },
    { capabilities: { tools: { listChanged: true } } }
  )
  server.registerTool(
    "echo",
    {
      description: "Echo a value through a v2 server",
      inputSchema: { value: z.string() },
      outputSchema: { value: z.string() }
    },
    ({ value }) =>
      Promise.resolve({
        content: [{ type: "text", text: value }],
        structuredContent: { value }
      })
  )
  server.registerTool(
    "refuse",
    { inputSchema: { ignored: z.string().optional() } },
    () => {
      const result: CallToolResult = {
        isError: true,
        content: [{ type: "text", text: "v2 refused" }]
      }
      return result
    }
  )
  server.registerTool(
    "slow",
    { inputSchema: { ignored: z.string().optional() } },
    (_args, context) =>
      new Promise<CallToolResult>((resolve) => {
        Deferred.doneUnsafe(slowStarted, Effect.void)
        const onAbort = () => {
          Deferred.doneUnsafe(slowCancelled, Effect.void)
          resolve({
            isError: true,
            content: [{ type: "text", text: "slow call cancelled" }]
          })
        }
        if (context.mcpReq.signal.aborted) onAbort()
        else context.mcpReq.signal.addEventListener("abort", onAbort, { once: true })
      })
  )
  return server
}

/**
 * A real Node server using v2's modern handler and official stateless legacy
 * fallback. `handledEras` proves which path answered each request.
 */
export const v2Http = Effect.fn("McpHttpFixture.v2Http")(function* () {
  const handledEras: Array<ProtocolEra> = []
  const slowStarted = yield* Deferred.make<void>()
  const slowCancelled = yield* Deferred.make<void>()
  const bus = new InMemoryServerEventBus()
  const handler = createMcpHandler(({ era }) => {
    handledEras.push(era)
    return makeV2Server(slowStarted, slowCancelled)
  }, { bus })
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => handler.close()).pipe(Effect.ignore)
  )
  const url = yield* listen(
    getRequestListener((request) => handler.fetch(request))
  )
  return {
    url,
    handledEras,
    notifyToolsChanged: () => handler.notify.toolsChanged(),
    slowStarted,
    slowCancelled,
    listenerCount: () => bus.listenerCount
  } satisfies V2HttpFixture
})

/**
 * A modern server that records the headers of every request it receives.
 *
 * For the header-forwarding question specifically: configured headers were
 * decoded, validated and then dropped, so a plugin naming an authenticated
 * server loaded cleanly and failed to connect. The only way to know they
 * arrive is to be the server and look.
 */
export const v2HeaderRecordingHttp = Effect.fn(
  "McpHttpFixture.v2HeaderRecordingHttp"
)(function* () {
  const received: Array<Record<string, string>> = []
  const slowStarted = yield* Deferred.make<void>()
  const slowCancelled = yield* Deferred.make<void>()
  const handler = createMcpHandler(() => makeV2Server(slowStarted, slowCancelled))
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => handler.close()).pipe(Effect.ignore)
  )
  const url = yield* listen(
    getRequestListener((request) => {
      const headers: Record<string, string> = {}
      request.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })
      received.push(headers)
      return handler.fetch(request)
    })
  )
  return { url, received }
})

/** A modern low-level server whose tools/list response spans two pages. */
export const v2PaginatedHttp = Effect.fn(
  "McpHttpFixture.v2PaginatedHttp"
)(function* () {
  const requestedCursors: Array<string | undefined> = []
  const handler = createMcpHandler(() => {
    const server = new V2Protocol(
      { name: "v2-pagination-fixture", version: "2.0.0" },
      { capabilities: { tools: {} } }
    )
    server.setRequestHandler("tools/list", (request) => {
      const cursor = request.params?.cursor
      requestedCursors.push(cursor)
      return cursor === "page-2"
        ? {
            tools: [
              { name: "second", inputSchema: { type: "object" } }
            ]
          }
        : {
            tools: [
              { name: "first", inputSchema: { type: "object" } }
            ],
            nextCursor: "page-2"
          }
    })
    return server
  })
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => handler.close()).pipe(Effect.ignore)
  )
  const url = yield* listen(
    getRequestListener((request) => handler.fetch(request))
  )
  return { url, requestedCursors } satisfies PaginatedHttpFixture
})
