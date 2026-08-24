/**
 * How much the footer shows, by terminal width.
 *
 * ---------------------------------------------------------------------------
 * Ported from opencode, `packages/opencode/src/cli/cmd/run/footer.width.ts`,
 * read at commit 2a6be0a03b93a6734070e10a6c3b56863475f214.
 * Upstream: https://github.com/sst/opencode -- MIT, see
 * `vendor/opencode/LICENSE.opencode`.
 *
 * Taken: the approach. One place decides what a width affords, returning named
 * booleans rather than letting each component invent its own `width > 80`.
 * That is why their footer degrades coherently instead of one part vanishing
 * while another overflows.
 *
 * Their breakpoints are 80 / 66 / 120 / 150 for compact / commandHint / model /
 * spacious. Ours are fewer because our footer shows less; the names are what
 * matters, not the numbers.
 * ---------------------------------------------------------------------------
 */

const BREAKPOINTS = {
  /** Below this, only the essentials fit. */
  compact: 60,
  /** Enough room for the keybinding hints. */
  hints: 80,
  /** Enough room for counts and timings alongside everything else. */
  spacious: 110
} as const

export interface WidthPolicy {
  readonly compact: boolean
  readonly hints: boolean
  readonly spacious: boolean
  /** Cells the backend label may occupy. See `widthPolicy`. */
  readonly backendWidth: number
}

export const widthPolicy = (width: number): WidthPolicy => ({
  compact: width < BREAKPOINTS.compact,
  hints: width >= BREAKPOINTS.hints,
  spacious: width >= BREAKPOINTS.spacious,
  /**
   * How much of the footer the backend label may take.
   *
   * A share rather than a constant, because the label sits on the same row as
   * the status and the hints -- a fixed budget that fits at 120 columns pushes
   * the row past the edge at 60. Floored at eight so it never shrinks to just
   * an ellipsis; below that the label is worth less than the space.
   */
  backendWidth: Math.max(8, Math.floor(width / 3))
})

/** `1.2s`, `340ms`, `2m 05s` -- whichever reads best at that magnitude. */
/**
 * Cut a label to fit, with an ellipsis that says it was cut.
 *
 * Middles go, not ends: a live backend's label is `model · /some/long/path`,
 * and both halves identify it. Trimming the tail would leave every workspace
 * under one parent looking identical.
 */
export const fit = (text: string, width: number): string => {
  if (width <= 1 || text.length <= width) return text
  const head = Math.ceil((width - 1) / 2)
  const tail = width - 1 - head
  return tail === 0
    ? `${text.slice(0, head)}…`
    : `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

export const duration = (millis: number): string => {
  if (millis < 1000) return `${Math.round(millis)}ms`
  if (millis < 60_000) return `${(millis / 1000).toFixed(1)}s`
  const minutes = Math.floor(millis / 60_000)
  const seconds = Math.round((millis % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`
}
