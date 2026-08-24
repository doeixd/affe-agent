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

export interface Tail {
  /** The kept text: the whole of it when nothing was over budget. */
  readonly text: string
  /** Whether anything was dropped. */
  readonly cut: boolean
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
  if (lines.length <= maxLines && byteLength(text) <= maxBytes) {
    return { text, cut: false }
  }

  const out: Array<string> = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const line = lines[i] ?? ""
    const size = byteLength(line) + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
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

  return { text: out.join("\n"), cut: true }
}

/** Where a truncated command's full output is kept, relative to the workspace. */
export const OUTPUT_DIR = ".effect-agent/tool-output"

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

/** The banner naming where the full output went. */
export const savedNotice = (path: string): string =>
  `...output truncated...\n\nFull output saved to: ${path}\n\n`

/**
 * The banner used when the output was cut but could not be saved -- a
 * read-only workspace, say. Saying so is better than naming a file that is not
 * there.
 */
export const unsavedNotice = (): string =>
  `...output truncated...\n\n`

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
