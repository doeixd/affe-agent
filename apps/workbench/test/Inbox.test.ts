/**
 * The Needs You inbox (control plane §11): the store's contract on both
 * backends, the projection's three rules against a hand-made event stream,
 * and -- over a real server -- a question an agent asks appearing in its
 * owner's inbox alone and leaving when answered.
 */
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer, Option, Schedule, Stream } from "effect"
import type { Scope } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import type { AgentEvent } from "affe-agent"
import { AgentProtocol } from "affe-agent/client"
import { AgentId, AgentRevisionId, ConversationId, UserId } from "../src/domain/WorkbenchIds.js"
import * as AgentDirectory from "../src/runtime/AgentDirectory.js"
import * as ConversationSessions from "../src/runtime/ConversationSessions.js"
import { sessionIdOf } from "../src/runtime/ConversationSessions.js"
import * as InboxProjection from "../src/runtime/InboxProjection.js"
import { tokens } from "../src/server/Authentication.js"
import { serve } from "../src/server/app.js"
import * as AgentRegistry from "../src/store/AgentRegistry.js"
import * as ConversationStore from "../src/store/ConversationStore.js"
import * as HttpStores from "../src/store/http.js"
import * as InboxStore from "../src/store/InboxStore.js"

const ada = UserId.make("ada")
const grace = UserId.make("grace")

const item = (sessionId: string, id: string, ownerId: UserId, createdAt: number): InboxStore.Item => ({
  id,
  sessionId,
  conversationId: ConversationId.make(sessionId),
  ownerId,
  kind: "tool-approval",
  detail: { tool: "deleteEverything" },
  createdAt
})

const tempFile = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "workbench-inbox-")), "inbox.db")),
  (file) => Effect.sync(() => NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true }))
)

const backends: ReadonlyArray<readonly [string, Effect.Effect<Layer.Layer<InboxStore.InboxStore>, never, Scope.Scope>]> = [
  ["memory", Effect.succeed(InboxStore.memory)],
  ["sqlite", Effect.map(tempFile, (file) => InboxStore.layerSql.pipe(Layer.provide(SqliteClient.layer({ filename: file }))))]
]

for (const [name, backend] of backends) {
  describe(`inbox store (${name})`, () => {
    it.effect("items are per owner, oldest first, idempotent, and settle by id or by session", () =>
      Effect.scoped(Effect.gen(function*() {
        const store = Context.get(yield* Layer.build(yield* backend), InboxStore.InboxStore)
        yield* store.put(item("s1", "q2", ada, 20))
        yield* store.put(item("s1", "q1", ada, 10))
        yield* store.put(item("s2", "q3", ada, 30))
        yield* store.put(item("s3", "q4", grace, 5))
        yield* store.put({ ...item("s1", "q1", ada, 99), kind: "replayed" })

        const adas = yield* store.listFor(ada)
        assert.deepStrictEqual(adas.map((found) => [found.sessionId, found.id, found.kind]), [
          ["s1", "q1", "tool-approval"],
          ["s1", "q2", "tool-approval"],
          ["s2", "q3", "tool-approval"]
        ])
        assert.deepStrictEqual(adas[0]?.detail, { tool: "deleteEverything" })
        assert.deepStrictEqual((yield* store.listFor(grace)).map((found) => found.id), ["q4"])

        yield* store.remove("s1", "q2")
        yield* store.remove("s1", "never-there")
        assert.deepStrictEqual((yield* store.listFor(ada)).map((found) => found.id), ["q1", "q3"])
        yield* store.clearSession("s1")
        assert.deepStrictEqual((yield* store.listFor(ada)).map((found) => found.id), ["q3"])
        assert.deepStrictEqual((yield* store.listFor(grace)).map((found) => found.id), ["q4"])
      })))
  })
}

// -- The projection -----------------------------------------------------------------

const conversation = ConversationId.make("c1")
const session = AgentProtocol.SessionId.make(sessionIdOf(conversation))
const stray = AgentProtocol.SessionId.make("not-a-conversation")

let sequence = 0
const envelope = (sessionId: AgentProtocol.SessionId, event: AgentEvent.StreamedEvent): AgentProtocol.HostEvent => ({
  _tag: "SessionEvent",
  envelope: {
    sessionId,
    submissionId: Option.some(AgentProtocol.SubmissionId.make("sub")),
    runId: Option.none(),
    turn: Option.none(),
    sequence: ++sequence,
    event
  }
})

describe("inbox projection", () => {
  it.effect("a request appears for the owner, settles when resolved, and everything settles when the submission does", () =>
    Effect.scoped(Effect.gen(function*() {
      const context = yield* Layer.build(Layer.mergeAll(InboxStore.memory, ConversationStore.memory))
      const inbox = Context.get(context, InboxStore.InboxStore)
      const conversations = Context.get(context, ConversationStore.ConversationStore)
      yield* conversations.create({
        id: conversation,
        ownerId: ada,
        agentId: AgentId.make("a"),
        agentRevisionId: AgentRevisionId.make("a@1"),
        sessionId: session,
        workspaceId: Option.none(),
        title: "C1"
      })
      const fold = (events: ReadonlyArray<AgentProtocol.HostEvent>) =>
        InboxProjection.follow(inbox, conversations, Stream.fromIterable(events))

      yield* fold([
        { _tag: "SessionHosted", sessionId: session },
        envelope(session, { _tag: "ElicitationRequested", id: "q1", kind: "tool-approval", detail: { tool: "rm" } }),
        envelope(session, { _tag: "ElicitationRequested", id: "q2", kind: "question", detail: "why?" }),
        // A session no conversation names asks nobody.
        envelope(stray, { _tag: "ElicitationRequested", id: "q9", kind: "tool-approval", detail: null })
      ])
      assert.deepStrictEqual((yield* inbox.listFor(ada)).map((found) => [found.id, found.kind, found.detail]), [
        ["q1", "tool-approval", { tool: "rm" }],
        ["q2", "question", "why?"]
      ])

      yield* fold([envelope(session, { _tag: "ElicitationResolved", id: "q1", kind: "tool-approval", granted: true })])
      assert.deepStrictEqual((yield* inbox.listFor(ada)).map((found) => found.id), ["q2"])

      // An interrupted run never resolves its question; the settled submission does.
      yield* fold([envelope(session, { _tag: "SubmissionInterrupted" })])
      assert.deepStrictEqual(yield* inbox.listFor(ada), [])
    })))
})

// -- Over a real server ---------------------------------------------------------------

const port = 8784
const people = tokens({ "ada-token": "ada", "grace-token": "grace" })

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
      inbox: Effect.provide(HttpStores.inbox(server), FetchHttpClient.layer)
    })
  )
}

const until = <A>(read: Effect.Effect<A, unknown>, ok: (value: A) => boolean) =>
  read.pipe(Effect.repeat({ until: ok, schedule: Schedule.spaced("50 millis") }), Effect.timeout("10 seconds"))

describe("inbox over the server", () => {
  it.live("a question the agent asks is in its owner's inbox alone, until answered", () =>
    Effect.scoped(Effect.gen(function*() {
      yield* Layer.build(serve({ port, database: ":memory:" }).pipe(Layer.provide(people)))
      const adas = yield* load("ada-token")
      const graces = yield* load("grace-token")
      const [agent] = yield* adas.registry.list(ada)
      if (agent === undefined) return yield* Effect.die("no seeded agent")
      const { conversation, session } = yield* adas.sessions.create({ ownerId: ada, agentId: agent.id, title: "Asks" })

      assert.deepStrictEqual(yield* adas.inbox, [])
      yield* session.prompt("build it")
      assert.deepStrictEqual(yield* adas.inbox, [], "nothing asked yet")

      const blocked = yield* Effect.forkChild(session.prompt("clean up"))
      const waiting = yield* until(adas.inbox, (items) => items.length > 0)
      assert.strictEqual(waiting.length, 1)
      const [asked] = waiting
      assert.strictEqual(asked?.conversationId, conversation.id)
      assert.strictEqual(asked?.kind, "tool-approval")
      assert.deepStrictEqual(yield* graces.inbox, [])

      // Answered on the session, as always; the inbox learns from the session.
      const pending = yield* session.pending
      assert.deepStrictEqual(pending.map((request) => request.id), [asked?.id])
      assert.isTrue(yield* session.respond({ id: asked?.id ?? "", granted: true }))
      yield* Fiber.join(blocked)
      assert.deepStrictEqual(yield* until(adas.inbox, (items) => items.length === 0), [])
    })), 60_000)
})
