import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as ContextTransform from "../src/ContextTransform.js"
import * as PromptWire from "../src/PromptWire.js"

/**
 * Prompt caching (`docs/plan-model-capabilities.md` §7.1, M3).
 *
 * The breakpoint marks the end of the stable prefix -- the leading run of
 * system messages -- so a provider can bill it at the cached rate. Three
 * things have to hold, and all three are the kind that rot silently: it lands
 * on the *last* leading system message and no other, it survives this
 * repository's own wire boundary, and it stays out of canonical history.
 */

const ANTHROPIC = { cacheControl: { type: "ephemeral" } } as const
const OPENAI = { promptCacheBreakpoint: { mode: "explicit" } } as const

const context = (prompt: Prompt.Prompt): ContextTransform.Context => ({
  sessionId: "s" as ContextTransform.Context["sessionId"],
  submissionId: "sub" as ContextTransform.Context["submissionId"],
  runId: "r" as ContextTransform.Context["runId"],
  turnIndex: 1,
  canonicalPrompt: prompt,
  prompt
})

const system = (text: string) => Prompt.systemMessage({ content: text })
const user = (text: string) =>
  Prompt.makeMessage("user", { content: [Prompt.textPart({ text })] })

/** The options each message carries, positionally — the whole assertion surface. */
const optionsOf = (prompt: Prompt.Prompt) =>
  prompt.content.map((message) => message.options)

describe("ContextTransform.cacheBreakpoint", () => {
  it.effect("marks the last message of the leading system run, and only that one", () =>
    Effect.gen(function*() {
      const prompt = Prompt.fromMessages([
        system("instructions"),
        system("workspace details"),
        user("do the thing"),
        // A later system message is not part of the stable prefix: it sits
        // after conversation, which is where `appendSystem` puts one.
        system("dynamic per-turn note")
      ])
      const out = yield* ContextTransform.cacheBreakpoint().transform(context(prompt))
      assert.deepStrictEqual(optionsOf(out), [
        {},
        { anthropic: ANTHROPIC },
        {},
        {}
      ])
    }))

  it.effect("OpenAI's breakpoint is opt-in, and both can be written at once", () =>
    Effect.gen(function*() {
      const prompt = Prompt.fromMessages([system("instructions"), user("hi")])
      const both = yield* ContextTransform
        .cacheBreakpoint({ providers: ["anthropic", "openai"] })
        .transform(context(prompt))
      assert.deepStrictEqual(optionsOf(both), [
        { anthropic: ANTHROPIC, openai: OPENAI },
        {}
      ])
      // The default writes Anthropic's alone: an unread key is inert, but
      // OpenAI's own is rejected by models before GPT-5.6.
      const byDefault = yield* ContextTransform.cacheBreakpoint().transform(context(prompt))
      assert.deepStrictEqual(optionsOf(byDefault), [{ anthropic: ANTHROPIC }, {}])
    }))

  it.effect("a prompt with no leading system message is passed through untouched", () =>
    Effect.gen(function*() {
      const prompt = Prompt.fromMessages([user("hi"), system("late")])
      const out = yield* ContextTransform.cacheBreakpoint().transform(context(prompt))
      assert.deepStrictEqual(optionsOf(out), [{}, {}])
    }))

  it.effect("existing options on the marked message are preserved, not replaced", () =>
    Effect.gen(function*() {
      const prompt = Prompt.fromMessages([
        Prompt.systemMessage({
          content: "instructions",
          options: { somethingElse: { kept: true } }
        }),
        user("hi")
      ])
      const out = yield* ContextTransform.cacheBreakpoint().transform(context(prompt))
      assert.deepStrictEqual(optionsOf(out), [
        { somethingElse: { kept: true }, anthropic: ANTHROPIC },
        {}
      ])
    }))

  it.effect("the breakpoint survives PromptWire, which every boundary uses", () =>
    Effect.gen(function*() {
      // M0.2: the session snapshot, the client protocol, the cluster entity
      // payload and the durable payload all type their prompt as
      // `PromptWire.Prompt`, so this codec is the one that has to carry it.
      const prompt = Prompt.fromMessages([system("instructions"), user("hi")])
      const marked = yield* ContextTransform.cacheBreakpoint().transform(context(prompt))
      const wire = yield* Schema.encodeEffect(PromptWire.Prompt)(marked)
      const back = yield* Schema.decodeUnknownEffect(PromptWire.Prompt)(wire)
      assert.deepStrictEqual(optionsOf(back), [{ anthropic: ANTHROPIC }, {}])
    }))

  it.effect("canonical history is untouched", () =>
    Effect.gen(function*() {
      const prompt = Prompt.fromMessages([system("instructions"), user("hi")])
      const ctx = context(prompt)
      yield* ContextTransform.cacheBreakpoint().transform(ctx)
      // The breakpoint is a property of one model call, so it must never
      // reach a snapshot, an event, or the durable payload.
      assert.deepStrictEqual(optionsOf(ctx.canonicalPrompt), [{}, {}])
    }))
})
