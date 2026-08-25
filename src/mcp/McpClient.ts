import { Effect, Stream } from "effect"
import * as McpToolkit from "./McpToolkit.js"
import type * as ClientPort from "./internal/clientPort.js"
import * as McpClientV2 from "./v2/McpClientV2.js"

export type ProtocolEra = ClientPort.ProtocolEra
export type Metadata = ClientPort.Metadata

/** A scoped official-client connection with SDK-neutral observations. */
export interface Connection extends McpToolkit.Connection {
  readonly metadata: Effect.Effect<Metadata>
  readonly toolListChanges: Stream.Stream<void>
  readonly close: Effect.Effect<void, McpToolkit.McpTransportError>
}

export interface ClientInfo {
  readonly name: string
  readonly version: string
}

export interface StreamableHttpOptions {
  readonly url: URL
  readonly clientInfo: ClientInfo
  /**
   * Sent with every request to the server.
   *
   * The reason this exists on the neutral surface rather than only on `/mcp/v2`:
   * an MCP server behind authentication is the ordinary case, and a plugin that
   * configures `headers` and has them silently dropped validates, loads, and
   * then fails to connect for a reason nothing reports. Carrying them here is
   * what makes the declared HTTP capability true.
   */
  readonly headers?: Record<string, string> | undefined
}

/**
 * Connect with the split v2 SDK and automatic modern/legacy negotiation.
 * Import `/mcp/v2` when official SDK-specific transport options are needed.
 */
export const streamableHttp = Effect.fn("McpClient.streamableHttp")(
  function* (options: StreamableHttpOptions) {
    return yield* McpClientV2.streamableHttp({
      url: options.url,
      clientInfo: options.clientInfo,
      // `requestInit` is where the SDK's transport takes per-request headers.
      // Omitted entirely when there are none, so the transport's own defaults
      // are not replaced by an empty object.
      ...(options.headers === undefined
        ? {}
        : { transportOptions: { requestInit: { headers: options.headers } } })
    })
  }
)

export interface StdioServer {
  readonly command: string
  readonly args?: Array<string>
  readonly env?: Record<string, string>
  readonly cwd?: string
}

export interface StdioOptions {
  readonly server: StdioServer
  readonly clientInfo: ClientInfo
}

/** Spawn a scoped MCP process with the split v2 SDK. */
export const stdio = Effect.fn("McpClient.stdio")(
  function* (options: StdioOptions) {
    return yield* McpClientV2.stdio(options)
  }
)
