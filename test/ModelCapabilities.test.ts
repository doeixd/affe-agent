import { assert, describe, it } from "@effect/vitest"
import { Generated } from "@effect/ai-anthropic"
import { Effect, Layer, Option } from "effect"
import { Model } from "effect/unstable/ai"
import * as ModelCapabilities from "../src/model/ModelCapabilities.js"

/**
 * Model capabilities (`docs/plan-model-capabilities.md` §4, M1).
 *
 * Two properties matter here and they are different in kind. One is
 * behavioural -- `current` resolves through the tags a `Model` provides, and
 * says so honestly when there is no model in context. The other is a guard
 * against *rot*: the built-in table is hand-written data about someone else's
 * product, so the only thing keeping it from silently falling behind is a
 * check that fails the build when the pinned rc names a model nobody has
 * classified.
 *
 * The provider package is imported *here* and not in `src/`: the table is
 * keyed by provider string, and this test is what ties those strings back to
 * the rc's own union.
 */

/** Every model id the pinned `@effect/ai-anthropic` names. */
const pinnedAnthropicModels: ReadonlyArray<string> =
  Generated.Model.members[1].literals

describe("ModelCapabilities: the built-in table cannot drift silently", () => {
  it("classifies every model the pinned rc names", () => {
    const classified = new Set([
      ...Object.keys(ModelCapabilities.builtinTable["anthropic"] ?? {}),
      ...(ModelCapabilities.UNCLASSIFIED["anthropic"] ?? [])
    ])
    const unclassified = pinnedAnthropicModels.filter((id) => !classified.has(id))
    assert.deepStrictEqual(
      unclassified,
      [],
      "Bumping @effect/ai-anthropic introduced a model with no capability row. " +
        "Add it to ANTHROPIC with its published context window and price, or " +
        "to UNCLASSIFIED if those are not published."
    )
  })

  it("records nothing about a model the rc does not name", () => {
    // The guard has to bite in both directions, or a typo'd key would sit in
    // the table forever looking like coverage.
    const known = new Set(pinnedAnthropicModels)
    const strays = Object.keys(ModelCapabilities.builtinTable["anthropic"] ?? {})
      .filter((id) => !known.has(id))
    assert.deepStrictEqual(strays, [])
  })

  it("states a context window and an output cap wherever it states anything", () => {
    for (const [id, caps] of Object.entries(ModelCapabilities.builtinTable["anthropic"] ?? {})) {
      assert.isAbove(caps.contextWindow, 0, id)
      assert.isAbove(caps.maxOutputTokens, 0, id)
      // Absent means unknown; a recorded price must have both directions.
      if (caps.cost !== undefined) {
        assert.isAbove(caps.cost.input, 0, id)
        assert.isAbove(caps.cost.output, 0, id)
      }
    }
  })
})

describe("ModelCapabilities: resolution", () => {
  it.effect("`current` reads the tags a Model provides", () =>
    Effect.gen(function*() {
      const capabilities = yield* ModelCapabilities.ModelCapabilities
      const caps = yield* capabilities.current
      assert.strictEqual(caps.contextWindow, 200_000)
      assert.strictEqual(caps.maxOutputTokens, 64_000)
    }).pipe(
      // One merged provide, not a chain: separate `Effect.provide` calls can
      // change service lifecycle behaviour. `Model.make` wraps any layer with
      // the provider/model tags -- the same tags
      // `AnthropicLanguageModel.model(...)` provides, without needing a
      // provider client here.
      Effect.provide(
        Layer.merge(
          ModelCapabilities.builtin,
          Model.make("anthropic", "claude-haiku-4-5", Layer.empty)
        )
      )
    ))

  it.effect("`current` fails honestly when no Model is in context", () =>
    Effect.gen(function*() {
      const capabilities = yield* ModelCapabilities.ModelCapabilities
      const result = yield* Effect.result(capabilities.current)
      assert.isTrue(result._tag === "Failure")
      // A caller who wired `AnthropicLanguageModel.layer(...)` rather than
      // `.model(...)` lands here, and the error says which to use.
      const failure = yield* Effect.flip(capabilities.current)
      assert.strictEqual(failure._tag, "UnknownCurrentModelError")
    }).pipe(Effect.provide(ModelCapabilities.builtin)))

  it.effect("an unrecorded model names itself in the failure", () =>
    Effect.gen(function*() {
      const capabilities = yield* ModelCapabilities.ModelCapabilities
      const failure = yield* Effect.flip(
        capabilities.forModel("anthropic", "claude-opus-4-1")
      )
      assert.strictEqual(failure._tag, "UnknownModelError")
      assert.include(failure.message, "anthropic/claude-opus-4-1")
      assert.include(failure.message, "fromTable")
    }).pipe(Effect.provide(ModelCapabilities.builtin)))

  it.effect("a caller's table answers where the built-in one does not", () =>
    Effect.gen(function*() {
      const capabilities = yield* ModelCapabilities.ModelCapabilities
      // A gateway's namespaced id is an ordinary string here.
      const caps = yield* capabilities.forModel("openrouter", "anthropic/claude-sonnet-5")
      assert.strictEqual(caps.contextWindow, 1_000_000)
      assert.deepStrictEqual(caps.vision, true)
    }).pipe(
      Effect.provide(
        ModelCapabilities.fromTable({
          openrouter: {
            "anthropic/claude-sonnet-5": {
              contextWindow: 1_000_000,
              maxOutputTokens: 128_000,
              vision: true
            }
          }
        })
      )
    ))

  it.effect("an absent capability is absent, not false", () =>
    Effect.gen(function*() {
      const capabilities = yield* ModelCapabilities.ModelCapabilities
      const caps = yield* capabilities.forModel("anthropic", "claude-sonnet-5")
      // The rc's ModelInfo predates the Models API capability fields, so
      // vision is genuinely unrecorded rather than known-false. A consumer
      // must be able to tell those apart.
      assert.strictEqual(caps.vision, undefined)
      assert.isFalse(caps.vision === false)
      assert.deepStrictEqual(Option.fromNullishOr(caps.vision), Option.none())
    }).pipe(Effect.provide(ModelCapabilities.builtin)))
})
