import { Effect, Option } from "effect"
import type * as McpClient from "../McpClient.js"
import * as McpToolkit from "../McpToolkit.js"
import type * as ClientPort from "./clientPort.js"

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const contentTypes = (content: unknown): ReadonlyArray<string> =>
  Array.isArray(content)
    ? content.map((part) =>
        isRecord(part) && typeof part.type === "string"
          ? part.type
          : "unknown"
      )
    : ["invalid"]

const contentValue = (
  name: string,
  content: unknown
): Effect.Effect<unknown, McpToolkit.McpUnsupportedContentError> => {
  if (!Array.isArray(content) || content.length !== 1) {
    return Effect.fail(
      new McpToolkit.McpUnsupportedContentError({
        toolName: name,
        contentTypes: contentTypes(content)
      })
    )
  }
  const only = content[0]
  return isRecord(only) && only.type === "text" && typeof only.text === "string"
    ? Effect.succeed(only.text)
    : Effect.fail(
        new McpToolkit.McpUnsupportedContentError({
          toolName: name,
          contentTypes: contentTypes(content)
        })
      )
}

const validateSupplementaryContent = (
  name: string,
  content: unknown
): Effect.Effect<void, McpToolkit.McpUnsupportedContentError> =>
  Array.isArray(content) && content.every((part) =>
    isRecord(part) && part.type === "text" && typeof part.text === "string"
  )
    ? Effect.void
    : Effect.fail(
        new McpToolkit.McpUnsupportedContentError({
          toolName: name,
          contentTypes: contentTypes(content)
        })
      )

/** Adapt the one internal port to the public SDK-neutral connection. */
export const fromPort = (port: ClientPort.ClientPort): McpClient.Connection => ({
  metadata: port.metadata,
  toolListChanges: port.toolListChanges,
  close: port.close,
  listTools: Effect.gen(function* () {
    const tools: Array<McpToolkit.RemoteTool> = []
    const seenCursors = new Set<string>()
    let cursor = Option.none<string>()
    do {
      const page = yield* port.listTools(cursor)
      tools.push(...page.tools)
      cursor = page.nextCursor
      if (Option.isSome(cursor)) {
        if (seenCursors.has(cursor.value)) {
          return yield* new McpToolkit.McpTransportError({
            detail: `MCP tools/list repeated pagination cursor ${cursor.value}`
          })
        }
        seenCursors.add(cursor.value)
      }
    } while (Option.isSome(cursor))
    return tools
  }),
  callTool: Effect.fn("McpClient.callTool")(function* (name, params) {
    if (!isRecord(params)) {
      return yield* new McpToolkit.McpTransportError({
        detail: `MCP tool ${name} parameters must encode to an object`
      })
    }
    const result = yield* port.callTool(name, params)
    const value = yield* Option.match(
      result.structuredContent,
      {
        onNone: () => contentValue(name, result.content),
        onSome: (structured) =>
          validateSupplementaryContent(name, result.content).pipe(
            Effect.as(structured)
          )
      }
    )
    if (result.isError) {
      return yield* new McpToolkit.McpToolError({ error: value })
    }
    return value
  })
})
