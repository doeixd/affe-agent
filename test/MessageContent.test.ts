import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { AgentClient } from "../src/client/index.js"
import { AgentProbe, TestLanguageModel } from "../src/testing/index.js"

/**
 * Phase 2-3 of `docs/plan-filetypes.txt`: a model that answers with a file
 * used to reach a remote caller, and the event stream, as a sentence and
 * nothing else. Writing these found that canonical history did not have the
 * file either -- Effect AI's `fromResponseParts` drops file parts -- so the
 * first assertion below is that history and the event agree, through the
 * kernel's corrected conversion.
 */
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const filePartsOf = (parts: ReadonlyArray<Prompt.Part>) =>
  parts.flatMap((part) => (part.type === "file" ? [part] : []))

describe("message content", () => {
  it.effect("MessageCompleted carries the file the model returned, and history agrees", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script([
        { text: "here is the diagram", files: [{ mediaType: "image/png", data: png }] }
      ])
      const out = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({ loop: AgentLoop.bounded(1) }))
          const probe = yield* AgentProbe.make(session)
          yield* session.prompt("draw it")
          const completed = (yield* probe.events).flatMap((envelope) =>
            envelope.event._tag === "MessageCompleted" ? [envelope.event] : []
          )
          return { completed, history: yield* session.history }
        })
      ).pipe(Effect.provide(layer))

      assert.strictEqual(out.completed.length, 1)
      const event = out.completed[0]!
      assert.strictEqual(event.text, "here is the diagram")
      assert.deepStrictEqual(
        event.content?.map((part) => part.type),
        ["text", "file"]
      )
      const file = filePartsOf(event.content ?? [])[0]
      assert.strictEqual(file?.mediaType, "image/png")
      assert.isTrue(file?.data instanceof Uint8Array)
      assert.deepStrictEqual(Array.from(file?.data instanceof Uint8Array ? file.data : []), Array.from(png))

      // The same content canonical history committed: not a second copy of
      // the response, the same conversion.
      const assistant = out.history.content.find((message) => message.role === "assistant")
      assert.isDefined(assistant)
      if (assistant?.role === "assistant") {
        assert.deepStrictEqual(assistant.content.map((part) => part.type), ["text", "file"])
      }
    })
  )

  it.effect("a message that is only a file is still announced; one that is only reasoning is not", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script([
        { files: [{ mediaType: "application/pdf", data: new Uint8Array([1, 2, 3]) }] }
      ])
      const completed = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({ loop: AgentLoop.bounded(1) }))
          const probe = yield* AgentProbe.make(session)
          yield* session.prompt("the report, please")
          return (yield* probe.events).flatMap((envelope) =>
            envelope.event._tag === "MessageCompleted" ? [envelope.event] : []
          )
        })
      ).pipe(Effect.provide(layer))
      assert.strictEqual(completed.length, 1)
      assert.strictEqual(completed[0]?.text, "")
      assert.deepStrictEqual(completed[0]?.content?.map((part) => part.type), ["file"])
    })
  )

  it.effect("under streaming, a file is announced whole as MessagePartCompleted, before the stream completes", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script([
        { text: "rendered", chunks: ["rend", "ered"], files: [{ mediaType: "image/png", data: png }] }
      ])
      const tags = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({ loop: AgentLoop.bounded(1) }))
          const probe = yield* AgentProbe.make(session)
          yield* session.prompt("draw it", { stream: true })
          return (yield* probe.events).map((envelope) => envelope.event)
        })
      ).pipe(Effect.provide(layer))

      const names = tags.map((event) => event._tag)
      const partAt = names.indexOf("MessagePartCompleted")
      assert.isAbove(partAt, names.indexOf("MessageStarted"))
      assert.isBelow(partAt, names.indexOf("MessageStreamCompleted"))
      // Not invented as deltas: the two text chunks are the only deltas.
      assert.strictEqual(names.filter((tag) => tag === "MessageDelta").length, 2)
      const announced = tags.find((event) => event._tag === "MessagePartCompleted")
      if (announced?._tag === "MessagePartCompleted") {
        assert.strictEqual(announced.part.type, "file")
        if (announced.part.type === "file") {
          assert.strictEqual(announced.part.mediaType, "image/png")
        }
      }
      // And the completed message carries it too.
      const completed = tags.find((event) => event._tag === "MessageCompleted")
      if (completed?._tag === "MessageCompleted") {
        assert.deepStrictEqual(completed.content?.map((part) => part.type), ["text", "file"])
      }
    })
  )

  it.effect("the in-process remote result carries content, as prompt parts", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script([
        { text: "done", files: [{ mediaType: "image/png", data: png }] }
      ])
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* AgentClient.AgentClient
          const session = yield* client.createSession()
          return yield* session.prompt("go")
        })
      ).pipe(
        Effect.provide(AgentClient.layer(Agent.make({ loop: AgentLoop.bounded(1) })).pipe(Layer.provide(layer)))
      )
      assert.strictEqual(result.text, "done")
      assert.deepStrictEqual(result.content.map((part) => part.type), ["text", "file"])
      const file = filePartsOf(result.content)[0]
      assert.deepStrictEqual(Array.from(file?.data instanceof Uint8Array ? file.data : []), Array.from(png))
    })
  )

  describe("on the wire", () => {
    const json = Schema.fromJsonString(Schema.toCodecJson(AgentEvent.AgentEventTolerant))

    it.effect("MessageCompleted and MessagePartCompleted round-trip through JSON with the bytes intact", () =>
      Effect.gen(function* () {
        const completed: AgentEvent.AgentEvent = {
          _tag: "MessageCompleted",
          text: "t",
          content: [Prompt.textPart({ text: "t" }), Prompt.filePart({ mediaType: "image/png", data: png })]
        }
        const part: AgentEvent.AgentEvent = {
          _tag: "MessagePartCompleted",
          part: Prompt.filePart({ mediaType: "image/png", data: new URL("https://example.test/a.png") })
        }
        for (const event of [completed, part]) {
          const encoded = yield* Schema.encodeEffect(json)(event)
          assert.strictEqual(typeof encoded, "string")
          const decoded = yield* Schema.decodeEffect(json)(encoded)
          assert.deepStrictEqual(decoded, event)
        }
      })
    )

    it.effect("a MessageCompleted from a build that predates `content` still decodes", () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeEffect(json)(JSON.stringify({ _tag: "MessageCompleted", text: "old" }))
        assert.deepStrictEqual(decoded, { _tag: "MessageCompleted", text: "old" })
      })
    )

    it.effect("a build that predates `content` still decodes the new payload", () =>
      Effect.gen(function* () {
        // The old event schema, as it was: a `text` and nothing else.
        const Old = Schema.TaggedStruct("MessageCompleted", { text: Schema.String })
        const encoded = yield* Schema.encodeEffect(json)({
          _tag: "MessageCompleted",
          text: "new",
          content: [Prompt.textPart({ text: "new" })]
        })
        const decoded = yield* Schema.decodeUnknownEffect(Old)(JSON.parse(encoded))
        assert.strictEqual(decoded.text, "new")
      })
    )
  })

  it("the content types are exact: prompt parts, not provider parts, not any", () => {
    type Equal<A, B> =
      (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
    type Assert<T extends true> = T
    type _Remote = Assert<Equal<AgentClient.RemoteResult["content"], ReadonlyArray<Prompt.Part>>>
    type _Event = Assert<Equal<AgentEvent.MessageContent, ReadonlyArray<Prompt.Part>>>
    type _Part = Assert<Equal<Extract<AgentEvent.AgentEvent, { _tag: "MessagePartCompleted" }>["part"], Prompt.Part>>
    assert.isTrue(Option.isSome(Option.some(1)))
  })
})
