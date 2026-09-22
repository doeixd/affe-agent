/**
 * Control plane §10, wired: the product can say which of a person's sessions
 * exist and which are running work now -- the Phase 1 acceptance's "see
 * currently running/blocked sessions" -- from the kernel's `SessionDirectory`
 * kept current by the server, and nobody sees anyone else's.
 */
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Context, DateTime, Effect, Fiber, Layer, Option, Schedule } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AgentProtocol } from "affe-agent/client"
import { SessionDirectory } from "affe-agent/sessions"
import type * as Conversation from "../src/domain/Conversation.js"
import { AgentId, AgentRevisionId, ConversationId, UserId } from "../src/domain/WorkbenchIds.js"
import * as AgentDirectory from "../src/runtime/AgentDirectory.js"
import * as ConversationSessions from "../src/runtime/ConversationSessions.js"
import { sessionIdOf } from "../src/runtime/ConversationSessions.js"
import { tokens } from "../src/server/Authentication.js"
import { buildReply, serve } from "../src/server/app.js"
import * as AgentRegistry from "../src/store/AgentRegistry.js"
import * as ConversationStore from "../src/store/ConversationStore.js"
import * as HttpStores from "../src/store/http.js"
import * as SessionIndex from "../src/store/SessionIndex.js"

const ada = UserId.make("ada")
const grace = UserId.make("grace")

const conversation = (id: string, ownerId: UserId): Conversation.Record => ({
  id: ConversationId.make(id),
  ownerId,
  agentId: AgentId.make("builder"),
  agentRevisionId: AgentRevisionId.make("builder@2"),
  sessionId: sessionIdOf(ConversationId.make(id)),
  workspaceId: Option.none(),
  title: id,
  archived: false,
  createdAt: DateTime.makeUnsafe(0),
  updatedAt: DateTime.makeUnsafe(0)
})

const running: SessionDirectory.Stats = {
  ...SessionDirectory.emptyStats,
  started: true,
  activeSubmission: Option.some(AgentProtocol.SubmissionId.make("s1"))
}

describe("session index", () => {
  it("a session that is not a conversation has no summary", () => {
    const entry: SessionDirectory.Entry = {
      sessionId: AgentProtocol.SessionId.make("not-a-conversation"),
      name: Option.none(),
      namespace: "",
      attributes: {},
      stats: SessionDirectory.emptyStats,
      createdAt: 0,
      updatedAt: 0
    }
    assert.isTrue(Option.isNone(SessionIndex.summaryOf(entry)))
  })

  it.effect("indexing names the agent, and `active` is the owner's running sessions alone", () =>
    Effect.scoped(Effect.gen(function*() {
      const index = Context.get(yield* Layer.build(SessionIndex.memory), SessionIndex.SessionIndex)
      const adasIdle = conversation("adas-idle", ada)
      const adasBusy = conversation("adas-busy", ada)
      const gracesBusy = conversation("graces-busy", grace)
      for (const record of [adasIdle, adasBusy, gracesBusy]) yield* SessionIndex.index(index, record)

      // Indexed before any event: present, idle, and already naming its agent.
      const fresh = yield* SessionIndex.summary(index, adasIdle)
      assert.isTrue(Option.isSome(fresh))
      if (Option.isSome(fresh)) {
        assert.isFalse(fresh.value.active)
        assert.deepStrictEqual(fresh.value.agentId, Option.some(AgentId.make("builder")))
        assert.deepStrictEqual(fresh.value.agentRevisionId, Option.some(AgentRevisionId.make("builder@2")))
      }

      // What the follower does: stats written through for two of them.
      yield* index.record(AgentProtocol.SessionId.make(adasBusy.sessionId), running)
      yield* index.record(AgentProtocol.SessionId.make(gracesBusy.sessionId), running)

      const adas = yield* SessionIndex.active(index, ada)
      assert.deepStrictEqual(adas.map((summary) => summary.conversationId), [adasBusy.id])
      const graces = yield* SessionIndex.active(index, grace)
      assert.deepStrictEqual(graces.map((summary) => summary.conversationId), [gracesBusy.id])

      // Indexing again, after events, resets nothing.
      yield* SessionIndex.index(index, adasBusy)
      const kept = yield* SessionIndex.summary(index, adasBusy)
      assert.isTrue(Option.isSome(kept) && kept.value.active)
    })))

  it.effect("a record whose stats are written before it is indexed still lands under its owner", () =>
    Effect.scoped(Effect.gen(function*() {
      const index = Context.get(yield* Layer.build(SessionIndex.memory), SessionIndex.SessionIndex)
      const record = conversation("early", ada)
      yield* index.record(AgentProtocol.SessionId.make(record.sessionId), running)
      assert.deepStrictEqual(yield* SessionIndex.active(index, ada), [])
      yield* SessionIndex.index(index, record)
      assert.deepStrictEqual((yield* SessionIndex.active(index, ada)).map((summary) => summary.conversationId), [record.id])
    })))
})

// -- Over a real server ---------------------------------------------------------------

const port = 8789
const people = tokens({ "ada-token": "ada", "grace-token": "grace" })

const tempDatabase = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "workbench-index-")), "index.db")),
  (file) => Effect.sync(() => NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true }))
)

const load = (token: string) => {
  const server = { baseUrl: `http://localhost:${port}`, token }
  return Effect.map(
    Layer.build(
      ConversationSessions.layer.pipe(
        Layer.provideMerge(AgentDirectory.http(server)),
        Layer.provideMerge(Layer.mergeAll(HttpStores.conversationStore(server), HttpStores.agentRegistry(server))),
        Layer.provideMerge(FetchHttpClient.layer)
      )
    ),
    (context) => ({
      sessions: Context.get(context, ConversationSessions.ConversationSessions),
      registry: Context.get(context, AgentRegistry.AgentRegistry),
      store: Context.get(context, ConversationStore.ConversationStore),
      summary: (id: ConversationId) => Effect.provide(HttpStores.sessionSummary(server, id), FetchHttpClient.layer),
      active: Effect.provide(HttpStores.activeSessions(server), FetchHttpClient.layer)
    })
  )
}

const summaryOf = (found: Option.Option<SessionIndex.Summary>) =>
  Option.match(found, {
    onNone: () => Effect.die("the conversation's session is not indexed"),
    onSome: Effect.succeed
  })

/** The index lags the session by the follower's write; wait for it to say so. */
const until = <A>(read: Effect.Effect<A, unknown>, ok: (value: A) => boolean) =>
  read.pipe(
    Effect.repeat({ until: ok, schedule: Schedule.spaced("50 millis") }),
    Effect.timeout("10 seconds")
  )

describe("session index over the server", () => {
  it.live("the server keeps the index current, and a blocked session is a running one", () =>
    Effect.scoped(Effect.gen(function*() {
      yield* Layer.build(serve({ port, database: yield* tempDatabase }).pipe(Layer.provide(people)))
      const page = yield* load("ada-token")
      const other = yield* load("grace-token")
      const [agent] = yield* page.registry.list(ada)
      if (agent === undefined) return yield* Effect.die("no seeded agent")

      const { conversation, session } = yield* page.sessions.create({ ownerId: ada, agentId: agent.id, title: "Indexed" })

      // Indexed at creation: idle, on the right agent, and only for its owner.
      const fresh = yield* summaryOf(yield* page.summary(conversation.id))
      assert.isFalse(fresh.active)
      assert.strictEqual(fresh.stats.turns, 0)
      assert.deepStrictEqual(fresh.agentId, Option.some(agent.id))
      assert.deepStrictEqual(fresh.agentRevisionId, Option.some(conversation.agentRevisionId))
      assert.isTrue(Option.isNone(yield* other.summary(conversation.id)))

      // One exchange: the follower folds it into the stats.
      const reply = yield* session.prompt("build it")
      assert.strictEqual(reply.text, buildReply)
      const after = yield* until(page.summary(conversation.id), (found) => Option.isSome(found) && found.value.stats.turns > 0)
      const done = yield* summaryOf(after)
      assert.isFalse(done.active)
      assert.strictEqual(done.stats.submissions.completed, 1)
      assert.isAtLeast(done.stats.tools.succeeded, 1)

      // Blocked on an approval: running, so listed as active -- for its owner.
      const blocked = yield* Effect.forkChild(session.prompt("clean up"))
      const question = yield* session.pending.pipe(
        Effect.repeat({ until: (pending) => pending.length > 0 }),
        Effect.map((pending) => pending[0]?.id ?? ""),
        Effect.timeout("10 seconds")
      )
      const active = yield* until(page.active, (found) => found.length > 0)
      assert.deepStrictEqual(active.map((summary) => summary.conversationId), [conversation.id])
      assert.deepStrictEqual(yield* other.active, [])

      assert.isTrue(yield* session.respond({ id: question, granted: true }))
      yield* Fiber.join(blocked)
      const settled = yield* until(page.active, (found) => found.length === 0)
      assert.deepStrictEqual(settled, [])
      const final = yield* summaryOf(yield* page.summary(conversation.id))
      assert.strictEqual(final.stats.submissions.completed, 2)
    })), 60_000)
})
