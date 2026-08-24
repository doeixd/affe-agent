/**
 * Assert the published tarball contains exactly what it should — the built
 * `dist`, the three metadata files, and `package.json` — and nothing stray
 * (no `src`, no tests, no `.ts` sources, no tsconfig). `npm pack` honours the
 * `files` field, so a mistake there (or a stray tracked file) ships to every
 * installer and is invisible to the test suite. This catches it before publish.
 */
import { execFileSync } from "node:child_process"

const REQUIRED_ROOT = ["package.json", "README.md", "CHANGELOG.md", "LICENSE"]

const output = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8", stdio: "pipe" })
// `npm pack --json` prints a JSON array; slice from the first `[` in case npm
// emits any leading notices on stdout.
const files = JSON.parse(output.slice(output.indexOf("[")))[0].files.map((entry) =>
  entry.path.replace(/\\/g, "/")
)

const problems = []

// Everything is either inside dist/ or one of the allowed root files.
const stray = files.filter((path) => !path.startsWith("dist/") && !REQUIRED_ROOT.includes(path))
if (stray.length > 0) {
  problems.push(`stray files in the tarball: ${stray.join(", ")}`)
}

// The build output must actually be there.
if (!files.some((path) => path.startsWith("dist/"))) {
  problems.push("no dist/ output in the tarball — did the build run?")
}

// The metadata files must all be present.
for (const required of REQUIRED_ROOT) {
  if (!files.includes(required)) {
    problems.push(`missing ${required} from the tarball`)
  }
}

// No TypeScript sources should ship outside dist (dist ships .d.ts, which is fine).
const sources = files.filter((path) => path.endsWith(".ts") && !path.startsWith("dist/"))
if (sources.length > 0) {
  problems.push(`TypeScript sources in the tarball: ${sources.join(", ")}`)
}

if (problems.length > 0) {
  console.error("pack check failed:")
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`pack check passed: ${files.length} files, dist + ${REQUIRED_ROOT.join(", ")}, nothing stray`)
