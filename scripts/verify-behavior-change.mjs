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
import { FIXTURES, isFixture, readBehaviorChanges, TRAILER } from "./lib/behavior-changes.mjs"

const BASELINE = "1c6b2bd"

const range = process.env.BEHAVIOR_CHANGE_RANGE ?? `${BASELINE}..HEAD`

const commits = readBehaviorChanges(range, (message) => {
  console.error(`verify-behavior-change: ${message}`)
  console.error("A shallow clone that lacks the baseline cannot be checked; fetch the full history.")
})

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
