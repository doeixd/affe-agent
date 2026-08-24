import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Mcp from "../src/plugins/internal/mcp.js"

/**
 * mcp.json decoding. Never fatal to the plugin: a bad document yields no servers
 * and a warning, and each server entry decodes independently. Pins the transport
 * rules (loopback-HTTPS, reserved env keys, sse-skip) and placeholder expansion.
 */

const S = Mcp.MCP_SCHEMA_ID
const OPTS: Mcp.DecodeOptions = { allowStdio: true, pluginRoot: "/root", pluginData: "/data" }

const decode = (servers: object, options: Mcp.DecodeOptions = OPTS, schema: string = S) =>
  Mcp.decodeMcp(JSON.stringify({ $schema: schema, mcpServers: servers }), options)

describe("mcp.json decoding", () => {
  it.effect("decodes a stdio and a streamable-http server", () =>
    Effect.gen(function* () {
      const { servers, warnings } = yield* decode({
        local: { type: "stdio", command: "my-server", args: ["--port", "3000"] },
        remote: { type: "streamable-http", url: "https://api.example.com/mcp" }
      })
      assert.deepStrictEqual(warnings, [])
      assert.strictEqual(servers.length, 2)
      const stdio = servers.find((s) => s.name === "local")
      assert.deepStrictEqual(stdio, {
        name: "local",
        transport: "stdio",
        command: "my-server",
        args: ["--port", "3000"],
        env: {}
      })
    })
  )

  it.effect("a wrong or missing $schema yields no servers and a warning", () =>
    Effect.gen(function* () {
      const { servers, warnings } = yield* decode({ x: { type: "stdio", command: "c" } }, OPTS, "https://x/other")
      assert.deepStrictEqual(servers, [])
      assert.strictEqual(warnings.length, 1)
    })
  )

  it.effect("skips a bad entry and keeps the good sibling", () =>
    Effect.gen(function* () {
      const { servers, warnings } = yield* decode({
        good: { type: "streamable-http", url: "https://ok.example.com" },
        badType: { type: "carrier-pigeon" },
        noCommand: { type: "stdio" }
      })
      assert.deepStrictEqual(servers.map((s) => s.name), ["good"])
      assert.strictEqual(warnings.length, 2)
    })
  )

  it.effect("requires HTTPS for non-loopback urls, allows http for loopback", () =>
    Effect.gen(function* () {
      const remote = yield* decode({ r: { type: "streamable-http", url: "http://api.example.com" } })
      assert.deepStrictEqual(remote.servers, [])
      assert.strictEqual(remote.warnings.length, 1)

      const local = yield* decode({ l: { type: "streamable-http", url: "http://127.0.0.1:8080" } })
      assert.strictEqual(local.servers.length, 1)
      const localhost = yield* decode({ l: { type: "streamable-http", url: "http://localhost:8080" } })
      assert.strictEqual(localhost.servers.length, 1)
    })
  )

  it.effect("rejects an env that sets a reserved placeholder key", () =>
    Effect.gen(function* () {
      const { servers, warnings } = yield* decode({
        s: { type: "stdio", command: "c", env: { PLUGIN_ROOT: "/evil" } }
      })
      assert.deepStrictEqual(servers, [])
      assert.include(warnings[0]?.detail ?? "", "PLUGIN_ROOT")
    })
  )

  it.effect("skips sse with a warning", () =>
    Effect.gen(function* () {
      const { servers, warnings } = yield* decode({ s: { type: "sse", url: "https://x.example.com" } })
      assert.deepStrictEqual(servers, [])
      assert.include(warnings[0]?.detail ?? "", "sse")
    })
  )

  it.effect("skips stdio servers when allowStdio is false", () =>
    Effect.gen(function* () {
      const { servers, warnings } = yield* decode(
        { s: { type: "stdio", command: "c" } },
        { allowStdio: false }
      )
      assert.deepStrictEqual(servers, [])
      assert.include(warnings[0]?.detail ?? "", "disabled")
    })
  )

  it.effect("expands placeholders in args/env/cwd only, single-pass, and never in command", () =>
    Effect.gen(function* () {
      const { servers } = yield* decode({
        s: {
          type: "stdio",
          command: "${PLUGIN_ROOT}/bin", // command is NOT expanded
          args: ["--config", "${PLUGIN_ROOT}/config.json", "--unknown", "${FOO}"],
          env: { DATA: "${PLUGIN_DATA}/db" },
          cwd: "${PLUGIN_ROOT}"
        }
      })
      const s = servers[0]
      assert.strictEqual(s?.transport, "stdio")
      if (s?.transport === "stdio") {
        assert.strictEqual(s.command, "${PLUGIN_ROOT}/bin") // literal
        assert.deepStrictEqual(s.args, ["--config", "/root/config.json", "--unknown", "${FOO}"]) // unknown literal
        assert.deepStrictEqual(s.env, { DATA: "/data/db" })
        assert.strictEqual(s.cwd, "/root")
      }
    })
  )

  it.effect("rejects a url with credentials or a fragment", () =>
    Effect.gen(function* () {
      const creds = yield* decode({ s: { type: "streamable-http", url: "https://user:pass@api.example.com/mcp" } })
      assert.deepStrictEqual(creds.servers, [])
      assert.include(creds.warnings[0]?.detail ?? "", "credentials")

      const frag = yield* decode({ s: { type: "streamable-http", url: "https://api.example.com/mcp#section" } })
      assert.deepStrictEqual(frag.servers, [])
      assert.include(frag.warnings[0]?.detail ?? "", "fragment")
    })
  )

  it.effect("expansion is a single pass: a placeholder inside a placeholder value is not re-expanded", () =>
    Effect.gen(function* () {
      const { servers } = yield* decode(
        { s: { type: "stdio", command: "c", args: ["${PLUGIN_ROOT}/x"] } },
        { allowStdio: true, pluginRoot: "/a${PLUGIN_DATA}b", pluginData: "/data" }
      )
      const s = servers[0]
      if (s?.transport === "stdio") {
        // The ${PLUGIN_DATA} that came from the root value stays literal.
        assert.deepStrictEqual(s.args, ["/a${PLUGIN_DATA}b/x"])
      } else {
        assert.fail("expected a stdio server")
      }
    })
  )

  it.effect("skips a server that references PLUGIN_DATA when none was supplied", () =>
    Effect.gen(function* () {
      const { servers, warnings } = yield* decode(
        { s: { type: "stdio", command: "c", args: ["${PLUGIN_DATA}/x"] } },
        { allowStdio: true, pluginRoot: "/root" } // no pluginData
      )
      assert.deepStrictEqual(servers, [])
      assert.include(warnings[0]?.detail ?? "", "placeholder")
    })
  )
})
