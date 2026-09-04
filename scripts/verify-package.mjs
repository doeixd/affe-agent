/**
 * Import every published entry point from the packed artifact.
 *
 * `npm run check` proves the source is sound; it says nothing about whether the
 * *package* is. Every public subpath resolves through `exports`, and a wrong path,
 * a missing build output or a mismatched condition is invisible to the test
 * suite and visible to the first person who installs it.
 *
 * So this packs the tarball, installs it into a scratch directory, and imports
 * each subpath the way a consumer would.
 */
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" }).trim()

const root = process.cwd()
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8")
)
const subpaths = Object.keys(manifest.exports).filter(
  (name) => name !== "./package.json"
)

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "affe-agent-pack-"))
let failures = 0

try {
  const packed = path.join(
    scratch,
    run("npm", ["pack", "--silent", "--pack-destination", scratch], root)
      .split("\n")
      .pop()
  )

  fs.writeFileSync(
    path.join(scratch, "package.json"),
    JSON.stringify({ name: "consumer", type: "module", private: true }, null, 2)
  )
  // The real dependency tree, so a missing peer shows up here rather than for
  // a user.
  //
  // Every peer, not just `effect`: an entry point that exists *because* of an
  // optional peer (`./code/callscript`) cannot be imported without it, and
  // skipping it would drop the gate for exactly the entries most likely to
  // break -- the ones whose dependency this package does not control.
  run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      packed,
      ...Object.entries(manifest.peerDependencies).map(
        ([name, range]) => `${name}@${range}`
      )
    ],
    scratch
  )

  const hostEntries = new Set(["./sandbox/local", "./connectors/slack", "./blob/fs"])
  // The Cloudflare entry imports `cloudflare:workers`, which only workerd
  // provides: on Node it can be *resolved* through `exports` and no more.
  // Importing it is what `test/WorkerDurableObject.test.ts` does, on workerd.
  const workerdEntries = new Set(["./cloudflare"])
  const hook = pathToFileURL(
    path.join(root, "scripts", "no-node-builtins.mjs")
  ).href

  for (const subpath of subpaths) {
    const specifier = subpath.replace(/^\./, manifest.name)
    // Every entry is a host implementation or it is portable. A portable
    // entry is imported under a resolution hook that refuses Node built-ins,
    // so the check is on the artifact a consumer installs, not on the source:
    // a dependency reaching for `node:fs` at import time fails here.
    const portable = !hostEntries.has(subpath) && !workerdEntries.has(subpath)
    fs.writeFileSync(
      path.join(scratch, "probe.mjs"),
      workerdEntries.has(subpath)
        ? `const url = import.meta.resolve(${JSON.stringify(specifier)})\n` +
          `if (!url.endsWith("/dist/cloudflare/index.js")) throw new Error("resolved to " + url)\n` +
          `console.log(${JSON.stringify(specifier)}, "(workerd) ->", url)\n`
        : `const m = await import(${JSON.stringify(specifier)})\n` +
        `if (Object.keys(m).length === 0) throw new Error("no exports")\n` +
        `console.log(${JSON.stringify(specifier)}, ${
          JSON.stringify(portable ? "(portable) ->" : "(host) ->")
        }, Object.keys(m).join(","))\n`
    )
    try {
      console.log(
        run(
          "node",
          portable
            ? ["--import", hook, "probe.mjs"]
            : ["probe.mjs"],
          scratch
        )
      )
    } catch (error) {
      failures++
      console.error(`FAILED ${specifier}: ${error.stderr ?? error.message}`)
    }
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`${failures} entry point(s) failed to import from the package`)
  process.exit(1)
}
console.log(
  `all ${subpaths.length} entry points import from the packed artifact`
)
