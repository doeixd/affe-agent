/**
 * A conservative refusal for model-supplied search patterns.
 *
 * ## What the problem actually is
 *
 * `search` compiles the model's `pattern` into a native `RegExp` and runs it
 * over every line of every eligible file. JavaScript's engine is backtracking,
 * so a pattern with a quantifier applied to something that is itself
 * quantified or ambiguously alternated -- `(a+)+$`, `(a|a)*$`, `(\d+|\w+)*x`
 * -- can take time exponential in the length of the line. Matching runs
 * synchronously to completion: an `Effect.timeout` cannot preempt it, an
 * interruption cannot preempt it, and neither can anything else in this
 * process. The event loop simply stops.
 *
 * ## What this is, and is not
 *
 * This is **not** a decision procedure. Deciding whether a regular expression
 * backtracks exponentially is not something a syntactic scan can do, and a
 * module claiming otherwise would be worse than none -- a caller who believes
 * it stops looking.
 *
 * What it does is refuse the shape that produces the overwhelming majority of
 * real cases: a quantified group whose body contains another quantifier or an
 * alternation. That rejects some patterns which are in fact safe, which is the
 * right way round for an input chosen by a model rather than a person -- the
 * refusal names the problem and the model can write something simpler.
 *
 * ## A pattern it does not catch, measured
 *
 * The gap is not hypothetical, and the shape is ordinary enough to write by
 * accident:
 *
 * ```
 * a*a*a*a*a*a*a*a*a*a*a*a*b
 * ```
 *
 * Twenty-five characters, accepted here, and against `"a" * 40 + "!"` it does
 * not finish -- killed at twenty seconds, and again at four minutes. There is
 * no quantified group and no alternation, so there is nothing for the scan
 * above to object to: the blowup comes from a *run* of independent quantifiers
 * over the same character, each free to give back what the next takes. Every
 * `search` this process serves afterwards is gone with it, because the event
 * loop is.
 *
 * Recorded here rather than in a plan document, because this is where someone
 * deciding whether the check is sufficient will be standing.
 *
 * **The real fix is a linear-time engine** (RE2 or equivalent) or running the
 * match somewhere killable. Both are larger changes than this file: RE2 is a
 * native dependency, which this package's portability rules exclude from the
 * core, and a worker means an async boundary through the whole search path.
 * `coding/internal/glob.ts` is the same problem solved the first way, for a
 * far smaller language -- a glob has no backreferences or lookaround to give
 * up, and a regular expression does, so the trade there was free and here it
 * is not. Until one of them lands, this narrows the door rather than closing
 * it, and says so.
 */

/**
 * How long a search pattern may be.
 *
 * A cap does not prevent catastrophic backtracking -- `(a+)+$` is nine
 * characters -- so this is not the defence. It bounds the *other* cost, which
 * is compiling and running something enormous over every line of every file.
 */
export const MAX_PATTERN_LENGTH = 1024

/** Why this pattern was refused, or `undefined` if it was not. */
export type Refusal = string | undefined

/**
 * The group bodies that are immediately quantified.
 *
 * Written as a scan rather than a regular expression, because finding the
 * matching parenthesis needs a counter -- and using a regular expression to
 * decide whether a regular expression is safe has an obvious problem.
 */
const quantifiedGroups = (pattern: string): ReadonlyArray<string> => {
  const bodies: Array<string> = []
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") {
      i++
      continue
    }
    if (pattern[i] !== "(") continue

    let depth = 1
    let end = i + 1
    while (end < pattern.length && depth > 0) {
      if (pattern[end] === "\\") {
        end += 2
        continue
      }
      if (pattern[end] === "(") depth++
      if (pattern[end] === ")") depth--
      end++
    }
    if (depth !== 0) break // Unbalanced; `new RegExp` will refuse it anyway.

    const after = pattern[end]
    const quantified = after === "*" || after === "+" ||
      (after === "{" && /^\{\d*,\}?/.test(pattern.slice(end)))
    if (quantified) bodies.push(pattern.slice(i + 1, end - 1))
    i = end - 1
  }
  return bodies
}

/** Does this fragment contain a quantifier of its own, outside a class? */
const hasQuantifier = (body: string): boolean => {
  for (let i = 0; i < body.length; i++) {
    const char = body[i]
    if (char === "\\") {
      i++
      continue
    }
    if (char === "[") {
      // A character class: quantifiers inside it are literal.
      while (i < body.length && body[i] !== "]") {
        if (body[i] === "\\") i++
        i++
      }
      continue
    }
    if (char === "*" || char === "+") return true
    if (char === "{" && /^\{\d+(,\d*)?\}/.test(body.slice(i))) return true
  }
  return false
}

/** Does this fragment alternate at its top level? */
const hasAlternation = (body: string): boolean => {
  let depth = 0
  for (let i = 0; i < body.length; i++) {
    const char = body[i]
    if (char === "\\") {
      i++
      continue
    }
    if (char === "[") {
      while (i < body.length && body[i] !== "]") {
        if (body[i] === "\\") i++
        i++
      }
      continue
    }
    if (char === "(") depth++
    else if (char === ")") depth--
    else if (char === "|" && depth === 0) return true
  }
  return false
}

/**
 * Why this pattern must not be compiled, or `undefined` if it may be.
 *
 * See the module comment for the boundaries of this claim.
 */
export const refuse = (pattern: string): Refusal => {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return `the pattern is longer than ${MAX_PATTERN_LENGTH} characters`
  }
  for (const body of quantifiedGroups(pattern)) {
    if (hasQuantifier(body)) {
      return "a repeated group contains another repetition" +
        " (like `(a+)+`), which can take exponential time to match"
    }
    if (hasAlternation(body)) {
      return "a repeated group contains an alternation" +
        " (like `(a|b)*`), which can take exponential time to match" +
        " when the alternatives can match the same text"
    }
  }
  return undefined
}
