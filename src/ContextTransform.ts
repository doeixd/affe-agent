import { Effect } from "effect"
import type { Pipeable } from "effect/Pipeable"
import { pipeArguments } from "effect/Pipeable"
import { Prompt } from "effect/unstable/ai"
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
  /**
   * The session's canonical history, as committed.
   *
   * Always the original snapshot, even part-way through a composition. The
   * whole architecture rests on canonical-versus-derived, so this field must
   * not quietly come to mean "the prompt so far".
   */
  readonly canonicalPrompt: Prompt.Prompt
  /**
   * The prompt as derived so far.
   *
   * Equal to `canonicalPrompt` for the first transform in a chain; each
   * subsequent transform sees the previous one's output here. Build from this
   * unless you specifically want to discard earlier transforms' work.
   */
  readonly prompt: Prompt.Prompt
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
export interface ContextTransform<E = never, R = never> extends Pipeable {
  readonly transform: (context: Context) => Effect.Effect<Prompt.Prompt, E, R>
}

export const make = <E = never, R = never>(
  transform: (context: Context) => Effect.Effect<Prompt.Prompt, E, R>
): ContextTransform<E, R> => ({
  transform,
  // `pipe` carries no semantics of its own -- it is syntax for passing this
  // value through functions. That matters here: composing transforms means
  // something specific, and it stays spelled out (`compose`) rather than being
  // implied by the position of an argument.
  pipe() {
    return pipeArguments(this, arguments)
  }
})

/**
 * A discrete system message.
 *
 * `Prompt.appendSystem` folds text into an adjacent system message, which makes
 * composition order hard to predict — two transforms each adding a line can end
 * up concatenated into one. Adding a separate message keeps `compose`
 * associative and each contribution legible in the prompt.
 */
const systemPrompt = (text: string): Prompt.Prompt =>
  Prompt.fromMessages([Prompt.systemMessage({ content: text })])

/** Passes the derived prompt through untouched. */
export const identity: ContextTransform = make((context) =>
  Effect.succeed(context.prompt)
)

/**
 * Add a system message to the model-facing prompt only.
 *
 * Dynamic instructions are the most common transform there is — workspace
 * details, the current date, permissions, retrieved memory — and they are all
 * this shape. Canonical history is untouched, which is what makes them safe to
 * recompute every turn.
 *
 * The message is built from the context, so it can vary per turn.
 */
export const appendSystem = <E = never, R = never>(
  message: (context: Context) => Effect.Effect<string, E, R>
): ContextTransform<E, R> =>
  make((context) =>
    Effect.map(message(context), (text) =>
      Prompt.concat(context.prompt, systemPrompt(text))
    )
  )

/**
 * Instructions computed per turn, appended as a system message.
 *
 * `appendSystem` over an Effect that does not need the context: the shape
 * for credentials, the date, a feature flag -- anything read from the
 * environment rather than derived from the prompt. It is a transform, and
 * so it runs every turn; instructions that never change belong on the agent.
 */
export const instructions = <E = never, R = never>(
  message: Effect.Effect<string, E, R>
): ContextTransform<E, R> => appendSystem(() => message)

/** As `appendSystem`, but placed before the existing messages. */
export const prependSystem = <E = never, R = never>(
  message: (context: Context) => Effect.Effect<string, E, R>
): ContextTransform<E, R> =>
  make((context) =>
    Effect.map(message(context), (text) =>
      Prompt.concat(systemPrompt(text), context.prompt)
    )
  )

/**
 * Left-to-right composition.
 *
 * Each transform sees the previous one's output in `prompt`, while
 * `canonicalPrompt` keeps pointing at the session's committed history. An
 * earlier version threaded the accumulated value through `canonicalPrompt`
 * itself, which quietly made the field mean two different things depending on
 * position in the chain — the one distinction this design cannot afford to
 * blur.
 */
/**
 * The pieces of a composed transform, extracted per element.
 *
 * Declaring `compose` over a single `E` and `R` reads naturally and does not
 * work: TypeScript infers them from the first argument and rejects every
 * argument that differs. Two transforms failing in different ways, or needing
 * different services — the case composition exists for — would not compile at
 * all. Extraction distributes because `Transform` is a naked type parameter.
 */
type ErrorOf<Transform> = Transform extends ContextTransform<infer E, infer _R>
  ? E
  : never
type ServicesOf<Transform> = Transform extends ContextTransform<
  infer _E,
  infer R
>
  ? R
  : never

export const compose = <
  const Transforms extends ReadonlyArray<ContextTransform<any, any>>
>(
  ...transforms: Transforms
): ContextTransform<
  ErrorOf<Transforms[number]>,
  ServicesOf<Transforms[number]>
> =>
  make((context) =>
    Effect.reduce(transforms, () => context.prompt, (prompt, next) =>
      next.transform({ ...context, prompt })
    )
  ) as ContextTransform<
    ErrorOf<Transforms[number]>,
    ServicesOf<Transforms[number]>
  >
