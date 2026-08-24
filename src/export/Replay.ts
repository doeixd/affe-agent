import { Option } from "effect"
import { Prompt } from "effect/unstable/ai"
import type * as Export from "./Export.js"

/**
 * Turn a real transcript into a deterministic script.
 *
 * A `TestLanguageModel` turn is `{ text }` or `{ toolCalls }`, and that is
 * exactly what an assistant message in a transcript already is. So an export
 * can be replayed: the recorded model output is played back in order, and the
 * agent runs against it with no provider, no network and no cost.
 *
 * What that buys is out of proportion to what it costs to build:
 *
 * - **A session that hit a bug becomes a regression test.** Export it, commit
 *   the file, and the bug has a fixture.
 * - **Evaluations get real transcripts** instead of hand-written scripts that
 *   drift from what models actually emit.
 * - **CI that cannot flake**, because there is nothing non-deterministic left.
 *
 * The honest limit is written into `turnsOf` below: a replay reproduces what
 * the *model* said, not what the *tools* did.
 */

/** The shape `TestLanguageModel.script` consumes. */
export interface Turn {
  readonly text?: string
  readonly toolCalls?: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly params: unknown
    readonly providerExecuted?: boolean
  }>
}

/**
 * The assistant's turns, in order.
 *
 * **A replay reproduces the model, not the world.** Tool *results* are not
 * scripted here, because they were produced by handlers that ran against a
 * real filesystem, a real shell, a real network -- and playing back a recorded
 * result would quietly turn a test of the agent into a test of nothing. The
 * tools run again, against whatever the test provides. That is usually a
 * memory sandbox, and the difference between its answers and the recorded ones
 * is frequently the bug being chased.
 *
 * A turn carrying both text and tool calls stays one turn, because that is
 * what the model produced and splitting it would replay a conversation that
 * never happened.
 */
export const turnsOf = (self: Export.Export): ReadonlyArray<Turn> =>
  self.session.history.content.flatMap((message) => {
    if (message.role !== "assistant") return []

    const text = message.content
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("")

    const toolCalls = message.content
      .filter((part): part is Extract<typeof part, { type: "tool-call" }> =>
        part.type === "tool-call"
      )
      .map((part) => ({
        id: part.id,
        name: part.name,
        params: part.params,
        ...(part.providerExecuted === true ? { providerExecuted: true } : {})
      }))

    if (text === "" && toolCalls.length === 0) return []
    return [{
      ...(text === "" ? {} : { text }),
      ...(toolCalls.length === 0 ? {} : { toolCalls })
    }]
  })

/**
 * What the user said, in order.
 *
 * A replay needs prompting: the script supplies the model's side, and these
 * are the inputs that draw them out. Without this a caller has to invent
 * prompts, and the run stops being a reproduction.
 */
export const promptsOf = (self: Export.Export): ReadonlyArray<string> =>
  self.session.history.content.flatMap((message) => {
    if (message.role !== "user") return []
    const text = message.content
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("")
    return text === "" ? [] : [text]
  })

/**
 * Every tool the transcript calls.
 *
 * What a replay needs to have available, read off the conversation itself
 * rather than off provenance -- provenance records what the agent *had*, and
 * this records what the transcript actually *used*. When they disagree, this
 * is the one that decides whether a replay can run.
 */
export const toolsUsed = (self: Export.Export): ReadonlyArray<string> => {
  const names = new Set<string>()
  for (const message of self.session.history.content) {
    if (message.role !== "assistant") continue
    for (const part of message.content) {
      if (part.type === "tool-call") names.add(part.name)
    }
  }
  return [...names]
}

/**
 * The conversation with the assistant's side removed.
 *
 * The starting point for a replay that should reproduce a run rather than
 * continue one: seed a session with this and the script produces the rest. An
 * empty result means the transcript opened with the model, which a replay
 * cannot reproduce because nothing prompted it.
 */
export const seedOf = (self: Export.Export): Prompt.Prompt =>
  Prompt.fromMessages(
    self.session.history.content.filter((message) =>
      message.role === "system" || message.role === "user"
    ).slice(0, 1)
  )

/**
 * Whether a replay can run here.
 *
 * Advisory like `Export.missingTools`, and for the same reason: it reports
 * what is absent, not whether the run will behave. `Option.none()` means
 * nothing is obviously missing.
 */
export const unavailable = (
  self: Export.Export,
  available: ReadonlyArray<string>
): Option.Option<ReadonlyArray<string>> => {
  const missing = toolsUsed(self).filter((name) => !available.includes(name))
  return missing.length === 0 ? Option.none() : Option.some(missing)
}
