/**
 * How search results are presented to a model.
 *
 * ---------------------------------------------------------------------------
 * Ported from opencode, `packages/opencode/src/tool/grep.ts`, verified against
 * commit 2a6be0a03b93a6734070e10a6c3b56863475f214.
 * Upstream: https://github.com/sst/opencode -- MIT License, Copyright (c) sst.
 *
 * Faithful to upstream: the 100-result limit, `truncated` meaning "we returned
 * exactly the limit", the `Found N matches` header, grouping by file with a
 * blank line between groups, the `  Line N: text` row, the `No files found`
 * empty result, and the truncation sentence word for word.
 *
 * Divergence: each matched line is capped at the same 2000 characters a read
 * caps a line at. Upstream leaves the line at whatever length ripgrep returns,
 * so a single minified file can dominate the output; a bound on every tool's
 * output is an invariant here.
 * ---------------------------------------------------------------------------
 */

import { MAX_LINE_LENGTH, MAX_LINE_SUFFIX } from "./readFormat.js"

/** How many matches a search will return before it stops looking. */
export const SEARCH_LIMIT = 100

/**
 * Directory names a search does not descend into.
 *
 * Without this a search is worthless on a real repository: it walks
 * alphabetically, fills its whole result budget from `dist/` or
 * `node_modules/`, and never reaches the source. Measured on this repository
 * before the rule existed -- 100 matches, 13 files, every one of them build
 * output or a plan document, and 4.6 seconds spent to get there.
 *
 * ripgrep gets this from `.gitignore`, which it can afford to parse because it
 * is a search tool. A fixed list of the usual suspects is most of that value
 * for none of the machinery, and it is deterministic: the same query returns
 * the same results everywhere, which a `.gitignore` walk or an "if ripgrep is
 * installed" fallback would not.
 *
 * A directory is only skipped when the walk would *descend* into it, so
 * scoping a search at `dist` explicitly still searches `dist`.
 */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".gradle",
  ".idea",
  ".vscode"
])

/** What was said when nothing matched. */
export const NO_RESULTS = "No files found"

export interface Match {
  readonly path: string
  readonly line: number
  readonly text: string
}

const cap = (text: string): string =>
  text.length > MAX_LINE_LENGTH ? text.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text

/**
 * The rendered results, grouped by file.
 *
 * Grouping is what makes the output cheap to read: a path is stated once and
 * its matching lines listed under it, rather than repeated on every row.
 * Matches must already be ordered by file for the grouping to be meaningful,
 * which the walk guarantees.
 */
export const render = (matches: ReadonlyArray<Match>): string => {
  if (matches.length === 0) return NO_RESULTS

  // "Exactly the limit" is how upstream infers truncation. It cannot tell a
  // search that found exactly 100 from one that stopped at 100, and says
  // "more available" for both; over-warning is the safe side of that.
  const truncated = matches.length === SEARCH_LIMIT
  const lines: Array<string> = [
    `Found ${matches.length} matches${truncated ? " (more matches available)" : ""}`
  ]

  let current = ""
  for (const match of matches) {
    if (current !== match.path) {
      if (current !== "") lines.push("")
      current = match.path
      lines.push(`${match.path}:`)
    }
    lines.push(`  Line ${match.line}: ${cap(match.text)}`)
  }

  if (truncated) {
    lines.push("")
    lines.push("(Results truncated. Consider using a more specific path or pattern.)")
  }

  return lines.join("\n")
}
