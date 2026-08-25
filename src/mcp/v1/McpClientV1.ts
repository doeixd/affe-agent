import {
  Client,
  type ClientOptions
} from "@modelcontextprotocol/sdk/client/index.js"
import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions
} from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import type { Implementation } from "@modelcontextprotocol/sdk/types.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js"
import { Effect, Option, PubSub, Ref, Stream } from "effect"
import * as McpToolkit from "../McpToolkit.js"
import type * as ClientPort from "../internal/clientPort.js"
import * as Connection from "../internal/connection.js"

const sdkEffect = <A>(
  operation: string,
  evaluate: (signal: NonNullable<RequestOptions["signal"]>) => Promise<A>
): Effect.Effect<A, McpToolkit.McpTransportError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => {
      const detail = cause instanceof Error && "code" in cause
        ? `${cause.name}: ${cause.message} (code ${String(cause.code)})`
        : String(cause)
      return new McpToolkit.McpTransportError({
        detail: `v1 ${operation}: ${detail}`
      })
    }
  })

/**
 * Adapt an already-connected official monolithic SDK v1 client.
 *
 * The returned connection owns `client` until its Effect scope closes.
 */
export const fromSdkClient = Effect.fn("McpClientV1.fromSdkClient")(
  function* (client: Client) {
    const changes = yield* PubSub.unbounded<void>()
    const closed = yield* Ref.make(false)

    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      PubSub.publishUnsafe(changes, void 0)
    })

    const close = Ref.modify(closed, (alreadyClosed): readonly [boolean, boolean] =>
      alreadyClosed
        ? [false, true]
        : [true, true]
    ).pipe(
      Effect.flatMap((shouldClose) =>
        shouldClose
          ? sdkEffect("close", () => client.close())
          : Effect.void
      )
    )

    yield* Effect.addFinalizer(() =>
      close.pipe(
        Effect.ignore,
        Effect.andThen(PubSub.shutdown(changes))
      )
    )

    const listTools = Effect.fn("McpClientV1.listTools")(function* (
      cursor: Option.Option<string>
    ) {
      const result = yield* sdkEffect("tools/list", (signal) =>
        client.listTools(
          Option.match(cursor, {
            onNone: () => undefined,
            onSome: (value) => ({ cursor: value })
          }),
          { signal }
        )
      )
      return {
        tools: result.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description === undefined
            ? {}
            : { description: tool.description }),
          inputSchema: tool.inputSchema
        })),
        nextCursor: Option.fromUndefinedOr(result.nextCursor)
      } satisfies ClientPort.ToolPage
    })

    const callTool = Effect.fn("McpClientV1.callTool")(function* (
      name: string,
      params: Readonly<Record<string, unknown>>
    ) {
      const result = yield* sdkEffect("tools/call", (signal) =>
        client.callTool(
          { name, arguments: params },
          undefined,
          { signal }
        )
      )
      return {
        isError: result.isError === true,
        structuredContent: Option.fromUndefinedOr(
          "structuredContent" in result
            ? result.structuredContent
            : undefined
        ),
        content: result.content
      } satisfies ClientPort.ToolResult
    })

    return Connection.fromPort({
      metadata: Effect.sync(() => ({
        sdk: "v1",
        era: Option.some<ClientPort.ProtocolEra>("legacy"),
        protocolVersion: Option.none(),
        serverCapabilities: Option.fromUndefinedOr(
          client.getServerCapabilities()
        )
      } satisfies ClientPort.Metadata)),
      listTools,
      callTool,
      toolListChanges: Stream.fromPubSub(changes),
      close
    })
  }
)

interface ConnectOptions {
  readonly clientInfo: Implementation
  readonly clientOptions?: ClientOptions
}

export interface StreamableHttpOptions extends ConnectOptions {
  readonly url: ConstructorParameters<typeof StreamableHTTPClientTransport>[0]
  readonly transportOptions?: StreamableHTTPClientTransportOptions
}

/** Connect a scoped monolithic-SDK client over Streamable HTTP. */
export const streamableHttp = Effect.fn("McpClientV1.streamableHttp")(
  function* (options: StreamableHttpOptions) {
    const client = new Client(options.clientInfo, options.clientOptions)
    const connection = yield* fromSdkClient(client)
    const transport = new StreamableHTTPClientTransport(
      options.url,
      options.transportOptions
    )
    yield* sdkEffect("connect", () =>
      // The SDK's concrete transport declares `sessionId: string | undefined`
      // while its Transport interface declares `sessionId?: string`. Those are
      // runtime-equivalent but not assignable under exactOptionalPropertyTypes.
      // Keep the upstream declaration mismatch inside this versioned adapter.
      client.connect(transport as Transport)
    )
    return connection
  }
)

export interface StdioOptions extends ConnectOptions {
  readonly server: StdioServerParameters
}

/** Spawn and own a scoped monolithic-SDK MCP server process. */
export const stdio = Effect.fn("McpClientV1.stdio")(
  function* (options: StdioOptions) {
    const client = new Client(options.clientInfo, options.clientOptions)
    const connection = yield* fromSdkClient(client)
    // Loaded on demand: the stdio transport is a host capability (it spawns
    // a process), and must not be the price of importing this entry.
    const { StdioClientTransport } = yield* sdkEffect(
      "load stdio transport",
      () => import("@modelcontextprotocol/sdk/client/stdio.js")
    )
    const transport = new StdioClientTransport(options.server)
    yield* sdkEffect("connect", () => client.connect(transport))
    return connection
  }
)
