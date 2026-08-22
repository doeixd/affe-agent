/**
 * The portability guardrail: portable source must not couple to a host.
 *
 * Core code speaks Effect's platform services -- `SqlClient`, `HttpServer`,
 * `FileSystem` -- and concrete hosts (Node, Bun, Deno) arrive as Layers at the
 * application edge. The one place in `src/` that genuinely is a host
 * implementation is the local sandbox provider, and it has its own package
 * entry so that importing the portable surface never loads it.
 *
 * This check makes the boundary a failure rather than a convention. It
 * rejects, in every portable module:
 *
 *   - imports of `node:*`, or of Node built-ins by bare name;
 *   - imports of a concrete platform package (`@effect/platform-node`, `-bun`,
 *     `-deno`, `@effect/sql-sqlite-*`, ...);
 *   - `require(...)`;
 *   - host globals: `process.*`, `Buffer`, `__dirname`, `__filename`.
 *
 * Web-standard globals (`globalThis.crypto`, `TextEncoder`, `fetch`) are not
 * host coupling and are allowed: every Effect-supported runtime provides
 * them.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { builtinModules } from "node:module"

const root = process.cwd()
const sourceRoot = path.join(root, "src")

/** Host implementations, by path relative to `src/`. Keep this list short. */
const HOST_MODULES = new Set(["sandbox/local.ts"])

const builtins = new Set(builtinModules)
const hostPackages =
  /^@effect\/(platform-node|platform-bun|platform-deno|sql-sqlite-node|sql-sqlite-bun|sql-pg|sql-mysql2|sql-d1|sql-libsql)/

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory()
      ? walk(full)
      : entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")
        ? [full]
        : []
  })

const importPattern = /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const globalsPattern = /\b(process\.[a-zA-Z_]+|Buffer\b|__dirname\b|__filename\b|require\s*\()/g

const violations = []
for (const file of walk(sourceRoot)) {
  const relative = path.relative(sourceRoot, file).split(path.sep).join("/")
  if (HOST_MODULES.has(relative)) continue
  const text = fs.readFileSync(file, "utf8")
  // Comments are not code; strip them so prose can mention `process.env`.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

  for (const match of code.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2]
    if (specifier === undefined) continue
    if (specifier.startsWith("node:") || builtins.has(specifier)) {
      violations.push(`${relative}: imports Node built-in "${specifier}"`)
    } else if (hostPackages.test(specifier)) {
      violations.push(`${relative}: imports host package "${specifier}"`)
    }
  }
  for (const match of code.matchAll(globalsPattern)) {
    violations.push(`${relative}: uses host global "${match[1].trim()}"`)
  }
}

if (violations.length > 0) {
  console.error("portability check failed:")
  for (const violation of violations) console.error(`  ${violation}`)
  console.error(
    "\nPortable modules must reach the host through Effect platform services." +
      "\nA genuine host implementation belongs in its own entry and in HOST_MODULES."
  )
  process.exit(1)
}
console.log("portability check passed: no host coupling outside host modules")
