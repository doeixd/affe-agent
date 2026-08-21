import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Option } from "effect"
import { McpClientV1 } from "../src/mcp/v1/index.js"
import { McpClientV2 } from "../src/mcp/v2/index.js"
import * as McpStdioFixture from "./mcp/stdioFixtures.js"

const clientInfo = { name: "effect-harness-conformance", version: "1.0.0" }

const assertToolsAndRefusal = Effect.fn(
  "McpStdioCompatibility.assertToolsAndRefusal"
)(function* (
  connection: Effect.Success<ReturnType<typeof McpClientV1.stdio>>,
  expectedTools: ReadonlyArray<string>,
  expectedEcho: string | Readonly<Record<string, unknown>>,
  expectedRefusal: string
) {
  assert.deepStrictEqual(
    (yield* connection.listTools).map((tool) => tool.name).sort(),
    expectedTools
  )
  assert.deepStrictEqual(
    yield* connection.callTool("echo", { value: "stdio" }),
    expectedEcho
  )
  const refusal = yield* Effect.flip(connection.callTool("refuse", {}))
  if (refusal._tag !== "McpToolError") {
    return yield* Effect.die(
      new Error(`expected McpToolError, got ${refusal._tag}`)
    )
  }
  assert.strictEqual(refusal.error, expectedRefusal)
})

describe("MCP stdio compatibility", () => {
  it.effect("connects a v1 client to a v1 server and reaps the process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* McpStdioFixture.make("v1")
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* McpClientV1.stdio({
              server: fixture.server,
              clientInfo
            })
            yield* assertToolsAndRefusal(
              connection,
              ["echo", "refuse"],
              "stdio",
              "v1 stdio refused"
            )
            const metadata = yield* connection.metadata
            assert.strictEqual(metadata.sdk, "v1")
            assert.deepStrictEqual(metadata.era, Option.some("legacy"))
          })
        )
        const events = yield* fixture.waitFor(McpStdioFixture.sessionExited)
        assert.deepStrictEqual(events, [
          "started",
          "era:legacy",
          "connected",
          "session:exited"
        ])
      })
    )
  )

  it.effect("connects a v1 client to the v2 legacy stdio server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* McpStdioFixture.make("v2")
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* McpClientV1.stdio({
              server: fixture.server,
              clientInfo
            })
            yield* assertToolsAndRefusal(
              connection,
              ["echo", "refuse", "slow"],
              { value: "stdio" },
              "v2 stdio refused"
            )
            const metadata = yield* connection.metadata
            assert.strictEqual(metadata.sdk, "v1")
            assert.deepStrictEqual(metadata.era, Option.some("legacy"))
          })
        )
        const events = yield* fixture.waitFor(McpStdioFixture.sessionExited)
        assert.include(events, "era:legacy")
        assert.notInclude(events, "era:modern")
      })
    )
  )

  it.effect("falls a v2 auto client back to a v1 stdio server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* McpStdioFixture.make("v1")
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* McpClientV2.stdio({
              server: fixture.server,
              clientInfo,
              clientOptions: {
                versionNegotiation: {
                  mode: "auto",
                  probe: { timeoutMs: 200 }
                }
              }
            })
            yield* assertToolsAndRefusal(
              connection,
              ["echo", "refuse"],
              "stdio",
              "v1 stdio refused"
            )
            const metadata = yield* connection.metadata
            assert.strictEqual(metadata.sdk, "v2")
            assert.deepStrictEqual(metadata.era, Option.some("legacy"))
            assert.deepStrictEqual(
              metadata.protocolVersion,
              Option.some("2025-11-25")
            )
          })
        )
        const events = yield* fixture.waitFor(McpStdioFixture.sessionExited)
        assert.isTrue(
          events.filter((event) => event === "era:legacy").length >= 1
        )
      })
    )
  )

  it.effect("negotiates modern stdio, propagates interruption, and cleans up", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* McpStdioFixture.make("v2")
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* McpClientV2.stdio({
              server: fixture.server,
              clientInfo
            })
            yield* assertToolsAndRefusal(
              connection,
              ["echo", "refuse", "slow"],
              { value: "stdio" },
              "v2 stdio refused"
            )
            const metadata = yield* connection.metadata
            assert.strictEqual(metadata.sdk, "v2")
            assert.deepStrictEqual(metadata.era, Option.some("modern"))
            assert.deepStrictEqual(
              metadata.protocolVersion,
              Option.some("2026-07-28")
            )

            const slow = yield* connection.callTool("slow", {}).pipe(
              Effect.forkChild({ startImmediately: true })
            )
            yield* fixture.waitFor(McpStdioFixture.includes("slow:started"))
            yield* Fiber.interrupt(slow)
            yield* fixture.waitFor(McpStdioFixture.includes("slow:cancelled"))
          })
        )
        const events = yield* fixture.waitFor(McpStdioFixture.sessionExited)
        assert.include(events, "era:modern")
        assert.notInclude(events, "era:legacy")
      })
    )
  )
})
