import { Effect, Option, Predicate } from "effect"
import * as Paths from "./paths.js"
import { warn } from "./types.js"
import type { Warning } from "./types.js"

/** The canonical Agent Plugins 1.0.0 MCP configuration schema identifier. */
export const MCP_SCHEMA_ID = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"

/** A decoded stdio server, expanded and ready for `McpClient.stdio`. */
export interface StdioServer {
  readonly name: string
  readonly transport: "stdio"
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly cwd?: string
}

/** A decoded streamable-http server, ready for `McpClient.streamableHttp`. */
export interface HttpServer {
  readonly name: string
  readonly transport: "streamable-http"
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

export type McpServer = StdioServer | HttpServer

export interface DecodeOptions {
  /** Allow stdio (subprocess) servers. When false they are skipped with a warning. */
  readonly allowStdio: boolean
  /** The resolved plugin root, for `${PLUGIN_ROOT}` expansion. */
  readonly pluginRoot?: string | undefined
  /** The client-managed data dir, for `${PLUGIN_DATA}` expansion. */
  readonly pluginData?: string | undefined
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

const isStringRecord = (value: unknown): value is Record<string, string> =>
  Predicate.isObject(value) && Object.values(value).every(Predicate.isString)

/**
 * Expand `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` in one string: a single,
 * non-recursive textual replacement, only these two placeholders. Returns `None`
 * when a placeholder is referenced but its value was not supplied — that makes
 * the server entry invalid, per the spec.
 */
const expand = (text: string, options: DecodeOptions): Option.Option<string> => {
  if (text.includes("${PLUGIN_ROOT}") && options.pluginRoot === undefined) return Option.none()
  if (text.includes("${PLUGIN_DATA}") && options.pluginData === undefined) return Option.none()
  // One combined pass over the *original* text, so a placeholder value that
  // itself contains `${PLUGIN_...}` is inserted literally, never re-expanded.
  return Option.some(
    text.replace(/\$\{PLUGIN_(ROOT|DATA)\}/g, (_match, which) =>
      which === "ROOT" ? (options.pluginRoot ?? "") : (options.pluginData ?? ""))
  )
}

const expandAll = (values: ReadonlyArray<string>, options: DecodeOptions): Option.Option<ReadonlyArray<string>> => {
  const out: Array<string> = []
  for (const value of values) {
    const expanded = expand(value, options)
    if (Option.isNone(expanded)) return Option.none()
    out.push(expanded.value)
  }
  return Option.some(out)
}

/** True if a `/`-joined relative path never rises above its root via `..`. */
const staysWithin = (relPath: string): boolean => {
  let depth = 0
  for (const segment of relPath.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      depth -= 1
      if (depth < 0) return false
    } else depth += 1
  }
  return true
}

/**
 * Why this command is not one a plugin may name, or `undefined` if it is.
 *
 * Two forms are allowed, and no others: a bare executable name, resolved by
 * the host the way any command is, and a `./`-relative path inside the plugin
 * root.
 *
 * `staysWithin` alone was doing this job, and it counts `..` segments against
 * a depth -- which says nothing about the three shapes that matter here.
 * `/usr/bin/server` has no `..` at all and passed; `bin/server` passed and is
 * neither a bare name nor `./`-prefixed, so what it resolves against was
 * anyone's guess; and `..\up\server` passed because a backslash is not a `/`,
 * so the escape was invisible to a `/`-only scanner.
 *
 * Backslashes are refused outright rather than interpreted: a manifest's paths
 * are `/`-separated by specification, so one that arrives with a backslash is
 * either mistaken or trying to be read differently by different platforms.
 */
const commandFault = (command: string): string | undefined => {
  if (command.includes("\\")) {
    return "must use / as its separator, not a backslash"
  }
  if (Paths.isAbsolute(command)) {
    return "must be a bare executable name or a ./-relative path, not an absolute one"
  }
  if (!command.includes("/")) return undefined
  if (!command.startsWith("./")) {
    return "must start with ./ when it names a path inside the plugin"
  }
  if (!staysWithin(command)) return "escapes the plugin root"
  return undefined
}

/**
 * The plugin-relative part of a valid `cwd`, or `undefined` if `cwd` is not one
 * of the allowed forms (`./…`, `${PLUGIN_ROOT}[/…]`, `${PLUGIN_DATA}[/…]`).
 */
const cwdRelative = (cwd: string): string | undefined => {
  if (cwd.startsWith("./")) return cwd
  const root = "${PLUGIN_ROOT}"
  const data = "${PLUGIN_DATA}"
  if (cwd === root || cwd.startsWith(`${root}/`)) return cwd.slice(root.length)
  if (cwd === data || cwd.startsWith(`${data}/`)) return cwd.slice(data.length)
  return undefined
}

type Decoded = { readonly server: McpServer } | { readonly warning: string }

const decodeStdio = (name: string, entry: Record<string, unknown>, options: DecodeOptions): Decoded => {
  if (!options.allowStdio) return { warning: `${name}: stdio servers are disabled` }
  /**
   * No root, no subprocess.
   *
   * The specification requires `PLUGIN_ROOT` and `PLUGIN_DATA` on every stdio
   * launch, absolute and resolved, and a `./`-relative command means nothing
   * without a root to resolve it against -- it would be resolved against the
   * *host process* cwd, which is wherever the application happens to have been
   * started. Refusing is the honest answer: launching anyway produces a
   * nonconformant plugin that appears to work until the cwd differs.
   */
  if (options.pluginRoot === undefined || options.pluginData === undefined) {
    return {
      warning:
        `${name}: stdio servers need a resolved pluginRoot and pluginData;` +
        ` pass both to Plugins.load`
    }
  }
  if (!Paths.isAbsolute(options.pluginRoot) || !Paths.isAbsolute(options.pluginData)) {
    return {
      warning:
        `${name}: pluginRoot and pluginData must be absolute paths,` +
        ` because a subprocess does not inherit this process's idea of "here"`
    }
  }
  const command = entry["command"]
  if (!Predicate.isString(command) || command === "") return { warning: `${name}: stdio "command" is required` }
  const commandProblem = commandFault(command)
  if (commandProblem !== undefined) return { warning: `${name}: stdio "command" ${commandProblem}` }

  const rawArgs = entry["args"] ?? []
  if (!Array.isArray(rawArgs) || !rawArgs.every(Predicate.isString)) return { warning: `${name}: "args" must be strings` }
  const rawEnv = entry["env"] ?? {}
  if (!isStringRecord(rawEnv)) return { warning: `${name}: "env" must be a string map` }
  if ("PLUGIN_ROOT" in rawEnv || "PLUGIN_DATA" in rawEnv) {
    return { warning: `${name}: "env" must not set PLUGIN_ROOT/PLUGIN_DATA` }
  }

  // Placeholder expansion applies to args, env values, and cwd — never command.
  const args = expandAll(rawArgs, options)
  if (Option.isNone(args)) return { warning: `${name}: unresolved placeholder in "args"` }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(rawEnv)) {
    const expanded = expand(value, options)
    if (Option.isNone(expanded)) return { warning: `${name}: unresolved placeholder in env "${key}"` }
    env[key] = expanded.value
  }
  const rawCwd = entry["cwd"]
  let cwd: string | undefined
  if (rawCwd !== undefined) {
    if (!Predicate.isString(rawCwd)) return { warning: `${name}: "cwd" must be a string` }
    const relative = cwdRelative(rawCwd)
    if (relative === undefined) {
      return { warning: `${name}: "cwd" must be ./-relative or start with a PLUGIN_ROOT/PLUGIN_DATA placeholder` }
    }
    if (!staysWithin(relative)) return { warning: `${name}: "cwd" escapes its root` }
    const expanded = expand(rawCwd, options)
    if (Option.isNone(expanded)) return { warning: `${name}: unresolved placeholder in "cwd"` }
    // A `./`-relative cwd has no placeholder to expand, so it is still
    // relative here and would be resolved against the host process cwd.
    cwd = rawCwd.startsWith("./") ? Paths.join(options.pluginRoot, rawCwd) : expanded.value
  }

  return {
    server: {
      name,
      transport: "stdio",
      /**
       * Resolved against the plugin root, not left relative.
       *
       * `./bin/server` handed to a subprocess spawner is relative to whatever
       * directory the *host application* was started in. That is almost never
       * the plugin root, and when it accidentally is, the bug is invisible.
       * A bare name is left alone: it is meant to be found the way any
       * command is.
       */
      command: command.startsWith("./") ? Paths.join(options.pluginRoot, command) : command,
      args: args.value,
      /**
       * The reserved variables, injected after the configured overlay.
       *
       * Required on every stdio launch by the specification, and never
       * supplied: a server was told where to find nothing. Written last so
       * they win, which is also why `env` naming either of them was refused
       * further up -- a plugin cannot quietly redirect its own root.
       */
      env: { ...env, PLUGIN_ROOT: options.pluginRoot, PLUGIN_DATA: options.pluginData },
      // No cwd configured means the plugin root, which is what the
      // specification says and is not what an omitted cwd would otherwise
      // mean: the host process's directory.
      cwd: cwd ?? options.pluginRoot
    }
  }
}

const decodeHttp = (name: string, entry: Record<string, unknown>): Decoded => {
  const url = entry["url"]
  if (!Predicate.isString(url)) return { warning: `${name}: streamable-http "url" is required` }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { warning: `${name}: "url" is not a valid URL` }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { warning: `${name}: "url" must be http(s)` }
  if (parsed.username !== "" || parsed.password !== "") return { warning: `${name}: "url" must not contain credentials` }
  if (parsed.hash !== "") return { warning: `${name}: "url" must not contain a fragment` }
  if (parsed.protocol === "http:" && !LOOPBACK.has(parsed.hostname)) {
    return { warning: `${name}: non-loopback "url" must use HTTPS` }
  }
  const rawHeaders = entry["headers"] ?? {}
  if (!isStringRecord(rawHeaders)) return { warning: `${name}: "headers" must be a string map` }
  return { server: { name, transport: "streamable-http", url, headers: rawHeaders } }
}

/**
 * Decode an `mcp.json` document into connectable server configs.
 *
 * Never fatal to the plugin (the spec: a bad `mcp.json` makes the *MCP
 * component* unavailable, not the plugin). A malformed document, a wrong
 * `$schema`, or a non-object `mcpServers` yields no servers and a warning; each
 * server entry is decoded independently, so one bad entry is skipped while the
 * rest load. `sse` is skipped with a warning (support is optional).
 */
export const decodeMcp = (
  text: string,
  options: DecodeOptions
): Effect.Effect<{ readonly servers: ReadonlyArray<McpServer>; readonly warnings: ReadonlyArray<Warning> }> =>
  Effect.gen(function* () {
    const warnings: Array<Warning> = []
    const servers: Array<McpServer> = []
    const push = (detail: string) => warnings.push(warn("mcp", detail))

    const raw = yield* Effect.option(
      Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => "bad" })
    )
    if (Option.isNone(raw) || !Predicate.isObject(raw.value)) {
      push("mcp.json is not a JSON object; no MCP servers loaded")
      return { servers, warnings }
    }
    if (raw.value["$schema"] !== MCP_SCHEMA_ID) {
      push("mcp.json \"$schema\" is missing or unsupported; no MCP servers loaded")
      return { servers, warnings }
    }
    const mcpServers = raw.value["mcpServers"]
    if (!Predicate.isObject(mcpServers)) {
      push("mcp.json \"mcpServers\" must be an object; no MCP servers loaded")
      return { servers, warnings }
    }

    for (const [name, entryValue] of Object.entries(mcpServers)) {
      if (!Predicate.isObject(entryValue)) {
        push(`${name}: server entry must be an object`)
        continue
      }
      const type = entryValue["type"]
      const decoded: Decoded = type === "stdio"
        ? decodeStdio(name, entryValue, options)
        : type === "streamable-http"
        ? decodeHttp(name, entryValue)
        : type === "sse"
        ? { warning: `${name}: sse transport is not supported` }
        : { warning: `${name}: unknown transport "${String(type)}"` }

      if ("server" in decoded) servers.push(decoded.server)
      else push(decoded.warning)
    }

    return { servers, warnings }
  })
