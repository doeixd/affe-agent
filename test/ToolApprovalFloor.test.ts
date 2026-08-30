import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { McpToolkit } from "../src/mcp/index.js"
import { ToolSource } from "../src/toolSource/index.js"

/**
 * A source's approval hint must become the tool's own `needsApproval` -- the
 * thing `ToolExecution.intrinsicApproval` reads -- rather than an annotation
 * nothing consults. MCP hints only ever *tighten*: a declared tool that says
 * what it needs keeps its own answer.
 */
const connection = (tools: ReadonlyArray<McpToolkit.RemoteTool>): McpToolkit.Connection => ({
  listTools: Effect.succeed(tools),
  callTool: () => Effect.succeed(null)
})

const remote = (name: string, annotations?: McpToolkit.RemoteToolAnnotations): McpToolkit.RemoteTool => ({
  name,
  inputSchema: { type: "object" },
  ...(annotations === undefined ? {} : { annotations })
})

describe("approval floors from tool sources", () => {
  it("MCP hints: destructive by the server's own account asks; read-only, non-destructive, and silent do not", () => {
    assert.isTrue(McpToolkit.requiresApproval({}))
    assert.isTrue(McpToolkit.requiresApproval({ destructiveHint: true }))
    assert.isTrue(McpToolkit.requiresApproval({ openWorldHint: true }))
    assert.isFalse(McpToolkit.requiresApproval({ readOnlyHint: true }))
    assert.isFalse(McpToolkit.requiresApproval({ destructiveHint: false }))
    assert.isFalse(McpToolkit.requiresApproval(undefined))
  })

  it.effect("McpToolkit.bindDiscovered sets needsApproval from the hints", () =>
    Effect.gen(function* () {
      const toolkit = yield* McpToolkit.bindDiscovered([
        connection([remote("delete", { destructiveHint: true }), remote("read", { readOnlyHint: true }), remote("quiet")])
      ])
      assert.strictEqual(toolkit.tools.delete?.needsApproval, true)
      assert.strictEqual(toolkit.tools.read?.needsApproval, undefined)
      assert.strictEqual(toolkit.tools.quiet?.needsApproval, undefined)
    })
  )

  it.effect("McpToolkit.bind raises a declared tool's floor and never lowers one it set itself", () =>
    Effect.gen(function* () {
      const Delete = Tool.make("delete", { parameters: Schema.Struct({ id: Schema.String }), success: Schema.Void })
      const Trusted = Tool.make("trusted", {
        parameters: Schema.Struct({ id: Schema.String }),
        success: Schema.Void,
        needsApproval: false
      })
      const Read = Tool.make("read", { parameters: Schema.Struct({ id: Schema.String }), success: Schema.Void })
      const toolkit = yield* McpToolkit.bind(
        connection([remote("delete", {}), remote("trusted", {}), remote("read", { readOnlyHint: true })]),
        [Delete, Trusted, Read]
      )
      assert.strictEqual(toolkit.tools.delete.needsApproval, true)
      assert.strictEqual(toolkit.tools.trusted.needsApproval, false)
      assert.strictEqual(toolkit.tools.read.needsApproval, undefined)
      // The declarations themselves are untouched.
      assert.strictEqual(Delete.needsApproval, undefined)
    })
  )

  it.effect("ToolSource: requiresApproval becomes needsApproval on discovered and declared tools alike", () =>
    Effect.gen(function* () {
      const source: ToolSource.ToolSource = {
        id: "api",
        extract: Effect.succeed({
          tools: [
            { name: "create", input: { type: "object" }, annotations: { requiresApproval: true } },
            { name: "list", input: { type: "object" } }
          ],
          skipped: []
        }),
        invoke: () => Effect.succeed(null)
      }
      const discovered = yield* ToolSource.bindDiscovered(source)
      assert.strictEqual(discovered.tools.create?.needsApproval, true)
      assert.strictEqual(discovered.tools.list?.needsApproval, undefined)

      const Create = Tool.make("create", { parameters: Schema.Struct({}), success: Schema.Unknown })
      const List = Tool.make("list", { parameters: Schema.Struct({}), success: Schema.Unknown, needsApproval: true })
      const declared = yield* ToolSource.bind(source, [Create, List])
      assert.strictEqual(declared.tools.create.needsApproval, true)
      // A declared requirement stands even where the source asks nothing.
      assert.strictEqual(declared.tools.list.needsApproval, true)
    })
  )

  it.effect("ToolSource.fromMcpConnection carries the MCP hints across the seam", () =>
    Effect.gen(function* () {
      const source = ToolSource.fromMcpConnection("mcp", connection([remote("delete", {}), remote("read", { readOnlyHint: true })]))
      const extraction = yield* source.extract
      assert.deepStrictEqual(
        extraction.tools.map((tool) => [tool.name, tool.annotations?.requiresApproval === true]),
        [["delete", true], ["read", false]]
      )
    })
  )
})
