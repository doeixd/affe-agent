import { Effect, Option, Stream } from "effect"
import type * as McpToolkit from "../McpToolkit.js"

/** The two wire behavior families normalized across SDK generations. */
export type ProtocolEra = "legacy" | "modern"

/** SDK-neutral connection facts. Absence is explicit because connect owns them. */
export interface Metadata {
  readonly sdk: "v1" | "v2"
  readonly era: Option.Option<ProtocolEra>
  readonly protocolVersion: Option.Option<string>
  readonly serverCapabilities: Option.Option<unknown>
}

export interface ToolPage {
  readonly tools: ReadonlyArray<McpToolkit.RemoteTool>
  readonly nextCursor: Option.Option<string>
}

export interface ToolResult {
  readonly isError: boolean
  readonly structuredContent: Option.Option<unknown>
  readonly content: unknown
}

/**
 * The only shape shared by the v1 and v2 integrations.
 *
 * No official SDK class, Zod schema, transport, or error crosses this seam.
 * Each generation translates its nominal types here inside its own module.
 */
export interface ClientPort {
  readonly metadata: Effect.Effect<Metadata>
  readonly listTools: (
    cursor: Option.Option<string>
  ) => Effect.Effect<ToolPage, McpToolkit.McpTransportError>
  readonly callTool: (
    name: string,
    params: Readonly<Record<string, unknown>>
  ) => Effect.Effect<ToolResult, McpToolkit.McpTransportError>
  /** Notifications already delivered by the connected SDK client. */
  readonly toolListChanges: Stream.Stream<void>
  readonly close: Effect.Effect<void, McpToolkit.McpTransportError>
}
