/**
 * How a file is presented to a model: numbering, caps, and the footer that
 * tells it how to continue.
 *
 * ---------------------------------------------------------------------------
 * Ported from opencode, `packages/opencode/src/tool/read.ts`, verified against
 * commit 2a6be0a03b93a6734070e10a6c3b56863475f214.
 * Upstream: https://github.com/sst/opencode -- MIT License, Copyright (c) sst.
 *
 * Faithful to upstream: every constant (2000 lines, 2000 chars per line, 50 KB,
 * a 4 KB binary sample, the 30% non-printable ratio), the `N: ` line prefix,
 * the byte accounting including the joining newline, the rule that a line-capped
 * read keeps counting to report a true total while a byte-capped read stops and
 * therefore reports none, and the three footers word for word.
 *
 * Shape changes: the module is pure and takes the whole text, because our
 * sandbox hands back bytes rather than a stream; paths are workspace-relative,
 * so the `<path>` tag holds a relative path; and image and PDF attachments are
 * not carried, because a tool in this toolkit returns a string (such a file is
 * reported as binary instead).
 * ---------------------------------------------------------------------------
 */

/** Lines returned when the caller names no limit. */
export const DEFAULT_LIMIT = 2000

/** A single line longer than this is cut, with `MAX_LINE_SUFFIX` appended. */
export const MAX_LINE_LENGTH = 2000

export const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`

/** The whole read is bounded by bytes as well as by lines. */
export const MAX_BYTES = 50 * 1024

export const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`

/** How much of a file is sniffed to decide whether it is binary. */
export const SAMPLE_BYTES = 4096

/** Above this share of non-printable bytes, a file is treated as binary. */
export const NON_PRINTABLE_RATIO = 0.3

/**
 * Extensions that are binary whatever their bytes happen to look like. A short
 * archive can sniff as text; its extension is the better evidence.
 */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  "zip", "tar", "gz", "exe", "dll", "so", "class", "jar", "war", "7z",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  "bin", "dat", "obj", "o", "a", "lib", "wasm", "pyc", "pyo"
])

const extensionOf = (path: string): string => {
  const base = path.slice(path.lastIndexOf("/") + 1)
  const dot = base.lastIndexOf(".")
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase()
}

/** The last segment of a sandbox path. */
export const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

/** The parent of a sandbox path, or `undefined` when it sits at the root. */
export const dirname = (path: string): string | undefined => {
  const cut = path.lastIndexOf("/")
  return cut === -1 ? undefined : path.slice(0, cut)
}

/**
 * Whether a file should be refused as binary.
 *
 * A NUL byte settles it outright; otherwise more than 30% non-printable bytes
 * in the sample does. Bytes 9-13 (tab, newlines, form feed, carriage return)
 * are printable for this purpose.
 */
export const isBinary = (path: string, sample: Uint8Array): boolean => {
  if (BINARY_EXTENSIONS.has(extensionOf(path))) return true
  if (sample.length === 0) return false
  let nonPrintable = 0
  for (const byte of sample) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable++
  }
  return nonPrintable / sample.length > NON_PRINTABLE_RATIO
}

/**
 * A text's lines, the way a line-oriented reader sees them.
 *
 * `split("\n")` reports a phantom empty line for any text ending in a newline,
 * which is most files: "a\nb\n" is two lines, not three. Upstream reads through
 * a line stream and never sees that line, so counting with `split` would report
 * one line too many and render an empty numbered row at the end of nearly every
 * file.
 */
export const toLines = (text: string): ReadonlyArray<string> => {
  const lines = text.split("\n")
  return lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines
}

/** The window of a file a read returned, and why it stopped. */
export interface Slice {
  /** The lines themselves, each already capped at `MAX_LINE_LENGTH`. */
  readonly lines: ReadonlyArray<string>
  /** The 1-based line number of `lines[0]`. */
  readonly offset: number
  /**
   * Lines counted. A true total for a whole or line-capped read; for a
   * byte-capped read, only how far the read got -- which is why the byte-capped
   * footer quotes no total.
   */
  readonly counted: number
  /** The byte cap stopped the read. */
  readonly cut: boolean
  /** There is more to read after this window. */
  readonly more: boolean
}

const encoder = new TextEncoder()

/**
 * The window starting at `offset` (1-based), bounded by both caps.
 *
 * The byte budget counts the newline that joins each line to the one before,
 * so the accounting matches the string the model actually receives rather than
 * the sum of the lines in isolation.
 */
export const slice = (text: string, offset: number, limit: number): Slice => {
  const start = offset - 1
  const lines: Array<string> = []
  let counted = 0
  let bytes = 0
  let cut = false
  let more = false

  for (const line of toLines(text)) {
    counted++
    if (counted <= start) continue
    if (lines.length >= limit) {
      // Keep counting rather than stopping: the footer can then quote a real
      // total, which is what tells the model whether continuing is worthwhile.
      more = true
      continue
    }
    const capped = line.length > MAX_LINE_LENGTH
      ? line.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX
      : line
    const size = encoder.encode(capped).length + (lines.length > 0 ? 1 : 0)
    if (bytes + size <= MAX_BYTES) {
      lines.push(capped)
      bytes += size
      continue
    }
    // The byte cap stops the read outright, so `counted` is no longer a total.
    cut = true
    more = true
    break
  }

  return { lines, offset, counted, cut, more }
}

/**
 * Whether an offset points past the end of the file.
 *
 * An empty file read from the top is not an error: there is simply nothing to
 * show, and saying so beats a complaint about line 1 of 0.
 */
export const offsetOutOfRange = (slice: Slice): boolean =>
  slice.counted < slice.offset && !(slice.counted === 0 && slice.offset === 1)

/**
 * The rendered read, tags and footer included.
 *
 * The footer is the whole point: every capped read ends with the exact
 * `offset` to pass next, so continuing never requires the model to work out
 * arithmetic it tends to get wrong.
 */
export const render = (path: string, slice: Slice): string => {
  const last = slice.offset + slice.lines.length - 1
  const next = last + 1
  const numbered = slice.lines.map((line, i) => `${i + slice.offset}: ${line}`).join("\n")

  const footer = slice.cut
    ? `(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${slice.offset}-${last}. Use offset=${next} to continue.)`
    : slice.more
    ? `(Showing lines ${slice.offset}-${last} of ${slice.counted}. Use offset=${next} to continue.)`
    : `(End of file - total ${slice.counted} lines)`

  return `<path>${path}</path>\n<type>file</type>\n<content>\n${numbered}\n\n${footer}\n</content>`
}

/**
 * The "did you mean" line for a missing file, given the names beside it.
 *
 * Matched in both directions -- a candidate containing the requested name, or
 * contained by it -- so both a typo and an abbreviation find their target.
 */
export const suggestions = (
  requested: string,
  siblings: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const base = basename(requested).toLowerCase()
  if (base.length === 0) return []
  return siblings
    .filter((sibling) => {
      const name = basename(sibling).toLowerCase()
      return name.includes(base) || base.includes(name)
    })
    .slice(0, 3)
}

export const notFoundMessage = (
  requested: string,
  siblings: ReadonlyArray<string>
): string => {
  const found = suggestions(requested, siblings)
  return found.length === 0
    ? `File not found: ${requested}`
    : `File not found: ${requested}\n\nDid you mean one of these?\n${found.join("\n")}`
}
