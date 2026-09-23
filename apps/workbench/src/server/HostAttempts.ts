/**
 * `TaskAttempts` over the server's own session host.
 *
 * An attempt is begun as the task's owner, through the same host the HTTP
 * routes serve: the conversation is recorded and indexed as the product
 * route would, then the host is asked -- as that person -- to make the
 * session and submit the description. The host authorizes it by the
 * conversation's owner, exactly as it would a request from their browser,
 * and observes it, which is the whole point.
 */
import { Effect, Layer, Option } from "effect"
import { AgentProtocol } from "affe-agent/client"
import type { AgentSessionHost } from "affe-agent/client"
import type * as Conversation from "../domain/Conversation.js"
import type * as Task from "../domain/Task.js"
import { ConversationId } from "../domain/WorkbenchIds.js"
import type { UserId } from "../domain/WorkbenchIds.js"
import { sessionIdOf } from "../runtime/ConversationSessions.js"
import { TaskAttempts } from "../runtime/TaskRunner.js"
import { AgentNotFoundError, AgentRegistry } from "../store/AgentRegistry.js"
import { ConversationStore } from "../store/ConversationStore.js"
import * as SessionIndex from "../store/SessionIndex.js"
import { Host } from "./Host.js"

const requestId = () => AgentProtocol.RequestId.make(globalThis.crypto.randomUUID())

export const layer: Layer.Layer<
  TaskAttempts,
  never,
  AgentSessionHost.Service<UserId> | ConversationStore | AgentRegistry | SessionIndex.SessionIndex
> =
  Layer.effect(
    TaskAttempts,
    Effect.gen(function*() {
      const host = yield* Host
      const store = yield* ConversationStore
      const registry = yield* AgentRegistry
      const index = yield* SessionIndex.SessionIndex

      const begin = Effect.fn("HostAttempts.begin")(function*(task: Task.Record, title: string) {
        const agent = yield* registry.get(task.agentId)
        if (Option.isNone(agent)) {
          return yield* new AgentNotFoundError({ agentId: task.agentId })
        }
        const id = ConversationId.make(globalThis.crypto.randomUUID())
        const conversation = yield* store.create({
          id,
          ownerId: task.ownerId,
          agentId: task.agentId,
          agentRevisionId: agent.value.activeRevisionId,
          sessionId: sessionIdOf(id),
          workspaceId: Option.none(),
          title
        }).pipe(
          // The id was minted here; it cannot exist. If it somehow does, that is the store's word.
          Effect.catchTag("ConversationExistsError", (error) =>
            Effect.die(`a freshly minted conversation id already exists: ${error.conversationId}`))
        )
        yield* SessionIndex.index(index, conversation)
        const sessionId = AgentProtocol.SessionId.make(conversation.sessionId)
        yield* host.createSession(task.ownerId, { requestId: requestId(), sessionId }).pipe(
          Effect.catchTag("AgentSessionAlreadyExistsError", () => Effect.void)
        )
        return conversation
      })

      const submit = (task: Task.Record, conversation: Conversation.Record) =>
        Effect.map(
          host.submit(task.ownerId, {
            requestId: requestId(),
            sessionId: AgentProtocol.SessionId.make(conversation.sessionId),
            input: AgentProtocol.input(task.description)
          }),
          ({ submissionId }) => submissionId
        )

      const interrupt = (owner: UserId, conversationId: ConversationId) =>
        host.interrupt(owner, { requestId: requestId(), sessionId: AgentProtocol.SessionId.make(sessionIdOf(conversationId)) })
          .pipe(Effect.asVoid)

      return TaskAttempts.of({ begin, submit, interrupt })
    })
  )
