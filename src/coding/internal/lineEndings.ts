/**
 * Line-ending reconciliation for edits.
 *
 * A model quotes code with `\n` whatever the file uses, so an edit against a
 * CRLF file would never match. The fix has two possible shapes and only one of
 * them is safe:
 *
 * - Normalise *the file* to LF, edit, convert back. This rewrites every line
 *   ending in the file, so a file with mixed endings silently loses them --
 *   the edit reports one changed span but the diff covers the whole file.
 * - Normalise *the search strings* to the file's convention and match against
 *   the file exactly as it is on disk. Only the replaced span is ever
 *   rewritten; every other byte, including a BOM and any stray ending, is
 *   untouched because it is never re-encoded.
 *
 * This module does the second. Nothing here rewrites file content.
 */

export type Newline = "\r\n" | "\n"

/**
 * The line ending a file predominantly uses.
 *
 * "Predominantly", not "the first one seen": a file that is CRLF throughout
 * apart from one stray LF is a CRLF file, and an edit quoted against it should
 * be converted to CRLF.
 */
export const detect = (text: string): Newline => {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n") continue
    if (i > 0 && text[i - 1] === "\r") crlf++
    else lf++
  }
  return crlf > lf ? "\r\n" : "\n"
}

/** Every line ending as a bare LF, whatever the input used. */
export const toLf = (text: string): string => text.replace(/\r\n/g, "\n")

/**
 * Re-express text with the given line ending.
 *
 * LF-normalises first, so text that already arrived as CRLF is not doubled
 * into `\r\r\n`.
 */
export const convert = (text: string, newline: Newline): string =>
  newline === "\n" ? toLf(text) : toLf(text).replace(/\n/g, "\r\n")

/** The byte-order mark, which some editors leave at the head of a file. */
export const BOM = "﻿"

export const hasBom = (text: string): boolean => text.startsWith(BOM)
