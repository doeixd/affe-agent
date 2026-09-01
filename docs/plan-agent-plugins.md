# Plan — Agent Plugins support (`/plugins`)

Implement first-class support for the [Agent Plugins](https://agent-plugins.org)
1.0.0 standard: load a portable plugin directory (a `plugin.json` manifest,
`skills/<name>/SKILL.md` skills, and an `mcp.json` of MCP servers) into a running
agent. The standard is a vendor-neutral composition of two things this library
already models — **Agent Skills** (→ `/skills`) and **MCP servers** (→ `/mcp`) —
so support is an *adapter*, not a new capability.

## Why this fits the project

The Agent Skills progressive-disclosure model (advertise `name`+`description`,
load the body on activation, load resources on demand) is *exactly* what
`/skills` already does. An Agent Plugins package is therefore, in this library's
terms, "a `SkillRegistry` plus a set of MCP toolkits in a portable directory" —
a **loader/adapter over existing seams**, which is precisely what the project's
thesis permits: *a package adds a capability, policy, interpreter, or adapter —
never a parallel execution model; core depends on no battery.* `/plugins` adds
nothing to the engine, depends only on `/skills`, `/mcp`, and `/sandbox`, and
reads the filesystem through the existing `Sandbox` seam so it stays **portable**
(no new `HOST_MODULES` entry).

---

## 1. Architecture

```
        plugin directory (on disk, or in a memory sandbox)
                         │  read via Sandbox.Current (portable fs seam)
                         ▼
   ┌─────────────────────────────────────────────────────────┐
   │  /plugins  (portable battery)                            │
   │                                                          │
   │  Plugins.load ──► LoadedPlugin { manifest, skills[],     │
   │                     mcpServers[], warnings[] }           │
   │      │  parse+validate plugin.json / mcp.json / SKILL.md │
   │      │  (Effect Schema + per-component failure isolation)│
   │      ├──► Plugins.skillsLayer ─► Skills.layer(skills)    │  (reuse /skills)
   │      ├──► Plugins.mcpToolkit  ─► McpClient.{stdio,http}  │  (reuse /mcp)
   │      │        + McpToolkit dynamic bind (scoped)         │
   │      └──► Plugins.install ─► Skills.install + the toolkit│
   └─────────────────────────────────────────────────────────┘
                         │  provided at the session
                         ▼
                   Agent.make(...).pipe(Plugins.install(loaded))
```

- **Everything is portable.** File reads go through `Sandbox.Current` /
  `Sandbox.readText` / `Sandbox.list` (the same seam `/coding` uses), and
  `SandboxPath` already refuses `..` and absolute paths — the spec's path
  containment for free. The application points the loader at a real directory at
  the edge with `sandbox/local.layer({ workspaceRoot })`, or at a `MemorySandbox`
  in tests.
- **The one host-coupled runtime action — spawning a stdio MCP subprocess — is
  already isolated** behind `McpClientV2`'s dynamic `import()` of its stdio
  transport, so building and even connecting stdio servers does not force
  `/plugins` into `HOST_MODULES`. `streamable-http` servers are fully portable.

---

## 2. Public API (design)

Mirror the battery conventions (`src/plugins/`, `index.ts` `export * as Plugins`,
a `./plugins` package export, service ids `@doeixd/effect-agent/plugins/...`).

```ts
// A parsed, validated plugin. Skills carry lazy bodies (Sandbox-backed).
export interface LoadedPlugin {
  readonly manifest: Manifest          // decoded plugin.json (closed shape)
  readonly skills: ReadonlyArray<Skills.Skill>
  readonly mcpServers: ReadonlyArray<McpServer>   // decoded, expanded, validated entries
  readonly warnings: ReadonlyArray<Warning>       // non-fatal issues (unknown fields, skipped skills/servers)
}

// Read + validate a plugin directory through the ambient Sandbox.
// Fatal manifest problems fail with PluginError; component problems become warnings.
export const load: (options?: {
  readonly pluginData?: string          // ${PLUGIN_DATA} for placeholder expansion; default a derived path
  readonly clientInfo?: { name: string; version: string }  // for MCP handshakes
}) => Effect.Effect<LoadedPlugin, PluginError, Sandbox.Current>

// Skills → the existing registry (reuse /skills verbatim).
export const skillsLayer: (loaded: LoadedPlugin) => Layer.Layer<Skills.SkillRegistry>

// MCP servers → one bound toolkit of *discovered* tools. Scoped: connections are
// acquired once and closed on scope end. Discovered tools are dynamic (params
// validated by the server), because a plugin declares no local Tool.make values.
export const mcpToolkit: (loaded: LoadedPlugin) =>
  Effect.Effect<Toolkit.WithHandler<Record<string, Tool.Any>>, PluginError, Scope.Scope>

// Sugar: an agent transform that installs the plugin's skills (tool + advertise,
// via Skills.install) and merges its MCP toolkit. Scoped, because MCP is a live
// connection. Still provide `skillsLayer(loaded)` at the session.
export const install: (loaded: LoadedPlugin) =>
  <Tools, E, R>(agent: AgentDefinition<Tools, E, R>) =>
    Effect.Effect<AgentDefinition<Record<string, Tool.Any>, E, R | Skills.SkillRegistry>, PluginError, Scope.Scope>
```

Usage:

```ts
Effect.scoped(Effect.gen(function* () {
  const loaded = yield* Plugins.load()
  const agent = yield* Agent.make({ instructions: "…" }).pipe(Plugins.install(loaded))
  const session = yield* AgentSession.make(agent).pipe(
    Effect.provide(Plugins.skillsLayer(loaded))
  )
  return yield* AgentSession.prompt(session, "…")
})).pipe(
  Effect.provide(Sandbox.currentLayer(Sandbox.workspace("plugin"))),
  Effect.provide(SandboxLocal.layer({ workspaceRoot: "/path/to/my-plugin" }))
)
```

**Design note (MCP + toolkit-as-Effect):** the MCP toolkit is a *scoped resource*
(a live connection), so it is resolved **once** at session setup and passed as a
value — not as a per-turn `toolkit: Effect<…>` (which would reconnect every turn).
This is the correct use of the connection lifetime and keeps `install` honest
about its `Scope` requirement.

---

## 3. The three sub-problems and how each is resolved

### 3a. SKILL.md frontmatter parsing (no YAML dependency)

No frontmatter/YAML parser exists in the repo, and adding a YAML dep would be a
portability and supply-chain cost for a constrained format. The Agent Skills
frontmatter is small and well-specified: `name`, `description` (required),
`license`, `compatibility`, `metadata` (a flat string→string map),
`allowed-tools`. Write a **minimal, total, well-tested frontmatter parser** for
exactly this shape:

- Split on a leading `---\n … \n---\n` fence; no fence → the file has no
  frontmatter → the skill is invalid (missing required `name`/`description`) →
  skipped.
- Parse `key: value` lines; support quoted values; support the single nested
  `metadata:` block (indented `key: value` pairs). Reject/ignore anything else
  gracefully (the spec's `metadata` is the only nesting).
- The body is everything after the closing fence.

This parser is a pure function `parseFrontmatter(text): { fields, body }` with its
own exhaustive test matrix (see invariants). It deliberately does **not** aim to
be a general YAML parser — it accepts the documented subset and treats anything
outside it as a skipped skill, which is the spec's non-fatal stance.

Map onto `Skills.skill({ id, name, description, body, resources })`:
| SKILL.md | Skill |
|----------|-------|
| frontmatter `name` (== parent dir) | `id` **and** `name` |
| frontmatter `description` | `description` |
| markdown body | `body` — a **lazy** `Sandbox.readText(path)` so it loads only on activation |
| `references/*.md` (optional) | `resources` — lazy `Sandbox.readText` per file |
| `license` / `compatibility` / `metadata` / `allowed-tools` | carried as advisory info in the warning/telemetry channel; not part of `Skill` today |

### 3b. MCP discovered tools (the `bind` gap)

`McpToolkit.bind(connection, tools)` verifies the server against **locally
declared** `Tool.make(...)` values and returns a statically-typed toolkit. A
plugin's `mcp.json` declares servers, not tools, so their tools are known only at
connect time. Resolution:

- Connect each server (`McpClient.stdio` / `McpClient.streamableHttp`), call
  `connection.listTools`, and build a **dynamic tool per discovered tool** —
  Effect AI's `Tool.dynamic` (parameters `unknown`, validated by the server on
  call), wired to `connection.callTool`. Assemble them into one
  `Toolkit.WithHandler<Record<string, Tool.Any>>`.
- This trades compile-time tool types for runtime discovery — the correct trade
  for plugins, whose tools are not known when the agent is written. Statically
  typed use stays available for authors who *do* declare tools (plain
  `McpToolkit.bind`); `/plugins` is the discovered path.
- **Verify in an early spike:** the exact `Tool.dynamic` signature and how its
  handler reaches `connection.callTool` and surfaces `McpToolError` /
  `McpUnsupportedContentError`. If a "bind all discovered" helper is missing from
  `McpToolkit`, add one there (it belongs next to `bind`), not in `/plugins`.

### 3c. Validation and failure isolation (the heart of correctness)

The spec defines precise, *narrowest-scope* failure boundaries. Model them with
Effect Schema plus per-component decoding:

| Condition | Outcome |
|-----------|---------|
| `plugin.json` missing / not an object / not valid JSON | **fatal** — `load` fails with `PluginError` |
| `$schema` ≠ the canonical v1 id, or missing | fatal |
| `name` missing or violates the pattern (`^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`, 1–64) | fatal |
| **unknown top-level field** | **non-fatal** — warn, ignore, continue |
| **non-object `extensions`** | non-fatal — warn, ignore |
| `extensions` namespace we don't implement | ignored **without validating its contents** |
| `skills/` missing | no skills, not an error |
| `skills` is a file, not a directory | skills component unavailable; plugin still loads (warn) |
| one `SKILL.md` invalid (no `name`/`description`, bad name, name ≠ dir, escapes root) | **that skill skipped**; others load |
| `mcp.json` missing | no MCP, not an error |
| `mcp.json` invalid / `$schema` version ≠ manifest | MCP component unavailable; plugin still loads (warn) |
| one server entry invalid (bad transport, http to non-loopback, reserved env key, path escape) | **that server skipped**; others load |
| `sse` transport | supported-optional → skip with a warning (document why) |

Implementation notes:
- The "closed manifest, but unknown top-level fields are non-fatal" rule is *not*
  Schema's default (which rejects excess). Handle it explicitly: read the raw
  object, split known vs unknown keys, **warn** on unknown, then decode the known
  subset against a strict `Schema.Struct`. Same for a non-object `extensions`.
- Every component list (skills, servers) is decoded **element-by-element**:
  collect the `Right`s, turn each `Left` into a `Warning`, never let one bad
  element fail the load. This is the failure-isolation invariant.
- `load` therefore fails *only* on a fatal manifest problem; everything else is a
  `Warning` in `LoadedPlugin.warnings`.

---

## 4. Path safety & placeholder expansion

- **Containment for free:** all plugin-relative paths are built with
  `Sandbox.path(value)` (refuses `..`, absolute, drive-qualified) and read through
  a `Sandbox` whose `sandbox/local` provider resolves symlinks and refuses escapes
  (`resolveWithin`). The spec's "paths remain within plugin root after symlink
  resolution" and the `./`-prefix requirement are enforced by the seam, not
  re-implemented.
- **Placeholder expansion** (`${PLUGIN_ROOT}`, `${PLUGIN_DATA}`) is a portable,
  purely textual step done when building each stdio `ServerConfig`:
  - Expand **only** in `args` elements, `env` *values*, and `cwd`. **Never** in
    `command`, `url`, headers, `env` keys, or the fixed component locations.
  - Single, non-recursive replacement of every exact occurrence; unrecognised
    `${…}`-like text stays literal.
  - `PLUGIN_ROOT` = the resolved plugin root; `PLUGIN_DATA` = the caller-supplied
    `pluginData` dir. An `env` object containing a `PLUGIN_ROOT`/`PLUGIN_DATA`
    **key** makes that server entry invalid (skipped).

---

## 5. Portable / host split

- `/plugins` is **portable** — imports only `effect`, `effect/unstable/ai`,
  `../Agent.js`, `../skills/*`, `../mcp/*`, `../sandbox/Sandbox.js`. It is **not**
  added to `HOST_MODULES` and needs no `./plugins/*host*` sub-entry.
- Reading the plugin dir is via `Sandbox.Current`; the host binding
  (`sandbox/local`) is supplied by the application at the edge, exactly as
  `/coding` does.
- Spawning a stdio MCP server is host at *runtime*, but statically isolated inside
  `McpClientV2`'s dynamic import, so the portability checker (static-import scan)
  stays green. `streamable-http` needs no host at all.
- One new `package.json` export: `"./plugins"`. `verify:package` will count 31
  entry points.

---

## 6. Invariants to test (falsifiable)

Grouped by component. Each is a `MUST`/boundary from the spec, written as a test;
deterministic via a **`MemorySandbox`** holding fixture plugin files (no disk) and
a **fake MCP `Connection`** (scripted `listTools`/`callTool`) plus, where useful,
an in-process `streamable-http` server. Every "assert inference" fix carries a
type-level assertion falsified once.

**Manifest (fatal vs non-fatal):**
1. Minimal valid manifest (`$schema` + `name` only) → loads.
2. Missing `$schema` → `load` fails (`PluginError`). Missing `name` → fails.
3. `$schema` ≠ canonical v1 id → fails.
4. `name` violations each fail: uppercase, leading/trailing `-`, `--`, `..`,
   empty, >64 chars.
5. Unknown top-level field → **loads**, a warning names the field, the field is
   absent from `manifest`. (Falsify: a version that rejects it fails the test.)
6. Non-object `extensions` → loads, warning. `extensions` with an unknown
   namespace → loads, and the loader never inspects that namespace's contents.

**Skills discovery & parsing:**
7. `skills/a/SKILL.md` + `skills/b/SKILL.md` → two skills; `skills/a/nested/SKILL.md`
   is **not** discovered (no deep recursion).
8. Missing `skills/` → zero skills, no warning-as-error, load succeeds.
9. `skills` present as a file → skills unavailable, plugin still loads (warning).
10. Frontmatter parser matrix: valid minimal; with all optional fields; quoted
    values; a `metadata:` block; **no fence** → skipped; missing `name` →
    skipped; missing `description` → skipped; `name` ≠ parent dir → skipped;
    invalid `name` pattern → skipped. One valid + one invalid sibling → the valid
    one loads.
11. A discovered skill's `body` is **lazy** — reading it is deferred until
    `SkillRegistry.load(id)` (assert the file is not read at `load` time, e.g. via
    a counting sandbox or a memory sandbox read-count).
12. `references/*.md` surface as the skill's `resources` (names in `list`, bodies
    via `loadResource`).

**MCP:**
13. `mcp.json` with one stdio + one streamable-http server → two `McpServer`
    entries with the decoded shapes.
14. Missing `mcp.json` → no MCP, load succeeds.
15. `mcp.json` `$schema` version ≠ manifest → MCP unavailable, plugin loads (warn).
16. One invalid server entry (unknown `type`, missing `command`/`url`) → skipped;
    the valid sibling remains.
17. `streamable-http` `url` = `http://example.com` (non-loopback, not HTTPS) →
    server skipped. `http://127.0.0.1` / `localhost` → allowed.
18. `env` containing a `PLUGIN_ROOT` key → server skipped.
19. `sse` transport → skipped with a warning.
20. Discovered-tool binding: against a fake connection whose `listTools` returns
    two tools, `mcpToolkit` yields a toolkit that calls `connection.callTool` with
    the tool name and passes params through; a `callTool` failure surfaces as the
    tool's handler error, not a defect.

**Placeholder expansion:**
21. `${PLUGIN_ROOT}/x` in `args` → expanded to `<root>/x`; the same text in
    `command` → **left literal**; `${PLUGIN_DATA}/db` in an `env` value → expanded;
    an unknown `${FOO}` → literal; expansion is single-pass (a value that itself
    contains `${PLUGIN_ROOT}` after one expansion is not re-expanded).

**Path safety:**
22. A `SKILL.md` (or server `cwd`/`command`) resolving outside the plugin root
    (via `..` or an escaping symlink) → that skill/server skipped, others load;
    the read is refused by the sandbox, never escapes.

**Failure isolation (the headline):**
23. A plugin with one good + one bad skill **and** one good + one bad server →
    `load` succeeds, returns exactly the good skill and good server, and a warning
    per bad element; nothing throws.

**End-to-end:**
24. A fixture plugin in a `MemorySandbox` → `load` → `Plugins.install` →
    `AgentSession`: the catalogue is advertised (skill metadata in the first
    model prompt), `load_skill` returns a body on demand, and a discovered MCP
    tool is callable — driven by the scripted `TestLanguageModel`.

---

## 7. Workstream breakdown (ordered)

| # | Deliverable | Depends on | Acceptance |
|---|-------------|-----------|------------|
| **PL0** | Spike: confirm `Tool.dynamic` shape + whether a `MemorySandbox` and a fake `McpToolkit.Connection` exist for tests. Decide the effect-agent extension namespace string. | — | a throwaway test binds one dynamic MCP tool and calls it; test harness confirmed |
| **PL1** | Frontmatter parser (`parseFrontmatter`) + its exhaustive test matrix (invariant 10, partial) | — | parser total, every frontmatter test green, falsified on the "no fence → skipped" case |
| **PL2** | Manifest schema + validation (fatal vs non-fatal, unknown-field warnings) | — | invariants 1–6 |
| **PL3** | Skills discovery + SKILL.md → `Skills.skill` mapping, lazy bodies, resources | PL1, Sandbox | invariants 7–12 |
| **PL4** | `mcp.json` decode: transports, URL/loopback rule, reserved-env rule, placeholder expansion, sse-skip | PL2 | invariants 13–19, 21 |
| **PL5** | `mcpToolkit` — connect + discover + dynamic-bind (scoped) | PL4, PL0 | invariant 20 |
| **PL6** | `load` orchestration + failure isolation + `LoadedPlugin`/`Warning` types | PL2–PL5 | invariants 22–23 |
| **PL7** | `skillsLayer` + `install` sugar; the `./plugins` export; module docs | PL3, PL5, PL6 | verify:package = 31 entries |
| **PL8** | End-to-end example (`examples/agent-plugins.ts`) + integration test | PL7 | invariant 24; example typechecks |
| **PL9** | README section (a "Load a plugin" subsection under skills/mcp) + STATUS/ROADMAP | PL8 | docs land; full gate green |

Order rationale: the pure, dependency-light pieces first (parser, manifest), then
the two component mappers (skills, mcp), then orchestration, then sugar/docs — so
each layer is tested before the next builds on it.

---

## 8. Decisions (settled)

1. **Extension namespace — reserve `dev.doeixd.effect-agent`, but v1 ignores all
   namespaces.** Spec-compliant clients ignore namespaces they don't implement;
   v1 does exactly that (report + continue, never inspect contents). The name is
   reserved in the docs so a later version can read effect-agent-specific config
   (a default permission policy, a loop bound) without a breaking change. No v1
   code reads any namespace.
2. **stdio — include, gated by `allowStdio` (default `true`).** stdio servers are
   supported by default (host coupling stays isolated behind `McpClientV2`'s
   dynamic import, so the portability checker stays green). A portable-only
   deployment sets `allowStdio: false`, and stdio server entries are then skipped
   with a warning.
3. **Discovered tools — `Tool.dynamic` (JSON-Schema mode, `unknown` params).**
   Confirmed available and documented by Effect AI for exactly "MCP tools
   discovered at runtime, plugin systems." `/plugins` binds each discovered tool
   as a `Tool.dynamic`; statically-typed use stays available via plain
   `McpToolkit.bind` for authors who ship local `Tool.make` declarations.
4. **`PLUGIN_DATA` — caller-supplied, required only when referenced.** `load`
   takes an optional `pluginData` path. A server that references `${PLUGIN_DATA}`
   (in `args`/`env`/`cwd`) when none was supplied is an invalid server entry →
   skipped with a warning. Servers that don't reference it are unaffected. No
   silent default directory (a wrong guess is worse than an explicit skip).

### PL0 spike — resolved

- **`Tool.dynamic`** exists with a JSON-Schema mode whose handler receives
  `unknown` params — its docstring names "MCP tools discovered at runtime, plugin
  systems" as the use case. Confirmed fit for §3b.
- **`MemorySandbox.layer({ seed: { "path": "content" } })`**
  (`src/sandbox/memory.ts`) seeds fixture files by path — the deterministic test
  substrate for the whole loader, no disk.
- **`McpToolkit.Connection`** is a plain interface (`listTools`, `callTool`),
  trivially faked in tests; `McpToolkit.bind`'s own docs already point at
  `Tool.dynamic` for discovered tools. If a `bindDiscovered` helper turns out to
  belong next to `bind`, it goes in `src/mcp/McpToolkit.ts`, not `/plugins`.

---

## 9. Files (new + touched)

- **New:** `src/plugins/index.ts`, `src/plugins/Plugins.ts` (loader + API),
  `src/plugins/internal/frontmatter.ts` (parser),
  `test/Plugins.test.ts`, `test/PluginFrontmatter.test.ts`,
  `examples/agent-plugins.ts`, fixture plugin files (built into a `MemorySandbox`
  in-test, not committed as a tree unless an on-disk fixture is clearer).
- **Touched:** `package.json` (`"./plugins"` export), possibly
  `src/mcp/McpToolkit.ts` (a `bindDiscovered` helper if PL0 shows one is missing),
  `README.md`, `STATUS.md`, `ROADMAP.md`. **Not touched:** core, `HOST_MODULES`.

Everything here is an adapter over existing seams — no core execution-model
change, no new host module, and the spec's normative `MUST`s become the test
suite's invariants.
