/**
 * W0's acceptance, through the proposed services and nothing else: create and
 * open a conversation, stream into the projection, show reasoning, a tool
 * call and its progress, stop, answer a question, and reopen from history.
 */
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Option, Schema, Stream, SubscriptionRef } from "effect"
import { Tool } from "effect/unstable/ai"
import { Agent, AgentLoop } from "affe-agent"
import { AgentClient } from "affe-agent/client"
import * as Elicitation from "affe-agent/elicitation"
import { TestLanguageModel } from "affe-agent/testing"
import type * as Conversation from "../src/domain/Conversation.js"
import { AgentProfileId, ConversationId, UserId } from "../src/domain/WorkbenchIds.js"
import * as AgentDirectory from "../src/runtime/AgentDirectory.js"
import * as ConversationSessions from "../src/runtime/ConversationSessions.js"
import * as AgentCatalog from "../src/store/AgentCatalog.js"
import * as ConversationStore from "../src/store/ConversationStore.js"
import * as ConversationPresenter from "../src/ui-core/ConversationPresenter.js"
import type { ConversationView } from "../src/ui-core/ConversationProjection.js"

const owner = UserId.make("ada")
const profile: Conversation.AgentProfile = {
  id: AgentProfileId.make("builder"),
  ownerId: owner,
  name: "Builder",
  instructions: "Build things."
}

const Build = Tool.make("build", { parameters: Schema.Struct({}), success: Schema.String })
const Dangerous = Tool.make("deleteEverything", { parameters: Schema.Struct({}), success: Schema.String })
  .setNeedsApproval(true)

const workbench = (turns: ReadonlyArray<TestLanguageModel.Turn>) =>
  Effect.gen(function*() {
    const toolkit = yield* Agent.toolkit([Build, Dangerous], {
      build: (_params, context) => context.preliminary("halfway").pipe(Effect.as("built")),
      deleteEverything: () => Effect.succeed("deleted")
    })
    const { layer: model } = yield* TestLanguageModel.script(turns)
    const client = AgentClient.layer(Agent.make({ toolkit, loop: AgentLoop.bounded(4) }), {
      elicitation: Elicitation.memory
    })
    return ConversationSessions.layer.pipe(
      Layer.provideMerge(AgentDirectory.single),
      Layer.provideMerge(Layer.mergeAll(ConversationStore.memory, AgentCatalog.memory([profile]))),
      Layer.provideMerge(client),
      Layer.provide(model)
    )
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

const create = Effect.gen(function*() {
  const sessions = yield* ConversationSessions.ConversationSessions
  const { conversation } = yield* sessions.create({ ownerId: owner, agentProfileId: profile.id, title: "First" })
  return conversation
})

describe("workbench W0", () => {
  it.effect("streams reasoning, a tool call and its progress, then reopens from history", () =>
    Effect.gen(function*() {
      const layer = yield* workbench([
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

  it.effect("a paused run is answered through the session, and the question closes", () =>
    Effect.gen(function*() {
      const layer = yield* workbench([
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
      const layer = yield* workbench([{ text: "never", hang: true, started }])
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
      const layer = yield* workbench([])
      yield* Effect.scoped(Effect.gen(function*() {
        const sessions = yield* ConversationSessions.ConversationSessions
        const input = {
          ownerId: owner,
          agentProfileId: profile.id,
          title: "Retried",
          conversationId: ConversationId.make("retried")
        }
        const first = yield* sessions.create(input)
        const again = yield* sessions.create(input)
        assert.deepStrictEqual(again.conversation, first.conversation)
        assert.strictEqual(again.session.id, first.session.id)
      })).pipe(Effect.provide(layer))
    }))

  it.effect("a conversation for a profile the catalog does not know is refused, and not recorded", () =>
    Effect.gen(function*() {
      const layer = yield* workbench([])
      yield* Effect.scoped(Effect.gen(function*() {
        const sessions = yield* ConversationSessions.ConversationSessions
        const id = ConversationId.make("orphan")
        const failure = yield* Effect.flip(
          sessions.create({ ownerId: owner, agentProfileId: AgentProfileId.make("nobody"), title: "x", conversationId: id })
        )
        assert.strictEqual(failure._tag, "AgentResolutionError")
        const store = yield* ConversationStore.ConversationStore
        assert.isTrue(Option.isNone(yield* store.get(id)))
        const opened = yield* Effect.flip(sessions.open(id))
        assert.strictEqual(opened._tag, "ConversationNotFoundError")
      })).pipe(Effect.provide(layer))
    }))
})
