/**
 * The commits of a range, each with its `Behavior-Change:` trailer values and
 * the files it touched. Shared by `verify-behavior-change.mjs`, which enforces
 * the trailer, and `changelog-behavior-changes.mjs`, which publishes it, so the
 * two cannot read the log differently.
 */
import { execFileSync } from "node:child_process"

export const TRAILER = "Behavior-Change"
export const FIXTURES = "test/fixtures/"

/** The README describes the convention; editing it changes no behaviour. */
export const isFixture = (file) => file.startsWith(FIXTURES) && !file.endsWith("README.md")

export const git = (args, onFailure) => {
  try {
    return execFileSync("git", args, { encoding: "utf8" })
  } catch (error) {
    onFailure(`git failed for ${args.join(" ")}: ${String(error.stderr ?? error)}`)
    process.exit(1)
  }
}

// One record per commit: hash, subject, the trailer's values, then the files
// it touched. ASCII record and unit separators, written as escapes: the first
// version had them as literal control bytes, which read as empty strings in
// the source.
const RECORD = "\u001e"
const FIELD = "\u001f"

/**
 * @returns {Array<{ hash: string, subject: string, trailers: Array<string>, files: Array<string> }>}
 *   oldest first, as a changelog reads.
 */
export const readBehaviorChanges = (range, onFailure) => {
  const log = git(
    [
      "log",
      "--reverse",
      `--format=${RECORD}%h${FIELD}%s${FIELD}%(trailers:key=${TRAILER},valueonly,unfold)${FIELD}`,
      "--name-only",
      range
    ],
    onFailure
  )
  return log
    .split(RECORD)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      // Trailers may span several lines. Delimit their entire block before
      // parsing paths, otherwise the second trailer becomes a filename.
      const [hash, subject, trailerBlock, fileBlock] = chunk.split(FIELD)
      const trailers = (trailerBlock ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
      const files = (fileBlock ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
      return { hash, subject: subject ?? "", trailers, files }
    })
}
