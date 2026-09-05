/**
 * `remaining-work.md` calls itself the live list, and it misdirected twice in
 * one day: item 25 was fully built while its text said four things were
 * still queued, and H7's recorded fix for `ClusterMultiNode` was
 * architecturally impossible. Acting on either would have cost a session.
 *
 * So an entry that makes a claim about the code carries the check that
 * falsifies it, and this runs every one. A line anywhere in the document of
 * the form
 *
 *     verify: grep "some literal" src/path.ts      the file contains it
 *     verify: no-grep "some literal" src/path.ts   the file does not
 *     verify: exists src/path.ts                   the path is there
 *     verify: absent src/path.ts                   the path is not
 *
 * is a claim the entry stands on. When one fails, the entry is stale: either
 * the work it describes as open has landed, or the work it describes as done
 * has been undone, and either way the text has to change before the build
 * goes green. That is the point -- the doc cannot quietly lie about the code.
 *
 * Three files are scanned: the live list, its ledger
 * (`remaining-work-closed.md`) and `STATUS.md`. A closed entry keeps its
 * `verify:` lines when it moves, and there they pin the work as *done* -- an
 * undone fix fails the build from the ledger exactly as unlanded work fails
 * it from the list; and `STATUS.md`'s "what ships" carries pins for the
 * mechanisms it names.
 *
 * Deliberately a four-verb literal DSL rather than shell: `npm run check`
 * runs on Windows, and a check that only fires where `sh` is on the path is a
 * check that fires nowhere it matters. Literal substrings rather than
 * regexes, so the line is readable by someone deciding whether the claim is
 * still the one they meant to make.
 *
 * Part of `npm run check`. Instant: it reads a handful of files.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const docs = ["docs/remaining-work.md", "docs/remaining-work-closed.md", "STATUS.md"]

// `verify: <verb> ["literal"] <path>`. The literal is quoted so it may hold
// spaces; the path is one token.
const shape = /^\s*verify:\s+(grep|no-grep|exists|absent)\s+(?:"((?:[^"\\]|\\.)*)"\s+)?(\S+)\s*$/

/** @type {Array<{ doc: string, line: number, verb: string, literal: string | undefined, target: string }>} */
const checks = []
/** @type {Array<string>} */
const malformed = []

for (const doc of docs) {
  const file = path.join(root, doc)
  if (!fs.existsSync(file)) {
    console.error(`verify-remaining-work: ${doc} is missing`)
    process.exit(1)
  }
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/)
  lines.forEach((text, index) => {
    if (!/^\s*verify:/.test(text)) return
    const match = shape.exec(text)
    if (match === null) {
      malformed.push(`${doc}:${index + 1}: ${text.trim()}`)
      return
    }
    const [, verb, literal, target] = match
    checks.push({
      doc,
      line: index + 1,
      verb,
      literal: literal === undefined ? undefined : literal.replace(/\\(.)/g, "$1"),
      target
    })
  })
}

if (malformed.length > 0) {
  console.error("verify-remaining-work: lines that look like checks but do not parse:")
  for (const entry of malformed) console.error(`  ${entry}`)
  process.exit(1)
}

// Zero checks is a broken parser or a gutted document, not a clean bill.
if (checks.length === 0) {
  console.error("verify-remaining-work: no `verify:` lines found in the live list or the ledger")
  process.exit(1)
}

/** @type {Array<string>} */
const failures = []

for (const check of checks) {
  const target = path.join(root, check.target)
  const present = fs.existsSync(target)
  const where = `${check.doc}:${check.line}`

  switch (check.verb) {
    case "exists":
      if (!present) failures.push(`${where}: expected ${check.target} to exist`)
      break
    case "absent":
      if (present) failures.push(`${where}: expected ${check.target} not to exist`)
      break
    case "grep":
    case "no-grep": {
      if (check.literal === undefined) {
        failures.push(`${where}: ${check.verb} needs a quoted literal`)
        break
      }
      if (!present) {
        // A missing file fails both directions: `no-grep` over nothing is
        // vacuous, and vacuous is the failure mode this script exists for.
        failures.push(`${where}: ${check.target} does not exist`)
        break
      }
      const found = fs.readFileSync(target, "utf8").includes(check.literal)
      if (check.verb === "grep" && !found) {
        failures.push(`${where}: expected ${check.target} to contain ${JSON.stringify(check.literal)}`)
      }
      if (check.verb === "no-grep" && found) {
        failures.push(`${where}: expected ${check.target} not to contain ${JSON.stringify(check.literal)}`)
      }
      break
    }
  }
}

if (failures.length > 0) {
  console.error(`verify-remaining-work: ${failures.length} of ${checks.length} claims no longer hold. The entry is stale; fix the text, not the check.`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(`verify-remaining-work: ${checks.length} claims hold across ${docs.length} files`)
