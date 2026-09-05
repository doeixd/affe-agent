import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as fs from "node:fs"
import * as Agent from "../src/Agent.js"
import * as AgentInput from "../src/AgentInput.js"
import * as AgentProtocol from "../src/client/AgentProtocol.js"
import { AgentClient } from "../src/client/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

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

/**
 * `fixtures/prompt-response.json` was recorded from `baf0897`, before
 * `plan-input-default.md` step 5 gave every agent a `Value`: an untyped
 * agent answering "the answer" through the in-process client, encoded as
 * `AgentProtocol.PromptResponse`. The change to the wire is exactly one
 * added field, `value`, carrying the text -- and that is what is asserted,
 * so a second difference would be a second wire change and would show.
 */
const response = JSON.parse(fs.readFileSync("test/fixtures/prompt-response.json", "utf8")) as {
  readonly requestId: string
  readonly result: Record<string, unknown>
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

describe("the result wire", () => {
  it.effect("an untyped agent's response is the recorded one plus `value`, and nothing else moved", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("the answer")])
      const result = yield* Effect.gen(function* () {
        const client = yield* AgentClient.AgentClient
        const session = yield* client.createSession({ sessionId: "s-1" })
        return yield* session.prompt("hello")
      }).pipe(
        Effect.scoped,
        Effect.provide(AgentClient.layer(Agent.make({ instructions: "x" }))),
        Effect.provide(layer)
      )
      const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(AgentProtocol.PromptResponse))({
        requestId: AgentProtocol.RequestId.make("r-1"),
        result
      })
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(encoded)),
        { ...response, result: { ...response.result, value: "the answer" } }
      )
    })
  )
})
