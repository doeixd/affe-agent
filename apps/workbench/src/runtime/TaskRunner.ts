/**
 * Runs tasks (plan-agent-product-control-plane.md §8, `TaskRunner` in §43).
 *
 * An attempt is a conversation on the task's agent plus one submission of
 * the task's description, begun through `TaskAttempts`: on the server, the
 * session host itself, so the attempt is observed like any session a
 * person opens -- its questions land in the inbox, its session is in the
 * index, and the chat page can read along. Nothing about execution is
 * special-cased for tasks, and the runner never reaches an `AgentClient`
 * directly: a session made behind the host's back would emit no host
 * events, and its task would never settle.
 *
 * Status comes back the other way, from those events (`follow`): the
 * task is `waiting` while its attempt has a question open, `running`
 * otherwise, and `completed` / `failed` / `canceled` once the submission
 * is done. No status is ever guessed from the runner's own bookkeeping.
 */
import { Context, Effect, Option, Schema, Stream } from "effect"
import type { AgentProtocol } from "affe-agent/client"
import type * as Conversation from "../domain/Conversation.js"
import * as Task from "../domain/Task.js"
import { TaskId } from "../domain/WorkbenchIds.js"
import type { ConversationId } from "../domain/WorkbenchIds.js"
import type { AgentNotFoundError } from "../store/AgentRegistry.js"
import { TaskStore } from "../store/TaskStore.js"
import type { WorkbenchStorageError } from "../store/WorkbenchStorageError.js"

/** Starting a task that is already being attempted, or cancelling one that is not. */
export class TaskNotStartableError extends Schema.TaggedError<TaskNotStartableError>()(
  "TaskNotStartableError",
  { taskId: TaskId, status: Task.Status },
  { httpApiStatus: 409 }
) {}

/**
 * How an attempt is made and stopped, on a path the host observes: a
 * conversation with its session made (`begin`), the description submitted
 * to it (`submit`), and the session interrupted (`interrupt`). Two steps
 * rather than one so the runner can record the attempt between them.
 */
export interface Attempts {
  readonly begin: (
    task: Task.Record,
    title: string
  ) => Effect.Effect<Conversation.Record, AgentNotFoundError | WorkbenchStorageError | AgentProtocol.RemoteError>
  readonly submit: (
    task: Task.Record,
    conversation: Conversation.Record
  ) => Effect.Effect<string, AgentProtocol.RemoteError>
  readonly interrupt: (
    owner: Task.Record["ownerId"],
    conversationId: ConversationId
  ) => Effect.Effect<void, AgentProtocol.RemoteError>
}

export class TaskAttempts extends Context.Service<TaskAttempts, Attempts>()("workbench/TaskAttempts") {}

/** Start the next attempt: a conversation on the task's agent, and its description submitted. */
export const start = Effect.fn("TaskRunner.start")(function*(task: Task.Record) {
  const tasks = yield* TaskStore
  const attempts = yield* TaskAttempts
  if (!Task.canStart(task.status)) {
    return yield* new TaskNotStartableError({ taskId: task.id, status: task.status })
  }
  const earlier = yield* tasks.attempts(task.id)
  const conversation = yield* attempts.begin(task, `${task.title} (attempt ${earlier.length + 1})`)
  // Recorded before anything is submitted: the session's first event may be
  // a question asked at once, and the follower must find the attempt then.
  const recorded = yield* tasks.startAttempt({
    taskId: task.id,
    agentRevisionId: conversation.agentRevisionId,
    conversationId: conversation.id,
    sessionId: conversation.sessionId
  })
  const submissionId = yield* attempts.submit(task, conversation)
  const stamped = yield* tasks.recordSubmission(conversation.sessionId, submissionId)
  // Settled before the stamp could land -- the run was that quick. The attempt as recorded is still the answer.
  return Option.getOrElse(stamped, () => recorded)
})

/** Interrupt the live attempt. The task settles as `canceled` when the session reports the interruption. */
export const cancel = Effect.fn("TaskRunner.cancel")(function*(task: Task.Record) {
  const tasks = yield* TaskStore
  const attempts = yield* TaskAttempts
  if (!Task.isLive(task.status)) {
    return yield* new TaskNotStartableError({ taskId: task.id, status: task.status })
  }
  const live = (yield* tasks.attempts(task.id)).find((attempt) => Option.isNone(attempt.finishedAt))
  if (live === undefined) {
    // Marked live with nothing in flight: an attempt the process lost between two writes. Settle it.
    yield* tasks.setStatus(task.id, "canceled")
    return
  }
  yield* attempts.interrupt(task.ownerId, live.conversationId)
})

/**
 * Keep task status current from the host's events. Only sessions with a
 * live attempt are looked at; everything else is someone's conversation.
 */
export const follow: (
  tasks: TaskStore["Service"],
  events: Stream.Stream<AgentProtocol.HostEvent, never>
) => Effect.Effect<void, WorkbenchStorageError> = Effect.fn("TaskRunner.follow")(function*(tasks, events) {
  yield* Stream.runForEach(events, (hostEvent): Effect.Effect<void, WorkbenchStorageError> => {
    if (hostEvent._tag !== "SessionEvent") return Effect.void
    const { event, sessionId } = hostEvent.envelope
    switch (event._tag) {
      case "SubmissionCompleted":
        return tasks.finishAttempt(sessionId, "completed", "completed")
      case "SubmissionFailed":
        return tasks.finishAttempt(sessionId, "failed", "failed")
      case "SubmissionInterrupted":
        return tasks.finishAttempt(sessionId, "interrupted", "canceled")
      case "ElicitationRequested":
        return statusIfLive(tasks, sessionId, "waiting")
      case "ElicitationResolved":
        return statusIfLive(tasks, sessionId, "running")
      default:
        return Effect.void
    }
  })
})

const statusIfLive = (tasks: TaskStore["Service"], sessionId: string, status: Task.Status) =>
  Effect.flatMap(tasks.liveAttemptOf(sessionId), (live) =>
    Option.match(live, {
      onNone: () => Effect.void,
      onSome: (attempt) =>
        tasks.setStatus(attempt.taskId, status).pipe(
          Effect.asVoid,
          // The task went away under a live attempt; nothing to keep current.
          Effect.catchTag("TaskNotFoundError", () => Effect.void)
        )
    }))
