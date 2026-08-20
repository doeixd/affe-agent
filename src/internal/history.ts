import { Effect, SubscriptionRef } from "effect"
import { Prompt, Response } from "effect/unstable/ai"
import type { SessionState } from "./state.js"

/**
 * Canonical conversation history.
 *
 * `AgentSession` is its sole owner. Everything here is an append of already
 * completed work: nothing writes speculative or partial content, which is what
 * lets an interrupted turn leave history untouched.
 */
export const snapshot = (
  state: SubscriptionRef.SubscriptionRef<SessionState>
): Effect.Effect<Prompt.Prompt> =>
  SubscriptionRef.get(state).pipe(Effect.map((s) => s.history))

export const commit = (
  state: SubscriptionRef.SubscriptionRef<SessionState>,
  prompt: Prompt.Prompt
): Effect.Effect<void> =>
  SubscriptionRef.update(state, (s) => ({
    ...s,
    history: Prompt.concat(s.history, prompt)
  }))

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
