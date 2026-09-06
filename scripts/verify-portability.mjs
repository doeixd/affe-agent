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
import ts from "typescript"

const root = process.cwd()
// An explicit source root lets the check itself be tested against fixtures.
// Flags are filtered out first, so `--host` may appear on either side of it.
const positionalRoot = process.argv
  .slice(2)
  .find((argument) => !argument.startsWith("--"))
const sourceRoot = positionalRoot === undefined
  ? path.join(root, "src")
  : path.resolve(positionalRoot)

/**
 * Host implementations, by path relative to `src/`. Keep this list short.
 *
 * `connectors/slack.ts` was on this list until it moved from `node:crypto` to
 * the Web Crypto API. Removing an entry is the only proof that a module became
 * portable, which is why the list is checked rather than merely documented.
 */
// `cloudflare/` is the Cloudflare host entry, on `effect-cf` and the DO
// SQLite driver by design (`docs/plan-effect-cf-and-webtransport.md` §3).
const HOST_MODULES = new Set(["sandbox/local.ts", "blob/fs.ts", "cloudflare/index.ts", "cloudflare/isolate.ts"])

const builtins = new Set(builtinModules)

/**
 * Packages that bind a module to one host, grouped by *which* host.
 *
 * An allowlist of known-bad rather than a rule, which is a real weakness: the
 * check only stops what somebody thought to name. It missed the Cloudflare
 * group entirely -- including `@effect/sql-sqlite-do`, a platform package
 * `apps/worker` already uses -- so anything in that set imported into `src/`
 * passed the check built to stop it.
 *
 * Grouped rather than merged into one pattern, because "host coupling" is
 * relative to a target. The portable core must import none of these. The
 * workerd bundle *is* the Cloudflare host, so the Cloudflare group is exactly
 * what it is allowed to reach for, and rejecting it there would be the check
 * refusing the thing it exists to prove works. Hence `--host`.
 */
const HOST_GROUPS = {
  node: /^@effect\/(platform-node|sql-sqlite-node|sql-pg|sql-mysql2)/,
  bun: /^@effect\/(platform-bun|sql-sqlite-bun)|^bun:|^bun(\/|$)/,
  deno: /^@effect\/platform-deno|^deno(\/|$)/,
  cloudflare: /^@effect\/(sql-d1|sql-sqlite-do)|^effect-cf(\/|$)|^@cloudflare\//,
  // Not a runtime of its own; a driver that pins you to one service.
  other: /^@effect\/sql-libsql/
}

/**
 * The host this target is allowed to be. `--host=cloudflare` for the workerd
 * bundle; absent means fully portable, which is the default and the stricter
 * reading.
 */
const targetHost = process.argv
  .slice(2)
  .find((argument) => argument.startsWith("--host="))
  ?.slice("--host=".length)

if (targetHost !== undefined && !Object.hasOwn(HOST_GROUPS, targetHost)) {
  console.error(
    `unknown --host=${targetHost}; expected one of ${Object.keys(HOST_GROUPS).join(", ")}`
  )
  process.exit(1)
}

const rejected = Object.entries(HOST_GROUPS)
  .filter(([host]) => host !== targetHost)
  .map(([, pattern]) => pattern)

const isHostPackage = (specifier) =>
  rejected.some((pattern) => pattern.test(specifier))

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory()
      ? walk(full)
      : entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")
        ? [full]
        : []
  })

// Parse actual syntax: strings/comments are not imports or global accesses.
// A small no-lib program also distinguishes a local `process` parameter from
// the host global without loading dependencies or the application tsconfig.
const files = walk(sourceRoot)
const program = ts.createProgram(files, { noResolve: true, noLib: true, types: [] })
const checker = program.getTypeChecker()
const hostGlobals = new Set(["process", "Buffer", "__dirname", "__filename", "require"])
const violations = []
for (const file of files) {
  const relative = path.relative(sourceRoot, file).split(path.sep).join("/")
  if (HOST_MODULES.has(relative)) continue
  const source = program.getSourceFile(file)

  const checkImport = (literal) => {
    if (literal === undefined || !ts.isStringLiteralLike(literal)) return
    const specifier = literal.text
    if (specifier.startsWith("node:") || builtins.has(specifier)) {
      violations.push(`${relative}: imports Node built-in "${specifier}"`)
    } else if (isHostPackage(specifier)) {
      violations.push(`${relative}: imports host package "${specifier}"`)
    }
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      checkImport(node.moduleSpecifier)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      checkImport(node.arguments[0])
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      checkImport(node.argument.literal)
    } else if (ts.isExternalModuleReference(node)) {
      checkImport(node.expression)
    }

    if (ts.isIdentifier(node) && hostGlobals.has(node.text)) {
      const parent = node.parent
      // A property/declaration name is not a reference; shorthand properties
      // are, and can capture a global just like an ordinary expression.
      const nameOnly = parent.name === node && !ts.isShorthandPropertyAssignment(parent)
      const symbol = checker.getSymbolAtLocation(node)
      if (!nameOnly && (symbol?.declarations?.length ?? 0) === 0) {
        const usage = node.text === "process" && ts.isPropertyAccessExpression(parent) && parent.expression === node
          ? parent.getText(source)
          : node.text === "process" && ts.isElementAccessExpression(parent) && parent.expression === node
          ? parent.getText(source)
          : node.text === "require" && ts.isCallExpression(parent) && parent.expression === node
          ? "require("
          : node.text
        violations.push(`${relative}: uses host global "${usage}"`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
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
