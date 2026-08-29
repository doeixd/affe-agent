import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { Prompt } from "effect/unstable/ai"
import {
  alignOffToolResults,
  prepare
} from "../src/compaction/internal/prepare.js"

const transcript = Prompt.fromMessages([
  Prompt.userMessage({ content: [Prompt.textPart({ text: "investigate" })] }),
  Prompt.assistantMessage({
    content: [Prompt.toolCallPart({
      id: "call-1",
      name: "search",
      params: { query: "one" },
      providerExecuted: false
    })]
  }),
  Prompt.toolMessage({
    content: [Prompt.toolResultPart({
      id: "call-1",
      name: "search",
      isFailure: false,
      result: "result",
      providerExecuted: false
    })]
  }),
  Prompt.assistantMessage({ content: [Prompt.textPart({ text: "working" })] }),
  Prompt.userMessage({ content: [Prompt.textPart({ text: "continue" })] })
])

describe("compaction preparation", () => {
  it("normalizes a cut off tool results and exposes a split turn", () => {
    assert.strictEqual(alignOffToolResults(transcript.content, 0, 2), 1)

    const result = prepare({
      messages: transcript.content,
      previous: Option.some("prior"),
      previouslyCovered: 0,
      rawBoundary: 2,
      tokensBefore: 120,
      tokensRetained: 40
    })
    assert.isTrue(Option.isSome(result))
    if (Option.isSome(result)) {
      assert.deepStrictEqual(
        result.value.messagesToSummarise.content.map((message) => message.role),
        ["user"]
      )
      assert.deepStrictEqual(
        result.value.retained.content.map((message) => message.role),
        ["assistant", "tool", "assistant", "user"]
      )
      assert.strictEqual(result.value.coveredThrough, 1)
      assert.strictEqual(result.value.firstKept, 1)
      assert.isTrue(result.value.splitTurn)
      assert.deepStrictEqual(result.value.previous, Option.some("prior"))
      assert.deepStrictEqual(result.value.tokensBefore, Option.some(120))
      assert.deepStrictEqual(result.value.tokensRetained, Option.some(40))
    }
  })

  it("refuses an empty foldable span", () => {
    assert.isTrue(Option.isNone(prepare({
      messages: transcript.content,
      previous: Option.none<string>(),
      previouslyCovered: 3,
      rawBoundary: 3
    })))
  })

  it("leaves token measurements absent when the policy did not make them", () => {
    const result = prepare({
      messages: transcript.content,
      previous: Option.none<string>(),
      previouslyCovered: 0,
      rawBoundary: 4
    })
    assert.isTrue(Option.isSome(result))
    if (Option.isSome(result)) {
      assert.isTrue(Option.isNone(result.value.tokensBefore))
      assert.isTrue(Option.isNone(result.value.tokensRetained))
      assert.isFalse(result.value.splitTurn)
    }
  })
})
