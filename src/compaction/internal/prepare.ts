import { Option } from "effect"
import { Prompt } from "effect/unstable/ai"

/** The policy-independent result of choosing a canonical cut point. */
export interface Preparation<Checkpoint> {
  readonly messagesToSummarise: Prompt.Prompt
  readonly retained: Prompt.Prompt
  readonly previous: Option.Option<Checkpoint>
  /** The new checkpoint covers canonical messages before this index. */
  readonly coveredThrough: number
  /** Alias naming the first canonical message retained verbatim. */
  readonly firstKept: number
  readonly tokensBefore: Option.Option<number>
  readonly tokensRetained: Option.Option<number>
  /** The retained tail starts inside a user-led agentic turn. */
  readonly splitTurn: boolean
}

/**
 * Back a raw cut point off tool results so the retained prompt cannot begin
 * with an answer whose assistant tool call was summarized away.
 *
 * `retain` counts messages, and a raw count can land the boundary on a tool
 * message whose call was just folded into the summary; the projection then
 * carries a `tool_result` with no `tool_use`, which providers reject, so every
 * turn fails until the window happens to move. The boundary backs up to the
 * assistant message that issued those calls, keeping the exchange whole. It is
 * deliberately not aligned to a *user* turn: a long agentic run is one user
 * message followed by many assistant/tool exchanges, and a user-aligned boundary
 * could never fold any of it.
 */
export const alignOffToolResults = (
  messages: ReadonlyArray<Prompt.Message>,
  floor: number,
  raw: number
): number => {
  let index = Math.min(messages.length, Math.max(floor, raw))
  while (index > floor && messages[index]?.role === "tool") {
    index = index - 1
  }
  return index
}

/**
 * Purely materialize a preparation after a policy chooses its raw boundary.
 * Returns `None` when there is no non-empty span to summarize.
 */
export const prepare = <Checkpoint>(options: {
  readonly messages: ReadonlyArray<Prompt.Message>
  readonly previous: Option.Option<Checkpoint>
  readonly previouslyCovered: number
  readonly rawBoundary: number
  readonly tokensBefore?: number | undefined
  readonly tokensRetained?: number | undefined
}): Option.Option<Preparation<Checkpoint>> => {
  const firstKept = alignOffToolResults(
    options.messages,
    options.previouslyCovered,
    options.rawBoundary
  )
  if (firstKept <= options.previouslyCovered) {
    return Option.none()
  }
  return Option.some({
    messagesToSummarise: Prompt.fromMessages(
      options.messages.slice(options.previouslyCovered, firstKept)
    ),
    retained: Prompt.fromMessages(options.messages.slice(firstKept)),
    previous: options.previous,
    coveredThrough: firstKept,
    firstKept,
    tokensBefore: Option.fromUndefinedOr(options.tokensBefore),
    tokensRetained: Option.fromUndefinedOr(options.tokensRetained),
    splitTurn: options.messages[firstKept]?.role === "assistant"
  })
}
