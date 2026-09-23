/**
 * Attachments (W2) as pure functions: the caps refuse with a reason and
 * keep what fits, and a message with files becomes one user message whose
 * text comes first and whose files follow as file parts.
 */
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import { Prompt } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { UserId } from "../src/domain/WorkbenchIds.js"
import * as AgentDirectory from "../src/runtime/AgentDirectory.js"
import * as ConversationSessions from "../src/runtime/ConversationSessions.js"
import { tokens } from "../src/server/Authentication.js"
import { buildReply, serve } from "../src/server/app.js"
import * as AgentRegistry from "../src/store/AgentRegistry.js"
import * as HttpStores from "../src/store/http.js"
import * as Attachments from "../src/ui-core/Attachments.js"

const file = (fileName: string, bytes: number, mediaType = "text/plain"): Attachments.Attachment => ({
  fileName,
  mediaType,
  data: new Uint8Array(bytes).fill(65)
})

const limits: Attachments.Limits = { maxBytes: 10, maxFiles: 2 }

describe("attachments", () => {
  it("keeps what fits, and says why the rest did not", () => {
    const { attached, refused } = Attachments.add([], [file("a.txt", 4), file("big.bin", 11), file("empty.txt", 0), file("b.txt", 10)], limits)
    assert.deepStrictEqual(attached.map((f) => f.fileName), ["a.txt", "b.txt"])
    assert.deepStrictEqual(refused.map((r) => r._tag), ["TooLarge", "Empty"])
    const more = Attachments.add(attached, [file("c.txt", 1)], limits)
    assert.deepStrictEqual(more.attached.map((f) => f.fileName), ["a.txt", "b.txt"])
    assert.deepStrictEqual(more.refused, [{ _tag: "TooMany", count: 3, maxFiles: 2 }])
    assert.deepStrictEqual(refused.map(Attachments.describeRefusal), ["big.bin is 0.0 MB; the limit is 0.0 MB.", "empty.txt is empty."])
    assert.deepStrictEqual(more.refused.map(Attachments.describeRefusal), ["A message can carry 2 files at most."])
  })

  it("text alone stays a string; with files it is one user message, text first", () => {
    assert.strictEqual(Attachments.promptOf("hi", []), "hi")
    const prompt = Prompt.make(Attachments.promptOf("see attached", [file("notes.txt", 3), file("pic.png", 2, "image/png")]))
    assert.strictEqual(prompt.content.length, 1)
    const [message] = prompt.content
    assert.strictEqual(message?.role, "user")
    if (message?.role !== "user") return
    assert.deepStrictEqual(message.content.map((part) => part.type), ["text", "file", "file"])
    const files = message.content.filter((part) => part.type === "file")
    assert.deepStrictEqual(files.map((part) => [part.fileName, part.mediaType]), [["notes.txt", "text/plain"], ["pic.png", "image/png"]])
    // Files without text: no empty text part.
    const bare = Prompt.make(Attachments.promptOf("", [file("only.txt", 1)]))
    assert.deepStrictEqual(bare.content[0]?.role === "user" ? bare.content[0].content.map((part) => part.type) : [], ["file"])
    assert.strictEqual(Attachments.mediaTypeOf(""), "application/octet-stream")
    assert.strictEqual(Attachments.mediaTypeOf("image/png"), "image/png")
  })
})

const port = 8779
const ada = UserId.make("ada")

describe("attachments over the server", () => {
  it.live("a file sent with a message is in the durable session's history, byte for byte", () =>
    Effect.scoped(Effect.gen(function*() {
      yield* Layer.build(serve({ port, database: ":memory:" }).pipe(Layer.provide(tokens({ "ada-token": "ada" }))))
      const server = { baseUrl: `http://localhost:${port}`, token: "ada-token" }
      const context = yield* Layer.build(
        ConversationSessions.layer.pipe(
          Layer.provideMerge(AgentDirectory.http(server)),
          Layer.provideMerge(Layer.mergeAll(HttpStores.conversationStore(server), HttpStores.agentRegistry(server))),
          Layer.provideMerge(FetchHttpClient.layer)
        )
      )
      const [agent] = yield* Context.get(context, AgentRegistry.AgentRegistry).list(ada)
      if (agent === undefined) return yield* Effect.die("no agent")
      const { session } = yield* Context.get(context, ConversationSessions.ConversationSessions)
        .create({ ownerId: ada, agentId: agent.id, title: "Files" })
      const bytes = new Uint8Array([0, 1, 2, 250, 255])
      const reply = yield* session.prompt(
        Attachments.promptOf("see attached", [{ fileName: "raw.bin", mediaType: "application/octet-stream", data: bytes }])
      )
      assert.strictEqual(reply.text, buildReply)
      const history = yield* session.history
      const sent = history.content
        .filter((message) => message.role === "user")
        .flatMap((message) => message.content)
        .filter((part) => part.type === "file")
      assert.strictEqual(sent.length, 1)
      const [part] = sent
      assert.strictEqual(part?.fileName, "raw.bin")
      // Over the wire the bytes come back as base64 -- a form a file part allows and providers take.
      const data = part?.data
      const received = data instanceof Uint8Array
        ? [...data]
        : typeof data === "string"
        ? [...atob(data)].map((char) => char.charCodeAt(0))
        : data
      assert.deepStrictEqual(received, [...bytes])
    })), 30_000)
})
