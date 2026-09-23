/**
 * Keeps the inbox current from the host's events (control plane §11):
 *
 *     ElicitationRequested -> an item appears
 *     ElicitationResolved  -> it settles
 *     a submission settles -> whatever that session had open settles
 *
 * The third rule is what makes an interrupted run honest: its questions
 * never get an `ElicitationResolved`, and without it they would wait for
 * ever. An item is the conversation owner's; a session no conversation
 * names asks nobody, and is skipped. One write per event, as the session
 * index does, for the same reason: a list that lags answers "is anyone
 * waiting on me" wrongly for exactly that lag.
 */
import { Clock, Effect, Option, Stream } from "effect"
import type { AgentProtocol } from "affe-agent/client"
import type { ConversationStore } from "../store/ConversationStore.js"
import type { InboxStore } from "../store/InboxStore.js"
import type { WorkbenchStorageError } from "../store/WorkbenchStorageError.js"
import { conversationIdOf } from "./ConversationSessions.js"

export const follow: (
  inbox: InboxStore["Service"],
  conversations: ConversationStore["Service"],
  events: Stream.Stream<AgentProtocol.HostEvent, never>
) => Effect.Effect<void, WorkbenchStorageError> = Effect.fn("InboxProjection.follow")(
  function*(inbox, conversations, events) {
    yield* Stream.runForEach(events, (hostEvent): Effect.Effect<void, WorkbenchStorageError> => {
      if (hostEvent._tag !== "SessionEvent") return Effect.void
      const { event, sessionId } = hostEvent.envelope
      switch (event._tag) {
        case "ElicitationRequested":
          return Effect.gen(function*() {
            const conversationId = conversationIdOf(sessionId)
            if (Option.isNone(conversationId)) return
            const conversation = yield* conversations.get(conversationId.value)
            if (Option.isNone(conversation)) return
            yield* inbox.put({
              id: event.id,
              sessionId,
              conversationId: conversationId.value,
              ownerId: conversation.value.ownerId,
              kind: event.kind,
              detail: event.detail,
              createdAt: yield* Clock.currentTimeMillis
            })
          })
        case "ElicitationResolved":
          return inbox.remove(sessionId, event.id)
        case "SubmissionCompleted":
        case "SubmissionFailed":
        case "SubmissionInterrupted":
          return inbox.clearSession(sessionId)
        default:
          return Effect.void
      }
    })
  }
)
