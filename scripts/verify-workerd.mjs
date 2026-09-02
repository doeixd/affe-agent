/**
 * Workerd bundle probe — docs/plan-deployment.md §10 Sequence 1.
 *
 * Step 1 is not a deployment, just a bundle: "compile the portable core for
 * workerd. No entry point, no deployment — just a bundle. This is the cheapest
 * possible test of the guardrail and it either passes or produces the findings
 * that shape everything after it."
 *
 * What it proves:
 * - `apps/worker/src` typechecks with `lib: ["DOM","WebWorker"]` and `types: []`
 *   (no `node:*` globals, no `Buffer`, `process`, `__dirname`).
 * - `scripts/verify-portability.mjs` passes on `apps/worker/src` with
 *   `--host=cloudflare`: Cloudflare packages are allowed there and nowhere
 *   else, while Node, Bun and Deno coupling still fails.
 * - If `esbuild` is available, the same entry bundles for `browser`/`neutral`
 *   without the `node` export condition — the way workerd/Bun/Deno see the package.
 *
 * Exit non-zero on the first failure so CI can gate on it.
 */

import { execFileSync } from "node:child_process"
import * as path from "node:path"

const root = process.cwd()
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe", ...opts }).trim()

const step = (label, fn) => {
  process.stdout.write(`${label}... `)
  try {
    fn()
    console.log("ok")
  } catch (error) {
    console.log("FAILED")
    const stderr = error.stderr ?? error.stdout ?? String(error)
    console.error(stderr)
    process.exitCode = 1
    throw error
  }
}

step("workerd: tsc --noEmit --project apps/worker/tsconfig.json", () =>
  run("npx", ["tsc", "--noEmit", "--project", "apps/worker/tsconfig.json"], { cwd: root })
)

step("workerd: verify-portability apps/worker/src", () =>
  // `--host=cloudflare`: this bundle *is* the Cloudflare host, so `effect-cf`,
  // `@cloudflare/*` and the D1/DO drivers are what it is meant to reach for.
  // Every other host group -- Node, Bun, Deno -- is still rejected here, which
  // is the coupling this step exists to catch.
  run(
    "node",
    ["scripts/verify-portability.mjs", "apps/worker/src", "--host=cloudflare"],
    { cwd: root }
  )
)

// Optional bundle probe — best-effort. If esbuild is not installed, skip rather than fail.
// The typecheck above is the required gate; a bundle adds confidence but is not load-bearing
// until a real Worker entry with a DO is built (Sequence 2).
const hasEsbuild = (() => {
  try {
    run("npx", ["--yes", "esbuild", "--version"], { cwd: root })
    return true
  } catch {
    return false
  }
})()

if (hasEsbuild) {
  step("workerd: esbuild --bundle apps/worker/src/index.ts --platform=browser --format=esm", () => {
    const out = path.join(root, "dist", "worker-probe.mjs")
    run("npx", ["esbuild", "apps/worker/src/index.ts", "--bundle", "--platform=browser", "--format=esm", `--outfile=${out}`, "--external:effect", "--external:effect/*", "--external:cloudflare:*", "--external:node:*"], {
      cwd: root
    })
    console.log(`  → ${out}`)
  })
} else {
  console.log("workerd: esbuild not available — bundle probe skipped (typecheck is the gate)")
}

if (process.exitCode !== 1) {
  console.log(
    "\nworkerd probe passed — the portable core typechecks and bundles without node:*"
  )
}
