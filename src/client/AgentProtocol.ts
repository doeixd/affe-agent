import { Effect, Option, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as AgentEvent from "../AgentEvent.js"
import * as AgentInput from "../AgentInput.js"
import * as Elicitation from "../Elicitation.js"
import * as PromptWire from "../PromptWire.js"
import {
  AgentBusyError,
  AgentClosedError,
  AgentIdleError
} from "../Errors.js"
import {
  SessionId as SessionIdSchema,
  SubmissionId as SubmissionIdSchema
} from "../internal/ids.js"
import * as AgentClient from "./AgentClient.js"
import * as ProtocolErrors from "./internal/protocolErrors.js"

/**
 * The schema-owned contract shared by remote session transports.
 *
 * RPC, HTTP/SSE, AG-UI and A2A may encode these values differently, but they
 * must not invent different meanings for a session operation. Public client
 * helpers accept `Prompt.RawInput` and normalize it with `Prompt.make` before
 * constructing one of these wire requests.
 */

export const SessionId = SessionIdSchema
export type SessionId = typeof SessionId.Type

export const SubmissionId = SubmissionIdSchema
export type SubmissionId = typeof SubmissionId.Type

/**
 * The protocol's vocabulary of failures, declared one module down.
 *
 * `AgentClient.RemoteError` has to name every one of these -- a transport that
 * cannot say "forbidden" reports a 403 as a retryable transport failure -- and
 * this module already imports `AgentClient`. Declaring them here and importing
 * them back would put a cycle around a `Schema.Union` built at module
 * initialisation. They therefore live in `internal/protocolErrors.ts`, which
 * depends on nothing, and are re-exported here: this is still where they are
 * *named*, and every existing `AgentProtocol.AgentForbiddenError` import is
 * unchanged.
 */
export const RequestId = ProtocolErrors.RequestId
export type RequestId = ProtocolErrors.RequestId

export const Operation = ProtocolErrors.Operation
export type Operation = ProtocolErrors.Operation

/** Transport-neutral context evaluated before every protected operation. */
export interface AuthorizationContext<Principal> {
  readonly principal: Principal
  readonly operation: Operation
  readonly sessionId: Option.Option<SessionId>
}

export type AuthorizationError =
  | AgentUnauthorizedError
  | AgentForbiddenError

export interface Authorization<Principal> {
  readonly authorize: (
    context: AuthorizationContext<Principal>
  ) => Effect.Effect<void, AuthorizationError>
}

/** Options that have a stable representation across a process boundary. */
export const RemotePromptOptions = Schema.Struct({
  stream: Schema.optional(Schema.Boolean)
})
export type RemotePromptOptions = typeof RemotePromptOptions.Type

/** Reuse the existing transport-safe submission projection. */
export const RemoteResult = AgentClient.RemoteResult
export type RemoteResult = typeof RemoteResult.Type

export const SessionStatus = Schema.Literals(["idle", "running", "closed"])
export type SessionStatus = typeof SessionStatus.Type

export const Session = Schema.Struct({
  sessionId: SessionId,
  status: SessionStatus
})
export type Session = typeof Session.Type

/**
 * A session lookup failed without implying that the transport itself failed.
 *
 * The client service's own error, re-exported: the protocol and the service
 * must agree on what a missing session is called, or a transport would turn
 * the service's typed answer into something the service cannot name.
 */
export const AgentSessionNotFoundError = AgentClient.AgentSessionNotFoundError
export type AgentSessionNotFoundError = AgentClient.AgentSessionNotFoundError

import { AgentSubmissionNotFoundError } from "../Errors.js"
export { AgentSubmissionNotFoundError }

export const SubmissionReceipt = AgentClient.SubmissionReceipt
export type SubmissionReceipt = AgentClient.SubmissionReceipt

/** A create request named a session that is already open. */
export const AgentSessionAlreadyExistsError = ProtocolErrors.AgentSessionAlreadyExistsError
export type AgentSessionAlreadyExistsError = ProtocolErrors.AgentSessionAlreadyExistsError

/** A request id was reused for a different mutation payload. */
export const AgentRequestConflictError = ProtocolErrors.AgentRequestConflictError
export type AgentRequestConflictError = ProtocolErrors.AgentRequestConflictError

/** Every retained request for a session is still running. */
export const AgentRequestCapacityExceededError = ProtocolErrors.AgentRequestCapacityExceededError
export type AgentRequestCapacityExceededError = ProtocolErrors.AgentRequestCapacityExceededError

/** No authenticated principal was available for a protected operation. */
export const AgentUnauthorizedError = ProtocolErrors.AgentUnauthorizedError
export type AgentUnauthorizedError = ProtocolErrors.AgentUnauthorizedError

/** The authenticated principal may not perform the requested operation. */
export const AgentForbiddenError = ProtocolErrors.AgentForbiddenError
export type AgentForbiddenError = ProtocolErrors.AgentForbiddenError

/** The host cannot acquire another live session. */
export const AgentCapacityExceededError = ProtocolErrors.AgentCapacityExceededError
export type AgentCapacityExceededError = ProtocolErrors.AgentCapacityExceededError

/** A request was well-formed at the transport level but invalid for the API. */
export const AgentInvalidRequestError = ProtocolErrors.AgentInvalidRequestError
export type AgentInvalidRequestError = ProtocolErrors.AgentInvalidRequestError

/** A typed protocol value could not cross its declared codec boundary. */
export const AgentProtocolCodecError = ProtocolErrors.AgentProtocolCodecError
export type AgentProtocolCodecError = ProtocolErrors.AgentProtocolCodecError

/** Every anticipated failure that a protocol adapter may encode. */
export const RemoteError = Schema.Union([
  AgentBusyError,
  AgentIdleError,
  AgentClosedError,
  AgentClient.AgentExecutionError,
  AgentClient.AgentTransportError,
  AgentSessionNotFoundError,
  AgentSessionAlreadyExistsError,
  AgentRequestConflictError,
  AgentRequestCapacityExceededError,
  AgentUnauthorizedError,
  AgentForbiddenError,
  AgentCapacityExceededError,
  AgentInvalidRequestError,
  AgentProtocolCodecError,
  AgentSubmissionNotFoundError
])
export type RemoteError = typeof RemoteError.Type

export const CreateSessionRequest = Schema.Struct({
  requestId: RequestId,
  sessionId: Schema.optional(SessionId)
})
export type CreateSessionRequest = typeof CreateSessionRequest.Type

export const CreateSessionResponse = Schema.Struct({
  requestId: RequestId,
  session: Session
})
export type CreateSessionResponse = typeof CreateSessionResponse.Type

export const CloseSessionRequest = Schema.Struct({
  requestId: RequestId,
  sessionId: SessionId
})
export type CloseSessionRequest = typeof CloseSessionRequest.Type

export const CloseSessionResponse = Schema.Struct({
  requestId: RequestId,
  closed: Schema.Boolean
})
export type CloseSessionResponse = typeof CloseSessionResponse.Type

export const GetSessionRequest = Schema.Struct({ sessionId: SessionId })
export type GetSessionRequest = typeof GetSessionRequest.Type

export const GetSessionResponse = Session
export type GetSessionResponse = typeof GetSessionResponse.Type

/**
 * What a prompt or submit carries: the session's encoded input, one shape
 * on the wire.
 *
 * On the wire it is JSON that names no schema; the host decodes it with the
 * schema the session's agent declares (`inputBoundary`). For the default
 * input that JSON is the prompt wire, so an untyped client's request is
 * byte for byte what it was when this was a union of a tagged typed value
 * and the prompt (`test/InputWire.test.ts` holds the recorded bytes); a
 * declared input's value travels bare, where it used to be tagged.
 *
 * In memory it is a `Prompt` or the encoded value, which is what the union
 * below is for: a caller building a request by hand -- the generated HTTP
 * client, a test -- writes `Prompt.make(...)` and this codec encodes it, as
 * it always did; anything else passes through as the JSON it already is.
 * Decoding tries the prompt wire first, so a prompt arrives as a `Prompt`
 * and anything else as itself. The one thing a declared input's schema must
 * therefore not do is encode to something that decodes as a prompt wire
 * (`{ content: [messages] }`); nothing does, and nothing should.
 */
export const Input = Schema.Union([PromptWire.Prompt, Schema.Unknown])
export type Input = typeof Input.Type

/** A `RemoteInput` as a request carries it: a raw prompt normalised, an encoded value as it is. */
export const input = (raw: AgentClient.RemoteInput): Input =>
  AgentInput.isRaw(raw) ? Prompt.make(raw) : raw

export const PromptRequest = Schema.Struct({
  requestId: RequestId,
  sessionId: SessionId,
  input: Input,
  options: Schema.optional(RemotePromptOptions)
})
export type PromptRequest = typeof PromptRequest.Type

export const PromptResponse = Schema.Struct({
  requestId: RequestId,
  result: RemoteResult
})
export type PromptResponse = typeof PromptResponse.Type

/** The same request as a prompt; the difference is when the caller gets an answer. */
export const SubmitRequest = Schema.Struct({
  requestId: RequestId,
  sessionId: SessionId,
  input: Input,
  options: Schema.optional(RemotePromptOptions)
})
export type SubmitRequest = typeof SubmitRequest.Type

export const SubmitResponse = Schema.Struct({
  requestId: RequestId,
  submissionId: SubmissionId
})
export type SubmitResponse = typeof SubmitResponse.Type

export const AwaitSubmissionRequest = Schema.Struct({
  sessionId: SessionId,
  submissionId: SubmissionId
})
export type AwaitSubmissionRequest = typeof AwaitSubmissionRequest.Type

export const AwaitSubmissionResponse = Schema.Struct({ result: RemoteResult })
export type AwaitSubmissionResponse = typeof AwaitSubmissionResponse.Type

export const SteerRequest = Schema.Struct({
  requestId: RequestId,
  sessionId: SessionId,
  input: PromptWire.Prompt
})
export type SteerRequest = typeof SteerRequest.Type

export const FollowUpRequest = Schema.Struct({
  requestId: RequestId,
  sessionId: SessionId,
  input: PromptWire.Prompt
})
export type FollowUpRequest = typeof FollowUpRequest.Type

export const InterruptRequest = Schema.Struct({
  requestId: RequestId,
  sessionId: SessionId
})
export type InterruptRequest = typeof InterruptRequest.Type

export const RespondRequest = Schema.Struct({
  requestId: RequestId,
  sessionId: SessionId,
  response: Elicitation.Response
})
export type RespondRequest = typeof RespondRequest.Type

export const MutationResponse = Schema.Struct({
  requestId: RequestId,
  accepted: Schema.Boolean
})
export type MutationResponse = typeof MutationResponse.Type

export const SteerResponse = MutationResponse
export type SteerResponse = typeof SteerResponse.Type

export const FollowUpResponse = MutationResponse
export type FollowUpResponse = typeof FollowUpResponse.Type

export const InterruptResponse = MutationResponse
export type InterruptResponse = typeof InterruptResponse.Type

export const RespondResponse = Schema.Struct({
  requestId: RequestId,
  matched: Schema.Boolean
})
export type RespondResponse = typeof RespondResponse.Type

export const PendingRequest = Schema.Struct({ sessionId: SessionId })
export type PendingRequest = typeof PendingRequest.Type

export const PendingResponse = Schema.Struct({
  requests: Schema.Array(Elicitation.Request)
})
export type PendingResponse = typeof PendingResponse.Type

export const HistoryRequest = Schema.Struct({ sessionId: SessionId })
export type HistoryRequest = typeof HistoryRequest.Type

export const HistoryResponse = Schema.Struct({ history: PromptWire.Prompt })
export type HistoryResponse = typeof HistoryResponse.Type

/** One hosted session, as the registry lists it. */
export const SessionSummary = Schema.Struct({ sessionId: SessionId, status: SessionStatus })
export type SessionSummary = typeof SessionSummary.Type

export const SessionsResponse = Schema.Struct({ sessions: Schema.Array(SessionSummary) })
export type SessionsResponse = typeof SessionsResponse.Type

export const StatusRequest = Schema.Struct({ sessionId: SessionId })
export type StatusRequest = typeof StatusRequest.Type

export const StatusResponse = Schema.Struct({ status: SessionStatus })
export type StatusResponse = typeof StatusResponse.Type

/**
 * Where an event subscription should start.
 *
 * `after` is absent for "from now", and carries the last sequence the caller
 * saw for a resumption -- exclusive, so the first event delivered is the one
 * above it. That is what SSE's `Last-Event-ID` means and what `DeliveryLog`
 * means by the same name, so the number travels unchanged from a browser's
 * reconnect header to the log read.
 *
 * Optional rather than a second request type: every transport already carries
 * this shape, and a parallel `ResumeEventsRequest` would double the surface to
 * express one number.
 */
export const EventsRequest = Schema.Struct({
  sessionId: SessionId,
  after: Schema.optional(Schema.Number)
})
export type EventsRequest = typeof EventsRequest.Type

/** The existing event envelope is already schema-defined and session ordered. */
export const AgentEventEnvelope = AgentEvent.AgentEventEnvelope
export type AgentEventEnvelope = typeof AgentEventEnvelope.Type

/**
 * A finite read of a session's retained events.
 *
 * `after` is the same number `Last-Event-ID` and `DeliveryLog.read` carry:
 * the last sequence the caller has. It is never silently downgraded -- a
 * caller resuming from before what the host still holds is refused, not
 * handed a stream with a gap in it.
 */
export const EventLogRequest = Schema.Struct({
  sessionId: SessionId,
  after: Schema.optional(Schema.Number)
})
export type EventLogRequest = typeof EventLogRequest.Type

export const EventLogResponse = Schema.Struct({
  events: Schema.Array(AgentEventEnvelope),
  /**
   * The first sequence the host holds for this session; absent while it
   * holds nothing. A session emits `SessionStarted` before a host can begin
   * retaining it, so this is normally 2 -- stated here rather than left for
   * the reader to infer from a first event that is not the first.
   */
  oldest: Schema.optional(Schema.Number),
  /** The newest sequence the host holds; what to pass as `after` next time. */
  latest: Schema.Number
})
export type EventLogResponse = typeof EventLogResponse.Type

export const EventsResponse = AgentEventEnvelope
export type EventsResponse = typeof EventsResponse.Type

/**
 * Why a session stopped being visible on this host.
 *
 * None of these is `SessionClosed`; see {@link SessionUnhosted}.
 */
export const UnhostReason = Schema.Literals([
  /** `closeSession` succeeded through this host. */
  "closed",
  /** The host itself is shutting down. Says nothing about the session. */
  "released",
  /** The session's event stream ran to completion. */
  "ended",
  /** The stream failed -- a transport error on a remote session. */
  "failed"
])
export type UnhostReason = typeof UnhostReason.Type

/**
 * The inventory, delivered once as the first element of the host stream.
 *
 * A subscriber attaching to a host that already has sessions would otherwise
 * receive events for sessions it was never told about, and could not build a
 * routing table. Ids only: `status` is an `Effect`, and for a remote client a
 * network call, so gathering N of them while holding the host's registry gate
 * is not something a subscribe should do. Status is what `sessions()` is for.
 */
export const HostAttached = Schema.TaggedStruct("HostAttached", {
  sessionIds: Schema.Array(SessionId)
})

/** A session became visible on this host. */
export const SessionHosted = Schema.TaggedStruct("SessionHosted", {
  sessionId: SessionId
})

/**
 * A session stopped being visible on this host.
 *
 * **A statement about this host's visibility, not about the session's
 * lifetime.** The only statement about the session's own lifetime is
 * `SessionClosed`, on the inner envelope. For a durable session even
 * `reason: "closed"` means just that this host released its handle -- the
 * session persists in its store and is reachable by id from any process.
 *
 * `reason` says which of those happened, because the pump cannot infer it: a
 * closing session's subscription is shut down, which Effect reports as a
 * `Cause.Done` defect that is indistinguishable in shape from a transport
 * dying. So whoever removes the session states the reason, and only a session
 * that left on its own is classified from what the pump saw.
 *
 * `lastSequence` is the last per-session sequence this host forwarded, so a
 * consumer can say "this projection is final at N" -- or, needing certainty
 * rather than a claim, repair from the durable log.
 *
 * There is deliberately no "did this host see `SessionClosed`" flag. One was
 * written and removed: closing a session shuts its subscription down rather
 * than delivering a final event to subscribers already attached, so the flag
 * was `false` even for a session closed through this very host. A field that
 * is always false is worse than no field, because it reads like evidence.
 */
export const SessionUnhosted = Schema.TaggedStruct("SessionUnhosted", {
  sessionId: SessionId,
  reason: UnhostReason,
  lastSequence: Schema.Option(Schema.Number)
})

/**
 * One session's event, carried on the host-wide stream.
 *
 * Wraps the envelope rather than flattening it: `AgentEventEnvelope`'s tag is
 * on `.event`, so a flat union would collide with the inner tags, and keeping
 * it whole means the value reaches `SessionProjection.reduce` unchanged.
 */
export const SessionEvent = Schema.TaggedStruct("SessionEvent", {
  envelope: AgentEventEnvelope
})

/**
 * Everything happening on a host: its sessions' events, and its own hosting
 * lifecycle.
 *
 * **Per-session order is preserved. Order across sessions is arbitrary, and
 * there is deliberately no host-wide sequence.** Such a number would record
 * which pump fibre the scheduler happened to run first, and publishing it as a
 * sequence would dress a scheduling accident up as an ordering. Making it mean
 * even *delivery* order would require a host-wide permit held across every
 * publish -- the per-session bus's serialisation point, reinstalled one level
 * up and paid on every event of every session. The one thing it would buy,
 * detecting loss, the inner `AgentEventEnvelope.sequence` already gives at
 * finer grain; that is what `SessionProjection.gap` reads.
 *
 * Live-only. `HostAttached` carries the inventory and no agent event is
 * replayed. The finite, cursored read is still `eventLog`, per session, and
 * stays there because a cursor into a nondeterministic merge would not be a
 * cursor.
 *
 * **Folding this into `SessionProjection`s: seed with `empty(id)`, never
 * `since(id, 0)`.** A session emits `SessionStarted` at sequence 1 while it is
 * still being constructed, before any host can subscribe -- the same fact
 * {@link EventLogResponse}'s `oldest` records when it says the oldest retained
 * sequence "is normally 2". Seeding with `since(id, 0)` therefore reports a
 * gap that was never a loss, and `isComplete` stays false for the life of the
 * projection.
 */
export const HostEvent = Schema.Union([
  HostAttached,
  SessionHosted,
  SessionUnhosted,
  SessionEvent
])
export type HostEvent = typeof HostEvent.Type
