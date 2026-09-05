/**
 * `CHANGELOG.md`'s behaviour-change lines, derived from the commit log rather
 * than remembered (item 60k; `plan-context-lessons.md` 2.5).
 *
 * Every commit since the last release tag that carries a `Behavior-Change:`
 * trailer (which `verify-behavior-change.mjs` requires of any commit touching
 * a fixture) becomes one line -- the sentence, the commit, and the fixture
 * that measured it -- inside a marked block under `## [Unreleased]`:
 *
 *   <!-- behavior-changes:start -->
 *   ### Behaviour changes
 *   - <sentence> (`<hash>`; measured by `test/fixtures/<file>`)
 *   <!-- behavior-changes:end -->
 *
 * The block is regenerated whole, so it is idempotent and hand edits inside
 * it are overwritten; write around it. Modes:
 *
 *   --write   rewrite the block in CHANGELOG.md (creating `## [Unreleased]`
 *             after the header if there is none);
 *   --check   fail if the block differs from what --write would produce, so a
 *             behaviour change that was measured cannot be left out of the
 *             changelog. Part of `npm run check`.
 *   (none)    print the block.
 *
 * The range is `<last tag>..HEAD`, overridable with `BEHAVIOR_CHANGE_RANGE`.
 * At a release, tag, and the next block starts empty.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { git, isFixture, readBehaviorChanges } from "./lib/behavior-changes.mjs"

const CHANGELOG = "CHANGELOG.md"
const START = "<!-- behavior-changes:start -->"
const END = "<!-- behavior-changes:end -->"

const fail = (message) => {
  console.error(`changelog-behavior-changes: ${message}`)
  process.exit(1)
}

const lastTag = () => git(["describe", "--tags", "--abbrev=0"], fail).trim()
const range = process.env.BEHAVIOR_CHANGE_RANGE ?? `${lastTag()}..HEAD`

const lines = readBehaviorChanges(range, fail)
  .filter((commit) => commit.trailers.length > 0)
  .flatMap((commit) => {
    const fixtures = commit.files.filter(isFixture)
    const measured = fixtures.length === 0
      ? "unmeasured"
      : `measured by ${fixtures.map((file) => `\`${file}\``).join(", ")}`
    return commit.trailers.map((sentence) => `- ${sentence} (\`${commit.hash}\`; ${measured})`)
  })

const block = [
  START,
  "### Behaviour changes",
  "",
  ...(lines.length === 0 ? [`_None since ${range.split("..")[0]}._`] : lines),
  END
].join("\n")

const mode = process.argv[2]
if (mode === undefined) {
  console.log(block)
  process.exit(0)
}

const current = readFileSync(CHANGELOG, "utf8")
const start = current.indexOf(START)
const end = current.indexOf(END)
let next
if (start !== -1 && end !== -1 && end > start) {
  next = current.slice(0, start) + block + current.slice(end + END.length)
} else if (start === -1 && end === -1) {
  const unreleased = current.indexOf("## [Unreleased]")
  if (unreleased !== -1) {
    const afterHeading = current.indexOf("\n", unreleased) + 1
    next = `${current.slice(0, afterHeading)}\n${block}\n${current.slice(afterHeading)}`
  } else {
    const firstRelease = current.indexOf("\n## [")
    if (firstRelease === -1) fail(`${CHANGELOG} has no release heading to insert before`)
    next = `${current.slice(0, firstRelease)}\n## [Unreleased]\n\n${block}\n${current.slice(firstRelease)}`
  }
} else {
  fail(`${CHANGELOG} has one of the block markers without the other`)
}

if (mode === "--write") {
  if (next !== current) writeFileSync(CHANGELOG, next)
  console.log(`changelog-behavior-changes: ${lines.length} line(s) in ${range}, block ${next === current ? "unchanged" : "rewritten"}`)
} else if (mode === "--check") {
  if (next !== current) {
    fail(
      `${CHANGELOG}'s behaviour-change block is out of date for ${range}. ` +
        "Run `npm run changelog:behavior-changes` and commit the result."
    )
  }
  console.log(`changelog-behavior-changes: ${CHANGELOG} lists every behaviour change in ${range} (${lines.length})`)
} else {
  fail(`unknown mode ${mode}; use --write, --check, or nothing`)
}
