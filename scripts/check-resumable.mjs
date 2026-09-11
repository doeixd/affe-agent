// `npm run check:resume` -- the same steps as `npm run check`, in the same
// order, but one at a time, recording each step that passed for the current
// commit. A run that dies partway (a machine short of memory kills the long
// one; ours did three times on 2026-09-11) then resumes rather than starting
// over. The test step runs with fewer workers for the same reason. The
// progress file is keyed by commit, so a new commit re-runs everything.
//
// usage: npm run check:resume  (or: node scripts/check-resumable.mjs <file>)
import { execSync, spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"

const progressFile = process.argv[2]
const commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim()
const steps = JSON.parse(readFileSync("package.json", "utf8")).scripts.check.split("&&").map((s) => s.trim())
const progress = existsSync(progressFile) ? JSON.parse(readFileSync(progressFile, "utf8")) : {}
const done = new Set(progress.commit === commit ? progress.done : [])

for (const step of steps) {
  if (done.has(step)) {
    console.log(`skip (passed at ${commit.slice(0, 7)}): ${step}`)
    continue
  }
  const command = step === "npm run test" ? "npx vitest run --maxWorkers=4" : step
  console.log(`run: ${command}`)
  const result = spawnSync(command, { shell: true, stdio: "inherit" })
  if (result.status !== 0) {
    console.log(`FAILED: ${command} (exit ${result.status})`)
    process.exit(1)
  }
  done.add(step)
  writeFileSync(progressFile, JSON.stringify({ commit, done: [...done] }))
}
console.log(`ALL ${steps.length} STEPS PASSED at ${commit}`)
