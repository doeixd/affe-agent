import type { ColorInput } from "@opentui/core"

/**
 * Colour tokens for the TUI.
 *
 * ---------------------------------------------------------------------------
 * Structure ported from opencode, `packages/opencode/src/cli/cmd/run/theme.ts`,
 * read at commit 2a6be0a03b93a6734070e10a6c3b56863475f214.
 * Upstream: https://github.com/sst/opencode -- MIT, see
 * `vendor/opencode/LICENSE.opencode`. The pristine copy is in `vendor/`.
 *
 * Taken: the shape. A `Tone` per entry kind (a body colour, and an optional
 * separate colour for the leading marker), and separate groups for the footer
 * and for block content. Keeping their token *names* is deliberate -- later
 * ports of their render files then read almost unchanged.
 *
 * Not taken: `resolveTheme`, `generateSystem` and the theme JSON model --
 * roughly 500 of their 690 lines. That is a terminal colour-scheme detector
 * that derives a palette from the terminal's own colours and falls back to a
 * hardcoded one. It is good work, and it is environment handling we have not
 * thought about; adopting it wholesale would mean inheriting behaviour we
 * cannot yet test. A fixed palette first, detection later if it is wanted.
 * ---------------------------------------------------------------------------
 */

/** How one kind of entry is coloured. */
export interface Tone {
  /** The entry's text. */
  readonly body: ColorInput
  /** The leading marker, when it differs from the body. */
  readonly start?: ColorInput
}

/** Every kind of thing that can appear in the transcript. */
export type EntryKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool"
  | "notice"
  /** The line closing a turn: how long it took, what it used. */
  | "summary"

export type EntryTheme = Record<EntryKind, Tone>

export interface FooterTheme {
  readonly highlight: ColorInput
  readonly warning: ColorInput
  readonly success: ColorInput
  readonly error: ColorInput
  readonly muted: ColorInput
  readonly text: ColorInput
  readonly status: ColorInput
  readonly border: ColorInput
}

/** Colours for content rendered inside an entry: code, diffs, structured output. */
export interface BlockTheme {
  readonly highlight: ColorInput
  readonly warning: ColorInput
  readonly text: ColorInput
  readonly muted: ColorInput
  readonly diffAdded: ColorInput
  readonly diffRemoved: ColorInput
  readonly diffLineNumber: ColorInput
}

export interface Theme {
  readonly background: ColorInput
  readonly entry: EntryTheme
  readonly footer: FooterTheme
  readonly block: BlockTheme
}

const palette = {
  bg: "#1a1b26",
  fg: "#c0caf5",
  blue: "#7aa2f7",
  green: "#9ece6a",
  yellow: "#e0af68",
  red: "#f7768e",
  magenta: "#bb9af7",
  dim: "#565f89",
  border: "#3b4261"
} as const

/** The default palette. Fixed, and dark -- see the note above on detection. */
export const theme: Theme = {
  background: palette.bg,
  entry: {
    user: { body: palette.fg, start: palette.blue },
    assistant: { body: palette.fg, start: palette.green },
    // Reasoning is deliberately dim: it is context, not the answer.
    reasoning: { body: palette.dim, start: palette.dim },
    tool: { body: palette.dim, start: palette.yellow },
    notice: { body: palette.red, start: palette.red },
    // Dim, like their turn summary: it is a footnote to the turn, not part of it.
    summary: { body: palette.dim, start: palette.dim }
  },
  footer: {
    highlight: palette.blue,
    warning: palette.yellow,
    success: palette.green,
    error: palette.red,
    muted: palette.dim,
    text: palette.fg,
    status: palette.dim,
    border: palette.border
  },
  block: {
    highlight: palette.magenta,
    warning: palette.yellow,
    text: palette.fg,
    muted: palette.dim,
    diffAdded: palette.green,
    diffRemoved: palette.red,
    diffLineNumber: palette.dim
  }
}

/** The marker drawn at the start of an entry, by kind. */
export const marker: Record<EntryKind, string> = {
  user: "›",
  assistant: "●",
  reasoning: "│",
  tool: "•",
  notice: "!",
  summary: "▣"
}
