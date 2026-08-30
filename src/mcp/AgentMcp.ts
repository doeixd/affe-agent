import {
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream
} from "effect"
import { McpSchema, McpServer, Prompt, Tool, Toolkit } from "effect/unstable/ai"
import { Headers, HttpServerRequest } from "effect/unstable/http"
import { AgentClient } from "../client/AgentClient.js"
import { positiveInteger } from "../internal/positive.js"
import * as Elicitation from "../Elicitation.js"
import * as Permission from "../Permission.js"
import * as Client from "../client/AgentClient.js"
import * as AgentProtocol from "../client/AgentProtocol.js"
import * as AgentSessionHost from "../client/AgentSessionHost.js"
import * as PromptWire from "../PromptWire.js"

/**
 * An agent, exposed to MCP clients as a tool.
 *
 * The interesting thing is how little of it is MCP. The handler talks to
 * `AgentClient` — the transport seam — and knows nothing about sessions,
 * scopes, or the harness. MCP is a protocol adapter over that seam, which is
 * what the seam was for.
 *
 * Only this direction is implemented. Consuming a remote MCP server's tools —
 * turning them into an Effect AI `Toolkit` — would need an MCP *client*, and
 * Effect ships `McpServer`, `McpProtocol` and `McpSchema` but no client. That
 * is a protocol implementation, not an adapter, and writing one against a
 * specification with no peer to check it against is how plausible-but-wrong
 * code gets shipped.
 */

/**
 * Conversation continuity across calls.
 *
 * MCP tool calls are individually stateless, so a client that wants a
 * conversation has to say which one. Omitting `sessionId` gives a fresh
 * session, which is the right default for a one-shot question; supplying one
 * reaches the same session again, and it lives as long as the server does.
 */
/**
 * The declared failure of every agent tool.
 *
 * Effect's `McpServer` renders a declared failure's text only when the value
 * is an `Error` (`error instanceof Error ? error.message : <internal>`); a
 * plain string failure -- which these tools declared for a long time -- is
 * shown to the client as "Tool execution failed due to an internal server
 * error", so a capacity or authorization refusal was indistinguishable from
 * a crash. Found by `test/HostConformance.test.ts`. The wire is unchanged:
 * `isError: true` with the reason as text.
 */
export class ToolFailure extends Schema.TaggedError<ToolFailure>()(
  "AgentMcpToolFailure",
  { detail: Schema.String }
) {
  override get message() {
    return this.detail
  }
}

export const AskAgent = Tool.make("ask_agent", {
  parameters: Schema.Struct({
    prompt: Schema.String,
    sessionId: Schema.optional(Schema.String)
  }),
  success: Schema.String,
  failure: ToolFailure
})


/** Begin a host-owned run and return immediately with the ticket used to await it. */
export const StartAgent = Tool.make("agent_start", {
  description:
    "Start an agent prompt without waiting. Keep the returned sessionId and requestId to steer, await, or close it.",
  parameters: Schema.Struct({
    prompt: Schema.String,
    sessionId: Schema.optional(AgentProtocol.SessionId)
  }),
  success: Schema.Struct({
    sessionId: AgentProtocol.SessionId,
    requestId: AgentProtocol.RequestId
  }),
  failure: ToolFailure
})

/** Await the exact run previously returned by `agent_start`. */
export const AwaitAgent = Tool.make("agent_await", {
  description:
    "Wait for a previously started agent prompt. Awaiting the same requestId more than once never starts another run.",
  parameters: Schema.Struct({
    requestId: AgentProtocol.RequestId
  }),
  success: AgentProtocol.RemoteResult,
  failure: ToolFailure
})

/** Release a named or generated host session when the MCP client is done with it. */
export const CloseAgent = Tool.make("agent_close", {
  description:
    "Close an agent session and release its capacity. Any active prompt in that session is interrupted.",
  parameters: Schema.Struct({
    sessionId: AgentProtocol.SessionId
  }),
  success: Schema.Boolean,
  failure: ToolFailure
})

/** Queue steering input for the run currently active in a host session. */
export const SteerAgent = Tool.make("agent_steer", {
  description:
    "Steer the active run. The input is applied at the next safe model boundary; false means the session did not accept it.",
  parameters: Schema.Struct({
    sessionId: AgentProtocol.SessionId,
    prompt: Schema.String
  }),
  success: Schema.Boolean,
  failure: ToolFailure
})

/** Queue a sequential follow-up under the active submission. */
export const FollowUpAgent = Tool.make("agent_follow_up", {
  description:
    "Queue a follow-up after the active run. The original agent_await waits through accepted follow-ups until the submission is quiet.",
  parameters: Schema.Struct({
    sessionId: AgentProtocol.SessionId,
    prompt: Schema.String
  }),
  success: Schema.Boolean,
  failure: ToolFailure
})

/** Interrupt the run active in a host session. */
export const InterruptAgent = Tool.make("agent_interrupt", {
  description:
    "Interrupt the active run. Awaiting its ticket then returns an interrupted result; cancelling an await alone does not stop the run.",
  parameters: Schema.Struct({
    sessionId: AgentProtocol.SessionId
  }),
  success: Schema.Boolean,
  failure: ToolFailure
})

/** Read the current session state and any questions waiting for an answer. */
export const StatusAgent = Tool.make("agent_status", {
  description:
    "Read a session's status and pending elicitation requests together. Use agent_respond to answer a pending request.",
  parameters: Schema.Struct({
    sessionId: AgentProtocol.SessionId
  }),
  success: Schema.Struct({
    status: AgentProtocol.SessionStatus,
    pending: Schema.Array(Elicitation.Request)
  }),
  failure: ToolFailure
})

/** Answer one question reported by `agent_status` or native MCP elicitation. */
export const RespondAgent = Tool.make("agent_respond", {
  description:
    "Answer a pending agent elicitation. False means that request was no longer waiting; a late response never starts new work.",
  parameters: Schema.Struct({
    sessionId: AgentProtocol.SessionId,
    id: Schema.String,
    granted: Schema.Boolean,
    value: Schema.optional(Schema.Unknown)
  }),
  success: Schema.Boolean,
  failure: ToolFailure
})

// The shared-host variants run inside an MCP request and may issue reverse
// elicitation calls to that exact client. The dependency stays off the
// exported tool definitions, which need no synthetic MCP request context; the
// local registration adapter below receives and discharges this request-level
// service for the frontend toolkit.
const SharedAskAgent = AskAgent.addDependency(McpSchema.McpServerClient)
const SharedAwaitAgent = AwaitAgent.addDependency(McpSchema.McpServerClient)

const RegisteredToolkit = Toolkit.make(
  StartAgent,
  CloseAgent,
  SteerAgent,
  FollowUpAgent,
  InterruptAgent,
  StatusAgent,
  RespondAgent
)

/** The frontend toolkit: every tool the host path serves. */
export const ServerToolkit = Toolkit.make(
  SharedAskAgent,
  StartAgent,
  SharedAwaitAgent,
  CloseAgent,
  SteerAgent,
  FollowUpAgent,
  InterruptAgent,
  StatusAgent,
  RespondAgent
)

class AgentMcpTicketNotFoundError extends Schema.TaggedError<AgentMcpTicketNotFoundError>()(
  "AgentMcpTicketNotFoundError",
  { requestId: AgentProtocol.RequestId }
) {
  override get message() {
    return `Agent request ticket ${this.requestId} is not retained by this MCP server`
  }
}

class AgentMcpElicitationUnsupportedError extends Schema.TaggedError<AgentMcpElicitationUnsupportedError>()(
  "AgentMcpElicitationUnsupportedError",
  {
    sessionId: AgentProtocol.SessionId,
    id: Schema.String,
    kind: Schema.String
  }
) {
  override get message() {
    return `MCP client cannot present ${this.kind} elicitation ${this.id} for session ${this.sessionId}`
  }
}

const ToolApprovalForm = Schema.Struct({
  // MCP form fields are primitive and cannot represent the `boolean | null`
  // JSON Schema Effect emits for `Schema.optional(Boolean)`.
  remember: Schema.Boolean
})

const GenericApprovalForm = Schema.Struct({
  approve: Schema.Boolean
})

const decodeApprovalDetail = Schema.decodeUnknownOption(
  Schema.toCodecJson(Permission.ApprovalDetail)
)

interface Ticket {
  readonly request: AgentProtocol.PromptRequest
  readonly result: Deferred.Deferred<
    AgentProtocol.PromptResponse,
    AgentProtocol.RemoteError
  >
  readonly completed: boolean
}

type TicketState = {
  readonly bySession: ReadonlyMap<AgentProtocol.SessionId, ReadonlyMap<AgentProtocol.RequestId, Ticket>>
  readonly byId: ReadonlyMap<AgentProtocol.RequestId, Ticket>
}

const requestId = (): AgentProtocol.RequestId =>
  AgentProtocol.RequestId.make(globalThis.crypto.randomUUID())

/**
 * Headers belonging to the current MCP request.
 *
 * Effect's MCP tool-handler context does not expose transport metadata, but an
 * HTTP handler still runs with `HttpServerRequest` in its fiber context. Read
 * it opportunistically so the same principal resolver used by the other HTTP
 * adapters sees MCP authorization headers too. Stdio has no request and
 * therefore honestly authenticates with empty headers: it is a single-user
 * process transport.
 */
const requestHeaders: Effect.Effect<Headers.Headers> = Effect.map(
  Effect.serviceOption(HttpServerRequest.HttpServerRequest),
  Option.match({
    onNone: () => Headers.empty,
    onSome: (request) => request.headers
  })
)

/**
 * Build the frontend handlers over an application-owned host.
 *
 * Deliberately private: applications compose `serverLayer`; exposing another
 * handler constructor would add public vocabulary for one consumer. Unlike
 * `handlers`, this path owns no session registry, session scope or creation
 * lock. It retains only bounded start/await tickets; session ownership,
 * mutation idempotency and capacity remain with the supplied host.
 */
const handlersFromHost = <Principal>(
  hostTag: AgentSessionHost.Tag<Principal>,
  options: {
    readonly onUnsupportedElicitation: "pending" | "deny" | "fail"
  }
) =>
  Effect.gen(function* () {
    const host = yield* hostTag
    const adapterScope = yield* Effect.scope
    const tickets = yield* Ref.make<TicketState>({ bySession: new Map(), byId: new Map() })

    const authenticate = Effect.fn("AgentMcp.authenticate")(function* (
      operation: AgentProtocol.Operation,
      sessionId: Option.Option<AgentProtocol.SessionId>
    ) {
      const headers = yield* requestHeaders
      return yield* host.resolve({ operation, sessionId, headers })
    })

    const create = Effect.fn("AgentMcp.createSession")(function* (
      principal: Principal,
      sessionId: Option.Option<AgentProtocol.SessionId>
    ) {
      const created = yield* host.createSession(principal, {
        requestId: requestId(),
        ...(Option.isSome(sessionId) ? { sessionId: sessionId.value } : {})
      })
      return created.session.sessionId
    })

    const named = Effect.fn("AgentMcp.namedSession")(function* (
      principal: Principal,
      sessionId: AgentProtocol.SessionId
    ) {
      return yield* host.session(principal, { sessionId }).pipe(
        Effect.as({ sessionId, created: false } as const),
        Effect.catchTag("AgentSessionNotFoundError", () =>
          create(principal, Option.some(sessionId)).pipe(
            Effect.map((sessionId) => ({ sessionId, created: true } as const)),
            // Two clients may discover the same missing name together. The
            // host serializes creation; the loser adopts what the winner made.
            Effect.catchTag("AgentSessionAlreadyExistsError", () =>
              host.session(principal, { sessionId }).pipe(
                Effect.as({ sessionId, created: false } as const)
              )
            )
          )
        )
      )
    })

    const close = Effect.fn("AgentMcp.closeSession")(function* (
      principal: Principal,
      sessionId: AgentProtocol.SessionId
    ) {
      const response = yield* host.closeSession(principal, {
        requestId: requestId(),
        sessionId
      })
      return response.closed
    })

    type Admission =
      | { readonly _tag: "Admitted" }
      | { readonly _tag: "Collision" }
      | { readonly _tag: "RequestFull" }
      | { readonly _tag: "SessionFull" }

    const reserveTicket = Effect.fn("AgentMcp.reserveTicket")(function* (
      sessionId: AgentProtocol.SessionId,
      promptText: string
    ) {
      while (true) {
        const id = requestId()
        const result = yield* Deferred.make<
          AgentProtocol.PromptResponse,
          AgentProtocol.RemoteError
        >()
        const request: AgentProtocol.PromptRequest = {
          requestId: id,
          sessionId,
          input: Prompt.make(promptText)
        }
        const ticket: Ticket = { request, result, completed: false }
        const admission = yield* Ref.modify(
          tickets,
          (all): readonly [Admission, TicketState] => {
            if (all.byId.has(id)) {
              return [{ _tag: "Collision" }, all]
            }

            const nextBySession = new Map(all.bySession)
            const current = all.bySession.get(sessionId) ?? new Map<
              AgentProtocol.RequestId,
              Ticket
            >()
            const nextById = new Map(all.byId)
            /**
             * Ticket retention is bounded by the host's capacity numbers.
             *
             * Borrowed rather than separately configured, and the reason is
             * that a ticket only means anything while its session could still
             * be addressed: retaining more tickets than the host will hold
             * sessions buys nothing, and fewer would evict a ticket for a
             * session that is still live. The consequence a caller meets is
             * that `agent_await` for a very old request can be refused once
             * `maxSessions` newer sessions have started — the run itself is
             * unaffected, only this adapter's memory of how to await it.
             */
            if (!all.bySession.has(sessionId) && all.bySession.size >= host.maxSessions) {
              const oldestSettledSession = [...all.bySession.entries()].find(
                ([, retained]) =>
                  [...retained.values()].every((entry) => entry.completed)
              )
              if (oldestSettledSession === undefined) {
                return [{ _tag: "SessionFull" }, all]
              }
              nextBySession.delete(oldestSettledSession[0])
              for (const rid of oldestSettledSession[1].keys()) {
                nextById.delete(rid)
              }
            }

            const nextForSession = new Map(current)
            if (nextForSession.size >= host.maxRequestsPerSession) {
              const oldestCompleted = [...nextForSession.entries()].find(
                ([, retained]) => retained.completed
              )
              if (oldestCompleted === undefined) {
                return [{ _tag: "RequestFull" }, all]
              }
              nextForSession.delete(oldestCompleted[0])
              nextById.delete(oldestCompleted[0])
            }
            nextForSession.set(id, ticket)
            nextById.set(id, ticket)
            // Delete before set, so an updated session moves to the end and
            // eviction drops genuinely stale sessions rather than busy ones.
            nextBySession.delete(sessionId)
            nextBySession.set(sessionId, nextForSession)
            return [
              { _tag: "Admitted" },
              { bySession: nextBySession, byId: nextById }
            ]
          }
        )
        if (admission._tag === "Collision") continue
        if (admission._tag === "RequestFull") {
          return yield* new AgentProtocol.AgentRequestCapacityExceededError({
            sessionId: Option.some(sessionId),
            capacity: host.maxRequestsPerSession
          })
        }
        if (admission._tag === "SessionFull") {
          return yield* new AgentProtocol.AgentCapacityExceededError({
            capacity: host.maxSessions
          })
        }
        return ticket
      }
    })

    const markCompleted = (ticket: Ticket) =>
      Ref.update(tickets, (all) => {
        const current = all.bySession.get(ticket.request.sessionId)
        const retained = current?.get(ticket.request.requestId)
        if (current === undefined || retained?.result !== ticket.result) {
          return all
        }
        const updated: Ticket = { ...retained, completed: true }
        const nextForSession = new Map(current).set(ticket.request.requestId, updated)
        const nextBySession = new Map(all.bySession).set(ticket.request.sessionId, nextForSession)
        const nextById = new Map(all.byId).set(ticket.request.requestId, updated)
        return { bySession: nextBySession, byId: nextById }
      })

    const ticketById = Effect.fn("AgentMcp.ticketById")(function* (
      id: AgentProtocol.RequestId
    ) {
      const all = yield* Ref.get(tickets)
      const ticket = all.byId.get(id)
      if (ticket !== undefined) return ticket
      return yield* new AgentMcpTicketNotFoundError({ requestId: id })
    })

    const removeTickets = (sessionId: AgentProtocol.SessionId) =>
      Ref.update(tickets, (all) => {
        if (!all.bySession.has(sessionId)) return all
        const nextBySession = new Map(all.bySession)
        const removed = nextBySession.get(sessionId)
        nextBySession.delete(sessionId)
        const nextById = new Map(all.byId)
        if (removed !== undefined) {
          for (const rid of removed.keys()) {
            nextById.delete(rid)
          }
        }
        return { bySession: nextBySession, byId: nextById }
      })

    const removeTicket = (ticket: Ticket) =>
      Ref.update(tickets, (all) => {
        const current = all.bySession.get(ticket.request.sessionId)
        if (current?.get(ticket.request.requestId)?.result !== ticket.result) {
          return all
        }
        const nextForSession = new Map(current)
        nextForSession.delete(ticket.request.requestId)
        const nextBySession = new Map(all.bySession)
        if (nextForSession.size === 0) {
          nextBySession.delete(ticket.request.sessionId)
        } else {
          nextBySession.delete(ticket.request.sessionId)
          nextBySession.set(ticket.request.sessionId, nextForSession)
        }
        const nextById = new Map(all.byId)
        nextById.delete(ticket.request.requestId)
        return { bySession: nextBySession, byId: nextById }
      })

    const start = Effect.fn("AgentMcp.startAgent")(function* (
      promptText: string,
      rawSessionId: AgentProtocol.SessionId | undefined
    ) {
      const requested = Option.fromUndefinedOr(rawSessionId)
      const principal = yield* authenticate("prompt", requested)
      const generated = AgentProtocol.SessionId.make(
        `mcp-${globalThis.crypto.randomUUID()}`
      )
      // From acquiring the session through handing the prompt to an
      // adapter-owned fiber, start is one uninterruptible ownership transfer.
      // We remember whether this call created the session so ticket admission
      // can roll it back without closing a session another caller already
      // owned. Masking the handoff means cancellation cannot split ownership
      // between the ticket and host session.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const acquired = Option.isSome(requested)
            ? yield* named(principal, requested.value)
            : {
                sessionId: yield* create(principal, Option.some(generated)),
                created: true
              } as const
          const launch = Effect.gen(function* () {
            const ticket = yield* reserveTicket(
              acquired.sessionId,
              promptText
            )
            const complete = Deferred.complete(
              ticket.result,
              host.prompt(principal, ticket.request)
            ).pipe(Effect.ensuring(markCompleted(ticket)))
            return yield* Effect.forkIn(complete, adapterScope).pipe(
              Effect.as({
                sessionId: acquired.sessionId,
                requestId: ticket.request.requestId
              }),
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? removeTicket(ticket) : Effect.void
              )
            )
          })
          return yield* launch.pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) && acquired.created
                ? close(principal, acquired.sessionId).pipe(Effect.ignore)
                : Effect.void
            )
          )
        })
      )
    })

    const nativeElicitation = Effect.fn("AgentMcp.nativeElicitation")(
      function* (request: Elicitation.Request) {
        if (request.kind === "tool-approval") {
          const detail = decodeApprovalDetail(request.detail)
          const message = Option.match(detail, {
            onNone: () => "Approve this agent tool call?",
            onSome: (approval) => {
              const subject = approval.subject ?? approval.resource
              const reason = approval.reason === undefined
                ? ""
                : ` Reason: ${approval.reason}.`
              return `Approve ${approval.toolName} to ${approval.action} ${subject}?${reason}`
            }
          })
          return yield* McpServer.elicit({
            message,
            schema: ToolApprovalForm
          }).pipe(
            Effect.map((answer): Elicitation.Response => ({
              id: request.id,
              granted: true,
              value: { remember: answer.remember }
            })),
            Effect.catchTag("ElicitationDeclined", () =>
              Effect.succeed<Elicitation.Response>({
                id: request.id,
                granted: false
              })
            )
          )
        }

        return yield* McpServer.elicit({
          message: `Agent requests ${request.kind}. Approve it?`,
          schema: GenericApprovalForm
        }).pipe(
          Effect.map((answer): Elicitation.Response => ({
            id: request.id,
            granted: answer.approve
          })),
          Effect.catchTag("ElicitationDeclined", () =>
            Effect.succeed<Elicitation.Response>({
              id: request.id,
              granted: false
            })
          )
        )
      }
    )

    /**
     * Build the request-scoped side of an elicitation bridge.
     *
     * The event subscription is acquired before `pending`, so a question
     * cannot appear between a snapshot and a later subscription. A small
     * request-local set removes the intentional overlap between the snapshot
     * and buffered live events. The returned effect never succeeds: it either
     * keeps serving questions, fails under the declared policy, or is
     * interrupted when the prompt/await branch wins its race.
     */
    const elicitationBridgeFor = Effect.fn("AgentMcp.elicitationBridgeFor")(
      function* (
        principal: Principal,
        sessionId: AgentProtocol.SessionId
      ) {
        const client = yield* McpSchema.McpServerClient
        const capability = client.clientCapabilities.elicitation
        const isHttpRequest = Option.isSome(
          yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)
        )
        // Effect rc.111's Streamable HTTP transport cannot flush a reverse
        // request while its originating tool call is still open. Advertising
        // form elicitation is therefore not sufficient on that transport: a
        // native request waits forever. Stdio is full-duplex and can use the
        // reverse call; HTTP stays pending for agent_status/agent_respond.
        const supportsForm = !isHttpRequest && capability !== undefined &&
          (capability.form !== undefined || capability.url === undefined)

        if (!supportsForm && options.onUnsupportedElicitation === "pending") {
          return yield* Effect.never
        }

        const events = yield* host.events(principal, { sessionId })
        return yield* Effect.scoped(
          Effect.gen(function* () {
            // Running into the queue establishes the live subscription before
            // the pending snapshot. A bare Stream value is lazy and left a
            // gap in which ElicitationRequested could be lost.
            const eventQueue = yield* Stream.toQueue(events, {
              capacity: "unbounded"
            })
            const pending = yield* host.pending(principal, { sessionId })
            const seen = yield* Ref.make<ReadonlySet<string>>(new Set())

            const handle = Effect.fn("AgentMcp.handleElicitation")(function* (
              request: Elicitation.Request
            ) {
              const fresh = yield* Ref.modify(
                seen,
                (all): readonly [boolean, ReadonlySet<string>] =>
                  all.has(request.id)
                    ? [false, all]
                    : [true, new Set(all).add(request.id)]
              )
              if (!fresh) return

              if (!supportsForm) {
                if (options.onUnsupportedElicitation === "fail") {
                  return yield* new AgentMcpElicitationUnsupportedError({
                    sessionId,
                    id: request.id,
                    kind: request.kind
                  })
                }
                yield* host.respond(principal, {
                  requestId: requestId(),
                  sessionId,
                  response: { id: request.id, granted: false }
                })
                return
              }

              const response = yield* nativeElicitation(request)
              yield* host.respond(principal, {
                requestId: requestId(),
                sessionId,
                response
              })
            })

            const live = Stream.fromQueue(eventQueue).pipe(
              Stream.filterMap((envelope) =>
                envelope.event._tag === "ElicitationRequested"
                  ? Result.succeed<Elicitation.Request>({
                      id: envelope.event.id,
                      kind: envelope.event.kind,
                      detail: envelope.event.detail
                    })
                  : Result.fail(undefined)
              )
            )
            return yield* Stream.concat(
              Stream.fromIterable(pending.requests),
              live
            ).pipe(
              Stream.runForEach(handle),
              Effect.andThen(Effect.never)
            )
          })
        )
      }
    )

    const awaitTicket = Effect.fn("AgentMcp.awaitAgent")(function* (
      id: AgentProtocol.RequestId
    ) {
      const ticket = yield* ticketById(id)
      const sessionId = ticket.request.sessionId
      const principal = yield* authenticate(
        "getSession",
        Option.some(sessionId)
      )
      // Authorization is checked on every await, not only when the ticket was
      // minted. A request id is correlation, not an authentication token.
      yield* host.session(principal, { sessionId })
      const bridge = elicitationBridgeFor(principal, sessionId)
      const response = yield* Effect.raceFirst(
        Deferred.await(ticket.result),
        bridge
      )
      return response.result
    })

    const closeFromRequest = Effect.fn("AgentMcp.closeFromRequest")(function* (
      sessionId: AgentProtocol.SessionId
    ) {
      const principal = yield* authenticate(
        "closeSession",
        Option.some(sessionId)
      )
      const closed = yield* close(principal, sessionId)
      yield* removeTickets(sessionId)
      return closed
    })

    const steerFromRequest = Effect.fn("AgentMcp.steerFromRequest")(function* (
      sessionId: AgentProtocol.SessionId,
      promptText: string
    ) {
      const principal = yield* authenticate("steer", Option.some(sessionId))
      const response = yield* host.steer(principal, {
        requestId: requestId(),
        sessionId,
        input: Prompt.make(promptText)
      })
      return response.accepted
    })

    const followUpFromRequest = Effect.fn("AgentMcp.followUpFromRequest")(
      function* (
        sessionId: AgentProtocol.SessionId,
        promptText: string
      ) {
        const principal = yield* authenticate(
          "followUp",
          Option.some(sessionId)
        )
        const response = yield* host.followUp(principal, {
          requestId: requestId(),
          sessionId,
          input: Prompt.make(promptText)
        })
        return response.accepted
      }
    )

    const interruptFromRequest = Effect.fn("AgentMcp.interruptFromRequest")(
      function* (sessionId: AgentProtocol.SessionId) {
        const principal = yield* authenticate(
          "interrupt",
          Option.some(sessionId)
        )
        const response = yield* host.interrupt(principal, {
          requestId: requestId(),
          sessionId
        })
        return response.accepted
      }
    )

    const statusFromRequest = Effect.fn("AgentMcp.statusFromRequest")(
      function* (sessionId: AgentProtocol.SessionId) {
        const principal = yield* authenticate("status", Option.some(sessionId))
        const status = yield* host.status(principal, { sessionId })
        const pending = yield* host.pending(principal, { sessionId })
        return { status: status.status, pending: pending.requests }
      }
    )

    const respondFromRequest = Effect.fn("AgentMcp.respondFromRequest")(
      function* (
        sessionId: AgentProtocol.SessionId,
        id: string,
        granted: boolean,
        value: unknown | undefined
      ) {
        const principal = yield* authenticate("respond", Option.some(sessionId))
        const response: Elicitation.Response = {
          id,
          granted,
          ...(value === undefined ? {} : { value })
        }
        const answered = yield* host.respond(principal, {
          requestId: requestId(),
          sessionId,
          response
        })
        return answered.matched
      }
    )

    const promptWithBridge = Effect.fn("AgentMcp.promptWithBridge")(
      function* (
        principal: Principal,
        sessionId: AgentProtocol.SessionId,
        input: string
      ) {
        const promptRequest: AgentProtocol.PromptRequest = {
          requestId: requestId(),
          sessionId,
          input: Prompt.make(input)
        }
        const bridge = elicitationBridgeFor(principal, sessionId)
        const response = yield* Effect.raceFirst(
          host.prompt(principal, promptRequest),
          bridge
        ).pipe(
          // `ask_agent` presents one blocking operation, unlike an
          // observational `agent_await`: canceling it cancels its work.
          Effect.onInterrupt(() =>
            host.interrupt(principal, {
              requestId: requestId(),
              sessionId
            }).pipe(Effect.ignore)
          )
        )
        return response.result.text
      }
    )

    const ask = Effect.fn("AgentMcp.askAgent")(function* (
      promptText: string,
      rawSessionId: string | undefined
    ) {
      const requested = Option.map(
        Option.fromUndefinedOr(rawSessionId),
        AgentProtocol.SessionId.make
      )
      const principal = yield* authenticate("prompt", requested)

      if (Option.isSome(requested)) {
        const acquired = yield* named(principal, requested.value)
        return yield* promptWithBridge(
          principal,
          acquired.sessionId,
          promptText
        )
      }

      return yield* Effect.acquireUseRelease(
        create(principal, Option.none()),
        (sessionId) => promptWithBridge(principal, sessionId, promptText),
        // Anonymous MCP calls are one-shot. Release capacity when the call
        // ends, including interruption; failure to clean up must not replace
        // the prompt outcome the remote caller is waiting for.
        (sessionId) => close(principal, sessionId).pipe(Effect.ignore)
      )
    })

    const remote = <A, E extends { readonly message: string }, R>(
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<A, ToolFailure, R> =>
      Effect.mapError(effect, (error) => new ToolFailure({ detail: error.message }))

    const handlers = ServerToolkit.of({
      ask_agent: ({ prompt, sessionId }) =>
        remote(ask(prompt, sessionId)),
      agent_start: ({ prompt, sessionId }) =>
        remote(start(prompt, sessionId)),
      agent_await: ({ requestId }) =>
        remote(awaitTicket(requestId)),
      agent_close: ({ sessionId }) =>
        remote(closeFromRequest(sessionId)),
      agent_steer: ({ sessionId, prompt }) =>
        remote(steerFromRequest(sessionId, prompt)),
      agent_follow_up: ({ sessionId, prompt }) =>
        remote(followUpFromRequest(sessionId, prompt)),
      agent_interrupt: ({ sessionId }) =>
        remote(interruptFromRequest(sessionId)),
      agent_status: ({ sessionId }) =>
        remote(statusFromRequest(sessionId)),
      agent_respond: ({ sessionId, id, granted, value }) =>
        remote(respondFromRequest(sessionId, id, granted, value))
    })

    const historyResource = McpServer.registerResource`agent://session/${AgentProtocol.SessionId}/history`({
      name: "agent-session-history",
      description: "The JSON-encoded conversation history for an agent session.",
      mimeType: "application/json",
      content: (_uri, sessionId) =>
        Effect.gen(function* () {
          const principal = yield* authenticate(
            "history",
            Option.some(sessionId)
          )
          const response = yield* host.history(principal, { sessionId })
          const encoded = yield* Schema.encodeEffect(PromptWire.Prompt)(
            response.history
          )
          return JSON.stringify(encoded)
        })
    })

    const sessionsResource = McpServer.registerResource({
      uri: "agent://sessions",
      name: "agent-sessions",
      description: "Every session this host holds, with its status.",
      mimeType: "application/json",
      content: Effect.gen(function* () {
        const principal = yield* authenticate("listSessions", Option.none())
        const response = yield* host.sessions(principal)
        return JSON.stringify(response.sessions)
      })
    })

    /**
     * The event log, read finitely. `after` is the last sequence the reader
     * has; the read is refused, not downgraded, when the host no longer
     * holds what follows it (`AgentSessionHost.maxRetainedEvents`). Two
     * templates because a URI template cannot make a segment optional: the
     * bare form is "everything you hold".
     */
    const encodeEventLog = Schema.encodeEffect(Schema.toCodecJson(AgentProtocol.EventLogResponse))
    const readEventLog = (sessionId: AgentProtocol.SessionId, after: number | undefined) =>
      Effect.gen(function* () {
        const principal = yield* authenticate("eventLog", Option.some(sessionId))
        const response = yield* host.eventLog(principal, {
          sessionId,
          ...(after === undefined ? {} : { after })
        })
        return JSON.stringify(yield* encodeEventLog(response))
      })

    const eventsResource = McpServer.registerResource`agent://session/${AgentProtocol.SessionId}/events`({
      name: "agent-session-events",
      description: "The retained events of an agent session, oldest first, with the latest sequence.",
      mimeType: "application/json",
      content: (_uri, sessionId) => readEventLog(sessionId, undefined)
    })

    const eventsAfterResource = McpServer.registerResource`agent://session/${AgentProtocol.SessionId}/events/after/${Schema.NumberFromString}`({
      name: "agent-session-events-after",
      description: "The retained events of an agent session after a sequence the reader already has.",
      mimeType: "application/json",
      content: (_uri, sessionId, after) => readEventLog(sessionId, after)
    })

    const pendingResource = McpServer.registerResource`agent://session/${AgentProtocol.SessionId}/pending`({
      name: "agent-session-pending",
      description: "Pending elicitation requests for an agent session.",
      mimeType: "application/json",
      content: (_uri, sessionId) =>
        Effect.gen(function* () {
          const principal = yield* authenticate(
            "pending",
            Option.some(sessionId)
          )
          const response = yield* host.pending(principal, { sessionId })
          return JSON.stringify(response.requests)
        })
    })

    /**
     * Register one request-interactive tool without `registerToolkit`.
     *
     * In Effect rc.111, `McpServer.registerToolkit` captures the handler Layer
     * context and later `provideContext`s it over the invocation context. That
     * drops the `McpServerClient` which its own `addTool` wrapper supplied, so
     * a correctly declared request dependency typechecks and dies at runtime.
     * The lower-level public service preserves that invocation service. Keep
     * this adapter local to the two tools which genuinely need reverse calls;
     * the ordinary toolkit registration remains the default path.
     */
    const registerInteractive = <
      Name extends string,
      Parameters extends Schema.Top,
      Success extends Schema.Top,
      Failure extends Schema.Top,
      FailureMode extends Tool.FailureMode,
      Requirements
    >(
      tool: Tool.Tool<Name, {
        readonly parameters: Parameters
        readonly success: Success
        readonly failure: Failure
        readonly failureMode: FailureMode
      }, Requirements>,
      handle: (
        parameters: Parameters["Type"]
      ) => Effect.Effect<Success["Type"], ToolFailure, McpSchema.McpServerClient>
    ) =>
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer
        const decodingServices = yield* Effect.context<
          Parameters["DecodingServices"]
        >()
        const encodingServices = yield* Effect.context<
          Success["EncodingServices"]
        >()
        const inputSchema = yield* Schema.decodeUnknownEffect(
          McpSchema.ToolJsonSchema
        )(Tool.getJsonSchema(tool)).pipe(Effect.orDie)
        const output = Tool.getJsonSchemaFromSchema(tool.successSchema)
        const outputSchema = output.type === "object"
          ? yield* Schema.decodeUnknownEffect(McpSchema.ToolJsonSchema)(
              output
            ).pipe(Effect.orDie)
          : undefined
        const decode = (payload: unknown) =>
          Schema.decodeUnknownEffect(tool.parametersSchema)(payload).pipe(
            Effect.provideContext(decodingServices)
          )
        const encode = (result: Success["Type"]) =>
          Schema.encodeUnknownEffect(tool.successSchema)(result).pipe(
            Effect.provideContext(encodingServices)
          )

        yield* server.addTool({
          tool: new McpSchema.Tool({
            name: tool.name,
            description: Tool.getDescription(tool),
            inputSchema,
            ...(outputSchema === undefined ? {} : { outputSchema })
          }),
          annotations: Context.empty(),
          handle: (payload) =>
            decode(payload ?? {}).pipe(
              Effect.mapError((error) =>
                new McpSchema.InvalidParams({ message: error.message })
              ),
              Effect.flatMap((parameters) =>
                handle(parameters).pipe(
                  Effect.matchEffect({
                    onFailure: (failure) =>
                      Effect.succeed(new McpSchema.CallToolResult({
                        isError: true,
                        content: [{ type: "text", text: failure.message }]
                      })),
                    onSuccess: (result) =>
                      encode(result).pipe(
                        Effect.orDie,
                        Effect.map((encoded) =>
                          new McpSchema.CallToolResult({
                            isError: false,
                            ...(Schema.is(Schema.JsonObject)(encoded)
                              ? { structuredContent: encoded }
                              : {}),
                            content: encoded === undefined
                              ? []
                              : [{
                                  type: "text" as const,
                                  text: JSON.stringify(encoded)
                                }]
                          })
                        )
                      )
                  })
                )
              )
            )
        })
      })

    const registrations = Layer.effectDiscard(
      Effect.all([
        McpServer.registerToolkit(RegisteredToolkit),
        historyResource,
        pendingResource,
        sessionsResource,
        eventsResource,
        eventsAfterResource,
        registerInteractive(
          SharedAskAgent,
          handlers.ask_agent
        ),
        registerInteractive(
          SharedAwaitAgent,
          handlers.agent_await
        )
      ], { discard: true })
    )

    return registrations.pipe(
      Layer.provide(ServerToolkit.toLayer(handlers))
    )
  })

export interface ServerOptions<Principal> {
  /**
   * The application-owned host this adapter serves.
   *
   * Give the same tag to HTTP, RPC, AG-UI, A2A or connector adapters to share
   * one session registry, one capacity limit and one authorization policy.
   */
  readonly host: AgentSessionHost.Tag<Principal>
  /**
   * What an await/ask does when its MCP client cannot present form
   * elicitation. `pending` leaves the question for `agent_status` and
   * `agent_respond`; `deny` answers it false; `fail` fails the observing tool
   * call while leaving the agent paused. Defaults to `pending` and never to an
   * implicit grant. With Effect rc.111, Streamable HTTP is treated as
   * unsupported even when the client advertises forms because that transport
   * cannot flush a reverse request while the tool call remains open; stdio can.
   */
  readonly onUnsupportedElicitation?: "pending" | "deny" | "fail" | undefined
}

/**
 * Register the MCP agent frontend over a shared `AgentSessionHost`.
 *
 * This is the preferred application path. The older `handlers` and `layer`
 * remain intact because their bounded registry evicts the oldest idle session,
 * while `AgentSessionHost` deliberately refuses new sessions at capacity. That
 * observable policy choice cannot be changed under the name of a refactor.
 *
 * ```ts
 * const Host = AgentSessionHost.Tag<User>("app/AgentSessionHost")
 *
 * AgentMcp.serverLayer({ host: Host }).pipe(
 *   Layer.provide(HostLive),
 *   Layer.provide(McpServer.layerStdio({ name: "my-agent", version: "1.0.0" }))
 * )
 * ```
 */
export const serverLayer = <Principal>(
  options: ServerOptions<Principal>
): Layer.Layer<
  never,
  never,
  McpServer.McpServer | AgentSessionHost.Service<Principal>
> =>
  Layer.unwrap(handlersFromHost(options.host, {
    onUnsupportedElicitation: options.onUnsupportedElicitation ?? "pending"
  }))
