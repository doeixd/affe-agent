/**
 * Tasks and attempts (plan-agent-product-control-plane.md §8).
 *
 * A task is a product work item: a thing a person wants done, by an agent.
 * It is not a kernel `Submission`. An *attempt* is one try at it -- one
 * conversation, one submission -- so "the work" and "one go at the work"
 * stay distinct, and a task can be tried again after a failure without
 * pretending the first try did not happen.
 *
 * Personal, like conversations: a task has an owner, and it runs the
 * agents that owner may use. Projects, dependencies and due dates are
 * later phases and are left off rather than stubbed.
 */
import { Schema } from "effect"
import { AgentId, AgentRevisionId, ConversationId, TaskId, UserId } from "./WorkbenchIds.js"

/**
 * The board's columns, as the plan draws them: BACKLOG | READY | RUNNING |
 * NEEDS YOU | DONE, with the ways a task leaves RUNNING spelled out. Set by
 * the runner and its projection, never by the session, which knows nothing
 * of tasks.
 */
export const Status = Schema.Literals(["backlog", "ready", "running", "waiting", "failed", "completed", "canceled"])
export type Status = typeof Status.Type

export const Record = Schema.Struct({
  id: TaskId,
  ownerId: UserId,
  agentId: AgentId,
  title: Schema.String,
  /** What the agent is asked to do: the first attempt's prompt. */
  description: Schema.String,
  status: Status,
  /** Higher runs first when a queue exists; a plain number until then. */
  priority: Schema.Int,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
})
export type Record = typeof Record.Type

export const New = Schema.Struct({
  ownerId: UserId,
  agentId: AgentId,
  title: Schema.String,
  description: Schema.String,
  priority: Schema.optional(Schema.Int)
})
export type New = typeof New.Type

/** How an attempt ended, when it has. */
export const Outcome = Schema.Literals(["completed", "failed", "interrupted"])
export type Outcome = typeof Outcome.Type

export const Attempt = Schema.Struct({
  taskId: TaskId,
  /** 1 for the first, then one more per retry. */
  attempt: Schema.Int,
  agentRevisionId: AgentRevisionId,
  /** The conversation the attempt is, so a person can open it and read along. */
  conversationId: ConversationId,
  sessionId: Schema.String,
  /**
   * `None` until the description is submitted. The attempt is recorded
   * first, so an event from the session -- a question asked at once -- finds
   * it; the id is stamped when the host answers the submit.
   */
  submissionId: Schema.Option(Schema.String),
  startedAt: Schema.DateTimeUtc,
  finishedAt: Schema.Option(Schema.DateTimeUtc),
  outcome: Schema.Option(Outcome)
})
export type Attempt = typeof Attempt.Type

/** Whether a task has an attempt in flight. */
export const isLive = (status: Status): boolean => status === "running" || status === "waiting"

/** Whether a task may be started (again): anything not in flight, a finished one included -- "run it again" is a retry. */
export const canStart = (status: Status): boolean => !isLive(status)
