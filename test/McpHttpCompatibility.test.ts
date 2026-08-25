import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option, Stream } from "effect"
import * as McpClient from "../src/mcp/McpClient.js"
import { McpClientV1 } from "../src/mcp/v1/index.js"
import { McpClientV2 } from "../src/mcp/v2/index.js"
import * as McpHttpFixture from "./mcp/httpFixtures.js"

const clientInfo = { name: "effect-harness-conformance", version: "1.0.0" }

const assertOnlyEra = (
  eras: ReadonlyArray<"legacy" | "modern">,
  expected: "legacy" | "modern"
) => {
  assert.isAbove(eras.length, 0)
  assert.isTrue(eras.every((era) => era === expected))
}

describe("MCP Streamable HTTP compatibility", () => {
  it.effect("connects a v1 client to a v1 server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* McpHttpFixture.v1Http()
        const connection = yield* McpClientV1.streamableHttp({
          url: fixture.url,
          clientInfo
        })

        assert.deepStrictEqual(
          (yield* connection.listTools).map((tool) => tool.name).sort(),
          ["echo", "refuse"]
        )
        assert.strictEqual(
          yield* connection.callTool("echo", { value: "v1-v1" }),
          "v1-v1"
        )
        const metadata = yield* connection.metadata
        assert.strictEqual(metadata.sdk, "v1")
        assert.deepStrictEqual(metadata.era, Option.some("legacy"))
      })
    )
  )

  it.effect("connects a v1 client to the v2 legacy fallback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* McpHttpFixture.v2Http()
        const connection = yield* McpClientV1.streamableHttp({
          url: fixture.url,
          clientInfo
        })

        assert.deepStrictEqual(
          yield* connection.callTool("echo", { value: "v1-v2" }),
          { value: "v1-v2" }
        )
        const refusal = yield* Effect.flip(
          connection.callTool("refuse", {})
        )
        if (refusal._tag !== "McpToolError") {
          assert.fail(`expected McpToolError, got ${refusal._tag}`)
        }
        assert.strictEqual(refusal.error, "v2 refused")
        assertOnlyEra(fixture.handledEras, "legacy")
      })
    )
  )

  it.effect("falls a v2 auto client back to a v1 server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* McpHttpFixture.v1Http()
        const connection = yield* McpClientV2.streamableHttp({
          url: fixture.url,
          clientInfo
        })

        assert.strictEqual(
          yield* connection.callTool("echo", { value: "v2-v1" }),
          "v2-v1"
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
  )

  /**
   * R50 -- configured headers reach the origin.
   *
   * `decodeHttp` retained `headers` and the connect path built the transport
   * with only a URL and a client identity, so an authenticated server
   * validated and loaded and then received a materially different request. The
   * implementation comment admitted it while the declared HTTP capability said
   * otherwise.
   *
   * Asserted by being the server: anything short of that checks that we
   * *intended* to send them.
   */
  it.effect("sends configured headers with every request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* McpHttpFixture.v2HeaderRecordingHttp()
        const connection = yield* McpClient.streamableHttp({
          url: fixture.url,
          clientInfo,
          headers: { authorization: "Bearer plugin-secret", "x-tenant": "acme" }
        })
        yield* connection.listTools

        assert.isAbove(fixture.received.length, 0, "the server saw no requests")
        for (const headers of fixture.received) {
          assert.strictEqual(headers["authorization"], "Bearer plugin-secret")
          assert.strictEqual(headers["x-tenant"], "acme")
        }
      })
    )
  )

  it.effect("negotiates the modern era between v2 peers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* McpHttpFixture.v2Http()
        const connection = yield* McpClientV2.streamableHttp({
          url: fixture.url,
          clientInfo
        })

        const changed = yield* connection.toolListChanges.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true })
        )
        fixture.notifyToolsChanged()
        assert.strictEqual((yield* Fiber.join(changed)).length, 1)

        assert.deepStrictEqual(
          yield* connection.callTool("echo", { value: "v2-v2" }),
          { value: "v2-v2" }
        )
        const metadata = yield* connection.metadata
        assert.strictEqual(metadata.sdk, "v2")
        assert.deepStrictEqual(metadata.era, Option.some("modern"))
        assert.deepStrictEqual(
          metadata.protocolVersion,
          Option.some("2026-07-28")
        )
        assertOnlyEra(fixture.handledEras, "modern")
      })
    )
  )

  it.effect("propagates Effect interruption to a modern tool call", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* McpHttpFixture.v2Http()
        const connection = yield* McpClientV2.streamableHttp({
          url: fixture.url,
          clientInfo
        })

        const call = yield* connection.callTool("slow", {}).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(fixture.slowStarted)
        yield* Fiber.interrupt(call)
        yield* Deferred.await(fixture.slowCancelled)
      })
    )
  )

  it.effect("collects every tools/list page over modern HTTP", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* McpHttpFixture.v2PaginatedHttp()
        const connection = yield* McpClientV2.streamableHttp({
          url: fixture.url,
          clientInfo
        })

        assert.deepStrictEqual(
          (yield* connection.listTools).map((tool) => tool.name),
          ["first", "second"]
        )
        assert.deepStrictEqual(fixture.requestedCursors, [undefined, "page-2"])
      })
    )
  )

  it.effect("closes the modern subscription with its connection scope", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* McpHttpFixture.v2Http()
        assert.strictEqual(fixture.listenerCount(), 0)

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* McpClientV2.streamableHttp({
              url: fixture.url,
              clientInfo
            })
            assert.strictEqual(fixture.listenerCount(), 1)
          })
        )

        assert.strictEqual(fixture.listenerCount(), 0)
      })
    )
  )
})
