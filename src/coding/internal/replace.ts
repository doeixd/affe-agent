/**
 * Multi-strategy literal replacement: the engine behind `edit_file`.
 *
 * ---------------------------------------------------------------------------
 * Vendored from opencode, `packages/opencode/src/tool/edit.ts`, verified
 * line-by-line against commit 2a6be0a03b93a6734070e10a6c3b56863475f214.
 * Upstream: https://github.com/sst/opencode -- MIT License, Copyright (c) sst.
 * Upstream credits the strategies to Cline's diff-apply evals and Gemini CLI's
 * `editCorrector.ts`.
 *
 * Faithful to upstream: all nine strategies, their order, the 0.65 anchor
 * similarity threshold, the 0.5 context-aware middle-line threshold, the
 * 25% block-size tolerance, the driver's fall-through-on-ambiguity rule and
 * both proportionality-guard formulas.
 *
 * Shape changes for this repository: the driver returns a discriminated
 * result instead of throwing, every strategy names itself so tests can assert
 * *which* one matched, and the module is pure (no I/O, no host imports) so it
 * stays portable.
 *
 * Deliberate behavioural divergences, each fixing a bug reproduced by running
 * upstream's own code at the pinned commit:
 *
 * 1. **Dollar patterns are literal.** Upstream's replace-all path calls
 *    `String.replaceAll(search, newString)`, which interprets `$&`, `$'` and
 *    `$1` in the replacement: replacing `A` with `$'` in `"A A"` yields
 *    `" A "`. Splicing by index and joining keeps the text literal.
 * 2. **A find ending in a newline replaces whole lines.** Upstream's yielded
 *    span never includes the terminating newline, so replacing
 *    `"  return 1;" + newline` with `"  return 2;" + newline` leaves a blank
 *    line behind. `blockOf` includes the newline exactly when the find had
 *    one, and the trailing blank `split` produces is dropped before sizing a
 *    block, so the block compared is the one the model meant.
 * ---------------------------------------------------------------------------
 *
 * The design in one sentence: **a strategy may only ever point at a span of
 * text that already exists in the file, and the driver splices that exact span
 * out.** Fuzzy matching selects; it never synthesizes. That is what makes nine
 * increasingly forgiving strategies safe to chain -- the worst a bad strategy
 * can do is select the wrong region, which the uniqueness and proportionality
 * checks then refuse.
 *
 * Strategies run in order from exact to most forgiving. A strategy whose
 * candidate matches more than once *falls through to the next strategy* rather
 * than guessing: ambiguity under a loose strategy is often uniqueness under a
 * stricter one. Only when every strategy is exhausted does the driver report
 * which of the three failures happened.
 */

/**
 * How similar a block's middle lines must be for the anchored strategies to
 * accept it. Upstream uses 0.65 for both its single- and multiple-candidate
 * paths.
 */
const ANCHOR_SIMILARITY_THRESHOLD = 0.65

/** How many of a context-aware block's middle lines must match exactly. */
const CONTEXT_MIDDLE_THRESHOLD = 0.5

/** Which strategy produced a match. Reported so callers (and tests) can tell. */
export type StrategyName =
  | "simple"
  | "line-trimmed"
  | "block-anchor"
  | "whitespace-normalized"
  | "indentation-flexible"
  | "escape-normalized"
  | "trimmed-boundary"
  | "context-aware"
  | "multi-occurrence"

/**
 * The outcome of a replacement attempt.
 *
 * The three failures are distinct because the model's next move differs for
 * each: supply the real text, supply more context, or re-read the file. The
 * handler turns each into prose; the engine stays quiet about wording.
 */
export type Replacement =
  | {
    readonly _tag: "Replaced"
    /** The whole file's new content. */
    readonly content: string
    /** Which strategy selected the span. */
    readonly strategy: StrategyName
    /** How many occurrences were replaced (always 1 unless `replaceAll`). */
    readonly count: number
    /** The exact span that was replaced, as it appeared in the file. */
    readonly matched: string
  }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Ambiguous" }
  | {
    readonly _tag: "Disproportionate"
    /** The span a strategy selected, which was far larger than asked for. */
    readonly matched: string
    readonly strategy: StrategyName
  }

/**
 * A strategy: given the file and the text to find, yield candidate spans that
 * *should already occur verbatim in the file*. The driver verifies that with
 * `indexOf`, so a strategy that yields something invented is merely useless,
 * never dangerous.
 */
export type Replacer = (content: string, find: string) => Generator<string>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drop the trailing empty line `split("\n")` leaves on text ending in a newline. */
const withoutTrailingBlank = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines

/** The char offset at which `index`-th line starts, given the file's lines. */
const offsetOfLine = (lines: ReadonlyArray<string>, index: number): number => {
  let offset = 0
  for (let i = 0; i < index; i++) offset += (lines[i] ?? "").length + 1
  return offset
}

/**
 * The exact slice of `content` spanning lines `[start, end)`, including the
 * newline that terminates the last line when the file has one.
 */
const sliceLines = (
  content: string,
  lines: ReadonlyArray<string>,
  start: number,
  end: number
): string => {
  const from = offsetOfLine(lines, start)
  const to = offsetOfLine(lines, end)
  // `offsetOfLine` counts a newline after every line, including a final line
  // that has none; clamping to the content length restores the truth.
  return content.slice(from, Math.min(to, content.length))
}

/**
 * The comparable form of a block: the bare lines, never a terminating newline.
 *
 * Comparison must not see the newline that ends the last line, because the
 * text a model supplies usually has none -- but the *yielded* span often must
 * include it. Hence two forms of the same block.
 */
const coreOf = (lines: ReadonlyArray<string>, start: number, count: number): string =>
  lines.slice(start, start + count).join("\n")

/**
 * The form of the block to hand the driver.
 *
 * A find ending in a newline means whole lines are being replaced, so the span
 * must carry the terminating newline: without it, a replacement that also ends
 * in one would insert a blank line. A find without it gets the bare lines.
 * Both forms occur verbatim in `content`, which is what the driver requires.
 */
const blockOf = (
  content: string,
  lines: ReadonlyArray<string>,
  start: number,
  count: number,
  withNewline: boolean
): string =>
  withNewline ? sliceLines(content, lines, start, start + count) : coreOf(lines, start, count)

/** Levenshtein distance, two-row DP. Used only to score block middles. */
const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  let current = new Array<number>(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    current[0] = i
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      const deletion = (previous[j] ?? 0) + 1
      const insertion = (current[j - 1] ?? 0) + 1
      current[j] = Math.min(substitution, deletion, insertion)
    }
    const swap = previous
    previous = current
    current = swap
  }
  return previous[b.length] ?? 0
}

/**
 * The slice of `line` the find's words match when any run of whitespace is
 * allowed between them, or `undefined` if they do not match.
 *
 * Every word is escaped, so a construction failure would be a bug rather than
 * bad input -- but upstream guards it, and a thrown regex must not take the
 * whole edit down.
 */
const matchLoosely = (words: ReadonlyArray<string>, line: string): string | undefined => {
  try {
    const found = new RegExp(words.map(escapeRegex).join("\\s+")).exec(line)
    return found === null ? undefined : found[0]
  } catch {
    return undefined
  }
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const normalizeWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim()

/** The common leading indentation removed from every non-blank line. */
const dedent = (text: string): string => {
  const lines = text.split("\n")
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.length - line.trimStart().length)
  if (indents.length === 0) return text
  const common = Math.min(...indents)
  return lines.map((line) => (line.trim().length === 0 ? line : line.slice(common))).join("\n")
}

/**
 * Undo the escaping a model applies when it quotes code into a JSON string and
 * then escapes it a second time -- `\\n` where the file has a real newline.
 */
const unescape = (text: string): string =>
  text.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (_match, char: string) => {
    switch (char) {
      case "n":
        return "\n"
      case "t":
        return "\t"
      case "r":
        return "\r"
      default:
        return char
    }
  })

// ---------------------------------------------------------------------------
// The strategies, exact first
// ---------------------------------------------------------------------------

/** 1. The text, as given. */
const SimpleReplacer: Replacer = function*(_content, find) {
  yield find
}

/**
 * 2. Every line matches once trimmed -- indentation or trailing-whitespace
 * drift between what the model quoted and what the file holds.
 */
const LineTrimmedReplacer: Replacer = function*(content, find) {
  const lines = content.split("\n")
  const search = withoutTrailingBlank(find.split("\n"))
  const whole = find.endsWith("\n")
  if (search.length === 0) return
  for (let i = 0; i + search.length <= lines.length; i++) {
    let matches = true
    for (let j = 0; j < search.length; j++) {
      if ((lines[i + j] ?? "").trim() !== (search[j] ?? "").trim()) {
        matches = false
        break
      }
    }
    if (matches) yield blockOf(content, lines, i, search.length, whole)
  }
}

/**
 * 3. First and last lines anchor the block; the middle may have been rewritten.
 *
 * For blocks of three lines or more. A candidate must start on the first
 * anchor, end on the *first* following occurrence of the last anchor, and be
 * within a quarter of the expected size. Middles are scored by average
 * per-line similarity and accepted at 0.65 -- forgiving enough for a
 * reformatted body, strict enough that an unrelated block scores far below.
 */
const BlockAnchorReplacer: Replacer = function*(content, find) {
  const lines = content.split("\n")
  const search = withoutTrailingBlank(find.split("\n"))
  if (search.length < 3) return
  const whole = find.endsWith("\n")
  const firstAnchor = (search[0] ?? "").trim()
  const lastAnchor = (search[search.length - 1] ?? "").trim()
  const tolerance = Math.max(1, Math.floor(search.length * 0.25))

  const candidates: Array<{ readonly start: number; readonly end: number }> = []
  for (let start = 0; start < lines.length; start++) {
    if ((lines[start] ?? "").trim() !== firstAnchor) continue
    for (let end = start + 2; end < lines.length; end++) {
      if ((lines[end] ?? "").trim() !== lastAnchor) continue
      // The first close wins: a later one would swallow an inner block.
      if (Math.abs(end - start + 1 - search.length) <= tolerance) candidates.push({ start, end })
      break
    }
  }
  if (candidates.length === 0) return

  /**
   * Every block that scores best, not the first one that did.
   *
   * `score > bestScore` silently discarded ties, so two blocks resembling the
   * search text equally well were reduced to whichever the scan reached
   * first -- an edit landing on one of two indistinguishable places, chosen
   * by position in the file. Ties are yielded together and the driver refuses
   * them as ambiguous, which is what an editor that will not guess should do.
   */
  let best: Array<{ readonly start: number; readonly end: number }> = []
  let bestScore = -1
  for (const candidate of candidates) {
    const size = candidate.end - candidate.start + 1
    const comparable = Math.min(search.length, size) - 2
    let score = 1
    if (comparable > 0) {
      let total = 0
      for (let k = 1; k < search.length - 1 && k < size - 1; k++) {
        const found = (lines[candidate.start + k] ?? "").trim()
        const wanted = (search[k] ?? "").trim()
        const longest = Math.max(found.length, wanted.length)
        // A pair of blank lines earns nothing rather than a free point, and
        // still counts against the divisor -- upstream's behaviour, which
        // makes blank middles evidence against a block rather than for it.
        if (longest === 0) continue
        total += 1 - levenshtein(found, wanted) / longest
      }
      score = total / comparable
    }
    if (score > bestScore) {
      bestScore = score
      best = [candidate]
    } else if (score === bestScore) {
      best.push(candidate)
    }
  }

  // Only best-scoring blocks are ever offered. Falling back to a worse-scoring
  // candidate would let an edit land on a different block that merely happens to
  // share both anchors.
  if (bestScore >= ANCHOR_SIMILARITY_THRESHOLD) {
    for (const candidate of best) {
      yield blockOf(content, lines, candidate.start, candidate.end - candidate.start + 1, whole)
    }
  }
}

/**
 * 4. Whitespace is noise: runs of it collapse to one space before comparing.
 * Matches a whole line, a substring within a line, or a multi-line block.
 */
const WhitespaceNormalizedReplacer: Replacer = function*(content, find) {
  const target = normalizeWhitespace(find)
  if (target.length === 0) return
  const lines = content.split("\n")

  for (const line of lines) {
    if (normalizeWhitespace(line) === target) {
      yield line
      continue
    }
    // A normalized substring: rebuild the find as a whitespace-tolerant regex
    // and yield whatever the file actually holds there.
    if (normalizeWhitespace(line).includes(target)) {
      const words = target.split(" ").filter((word) => word.length > 0)
      if (words.length === 0) continue
      const found = matchLoosely(words, line)
      if (found !== undefined) yield found
    }
  }

  const searchLines = withoutTrailingBlank(find.split("\n"))
  if (searchLines.length > 1) {
    const whole = find.endsWith("\n")
    for (let i = 0; i + searchLines.length <= lines.length; i++) {
      if (normalizeWhitespace(coreOf(lines, i, searchLines.length)) === target) {
        yield blockOf(content, lines, i, searchLines.length, whole)
      }
    }
  }
}

/**
 * 5. The block is right but re-indented wholesale -- a body moved in or out of
 * a nesting level. Compare with the common indentation stripped from both.
 */
const IndentationFlexibleReplacer: Replacer = function*(content, find) {
  const target = dedent(find)
  const lines = content.split("\n")
  const searchLines = withoutTrailingBlank(find.split("\n"))
  const whole = find.endsWith("\n")
  if (searchLines.length === 0) return
  for (let i = 0; i + searchLines.length <= lines.length; i++) {
    const core = coreOf(lines, i, searchLines.length)
    if (dedent(core) === target || dedent(core) === dedent(target)) {
      yield blockOf(content, lines, i, searchLines.length, whole)
    }
  }
}

/**
 * 6. The model escaped its escapes: `\n` arrived as the two characters
 * backslash-n. Unescape the find and try again.
 */
const EscapeNormalizedReplacer: Replacer = function*(content, find) {
  const unescaped = unescape(find)
  if (unescaped === find) return
  yield unescaped
  const lines = content.split("\n")
  const searchLines = withoutTrailingBlank(unescaped.split("\n"))
  const whole = unescaped.endsWith("\n")
  if (searchLines.length === 0) return
  for (let i = 0; i + searchLines.length <= lines.length; i++) {
    if (unescape(coreOf(lines, i, searchLines.length)) === unescaped) {
      yield blockOf(content, lines, i, searchLines.length, whole)
    }
  }
}

/** 7. Leading or trailing blank lines the model included but the file has not. */
const TrimmedBoundaryReplacer: Replacer = function*(content, find) {
  const trimmed = find.trim()
  if (trimmed === find || trimmed.length === 0) return
  yield trimmed
  const lines = content.split("\n")
  const searchLines = withoutTrailingBlank(trimmed.split("\n"))
  if (searchLines.length === 0) return
  for (let i = 0; i + searchLines.length <= lines.length; i++) {
    const core = coreOf(lines, i, searchLines.length)
    if (core.trim() === trimmed) yield core
  }
}

/**
 * 8. Like the block anchor but strict and cheap: exactly the same line count,
 * both anchors exact once trimmed, and at least half the non-blank middle
 * lines identical. First occurrence only.
 */
const ContextAwareReplacer: Replacer = function*(content, find) {
  const lines = content.split("\n")
  const search = withoutTrailingBlank(find.split("\n"))
  if (search.length < 3) return
  const whole = find.endsWith("\n")
  const firstAnchor = (search[0] ?? "").trim()
  const lastAnchor = (search[search.length - 1] ?? "").trim()

  for (let start = 0; start < lines.length; start++) {
    if ((lines[start] ?? "").trim() !== firstAnchor) continue
    for (let end = start + 2; end < lines.length; end++) {
      if ((lines[end] ?? "").trim() !== lastAnchor) continue
      const size = end - start + 1
      if (size === search.length) {
        let comparable = 0
        let same = 0
        for (let k = 1; k < size - 1; k++) {
          const found = (lines[start + k] ?? "").trim()
          const wanted = (search[k] ?? "").trim()
          // A pair counts when either side has content, so a line the model
          // dropped still tells against the block.
          if (found.length > 0 || wanted.length > 0) {
            comparable++
            if (found === wanted) same++
          }
        }
        if (comparable === 0 || same / comparable >= CONTEXT_MIDDLE_THRESHOLD) {
          yield blockOf(content, lines, start, size, whole)
        }
      }
      // Only the first close is considered for this opening anchor.
      break
    }
  }
}

/**
 * 9. Last resort, and only useful under `replaceAll`: the exact text, offered
 * once per occurrence so the driver's replace-all path can fire on text that
 * the strict uniqueness check would otherwise have rejected as ambiguous.
 */
const MultiOccurrenceReplacer: Replacer = function*(content, find) {
  if (find.length === 0) return
  let from = 0
  for (;;) {
    const index = content.indexOf(find, from)
    if (index === -1) return
    yield find
    from = index + find.length
  }
}

const strategies: ReadonlyArray<readonly [StrategyName, Replacer]> = [
  ["simple", SimpleReplacer],
  ["line-trimmed", LineTrimmedReplacer],
  ["block-anchor", BlockAnchorReplacer],
  ["whitespace-normalized", WhitespaceNormalizedReplacer],
  ["indentation-flexible", IndentationFlexibleReplacer],
  ["escape-normalized", EscapeNormalizedReplacer],
  ["trimmed-boundary", TrimmedBoundaryReplacer],
  ["context-aware", ContextAwareReplacer],
  ["multi-occurrence", MultiOccurrenceReplacer]
]

/** The strategies in the order the driver tries them. Exported for tests. */
export const strategyOrder: ReadonlyArray<StrategyName> = strategies.map(([name]) => name)

/**
 * Each strategy on its own, so its specialty can be tested directly.
 *
 * The chain overlaps by design -- a stricter strategy often also handles what
 * a looser one was written for, and the driver deliberately lets the stricter
 * one answer first. Driving a generator directly is therefore the only way to
 * prove a given strategy does its job; asserting through `replace` proves the
 * *order*, which is a separate property.
 */
export const strategyByName: Readonly<Record<StrategyName, Replacer>> = {
  "simple": SimpleReplacer,
  "line-trimmed": LineTrimmedReplacer,
  "block-anchor": BlockAnchorReplacer,
  "whitespace-normalized": WhitespaceNormalizedReplacer,
  "indentation-flexible": IndentationFlexibleReplacer,
  "escape-normalized": EscapeNormalizedReplacer,
  "trimmed-boundary": TrimmedBoundaryReplacer,
  "context-aware": ContextAwareReplacer,
  "multi-occurrence": MultiOccurrenceReplacer
}

/** The candidates a strategy offers for `find`, in order. */
export const candidatesOf = (
  strategy: StrategyName,
  content: string,
  find: string
): ReadonlyArray<string> => Array.from(strategyByName[strategy](content, find))

// ---------------------------------------------------------------------------
// The proportionality guard
// ---------------------------------------------------------------------------

/**
 * Whether a selected span is so much bigger than what was asked for that no
 * model could have meant it.
 *
 * This is the guard naive fuzzy editors lack, and the reason the chain can
 * afford to be forgiving: a loose strategy that latches onto the wrong anchor
 * would otherwise replace half a file with two lines. Both limits are
 * generous in absolute terms and strict in ratio, so ordinary edits never
 * trip them.
 */
export const isDisproportionate = (matched: string, find: string): boolean => {
  const findLines = find.split("\n").length
  const matchedLines = matched.split("\n").length
  if (matchedLines >= Math.max(findLines + 3, findLines * 2)) return true
  // A single-line find legitimately matches a single long line.
  if (findLines === 1) return false
  const findLength = find.trim().length
  return matched.trim().length > Math.max(findLength + 500, findLength * 4)
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/**
 * Replace `find` with `replacement` in `content`, trying each strategy until
 * one selects a span uniquely.
 *
 * The splice is always by index into the real content, never `String.replace`:
 * a `$&` or `$1` in the replacement is literal text, not a substitution
 * pattern.
 */
export const replace = (
  content: string,
  find: string,
  replacement: string,
  replaceAll = false
): Replacement => {
  if (find.length === 0) return { _tag: "NotFound" }
  let found = false

  for (const [strategy, replacer] of strategies) {
    /**
     * Everywhere this strategy says the text is, before deciding anything.
     *
     * Candidates used to be judged one at a time: each was accepted if *that
     * exact string* occurred once in the file. Two candidates that differ only
     * in whitespace -- `foo  bar` and `foo\tbar`, both matching a requested
     * `foo bar` -- are each unique as literals, so the first was edited and the
     * second never considered. The question is not whether a literal is
     * unique; it is whether the *place* is, and that cannot be answered one
     * candidate at a time.
     *
     * Keyed by position and length, so the same span reached by two candidates
     * counts once and two spans that happen to share text count twice.
     */
    const locations = new Map<string, { readonly index: number; readonly text: string }>()
    let disproportionate: string | undefined

    for (const candidate of replacer(content, find)) {
      if (candidate.length === 0) continue
      // Every occurrence, not just the first: a candidate appearing twice is
      // two places, which is exactly the ambiguity being looked for.
      let index = content.indexOf(candidate)
      // A strategy may only point at text that is really there.
      if (index === -1) continue
      found = true
      if (disproportionate === undefined && isDisproportionate(candidate, find)) {
        disproportionate = candidate
      }
      while (index !== -1) {
        locations.set(`${index}:${candidate.length}`, { index, text: candidate })
        index = content.indexOf(candidate, index + 1)
      }
    }

    if (disproportionate !== undefined) {
      return { _tag: "Disproportionate", matched: disproportionate, strategy }
    }
    if (locations.size === 0) continue

    if (replaceAll) {
      const texts = new Set([...locations.values()].map((location) => location.text))
      // "Replace all" of *which* text? Two spellings is not a question this
      // can answer by picking one, so it is refused like any other ambiguity.
      if (texts.size === 1) {
        const candidate = [...texts][0]!
        const parts = content.split(candidate)
        return {
          _tag: "Replaced",
          content: parts.join(replacement),
          strategy,
          count: parts.length - 1,
          matched: candidate
        }
      }
      // A stricter strategy may still pin it down, so fall through.
      continue
    }

    // More than one place: fall through rather than choosing between them. A
    // later, stricter strategy may resolve it; if none does, `found` makes the
    // answer `Ambiguous` rather than `NotFound`.
    if (locations.size > 1) continue

    const only = [...locations.values()][0]!
    return {
      _tag: "Replaced",
      content: content.slice(0, only.index) + replacement +
        content.slice(only.index + only.text.length),
      strategy,
      count: 1,
      matched: only.text
    }
  }

  return found ? { _tag: "Ambiguous" } : { _tag: "NotFound" }
}
