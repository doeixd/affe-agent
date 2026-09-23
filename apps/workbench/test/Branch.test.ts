/**
 * Branching (W2 edit-and-resend): where a branch is cut, as pure functions,
 * and -- over a real server, where the seed crosses HTTP into the durable
 * client -- a branch holds the source's history up to the edited message,
 * runs the source's pinned revision, continues on its own, and leaves the
 * source untouched and unreadable to anyone else.
 */
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer, Option } from "effect"
import { Prompt } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { Permission } from "affe-agent"
import { UserId } from "../src/domain/WorkbenchIds.js"
import * as AgentDirectory from "../src/runtime/AgentDirectory.js"
import * as ConversationSessions from "../src/runtime/ConversationSessions.js"
import { tokens } from "../src/server/Authentication.js"
import { approvedReply, buildReply, serve } from "../src/server/app.js"
import * as AgentRegistry from "../src/store/AgentRegistry.js"
import * as HttpStores from "../src/store/http.js"
import * as Branch from "../src/ui-core/Branch.js"
import type { MessageView } from "../src/ui-core/ConversationProjection.js"

const view = (role: "user" | "assistant", text: string): MessageView => ({ role, text, reasoning: "", files: [], state: "complete" })

const history = Prompt.make([
  { role: "system", content: "sys" },
  { role: "user", content: [{ type: "text", text: "q1" }] },
  { role: "assistant", content: [{ type: "text", text: "a1" }] },
  { role: "user", content: [{ type: "text", text: "q2" }] },
  { role: "assistant", content: [{ type: "text", text: "a2" }] }
])

const texts = (prompt: Prompt.Prompt) =>
  prompt.content.map((message) =>
    message.role === "system"
      ? `system:${message.content}`
      : `${message.role}:${message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")}`
  )

describe("branch point", () => {
  it("counts the person's messages before a place on the page, and nothing for a reply", () => {
    const shown = [view("user", "q1"), view("assistant", "a1"), view("user", "q2"), view("assistant", "a2")]
    assert.deepStrictEqual(Branch.userOrdinal(shown, 0), Option.some(0))
    assert.deepStrictEqual(Branch.userOrdinal(shown, 2), Option.some(1))
    assert.isTrue(Option.isNone(Branch.userOrdinal(shown, 1)))
    assert.isTrue(Option.isNone(Branch.userOrdinal(shown, 9)))
  })

  it("cuts history just before the person's message, system message kept, the whole of it at the end, and refuses past that", () => {
    assert.deepStrictEqual(Option.map(Branch.before(history, 0), texts), Option.some(["system:sys"]))
    assert.deepStrictEqual(Option.map(Branch.before(history, 1), texts), Option.some(["system:sys", "user:q1", "assistant:a1"]))
    // One past the last of the person's messages: the whole history, where "another model" continues.
    assert.deepStrictEqual(Option.map(Branch.before(history, 2), texts), Option.some(texts(history)))
    assert.isTrue(Option.isNone(Branch.before(history, 3)))
    assert.strictEqual(Branch.userCount([view("user", "q1"), view("assistant", "a1"), view("user", "q2")]), 2)
  })
})

const port = 8776
const ada = UserId.make("ada")

describe("branching over the server", () => {
  it.live("a branch holds history to the edit, runs the pinned revision, and leaves the source alone", () =>
    Effect.scoped(Effect.gen(function*() {
      yield* Layer.build(serve({ port, database: ":memory:" }).pipe(Layer.provide(tokens({ "ada-token": "ada", "grace-token": "grace" }))))
      const page = (token: string) => {
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
            registry: Context.get(context, AgentRegistry.AgentRegistry)
          })
        )
      }
      const adas = yield* page("ada-token")
      const [agent] = yield* adas.registry.list(ada)
      if (agent === undefined) return yield* Effect.die("no agent")
      const source = yield* adas.sessions.create({ ownerId: ada, agentId: agent.id, title: "Source" })
      // Two exchanges on the source: a build, then a question answered.
      assert.strictEqual((yield* source.session.prompt("build it")).text, buildReply)
      const cleaning = yield* Effect.forkChild(source.session.prompt("clean up"))
      const [asked] = yield* source.session.pending.pipe(
        Effect.repeat({ until: (pending) => pending.length > 0 }),
        Effect.timeout("10 seconds")
      )
      assert.isTrue(yield* source.session.respond({ id: asked?.id ?? "", granted: true }))
      assert.strictEqual((yield* Fiber.join(cleaning)).text, approvedReply)
      const sourceBefore = texts(yield* source.session.history)

      // The agent is revised after the source began: a branch must run the source's revision.
      const revised = yield* adas.registry.revise(agent.id, {
        instructions: "a different agent now",
        modelPolicy: { profile: "scripted" },
        capabilities: [{ id: "build" }, { id: "deleteEverything" }],
        skills: [],
        permission: { recorded: JSON.stringify(Permission.describe(Permission.allowAll)) },
        maxTurns: 4
      }, ada)
      assert.notStrictEqual(revised.id, source.conversation.agentRevisionId)

      // Branch before the second message: the seed is the first exchange, and nothing of the second.
      const branched = yield* adas.sessions.branch({ from: source.conversation.id, ordinal: 1, title: "Retry" })
      assert.strictEqual(branched.conversation.title, "Retry")
      assert.strictEqual(branched.conversation.agentRevisionId, source.conversation.agentRevisionId)
      const seeded = texts(yield* branched.session.history)
      assert.include(seeded, "user:build it")
      assert.include(seeded, `assistant:${buildReply}`)
      assert.notInclude(seeded, "user:clean up")
      assert.isTrue(seeded[0]?.startsWith("system:") ?? false, "the source's system message")
      assert.notInclude(seeded.join(), "a different agent now")

      // The branch continues on its own; the source keeps exactly what it had.
      assert.strictEqual((yield* branched.session.prompt("build it differently")).text, buildReply)
      const after = texts(yield* branched.session.history)
      assert.deepStrictEqual(after.slice(0, seeded.length), seeded)
      assert.include(after, "user:build it differently")
      assert.deepStrictEqual(texts(yield* source.session.history), sourceBefore)

      // A point past the source's history is refused by name.
      const past = yield* Effect.flip(adas.sessions.branch({ from: source.conversation.id, ordinal: 5 }))
      assert.strictEqual(past._tag, "BranchPointMissingError")

      // Someone else cannot branch Ada's conversation.
      const graces = yield* page("grace-token")
      const foreign = yield* Effect.flip(graces.sessions.branch({ from: source.conversation.id, ordinal: 0 }))
      assert.strictEqual(foreign._tag, "ConversationNotFoundError")
    })), 60_000)
})
