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
 * A tool annotated `ToolExecution.Alone` arrived in a turn with other calls.
 *
 * Not a permission answer and not the handler's failure: the model's own
 * mistake, and a recoverable one, so it is always returned to the model as
 * the call's result and never fails the run. None of the batch ran: its
 * siblings each get a `ToolBatchRejectedError`. `siblings` is how many other
 * calls came with it.
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
      `Tool ${this.toolName} must be the only call in its turn. ${this.siblings} other ` +
      `call${this.siblings === 1 ? "" : "s"} arrived with it, so none of them was run. ` +
      `Call it again, alone.`
    )
  }
}

/**
 * A call that was not run because a `ToolExecution.Alone` tool arrived in the
 * same turn.
 *
 * The whole batch is rejected before anything starts, rather than running the
 * siblings and refusing only the `Alone` call: an `Alone` tool decides what
 * happens *next* (the run's answer, a new context window), so a sibling's side
 * effect beside it is never what the model should have asked for. Like
 * `ToolNotAloneError`, always returned to the model. `exclusive` names the
 * `Alone` tools that caused it.
 */
export class ToolBatchRejectedError extends Schema.TaggedError<ToolBatchRejectedError>()(
  "ToolBatchRejectedError",
  {
    toolName: Schema.String,
    toolCallId: Schema.String,
    exclusive: Schema.Array(Schema.String)
  }
) {
  override get message() {
    return (
      `Tool ${this.toolName} was not run: ${this.exclusive.join(", ")} must be the only call in its turn, ` +
      `and nothing in a turn that breaks that rule runs. Make the calls you still need first, then ` +
      `call ${this.exclusive.join(", ")} alone.`
    )
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
 * And fault injection could not say
 * anything. A wrapper that fails a write, duplicates a record or half-commits
 * produces one observation through an `orDie`d store -- a defect -- so the
 * suite can prove the system noticed and nothing about *how* it degraded.
 * The invariant that storage failure degrades rather than corrupts was
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
 * is bounded, and an evicted outcome is
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

/**
 * An observer fell too far behind, and its stream was ended rather than
 * letting it retain the session's events without bound.
 *
 * An *observation* failure, not the submission's: the run it was watching
 * is unaffected and so is the journal. `lastDelivered` is the last sequence
 * the stream handed out before it ended -- an upper bound on what the peer
 * parsed -- and a consumer resumes with `events({ after })` from the last
 * sequence it actually saw, where a delivery log stands behind the session.
 * Retrying the observation is right; resubmitting is not.
 */
export class AgentObservationLagError extends Schema.TaggedError<AgentObservationLagError>()(
  "AgentObservationLagError",
  {
    sessionId: Schema.String,
    lastDelivered: Schema.Number,
    retainedEnvelopes: Schema.Number,
    retainedBytes: Schema.Number,
    maxEnvelopes: Schema.Number,
    maxBytes: Schema.Number
  }
) {
  override get message() {
    return `Observer of session ${this.sessionId} fell behind: ${this.retainedEnvelopes} envelopes / ${this.retainedBytes} bytes retained ` +
      `(bound ${this.maxEnvelopes} / ${this.maxBytes}); last delivered sequence ${this.lastDelivered}`
  }
}

/**
 * A run reached a built-in ceiling under a policy that says exhaustion is a
 * failure.
 *
 * Only raised by `onExhaustion: "fail"`. The default is still to stop, because
 * a run that used its whole allowance and produced an answer has not gone
 * wrong -- it did exactly what it was told. This exists for the caller who
 * cannot use a truncated result and would rather be told than inspect
 * `Result.exhaustion` and remember to.
 *
 * `exhaustion` names which ceiling; `reason` carries the loop's own prose for
 * it, so a log line does not lose what `stopReason` would have said.
 */
export class AgentExhaustedError extends Schema.TaggedError<AgentExhaustedError>()(
  "AgentExhaustedError",
  {
    exhaustion: Schema.Literals(["turns", "tool-calls", "duration", "tokens", "cost"]),
    reason: Schema.optional(Schema.String)
  }
) {
  override get message() {
    return this.reason === undefined
      ? `The run was exhausted: ${this.exhaustion}`
      : `The run was exhausted: ${this.exhaustion} (${this.reason})`
  }
}

/**
 * A submission produced more tool progress than its budget allows.
 *
 * Distinct from `AgentObservationLagError`, which bounds how far an *observer*
 * may fall behind, and from the bound on a tool's terminal result. This one
 * bounds what the agent *produces*: a tool emitting progress in a loop costs
 * network, storage and telemetry even when every consumer is keeping up, and a
 * replaying handle or a delivery log has to hold all of it.
 *
 * The budget is per submission rather than per run, because a follow-up chain
 * is one externally admitted unit of work -- a per-run budget would let one
 * submission emit without limit simply by scheduling continuations.
 *
 * Progress is not truncated to fit. A structured snapshot cut in half is
 * usually a lie, and a consumer cannot tell it from a real one, so the
 * offending call fails instead and already committed history is untouched.
 */
export class AgentToolProgressLimitError extends Schema.TaggedError<AgentToolProgressLimitError>()(
  "AgentToolProgressLimitError",
  {
    submissionId: Schema.String,
    toolName: Schema.String,
    toolCallId: Schema.String,
    observedBytes: Schema.Number,
    maxBytes: Schema.Number
  }
) {
  override get message() {
    return `Tool ${this.toolName} (call ${this.toolCallId}) took submission ${this.submissionId} past its ` +
      `progress budget: ${this.observedBytes} bytes emitted, limit ${this.maxBytes}`
  }
}

/**
 * A one-shot handle's retained trace outgrew its bound, so the trace it can
 * replay is no longer the complete one.
 *
 * Raised by `Agent.start`'s `events`, and by nothing else: the submission
 * itself continues, canonical history is unaffected, and a durable delivery
 * log is unaffected. Observation stays observational.
 *
 * It is a failure rather than a silently truncated stream because the
 * attraction of a replayable handle is that a late observer sees *everything*
 * that happened. A trace that quietly dropped its oldest envelopes would still
 * look like a complete one, which is the more expensive mistake.
 */
export class AgentTraceLimitError extends Schema.TaggedError<AgentTraceLimitError>()(
  "AgentTraceLimitError",
  {
    submissionId: Schema.String,
    retainedEnvelopes: Schema.Number,
    retainedBytes: Schema.Number,
    maxEnvelopes: Schema.Number,
    maxBytes: Schema.Number
  }
) {
  override get message() {
    return `Trace of submission ${this.submissionId} outgrew its bound: ${this.retainedEnvelopes} envelopes / ` +
      `${this.retainedBytes} bytes retained (bound ${this.maxEnvelopes} / ${this.maxBytes}). ` +
      `The submission is unaffected; only this trace is incomplete.`
  }
}
