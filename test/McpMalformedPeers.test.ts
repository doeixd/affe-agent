import {
  Client as V1Client
} from "@modelcontextprotocol/sdk/client/index.js"
import type { Transport as V1Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import {
  LATEST_PROTOCOL_VERSION as V1ProtocolVersion,
  type JSONRPCMessage as V1Message
} from "@modelcontextprotocol/sdk/types.js"
import {
  Client as V2Client,
  type JSONRPCMessage as V2Message,
  type Transport as V2Transport
} from "@modelcontextprotocol/client"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import { McpToolkit } from "../src/mcp/index.js"
import type * as ClientPort from "../src/mcp/internal/clientPort.js"
import * as Connection from "../src/mcp/internal/connection.js"
import { McpClientV1 } from "../src/mcp/v1/index.js"
import { McpClientV2 } from "../src/mcp/v2/index.js"

type PeerMode =
  | "malformed-list"
  | "malformed-call"
  | "structured-mismatch"
  | "structured-only"
  | "rich-content"
  | "resource-link"
  | "embedded-resource"
  | "disconnect-call"

const tool = {
  name: "echo",
  inputSchema: {
    type: "object" as const,
    properties: { value: { type: "string" as const } },
    required: ["value"]
  }
}

class V1MalformedTransport implements V1Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage: NonNullable<V1Transport["onmessage"]> = () => {}
  closeCount = 0

  constructor(readonly mode: PeerMode) {}

  start(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.closeCount += 1
    this.onclose?.()
    return Promise.resolve()
  }

  send(message: V1Message): Promise<void> {
    if (!("method" in message) || !("id" in message)) {
      return Promise.resolve()
    }
    if (message.method === "initialize") {
      this.onmessage?.({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: V1ProtocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "malformed-v1-peer", version: "1.0.0" }
        }
      })
    } else if (message.method === "tools/list") {
      this.onmessage?.({
        jsonrpc: "2.0",
        id: message.id,
        result: this.mode === "malformed-list"
          ? { tools: "not-an-array" }
          : { tools: [tool] }
      })
    } else if (message.method === "tools/call") {
      if (this.mode === "disconnect-call") {
        queueMicrotask(() => this.onclose?.())
      } else {
        this.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: this.mode === "malformed-call"
            ? { content: "not-an-array" }
            : { content: [{ type: "text", text: "v1 response" }] }
        })
      }
    }
    return Promise.resolve()
  }
}

class V2MalformedTransport implements V2Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: V2Transport["onmessage"]
  closeCount = 0
  disconnected = false

  constructor(readonly mode: PeerMode) {}

  start(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.closeCount += 1
    this.onclose?.()
    return Promise.resolve()
  }

  send(message: V2Message): Promise<void> {
    if (!("method" in message) || !("id" in message)) {
      return Promise.resolve()
    }
    if (message.method === "initialize") {
      this.onmessage?.({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "malformed-v2-peer", version: "2.0.0" }
        }
      })
    } else if (message.method === "tools/list") {
      this.onmessage?.({
        jsonrpc: "2.0",
        id: message.id,
        result: this.mode === "malformed-list"
          ? { tools: "not-an-array" }
          : { tools: [tool] }
      })
    } else if (message.method === "tools/call") {
      if (this.mode === "disconnect-call") {
        queueMicrotask(() => {
          this.disconnected = true
          this.onclose?.()
        })
      } else if (this.mode === "malformed-call") {
        this.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: "not-an-array" }
        })
      } else if (this.mode === "structured-mismatch") {
        this.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: "fallback" }],
            structuredContent: { wrong: true }
          }
        })
      } else if (this.mode === "structured-only") {
        this.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [],
            structuredContent: { value: "structured" }
          }
        })
      } else if (this.mode === "rich-content") {
        this.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{
              type: "image",
              data: "aW1hZ2U=",
              mimeType: "image/png"
            }]
          }
        })
      } else if (this.mode === "resource-link") {
        this.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{
              type: "resource_link",
              name: "notes",
              uri: "file:///notes.txt"
            }]
          }
        })
      } else if (this.mode === "embedded-resource") {
        this.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{
              type: "resource",
              resource: {
                uri: "file:///notes.txt",
                mimeType: "text/plain",
                text: "notes"
              }
            }]
          }
        })
      } else {
        this.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: "v2 response" }] }
        })
      }
    }
    return Promise.resolve()
  }
}

const v1Connection = Effect.fn("McpMalformedPeers.v1Connection")(function* (
  mode: PeerMode
) {
  const transport = new V1MalformedTransport(mode)
  const client = new V1Client({ name: "malformed-test", version: "1.0.0" })
  yield* Effect.promise(() => client.connect(transport))
  return { connection: yield* McpClientV1.fromSdkClient(client), transport }
})

const v2Connection = Effect.fn("McpMalformedPeers.v2Connection")(function* (
  mode: PeerMode
) {
  const transport = new V2MalformedTransport(mode)
  const client = new V2Client(
    { name: "malformed-test", version: "2.0.0" },
    { versionNegotiation: { mode: "legacy" } }
  )
  yield* Effect.promise(() => client.connect(transport))
  return { connection: yield* McpClientV2.fromSdkClient(client), transport }
})

const StructuredEcho = Tool.make("echo", {
  parameters: Schema.Struct({ value: Schema.String }),
  success: Schema.Struct({ value: Schema.String })
})

describe("malformed MCP peers", () => {
  it.effect("rejects a repeated pagination cursor instead of looping", () =>
    Effect.gen(function* () {
      const requestedCursors: Array<Option.Option<string>> = []
      const port: ClientPort.ClientPort = {
        metadata: Effect.succeed({
          sdk: "v1",
          era: Option.some("legacy"),
          protocolVersion: Option.none(),
          serverCapabilities: Option.none()
        }),
        listTools: (cursor) => {
          requestedCursors.push(cursor)
          return Effect.succeed({
            tools: [],
            nextCursor: Option.some("loop")
          })
        },
        callTool: () => Effect.die(new Error("not used")),
        toolListChanges: Stream.empty,
        close: Effect.void
      }
      const error = yield* Effect.flip(Connection.fromPort(port).listTools)
      assert.strictEqual(error._tag, "McpTransportError")
      assert.include(error.detail, "repeated pagination cursor loop")
      assert.deepStrictEqual(requestedCursors, [
        Option.none(),
        Option.some("loop")
      ])
    })
  )

  it.effect("turns malformed v1 discovery into a typed transport error", () =>
    Effect.gen(function* () {
      let transport: V1MalformedTransport | undefined
      yield* Effect.scoped(
        Effect.gen(function* () {
          const acquired = yield* v1Connection("malformed-list")
          transport = acquired.transport
          const error = yield* Effect.flip(acquired.connection.listTools)
          assert.strictEqual(error._tag, "McpTransportError")
          assert.include(error.detail, "v1 tools/list")
        })
      )
      assert.isDefined(transport)
      assert.strictEqual(transport.closeCount, 1)
    })
  )

  it.effect("turns malformed v2 discovery into a typed transport error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { connection } = yield* v2Connection("malformed-list")
        const error = yield* Effect.flip(connection.listTools)
        assert.strictEqual(error._tag, "McpTransportError")
        assert.include(error.detail, "v2 tools/list")
      })
    )
  )

  it.effect("turns malformed v1 invocation into a typed transport error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { connection } = yield* v1Connection("malformed-call")
        const error = yield* Effect.flip(
          connection.callTool("echo", { value: "hello" })
        )
        if (error._tag !== "McpTransportError") {
          assert.fail(`expected McpTransportError, got ${error._tag}`)
        }
        assert.include(error.detail, "v1 tools/call")
      })
    )
  )

  it.effect("turns malformed v2 invocation into a typed transport error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { connection } = yield* v2Connection("malformed-call")
        const error = yield* Effect.flip(
          connection.callTool("echo", { value: "hello" })
        )
        if (error._tag !== "McpTransportError") {
          assert.fail(`expected McpTransportError, got ${error._tag}`)
        }
        assert.include(error.detail, "v2 tools/call")
      })
    )
  )

  it.effect("prefers structured output and rejects a declared-schema mismatch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { connection } = yield* v2Connection("structured-mismatch")
        const toolkit = yield* McpToolkit.bind(connection, [StructuredEcho])
        const error = yield* Effect.flip(
          Effect.flatMap(
            toolkit.handle("echo", { value: "hello" }),
            Stream.runCollect
          )
        )
        assert.include(String(error), "declared schema")
        assert.notInclude(String(error), "fallback")
      })
    )
  )

  it.effect("accepts valid structured output without a text representation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { connection } = yield* v2Connection("structured-only")
        assert.deepStrictEqual(
          yield* connection.callTool("echo", { value: "hello" }),
          { value: "structured" }
        )
      })
    )
  )

  it.effect("rejects rich content explicitly instead of discarding it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { connection } = yield* v2Connection("rich-content")
        const error = yield* Effect.flip(
          connection.callTool("echo", { value: "hello" })
        )
        assert.strictEqual(error._tag, "McpUnsupportedContentError")
        if (error._tag === "McpUnsupportedContentError") {
          assert.strictEqual(error.toolName, "echo")
          assert.deepStrictEqual(error.contentTypes, ["image"])
        }

        const toolkit = yield* McpToolkit.bind(connection, [StructuredEcho])
        const boundError = yield* Effect.flip(
          Effect.flatMap(
            toolkit.handle("echo", { value: "hello" }),
            Stream.runCollect
          )
        )
        assert.include(String(boundError), "unsupported content: image")
      })
    )
  )

  it.effect("names unsupported resource links without leaking SDK values", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { connection } = yield* v2Connection("resource-link")
        const error = yield* Effect.flip(
          connection.callTool("echo", { value: "hello" })
        )
        if (error._tag !== "McpUnsupportedContentError") {
          assert.fail(`expected McpUnsupportedContentError, got ${error._tag}`)
        }
        assert.deepStrictEqual(error.contentTypes, ["resource_link"])
      })
    )
  )

  it.effect("names unsupported embedded resources without discarding them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { connection } = yield* v2Connection("embedded-resource")
        const error = yield* Effect.flip(
          connection.callTool("echo", { value: "hello" })
        )
        if (error._tag !== "McpUnsupportedContentError") {
          assert.fail(`expected McpUnsupportedContentError, got ${error._tag}`)
        }
        assert.deepStrictEqual(error.contentTypes, ["resource"])
      })
    )
  )

  it.effect("turns an invocation disconnect into a typed error and closes", () =>
    Effect.gen(function* () {
      let transport: V2MalformedTransport | undefined
      yield* Effect.scoped(
        Effect.gen(function* () {
          const acquired = yield* v2Connection("disconnect-call")
          transport = acquired.transport
          const error = yield* Effect.flip(
            acquired.connection.callTool("echo", { value: "hello" })
          )
          if (error._tag !== "McpTransportError") {
            assert.fail(`expected McpTransportError, got ${error._tag}`)
          }
          assert.include(error.detail, "v2 tools/call")
        })
      )
      assert.isDefined(transport)
      assert.isTrue(transport.disconnected)
    })
  )
})
