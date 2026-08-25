import {
  Client,
  StreamableHTTPClientTransport,
  type ClientOptions,
  type Implementation,
  type RequestOptions,
  type StreamableHTTPClientTransportOptions
} from "@modelcontextprotocol/client"
import type { StdioServerParameters } from "@modelcontextprotocol/client/stdio"
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
        detail: `v2 ${operation}: ${detail}`
      })
    }
  })

const ownClient = Effect.fn("McpClientV2.ownClient")(function* (
  client: Client
) {
  const closed = yield* Ref.make(false)
  const close = Ref.modify(
    closed,
    (alreadyClosed): readonly [boolean, boolean] =>
      alreadyClosed ? [false, true] : [true, true]
  ).pipe(
    Effect.flatMap((shouldClose) =>
      shouldClose
        ? sdkEffect("close", () => client.close())
        : Effect.void
    )
  )
  yield* Effect.addFinalizer(() => close.pipe(Effect.ignore))
  return { close }
})

const adaptClient = Effect.fn("McpClientV2.adaptClient")(function* (
  client: Client,
  close: Effect.Effect<void, McpToolkit.McpTransportError>
) {
    const changes = yield* PubSub.unbounded<void>()
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes))

    client.setNotificationHandler(
      "notifications/tools/list_changed",
      () => void PubSub.publishUnsafe(changes, void 0)
    )

    if (
      client.getProtocolEra() === "modern" &&
      client.getServerCapabilities()?.tools?.listChanged === true
    ) {
      const subscription = yield* sdkEffect(
        "subscriptions/listen",
        (signal) => client.listen({ toolsListChanged: true }, { signal })
      )
      yield* Effect.addFinalizer(() =>
        sdkEffect("subscriptions/close", () => subscription.close()).pipe(
          Effect.ignore
        )
      )
    }

    const listTools = Effect.fn("McpClientV2.listTools")(function* (
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

    const callTool = Effect.fn("McpClientV2.callTool")(function* (
      name: string,
      params: Readonly<Record<string, unknown>>
    ) {
      const result = yield* sdkEffect("tools/call", (signal) =>
        client.callTool({ name, arguments: params }, { signal })
      )
      return {
        isError: result.isError === true,
        structuredContent: Option.fromUndefinedOr(result.structuredContent),
        content: result.content
      } satisfies ClientPort.ToolResult
    })

    return Connection.fromPort({
      metadata: Effect.sync(() => ({
        sdk: "v2",
        era: Option.fromUndefinedOr(client.getProtocolEra()),
        protocolVersion: Option.fromUndefinedOr(
          client.getNegotiatedProtocolVersion()
        ),
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

/** Adapt an already-connected official split-package SDK v2 client. */
export const fromSdkClient = Effect.fn("McpClientV2.fromSdkClient")(
  function* (client: Client) {
    const { close } = yield* ownClient(client)
    return yield* adaptClient(client, close)
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

/**
 * Connect a scoped split-SDK client over Streamable HTTP.
 *
 * Automatic negotiation is the default so one client can discover a modern
 * server and fall back to the legacy initialize handshake. Callers may choose
 * an explicit mode through `clientOptions.versionNegotiation`.
 */
export const streamableHttp = Effect.fn("McpClientV2.streamableHttp")(
  function* (options: StreamableHttpOptions) {
    const client = new Client(options.clientInfo, {
      versionNegotiation: { mode: "auto" },
      ...options.clientOptions
    })
    const { close } = yield* ownClient(client)
    const transport = new StreamableHTTPClientTransport(
      options.url,
      options.transportOptions
    )
    yield* sdkEffect("connect", () => client.connect(transport))
    return yield* adaptClient(client, close)
  }
)

export interface StdioOptions extends ConnectOptions {
  readonly server: StdioServerParameters
}

/** Spawn and own a scoped split-SDK MCP server process. */
export const stdio = Effect.fn("McpClientV2.stdio")(
  function* (options: StdioOptions) {
    const client = new Client(options.clientInfo, {
      versionNegotiation: { mode: "auto" },
      ...options.clientOptions
    })
    const { close } = yield* ownClient(client)
    // Loaded on demand. The stdio transport spawns a subprocess, which is a
    // host capability; importing it at module level would make this whole
    // entry depend on `node:process` just by being imported, including for
    // a consumer that only ever connects over HTTP.
    const { StdioClientTransport } = yield* sdkEffect(
      "load stdio transport",
      () => import("@modelcontextprotocol/client/stdio")
    )
    const transport = new StdioClientTransport(options.server)
    yield* sdkEffect("connect", () => client.connect(transport))
    return yield* adaptClient(client, close)
  }
)
