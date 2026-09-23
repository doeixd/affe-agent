/**
 * W0 acceptance 7: refresh/reconnect reconstructs from history plus resumable
 * events where the backend supports them. The durable client has a delivery
 * log, so a presenter opened later resumes after the log's latest sequence
 * rather than attaching live and hoping nothing happened in between.
 */
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Option, Stream, SubscriptionRef } from "effect"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { Agent, AgentLoop } from "affe-agent"
import { AgentClient } from "affe-agent/client"
import { DeliveryLog, DurableAgentClient, DurableChannels, DurableSessionStore } from "affe-agent/durable"
import { TestLanguageModel } from "affe-agent/testing"
import type * as Conversation from "../src/domain/Conversation.js"
import { AgentId, AgentRevisionId, ConversationId, UserId } from "../src/domain/WorkbenchIds.js"
import * as ConversationPresenter from "../src/ui-core/ConversationPresenter.js"
import type { ConversationView } from "../src/ui-core/ConversationProjection.js"

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
    Effect.timeout("10 seconds")
  )

describe("workbench reconnect", () => {
  // Live: the durable client polls on the real clock, which TestClock would freeze.
  it.live("a presenter opened later resumes from the delivery log and follows the next submission", () =>
    Effect.gen(function*() {
      const { layer: model } = yield* TestLanguageModel.script([
        TestLanguageModel.text("first answer"),
        TestLanguageModel.text("second answer")
      ])
      const client = DurableAgentClient.layer("Workbench", Agent.make({ loop: AgentLoop.bounded(2) }), {
        store: yield* DurableChannels.memoryStore,
        sessionStore: yield* DurableSessionStore.memoryStore,
        delivery: yield* DeliveryLog.memoryLog
      }).pipe(
        Layer.provideMerge(ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))),
        Layer.provideMerge(model)
      )

      yield* Effect.gen(function*() {
        const agents = yield* AgentClient.AgentClient
        const session = yield* agents.createSession()
        const now = yield* DateTime.now
        const conversation: Conversation.Record = {
          id: ConversationId.make("c1"),
          ownerId: UserId.make("ada"),
          agentId: AgentId.make("a1"),
          agentRevisionId: AgentRevisionId.make("a1@1"),
          sessionId: session.id,
          workspaceId: Option.none(),
          modelProfile: Option.none(),
          title: "Reconnect",
          archived: false,
          createdAt: now,
          updatedAt: now
        }

        // The first page: follows one submission, then goes away.
        yield* Effect.scoped(Effect.gen(function*() {
          const presenter = yield* ConversationPresenter.fromOpen({ conversation, session })
          yield* session.prompt("one")
          yield* until(presenter, (view) => Option.isSome(view.outcome))
        }))
        const logged = yield* Effect.flatMap(Effect.fromNullishOr(session.eventLog), (read) => read())

        // The refreshed page: a new handle, as another tab or process would have.
        yield* Effect.scoped(Effect.gen(function*() {
          const reopened = yield* agents.session(session.id)
          const presenter = yield* ConversationPresenter.fromOpen({ conversation, session: reopened })
          const opened = yield* SubscriptionRef.get(presenter.state)
          assert.deepStrictEqual(opened.messages.map((message) => message.text), ["one", "first answer"])

          yield* reopened.prompt("two")
          const followed = yield* until(
            presenter,
            (view) => Option.isSome(view.outcome) && view.messages.length === 4
          )
          assert.deepStrictEqual(
            followed.messages.map((message) => message.text),
            ["one", "first answer", "two", "second answer"]
          )
          // Its events came after the log's snapshot, not from some later point.
          assert.isTrue(Option.getOrElse(followed.lastSequence, () => 0) > logged.latest)
        }))
      }).pipe(Effect.provide(client))
    }), 30_000)
})
