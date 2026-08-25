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

/**
 * How long a pattern may be, and how deeply braces may nest.
 *
 * These bound the size of the compiled automaton, and nothing more. They are
 * deliberately *not* the defence against an expensive pattern -- an earlier
 * version of this file said they were, and the mistake is worth recording,
 * because the reasoning is tempting.
 *
 * That version compiled the glob to a native `RegExp`. A backtracking engine
 * explores every way a run of `*`s can divide the subject, so cost there is
 * exponential in the number of `*`s and not in the length of the pattern --
 * and a length cap bounds the wrong variable. Measured: `*a` repeated twelve
 * times, a **24-character** pattern well inside any sane cap, took 25 seconds
 * against a 41-character name. `search` compiles once and then matches every
 * file it walks, so that is 25 seconds *per file*. JavaScript regular
 * expressions run synchronously and cannot be interrupted, so neither an
 * Effect timeout nor cancellation can end it once it has begun.
 *
 * The defence is that a glob is a regular language and never needed a
 * backtracking engine at all. `compile` builds an automaton and `simulate`
 * runs it, visiting each character once against each state: O(pattern x path)
 * on every input, with nothing to be adversarial about. That removes the
 * exponent rather than bounding it, which is why these caps can go back to
 * being what they read like -- generous limits on absurd input.
 *
 * It is not free: a subset simulation in JavaScript is roughly 25x slower than
 * a native regular expression on patterns that never backtracked anyway, which
 * for `src/**\/*.ts` over 5,000 paths measured 13ms against 0.4ms. Both are
 * lost in the file I/O of the search that asked, and it buys the disappearance
 * of a 25-second-per-file hang, so the trade is not close.
 *
 * Three levels of braces covers `src/**\/{a,b}.{ts,tsx}` and more.
 */
export const MAX_PATTERN_LENGTH = 256
export const MAX_BRACE_DEPTH = 3

/** A compiled pattern, or the reason it was refused. */
export type Compiled =
  | { readonly _tag: "Matcher"; readonly matches: (path: string) => boolean }
  | { readonly _tag: "Refused"; readonly reason: string }

/**
 * One automaton state, which is also one unit of the pattern.
 *
 * A state's index *is* its position in the token stream, so "advance" is
 * `+ 1` and the accepting state is one past the end. The brace tokens carry
 * the indices they jump to, filled in when the closing `}` is reached; that is
 * the only part that cannot be decided in a single left-to-right pass.
 */
type Token =
  | { readonly kind: "literal"; readonly char: string }
  /** `?` -- one character, but never a separator. */
  | { readonly kind: "single" }
  /** `*` -- any run of characters within one segment. */
  | { readonly kind: "star" }
  /** `**` -- any run of characters, separators included. */
  | { readonly kind: "globstar" }
  /**
   * `**\/`, which is three states rather than one, and the reason is subtle
   * enough to be worth stating.
   *
   * It means "any run ending in a separator, **or** nothing at all" -- and the
   * "or nothing" is a choice available on arriving, not one available again
   * after consuming half a directory name. Folding the two into a single
   * self-looping state with an exit-to-next lets it be taken on every
   * re-entry, which quietly turns `**\/` into `**`: a differential fuzz caught
   * `**\/` matching `ata/..b.s`, where the trailing `..b.s` has no separator
   * after it and the pattern must not match.
   *
   * So the empty branch gets its own state, which nothing loops back to:
   * `optionalRun` is entered once and offers the choice, `anyRun` does the
   * consuming, and only `slash` can leave.
   */
  | { readonly kind: "optionalRun"; readonly skip: number }
  /** The consuming half of `**\/`: any run, separators included. */
  | { readonly kind: "anyRun" }
  /** The separator `**\/` must end on, and the only way out of `anyRun`. */
  | { readonly kind: "slash" }
  /** `{` -- branches to the start of each alternative. */
  | { readonly kind: "open"; readonly starts: Array<number> }
  /** `,` -- the end of an alternative, which jumps past the whole group. */
  | { kind: "alternative"; after: number }
  /** `}` -- no choice left to make; falls through. */
  | { readonly kind: "close" }

/**
 * The pattern as automaton states, or `undefined` if braces nest too deeply.
 *
 * A single pass, so that `*` and `**` can be told apart and a brace group's
 * commas are not confused with literal ones outside it. A `,` or `}` outside
 * any group is an ordinary character, which is what a shell does too.
 *
 * Regex metacharacters need no escaping here: a literal is compared with
 * `===`, so `a.b.ts` matches that name and not "any character" because there
 * is no regular expression left to reinterpret it.
 */
const tokenize = (pattern: string): Array<Token> | undefined => {
  const tokens: Array<Token> = []
  /** Indices of the `open` tokens whose groups are still being read. */
  const open: Array<number> = []
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**\/` swallows the separator too, so the pattern also matches at
        // depth zero: `**\/a.ts` finds a top-level `a.ts`.
        if (pattern[i + 2] === "/") {
          const at = tokens.length
          // `skip` is the index just past `slash`, so taking the empty branch
          // steps over all three at once.
          tokens.push({ kind: "optionalRun", skip: at + 3 })
          tokens.push({ kind: "anyRun" })
          tokens.push({ kind: "slash" })
          i += 2
        } else {
          tokens.push({ kind: "globstar" })
          i += 1
        }
      } else {
        tokens.push({ kind: "star" })
      }
      continue
    }
    if (char === "?") {
      tokens.push({ kind: "single" })
      continue
    }
    if (char === "{") {
      if (open.length + 1 > MAX_BRACE_DEPTH) return undefined
      open.push(tokens.length)
      tokens.push({ kind: "open", starts: [] })
      continue
    }
    if (char === "," && open.length > 0) {
      // `after` is resolved below, once this group's `}` says where past it is.
      tokens.push({ kind: "alternative", after: -1 })
      continue
    }
    if (char === "}" && open.length > 0) {
      const start = open.pop()!
      tokens.push({ kind: "close" })
      const after = tokens.length
      const opener = tokens[start]
      if (opener === undefined || opener.kind !== "open") continue
      // The first alternative begins right after `{`, and each later one right
      // after the `,` that ended the previous. Only commas belonging to *this*
      // group count, so nested groups are stepped over rather than descended.
      opener.starts.push(start + 1)
      let depth = 0
      for (let j = start + 1; j < tokens.length - 1; j++) {
        const token = tokens[j]!
        if (token.kind === "open") depth++
        else if (token.kind === "close") depth--
        else if (token.kind === "alternative" && depth === 0) {
          token.after = after
          opener.starts.push(j + 1)
        }
      }
      continue
    }
    tokens.push({ kind: "literal", char: char ?? "" })
  }
  return tokens
}

/** The last segment of a path. */
const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

/**
 * Run the automaton over `path`.
 *
 * Textbook subset simulation: hold every state the pattern could be in at
 * once, so no choice is ever guessed and none ever has to be taken back. The
 * `star` family are the only states that can stay put, and that self-loop is
 * precisely what a backtracking engine would instead explore one split at a
 * time -- the difference between a linear walk and an exponential search.
 *
 * `seen` marks which states are already in the set being built. It is stamped
 * rather than cleared: the stamp advances with each character, so every mark
 * from the previous character is stale by construction and a step costs only
 * the states it actually touches. One array serves both the set being read and
 * the one being written, because a state is only ever added to the new one.
 */
const simulate = (tokens: ReadonlyArray<Token>, path: string): boolean => {
  const accept = tokens.length
  const seen = new Int32Array(accept + 1)
  // Marks start at 0, so the first live stamp must not be 0.
  let stamp = 1
  let live: Array<number> = []

  /**
   * Add `state`, and everything reachable from it without consuming input.
   *
   * Recursion depth is bounded by the number of tokens, which
   * `MAX_PATTERN_LENGTH` bounds in turn, and `seen` stops it revisiting a
   * state -- so a group of empty alternatives cannot send it round in circles.
   */
  const enter = (state: number, into: Array<number>): void => {
    if (seen[state] === stamp) return
    seen[state] = stamp
    into.push(state)
    if (state >= accept) return
    const token = tokens[state]!
    switch (token.kind) {
      // Zero occurrences is always one of the possibilities.
      case "star":
      case "globstar":
      case "anyRun":
        enter(state + 1, into)
        return
      // Either run the group or step over it -- decided here, once, because
      // nothing transitions back to this state.
      case "optionalRun":
        enter(state + 1, into)
        enter(token.skip, into)
        return
      case "open":
        for (const start of token.starts) enter(start, into)
        return
      // Reaching a `,` means an alternative completed: skip its siblings.
      case "alternative":
        enter(token.after, into)
        return
      case "close":
        enter(state + 1, into)
        return
      default:
        return
    }
  }

  enter(0, live)

  for (let i = 0; i < path.length; i++) {
    const char = path[i]
    stamp++
    const next: Array<number> = []
    for (const state of live) {
      if (state >= accept) continue
      const token = tokens[state]!
      switch (token.kind) {
        case "literal":
          if (char === token.char) enter(state + 1, next)
          break
        case "single":
          if (char !== "/") enter(state + 1, next)
          break
        case "star":
          if (char !== "/") enter(state, next)
          break
        case "globstar":
        case "anyRun":
          enter(state, next)
          break
        case "slash":
          // The only exit from `anyRun`, which is what makes the trailing
          // separator mandatory once the group has been entered at all.
          if (char === "/") enter(state + 1, next)
          break
        default:
          break
      }
    }
    // Nothing left to be: no continuation of the path can revive it.
    if (next.length === 0) return false
    live = next
  }

  for (const state of live) if (state === accept) return true
  return false
}

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
 * `matches` recompiled on every call, so `search` built a fresh matcher for
 * every file it considered -- multiplying the ordinary cost by the number of
 * files walked. A search filters thousands of paths with one filter; it should
 * build it once.
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
  const tokens = tokenize(pattern)
  if (tokens === undefined) {
    return {
      _tag: "Refused",
      reason: `the include pattern nests braces more than ${MAX_BRACE_DEPTH} deep`
    }
  }
  const wholePath = pattern.includes("/")
  return {
    _tag: "Matcher",
    matches: (path) => simulate(tokens, wholePath ? path : basename(path))
  }
}
