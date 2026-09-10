import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as AgentInput from "../src/AgentInput.js"
import { encodedText } from "../src/internal/promptText.js"

/**
 * Item 100: a string prompt's wire encoding is built directly on the hot
 * path. It must be exactly what the schema would produce, and decode back to
 * the same prompt, or `AgentInput.Current` would hold a value of its own.
 */
describe("the direct encoding of a text prompt", () => {
  const awkward = ["", "hi", "question 7", "émoji 🧪 and \"quotes\"", "line\nbreak", " ".repeat(3), "{\"content\":1}"]

  it.effect("equals the prompt wire's own encoding, for awkward strings", () =>
    Effect.gen(function*() {
      for (const text of awkward) {
        const viaSchema = yield* Schema.encodeUnknownEffect(AgentInput.prompt.schema)(text)
        assert.deepStrictEqual(encodedText(text), viaSchema, JSON.stringify(text))
      }
    }))

  it.effect("decodes back through the default input's schema", () =>
    Effect.gen(function*() {
      for (const text of awkward) {
        const viaSchema = yield* Schema.decodeUnknownEffect(AgentInput.prompt.schema)(
          yield* Schema.encodeUnknownEffect(AgentInput.prompt.schema)(text)
        )
        const direct = yield* Schema.decodeUnknownEffect(AgentInput.prompt.schema)(encodedText(text))
        assert.deepStrictEqual(direct, viaSchema)
      }
    }))
})
