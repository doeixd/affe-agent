import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref, Stream } from "effect"
import { McpToolkit } from "../src/mcp/index.js"

/**
 * McpToolkit.bindDiscovered: binding a server's runtime tool list (no local
 * declarations) as dynamic tools. Verified against a fake connection so no real
 * MCP server is needed.
 */

interface Call {
  readonly name: string
  readonly params: unknown
}

const fakeConnection = (
  tools: ReadonlyArray<McpToolkit.RemoteTool>,
  onCall: (call: Call) => Effect.Effect<unknown, McpToolkit.McpToolError | McpToolkit.McpTransportError>
): McpToolkit.Connection => ({
  listTools: Effect.succeed(tools),
  callTool: (name, params) => onCall({ name, params })
})

const echo: McpToolkit.RemoteTool = {
  name: "echo",
  description: "Echo the input",
  inputSchema: { type: "object", properties: { text: { type: "string" } } }
}
const add: McpToolkit.RemoteTool = { name: "add", inputSchema: { type: "object" } }

describe("McpToolkit.bindDiscovered", () => {
  it.effect("binds every discovered tool and routes calls to the connection", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([])
      const connection = fakeConnection([echo, add], (call) =>
        Ref.update(calls, (all) => [...all, call]).pipe(Effect.as({ echoed: call.params })))

      const toolkit = yield* McpToolkit.bindDiscovered([connection])
      assert.deepStrictEqual(Object.keys(toolkit.tools).sort(), ["add", "echo"])

      const stream = yield* toolkit.handle("echo", { text: "hi" })
      yield* Stream.runDrain(stream)
      assert.deepStrictEqual(yield* Ref.get(calls), [{ name: "echo", params: { text: "hi" } }])
    })
  )

  it.effect("a server-reported failure surfaces rather than becoming a defect", () =>
    Effect.gen(function* () {
      const connection = fakeConnection([echo], () =>
        Effect.fail(new McpToolkit.McpToolError({ error: "refused" })))

      const toolkit = yield* McpToolkit.bindDiscovered([connection])
      const exit = yield* toolkit.handle("echo", {}).pipe(
        Effect.flatMap(Stream.runDrain),
        Effect.exit
      )
      assert.isTrue(exit._tag === "Failure")
    })
  )

  it.effect("combines multiple connections; first to offer a name wins", () =>
    Effect.gen(function* () {
      const first = fakeConnection([echo], () => Effect.succeed("from-first"))
      const second = fakeConnection([{ name: "echo", inputSchema: { type: "object" } }, add], () =>
        Effect.succeed("from-second"))

      const toolkit = yield* McpToolkit.bindDiscovered([first, second])
      assert.deepStrictEqual(Object.keys(toolkit.tools).sort(), ["add", "echo"])
    })
  )
})
