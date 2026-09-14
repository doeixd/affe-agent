/**
 * W1 acceptance: reload the browser and continue the exact same conversation.
 *
 * A real server (SQLite product database + the agent over `AgentHttp`), and
 * the browser's own stack -- HTTP stores, `AgentDirectory.http`,
 * `ConversationSessions` -- built twice: once to start a conversation, and
 * again from nothing, as a reload does, to find it and carry on.
 */
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AgentId, ConversationId } from "../src/domain/WorkbenchIds.js"
import * as AgentDirectory from "../src/runtime/AgentDirectory.js"
import * as ConversationSessions from "../src/runtime/ConversationSessions.js"
import { approvedReply, buildReply, localOwner, serve } from "../src/server/app.js"
import * as AgentRegistry from "../src/store/AgentRegistry.js"
import * as ConversationStore from "../src/store/ConversationStore.js"
import * as HttpStores from "../src/store/http.js"

/**
 * One port per test: a server's graceful shutdown can outlast its test, and a
 * next test on the same port would talk to the one going away.
 */
const reloadPort = 8796
const refusalPort = 8795

/** Everything a page builds on load, and nothing it keeps across one. */
const browser = (baseUrl: string) =>
  ConversationSessions.layer.pipe(
    Layer.provideMerge(AgentDirectory.http({ baseUrl })),
    Layer.provideMerge(Layer.mergeAll(HttpStores.conversationStore({ baseUrl }), HttpStores.agentRegistry({ baseUrl }))),
    Layer.provide(FetchHttpClient.layer)
  )

const load = (port: number) => Effect.map(Layer.build(browser(`http://localhost:${port}`)), (context) => ({
  sessions: Context.get(context, ConversationSessions.ConversationSessions),
  store: Context.get(context, ConversationStore.ConversationStore),
  registry: Context.get(context, AgentRegistry.AgentRegistry)
}))

const tempDatabase = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "workbench-shell-")), "shell.db")),
  (file) => Effect.sync(() => NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true }))
)

describe("workbench product shell (W1)", () => {
  it.live("a reloaded page finds the conversation and continues it", () =>
    Effect.scoped(Effect.gen(function*() {
      yield* Layer.build(serve({ port: reloadPort, database: yield* tempDatabase }))

      // First load: start a conversation and run one exchange.
      const started = yield* Effect.scoped(Effect.gen(function*() {
        const page = yield* load(reloadPort)
        const [agent] = yield* page.registry.list(localOwner)
        if (agent === undefined) return yield* Effect.die("the server seeded no agent")
        const { conversation, session } = yield* page.sessions.create({
          ownerId: localOwner,
          agentId: agent.id,
          title: "Kept"
        })
        const reply = yield* session.prompt("build it")
        assert.strictEqual(reply.text, buildReply)
        return conversation
      }))

      // Reload: nothing survives in the page. The list comes from the server.
      yield* Effect.scoped(Effect.gen(function*() {
        const page = yield* load(reloadPort)
        const listed = yield* page.store.list({ ownerId: localOwner })
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

  it.live("typed refusals cross the product API as themselves", () =>
    Effect.scoped(Effect.gen(function*() {
      yield* Layer.build(serve({ port: refusalPort, database: ":memory:" }))
      const page = yield* load(refusalPort)

      const missing = yield* Effect.flip(page.store.update(ConversationId.make("nope"), { title: "x" }))
      assert.strictEqual(missing._tag, "ConversationNotFoundError")
      assert.isTrue(Option.isNone(yield* page.store.get(ConversationId.make("nope"))))
      const noAgent = yield* Effect.flip(page.registry.archive(AgentId.make("nobody")))
      assert.strictEqual(noAgent._tag, "AgentNotFoundError")
    })), 60_000)
})
