/**
 * Base vs head, under matched conditions (item 100).
 *
 *   npm run bench                       v0.0.1 vs HEAD
 *   npm run bench -- --base <ref> --head <ref> --samples 12 --rounds 3
 *   npm run bench -- --head WORKTREE    the uncommitted tree as head
 *
 * Nothing has been published, so "the release" is a git ref -- `v0.0.1`, the
 * tag the changelog already uses -- rather than an npm version. Each ref is
 * checked out into its own worktree and runs `bench/run.ts` from *head*
 * (copied in), against that ref's source, sharing this checkout's
 * `node_modules`. The runs are interleaved -- base, head, head, base, ... in
 * rounds -- so drift on the machine lands on both sides.
 *
 * What it reports, and what it does not claim:
 *
 * - per scenario, the median and interquartile range of each side, and every
 *   raw sample;
 * - the exact identities compared: commit, the `src` tree hash, the lockfile
 *   blob -- and when both the source and the lockfile are identical, **no
 *   percentage**, because a difference between identical artifacts is noise
 *   by construction;
 * - the machine: CPU count and model, and load where the OS reports it.
 *
 * A delta is an observation, not a confidence interval and not a regression
 * verdict. Informational only -- deliberately not part of `npm run check`
 * until the variance on a given machine is known.
 *
 * Writes `docs/reports/bench-<date>.json` and prints a table.
 */
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const root = process.cwd()
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const baseRef = arg("base", "v0.0.1")
const headRef = arg("head", "HEAD")
const samples = Number(arg("samples", "12"))
const rounds = Number(arg("rounds", "3"))
const perRun = Math.max(1, Math.ceil(samples / (rounds * 2)))

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
// `^{commit}`: a release tag is annotated, and its own hash is not the commit's.
const identity = (ref) =>
  ref === "WORKTREE"
    ? { ref, commit: `${git("rev-parse", "HEAD")}+uncommitted`, src: "uncommitted", lockfile: git("hash-object", "package-lock.json") }
    : {
      ref,
      commit: git("rev-parse", `${ref}^{commit}`),
      src: git("rev-parse", `${ref}:src`),
      lockfile: git("rev-parse", `${ref}:package-lock.json`)
    }

const installedLockfile = git("hash-object", "package-lock.json")

/**
 * A checkout of `ref` with head's scenarios copied in, and the dependencies
 * *that ref* was built with. When its lockfile is the one installed here, this
 * checkout's `node_modules` is linked in; when it is not, the ref gets its own
 * `npm ci` -- slower, and the only way the comparison is of the library rather
 * than of two dependency trees (v0.0.1 run against today's modules fails
 * outright). `release` removes a link *before* the worktree: a forced removal
 * follows a junction and empties the target, which is how this repository's
 * `node_modules` was once lost.
 */
const checkout = (ref) => {
  if (ref === "WORKTREE") return { dir: root, dependencies: "this checkout", release: () => {} }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "affe-bench-"))
  fs.rmSync(dir, { recursive: true, force: true })
  git("worktree", "add", "--detach", dir, ref)
  fs.mkdirSync(path.join(dir, "bench"), { recursive: true })
  fs.copyFileSync(path.join(root, "bench", "run.ts"), path.join(dir, "bench", "run.ts"))
  const link = path.join(dir, "node_modules")
  const shared = git("rev-parse", `${ref}:package-lock.json`) === installedLockfile
  if (shared) {
    if (process.platform === "win32") {
      execFileSync("cmd", ["/c", "mklink", "/J", link, path.join(root, "node_modules")], { stdio: "ignore" })
    } else {
      fs.symlinkSync(path.join(root, "node_modules"), link, "dir")
    }
  } else {
    process.stderr.write(`${ref}: its lockfile differs, installing its own dependencies...\n`)
    try {
      execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, stdio: "pipe", shell: true })
    } catch (error) {
      // A failed install leaves a real directory, never a link: safe to remove.
      git("worktree", "remove", "--force", dir)
      throw new Error(`npm ci failed for ${ref}:\n${String(error.stderr ?? error).slice(-2000)}`)
    }
  }
  return {
    dir,
    dependencies: shared ? "linked (same lockfile)" : "own install (npm ci)",
    release: () => {
      if (shared) {
        if (process.platform === "win32") execFileSync("cmd", ["/c", "rmdir", link], { stdio: "ignore" })
        else fs.unlinkSync(link)
        if (fs.existsSync(path.join(link, "effect"))) {
          throw new Error(`refusing to remove ${dir}: its node_modules link is still in place`)
        }
      }
      git("worktree", "remove", "--force", dir)
    }
  }
}

// `--only "<name>|<name>"`: the scenarios to run, passed through.
const onlyArg = arg("only", undefined)
const runOnce = (dir) => {
  const args = ["tsx", "bench/run.ts", "--samples", String(perRun), "--warmup", "1"]
  if (onlyArg !== undefined) args.push("--only", JSON.stringify(onlyArg))
  const out = execFileSync("npx", args, {
    cwd: dir,
    encoding: "utf8",
    shell: true,
    maxBuffer: 16 * 1024 * 1024
  })
  return out.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line))
}

const quantile = (sorted, q) => {
  const at = (sorted.length - 1) * q
  const low = Math.floor(at)
  return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (at - low)
}
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    median: quantile(sorted, 0.5),
    q1: quantile(sorted, 0.25),
    q3: quantile(sorted, 0.75)
  }
}

// The base is released if the head's checkout throws: a side created before a
// later failure must not be left behind (it was, once).
const baseSide = checkout(baseRef)
let headSide
try {
  headSide = checkout(headRef)
} catch (error) {
  baseSide.release()
  throw error
}
const sides = { base: baseSide, head: headSide }
const collected = { base: new Map(), head: new Map() }
try {
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? ["base", "head"] : ["head", "base"]
    for (const side of order) {
      for (const line of runOnce(sides[side].dir)) {
        const entry = collected[side].get(line.scenario) ?? { ok: line.ok, samples: [], metrics: line.metrics, error: line.error }
        if (line.ok) entry.samples.push(...line.samples)
        collected[side].set(line.scenario, entry)
      }
      process.stderr.write(`round ${round + 1}/${rounds}: ${side} done\n`)
    }
  }
} finally {
  sides.base.release()
  sides.head.release()
}

const base = { ...identity(baseRef), dependencies: sides.base.dependencies }
const head = { ...identity(headRef), dependencies: sides.head.dependencies }
const identical = base.src === head.src && base.lockfile === head.lockfile
const scenarios = [...new Set([...collected.base.keys(), ...collected.head.keys()])].map((name) => {
  const b = collected.base.get(name)
  const h = collected.head.get(name)
  const bs = b?.ok ? stats(b.samples) : undefined
  const hs = h?.ok ? stats(h.samples) : undefined
  return {
    scenario: name,
    base: b?.ok ? { ...bs, metrics: b.metrics, samples: b.samples } : { unavailable: b?.error ?? "not run" },
    head: h?.ok ? { ...hs, metrics: h.metrics, samples: h.samples } : { unavailable: h?.error ?? "not run" },
    deltaPercent: bs && hs && !identical ? Math.round(((hs.median - bs.median) / bs.median) * 1000) / 10 : null
  }
})

const report = {
  at: new Date().toISOString(),
  base,
  head,
  identicalArtifacts: identical,
  method: { samplesPerSide: samples, rounds, perRun, interleaved: true, statistic: "median, IQR" },
  machine: { cpus: os.cpus().length, model: os.cpus()[0]?.model ?? "unknown", loadavg: os.loadavg(), platform: process.platform },
  caveat: "Timings are observations under the scripted model, not confidence intervals or regression verdicts.",
  scenarios
}
// Named by both sides, so a second comparison on the same day does not
// overwrite the first (it did, once).
const file = path.join(
  "docs",
  "reports",
  `bench-${report.at.slice(0, 10)}-${base.commit.slice(0, 8)}-${head.commit.slice(0, 8).replace("+", "")}.json`
)
fs.writeFileSync(path.join(root, file), JSON.stringify(report, null, 2) + "\n")

const fmt = (s) => (s && "median" in s ? `${s.median.toFixed(1)} ms [${s.q1.toFixed(1)}–${s.q3.toFixed(1)}]` : "unavailable")
console.log(`base ${base.ref} (${base.commit.slice(0, 8)})  vs  head ${head.ref} (${head.commit.slice(0, 8)})`)
if (identical) console.log("source and lockfile identical: no percentage reported")
for (const row of scenarios) {
  const delta = row.deltaPercent === null ? "" : `  ${row.deltaPercent > 0 ? "+" : ""}${row.deltaPercent}%`
  const metrics = row.head.metrics && Object.keys(row.head.metrics).length > 0 ? `  ${JSON.stringify(row.head.metrics)}` : ""
  console.log(`${row.scenario.padEnd(40)} ${fmt(row.base).padEnd(28)} ${fmt(row.head).padEnd(28)}${delta}${metrics}`)
}
console.log(`-> ${file}`)
