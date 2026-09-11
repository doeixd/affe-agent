/**
 * The commits of a range, each with its `Behavior-Change:` trailer values and
 * the files it touched. Shared by `verify-behavior-change.mjs`, which enforces
 * the trailer, and `changelog-behavior-changes.mjs`, which publishes it, so the
 * two cannot read the log differently.
 */
import { execFileSync } from "node:child_process"

export const TRAILER = "Behavior-Change"
/**
 * Names an earlier commit whose behaviour change this one measures: the
 * fixture was recorded after the change landed. The commit carrying it must
 * touch a fixture itself.
 */
export const MEASURES = "Behavior-Change-Measures"

/**
 * Behaviour changes with nothing on a wire or in a journal to record: a
 * change to types, or to what a caller must pass. Each with its reason, so the
 * exception is reviewed rather than assumed.
 */
export const TYPE_ONLY = {
  "9342c8e": "authorization and principal became required options of two entry points; no wire or journal bytes changed",
  "e30f31f": "AgentOutput.fromTool refuses a provider-defined tool when an agent is built; no wire or journal bytes changed"
}
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
 * @returns {Array<{ hash: string, subject: string, trailers: Array<string>, measures: Array<string>, files: Array<string> }>}
 *   oldest first, as a changelog reads.
 */
export const readBehaviorChanges = (range, onFailure) => {
  const log = git(
    [
      "log",
      "--reverse",
      `--format=${RECORD}%h${FIELD}%s${FIELD}%(trailers:key=${TRAILER},valueonly,unfold)${FIELD}%(trailers:key=${MEASURES},valueonly,unfold)${FIELD}`,
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
      const [hash, subject, trailerBlock, measuresBlock, fileBlock] = chunk.split(FIELD)
      // Each value begins with the measured commit's hash; anything after it
      // is the reason, for a reader.
      const measures = (measuresBlock ?? "").split("\n")
        .map((line) => line.trim().split(/\s/)[0] ?? "")
        // A commit hash, or nothing: a free-text value would otherwise be
        // read as a hash prefix and exempt every commit it happens to start.
        .filter((named) => /^[0-9a-f]{7,40}$/.test(named))
      const trailers = (trailerBlock ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
      const files = (fileBlock ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
      return { hash, subject: subject ?? "", trailers, measures, files }
    })
}
