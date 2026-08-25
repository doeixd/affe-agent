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
 * How long a pattern may be, and how deeply braces may nest.
 *
 * `include` is model-supplied and compiles to a native regular expression, so
 * it is an input that can cost the process arbitrarily much. Nested brace
 * alternations are the expensive shape: `{a,{b,{c,…}}}` becomes nested
 * alternation groups, and a modest pattern can take seconds to match one
 * filename -- a review measured roughly three seconds for a 121-character
 * glob. JavaScript regular expressions run synchronously and cannot be
 * interrupted, so neither an Effect timeout nor cancellation can help once
 * matching has begun. The only defence is refusing the input.
 *
 * The limits are far above any glob a person writes: three levels of braces
 * covers `src/**\/{a,b}.{ts,tsx}` and more.
 */
export const MAX_PATTERN_LENGTH = 256
export const MAX_BRACE_DEPTH = 3

/** A compiled pattern, or the reason it was refused. */
export type Compiled =
  | { readonly _tag: "Matcher"; readonly matches: (path: string) => boolean }
  | { readonly _tag: "Refused"; readonly reason: string }

/**
 * The pattern as a regular expression source.
 *
 * Written as a single pass so that `*` and `**` can be told apart, and so a
 * brace group's commas are not confused with literal ones outside it.
 */
const toRegexSource = (pattern: string): string | undefined => {
  let source = ""
  let depth = 0
  let deepest = 0
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
      if (depth > deepest) deepest = depth
      // Refused here rather than after building the source: the point is not
      // to compile it at all.
      if (deepest > MAX_BRACE_DEPTH) return undefined
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
  const compiled = compile(pattern)
  return compiled._tag === "Matcher" ? compiled.matches(path) : false
}

/**
 * Compile a pattern once, or say why not.
 *
 * `matches` recompiled on every call, so `search` built a fresh regular
 * expression for every file it considered -- multiplying both the ordinary
 * cost and, for an adversarial pattern, the denial of service. A search
 * filters thousands of paths with one filter; it should build it once.
 *
 * A refusal is a message, not a silent empty result: `include` comes from the
 * model, and a filter that quietly matches nothing looks exactly like a search
 * that found nothing. The model cannot correct what it is not told about.
 */
export const compile = (pattern: string): Compiled => {
  if (pattern.length === 0) {
    return { _tag: "Matcher", matches: () => true }
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return {
      _tag: "Refused",
      reason: `the include pattern is longer than ${MAX_PATTERN_LENGTH} characters`
    }
  }
  const source = toRegexSource(pattern)
  if (source === undefined) {
    return {
      _tag: "Refused",
      reason: `the include pattern nests braces more than ${MAX_BRACE_DEPTH} deep`
    }
  }
  const wholePath = pattern.includes("/")
  try {
    const regex = new RegExp(`^${source}$`)
    return {
      _tag: "Matcher",
      matches: (path) => regex.test(wholePath ? path : basename(path))
    }
  } catch {
    // An unparseable pattern matches nothing rather than throwing: a bad
    // filter should narrow the search to nothing the caller can see and
    // correct, not fail the whole tool.
    return { _tag: "Matcher", matches: () => false }
  }
}
