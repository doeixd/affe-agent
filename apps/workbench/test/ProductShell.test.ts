/**
 * W1 acceptance -- reload the browser and continue the exact same
 * conversation -- and the ownership that makes a shared server safe.
 *
 * A real server (SQLite product database + the agent over `AgentHttp`, both
 * behind bearer tokens), and the browser's own stack -- HTTP stores,
 * `AgentDirectory.http`, `ConversationSessions` -- built from nothing each
 * time a page loads.
 */
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Context, Duration, Effect, Fiber, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AgentId, ConversationId, UserId } from "../src/domain/WorkbenchIds.js"
import * as AgentDirectory from "../src/runtime/AgentDirectory.js"
import * as ConversationSessions from "../src/runtime/ConversationSessions.js"
import { tokens } from "../src/server/Authentication.js"
import { approvedReply, buildReply, serve } from "../src/server/app.js"
import * as AgentRegistry from "../src/store/AgentRegistry.js"
import * as ConversationStore from "../src/store/ConversationStore.js"
import * as HttpStores from "../src/store/http.js"

/**
 * One port per test: a server's graceful shutdown can outlast its test, and a
 * next test on the same port would talk to the one going away.
 */
const reloadPort = 8796
const refusalPort = 8795
const ownershipPort = 8794
const routingPort = 8793
const restartPort = 8792
const restartedPort = 8791

const ada = UserId.make("ada")
const grace = UserId.make("grace")
const people = tokens({ "ada-token": "ada", "grace-token": "grace" })

/** Everything a page builds on load, and nothing it keeps across one. */
const load = (port: number, token: string) => {
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
      store: Context.get(context, ConversationStore.ConversationStore),
      registry: Context.get(context, AgentRegistry.AgentRegistry),
      directory: Context.get(context, AgentDirectory.AgentDirectory),
      me: Effect.provide(HttpStores.currentUser(server), FetchHttpClient.layer)
    })
  )
}

const tempDatabase = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "workbench-shell-")), "shell.db")),
  (file) => Effect.sync(() => NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true }))
)

const agentOf = (registry: AgentRegistry.Service, owner: UserId) =>
  Effect.flatMap(registry.list(owner), ([agent]) =>
    agent === undefined ? Effect.die(`the server seeded no agent for ${owner}`) : Effect.succeed(agent))

describe("workbench product shell (W1)", () => {
  it.live("a reloaded page finds the conversation and continues it", () =>
    Effect.scoped(Effect.gen(function*() {
      yield* Layer.build(serve({ port: reloadPort, database: yield* tempDatabase }).pipe(Layer.provide(people)))

      // First load: start a conversation and run one exchange.
      const started = yield* Effect.scoped(Effect.gen(function*() {
        const page = yield* load(reloadPort, "ada-token")
        assert.strictEqual(yield* page.me, ada)
        const agent = yield* agentOf(page.registry, ada)
        const { conversation, session } = yield* page.sessions.create({ ownerId: ada, agentId: agent.id, title: "Kept" })
        const reply = yield* session.prompt("build it")
        assert.strictEqual(reply.text, buildReply)
        return conversation
      }))

      // Reload: nothing survives in the page. The list comes from the server.
      yield* Effect.scoped(Effect.gen(function*() {
        const page = yield* load(reloadPort, "ada-token")
        const listed = yield* page.store.list({ ownerId: ada })
        assert.deepStrictEqual(listed.map((conversation) => conversation.id), [started.id])

        const { conversation, session } = yield* page.sessions.open(started.id)
        assert.deepStrictEqual(conversation, started)
        const history = yield* session.history
        assert.isTrue(
          history.content.some((message) =>
            message.role === "assistant" && message.content.some((part) => part.type === "text" && part.text === buildReply)
          ),
          "the reopened session holds the first exchange"
        )

        // And carries on from there: the next scripted step is the approval.
        const running = yield* Effect.forkChild(session.prompt("clean up"))
        const question = yield* session.pending.pipe(
          Effect.repeat({ until: (pending) => pending.length > 0 }),
          Effect.map((pending) => pending[0]?.id ?? ""),
          Effect.timeout("10 seconds")
        )
        assert.isTrue(yield* session.respond({ id: question, granted: true }))
        const approved = yield* Fiber.join(running)
        assert.strictEqual(approved.text, approvedReply)

        const renamed = yield* page.store.update(started.id, { title: "Renamed" })
        assert.strictEqual(renamed.title, "Renamed")
      }))
    })), 60_000)

  it.live("a restarted server reopens a conversation with its history, and it continues", () =>
    Effect.scoped(Effect.gen(function*() {
      const database = yield* tempDatabase
      // Short shard locks, so the second server need not wait out the first.
      // The second listens on another port: what restarts is the process and
      // its memory, and a client's pooled keep-alive connection to the old
      // socket would otherwise fail the first request for a reason that has
      // nothing to do with durability.
      const server = (port: number) =>
        serve({
          port,
          database,
          durability: { shardLockExpiration: Duration.seconds(1), shardLockRefreshInterval: Duration.millis(200) }
        }).pipe(Layer.provide(people))

      const started = yield* Effect.scoped(Effect.gen(function*() {
        yield* Layer.build(server(restartPort))
        const page = yield* load(restartPort, "ada-token")
        const agent = yield* agentOf(page.registry, ada)
        const { conversation, session } = yield* page.sessions.create({ ownerId: ada, agentId: agent.id, title: "Survives" })
        assert.strictEqual((yield* session.prompt("build it")).text, buildReply)
        return conversation
      }))

      // The first server is gone, and every session it held in memory with it.
      yield* Layer.build(server(restartedPort))
      const page = yield* load(restartedPort, "ada-token")
      const { session } = yield* page.sessions.open(started.id)
      const texts = (yield* session.history).content.flatMap((message) =>
        message.role === "assistant"
          ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          : []
      )
      assert.include(texts, buildReply, "the reopened conversation keeps the exchange the first server ran")

      // And carries on: the new server's script starts again at its build step.
      assert.strictEqual((yield* session.prompt("build again")).text, buildReply)
    })), 120_000)

  it.live("each conversation runs its own agent's configuration on the server", () =>
    Effect.scoped(Effect.gen(function*() {
      yield* Layer.build(serve({ port: routingPort, database: ":memory:" }).pipe(Layer.provide(people)))
      const page = yield* load(routingPort, "ada-token")
      const seeded = yield* agentOf(page.registry, ada)

      // A second agent, allowed no tools: the scripted model's tool call is refused.
      const [firstRevision] = yield* page.registry.revisions(seeded.id)
      if (firstRevision === undefined) return yield* Effect.die("the seeded agent has no revision")
      const { spec: toolless } = yield* page.registry.create({
        ownerId: ada,
        name: "No tools",
        revision: { ...firstRevision, capabilities: [] }
      })

      // The tool-less agent first, while the script's next turn is the build
      // call: routed to the wrong agent it would run the tool and succeed,
      // and this would fail at once rather than on a later scripted turn.
      const withTools = yield* page.sessions.create({ ownerId: ada, agentId: seeded.id, title: "With tools" })
      const withoutTools = yield* page.sessions.create({ ownerId: ada, agentId: toolless.id, title: "Without" })
      const refused = yield* Effect.flip(withoutTools.session.prompt("build it"))
      assert.strictEqual(refused._tag, "AgentExecutionError", "the tool-less agent cannot run the tool the model called")

      // Its own instructions and nothing else: none of the other run's messages.
      const history = yield* withTools.session.history
      assert.deepStrictEqual(
        history.content.map((message) => message.role),
        ["system"],
        "the tool-using conversation is untouched by the other's run"
      )
    })), 60_000)

  it.live("typed refusals cross the product API as themselves", () =>
    Effect.scoped(Effect.gen(function*() {
      yield* Layer.build(serve({ port: refusalPort, database: ":memory:" }).pipe(Layer.provide(people)))
      const page = yield* load(refusalPort, "ada-token")

      const missing = yield* Effect.flip(page.store.update(ConversationId.make("nope"), { title: "x" }))
      assert.strictEqual(missing._tag, "ConversationNotFoundError")
      assert.isTrue(Option.isNone(yield* page.store.get(ConversationId.make("nope"))))
      const noAgent = yield* Effect.flip(page.registry.archive(AgentId.make("nobody")))
      assert.strictEqual(noAgent._tag, "AgentNotFoundError")
    })), 60_000)

  it.live("one person cannot see, open, prompt or change another's conversation", () =>
    Effect.scoped(Effect.gen(function*() {
      yield* Layer.build(serve({ port: ownershipPort, database: ":memory:" }).pipe(Layer.provide(people)))

      const adas = yield* load(ownershipPort, "ada-token")
      const adasAgent = yield* agentOf(adas.registry, ada)
      const { conversation } = yield* adas.sessions.create({ ownerId: ada, agentId: adasAgent.id, title: "Private" })

      const graces = yield* load(ownershipPort, "grace-token")
      // The product API answers as if it did not exist.
      assert.deepStrictEqual(yield* graces.store.list({ ownerId: ada }), [])
      assert.isTrue(Option.isNone(yield* graces.store.get(conversation.id)))
      assert.isTrue(Option.isNone(yield* graces.registry.get(adasAgent.id)))
      assert.strictEqual((yield* Effect.flip(graces.sessions.open(conversation.id)))._tag, "ConversationNotFoundError")
      assert.strictEqual(
        (yield* Effect.flip(graces.store.update(conversation.id, { title: "Mine now" })))._tag,
        "ConversationNotFoundError"
      )
      yield* graces.store.remove(conversation.id)
      assert.isTrue(Option.isSome(yield* adas.store.get(conversation.id)), "grace's delete removed nothing")

      // Recording a conversation on ada's agent, or in ada's name, is refused.
      const gracesAgent = yield* agentOf(graces.registry, grace)
      const onAdasAgent = yield* Effect.flip(
        graces.sessions.create({ ownerId: grace, agentId: adasAgent.id, title: "Borrowed" })
      )
      assert.strictEqual(onAdasAgent._tag, "AgentNotFoundError")
      const asAda = yield* Effect.flip(graces.sessions.create({ ownerId: ada, agentId: gracesAgent.id, title: "Forged" }))
      assert.strictEqual(asAda._tag, "WorkbenchStorageError")

      // And the agent routes refuse the session itself, even addressed directly.
      const client = yield* graces.directory.client(gracesAgent.activeRevisionId)
      const direct = yield* Effect.flip(client.session(ConversationSessions.sessionIdOf(conversation.id)))
      assert.strictEqual(direct._tag, "AgentForbiddenError")

      // Without a token the server knows, neither API answers.
      const stranger = yield* load(ownershipPort, "not-a-token")
      assert.strictEqual((yield* Effect.flip(stranger.me))._tag, "WorkbenchStorageError")
      const strangerClient = yield* stranger.directory.client(gracesAgent.activeRevisionId)
      const unauthenticated = yield* Effect.flip(strangerClient.session(ConversationSessions.sessionIdOf(conversation.id)))
      assert.strictEqual(unauthenticated._tag, "AgentUnauthorizedError")
    })), 60_000)
})
