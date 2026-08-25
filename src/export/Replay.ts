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
 * The honest limits, both of them:
 *
 * - A replay reproduces what the *model* said, not what the *tools* did --
 *   see `turnsOf`.
 * - It reproduces the *conversation*, not the run's control flow. A history
 *   records messages; it does not record which of them arrived as a fresh
 *   submission and which were steered or queued into a submission already
 *   running. Those look identical afterwards, so a replay submits each of them
 *   as its own prompt. The model sees the same messages in the same order; the
 *   *run boundaries* differ, and with them permission timing and the loop's
 *   view of where a turn began. Reproducing that would need the event log, not
 *   the transcript.
 *
 * Neither is a defect to be fixed here; they are what a transcript can and
 * cannot say, written down so nobody has to rediscover them from a fixture
 * that does not reproduce.
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

    // An assistant message with nothing in it is still a turn the model took.
    // Dropping it used to shift every later turn up by one, so a script
    // replayed the wrong answer to every subsequent prompt -- a silent
    // off-by-one in the middle of a fixture.
    if (text === "" && toolCalls.length === 0) return [{ text: "" }]
    return [{
      ...(text === "" ? {} : { text }),
      ...(toolCalls.length === 0 ? {} : { toolCalls })
    }]
  })

/**
 * Where the user first speaks, which is where the seed ends.
 *
 * The boundary is the first *user* message, not the first assistant one. A
 * seed containing an unanswered prompt would be replayed as context that
 * nobody responded to, and the script's first turn would then answer the
 * second question -- every later answer landing one prompt early.
 *
 * `-1` when the user never speaks: a transcript with no prompt in it is all
 * seed, and cannot be replayed at all.
 */
const firstPrompt = (self: Export.Export): number =>
  self.session.history.content.findIndex((message) => message.role === "user")

/**
 * What the user said after the conversation started, in order.
 *
 * A replay needs prompting: the script supplies the model's side, and these
 * are the inputs that draw them out.
 *
 * One prompt per user message, not one string. Concatenating the text parts
 * and discarding everything else meant an image, a file or an audio prompt
 * simply vanished -- and a message with no text at all vanished entirely,
 * taking its position in the sequence with it. A `Prompt` is what
 * `session.prompt` accepts directly, so each of these is submitted as it
 * stands, whatever it contains.
 *
 * Partitioned against {@link seedOf} at the first user message: the seed is
 * the context that was in place before anyone asked anything, and these are
 * the asks. Together they cover the user's side exactly once, which is what
 * stops a replay submitting the opening prompt twice.
 */
export const promptsOf = (self: Export.Export): ReadonlyArray<Prompt.Prompt> =>
  self.session.history.content
    .filter((message) => message.role === "user")
    .map((message) => Prompt.fromMessages([message]))

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
 * Everything that was in place before the first prompt.
 *
 * The starting point for a replay that reproduces a run rather than continuing
 * one: seed a session with this and the script produces the rest. An empty
 * result means the transcript opened with the model, which a replay cannot
 * reproduce because nothing prompted it.
 *
 * This used to say "the assistant's side removed" and then keep only the
 * *first* message of what was left -- so a run that opened with a prompt
 * seeded that prompt and then had it submitted a second time by `promptsOf`.
 * The boundary is stated once, here, and `promptsOf` reads the other side of
 * it.
 */
export const seedOf = (self: Export.Export): Prompt.Prompt => {
  const boundary = firstPrompt(self)
  return Prompt.fromMessages(
    boundary === -1
      ? [...self.session.history.content]
      : self.session.history.content.slice(0, boundary)
  )
}

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
