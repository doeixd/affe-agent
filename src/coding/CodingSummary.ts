import { Effect, Option } from "effect"
import type { Prompt } from "effect/unstable/ai"
import type * as Compaction from "../compaction/Compaction.js"

/**
 * Cumulative file details for coding agents
 * (`docs/plan-branching-and-compaction.md` §21–23).
 *
 * A coding session's most valuable carryover is which files were read and
 * which were modified, accumulated across every compaction and branch
 * summary. That is not an agent-harness concept -- generic `/compaction`
 * knows nothing about files -- so it lives here, as *composition*: `wrap`
 * takes any `Summarise` and returns one whose output ends with a
 * machine-owned `## Files touched` section.
 *
 * The section is deterministic, never the model's. A template can ask a
 * summarising model for a Files section and hope; this one is computed from
 * the folded stretch's own tool calls (`read_file`, and `write_file` /
 * `edit_file` for modifications -- the known `/coding` toolkit definitions,
 * which are ours, exactly the first-version compromise §22 allows) and
 * unioned with what previous summaries already carried. Accumulation works
 * through text on purpose: a checkpoint persists the summary string and
 * nothing else, so details that live *in* the string survive every store,
 * every branch carryover, and a summary of a summary -- the §23 cases --
 * without widening `SummaryResult` or the checkpoint schema.
 */

/** What the folded work touched. */
export interface FilesTouched {
  readonly read: ReadonlyArray<string>
  readonly modified: ReadonlyArray<string>
}

const HEADING = "## Files touched"
const READ_PREFIX = "- read: "
const MODIFIED_PREFIX = "- modified: "

/** Tool names whose call means the file was read or modified. */
const READS = new Set(["read_file"])
const MODIFIES = new Set(["write_file", "edit_file"])

/**
 * Recover the section from text -- a previous summary, or a carryover
 * message folded into a later stretch.
 *
 * Only lines in this module's own format count, so a model writing prose
 * about files cannot inject entries; what accumulates is exactly what was
 * once observed as a tool call.
 */
export const parse = (text: string): FilesTouched => {
  const read: Array<string> = []
  const modified: Array<string> = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.startsWith(READ_PREFIX)) read.push(trimmed.slice(READ_PREFIX.length))
    else if (trimmed.startsWith(MODIFIED_PREFIX)) modified.push(trimmed.slice(MODIFIED_PREFIX.length))
  }
  return { read, modified }
}

/** The section, rendered. Sorted so equal sets are equal text. */
export const render = (files: FilesTouched): string => {
  const lines = [
    ...[...new Set(files.read)].sort().map((path) => `${READ_PREFIX}${path}`),
    ...[...new Set(files.modified)].sort().map((path) => `${MODIFIED_PREFIX}${path}`)
  ]
  return lines.length === 0 ? "" : `${HEADING}\n${lines.join("\n")}`
}

/** File operations observed in the stretch being folded. */
const filesIn = (messages: Prompt.Prompt): FilesTouched => {
  const read: Array<string> = []
  const modified: Array<string> = []
  for (const message of messages.content) {
    if (message.role === "system") {
      // A folded carryover or summary message: its own section accumulates
      // (§23's nested case).
      const carried = parse(message.content)
      read.push(...carried.read)
      modified.push(...carried.modified)
      continue
    }
    for (const part of message.content) {
      if (part.type !== "tool-call") continue
      // `params` is `unknown` on the wire; narrow it rather than cast it.
      const params: unknown = part.params
      if (typeof params !== "object" || params === null || !("path" in params)) continue
      const path: unknown = params.path
      if (typeof path !== "string") continue
      if (READS.has(part.name)) read.push(path)
      else if (MODIFIES.has(part.name)) modified.push(path)
    }
  }
  return { read, modified }
}

const union = (left: FilesTouched, right: FilesTouched): FilesTouched => ({
  read: [...left.read, ...right.read],
  modified: [...left.modified, ...right.modified]
})

/**
 * A `Summarise` whose output carries cumulative file details.
 *
 * The inner summariser -- `Compaction.model()`, a heuristic, anything --
 * produces the summary as it always does; this appends the computed
 * `## Files touched` section, replacing any such section the inner text
 * already ends with. The details are the union of three sources: the
 * previous summary's section (repeated compaction), sections inside folded
 * system messages (a branch carryover later compacted), and the folded
 * stretch's own `/coding` tool calls. Usage passes through untouched.
 *
 * Works unchanged as a `BranchSummary` summariser, which is §23's point:
 * one mechanism serves repeated compaction, branch carryover, and nested
 * carryover.
 */
export const wrap = <E, R>(
  inner: Compaction.Summarise<E, R>
): Compaction.Summarise<E, R> =>
(options) =>
  Effect.map(inner(options), (result) => {
    const summary: Compaction.SummaryResult = typeof result === "string"
      ? { text: result, usage: Option.none() }
      : result
    const accumulated = union(
      Option.match(options.previous, {
        onNone: (): FilesTouched => ({ read: [], modified: [] }),
        onSome: parse
      }),
      filesIn(options.messages)
    )
    const section = render(accumulated)
    // The inner summariser may have been wrapped already, or a template may
    // have echoed a section; strip any existing machine section so the text
    // holds exactly one, and ours.
    const headingAt = summary.text.lastIndexOf(HEADING)
    const base = headingAt === -1 ? summary.text : summary.text.slice(0, headingAt).trimEnd()
    return {
      text: section === "" ? base : `${base}\n\n${section}`,
      usage: summary.usage
    }
  })
