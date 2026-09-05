/**
 * A wire or journal change is measured by a recorded fixture
 * (`test/fixtures/README.md`). This ties that measurement to the commit log,
 * in both directions:
 *
 *   - a commit that touches `test/fixtures/` must carry a `Behavior-Change:`
 *     trailer -- one sentence saying what changed for a caller -- or the
 *     build fails naming the commit;
 *   - a commit that carries the trailer but touches no fixture is reported,
 *     because a behaviour change that measured nothing has not been recorded.
 *
 * Both are read with `git log`, from the commit the fixtures convention
 * landed in (`BASELINE`) to `HEAD`; commits before it predate the rule. The
 * range can be overridden with `BEHAVIOR_CHANGE_RANGE=<a>..<b>` so the check
 * can be pointed at a known-bad range to prove it fires.
 *
 * A clone too shallow to hold the baseline cannot answer the question, and
 * says so rather than passing: a check that passes when it cannot see is
 * the failure mode the whole family of `verify:*` scripts exists to avoid.
 *
 * Part of `npm run check`. `plan-context-lessons.md` 2.5.
 */
import { execFileSync } from "node:child_process"

const BASELINE = "1c6b2bd"
const TRAILER = "Behavior-Change"
const FIXTURES = "test/fixtures/"

const range = process.env.BEHAVIOR_CHANGE_RANGE ?? `${BASELINE}..HEAD`

const git = (args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8" })
  } catch (error) {
    console.error(`verify-behavior-change: git failed for ${args.join(" ")}: ${String(error.stderr ?? error)}`)
    console.error("A shallow clone that lacks the baseline cannot be checked; fetch the full history.")
    process.exit(1)
  }
}

// One record per commit: hash, the trailer's values, then the files it touched.
// ASCII record and unit separators, written as escapes: the first version had
// them as literal control bytes, which read as empty strings in the source.
const RECORD = "\u001e"
const FIELD = "\u001f"
const log = git([
  "log",
  `--format=${RECORD}%h${FIELD}%(trailers:key=${TRAILER},valueonly)`,
  "--name-only",
  range
])

const commits = log
  .split(RECORD)
  .map((chunk) => chunk.trim())
  .filter((chunk) => chunk.length > 0)
  .map((chunk) => {
    const [header, ...rest] = chunk.split("\n")
    const [hash, trailerBlock] = header.split(FIELD)
    const trailers = (trailerBlock ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
    const files = rest.map((line) => line.trim()).filter((line) => line.length > 0)
    return { hash, trailers, files }
  })

// The README describes the convention; editing it changes no behaviour.
const isFixture = (file) => file.startsWith(FIXTURES) && !file.endsWith("README.md")

const missing = commits.filter(
  (commit) => commit.files.some(isFixture) && commit.trailers.length === 0
)
const unmeasured = commits.filter(
  (commit) => commit.trailers.length > 0 && !commit.files.some(isFixture)
)

if (missing.length > 0) {
  console.error(
    `verify-behavior-change: ${missing.length} commit(s) in ${range} touch ${FIXTURES} without a \`${TRAILER}:\` trailer:`
  )
  for (const commit of missing) console.error(`  ${commit.hash}`)
  console.error("A fixture changed, so something a caller sees changed. Say what, in one sentence, as a trailer.")
  process.exit(1)
}

for (const commit of unmeasured) {
  console.error(
    `verify-behavior-change: ${commit.hash} declares a behaviour change but touches no fixture; record what it changed.`
  )
}
if (unmeasured.length > 0) process.exit(1)

const declared = commits.filter((commit) => commit.trailers.length > 0).length
console.log(
  `verify-behavior-change: ${commits.length} commit(s) in ${range}, ${declared} declared behaviour change(s), each measured by a fixture`
)
