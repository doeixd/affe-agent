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
 */
export const fromResponseParts = (
  parts: ReadonlyArray<Response.AnyPart>
): Prompt.Prompt => Prompt.fromResponseParts(parts)
