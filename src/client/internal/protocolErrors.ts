import { Schema } from "effect"
import { SessionId } from "../../internal/ids.js"

/**
 * The protocol's own failures, in the one module both seams can import.
 *
 * These belong, by meaning, with `AgentProtocol` -- they are what a protocol
 * adapter is allowed to say -- and they are needed by `AgentClient`, because
 * `RemoteError` has to name every one of them or a transport has no honest
 * way to report a 403. `AgentProtocol` already imports `AgentClient`, so
 * declaring them there and importing them back would put a cycle around a
 * `Schema.Union` evaluated at module initialisation: whichever module loaded
 * second would union over `undefined`.
 *
 * `src/Errors.ts`, beside `AgentBusyError`, was the other candidate and was
 * rejected: `src/index.ts` re-exports that module wholesale, so moving eight
 * classes there would add eight names to the package root -- a public-surface
 * change nobody asked for, to fix an import order.
 *
 * So they live here, internal and dependency-free, and `AgentProtocol`
 * re-exports every one of them. Every existing import path is unchanged.
 *
 * `Operation` and `RequestId` come along because the errors are typed in terms
 * of them; they are re-exported from `AgentProtocol` the same way.
 */

/** Identifies one mutation so a retry cannot execute it twice. */
export const RequestId = Schema.String.pipe(
  Schema.brand("@doeixd/effect-agent/RequestId")
)
export type RequestId = typeof RequestId.Type

/**
 * Operations named in authorization and wire-level validation failures.
 *
 * The distinctions here are the ones a policy can act on, so an operation
 * earns a name when granting it would grant something a neighbouring name does
 * not. `configure` is separate from `status` for that reason: reading a task's
 * state and registering a webhook that will be *sent* that state are different
 * powers, and the second outlives the grant.
 */
export const Operation = Schema.Literals([
  "createSession",
  "closeSession",
  "getSession",
  "prompt",
  /** Admit a submission and return its receipt. A write, like `prompt`. */
  "submit",
  /** Wait for a submission's outcome. A read: it changes nothing. */
  "awaitSubmission",
  "steer",
  "followUp",
  "interrupt",
  "respond",
  "pending",
  "history",
  "status",
  "events",
  /** Enumerate the host's sessions. A read, addressed to the host, not a session. */
  "listSessions",
  /** Read the retained event log of one session, finitely. A read. */
  "eventLog",
  /**
   * Change delivery configuration -- push notification targets and the like.
   *
   * A write, and a data-egress one: the caller supplies a URL the server will
   * later send task content to. Authorizing it as a read would let a read-only
   * principal arrange for updates to keep arriving after their access ends.
   */
  "configure",
  /**
   * Subscribe to every hosted session at once. A read, addressed to the host.
   *
   * Named apart from `events` because granting a stream over *every* session
   * is not the grant `events` is. `events` is per session, so a policy can
   * decide it session by session and refuse the ones a principal has no
   * business reading; this one cannot be narrowed that way once given. Same
   * reasoning as `listSessions`, one step further -- that tells a caller which
   * sessions exist, this hands them the contents.
   *
   * Worth knowing if you maintain an authorization function written as a
   * `switch` with a permissive `default`: this literal is new, so such a
   * policy grants it without anyone deciding to. Deny-by-default policies and
   * explicit allowlists are unaffected.
   */
  "hostEvents"
])
export type Operation = typeof Operation.Type

/** A create request named a session that is already open. */
export class AgentSessionAlreadyExistsError extends Schema.TaggedError<AgentSessionAlreadyExistsError>()(
  "AgentSessionAlreadyExistsError",
  { sessionId: SessionId }
) {
  override get message() {
    return `Session ${this.sessionId} already exists`
  }
}

/** A request id was reused for a different mutation payload. */
export class AgentRequestConflictError extends Schema.TaggedError<AgentRequestConflictError>()(
  "AgentRequestConflictError",
  { sessionId: Schema.Option(SessionId), requestId: RequestId }
) {
  override get message() {
    return `Request ${this.requestId} was already used for a different mutation`
  }
}

/** Every retained request for a session is still running. */
export class AgentRequestCapacityExceededError extends Schema.TaggedError<AgentRequestCapacityExceededError>()(
  "AgentRequestCapacityExceededError",
  { sessionId: Schema.Option(SessionId), capacity: Schema.Natural }
) {
  override get message() {
    return `All ${this.capacity} retained request slots are still in flight`
  }
}

/** No authenticated principal was available for a protected operation. */
export class AgentUnauthorizedError extends Schema.TaggedError<AgentUnauthorizedError>()(
  "AgentUnauthorizedError",
  { operation: Operation }
) {
  override get message() {
    return `Authentication is required to ${this.operation}`
  }
}

/** The authenticated principal may not perform the requested operation. */
export class AgentForbiddenError extends Schema.TaggedError<AgentForbiddenError>()(
  "AgentForbiddenError",
  { operation: Operation, sessionId: Schema.Option(SessionId) }
) {
  override get message() {
    return `The authenticated principal may not ${this.operation}`
  }
}

/** The host cannot acquire another live session. */
export class AgentCapacityExceededError extends Schema.TaggedError<AgentCapacityExceededError>()(
  "AgentCapacityExceededError",
  { capacity: Schema.Natural }
) {
  override get message() {
    return `The session host has reached its capacity of ${this.capacity}`
  }
}

/** A request was well-formed at the transport level but invalid for the API. */
export class AgentInvalidRequestError extends Schema.TaggedError<AgentInvalidRequestError>()(
  "AgentInvalidRequestError",
  { operation: Operation, detail: Schema.String }
) {
  override get message() {
    return `Invalid ${this.operation} request: ${this.detail}`
  }
}

/** A typed protocol value could not cross its declared codec boundary. */
export class AgentProtocolCodecError extends Schema.TaggedError<AgentProtocolCodecError>()(
  "AgentProtocolCodecError",
  {
    operation: Operation,
    phase: Schema.Literals(["request", "response"]),
    detail: Schema.String
  }
) {
  override get message() {
    return `Could not encode the ${this.operation} ${this.phase}: ${this.detail}`
  }
}
