/**
 * Choosing a model (W2 model picker), over a real server. A conversation's
 * model is pinned like its revision: chosen when it starts, recorded, and
 * never changed under it. Another model is a branch that continues from
 * where the conversation is. A model the deployment does not bind is
 * refused before anything is made.
 */
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Option } from "effect"
import type { Prompt } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import { ConversationId, UserId } from "../src/domain/WorkbenchIds.js"
import * as AgentDirectory from "../src/runtime/AgentDirectory.js"
import * as ConversationSessions from "../src/runtime/ConversationSessions.js"
import { tokens } from "../src/server/Authentication.js"
import { alternateReply, buildReply, serve } from "../src/server/app.js"
import * as AgentRegistry from "../src/store/AgentRegistry.js"
import * as ConversationStore from "../src/store/ConversationStore.js"
import * as HttpStores from "../src/store/http.js"

const port = 8775
const ada = UserId.make("ada")

const assistantTexts = (history: Prompt.Prompt) =>
  history.content.flatMap((message) =>
    message.role === "assistant"
      ? [message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")]
      : []
  ).filter((text) => text !== "")

describe("choosing a model", () => {
  it.live("a conversation runs the model it chose, continues on another as a branch, and refuses one not offered", () =>
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
      const sessions = Context.get(context, ConversationSessions.ConversationSessions)
      const [agent] = yield* Context.get(context, AgentRegistry.AgentRegistry).list(ada)
      if (agent === undefined) return yield* Effect.die("no agent")

      // Chosen at the start, recorded, and run.
      const chosen = yield* sessions.create({ ownerId: ada, agentId: agent.id, title: "Alt", modelProfile: "alternate" })
      assert.deepStrictEqual(chosen.conversation.modelProfile, Option.some("alternate"))
      assert.strictEqual((yield* chosen.session.prompt("hello")).text, alternateReply)
      // Reopened, it is still that model.
      const reopened = yield* sessions.open(chosen.conversation.id)
      assert.strictEqual((yield* reopened.session.prompt("again")).text, alternateReply)

      // Not chosen: the agent's own.
      const own = yield* sessions.create({ ownerId: ada, agentId: agent.id, title: "Own" })
      assert.isTrue(Option.isNone(own.conversation.modelProfile))
      assert.strictEqual((yield* own.session.prompt("build it")).text, buildReply)

      // Continued on another model: everything so far, then the other model answers.
      const continued = yield* sessions.branch({ from: own.conversation.id, ordinal: 1, modelProfile: "alternate" })
      assert.deepStrictEqual(continued.conversation.modelProfile, Option.some("alternate"))
      assert.strictEqual(continued.conversation.agentRevisionId, own.conversation.agentRevisionId)
      assert.strictEqual((yield* continued.session.prompt("and now?")).text, alternateReply)
      assert.deepStrictEqual(assistantTexts(yield* continued.session.history), [buildReply, alternateReply])
      // The source is still on its own model, and untouched.
      assert.deepStrictEqual(assistantTexts(yield* own.session.history), [buildReply])

      // A branch without a model keeps the source's.
      const kept = yield* sessions.branch({ from: chosen.conversation.id, ordinal: 2 })
      assert.deepStrictEqual(kept.conversation.modelProfile, Option.some("alternate"))

      // A model the deployment does not bind is refused, and nothing is made.
      const store = Context.get(context, ConversationStore.ConversationStore)
      const count = (yield* store.list({ ownerId: ada })).length
      const refused = yield* Effect.flip(sessions.create({ ownerId: ada, agentId: agent.id, title: "Nope", modelProfile: "nope" }))
      assert.strictEqual(refused._tag, "WorkbenchStorageError")
      assert.strictEqual((yield* store.list({ ownerId: ada })).length, count)
    })), 60_000)
})

describe("a conversation stored before models could be chosen", () => {
  it.effect("decodes as running its agent's own model", () =>
    Effect.scoped(Effect.gen(function*() {
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "workbench-old-conversation-"))),
        (dir) => Effect.sync(() => NodeFs.rmSync(dir, { recursive: true, force: true }))
      )
      const context = yield* Layer.build(
        ConversationStore.layerSql.pipe(Layer.provideMerge(SqliteClient.layer({ filename: NodePath.join(directory, "old.db") })))
      )
      const client = Context.get(context, SqlClient.SqlClient)
      // The body as the store wrote it on 2026-09-22: no modelProfile key.
      const body = JSON.stringify({
        id: "old",
        ownerId: "ada",
        agentId: "a",
        agentRevisionId: "a@1",
        sessionId: "conversation-old",
        workspaceId: { _tag: "None" },
        title: "Old",
        archived: false,
        createdAt: "2026-09-22T00:00:00.000Z",
        updatedAt: "2026-09-22T00:00:00.000Z"
      })
      yield* client`INSERT INTO workbench_conversations (id, owner_id, archived, updated_at, body) VALUES (${"old"}, ${"ada"}, ${0}, ${0}, ${body})`
      const found = yield* Context.get(context, ConversationStore.ConversationStore).get(ConversationId.make("old"))
      assert.deepStrictEqual(Option.map(found, (record) => record.modelProfile), Option.some(Option.none()))
    })))
})
