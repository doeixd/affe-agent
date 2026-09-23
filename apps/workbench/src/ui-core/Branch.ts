/**
 * Where a branch starts (plan-workbench.md W2, "message actions supported by
 * the underlying session semantics").
 *
 * Editing a message you sent does not rewrite the conversation -- history is
 * canonical and a run already happened. It branches: a new conversation
 * seeded with everything *before* that message, where the edited text is
 * sent instead. The original is left exactly as it was.
 *
 * The page names a message by its place among the messages it shows; the
 * seed is cut from canonical history. The two line up through the person's
 * own messages: the k-th user message the page shows is the k-th user
 * message in history, since the page shows every one of them.
 */
import { Option } from "effect"
import { Prompt } from "effect/unstable/ai"
import type { MessageView } from "./ConversationProjection.js"

/** How many of the person's messages come before `index` on the page. */
export const userOrdinal = (messages: ReadonlyArray<MessageView>, index: number): Option.Option<number> => {
  const message = messages[index]
  if (message === undefined || message.role !== "user") return Option.none()
  return Option.some(messages.slice(0, index).filter((m) => m.role === "user").length)
}

/**
 * History up to, not including, the person's `ordinal`-th message (from 0).
 * `None` when history holds fewer -- the page is ahead of what was committed,
 * and a branch cut from a guess would be a different conversation.
 */
export const before = (history: Prompt.Prompt, ordinal: number): Option.Option<Prompt.Prompt> => {
  let seen = 0
  for (let at = 0; at < history.content.length; at++) {
    if (history.content[at]?.role !== "user") continue
    if (seen === ordinal) return Option.some(Prompt.fromMessages(history.content.slice(0, at)))
    seen++
  }
  return Option.none()
}
