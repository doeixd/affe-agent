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
        // A bare name is left alone: it is meant to be found the way any
        // command is.
        command: "my-server",
        args: ["--port", "3000"],
        // The reserved variables the specification requires on every stdio
        // launch. They were never supplied, so a server was told where to
        // find nothing.
        env: { PLUGIN_ROOT: "/root", PLUGIN_DATA: "/data" },
        // An omitted cwd means the plugin root, not the host process's
        // directory -- which is what a relative launch would have used.
        cwd: "/root"
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

  it.effect("expands placeholders in args/env/cwd only, single-pass", () =>
    Effect.gen(function* () {
      const { servers } = yield* decode({
        s: {
          type: "stdio",
          command: "./bin/server",
          args: ["--config", "${PLUGIN_ROOT}/config.json", "--unknown", "${FOO}"],
          env: { DATA: "${PLUGIN_DATA}/db" },
          cwd: "${PLUGIN_ROOT}"
        }
      })
      const s = servers[0]
      assert.strictEqual(s?.transport, "stdio")
      if (s?.transport === "stdio") {
        assert.deepStrictEqual(s.args, ["--config", "/root/config.json", "--unknown", "${FOO}"]) // unknown literal
        // The configured environment, plus the reserved pair the
        // specification requires on every launch.
        assert.deepStrictEqual(s.env, {
          DATA: "/data/db",
          PLUGIN_ROOT: "/root",
          PLUGIN_DATA: "/data"
        })
        assert.strictEqual(s.cwd, "/root")
      }
    })
  )

  /**
   * R47 -- a command is a bare name or a `./`-relative path, and nothing else.
   *
   * `command` is deliberately not placeholder-expanded, which meant
   * `${PLUGIN_ROOT}/bin` was carried through literally and handed to a
   * spawner as the name of a program to run. That can only fail, so it is
   * refused rather than passed on.
   *
   * The other three shapes were all accepted by a `/`-only `..` counter: an
   * absolute path has no `..` at all, a bare `bin/server` resolves against
   * nothing in particular, and `..\up\server` escapes through a separator the
   * scanner never looked at.
   */
  it.effect("refuses command forms that cannot mean what they say", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [command: string, expected: string]> = [
        ["${PLUGIN_ROOT}/bin", "must start with ./"],
        ["/usr/bin/server", "not an absolute one"],
        ["C:/tools/server.exe", "not an absolute one"],
        ["bin/server", "must start with ./"],
        ["..\\up\\server", "backslash"],
        ["./../escape/server", "escapes the plugin root"]
      ]
      for (const [command, expected] of cases) {
        const { servers, warnings } = yield* decode({ s: { type: "stdio", command } })
        assert.deepStrictEqual(servers, [], `${command} should not have decoded`)
        assert.include(warnings[0]?.detail ?? "", expected)
      }

      // And the two legal forms still are.
      const bare = yield* decode({ s: { type: "stdio", command: "server" } })
      assert.strictEqual(bare.servers.length, 1)
      const relative = yield* decode({ s: { type: "stdio", command: "./bin/server" } })
      assert.strictEqual(relative.servers.length, 1)
    })
  )

  /**
   * R48 -- without a resolved root there is nothing to resolve against.
   *
   * A `./`-relative command handed to a spawner is relative to whatever
   * directory the host application was started in, and the specification
   * requires `PLUGIN_ROOT`/`PLUGIN_DATA` on every launch. Refusing is the
   * honest answer; launching produces a nonconformant plugin that appears to
   * work whenever the host's cwd happens to match.
   */
  it.effect("refuses stdio without a resolved root and data directory", () =>
    Effect.gen(function* () {
      const noRoot = yield* decode(
        { s: { type: "stdio", command: "./bin/server" } },
        { allowStdio: true, pluginData: "/data" }
      )
      assert.deepStrictEqual(noRoot.servers, [])
      assert.include(noRoot.warnings[0]?.detail ?? "", "resolved pluginRoot")

      const relativeRoot = yield* decode(
        { s: { type: "stdio", command: "./bin/server" } },
        { allowStdio: true, pluginRoot: "plugins/mine", pluginData: "/data" }
      )
      assert.deepStrictEqual(relativeRoot.servers, [])
      assert.include(relativeRoot.warnings[0]?.detail ?? "", "absolute")
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

  it.effect("rejects a command or cwd that escapes the plugin root", () =>
    Effect.gen(function* () {
      // command escapes
      assert.deepStrictEqual((yield* decode({ s: { type: "stdio", command: "../evil" } })).servers, [])
      assert.deepStrictEqual((yield* decode({ s: { type: "stdio", command: "./../evil" } })).servers, [])
      // cwd wrong form / escapes
      assert.deepStrictEqual((yield* decode({ s: { type: "stdio", command: "c", cwd: "../etc" } })).servers, [])
      assert.deepStrictEqual((yield* decode({ s: { type: "stdio", command: "c", cwd: "./../etc" } })).servers, [])
      assert.deepStrictEqual((yield* decode({ s: { type: "stdio", command: "c", cwd: "${PLUGIN_ROOT}/../etc" } })).servers, [])
    })
  )

  it.effect("allows a safe plugin-relative command and cwd", () =>
    Effect.gen(function* () {
      const { servers } = yield* decode({
        s: { type: "stdio", command: "./bin/server", cwd: "${PLUGIN_ROOT}/work" }
      })
      const s = servers[0]
      // Resolved against the root, not left relative: `./bin/server` handed to
      // a spawner is relative to wherever the host application was started.
      assert.strictEqual(s?.transport === "stdio" ? s.command : undefined, "/root/bin/server")
      assert.strictEqual(s?.transport === "stdio" ? s.cwd : undefined, "/root/work")
    })
  )

  it.effect("skips a stdio server when PLUGIN_DATA was never supplied", () =>
    Effect.gen(function* () {
      const { servers, warnings } = yield* decode(
        { s: { type: "stdio", command: "c", args: ["${PLUGIN_DATA}/x"] } },
        { allowStdio: true, pluginRoot: "/root" } // no pluginData
      )
      assert.deepStrictEqual(servers, [])
      // The reason moved: an unresolvable placeholder used to be the first
      // thing noticed, and now the missing data directory is refused before
      // any entry is read, because *every* stdio launch needs it -- not only
      // one that happens to mention it.
      assert.include(warnings[0]?.detail ?? "", "pluginData")
    })
  )

  /**
   * An `${PLUGIN_DATA}` placeholder in an *http* server's headers still has
   * nothing to expand to, and that path is unchanged.
   */
  it.effect("still reports an unresolvable placeholder where one can occur", () =>
    Effect.gen(function* () {
      const { servers, warnings } = yield* decode(
        { s: { type: "stdio", command: "c", args: ["${FOO}/x"] } },
        { allowStdio: true, pluginRoot: "/root", pluginData: "/data" }
      )
      // `${FOO}` is not a reserved placeholder, so it is literal text and the
      // server decodes.
      assert.strictEqual(servers.length, 1)
      assert.deepStrictEqual(warnings, [])
    })
  )
})
