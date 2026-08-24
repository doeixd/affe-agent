/**
 * Glob matching for the `include` filter on `search`.
 *
 * opencode hands `include` to ripgrep's `--glob`, so the semantics ported here
 * are ripgrep's (which are gitignore's), not a general glob library's:
 *
 * - `*` matches within one path segment and never crosses `/`.
 * - `**` matches any number of segments, including none.
 * - `?` matches a single character other than `/`.
 * - `{a,b}` matches either alternative.
 * - **A pattern containing no `/` is matched against the file's name alone**,
 *   at any depth. That is why `*.ts` finds `src/deep/a.ts`, while `src/*.ts`
 *   matches only files directly inside `src`.
 *
 * Everything else is literal, including regex metacharacters -- a pattern like
 * `a.b.ts` matches that name, not "any character".
 */

const REGEX_METACHARACTERS = /[.+^$()|[\]\\]/g

/**
 * The pattern as a regular expression source.
 *
 * Written as a single pass so that `*` and `**` can be told apart, and so a
 * brace group's commas are not confused with literal ones outside it.
 */
const toRegexSource = (pattern: string): string => {
  let source = ""
  let depth = 0
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` swallows the separator too, so the pattern also matches at
        // depth zero: `**/a.ts` finds a top-level `a.ts`.
        if (pattern[i + 2] === "/") {
          source += "(?:.*/)?"
          i += 2
        } else {
          source += ".*"
          i += 1
        }
      } else {
        source += "[^/]*"
      }
      continue
    }
    if (char === "?") {
      source += "[^/]"
      continue
    }
    if (char === "{") {
      depth++
      source += "(?:"
      continue
    }
    if (char === "}" && depth > 0) {
      depth--
      source += ")"
      continue
    }
    if (char === "," && depth > 0) {
      source += "|"
      continue
    }
    source += (char ?? "").replace(REGEX_METACHARACTERS, "\\$&")
  }
  return source
}

/** The last segment of a path. */
const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

/**
 * Whether `path` (workspace-relative, `/`-separated) matches `pattern`.
 *
 * An unparseable pattern matches nothing rather than throwing: `include` is
 * model-supplied, and a bad filter should narrow the search to nothing that the
 * caller can see and correct, not fail the whole tool.
 */
export const matches = (pattern: string, path: string): boolean => {
  if (pattern.length === 0) return true
  const source = toRegexSource(pattern)
  const target = pattern.includes("/") ? path : basename(path)
  try {
    return new RegExp(`^${source}$`).test(target)
  } catch {
    return false
  }
}
