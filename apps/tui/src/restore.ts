import type { Prompt } from "effect/unstable/ai"
import { bodyOf, titleOf, type Views } from "./tools.ts"
import type { Entry } from "./view.ts"

/**
 * Paint a conversation that has already happened.
 *
 * Everything else in this UI is built from *events*: the projection watches a
 * live session and turns what it says into entries. A restored conversation
 * has no events -- it is a `Prompt`, the canonical history, recovered from a
 * store after the process that produced it is gone.
 *
 * So this is the other direction, and the two are not interchangeable. Events
 * carry things history does not (timings, tool call ids as they happened, the
 * order deltas arrived in) and history carries the one thing events do not:
 * that it is *canonical*. A turn that was interrupted mid-message emitted
 * events and left nothing in history, and a repaint that invented an entry for
 * it would show the user something the agent does not believe it said.
 *
 * That is the rule this file follows: **paint what the conversation contains,
 * and nothing else.** No timings, because they were not recorded; no summary
 * entries, because a summary describes a turn as it ran.
 */

/** Flatten a message's text parts into one string. */
const textOf = (
  content: ReadonlyArray<{ readonly type: string }>
): string =>
  content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim()

/**
 * The tool results of a turn, by call id.
 *
 * A tool call and its result are in *different* messages -- the assistant's
 * and the following tool message -- so rendering a call with its output means
 * looking ahead. Built once for the whole conversation rather than searched
 * per call, because the alternative is quadratic on the transcripts most worth
 * restoring: the long ones.
 */
const resultsById = (
  history: Prompt.Prompt
): ReadonlyMap<string, unknown> => {
  const results = new Map<string, unknown>()
  for (const message of history.content) {
    if (message.role !== "tool") continue
    for (const part of message.content) {
      if (part.type === "tool-result") results.set(part.id, part.result)
    }
  }
  return results
}

/**
 * A conversation, as transcript entries.
 *
 * Ids are derived from position rather than minted, so painting the same
 * history twice produces the same entries -- which is what lets a caller
 * re-paint after a branch switch without the store treating them as new.
 */
export const entriesOf = (
  history: Prompt.Prompt,
  views: Views
): ReadonlyArray<Entry> => {
  const results = resultsById(history)
  const entries: Array<Entry> = []

  history.content.forEach((message, index) => {
    if (message.role === "system") {
      // The agent's instructions. Not something the user said, and showing it
      // would put words in their mouth at the top of every restored session.
      return
    }

    if (message.role === "user") {
      const text = textOf(message.content)
      if (text !== "") {
        entries.push({
          id: `restored-${index}-user`,
          kind: "user",
          title: text,
          body: { type: "none" }
        })
      }
      return
    }

    if (message.role === "assistant") {
      const text = textOf(message.content)
      if (text !== "") {
        entries.push({
          id: `restored-${index}-assistant`,
          kind: "assistant",
          title: text,
          body: { type: "none" }
        })
      }
      for (const part of message.content) {
        if (part.type !== "tool-call") continue
        const result = results.get(part.id)
        entries.push({
          id: `restored-${index}-tool-${part.id}`,
          kind: "tool",
          title: titleOf(views, part.name, part.params),
          // A call with no result in history is one whose turn did not finish.
          // Marked as such rather than shown as running: nothing is going to
          // finish it now, and an entry that never settles would block the
          // whole transcript from reaching scrollback.
          ...(result === undefined
            ? { status: "failed" as const, body: { type: "none" as const } }
            : { status: "ok" as const, body: bodyOf(views, part.name, result, part.params) })
        })
      }
    }
  })

  return entries
}
