/**
 * W0's acceptance, through the proposed services and nothing else: create and
 * open a conversation, stream into the projection, show reasoning, a tool
 * call and its progress, stop, answer a question, and reopen from history --
 * over agents defined as data and resolved by revision.
 */
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Option, Schema, Stream, SubscriptionRef } from "effect"
import { Tool } from "effect/unstable/ai"
import { Agent, Permission } from "affe-agent"
import { TestLanguageModel } from "affe-agent/testing"
import type { RevisionInput } from "../src/domain/AgentRevision.js"
import { AgentId, ConversationId, UserId } from "../src/domain/WorkbenchIds.js"
import * as AgentDirectory from "../src/runtime/AgentDirectory.js"
import * as AgentResolver from "../src/runtime/AgentResolver.js"
import * as ConversationSessions from "../src/runtime/ConversationSessions.js"
import * as AgentRegistry from "../src/store/AgentRegistry.js"
import * as ConversationStore from "../src/store/ConversationStore.js"
import * as ConversationPresenter from "../src/ui-core/ConversationPresenter.js"
import type { ConversationView } from "../src/ui-core/ConversationProjection.js"

const owner = UserId.make("ada")

const Build = Tool.make("build", { parameters: Schema.Struct({}), success: Schema.String })
const Dangerous = Tool.make("deleteEverything", { parameters: Schema.Struct({}), success: Schema.String })
  .setNeedsApproval(true)

const revision = (instructions: string): RevisionInput => ({
  instructions,
  modelPolicy: { profile: "scripted" },
  capabilities: [{ id: "workshop" }],
  skills: [],
  permission: { recorded: JSON.stringify(Permission.describe(Permission.allowAll)) },
  maxTurns: 4
})

const workbench = (turns: ReadonlyArray<TestLanguageModel.Turn>) =>
  Effect.gen(function*() {
    const { layer: model, recorder } = yield* TestLanguageModel.script(turns)
    const bindings = Layer.succeed(AgentResolver.AgentBindings, {
      models: { scripted: model },
      capabilities: {
        workshop: [
          Agent.tool(Build, (_params, context) => context.preliminary("halfway").pipe(Effect.as("built"))),
          Agent.tool(Dangerous, () => Effect.succeed("deleted"))
        ]
      },
      skills: {}
    })
    const layer = ConversationSessions.layer.pipe(
      Layer.provideMerge(AgentDirectory.layer),
      Layer.provideMerge(AgentResolver.layer),
      Layer.provideMerge(Layer.mergeAll(ConversationStore.memory, AgentRegistry.memory)),
      Layer.provide(bindings)
    )
    return { layer, recorder }
  })

/** The first view that satisfies `predicate`, the current one included. */
const until = (
  presenter: ConversationPresenter.ConversationPresenter,
  predicate: (view: ConversationView) => boolean
) =>
  SubscriptionRef.changes(presenter.state).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.flatMap(Option.match({
      onNone: () => Effect.die("the presenter's state stopped changing"),
      onSome: Effect.succeed
    })),
    Effect.timeout("5 seconds")
  )

const defineAgent = Effect.gen(function*() {
  const registry = yield* AgentRegistry.AgentRegistry
  const { spec } = yield* registry.create({ ownerId: owner, name: "Builder", revision: revision("Build things.") })
  return spec.id
})

const create = Effect.gen(function*() {
  const agentId = yield* defineAgent
  const sessions = yield* ConversationSessions.ConversationSessions
  const { conversation } = yield* sessions.create({ ownerId: owner, agentId, title: "First" })
  return conversation
})

describe("workbench W0", () => {
  it.effect("streams reasoning, a tool call and its progress, then reopens from history", () =>
    Effect.gen(function*() {
      const { layer } = yield* workbench([
        { reasoning: { text: "Needs a build." }, toolCalls: [{ id: "b1", name: "build", params: {} }] },
        TestLanguageModel.text("Built it.")
      ])
      yield* Effect.gen(function*() {
        const conversation = yield* create

        const live = yield* Effect.scoped(Effect.gen(function*() {
          const presenter = yield* ConversationPresenter.make(conversation.id)
          yield* presenter.session.prompt("build it", { stream: true })
          return yield* until(presenter, (view) => view.status === "idle" && Option.isSome(view.outcome))
        }))

        assert.deepStrictEqual(live.outcome, Option.some("completed"))
        assert.deepStrictEqual(
          live.messages.map((message) => [message.role, message.text, message.reasoning, message.state]),
          [
            ["user", "build it", "", "complete"],
            ["assistant", "", "Needs a build.", "complete"],
            ["assistant", "Built it.", "", "complete"]
          ]
        )
        assert.deepStrictEqual(live.activity, [
          { _tag: "Tool", id: "b1", name: "build", params: {}, progress: ["halfway"], state: "succeeded" }
        ])

        // A fresh presenter -- a refreshed page -- sees the same conversation,
        // from canonical history alone.
        const reopened = yield* Effect.scoped(
          Effect.flatMap(ConversationPresenter.make(conversation.id), (presenter) => SubscriptionRef.get(presenter.state))
        )
        assert.deepStrictEqual(reopened.messages, live.messages)
      }).pipe(Effect.provide(layer))
    }))

  it.effect("a conversation keeps the revision it was created on; a new one gets the edit", () =>
    Effect.gen(function*() {
      const { layer, recorder } = yield* workbench([
        TestLanguageModel.text("before"),
        TestLanguageModel.text("still before"),
        TestLanguageModel.text("after")
      ])
      yield* Effect.gen(function*() {
        const registry = yield* AgentRegistry.AgentRegistry
        const sessions = yield* ConversationSessions.ConversationSessions
        const agentId = yield* defineAgent

        const old = yield* sessions.create({ ownerId: owner, agentId, title: "Old" })
        yield* old.session.prompt("one")
        const edited = yield* registry.revise(agentId, revision("Build better things."), owner)

        const reopened = yield* sessions.open(old.conversation.id)
        yield* reopened.session.prompt("two")
        const fresh = yield* sessions.create({ ownerId: owner, agentId, title: "New" })
        yield* fresh.session.prompt("three")

        assert.strictEqual(reopened.conversation.agentRevisionId, old.conversation.agentRevisionId)
        assert.strictEqual(fresh.conversation.agentRevisionId, edited.id)
        const system = (yield* recorder.prompts).map((prompt) =>
          prompt.content.flatMap((message) => (message.role === "system" ? [message.content] : [])).join("")
        )
        assert.deepStrictEqual(system, ["Build things.", "Build things.", "Build better things."])
      }).pipe(Effect.provide(layer))
    }))

  it.effect("a paused run is answered through the session, and the question closes", () =>
    Effect.gen(function*() {
      const { layer } = yield* workbench([
        { toolCalls: [{ id: "d1", name: "deleteEverything", params: {} }] },
        TestLanguageModel.text("Deleted.")
      ])
      yield* Effect.scoped(Effect.gen(function*() {
        const presenter = yield* ConversationPresenter.make((yield* create).id)
        const running = yield* Effect.forkChild(presenter.session.prompt("clean up"))

        const asked = yield* until(presenter, (view) => view.pending.length === 1)
        const request = asked.pending[0]
        assert.strictEqual(request?.kind, "tool-approval")
        assert.isTrue(yield* presenter.session.respond({ id: request?.id ?? "", granted: true }))

        yield* Fiber.join(running)
        const settled = yield* until(presenter, (view) => Option.isSome(view.outcome))
        assert.deepStrictEqual(settled.pending, [])
        assert.deepStrictEqual(settled.outcome, Option.some("completed"))
      })).pipe(Effect.provide(layer))
    }))

  it.effect("stop interrupts through the session, and nothing is left running", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const { layer } = yield* workbench([{ text: "never", hang: true, started }])
      yield* Effect.scoped(Effect.gen(function*() {
        const presenter = yield* ConversationPresenter.make((yield* create).id)
        const running = yield* Effect.forkChild(presenter.session.prompt("wait", { stream: true }))
        yield* Deferred.await(started)

        yield* presenter.session.interrupt()
        yield* Fiber.await(running)
        const stopped = yield* until(presenter, (view) => Option.isSome(view.outcome))
        assert.deepStrictEqual(stopped.outcome, Option.some("interrupted"))
        assert.strictEqual(stopped.status, "idle")
        assert.isFalse(stopped.messages.some((message) => message.state === "streaming"))
      })).pipe(Effect.provide(layer))
    }))

  it.effect("creating again under the same conversation id opens the first, not a second", () =>
    Effect.gen(function*() {
      const { layer } = yield* workbench([])
      yield* Effect.gen(function*() {
        const sessions = yield* ConversationSessions.ConversationSessions
        const input = {
          ownerId: owner,
          agentId: yield* defineAgent,
          title: "Retried",
          conversationId: ConversationId.make("retried")
        }
        const first = yield* sessions.create(input)
        const again = yield* sessions.create(input)
        assert.deepStrictEqual(again.conversation, first.conversation)
        assert.strictEqual(again.session.id, first.session.id)
      }).pipe(Effect.provide(layer))
    }))

  it.effect("a conversation for an agent the registry does not know is refused, and not recorded", () =>
    Effect.gen(function*() {
      const { layer } = yield* workbench([])
      yield* Effect.gen(function*() {
        const sessions = yield* ConversationSessions.ConversationSessions
        const id = ConversationId.make("orphan")
        const failure = yield* Effect.flip(
          sessions.create({ ownerId: owner, agentId: AgentId.make("nobody"), title: "x", conversationId: id })
        )
        assert.strictEqual(failure._tag, "AgentNotFoundError")
        const store = yield* ConversationStore.ConversationStore
        assert.isTrue(Option.isNone(yield* store.get(id)))
        const opened = yield* Effect.flip(sessions.open(id))
        assert.strictEqual(opened._tag, "ConversationNotFoundError")
      }).pipe(Effect.provide(layer))
    }))
})
