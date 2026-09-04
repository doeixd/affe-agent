/**
 * Bounding command output so a single noisy command cannot flood a context.
 *
 * ---------------------------------------------------------------------------
 * Ported from opencode, `packages/opencode/src/tool/shell.ts` (the `tail`
 * function and the output assembly around it) and `truncate.ts`, verified
 * against commit 2a6be0a03b93a6734070e10a6c3b56863475f214.
 * Upstream: https://github.com/sst/opencode -- MIT License, Copyright (c) sst.
 *
 * Faithful to upstream: the 2000-line and 50 KB defaults, keeping the *tail*
 * rather than the head (the end of a build log is the part that matters), the
 * byte accounting including the joining newline, the character-boundary repair
 * when a single line is itself over budget, and the truncation and timeout
 * wording word for word.
 *
 * Shape change: byte lengths come from `TextEncoder` rather than Node's
 * `Buffer`, because this package must run on any Effect-supported runtime.
 * ---------------------------------------------------------------------------
 */

/** Lines kept from the end of a command's output. */
export const MAX_LINES = 2000

/** Bytes kept from the end of a command's output. */
export const MAX_BYTES = 50 * 1024

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const byteLength = (text: string): number => encoder.encode(text).length

/**
 * A size the model can read: `50.0KB`, not `51200`.
 *
 * From Pi (`formatSize`), so a truncation banner can name the limit that
 * fired rather than only that one did.
 */
export const formatSize = (bytes: number): string => {
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${bytes}B`
}

/**
 * Which budget actually ran out, for the truncation banner.
 *
 * Bytes first: a few huge lines fail the byte cap before the line cap, and
 * naming the line cap would be a lie. Called only when `tail`/`head` cut.
 */
export const firedLimit = (
  text: string,
  maxLines: number = MAX_LINES,
  maxBytes: number = MAX_BYTES
): string => {
  if (byteLength(text) > maxBytes) return formatSize(maxBytes)
  return `${maxLines} lines`
}

/**
 * How many lines `text` holds, not counting a trailing newline as one more.
 *
 * `"a\nb\n".split("\n")` is `["a", "b", ""]`, and treating that empty trailing
 * segment as a third line makes a complete two-line output look truncated --
 * which nearly all command output is, since nearly all of it ends in a
 * newline. The banner then reports a cut that did not happen.
 */
const lineCount = (lines: ReadonlyArray<string>): number =>
  lines.length > 1 && lines[lines.length - 1] === ""
    ? lines.length - 1
    : lines.length

/** Which budget stopped the walk. `undefined` when nothing did. */
export type Fired = "lines" | "bytes" | undefined

/** Name a budget for the banner, from what actually fired. */
export const nameLimit = (
  fired: Exclude<Fired, undefined>,
  maxLines: number = MAX_LINES,
  maxBytes: number = MAX_BYTES
): string => (fired === "bytes" ? formatSize(maxBytes) : `${maxLines} lines`)

export interface Tail {
  /** The kept text: the whole of it when nothing was over budget. */
  readonly text: string
  /** Whether anything was dropped. */
  readonly cut: boolean
  /**
   * Which budget stopped the walk, so the banner can name the right one.
   *
   * Reported by the walk rather than re-derived from the input, because the
   * two disagree: 200 lines totalling 100KB against a 100-line, 50KB budget
   * exceeds both, but if the first 100 lines are 10KB it is the *line* cap
   * that fired. Inspecting the input afterwards would name the byte cap.
   */
  readonly fired?: Fired
}

/**
 * The last `maxLines` lines of `text`, within `maxBytes`.
 *
 * The tail rather than the head, because the end of a command's output is
 * where the failure is. When even one line exceeds the byte budget, the end of
 * that line is kept and the start is dropped -- and the cut is then moved
 * forward off any UTF-8 continuation byte, so the result is always valid text
 * rather than a half-decoded character.
 */
export const tail = (
  text: string,
  maxLines: number = MAX_LINES,
  maxBytes: number = MAX_BYTES
): Tail => {
  const lines = text.split("\n")
  if (lineCount(lines) <= maxLines && byteLength(text) <= maxBytes) {
    return { text, cut: false }
  }

  const out: Array<string> = []
  let bytes = 0
  let fired: Fired = "lines"
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const line = lines[i] ?? ""
    const size = byteLength(line) + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      fired = "bytes"
      if (out.length === 0) {
        // One line is bigger than the whole budget: keep its end. `0b10xxxxxx`
        // marks a continuation byte, so walking forward past those lands on the
        // first byte of a character.
        const encoded = encoder.encode(line)
        let start = Math.max(0, encoded.length - maxBytes)
        while (start < encoded.length && ((encoded[start] ?? 0) & 0xc0) === 0x80) start++
        out.unshift(decoder.decode(encoded.subarray(start)))
      }
      break
    }
    out.unshift(line)
    bytes += size
  }

  return { text: out.join("\n"), cut: true, fired }
}

export interface Head {
  readonly text: string
  readonly cut: boolean
  /** Which budget stopped the walk. See `Tail.fired`. */
  readonly fired?: Fired
}

/**
 * The first `maxLines` lines of `text`, within `maxBytes`.
 *
 * The counterpart of `tail`. A log whose failure is at the *start* -- a
 * compiler that prints the error and then a wall of notes -- needs the head.
 * Same byte accounting and UTF-8 repair as `tail`, from the other end.
 *
 * From Pi (`truncateHead`), commit dcd461925db2edf69a43c8135db1180d418afd54.
 */
export const head = (
  text: string,
  maxLines: number = MAX_LINES,
  maxBytes: number = MAX_BYTES
): Head => {
  const lines = text.split("\n")
  if (lineCount(lines) <= maxLines && byteLength(text) <= maxBytes) {
    return { text, cut: false }
  }

  const out: Array<string> = []
  let bytes = 0
  let fired: Fired = "lines"
  for (let i = 0; i < lines.length && out.length < maxLines; i++) {
    const line = lines[i] ?? ""
    const size = byteLength(line) + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      fired = "bytes"
      if (out.length === 0) {
        const encoded = encoder.encode(line)
        let end = maxBytes
        while (end > 0 && end < encoded.length && ((encoded[end] ?? 0) & 0xc0) === 0x80) end--
        out.push(decoder.decode(encoded.subarray(0, end)))
      }
      break
    }
    out.push(line)
    bytes += size
  }
  return { text: out.join("\n"), cut: true, fired }
}

/** Where a truncated command's full output is kept, relative to the workspace. */
export const OUTPUT_DIR = ".affe-agent/tool-output"

/**
 * A name for the next saved output.
 *
 * Ascending within a process, so the order files were produced in is legible.
 * Names restart when the process does, which means a later run can overwrite
 * an earlier run's file: these exist to be read back during the session that
 * produced them, and the directory is the application's to keep or delete.
 */
let counter = 0
export const nextOutputPath = (): string => {
  counter += 1
  return `${OUTPUT_DIR}/tool_${String(counter).padStart(4, "0")}`
}

/** The banner naming where the full output went, and which budget fired. */
export const savedNotice = (path: string, limit: string): string =>
  `...output truncated (tail, ${limit} limit)...\n\nFull output saved to: ${path}\n\n`

/**
 * The banner used when the output was cut but could not be saved -- a
 * read-only workspace, say. Saying so is better than naming a file that is not
 * there.
 */
export const unsavedNotice = (limit: string): string =>
  `...output truncated (tail, ${limit} limit)...\n\n`

/** Same shape as `unsavedNotice`, for a head cut. */
export const headNotice = (limit: string): string =>
  `...output truncated (head, ${limit} limit)...\n\n`

/**
 * What a command that outran its time budget is told.
 *
 * Actionable on purpose: the model's next move is a larger timeout, unless the
 * command was waiting for input it will never get.
 */
export const timedOut = (millis: number): string =>
  `shell tool terminated command after exceeding timeout ${millis} ms. ` +
  `If this command is expected to take longer and is not waiting for interactive input, ` +
  `retry with a larger timeout value in milliseconds.`
