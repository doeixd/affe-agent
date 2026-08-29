import { Effect, Option, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as AgentEvent from "../AgentEvent.js"
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
  AgentProtocolCodecError
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

export const PromptRequest = Schema.Struct({
  requestId: RequestId,
  sessionId: SessionId,
  input: PromptWire.Prompt,
  options: Schema.optional(RemotePromptOptions)
})
export type PromptRequest = typeof PromptRequest.Type

export const PromptResponse = Schema.Struct({
  requestId: RequestId,
  result: RemoteResult
})
export type PromptResponse = typeof PromptResponse.Type

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

export const EventsResponse = AgentEventEnvelope
export type EventsResponse = typeof EventsResponse.Type
