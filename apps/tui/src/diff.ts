/**
 * A unified diff, from the two sides of an edit.
 *
 * The plan recorded this renderer as blocked: opencode's `snapEdit` reads
 * `p.metadata.diff` because *their* edit tool returns a diff, and ours returns
 * prose, so porting it looked like a library decision. It is not. `edit_file`
 * reports `matched` -- the span it actually replaced -- and the call carries
 * `new_string`, which is both sides. What was missing was the diff itself, and
 * that is thirty lines.
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

/**
 * Longest common subsequence over lines.
 *
 * Quadratic, and that is fine here: this runs over the span an edit touched,
 * not over a file. `edit_file` replaces a matched region, so both sides are
 * the size of the thing that changed -- and a renderer clips at a few lines
 * anyway. A linear-space variant would be more code defending against an input
 * this cannot receive.
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
 * Split into lines without the phantom trailing entry.
 *
 * `"a\nb\n".split("\n")` is `["a", "b", ""]`, and that empty string becomes a
 * spurious removed-or-added line at the end of every whole-line edit. The same
 * trap the library's `readFormat.toLines` exists for.
 */
const toLines = (text: string): ReadonlyArray<string> => {
  const lines = text.split("\n")
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

export const of = (before: string, after: string): ReadonlyArray<Line> =>
  lcs(toLines(before), toLines(after))

/**
 * The same, as the unified-diff text OpenTUI's `<diff>` parses.
 *
 * One hunk covering everything, because the input *is* one hunk: an edit
 * replaced a contiguous span, so there is nothing between hunks to elide. The
 * counts are the real line counts -- a parser that trusts the header and finds
 * a different number of lines renders nonsense.
 */
export const unified = (
  path: string,
  before: string,
  after: string
): string => {
  const lines = of(before, after)
  const removed = lines.filter((line) => line.kind !== "added").length
  const added = lines.filter((line) => line.kind !== "removed").length
  const body = lines.map((line) =>
    `${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}${line.text}`
  )
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed} +1,${added} @@`,
    ...body
  ].join("\n")
}

/** How many lines the edit added and removed. */
export const counts = (
  lines: ReadonlyArray<Line>
): { readonly added: number; readonly removed: number } => ({
  added: lines.filter((line) => line.kind === "added").length,
  removed: lines.filter((line) => line.kind === "removed").length
})
