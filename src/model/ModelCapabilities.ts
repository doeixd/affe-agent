import { Context, Effect, Layer, Option, Schema } from "effect"
import { Model } from "effect/unstable/ai"

/**
 * What a model can do (`docs/plan-model-capabilities.md` §4).
 *
 * Upstream's `Model` carries two strings and a layer: a provider name and a
 * model name. It does not say how much context the model holds, what it costs,
 * or whether it can see an image -- so everything downstream that needs to
 * know is told by a hand-written number at the call site, or not at all.
 * `Compaction.tokens` says so in its own doc comment: *"Build a context-window
 * policy without coupling an agent to a model."* This module is the coupling,
 * made optional and explicit.
 *
 * It is **not** a provider abstraction. Provider-specific request options
 * (`temperature`, Anthropic's `thinking`, OpenAI's `reasoning.effort`) stay in
 * each provider's own `Config`, reached through `withConfigOverride`; §3 of the
 * plan argues why normalising them across providers is a non-goal. The line
 * this module holds: **a capability is a fact about a model that a caller must
 * branch on; an option is an instruction to a provider.**
 *
 * Nothing here imports a provider package. Capabilities are keyed by the
 * provider *string*, exactly as `Model` is.
 */

// ---------------------------------------------------------------------------
// The value

/**
 * What is known about one model.
 *
 * **Absent means unknown, and never means false.** Only `contextWindow` and
 * `maxOutputTokens` are required, because they are the two facts every
 * published model states and the two `Compaction` cannot work without. The
 * rest are optional on purpose: a wrong capability is worse than a missing
 * one -- a `vision: false` invented for a model nobody checked would refuse
 * work the model can do, and an invented price would mis-bill silently. A
 * consumer that cannot answer its question from what is present should say so
 * (or decline to act), not assume.
 *
 * This is a deliberate change from the plan's §4.1 sketch, which had every
 * field required. Filling in the required fields for the models this
 * repository's pinned rcs name turned out to need data that is not published
 * per model in any source available here -- see `builtin`.
 */
export interface Capabilities {
  /** Total input + output the model will hold, in tokens. */
  readonly contextWindow: number
  /** The most it will emit in one response, in tokens. */
  readonly maxOutputTokens: number
  /** Accepts image parts. Absent means nobody has recorded it. */
  readonly vision?: boolean | undefined
  /** Accepts tool definitions. Absent means nobody has recorded it. */
  readonly tools?: boolean | undefined
  /** Has a reasoning mode at all -- not which knob turns it on. */
  readonly reasoning?: boolean | undefined
  /**
   * Price per million tokens, in whatever unit the caller keeps its books in.
   *
   * `cacheRead` and `cacheWrite` are separate rates and both matter: a cache
   * *write* costs more than an uncached token, not less, so a cost ceiling
   * that prices only reads under-counts the first turn of every conversation.
   * `Response.Usage` separates all three (`uncached` / `cacheRead` /
   * `cacheWrite`), which is what makes pricing them separately possible.
   */
  readonly cost?: {
    readonly input: number
    readonly output: number
    readonly cacheRead?: number | undefined
    readonly cacheWrite?: number | undefined
  } | undefined
}

/** A model with no capability row, named so the caller can add one. */
export class UnknownModelError extends Schema.TaggedError<UnknownModelError>()(
  "UnknownModelError",
  { provider: Schema.String, model: Schema.String }
) {
  override get message() {
    return `No capabilities recorded for ${this.provider}/${this.model}. ` +
      `Provide them with ModelCapabilities.fromTable.`
  }
}

/** Raised when nothing in context says which model is in use. */
export class UnknownCurrentModelError
  extends Schema.TaggedError<UnknownCurrentModelError>()("UnknownCurrentModelError", {})
{
  override get message() {
    return "No model in context. `current` reads Model.ProviderName and " +
      "Model.ModelName, which only a `Model` provides -- wire the provider " +
      "with e.g. AnthropicLanguageModel.model(...) rather than .layer(...)."
  }
}

/** Capabilities per provider, per model name. */
export type Table = Readonly<Record<string, Readonly<Record<string, Capabilities>>>>

// ---------------------------------------------------------------------------
// The service

/**
 * Capabilities for a model, by name or for the one in context.
 *
 * `current` reads `Model.ProviderName` and `Model.ModelName`, the tags every
 * upstream `Model` provides automatically. A caller who wired the bare
 * `AnthropicLanguageModel.layer({...})` has neither tag in context and gets
 * `UnknownCurrentModelError` -- the honest outcome, and the reason the error
 * is typed rather than defaulted away. `Model.make(provider, name, layer)`
 * wraps any layer if a provider package's `model` constructor is not being
 * used.
 */
export class ModelCapabilities extends Context.Service<ModelCapabilities, {
  readonly current: Effect.Effect<
    Capabilities,
    UnknownModelError | UnknownCurrentModelError
  >
  /**
   * Named `forModel` rather than the plan's `of`: `Context.Service` already
   * puts an `of` static on the class, and a method of the same name shadows
   * it -- the constructor call then typechecks the service object against
   * this signature instead. Found by the compiler, not by reasoning.
   */
  readonly forModel: (
    provider: string,
    model: string
  ) => Effect.Effect<Capabilities, UnknownModelError>
}>()("@doeixd/effect-agent/ModelCapabilities") {}

/**
 * Capabilities from a table you supply.
 *
 * The answer to `builtin` being wrong, incomplete, or silent about a gateway's
 * namespaced ids (`anthropic/claude-sonnet-5` through OpenRouter is an
 * ordinary string here, and its own row). Ordinary data, so a deployment that
 * fetches a model list at boot can build one and pass it in.
 */
export const fromTable = (table: Table): Layer.Layer<ModelCapabilities> => {
  const forModel = (
    provider: string,
    model: string
  ): Effect.Effect<Capabilities, UnknownModelError> => {
    const found = table[provider]?.[model]
    return found === undefined
      ? Effect.fail(new UnknownModelError({ provider, model }))
      : Effect.succeed(found)
  }
  // Annotated rather than inferred: `Layer.succeed` widens each field to
  // `unknown` without a target type to check against, and the two failure
  // types on `current` otherwise stay an un-collapsed union.
  const service: typeof ModelCapabilities.Service = {
    forModel,
    current: Effect.gen(function*() {
      const provider = yield* Effect.serviceOption(Model.ProviderName)
      const model = yield* Effect.serviceOption(Model.ModelName)
      if (Option.isNone(provider) || Option.isNone(model)) {
        return yield* new UnknownCurrentModelError()
      }
      return yield* forModel(provider.value, model.value)
    })
  }
  return Layer.succeed(ModelCapabilities, service)
}

// ---------------------------------------------------------------------------
// The built-in table

/**
 * Capabilities for the models this repository's pinned rcs name, as far as
 * they are published.
 *
 * **This table is data, not truth, and it will go stale.** `fromTable` is the
 * answer to it being wrong; that ordering is the design, not an apology.
 * `test/ModelCapabilities.test.ts` keeps it from drifting *silently*: every id
 * in the pinned `@effect/ai-anthropic` `Generated.Model` union must appear
 * either here or in `UNCLASSIFIED`, so bumping the rc to one naming a new
 * model fails the build until somebody decides which list it belongs in.
 *
 * Sourced 2026-09-01 from Anthropic's published model reference. Only
 * `contextWindow`, `maxOutputTokens` and price are recorded, because those are
 * what that reference states per model; `vision`, `tools` and `reasoning` are
 * left absent rather than assumed, even where they are near-certainly true.
 * The accurate source for those is the Models API's `capabilities` field
 * (`image_input.supported` and friends) -- **which the pinned rc cannot
 * reach**: its generated `ModelInfo` is `{created_at, display_name, id, type}`
 * and predates those fields entirely. A live capability layer is therefore a
 * later slice, gated on an rc bump rather than on effort.
 */
const ANTHROPIC: Readonly<Record<string, Capabilities>> = {
  "claude-fable-5": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    cost: { input: 10, output: 50 }
  },
  "claude-mythos-5": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    cost: { input: 10, output: 50 }
  },
  "claude-opus-4-8": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    cost: { input: 5, output: 25 }
  },
  "claude-opus-4-7": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    cost: { input: 5, output: 25 }
  },
  "claude-opus-4-6": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    cost: { input: 5, output: 25 }
  },
  "claude-sonnet-5": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    cost: { input: 2, output: 10 }
  },
  "claude-sonnet-4-6": {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    cost: { input: 3, output: 15 }
  },
  "claude-haiku-4-5": {
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    cost: { input: 1, output: 5 }
  },
  // The dated snapshot is the same model as its alias, and callers use both.
  "claude-haiku-4-5-20251001": {
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    cost: { input: 1, output: 5 }
  }
}

/**
 * Model ids the pinned rc names for which no per-model context window or
 * output cap is published in the reference used to build `ANTHROPIC`.
 *
 * Listing them is the point. An empty row (`{}`) would be a lie the type
 * cannot express, and omitting them silently would let the exhaustiveness
 * check pass while the table quietly failed to cover a third of the union.
 * A caller who needs one of these supplies it with `fromTable`; anyone who
 * finds the published numbers should move the id up into `ANTHROPIC`.
 */
export const UNCLASSIFIED: Readonly<Record<string, ReadonlyArray<string>>> = {
  anthropic: [
    "claude-mythos-preview",
    "claude-opus-4-5",
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-1",
    "claude-opus-4-1-20250805"
  ]
}

/**
 * The built-in table, as a layer.
 *
 * OpenAI is deliberately absent. Its `Generated.Model` union names ~118 ids --
 * chat, embedding, audio and legacy models together -- and a hand-written row
 * per id is neither maintainable nor checkable, which is exactly the drift the
 * guard on the Anthropic table exists to prevent. A partial OpenAI table with
 * no guard would give the *appearance* of coverage; `fromTable` gives real
 * coverage for the handful of ids a given deployment actually uses. The plan's
 * §4.3 assumed one exhaustiveness rule for every provider; counting the unions
 * is what showed a provider's table has to be either exhaustive and guarded,
 * or absent.
 */
export const builtin: Layer.Layer<ModelCapabilities> = fromTable({
  anthropic: ANTHROPIC
})

/** The built-in rows, for a caller extending rather than replacing them. */
export const builtinTable: Table = { anthropic: ANTHROPIC }
