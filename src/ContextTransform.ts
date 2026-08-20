import { Effect } from "effect"
import type { Prompt } from "effect/unstable/ai"
import type { RunId, SessionId, SubmissionId } from "./internal/ids.js"

/**
 * What a transform is allowed to see.
 *
 * Enough metadata to derive usefully, without exposing mutable runtime
 * internals: the canonical prompt arrives as an immutable value, and the
 * correlation fields let a transform vary its behaviour by run or turn.
 */
export interface Context {
  readonly sessionId: SessionId
  readonly submissionId: SubmissionId
  readonly runId: RunId
  /** 1-based index of the turn about to execute. */
  readonly turnIndex: number
  readonly canonicalPrompt: Prompt.Prompt
}

/**
 * Derives the ephemeral, model-facing prompt from canonical session history.
 *
 * A transform never mutates canonical history: it produces the input for one
 * model call and nothing more. Anything that must survive into the next turn
 * belongs in canonical history, committed by the run engine.
 *
 * `E` and `R` are preserved so a transform can fail in its own way and depend
 * on its own services — memory recall, RAG retrieval, a workspace — without the
 * harness knowing what those are.
 */
export interface ContextTransform<E = never, R = never> {
  readonly transform: (context: Context) => Effect.Effect<Prompt.Prompt, E, R>
}

export const make = <E = never, R = never>(
  transform: (context: Context) => Effect.Effect<Prompt.Prompt, E, R>
): ContextTransform<E, R> => ({ transform })

/** Passes canonical history through untouched. */
export const identity: ContextTransform = make((context) =>
  Effect.succeed(context.canonicalPrompt)
)

/**
 * Left-to-right composition.
 *
 * Each transform sees the previous one's output in `canonicalPrompt`, so a
 * chain accumulates. Canonical history itself is still never touched — that
 * invariant is about the session's state, not about this field, which is simply
 * "the prompt so far".
 */
export const compose = <E = never, R = never>(
  ...transforms: ReadonlyArray<ContextTransform<E, R>>
): ContextTransform<E, R> =>
  make((context) =>
    Effect.reduce(transforms, () => context.canonicalPrompt, (prompt, next) =>
      next.transform({ ...context, canonicalPrompt: prompt })
    )
  )
