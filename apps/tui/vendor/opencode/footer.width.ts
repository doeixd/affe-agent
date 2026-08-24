/**
 * VENDORED -- REFERENCE COPY, NOT COMPILED.
 *
 * Vendored from opencode: `packages/opencode/src/cli/cmd/run/footer.width.ts`
 * Upstream: https://github.com/sst/opencode
 * Commit:   2a6be0a03b93a6734070e10a6c3b56863475f214
 * Licence:  MIT -- see ./LICENSE.opencode for the full text and
 *           copyright notice, retained as the licence requires.
 *
 * This file is unmodified upstream source, kept outside `src/` so it is
 * never built. It is the reference we port *from*; the adapted code lives
 * in `src/` and records its divergences there. See ./README.md.
 */

// Shared responsive width policy

const FOOTER_WIDTH_BREAKPOINTS = {
  compact: 80,
  commandHint: 66,
  model: 120,
  spacious: 150,
} as const

export function footerWidthPolicy(width: number) {
  const compact = width >= FOOTER_WIDTH_BREAKPOINTS.compact
  const model = width >= FOOTER_WIDTH_BREAKPOINTS.model
  const spacious = width >= FOOTER_WIDTH_BREAKPOINTS.spacious

  return {
    dialog: {
      narrow: !compact,
    },
    statusline: {
      showActivityMeta: compact,
      showCommandHint: width >= FOOTER_WIDTH_BREAKPOINTS.commandHint,
      showContextHints: compact,
      contextHintLimit: !compact ? 0 : spacious ? undefined : model ? 2 : 1,
      showModel: model,
    },
  }
}
