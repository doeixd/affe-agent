import { Effect, Ref } from "effect"
import { Prompt, Response } from "effect/unstable/ai"

/**
 * Canonical conversation history.
 *
 * `AgentSession` is its sole owner. Everything here is an append of already
 * completed work: nothing writes speculative or partial content, which is what
 * lets an interrupted turn leave history untouched.
 */
export const snapshot = (
  history: Ref.Ref<Prompt.Prompt>
): Effect.Effect<Prompt.Prompt> => Ref.get(history)

export const commit = (
  history: Ref.Ref<Prompt.Prompt>,
  prompt: Prompt.Prompt
): Effect.Effect<void> =>
  Ref.update(history, (current) => Prompt.concat(current, prompt))

export const systemMessage = (text: string): Prompt.Prompt =>
  Prompt.fromMessages([Prompt.systemMessage({ content: text })])

/**
 * Convert model output into committable messages.
 *
 * `Prompt.fromResponseParts` is typed for a concrete toolkit; the engine works
 * with erased tool types, so the cast is absorbed here rather than by callers.
 *
 * It also converts a `file` part -- since rc.113 -- but as a base64 string,
 * while canonical history holds the raw bytes (files cross every boundary
 * intact, never re-encoded). So upstream's file parts are stripped here and
 * the files re-attached below from the response, in the order the model
 * produced them, after the assistant message's other parts (the conversion
 * has already interleaved those, and a file's exact position among them is
 * not something a provider defines). A response that was *only* files becomes
 * an assistant message of files rather than nothing.
 */
export const fromResponseParts = (
  parts: ReadonlyArray<Response.AnyPart>
): Prompt.Prompt => {
  const converted = Prompt.fromResponseParts(parts)
  const prompt = Prompt.fromMessages(
    converted.content.map((message) =>
      message.role === "assistant"
        ? Prompt.assistantMessage({
          content: message.content.filter((part) => part.type !== "file"),
          options: message.options
        })
        : message
    )
  )
  const files = parts.flatMap((part) => part.type === "file" ? [filePart(part)] : [])
  if (files.length === 0) return prompt
  const messages = [...prompt.content]
  const at = messages.findIndex((message) => message.role === "assistant")
  if (at === -1) {
    return Prompt.fromMessages([Prompt.assistantMessage({ content: files }), ...messages])
  }
  const assistant = messages[at]!
  if (assistant.role !== "assistant") return prompt
  messages[at] = Prompt.assistantMessage({
    content: [...assistant.content, ...files],
    options: assistant.options
  })
  return Prompt.fromMessages(messages)
}

/** What the model *said*: text, reasoning and files, in order. */
export type Content = ReadonlyArray<Prompt.TextPart | Prompt.ReasoningPart | Prompt.FilePart>

/**
 * The assistant's message content from a response.
 *
 * Deliberately not every assistant part. Tool calls are the model asking for
 * work, and they are already announced as `ToolCallStarted` with their
 * parameters; a consumer reading a *result* wants what was produced. Derived
 * through `Prompt.fromResponseParts`, the same conversion the commit uses, so
 * this is exactly the content canonical history records.
 */
export const assistantContent = (
  parts: ReadonlyArray<Response.AnyPart>
): Content => {
  const out: Array<Prompt.TextPart | Prompt.ReasoningPart | Prompt.FilePart> = []
  for (const message of fromResponseParts(parts).content) {
    if (message.role !== "assistant") continue
    for (const part of message.content) {
      if (part.type === "text" || part.type === "reasoning" || part.type === "file") {
        out.push(part)
      }
    }
  }
  return out
}

/** A streamed file, as the prompt part canonical history will hold. */
export const filePart = (part: Response.FilePart): Prompt.FilePart =>
  Prompt.filePart({ mediaType: part.mediaType, data: part.data })
