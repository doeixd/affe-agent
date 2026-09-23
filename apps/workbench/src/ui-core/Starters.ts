/**
 * Starter prompts (plan-workbench.md W2, `PromptCatalog`): what an agent
 * suggests a person could open with, from its revision.
 *
 * Offered only where they make sense -- an empty conversation, idle, with
 * nothing asked -- and the same list in every adapter: the plain page shows
 * them as buttons, assistant-ui as its own suggestions. UI-neutral and pure.
 */
import type { ConversationView } from "./ConversationProjection.js"

/** At most this many: a starter list is a nudge, not a menu. */
export const maxStarters = 4

/** The revision's starters, trimmed of blanks and repeats, capped. */
export const normalize = (starters: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(starters.map((starter) => starter.trim()).filter((starter) => starter !== ""))].slice(0, maxStarters)

/** Which starters to offer now: all of them on an empty idle conversation, none otherwise. */
export const offered = (view: ConversationView, starters: ReadonlyArray<string>): ReadonlyArray<string> =>
  view.messages.length === 0 && view.status === "idle" && view.pending.length === 0 ? normalize(starters) : []
