import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { PromptWire } from "../src/index.js"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false
type Assert<T extends true> = T
type IsAny<T> = 0 extends 1 & T ? true : false
type Not<T extends boolean> = T extends true ? false : true

type PromptWireTypeIsPrompt = Assert<Equal<typeof PromptWire.Prompt.Type, Prompt.Prompt>>
type PromptWireTypeIsNotAny = Assert<Not<IsAny<typeof PromptWire.Prompt.Type>>>
type MessageWireTypeIsMessage = Assert<Equal<typeof PromptWire.Message.Type, Prompt.Message>>

const inferenceProof: readonly [
  PromptWireTypeIsPrompt,
  PromptWireTypeIsNotAny,
  MessageWireTypeIsMessage
] = [true, true, true]

const multimodal = Prompt.make([
  Prompt.makeMessage("user", {
    content: [
      Prompt.textPart({ text: "compare these inputs" }),
      Prompt.filePart({
        mediaType: "text/plain",
        fileName: "literal.txt",
        data: "SGVsbG8="
      }),
      Prompt.filePart({
        mediaType: "application/octet-stream",
        fileName: "bytes.bin",
        data: new Uint8Array([0, 1, 2, 254, 255])
      }),
      Prompt.filePart({
        mediaType: "image/png",
        fileName: "remote.png",
        data: new URL("https://example.com/assets/image.png?size=large")
      })
    ]
  })
])

const fileParts = (prompt: Prompt.Prompt): ReadonlyArray<Prompt.FilePart> =>
  prompt.content.flatMap((message) =>
    message.role === "user" || message.role === "assistant"
      ? message.content.flatMap((part) => part.type === "file" ? [part] : [])
      : []
  )

describe("PromptWire", () => {
  it.effect("round-trips every file-data runtime variant through JSON", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(inferenceProof, [true, true, true])
      const encoded = yield* Schema.encodeEffect(PromptWire.Prompt)(multimodal)
      const json = JSON.stringify(encoded)

      assert.include(json, '"_tag":"String"')
      assert.include(json, '"_tag":"Bytes"')
      assert.include(json, '"base64":"AAEC/v8="')
      assert.include(json, '"_tag":"Url"')

      const decoded = yield* Schema.decodeUnknownEffect(PromptWire.Prompt)(
        JSON.parse(json)
      )
      type DecodedIsPrompt = Assert<Equal<typeof decoded, Prompt.Prompt>>

      const files = fileParts(decoded)
      assert.strictEqual(files.length, 3)
      assert.strictEqual(files[0]!.data, "SGVsbG8=")
      assert.instanceOf(files[1]!.data, Uint8Array)
      assert.deepStrictEqual(Array.from(files[1]!.data), [0, 1, 2, 254, 255])
      assert.instanceOf(files[2]!.data, URL)
      assert.strictEqual(
        files[2]!.data.toString(),
        "https://example.com/assets/image.png?size=large"
      )
    })
  )

  it.effect("uses the same representation for standalone messages", () =>
    Effect.gen(function* () {
      const message = multimodal.content[0]!
      const encoded = yield* Schema.encodeEffect(PromptWire.Message)(message)
      const decoded = yield* Schema.decodeUnknownEffect(PromptWire.Message)(
        JSON.parse(JSON.stringify(encoded))
      )
      assert.deepStrictEqual(
        fileParts(Prompt.fromMessages([decoded])).map((part) => part.data),
        fileParts(multimodal).map((part) => part.data)
      )
    })
  )

  it.effect("reads legacy strings but rejects malformed tagged file data", () =>
    Effect.gen(function* () {
      const legacy = yield* Schema.decodeUnknownEffect(PromptWire.Prompt)({
        content: [{
          role: "user",
          content: [{
            type: "file",
            mediaType: "text/plain",
            data: "SGVsbG8="
          }]
        }]
      })
      assert.strictEqual(fileParts(legacy)[0]?.data, "SGVsbG8=")

      const malformed = yield* Effect.flip(
        Schema.decodeUnknownEffect(PromptWire.Prompt)({
          content: [{
            role: "user",
            content: [{
              type: "file",
              mediaType: "application/octet-stream",
              data: { _tag: "Bytes", base64: "not base64!" }
            }]
          }]
        })
      )
      assert.include(malformed.message, "Base64")
    })
  )
})
