/**
 * Feedback on replies (W2 `FeedbackStore`): the store's contract on both
 * backends, and over a server, a rating is its owner's to give and read.
 */
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Option } from "effect"
import type { Scope } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import type { HttpClient } from "effect/unstable/http"
import { ConversationId, UserId } from "../src/domain/WorkbenchIds.js"
import * as AgentDirectory from "../src/runtime/AgentDirectory.js"
import * as ConversationSessions from "../src/runtime/ConversationSessions.js"
import { tokens } from "../src/server/Authentication.js"
import { serve } from "../src/server/app.js"
import * as AgentRegistry from "../src/store/AgentRegistry.js"
import * as FeedbackStore from "../src/store/FeedbackStore.js"
import * as HttpStores from "../src/store/http.js"

const ada = UserId.make("ada")
const grace = UserId.make("grace")
const c1 = ConversationId.make("c1")

const tempFile = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "workbench-feedback-")), "f.db")),
  (file) => Effect.sync(() => NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true }))
)

const backends: ReadonlyArray<readonly [string, Effect.Effect<Layer.Layer<FeedbackStore.FeedbackStore>, never, Scope.Scope>]> = [
  ["memory", Effect.succeed(FeedbackStore.memory)],
  ["sqlite", Effect.map(tempFile, (file) => FeedbackStore.layerSql.pipe(Layer.provide(SqliteClient.layer({ filename: file }))))]
]

const entry = (messageIndex: number, by: UserId, rating: FeedbackStore.Rating): FeedbackStore.Entry => ({
  conversationId: c1,
  messageIndex,
  by,
  rating,
  note: Option.none(),
  at: 0
})

for (const [name, backend] of backends) {
  describe(`feedback store (${name})`, () => {
    it.effect("one rating per person per message: set, replaced, cleared, listed by index", () =>
      Effect.scoped(Effect.gen(function*() {
        const store = Context.get(yield* Layer.build(yield* backend), FeedbackStore.FeedbackStore)
        yield* store.set(entry(3, ada, "up"))
        yield* store.set(entry(1, ada, "down"))
        yield* store.set(entry(3, grace, "down"))
        yield* store.set({ ...entry(3, ada, "down"), note: Option.some("wrong file") })
        const adas = yield* store.list(c1, ada)
        assert.deepStrictEqual(adas.map((e) => [e.messageIndex, e.rating]), [[1, "down"], [3, "down"]])
        assert.deepStrictEqual(adas[1]?.note, Option.some("wrong file"))
        assert.deepStrictEqual(FeedbackStore.ratingAt(adas, 3), Option.some("down"))
        assert.isTrue(Option.isNone(FeedbackStore.ratingAt(adas, 2)))
        yield* store.clear(c1, 3, ada)
        yield* store.clear(c1, 9, ada)
        assert.deepStrictEqual((yield* store.list(c1, ada)).map((e) => e.messageIndex), [1])
        assert.deepStrictEqual((yield* store.list(c1, grace)).map((e) => e.rating), ["down"])
      })))
  })
}

const port = 8780

describe("feedback over the server", () => {
  it.live("a rating is given and read by the conversation's owner, and nobody else", () =>
    Effect.scoped(Effect.gen(function*() {
      yield* Layer.build(serve({ port, database: ":memory:" }).pipe(Layer.provide(tokens({ "ada-token": "ada", "grace-token": "grace" }))))
      const adas = { baseUrl: `http://localhost:${port}`, token: "ada-token" }
      const graces = { baseUrl: `http://localhost:${port}`, token: "grace-token" }
      const http = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) => Effect.provide(effect, FetchHttpClient.layer)
      const context = yield* Layer.build(
        ConversationSessions.layer.pipe(
          Layer.provideMerge(AgentDirectory.http(adas)),
          Layer.provideMerge(Layer.mergeAll(HttpStores.conversationStore(adas), HttpStores.agentRegistry(adas))),
          Layer.provideMerge(FetchHttpClient.layer)
        )
      )
      const sessions = Context.get(context, ConversationSessions.ConversationSessions)
      const [agent] = yield* Context.get(context, AgentRegistry.AgentRegistry).list(ada)
      if (agent === undefined) return yield* Effect.die("no agent")
      const { conversation } = yield* sessions.create({ ownerId: ada, agentId: agent.id, title: "Rated" })

      yield* http(HttpStores.rate(adas, conversation.id, 1, Option.some("up")))
      assert.deepStrictEqual(
        (yield* http(HttpStores.feedback(adas, conversation.id))).map((e) => [e.messageIndex, e.rating, e.by]),
        [[1, "up", ada]]
      )
      // Another person can neither read nor rate it: it answers as missing.
      assert.strictEqual((yield* Effect.flip(http(HttpStores.feedback(graces, conversation.id))))._tag, "WorkbenchStorageError")
      assert.strictEqual(
        (yield* Effect.flip(http(HttpStores.rate(graces, conversation.id, 1, Option.some("down")))))._tag,
        "WorkbenchStorageError"
      )
      yield* http(HttpStores.rate(adas, conversation.id, 1, Option.none()))
      assert.deepStrictEqual(yield* http(HttpStores.feedback(adas, conversation.id)), [])
    })), 30_000)
})
