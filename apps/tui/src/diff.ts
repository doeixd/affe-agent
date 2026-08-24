/**
 * A unified diff, from the two sides of an edit.
 *
 * The plan recorded this renderer as blocked: opencode's `snapEdit` reads
 * `p.metadata.diff` because *their* edit tool returns a diff, and ours returns
 * prose, so porting it looked like a library decision. It is not. `edit_file`
 * reports `matched` -- the span it actually replaced -- and the call carries
 * `new_string`, which is both sides.
 *
 * Computing it here rather than in the library is also the right place for it.
 * A diff is a *presentation* of a change; the library's job is to report what
 * changed, which it already does more precisely than a diff can -- `matched`
 * says what was really replaced, which under a fuzzy strategy is not what was
 * asked for.
 */

/** One line of the result. */
export interface Line {
  readonly kind: "context" | "added" | "removed"
  readonly text: string
}

/** What came back, and whether it is the whole story. */
export interface Diff {
  readonly lines: ReadonlyArray<Line>
  /**
   * True when the edit was too large to line up, and the lines above are a
   * summary rather than a diff.
   */
  readonly summarised: boolean
  /** Set when only the file's final newline changed. */
  readonly newlineChange: "added" | "removed" | undefined
}

/**
 * The most cells the alignment may allocate.
 *
 * The first version of this file argued no budget was needed, because the
 * input is "the span an edit touched, not a file". That was wrong: nothing
 * bounds the span. A model may replace an entire file, and `matched` then
 * returns the entire file -- so a valid edit could allocate a matrix of
 * millions of cells and freeze the UI *after* the change had already been
 * written to disk. Clipping the output at twelve lines happened afterwards and
 * protected nothing.
 *
 * 250,000 is a 500x500 edit: far past anything worth reading line by line, and
 * a few megabytes at worst.
 */
export const BUDGET = 250_000

/**
 * Longest common subsequence over lines.
 *
 * Quadratic in time and space, which is why nothing reaches it without passing
 * the budget check above. A linear-space variant would raise the ceiling and
 * not remove it, and the presentation is clipped to twelve lines regardless --
 * so the useful thing to do past the ceiling is to stop, not to work harder.
 */
const lcs = (
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>
): ReadonlyArray<Line> => {
  const rows = before.length
  const cols = after.length
  // `table[i][j]` is the LCS length of `before[i..]` and `after[j..]`.
  const table: Array<Array<number>> = Array.from(
    { length: rows + 1 },
    () => new Array<number>(cols + 1).fill(0)
  )
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i]![j] = before[i] === after[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }

  const lines: Array<Line> = []
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      lines.push({ kind: "context", text: before[i]! })
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      lines.push({ kind: "removed", text: before[i]! })
      i++
    } else {
      lines.push({ kind: "added", text: after[j]! })
      j++
    }
  }
  // Removals before additions in the tail, so a replacement reads as one
  // block rather than interleaved.
  while (i < rows) lines.push({ kind: "removed", text: before[i++]! })
  while (j < cols) lines.push({ kind: "added", text: after[j++]! })
  return lines
}

/**
 * Split into lines, with empty text meaning *no* lines.
 *
 * The drop of the trailing entry is what does that: `"".split` yields one
 * entry and it is the phantom, so it goes. An explicit early return for `""`
 * was here and was dead code -- worth recording, because it looked like the
 * mechanism and was not.
 *
 * `"".split("\\n")` is `[""]`, and treating that as one line made an insertion
 * into an empty file render as "remove a blank line, add the content" -- and
 * made the unified header claim the empty side had one line.
 *
 * The trailing entry for text that ends in a newline is dropped, because
 * `"a\\nb\\n".split("\\n")` is `["a", "b", ""]` and that phantom would appear as
 * a spurious blank line on every whole-line edit. Whether the newline was
 * there is not lost -- `endsWithNewline` keeps it, because a change consisting
 * only of that newline is otherwise invisible.
 */
const toLines = (text: string): ReadonlyArray<string> => {
  const lines = text.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

const endsWithNewline = (text: string): boolean => text.endsWith("\n")

/**
 * Line up two versions of a span.
 *
 * Normalises CRLF first: a file with Windows line endings would otherwise
 * differ from itself on every line, because the `\\r` rides along on the end of
 * each one.
 */
export const of = (before: string, after: string): Diff => {
  const left = toLines(before.replaceAll("\r\n", "\n"))
  const right = toLines(after.replaceAll("\r\n", "\n"))

  /**
   * The change nobody sees.
   *
   * With the trailing entry dropped, `"a"` and `"a\\n"` are the same lines, so
   * adding or removing a file's final newline produced an all-context diff
   * that showed nothing at all -- while the file on disk had changed.
   */
  const newlineChange = before !== after &&
      endsWithNewline(before) !== endsWithNewline(after) &&
      left.join("\n") === right.join("\n")
    ? (endsWithNewline(after) ? "added" as const : "removed" as const)
    : undefined

  if (left.length * right.length > BUDGET) {
    // Past the ceiling, and the honest answer is what changed in the large
    // rather than a diff nobody could read anyway.
    return {
      lines: [
        { kind: "removed", text: `${left.length} lines` },
        { kind: "added", text: `${right.length} lines` }
      ],
      summarised: true,
      newlineChange
    }
  }

  return { lines: lcs(left, right), summarised: false, newlineChange }
}

/**
 * The same, as the unified-diff text OpenTUI's `<diff>` parses.
 *
 * One hunk covering everything, because the input *is* one hunk: an edit
 * replaced a contiguous span, so there is nothing between hunks to elide. The
 * counts are the real line counts -- a parser that trusts the header and finds
 * a different number of lines renders nonsense. A side with no lines is
 * written `-0,0`, which is the conventional way to say "this file was empty".
 */
export const unified = (
  path: string,
  before: string,
  after: string
): string => {
  const diff = of(before, after)
  const removed = diff.lines.filter((line) => line.kind !== "added").length
  const added = diff.lines.filter((line) => line.kind !== "removed").length
  const body = diff.lines.map((line) =>
    `${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}${line.text}`
  )
  // The conventional marker, so a reader is told about a change that has no
  // line of its own to sit on.
  const trailer = diff.newlineChange === undefined
    ? []
    : ["\\ No newline at end of file"]
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${removed === 0 ? 0 : 1},${removed} +${added === 0 ? 0 : 1},${added} @@`,
    ...body,
    ...trailer
  ].join("\n")
}

/** How many lines the edit added and removed. */
export const counts = (
  lines: ReadonlyArray<Line>
): { readonly added: number; readonly removed: number } => ({
  added: lines.filter((line) => line.kind === "added").length,
  removed: lines.filter((line) => line.kind === "removed").length
})
