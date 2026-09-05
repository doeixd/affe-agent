import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as fs from "node:fs"
import * as AgentInput from "../src/AgentInput.js"
import * as AgentProtocol from "../src/client/AgentProtocol.js"

/**
 * The wire carries one shape (`plan-input-default.md` step 3), and the
 * promise that came with it: an untyped client's request is byte for byte
 * what it was when `Input` was a union of a tagged typed value and the
 * prompt wire.
 *
 * `fixtures/prompt-request.json` was recorded from the commit before the
 * union went (`4ee770d`), with `AgentProtocol.PromptRequest` encoded through
 * `Schema.toCodecJson` exactly as every adapter encodes it: a text prompt,
 * and a multimodal one with a file part, so the base64 path is covered.
 * A change to this file's expectation is a wire change and should be
 * treated as one.
 */

const fixture = JSON.parse(fs.readFileSync("test/fixtures/prompt-request.json", "utf8")) as {
  readonly text: unknown
  readonly messages: unknown
}

describe("the input wire", () => {
  const encode = Schema.encodeEffect(Schema.toCodecJson(AgentProtocol.PromptRequest))

  it.effect("an untyped client's request is byte-identical to the recorded one", () =>
    Effect.gen(function* () {
      const text = yield* encode({
        requestId: AgentProtocol.RequestId.make("r-1"),
        sessionId: AgentProtocol.SessionId.make("s-1"),
        input: AgentProtocol.input("hello, world")
      })
      assert.strictEqual(JSON.stringify(text), JSON.stringify(fixture.text))

      const messages = yield* encode({
        requestId: AgentProtocol.RequestId.make("r-2"),
        sessionId: AgentProtocol.SessionId.make("s-1"),
        input: AgentProtocol.input([
          {
            role: "user",
            content: [
              { type: "text", text: "look at this" },
              { type: "file", mediaType: "text/plain", data: new TextEncoder().encode("bytes!") }
            ]
          }
        ]),
        options: { stream: true }
      })
      assert.strictEqual(JSON.stringify(messages), JSON.stringify(fixture.messages))
    })
  )

  it("a declared input's value travels bare, and a raw prompt is told from it", () => {
    const value = { customerId: "c-42", body: "my order is late" }
    assert.deepStrictEqual(AgentProtocol.input(value), value)
    assert.isFalse(AgentInput.isRaw(value))
    assert.isTrue(AgentInput.isRaw("hello"))
    assert.isTrue(AgentInput.isRaw([{ role: "user", content: "hi" }]))
    // The encoded prompt itself is not raw: it is already the wire form, and
    // passes through untouched -- which is what lets an alarm or a job carry
    // it without knowing which kind it holds.
    const wire = Schema.encodeSync(AgentInput.prompt.schema)("hello")
    assert.isFalse(AgentInput.isRaw(wire))
    assert.deepStrictEqual(AgentProtocol.input(wire), wire)
  })

  it.effect("a prompt already in wire form decodes as the same prompt", () =>
    Effect.gen(function* () {
      // The alarm and job stores carry the encoded form; when it comes back
      // through the request codec it must be the prompt it was, not a value
      // the host then refuses as "not a prompt".
      const wire = Schema.encodeSync(AgentInput.prompt.schema)("hello")
      const decoded = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(AgentProtocol.PromptRequest))({
        requestId: "r-3",
        sessionId: "s-1",
        input: wire
      })
      assert.isTrue(AgentInput.isRaw(decoded.input))
    })
  )
})
