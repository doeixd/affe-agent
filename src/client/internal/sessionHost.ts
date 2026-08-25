import {
  Deferred,
  Effect,
  Exit,
  Option,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream
} from "effect"
import { positiveInteger } from "../../internal/positive.js"
import * as AgentClient from "../AgentClient.js"
import * as AgentProtocol from "../AgentProtocol.js"

/** Compatibility aliases for internal host tests and adapter implementations. */
export type AuthorizationContext<Principal> =
  AgentProtocol.AuthorizationContext<Principal>
export type AuthorizationError = AgentProtocol.AuthorizationError
export type Authorization<Principal> = AgentProtocol.Authorization<Principal>

/** Explicitly opt into an unauthenticated host, primarily for tests/examples. */
export const allowAll = <Principal>(): Authorization<Principal> => ({
  authorize: () => Effect.void
})

export interface Options<Principal> {
  readonly authorization: Authorization<Principal>
  /** Refuse new sessions at this bound; the host never evicts live work. */
  readonly maxSessions: number
  /** Completed request records are evicted FIFO when this bound is reached. */
  readonly maxRequestsPerSession: number
}

export interface Host<Principal> {
  readonly createSession: (
    principal: Principal,
    request: AgentProtocol.CreateSessionRequest
  ) => Effect.Effect<
    AgentProtocol.CreateSessionResponse,
    AgentProtocol.RemoteError
  >
  readonly closeSession: (
    principal: Principal,
    request: AgentProtocol.CloseSessionRequest
  ) => Effect.Effect<
    AgentProtocol.CloseSessionResponse,
    AgentProtocol.RemoteError
  >
  readonly session: (
    principal: Principal,
    request: AgentProtocol.GetSessionRequest
  ) => Effect.Effect<AgentProtocol.GetSessionResponse, AgentProtocol.RemoteError>
  readonly prompt: (
    principal: Principal,
    request: AgentProtocol.PromptRequest
  ) => Effect.Effect<AgentProtocol.PromptResponse, AgentProtocol.RemoteError>
  readonly steer: (
    principal: Principal,
    request: AgentProtocol.SteerRequest
  ) => Effect.Effect<AgentProtocol.SteerResponse, AgentProtocol.RemoteError>
  readonly followUp: (
    principal: Principal,
    request: AgentProtocol.FollowUpRequest
  ) => Effect.Effect<AgentProtocol.FollowUpResponse, AgentProtocol.RemoteError>
  readonly interrupt: (
    principal: Principal,
    request: AgentProtocol.InterruptRequest
  ) => Effect.Effect<AgentProtocol.InterruptResponse, AgentProtocol.RemoteError>
  readonly respond: (
    principal: Principal,
    request: AgentProtocol.RespondRequest
  ) => Effect.Effect<AgentProtocol.RespondResponse, AgentProtocol.RemoteError>
  readonly pending: (
    principal: Principal,
    request: AgentProtocol.PendingRequest
  ) => Effect.Effect<AgentProtocol.PendingResponse, AgentProtocol.RemoteError>
  readonly history: (
    principal: Principal,
    request: AgentProtocol.HistoryRequest
  ) => Effect.Effect<AgentProtocol.HistoryResponse, AgentProtocol.RemoteError>
  readonly status: (
    principal: Principal,
    request: AgentProtocol.StatusRequest
  ) => Effect.Effect<AgentProtocol.StatusResponse, AgentProtocol.RemoteError>
  readonly events: (
    principal: Principal,
    request: AgentProtocol.EventsRequest
  ) => Effect.Effect<
    Stream.Stream<AgentProtocol.AgentEventEnvelope, AgentProtocol.RemoteError>,
    AgentProtocol.RemoteError
  >
  /** Internal observability used by conformance tests and future metrics. */
  readonly size: Effect.Effect<number>
}

interface HostedSession {
  readonly session: AgentClient.RemoteSession
  readonly scope: Scope.Closeable
}

type MutationOperation = Extract<
  AgentProtocol.Operation,
  | "createSession"
  | "closeSession"
  | "prompt"
  | "steer"
  | "followUp"
  | "interrupt"
  | "respond"
>

interface RequestEntry {
  readonly operation: MutationOperation
  readonly fingerprint: string
  readonly sessionId: Option.Option<AgentProtocol.SessionId>
  readonly deferred: Deferred.Deferred<unknown, AgentProtocol.RemoteError>
  readonly completed: boolean
}

const HostBucket: unique symbol = Symbol.for(
  "@doeixd/effect-agent/AgentSessionHost/requests"
)
type RequestBucket = AgentProtocol.SessionId | typeof HostBucket
type RequestEntries = ReadonlyMap<AgentProtocol.RequestId, RequestEntry>
type RequestState = ReadonlyMap<RequestBucket, RequestEntries>

type Reservation =
  | {
      readonly _tag: "Owner"
      readonly deferred: Deferred.Deferred<unknown, AgentProtocol.RemoteError>
    }
  | {
      readonly _tag: "Join"
      readonly deferred: Deferred.Deferred<unknown, AgentProtocol.RemoteError>
    }

const bucketOf = (
  sessionId: Option.Option<AgentProtocol.SessionId>
): RequestBucket =>
  Option.match(sessionId, {
    onNone: () => HostBucket,
    onSome: (id) => id
  })

const codecError = (
  operation: AgentProtocol.Operation,
  phase: "request" | "response",
  detail: string
) =>
  new AgentProtocol.AgentProtocolCodecError({ operation, phase, detail })

const encode = <A, I>(
  operation: AgentProtocol.Operation,
  phase: "request" | "response",
  schema: Schema.Codec<A, I>,
  value: A
): Effect.Effect<I, AgentProtocol.AgentProtocolCodecError> =>
  Schema.encodeEffect(schema)(value).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(codecError(operation, phase, error.message))
    )
  )

const decode = <A, I>(
  operation: AgentProtocol.Operation,
  schema: Schema.Codec<A, I>,
  value: unknown
): Effect.Effect<A, AgentProtocol.AgentProtocolCodecError> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(codecError(operation, "response", error.message))
    )
  )

const fingerprint = <A, I>(
  operation: AgentProtocol.Operation,
  schema: Schema.Codec<A, I>,
  value: A
): Effect.Effect<string, AgentProtocol.AgentProtocolCodecError> =>
  Effect.map(encode(operation, "request", schema, value), JSON.stringify)

/**
 * Acquire the shared host used by protocol servers.
 *
 * The host owns every named session in a child scope linked to its own scope.
 * Mutations are executed in that host scope, so interrupting one HTTP/RPC
 * waiter cannot cancel work that another retry is joining.
 */
export const make = <Principal>(
  options: Options<Principal>
): Effect.Effect<Host<Principal>, never, AgentClient.AgentClient | Scope.Scope> =>
  Effect.gen(function* () {
    const client = yield* AgentClient.AgentClient
    const parentScope = yield* Effect.scope
    const maxSessions = positiveInteger(
      "AgentSessionHost maxSessions",
      options.maxSessions
    )
    const maxRequests = positiveInteger(
      "AgentSessionHost maxRequestsPerSession",
      options.maxRequestsPerSession
    )
    const sessions = yield* Ref.make(
      new Map<AgentProtocol.SessionId, HostedSession>()
    )
    const requests = yield* Ref.make<RequestState>(new Map())
    const registryGate = yield* Semaphore.make(1)
    const requestGate = yield* Semaphore.make(1)

    const authorize = Effect.fn("AgentSessionHost.authorize")(function* (
      principal: Principal,
      operation: AgentProtocol.Operation,
      sessionId: Option.Option<AgentProtocol.SessionId>
    ) {
      yield* Effect.annotateCurrentSpan({ operation })
      if (Option.isSome(sessionId)) {
        yield* Effect.annotateCurrentSpan({ sessionId: sessionId.value })
      }
      yield* options.authorization.authorize({
        principal,
        operation,
        sessionId
      })
    })

    /**
     * Find a session, adopting one the client knows about but this host does
     * not.
     *
     * The registry holds what *this process* opened. That is the whole story
     * for the in-process client, whose sessions live here and nowhere else.
     * It is not for a durable client, whose sessions live in shared state and
     * are exactly the ones another process -- or this one after a restart --
     * is expected to reach by id. Answering "not found" from the map alone
     * made every transport deny the durable client's central promise.
     *
     * So a miss asks the client. A session it can address is adopted into
     * the registry under its own scope, after which it is served like any
     * other; a session it cannot is the not-found it always was.
     */
    const findSession = Effect.fn("AgentSessionHost.findSession")(function* (
      sessionId: AgentProtocol.SessionId
    ) {
      yield* Effect.annotateCurrentSpan({ sessionId })
      const found = (yield* Ref.get(sessions)).get(sessionId)
      if (found !== undefined) return found
      return yield* registryGate.withPermits(1)(
        Effect.gen(function* () {
          // Re-checked under the gate: another request may have adopted it.
          const raced = (yield* Ref.get(sessions)).get(sessionId)
          if (raced !== undefined) return raced
          const addressable = yield* client.session(sessionId).pipe(
            Effect.catchTag("AgentSessionNotFoundError", () =>
              Effect.fail(new AgentProtocol.AgentSessionNotFoundError({ sessionId }))
            )
          )
          if ((yield* Ref.get(sessions)).size >= maxSessions) {
            return yield* new AgentProtocol.AgentCapacityExceededError({
              capacity: maxSessions
            })
          }
          const childScope = yield* Scope.fork(parentScope)
          const hosted: HostedSession = { session: addressable, scope: childScope }
          yield* Ref.update(sessions, (all) => new Map(all).set(sessionId, hosted))
          return hosted
        })
      )
    })

    const markCompleted = (
      bucket: RequestBucket,
      requestId: AgentProtocol.RequestId,
      deferred: Deferred.Deferred<unknown, AgentProtocol.RemoteError>
    ) =>
      Ref.update(requests, (state) => {
        const entries = state.get(bucket)
        const entry = entries?.get(requestId)
        if (entry === undefined || entry.deferred !== deferred) return state
        const nextEntries = new Map(entries)
        nextEntries.set(requestId, { ...entry, completed: true })
        return new Map(state).set(bucket, nextEntries)
      })

    const reserve = Effect.fn("AgentSessionHost.reserveRequest")(function* (
      operation: MutationOperation,
      sessionId: Option.Option<AgentProtocol.SessionId>,
      requestId: AgentProtocol.RequestId,
      requestFingerprint: string
    ) {
      return yield* requestGate.withPermits(1)(
        Effect.gen(function* () {
          const bucket = bucketOf(sessionId)
          const state = yield* Ref.get(requests)
          const entries = new Map(state.get(bucket) ?? [])
          const existing = entries.get(requestId)
          if (existing !== undefined) {
            if (
              existing.operation !== operation ||
              existing.fingerprint !== requestFingerprint
            ) {
              return yield* new AgentProtocol.AgentRequestConflictError({
                sessionId,
                requestId
              })
            }
            return {
              _tag: "Join",
              deferred: existing.deferred
            } satisfies Reservation
          }

          if (entries.size >= maxRequests) {
            const evictable = Array.from(entries).find(
              ([, entry]) => entry.completed
            )
            if (evictable === undefined) {
              return yield* new AgentProtocol.AgentRequestCapacityExceededError(
                { sessionId, capacity: maxRequests }
              )
            }
            entries.delete(evictable[0])
          }

          const deferred = yield* Deferred.make<
            unknown,
            AgentProtocol.RemoteError
          >()
          entries.set(requestId, {
            operation,
            fingerprint: requestFingerprint,
            sessionId,
            deferred,
            completed: false
          })
          yield* Ref.set(requests, new Map(state).set(bucket, entries))
          return { _tag: "Owner", deferred } satisfies Reservation
        })
      )
    })

    const mutate = Effect.fn("AgentSessionHost.mutate")(function* <A, I>(
      operation: MutationOperation,
      sessionId: Option.Option<AgentProtocol.SessionId>,
      requestId: AgentProtocol.RequestId,
      requestFingerprint: string,
      responseSchema: Schema.Codec<A, I>,
      mutation: Effect.Effect<A, AgentProtocol.RemoteError>
    ) {
      const bucket = bucketOf(sessionId)
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const reservation = yield* reserve(
            operation,
            sessionId,
            requestId,
            requestFingerprint
          )

          if (reservation._tag === "Owner") {
            const complete = Deferred.complete(
              reservation.deferred,
              Effect.flatMap(mutation, (response) =>
                encode(operation, "response", responseSchema, response)
              ).pipe(
                Effect.ensuring(
                  markCompleted(bucket, requestId, reservation.deferred)
                )
              )
            ).pipe(
              // The owner runs in the host's scope. If the host shuts down
              // with the mutation in flight, the owner is interrupted before
              // it can complete the deferred, and every joiner waiting on it
              // -- a request whose transport does not interrupt its handler
              // on its own -- would wait forever. Interrupting the deferred
              // wakes them with the interruption the host's closing is.
              Effect.onInterrupt(() =>
                Effect.asVoid(Deferred.interrupt(reservation.deferred))
              )
            )
            yield* Effect.forkIn(complete, parentScope)
          }

          const encoded = yield* restore(Deferred.await(reservation.deferred))
          return yield* decode(operation, responseSchema, encoded)
        })
      )
    })

    const createRaw = Effect.fn("AgentSessionHost.createRaw")(function* (
      request: AgentProtocol.CreateSessionRequest
    ) {
      return yield* registryGate.withPermits(1)(
        Effect.gen(function* () {
          if (request.sessionId !== undefined) {
            const existing = (yield* Ref.get(sessions)).has(request.sessionId)
            if (existing) {
              return yield* new AgentProtocol.AgentSessionAlreadyExistsError({
                sessionId: request.sessionId
              })
            }
          }

          if ((yield* Ref.get(sessions)).size >= maxSessions) {
            return yield* new AgentProtocol.AgentCapacityExceededError({
              capacity: maxSessions
            })
          }

          const childScope = yield* Scope.fork(parentScope)
          const acquired = yield* Effect.exit(
            Scope.provide(
              client.createSession(
                request.sessionId === undefined
                  ? undefined
                  : { sessionId: request.sessionId }
              ),
              childScope
            ).pipe(
              Effect.flatMap((session) =>
                Schema.decodeEffect(AgentProtocol.SessionId)(session.id).pipe(
                  Effect.catchTag("SchemaError", (error) =>
                    Effect.fail(
                      codecError("createSession", "response", error.message)
                    )
                  ),
                  Effect.map((sessionId) => ({ sessionId, session }))
                )
              ),
              Effect.flatMap(({ sessionId, session }) =>
                Effect.map(session.status, (status) => ({
                  sessionId,
                  session,
                  status
                }))
              )
            )
          )

          if (Exit.isFailure(acquired)) {
            yield* Scope.close(childScope, acquired)
            return yield* Effect.failCause(acquired.cause)
          }

          const { sessionId, session, status } = acquired.value
          if ((yield* Ref.get(sessions)).has(sessionId)) {
            yield* Scope.close(childScope, Exit.void)
            return yield* new AgentProtocol.AgentSessionAlreadyExistsError({
              sessionId
            })
          }

          yield* Ref.update(sessions, (all) =>
            new Map(all).set(sessionId, { session, scope: childScope })
          )
          return {
            requestId: request.requestId,
            session: { sessionId, status }
          }
        })
      )
    })

    const closeRaw = Effect.fn("AgentSessionHost.closeRaw")(function* (
      request: AgentProtocol.CloseSessionRequest
    ) {
      return yield* registryGate.withPermits(1)(
        Effect.gen(function* () {
          const all = yield* Ref.get(sessions)
          const found = all.get(request.sessionId)
          if (found === undefined) {
            return yield* new AgentProtocol.AgentSessionNotFoundError({
              sessionId: request.sessionId
            })
          }
          const next = new Map(all)
          next.delete(request.sessionId)
          yield* Ref.set(sessions, next)
          return found
        })
      ).pipe(
        // Closed outside the registry gate. Closing interrupts the session's
        // run and waits for its finalizers -- tool cleanup, a provider stream
        // tearing down -- and holding the gate through that would stall every
        // other create and close on the host. The map no longer holds the
        // entry, so this close is the only one.
        Effect.flatMap((found) =>
          Effect.as(Scope.close(found.scope, Exit.void), {
            requestId: request.requestId,
            closed: true
          })
        )
      )
    })

    const releaseAll = registryGate.withPermits(1)(
      Effect.gen(function* () {
        const open = Array.from((yield* Ref.get(sessions)).values())
        yield* Ref.set(sessions, new Map())
        yield* Effect.forEach(
          open,
          ({ scope }) => Scope.close(scope, Exit.void),
          { discard: true }
        )
      })
    )
    yield* Effect.addFinalizer(() => releaseAll)

    const createSession = Effect.fn("AgentSessionHost.createSession")(
      function* (
        principal: Principal,
        request: AgentProtocol.CreateSessionRequest
      ) {
        const sessionId = Option.fromUndefinedOr(request.sessionId)
        yield* authorize(principal, "createSession", sessionId)
        const requestFingerprint = yield* fingerprint(
          "createSession",
          AgentProtocol.CreateSessionRequest,
          request
        )
        return yield* mutate(
          "createSession",
          sessionId,
          request.requestId,
          requestFingerprint,
          AgentProtocol.CreateSessionResponse,
          createRaw(request)
        )
      }
    )

    const closeSession = Effect.fn("AgentSessionHost.closeSession")(
      function* (
        principal: Principal,
        request: AgentProtocol.CloseSessionRequest
      ) {
        const sessionId = Option.some(request.sessionId)
        yield* authorize(principal, "closeSession", sessionId)
        const requestFingerprint = yield* fingerprint(
          "closeSession",
          AgentProtocol.CloseSessionRequest,
          request
        )
        return yield* mutate(
          "closeSession",
          sessionId,
          request.requestId,
          requestFingerprint,
          AgentProtocol.CloseSessionResponse,
          closeRaw(request)
        )
      }
    )

    const getSession = Effect.fn("AgentSessionHost.session")(function* (
      principal: Principal,
      request: AgentProtocol.GetSessionRequest
    ) {
      const sessionId = Option.some(request.sessionId)
      yield* authorize(principal, "getSession", sessionId)
      const hosted = yield* findSession(request.sessionId)
      const status = yield* hosted.session.status
      return { sessionId: request.sessionId, status }
    })

    const prompt = Effect.fn("AgentSessionHost.prompt")(function* (
      principal: Principal,
      request: AgentProtocol.PromptRequest
    ) {
      const sessionId = Option.some(request.sessionId)
      yield* authorize(principal, "prompt", sessionId)
      const requestFingerprint = yield* fingerprint(
        "prompt",
        AgentProtocol.PromptRequest,
        request
      )
      const mutation = Effect.flatMap(findSession(request.sessionId), (hosted) =>
        Effect.map(
          hosted.session.prompt(request.input, request.options),
          (result) => ({ requestId: request.requestId, result })
        )
      )
      return yield* mutate(
        "prompt",
        sessionId,
        request.requestId,
        requestFingerprint,
        AgentProtocol.PromptResponse,
        mutation
      )
    })

    const steer = Effect.fn("AgentSessionHost.steer")(function* (
      principal: Principal,
      request: AgentProtocol.SteerRequest
    ) {
      const sessionId = Option.some(request.sessionId)
      yield* authorize(principal, "steer", sessionId)
      const requestFingerprint = yield* fingerprint(
        "steer",
        AgentProtocol.SteerRequest,
        request
      )
      const mutation = Effect.flatMap(findSession(request.sessionId), (hosted) =>
        Effect.as(hosted.session.steer(request.input), {
          requestId: request.requestId,
          accepted: true
        })
      )
      return yield* mutate(
        "steer",
        sessionId,
        request.requestId,
        requestFingerprint,
        AgentProtocol.SteerResponse,
        mutation
      )
    })

    const followUp = Effect.fn("AgentSessionHost.followUp")(function* (
      principal: Principal,
      request: AgentProtocol.FollowUpRequest
    ) {
      const sessionId = Option.some(request.sessionId)
      yield* authorize(principal, "followUp", sessionId)
      const requestFingerprint = yield* fingerprint(
        "followUp",
        AgentProtocol.FollowUpRequest,
        request
      )
      const mutation = Effect.flatMap(findSession(request.sessionId), (hosted) =>
        Effect.as(hosted.session.followUp(request.input), {
          requestId: request.requestId,
          accepted: true
        })
      )
      return yield* mutate(
        "followUp",
        sessionId,
        request.requestId,
        requestFingerprint,
        AgentProtocol.FollowUpResponse,
        mutation
      )
    })

    const interrupt = Effect.fn("AgentSessionHost.interrupt")(function* (
      principal: Principal,
      request: AgentProtocol.InterruptRequest
    ) {
      const sessionId = Option.some(request.sessionId)
      yield* authorize(principal, "interrupt", sessionId)
      const requestFingerprint = yield* fingerprint(
        "interrupt",
        AgentProtocol.InterruptRequest,
        request
      )
      const mutation = Effect.flatMap(findSession(request.sessionId), (hosted) =>
        Effect.as(hosted.session.interrupt(), {
          requestId: request.requestId,
          accepted: true
        })
      )
      return yield* mutate(
        "interrupt",
        sessionId,
        request.requestId,
        requestFingerprint,
        AgentProtocol.InterruptResponse,
        mutation
      )
    })

    const respond = Effect.fn("AgentSessionHost.respond")(function* (
      principal: Principal,
      request: AgentProtocol.RespondRequest
    ) {
      const sessionId = Option.some(request.sessionId)
      yield* authorize(principal, "respond", sessionId)
      const requestFingerprint = yield* fingerprint(
        "respond",
        AgentProtocol.RespondRequest,
        request
      )
      const mutation = Effect.flatMap(findSession(request.sessionId), (hosted) =>
        Effect.map(hosted.session.respond(request.response), (matched) => ({
          requestId: request.requestId,
          matched
        }))
      )
      return yield* mutate(
        "respond",
        sessionId,
        request.requestId,
        requestFingerprint,
        AgentProtocol.RespondResponse,
        mutation
      )
    })

    const pending = Effect.fn("AgentSessionHost.pending")(function* (
      principal: Principal,
      request: AgentProtocol.PendingRequest
    ) {
      const sessionId = Option.some(request.sessionId)
      yield* authorize(principal, "pending", sessionId)
      const hosted = yield* findSession(request.sessionId)
      return { requests: yield* hosted.session.pending }
    })

    const history = Effect.fn("AgentSessionHost.history")(function* (
      principal: Principal,
      request: AgentProtocol.HistoryRequest
    ) {
      const sessionId = Option.some(request.sessionId)
      yield* authorize(principal, "history", sessionId)
      const hosted = yield* findSession(request.sessionId)
      return { history: yield* hosted.session.history }
    })

    const status = Effect.fn("AgentSessionHost.status")(function* (
      principal: Principal,
      request: AgentProtocol.StatusRequest
    ) {
      const sessionId = Option.some(request.sessionId)
      yield* authorize(principal, "status", sessionId)
      const hosted = yield* findSession(request.sessionId)
      return { status: yield* hosted.session.status }
    })

    const events = Effect.fn("AgentSessionHost.events")(function* (
      principal: Principal,
      request: AgentProtocol.EventsRequest
    ) {
      const sessionId = Option.some(request.sessionId)
      yield* authorize(principal, "events", sessionId)
      const hosted = yield* findSession(request.sessionId)
      // Passed through rather than interpreted: whether this session can be
      // resumed is the client's question, and only the client knows whether a
      // log stands behind it.
      return hosted.session.events(
        request.after === undefined ? undefined : { after: request.after }
      )
    })

    return {
      createSession,
      closeSession,
      session: getSession,
      prompt,
      steer,
      followUp,
      interrupt,
      respond,
      pending,
      history,
      status,
      events,
      size: Effect.map(Ref.get(sessions), (all) => all.size)
    } satisfies Host<Principal>
  })
