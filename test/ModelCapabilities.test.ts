import { assert, describe, it } from "@effect/vitest"
import { Generated } from "@effect/ai-anthropic"
import { Effect, Layer, Option } from "effect"
import { Model, Prompt } from "effect/unstable/ai"
import * as Compaction from "../src/compaction/Compaction.js"
import * as ModelCapabilities from "../src/model/ModelCapabilities.js"
import * as Ids from "../src/internal/ids.js"

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

describe("ModelCapabilities: budget (M2)", () => {
  /**
   * `ResolveBudget` is handed a `ContextTransform.Context`, and this resolver
   * ignores it entirely -- the budget comes from the model in scope, not from
   * the turn. Passing `undefined` says that outright, and would stop
   * compiling if the resolver ever started reading it.
   */
  const context = undefined

  const anthropic = (model: string) =>
    Layer.merge(
      ModelCapabilities.builtin,
      Model.make("anthropic", model, Layer.empty)
    )

  it.effect("sizes the window from the model, and keeps the caller's figures", () =>
    Effect.gen(function*() {
      const resolve = ModelCapabilities.budget({ reserve: 4096, keepRecent: 8192 })
      const resolved = yield* resolve(context)

      // Only `contextWindow` is derived: it is the number a caller cannot
      // know. The other two are judgements about the agent.
      assert.strictEqual(resolved.contextWindow, 200_000)
      assert.strictEqual(resolved.reserveTokens, 4096)
      assert.strictEqual(resolved.keepRecentTokens, 8192)
    }).pipe(Effect.provide(anthropic("claude-haiku-4-5"))))

  it.effect("reserves the model's own max output when the caller does not say", () =>
    Effect.gen(function*() {
      const resolved = yield* ModelCapabilities.budget({ keepRecent: 8192 })(context)

      // The response has to fit somewhere, and the model states how large it
      // can be -- so the default is a fact rather than a guess.
      assert.strictEqual(resolved.reserveTokens, 64_000)
    }).pipe(Effect.provide(anthropic("claude-haiku-4-5"))))

  it.effect("fails naming the model rather than compacting to a guess", () =>
    Effect.gen(function*() {
      const result = yield* Effect.result(
        ModelCapabilities.budget({ keepRecent: 8192 })(context)
      )

      assert.isTrue(result._tag === "Failure")
      if (result._tag !== "Failure") return
      // The failure travels on `ResolveBudget`'s own error channel, which is
      // the reason that seam is typed at all.
      // Narrowed, not asserted: the channel carries two error types and only
      // one of them names a model.
      assert.strictEqual(result.failure._tag, "UnknownModelError")
      if (result.failure._tag !== "UnknownModelError") return
      assert.strictEqual(result.failure.model, "claude-imaginary-9")
    }).pipe(Effect.provide(anthropic("claude-imaginary-9"))))

  it.effect("is a ResolveBudget: Compaction.tokens takes it unchanged", () =>
    Effect.gen(function*() {
      // The milestone's actual claim -- "no change to `src/compaction`" -- is
      // this assignment, not any behaviour above. It is a runtime test only
      // incidentally; the point is that it compiles, and it would stop
      // compiling if either side's shape moved.
      const policy = Compaction.tokens({
        budget: ModelCapabilities.budget({ reserve: 4096, keepRecent: 8192 }),
        estimate: Compaction.estimate.approximate
      })

      assert.strictEqual(policy._tag, "Tokens")
      assert.strictEqual(typeof policy.budget, "function")
    }))
})

describe("ModelCapabilities: preflight (M5)", () => {
  const table = ModelCapabilities.fromTable({
    test: {
      "sighted": { contextWindow: 1000, maxOutputTokens: 100, vision: true },
      "text-only": { contextWindow: 1000, maxOutputTokens: 100, vision: false },
      // No `vision` key at all: nobody has recorded it.
      "unrecorded": { contextWindow: 1000, maxOutputTokens: 100 }
    }
  })

  const withModel = (model: string) =>
    Layer.merge(table, Model.make("test", model, Layer.empty))

  const withImage = Prompt.make([
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "file", mediaType: "image/png", data: new Uint8Array([1, 2]) }
      ]
    }
  ])
  const textOnly = Prompt.make([{ role: "user", content: [{ type: "text", text: "hello" }] }])

  const contextFor = (prompt: Prompt.Prompt) => ({
    sessionId: Ids.sessionId("s"),
    submissionId: Ids.submissionId("s:submission-1"),
    runId: Ids.runId("s:run-1"),
    turnIndex: 1,
    canonicalPrompt: prompt,
    prompt
  })

  it.effect("refuses an image against a text-only model, naming both", () =>
    Effect.gen(function*() {
      const result = yield* Effect.result(
        ModelCapabilities.preflight().transform(contextFor(withImage))
      )

      assert.isTrue(result._tag === "Failure")
      if (result._tag !== "Failure") return
      assert.strictEqual(result.failure._tag, "MissingCapabilityError")
      if (result.failure._tag !== "MissingCapabilityError") return
      // The point of failing here rather than at the provider is that the
      // message says which model and which capability.
      assert.strictEqual(result.failure.model, "text-only")
      assert.strictEqual(result.failure.capability, "vision")
      assert.match(result.failure.message, /does not support vision/)
      assert.match(result.failure.message, /image\/png/)
    }).pipe(Effect.provide(withModel("text-only"))))

  it.effect("passes an image to a model that can see, unchanged", () =>
    Effect.gen(function*() {
      const out = yield* ModelCapabilities.preflight().transform(contextFor(withImage))

      // This reads; it never rewrites.
      assert.strictEqual(out, withImage)
    }).pipe(Effect.provide(withModel("sighted"))))

  it.effect("an unrecorded vision fact is not a refusal", () =>
    Effect.gen(function*() {
      // `vision` is optional and absent means nobody recorded it, not "no".
      // Refusing here would turn an incomplete table into an outage, and the
      // provider's own 400 is still the backstop.
      const out = yield* ModelCapabilities.preflight().transform(contextFor(withImage))
      assert.strictEqual(out, withImage)
    }).pipe(Effect.provide(withModel("unrecorded"))))

  it.effect("a prompt with no images never resolves the model at all", () =>
    Effect.gen(function*() {
      // The capability table is provided but **no `Model` is**, so resolving
      // would fail with `UnknownCurrentModelError`. Succeeding is the proof
      // that nothing was resolved: an agent that sends no images pays nothing
      // for having this installed, and does not acquire a requirement on a
      // model being in scope at transform time.
      const out = yield* ModelCapabilities.preflight().transform(contextFor(textOnly))
      assert.strictEqual(out, textOnly)
    }).pipe(Effect.provide(table)))
})
