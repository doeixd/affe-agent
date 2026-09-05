import { Schema } from "effect"
import { SessionId, SubmissionId } from "./internal/ids.js"

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
/**
 * A tool annotated `ToolExecution.Alone` arrived in a turn with other calls.
 *
 * Not a permission answer and not the handler's failure: the model's own
 * mistake, and a recoverable one, so it is always returned to the model as
 * the call's result -- the siblings run, this one did not -- and never fails
 * the run. `siblings` is how many other calls came with it.
 */
export class ToolNotAloneError extends Schema.TaggedError<ToolNotAloneError>()(
  "ToolNotAloneError",
  {
    toolName: Schema.String,
    toolCallId: Schema.String,
    siblings: Schema.Number
  }
) {
  override get message() {
    return (
      `Tool ${this.toolName} must be the only call in its turn; it was not run because ` +
      `${this.siblings} other call${this.siblings === 1 ? "" : "s"} arrived with it. Call it again, alone.`
    )
  }
}

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

/**
 * The store failed, or gave back something it could not have written.
 *
 * ## Why this exists
 *
 * The durable stores used to convert every failure into a defect with
 * `Effect.orDie`, so their interfaces read `Effect.Effect<SessionRecord>` --
 * no error channel at all. That is a stronger claim than `unknown` in an error
 * channel, and a false one: there is a database on the other side.
 *
 * Two costs followed, and both were real rather than theoretical.
 *
 * `DurableSubmission` needs to tell "the infrastructure under the agent
 * failed" from "the agent failed", because the first must not be reported to a
 * client as the submission ending. With the error channel emptied, the only
 * way left was to walk the defects and pattern-match their shapes -- checking
 * `_tag === "SqlError"` and, failing that, whether a `name` string *contains*
 * `"SqlError"`. That check reconstructs, unreliably, exactly the information
 * `orDie` threw away.
 *
 * And the durability plan's fault-injection milestone (H4) could not say
 * anything. A wrapper that fails a write, duplicates a record or half-commits
 * produces one observation through an `orDie`d store -- a defect -- so the
 * suite can prove the system noticed and nothing about *how* it degraded.
 * Invariant D7 ("storage failure degrades, it does not corrupt") was
 * untestable by construction.
 *
 * ## What is still a defect
 *
 * Not everything moved. Encoding a value the process just built stays
 * `orDie`: if a `Prompt` we assembled cannot be encoded by its own schema,
 * that is a bug in this library, not a condition a caller can act on. The
 * distinction this type draws is between *our* mistakes and *the world's*.
 *
 * Lives here rather than in `/durable` because it is not durability-specific:
 * `/state` persists through a `Store` too, and a second error meaning the same
 * thing is exactly the duplication this audit set out to remove.
 *
 * @see `docs/audit-effect-ecosystem.md` E14
 */
export class StorageError extends Schema.TaggedError<StorageError>()(
  "StorageError",
  {
    /** What was being attempted, e.g. `claim`, `getOrCreate`, `decodeHistory`. */
    operation: Schema.String,
    /** The session the operation concerned, where one applies. */
    sessionId: Schema.optional(Schema.String),
    detail: Schema.String
  }
) {
  override get message() {
    const where = this.sessionId === undefined ? "" : ` for session ${this.sessionId}`
    return `Storage operation ${this.operation}${where} failed: ${this.detail}`
  }
}

/**
 * Whether a value is a `StorageError`.
 *
 * Structural rather than `instanceof`, because a store failure can cross a
 * workflow journal and come back as a decoded value rather than the original
 * instance.
 */
export const isStorageError = (u: unknown): u is StorageError =>
  typeof u === "object" &&
  u !== null &&
  (u as { readonly _tag?: unknown })._tag === "StorageError"

/**
 * `awaitSubmission` named a submission the session does not hold.
 *
 * Either it never existed here, or its outcome has been evicted: retention
 * is bounded (`docs/plan-submit-await.md`), and an evicted outcome is
 * reported as gone rather than re-run or confused with another's.
 */
export class AgentSubmissionNotFoundError extends Schema.TaggedError<AgentSubmissionNotFoundError>()(
  "AgentSubmissionNotFoundError",
  { sessionId: SessionId, submissionId: SubmissionId }
) {
  override get message() {
    return `Session ${this.sessionId} holds no submission ${this.submissionId}`
  }
}
