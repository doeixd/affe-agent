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

/** What a tool message recorded about one call. */
interface Recorded {
  readonly result: unknown
  /**
   * Whether the tool *failed*, as history recorded it.
   *
   * Not "did it return a value". An earlier version inferred status from
   * whether a result was present, which got both directions wrong: a recorded
   * failure was repainted with a success tick, and a success whose decoded
   * value happens to be `undefined` was shown as failed.
   */
  readonly isFailure: boolean
  /** The tool it belongs to, so a reused id cannot be matched blindly. */
  readonly name: string
}

/**
 * Tool results, matched to the call that produced them.
 *
 * A tool call and its result are in *different* messages -- the assistant's
 * and the tool message that follows it -- so rendering a call with its output
 * means looking ahead. Matching is done **within the turn**: the results for
 * an assistant message are in the tool messages between it and the next
 * assistant message, and only there.
 *
 * That scoping is what a flat `Map<id, result>` over the whole conversation
 * got wrong. Provider call ids are unique within a response, not across one --
 * so a reused id meant the later result overwrote the earlier, and both
 * restored calls displayed the same output.
 */
const resultsForTurn = (
  history: Prompt.Prompt,
  from: number
): ReadonlyMap<string, Recorded> => {
  const results = new Map<string, Recorded>()
  for (let index = from + 1; index < history.content.length; index++) {
    const message = history.content[index]!
    // The next assistant message begins the next turn; its results are not
    // this turn's, whatever ids they carry.
    if (message.role === "assistant") break
    if (message.role !== "tool") continue
    for (const part of message.content) {
      if (part.type !== "tool-result") continue
      // A preliminary result is superseded by the final one for the same call.
      // Later wins *within* a turn, which is the only place both can appear.
      results.set(part.id, {
        result: part.result,
        isFailure: part.isFailure,
        name: part.name
      })
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
      const results = resultsForTurn(history, index)
      for (const part of message.content) {
        if (part.type !== "tool-call") continue
        const recorded = results.get(part.id)
        // A result recorded under this id but for another tool is not this
        // call's. Better to show the call with no output than to attach
        // somebody else's.
        const matched = recorded !== undefined && recorded.name === part.name
          ? recorded
          : undefined
        entries.push({
          id: `restored-${index}-tool-${part.id}`,
          kind: "tool",
          title: titleOf(views, part.name, part.params),
          // No result in history means the turn did not finish. Marked failed
          // rather than shown running: nothing is going to finish it now, and
          // an entry that never settles blocks the whole transcript from
          // reaching scrollback.
          //
          // Status comes from `isFailure`, never from whether a value is
          // present -- a recorded failure has a result too.
          ...(matched === undefined
            ? { status: "failed" as const, body: { type: "none" as const } }
            : matched.isFailure
            ? {
              status: "failed" as const,
              body: bodyOf(views, part.name, matched.result, part.params)
            }
            : {
              status: "ok" as const,
              body: bodyOf(views, part.name, matched.result, part.params)
            })
        })
      }
    }
  })

  return entries
}
