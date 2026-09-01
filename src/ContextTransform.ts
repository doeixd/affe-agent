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

// ---------------------------------------------------------------------------
// Prompt caching
// ---------------------------------------------------------------------------

/**
 * A provider whose prompt-cache breakpoint this module knows how to write.
 *
 * Named as strings rather than imported, because `src/` imports no provider
 * package -- the same rule that keeps `Model` keyed by a provider *string*.
 */
export type CacheProvider = "anthropic" | "openai"

/**
 * The per-message option each provider reads to mark a reusable prefix.
 *
 * Both are namespaced keys in `Prompt`'s `options` record, which is a
 * `Record<string, Json | null>` with an index signature -- so writing one
 * needs no provider import, and a provider that does not read a key does not
 * see it. Verified 2026-09-01: `@effect/ai-openai` reads `options.openai?.*`
 * field by field, so an `anthropic` key is inert to it, and vice versa.
 */
const BREAKPOINTS = {
  anthropic: { cacheControl: { type: "ephemeral" } },
  openai: { promptCacheBreakpoint: { mode: "explicit" } }
  // `satisfies` the options object itself, not `Json`: when a provider
  // package is in the compilation, its declaration merging types
  // `SystemMessageOptions.anthropic` as a named property, so a typo in
  // `cacheControl` is a compile error rather than an option the provider
  // silently ignores. Indexing the interface by `string` instead was tried
  // first and checks nothing -- it resolves to the index signature's
  // `Json | null`, which accepts any shape. Without the package present the
  // index signature is all there is and these go unchecked; that is the
  // price of `src/` importing no provider, and it is why the values are
  // pinned by test rather than by type alone.
} satisfies Prompt.SystemMessageOptions

/**
 * Marks the end of the stable prompt prefix, so a provider can cache it.
 *
 * A long conversation re-sends its instructions and tool definitions on every
 * single turn, and both providers will bill that prefix at a reduced rate if
 * told where it ends. For an agent with large instructions and a large toolkit
 * -- `Presets.coding`, and both reference agents -- that is the largest cost
 * lever available, and it is one option on one message.
 *
 * **Where the breakpoint goes, and why it is not configurable.** It marks the
 * last message of the *leading run of system messages*: the agent's
 * instructions as seeded into canonical history, plus anything
 * `prependSystem` put in front. That run is the part of a prompt which is
 * byte-identical from one turn to the next, which is the only thing a prefix
 * cache can reuse. `appendSystem` adds *after* the conversation, so dynamic
 * per-turn instructions do not disturb it.
 *
 * **The compaction interaction, which is the part worth knowing.** A prefix
 * cache is only a saving while the bytes beneath the breakpoint are
 * unchanged, and compaction rewrites history. Keeping the breakpoint at the
 * head -- above everything a compaction can fold -- is what makes it survive
 * compaction instead of being invalidated by it. A breakpoint placed lower,
 * at the end of the conversation prefix, would cache more per turn and be
 * thrown away by the next compaction; that trade is real, but it is not the
 * default, and moving the breakpoint down is deliberately not an option here.
 *
 * **`providers` defaults to Anthropic alone, and the asymmetry is not
 * favouritism.** An unread namespaced key is inert, so writing Anthropic's
 * costs a caller on another provider nothing. OpenAI's is not inert: its own
 * documentation says `promptCacheBreakpoint` *"requires GPT-5.6 or later"*
 * and that "OpenAI may reject requests that use this option with earlier
 * models". A default that can turn a working request into a rejected one is
 * not a default -- so OpenAI's is opt-in, by naming it.
 *
 * ```ts
 * ContextTransform.cacheBreakpoint()
 * ContextTransform.cacheBreakpoint({ providers: ["anthropic", "openai"] })
 * ```
 *
 * Canonical history is untouched, like every transform: the breakpoint exists
 * only in the prompt handed to one model call, so it never reaches a
 * snapshot, an event, or the durable payload.
 */
export const cacheBreakpoint = (options?: {
  readonly providers?: ReadonlyArray<CacheProvider> | undefined
}): ContextTransform => {
  const providers = options?.providers ?? ["anthropic"]
  return make((context) => {
    const messages = context.prompt.content
    // The leading run of system messages: the stable prefix, and nothing else.
    let last = -1
    for (let index = 0; index < messages.length; index++) {
      if (messages[index]!.role !== "system") break
      last = index
    }
    if (last === -1 || providers.length === 0) {
      return Effect.succeed(context.prompt)
    }
    const marked = messages.map((message, index) =>
      index === last
        ? Prompt.systemMessage({
            content: (message as Prompt.SystemMessage).content,
            options: {
              ...message.options,
              ...Object.fromEntries(
                providers.map((provider) => [provider, BREAKPOINTS[provider]])
              )
            }
          })
        : message
    )
    return Effect.succeed(Prompt.fromMessages(marked))
  })
}

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
