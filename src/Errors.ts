import { Schema } from "effect"
import { SessionId } from "./internal/ids.js"

/**
 * Harness errors are Schema classes rather than plain `Data.TaggedError`.
 *
 * They remain ordinary yieldable Effect errors, but they also carry a codec, so
 * an RPC or HTTP boundary can transport them without a parallel set of wire
 * types. That matters as soon as a session is driven remotely.
 *
 * `message` is a getter, never a Schema field. It stays useful for logs and
 * stack traces, and because it is derived it cannot drift from the fields it
 * describes or bloat the wire format with a string the receiver could rebuild.
 */

/**
 * Raised when an operation requires an idle session but a submission is active.
 */
export class AgentBusyError extends Schema.TaggedError<AgentBusyError>()(
  "AgentBusyError",
  { sessionId: SessionId }
) {
  override get message() {
    return `Session ${this.sessionId} is already running a submission`
  }
}

/**
 * Raised when an operation requires an active submission but the session is
 * idle.
 *
 * `steer` and `followUp` are meaningful only against active work; letting them
 * silently behave like `prompt` would blur the state machine.
 */
export class AgentIdleError extends Schema.TaggedError<AgentIdleError>()(
  "AgentIdleError",
  {
    sessionId: SessionId,
    operation: Schema.Literals(["steer", "followUp", "interrupt"])
  }
) {
  override get message() {
    return `Cannot ${this.operation} on idle session ${this.sessionId}`
  }
}

/** Raised when a session's scope has closed. */
export class AgentClosedError extends Schema.TaggedError<AgentClosedError>()(
  "AgentClosedError",
  { sessionId: SessionId }
) {
  override get message() {
    return `Session ${this.sessionId} is closed`
  }
}

/**
 * A tool call that needed approval and did not get it.
 *
 * The question was asked -- through `Elicitation` -- and the answer was no.
 * See `Permission` for how the question comes to be asked.
 */
export class ToolApprovalRequiredError extends Schema.TaggedError<ToolApprovalRequiredError>()(
  "ToolApprovalRequiredError",
  {
    toolName: Schema.String,
    toolCallId: Schema.String
  }
) {
  override get message() {
    return `Tool ${this.toolName} requires approval, and it was not granted`
  }
}

/**
 * A tool call the permission policy refused.
 *
 * Distinct from `ToolApprovalRequiredError`, which is a question that was
 * asked and answered "no". A denial was never a question: the policy -- or
 * the tool's own projection -- said this action on this resource is not
 * permitted here. `reason` is the policy's word, when it gave one.
 */
export class ToolPermissionDeniedError extends Schema.TaggedError<ToolPermissionDeniedError>()(
  "ToolPermissionDeniedError",
  {
    toolName: Schema.String,
    toolCallId: Schema.String,
    action: Schema.String,
    resource: Schema.String,
    reason: Schema.optional(Schema.String)
  }
) {
  override get message() {
    return (
      `Tool ${this.toolName} was denied: ${this.action} on ${this.resource}` +
      (this.reason === undefined ? "" : ` (${this.reason})`)
    )
  }
}
