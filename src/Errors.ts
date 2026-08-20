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
 * Raised when a tool requires approval, which v0.1 does not implement.
 *
 * Effect AI lets a tool declare `needsApproval`, and its own resolver honours
 * that. The harness resolves tools itself (PLAN §16), so it would otherwise
 * bypass the check silently — a tool marked as needing approval would simply
 * run. Failing loudly is the only safe reading of a safety annotation the
 * runtime cannot yet satisfy.
 *
 * Approval belongs to a later interrupts capability; until then this is how the
 * harness refuses to weaken a tool's declared semantics.
 */
export class ToolApprovalRequiredError extends Schema.TaggedError<ToolApprovalRequiredError>()(
  "ToolApprovalRequiredError",
  {
    toolName: Schema.String,
    toolCallId: Schema.String
  }
) {
  override get message() {
    return `Tool ${this.toolName} requires approval, which is not supported`
  }
}
