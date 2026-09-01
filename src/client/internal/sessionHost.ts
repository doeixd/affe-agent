import {
  Deferred,
  Effect,
  Exit,
  FiberMap,
  Option,
  PubSub,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream
} from "effect"
import { positiveInteger } from "../../internal/positive.js"
import { CurrentPrincipal } from "../../Principal.js"
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
  /**
   * Project the principal to the opaque subject string set as
   * `CurrentPrincipal` on the fibre that runs a submission
   * (`docs/plan-principal-on-tool-fibre.md`). The submitter's subject
   * governs the whole run: it is provided around the mutation that starts
   * it, the fork inherits it, and the session's captured environment
   * cannot clobber a key it never held. `respond` sets it too -- an
   * approval's authority is the approver's. Absent, the host sets nothing
   * and every run reads the default `None`.
   */
  readonly subject?: ((principal: Principal) => string) | undefined
  /** Refuse new sessions at this bound; the host never evicts live work. */
  readonly maxSessions: number
  /** Completed request records are evicted FIFO when this bound is reached. */
  readonly maxRequestsPerSession: number
  /**
   * Events kept per session for `eventLog`, newest wins. Default 256.
   *
   * A finite read needs something finite to read. An in-process session's
   * bus remembers nothing, so the host keeps the tail of what each hosted
   * session emitted, bounded, and refuses a read that would start before
   * what it still holds rather than answer with a gap.
   */
  readonly maxRetainedEvents?: number | undefined
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
  readonly submit: (
    principal: Principal,
    request: AgentProtocol.SubmitRequest
  ) => Effect.Effect<AgentProtocol.SubmitResponse, AgentProtocol.RemoteError>
  readonly awaitSubmission: (
    principal: Principal,
    request: AgentProtocol.AwaitSubmissionRequest
  ) => Effect.Effect<AgentProtocol.AwaitSubmissionResponse, AgentProtocol.RemoteError>
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
  /** Every session this host holds, with its status. */
  readonly sessions: (
    principal: Principal
  ) => Effect.Effect<AgentProtocol.SessionsResponse, AgentProtocol.RemoteError>
  /** The retained events of one session after a sequence, finitely. */
  readonly eventLog: (
    principal: Principal,
    request: AgentProtocol.EventLogRequest
  ) => Effect.Effect<AgentProtocol.EventLogResponse, AgentProtocol.RemoteError>
  readonly events: (
    principal: Principal,
    request: AgentProtocol.EventsRequest
  ) => Effect.Effect<
    Stream.Stream<AgentProtocol.AgentEventEnvelope, AgentProtocol.RemoteError>,
    AgentProtocol.RemoteError
  >
  /**
   * Every hosted session's events, plus this host's own hosting lifecycle.
   *
   * The aggregate `events` is not: that one is per session and answers "what
   * is this conversation doing", where this answers "what is happening on
   * this host". `docs/effect-plan-2.txt` §29.
   *
   * Per-session order is preserved; across sessions the merge is arbitrary and
   * carries no host-wide sequence, for the reasons on
   * `AgentProtocol.HostEvent`. Live-only, with the inventory delivered once as
   * a leading `HostAttached`; `eventLog` remains the finite, cursored read.
   *
   * The error channel is `never`, unlike per-session `events`. One session's
   * transport failing must not end everyone else's feed, so it arrives as
   * `SessionUnhosted` with `reason: "failed"` and the stream carries on.
   *
   * **Publication never blocks, and the price is on the reader.** The backing
   * is unbounded, so a subscriber that stops reading pins the history at its
   * cursor and grows the host's heap without limit -- every event of every
   * session, for as long as the host lives. That is the deliberate trade: the
   * alternative is a bound whose backpressure stalls one session's pump behind
   * another session's slow consumer. **A transport adapter serving this over a
   * connection must bound its own per-connection buffer**, which it can do
   * safely because its producer is disposable and request-scope interruption
   * releases it. Nothing here can do that on its behalf.
   */
  readonly hostEvents: (
    principal: Principal
  ) => Effect.Effect<
    Stream.Stream<AgentProtocol.HostEvent>,
    AgentProtocol.RemoteError
  >
  /** Internal observability used by conformance tests and future metrics. */
  readonly size: Effect.Effect<number>
  /**
   * How many session pumps are still forwarding.
   *
   * Internal, in `requestBuckets`' idiom: a pump that outlives its session is
   * a leak nothing else can name. `size` cannot see it, because a leaked pump
   * is precisely one whose session has already left the registry.
   */
  readonly pumps: Effect.Effect<number>
  /**
   * How many request-idempotency buckets are held, live and closed together.
   *
   * Internal: it exists so the retention bound can be *observed* to hold. A
   * leak that only shows up as a heap graph in production is not something a
   * test can name, and this is the number the bound is about.
   */
  readonly requestBuckets: Effect.Effect<number>
  /** The bound `size` is measured against. Part of the inventory snapshot. */
  readonly maxSessions: number
  /** The per-session request-retention bound used by protocol adapters. */
  readonly maxRequestsPerSession: number
}

/**
 * The tail of a session's events, bounded.
 *
 * `oldest` is the sequence of the first entry still held, or `undefined`
 * while nothing has been dropped; the read below uses it to tell "nothing
 * after that yet" from "that has been evicted".
 */
interface EventTail {
  readonly entries: Array<AgentProtocol.AgentEventEnvelope>
  dropped: number
}

interface HostedSession {
  readonly session: AgentClient.RemoteSession
  readonly tail: EventTail
  readonly scope: Scope.Closeable
  /**
   * Why this session is being unhosted, when the remover is the one who knows.
   *
   * The pump publishes `SessionUnhosted` from its own exit and cannot tell a
   * `closeSession` from a host shutdown -- both reach it as its scope closing
   * -- so whoever removes the session writes the reason here first and that
   * decision wins.
   *
   * `None` means nobody removed it and the pump should say what it saw. It
   * has to be an `Option` rather than a defaulted value: at host shutdown the
   * client layer tears down first, so the session's stream *fails* on the way
   * out, and a pump that simply overwrote the reason would report `"failed"`
   * for an orderly release. Measured, not predicted -- it is what the first
   * version of this did.
   */
  readonly reason: Ref.Ref<Option.Option<AgentProtocol.UnhostReason>>
}

type MutationOperation = Extract<
  AgentProtocol.Operation,
  | "createSession"
  | "submit"
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
    /**
     * The scope every hosted session's child scope is forked from.
     *
     * Owned by the host rather than taken from the ambient one, so that
     * `releaseAll` can mark each session's reason *before* anything is torn
     * down. Forked from the ambient scope, the children are finalizers of it
     * and close ahead of the host's own finalizer -- measured: every pump had
     * already published `SessionUnhosted` before `releaseAll` ran, so a
     * shutdown was indistinguishable from a session ending on its own.
     */
    const sessionScope = yield* Scope.make()
    const maxSessions = positiveInteger(
      "AgentSessionHost maxSessions",
      options.maxSessions
    )
    const maxRequests = positiveInteger(
      "AgentSessionHost maxRequestsPerSession",
      options.maxRequestsPerSession
    )
    const maxRetainedEvents = positiveInteger(
      "AgentSessionHost maxRetainedEvents",
      options.maxRetainedEvents ?? 256
    )

    /**
     * Host a session: start keeping its event tail in its own scope.
     *
     * Observational, like every other consumer of the bus: a failure of the
     * event stream ends the tail and is logged, and does not touch the
     * session. The subscription starts at hosting, so a session adopted
     * mid-life is retained from that point; sequences are the session's
     * own, so a reader can still tell what it is missing.
     */
    /**
     * The host-wide stream's backing, and the pump mirror.
     *
     * Unbounded on purpose. A bound with backpressure would stall every
     * session's pump behind one slow `hostEvents` reader -- relocating the
     * unbounded memory into the per-session subscriptions and coupling
     * sessions to each other on the way. A sliding or dropping bound would
     * silently discard `SessionHosted` / `SessionUnhosted`, and a consumer
     * missing the first sees orphan events while one missing the second keeps
     * a projection for ever. AG-UI's 256-element bound does not transfer: its
     * producer is a per-request fibre that request-scope interruption
     * releases, where this is the shared host-lifetime pump with no such
     * release. The per-connection bound belongs in a transport adapter, where
     * the producer is disposable again.
     *
     * The finalizer is registered *here*, ahead of `releaseAll`'s below,
     * because finalizers run in reverse order of registration -- so this one
     * runs last, and every session's `SessionUnhosted` reaches the stream
     * before the stream carrying it ends.
     */
    /** Written by whoever removes a session; see `HostedSession.reason`. */
    const closedReason: Option.Option<AgentProtocol.UnhostReason> =
      Option.some("closed")
    const releasedReason: Option.Option<AgentProtocol.UnhostReason> =
      Option.some("released")

    const hostBus = yield* PubSub.unbounded<AgentProtocol.HostEvent>()
    yield* Effect.addFinalizer(() => PubSub.shutdown(hostBus))
    const pumpFibers = yield* FiberMap.make<AgentProtocol.SessionId>()

    const host = (
      sessionId: AgentProtocol.SessionId,
      session: AgentClient.RemoteSession,
      scope: Scope.Closeable
    ): Effect.Effect<HostedSession> =>
      Effect.gen(function* () {
        const tail: EventTail = { entries: [], dropped: 0 }
        const retain = (envelope: AgentProtocol.AgentEventEnvelope) => {
          tail.entries.push(envelope)
          if (tail.entries.length > maxRetainedEvents) {
            tail.entries.shift()
            tail.dropped += 1
          }
        }
        const reason = yield* Ref.make(
          Option.none<AgentProtocol.UnhostReason>()
        )
        let lastSequence: number | undefined

        const forward = (envelope: AgentProtocol.AgentEventEnvelope) =>
          Effect.suspend(() => {
            // Retain first, publish second. `eventLog` is a finite, cursored
            // read with a bound it can defend; the host stream is an
            // unbounded broadcast to whoever is listening. Ordering it the
            // other way would let a slow host-stream consumer hold up the
            // tail that the log is served from.
            retain(envelope)
            lastSequence = envelope.sequence
            return PubSub.publish(hostBus, { _tag: "SessionEvent", envelope })
          })

        /**
         * Announce the unhosting from the pump's own exit.
         *
         * Not from whoever removed the session: `closeRaw` deletes the
         * registry entry under the gate but closes the scope *outside* it, on
         * purpose, so at the moment of removal this pump is still live and may
         * still have queued envelopes. Publishing there would let a session's
         * tail trail its own `SessionUnhosted`. Here it is true by fibre
         * sequencing, and it covers every exit route -- close, host shutdown,
         * a stream that ended, a stream that failed -- with one path.
         */
        const announce = (
          exit: Exit.Exit<void, AgentProtocol.RemoteError>
        ) =>
          Effect.gen(function* () {
            const removed = yield* Ref.get(reason)
            yield* PubSub.publish(hostBus, {
              _tag: "SessionUnhosted",
              sessionId,
              // The remover's word beats what the pump saw. At host shutdown
              // the client layer tears down first, so the session's stream
              // fails on the way out and the pump would otherwise report
              // `"failed"` for an orderly release.
              reason: Option.isSome(removed)
                ? removed.value
                // Nobody removed it, so report what the pump saw. Both
                // removers state their reason, so this is the genuinely
                // unattended case: the session's own stream ended or broke
                // while the host was still holding it.
                : Exit.isSuccess(exit)
                ? "ended"
                : "failed",
              lastSequence: Option.fromNullishOr(lastSequence)
            })
            yield* Ref.update(closing, (ids) => {
              const next = new Set(ids)
              next.delete(sessionId)
              return next
            })
          })

        /**
         * Announced before the pump exists, so nothing it forwards can
         * precede it.
         *
         * The first attempt gated the *forwarding* on a `Deferred` opened
         * after this publish, which deadlocked: the pump's exit finalizer
         * awaited that gate, finalizers run uninterruptibly, and a stream that
         * ended inside the window between forking and opening left the fibre
         * waiting for something no longer on its way. Ordering the publish
         * ahead of the fork makes the same guarantee by construction and
         * needs no gate, no deferred and no finalizer that can block.
         *
         * Safe against a subscriber seeing this before the session is in the
         * registry, because both callers hold `registryGate` across `host`
         * and the `Ref.update` that follows it, and `hostEvents` takes that
         * same gate around its subscribe-and-snapshot.
         */
        yield* PubSub.publish(hostBus, { _tag: "SessionHosted", sessionId })
        // Forked into the session's scope, then yielded to, so the child has
        // subscribed before this returns: under the cooperative scheduler the
        // subscription is registered at its first step, ahead of any request
        // the host could serve next. `toPull` was tried and is no better --
        // it subscribes on the first pull, not on the call. Whatever the
        // scheduling, the read reports `oldest`, so nothing is silent.
        const fiber = yield* Effect.forkIn(
          Stream.runForEach(session.events(), forward).pipe(
            // `onExit` before `catchCause`, so `announce` sees the real cause
            // -- reversed, every failure would already have been swallowed
            // into a success and `reason` could never be `"failed"`.
            Effect.onExit(announce),
            // The stream ending -- the session closed -- ends the tail; so
            // does a stream failure, which for an in-process session cannot
            // happen and for a remote one is that transport's to report. It
            // must not reach the host stream's error channel either: one
            // session's transport dying would end everybody's feed.
            Effect.catchCause(() => Effect.void)
          ),
          scope
        )
        yield* Effect.yieldNow
        // Held so `pumps` can count what is genuinely live: the map drops a
        // fibre when it completes, so its size is live pumps rather than pumps
        // ever started, and a leaked pump is exactly one whose session has left
        // the registry -- which `size` cannot see.
        //
        // `FiberMap` *is* an owner -- its release interrupts every fibre it
        // holds -- so the session's child scope is not the only thing that
        // could tear these down. What makes that harmless is registration
        // order: the map is created before `releaseAll` is registered, and
        // finalizers run last-registered-first, so `releaseAll` has already
        // closed every session scope by the time the map is released and it
        // finds nothing left to interrupt. Do not reorder those two.
        FiberMap.setUnsafe(pumpFibers, sessionId, fiber)
        return { session, tail, scope, reason }
      })
    const sessions = yield* Ref.make(
      new Map<AgentProtocol.SessionId, HostedSession>()
    )
    const requests = yield* Ref.make<RequestState>(new Map())
    /**
     * Closed sessions whose request buckets are still answering retries.
     *
     * `maxRequestsPerSession` bounds what is *in* a bucket; nothing bounded the
     * number of buckets, and `closeRaw` left one behind for every session it
     * closed -- non-empty by construction, because the `closeSession` request
     * that emptied the registry is itself retained. A server that opens and
     * closes sessions grew this map for as long as it ran.
     *
     * Dropping the bucket on close would have been one line and a broken
     * promise: a retried `closeSession` under the same request id would
     * re-execute and be told `AgentSessionNotFoundError` instead of joining the
     * cached `{ closed: true }`, which is exactly the case idempotency exists
     * for. So the buckets are retained in FIFO order and capped at
     * `maxSessions` -- a number the host already has, and the same reasoning
     * `AgentMcp` uses for its ticket retention. Recent retries still join;
     * memory is bounded by a constant the operator already chose.
     */
    const retained = yield* Ref.make<ReadonlyArray<AgentProtocol.SessionId>>([])
    /**
     * Sessions removed from the registry whose pump has not yet announced.
     *
     * `closeRaw` unregisters under the gate but closes the scope outside it,
     * so between those two a session is invisible to a fresh `hostEvents`
     * snapshot while its pump is still forwarding. Without this, a subscriber
     * arriving in that window would receive `SessionEvent`s and a
     * `SessionUnhosted` for a session it was never told about -- the exact
     * thing publishing `SessionHosted` before the fork exists to prevent, in
     * the one direction the registry gate does not cover.
     *
     * **Not covered by a test.** It defends a race between a subscriber
     * attaching and a session closing, and that interleaving cannot be
     * produced deterministically here -- removing this set leaves the suite
     * green. Found by review rather than by a failure, and recorded as
     * untested rather than left to look proven.
     */
    const closing = yield* Ref.make(new Set<AgentProtocol.SessionId>())

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
          const childScope = yield* Scope.fork(sessionScope)
          const hosted = yield* host(sessionId, addressable, childScope)
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

    /**
     * Retain a closed session's bucket, evicting the oldest beyond the cap.
     *
     * Under the request gate, because it both appends to the retention list
     * and deletes from `requests`: a reservation racing the eviction could
     * otherwise write into a bucket that is about to be dropped, and the
     * request that reserved it would be answered twice.
     */
    const retainClosed = (sessionId: AgentProtocol.SessionId) =>
      requestGate.withPermits(1)(
        Effect.gen(function* () {
          // A session id can be reused after a close; keep one entry for it.
          const queue = (yield* Ref.get(retained)).filter((id) => id !== sessionId)
          const next = [...queue, sessionId]
          const evicted = next.slice(0, Math.max(0, next.length - maxSessions))
          yield* Ref.set(retained, next.slice(evicted.length))
          if (evicted.length === 0) return
          yield* Ref.update(requests, (state) => {
            const withoutEvicted = new Map(state)
            for (const id of evicted) withoutEvicted.delete(id)
            return withoutEvicted
          })
        })
      )

    /** A session id that is live again is no longer a retained closed one. */
    const unretain = (sessionId: AgentProtocol.SessionId) =>
      requestGate.withPermits(1)(
        Ref.update(retained, (queue) => queue.filter((id) => id !== sessionId))
      )

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

    /**
     * The submitter's subject, onto the fibre the mutation runs on.
     *
     * Around the *mutation*, not the whole host operation: only the owner
     * of a request-id reservation executes the mutation, so the run's
     * authority is whoever's request actually started it -- a retry that
     * joins the reservation inherits the answer, never re-principals the
     * run. The owner is forked from the reserving caller's fibre inside
     * `mutate`, which is what carries this into the fork.
     */
    const asPrincipal = (principal: Principal) =>
      <A2, E2, R2>(self: Effect.Effect<A2, E2, R2>): Effect.Effect<A2, E2, R2> =>
        options.subject === undefined
          ? self
          : Effect.provideService(
              self,
              CurrentPrincipal,
              Option.some(options.subject(principal))
            )

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

          const childScope = yield* Scope.fork(sessionScope)
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

          const hosted = yield* host(sessionId, session, childScope)
          yield* Ref.update(sessions, (all) => new Map(all).set(sessionId, hosted))
          return {
            requestId: request.requestId,
            session: { sessionId, status }
          }
        })
      ).pipe(
        // A reopened id is a live session again, so its bucket is no longer
        // one of the closed ones waiting to be evicted -- leaving it in the
        // FIFO would let a later close evict a bucket that is in use.
        Effect.tap((response) => unretain(response.session.sessionId))
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
          // Still visible to a subscriber until its pump has announced.
          yield* Ref.update(closing, (ids) =>
            new Set(ids).add(request.sessionId))
          return found
        })
      ).pipe(
        // Closed outside the registry gate. Closing interrupts the session's
        // run and waits for its finalizers -- tool cleanup, a provider stream
        // tearing down -- and holding the gate through that would stall every
        // other create and close on the host. The map no longer holds the
        // entry, so this close is the only one.
        Effect.flatMap((found) =>
          // Say why before closing, as `releaseAll` does. The pump cannot tell
          // a close from a shutdown -- both arrive as its scope going away --
          // and it cannot read it off the cause either: a closing session's
          // subscription shuts down, which Effect reports as a `Cause.Done`
          // defect, indistinguishable by shape from a transport that died.
          Ref.set(found.reason, closedReason).pipe(
            Effect.andThen(Scope.close(found.scope, Exit.void)),
            Effect.as({ requestId: request.requestId, closed: true })
          )
        ),
        // The bucket outlives the session, on purpose and not forever: a retry
        // arriving just after the close still joins this answer, and the
        // oldest retained bucket is dropped once `maxSessions` of them exist.
        Effect.tap(() => retainClosed(request.sessionId))
      )
    })

    const releaseAll = registryGate.withPermits(1)(
      Effect.gen(function* () {
        const open = Array.from((yield* Ref.get(sessions)).values())
        yield* Ref.set(sessions, new Map())
        // Say why before closing: each pump reads this on its way out, and a
        // host shutting down is not the same event as a session being closed
        // through it. Without this every `SessionUnhosted` at shutdown would
        // claim `"closed"` and imply something about sessions that are, for a
        // durable client, still very much alive elsewhere.
        yield* Effect.forEach(
          open,
          ({ reason }) => Ref.set(reason, releasedReason),
          { discard: true }
        )
        yield* Effect.forEach(
          open,
          ({ scope }) => Scope.close(scope, Exit.void),
          { discard: true }
        )
        yield* Scope.close(sessionScope, Exit.void)
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
          // The wire request id travels on as the idempotency key. The host's
          // own retention answers a retry that reaches *this* process; a
          // durable client's store has to answer one that reaches another, and
          // it can only do that if the two are told the same name for the
          // request. Minting a second name here would make a retried prompt a
          // fresh claim as soon as the host moved.
          hosted.session.prompt(request.input, {
            ...request.options,
            idempotencyKey: request.requestId
          }),
          (result) => ({ requestId: request.requestId, result })
        )
      ).pipe(asPrincipal(principal))
      return yield* mutate(
        "prompt",
        sessionId,
        request.requestId,
        requestFingerprint,
        AgentProtocol.PromptResponse,
        mutation
      )
    })

    /**
     * `prompt`'s admission half. The request table dedupes the *submit*: a
     * retry under the same id joins the receipt. The outcome is retained by
     * the session's own client (`awaitSubmission` below reads it there), so
     * the host adds no second table for it -- one place, one bound.
     */
    const submit = Effect.fn("AgentSessionHost.submit")(function* (
      principal: Principal,
      request: AgentProtocol.SubmitRequest
    ) {
      const sessionId = Option.some(request.sessionId)
      yield* authorize(principal, "submit", sessionId)
      const requestFingerprint = yield* fingerprint(
        "submit",
        AgentProtocol.SubmitRequest,
        request
      )
      const mutation = Effect.flatMap(findSession(request.sessionId), (hosted) =>
        Effect.map(
          hosted.session.submit(request.input, {
            ...request.options,
            idempotencyKey: request.requestId
          }),
          (receipt) => ({ requestId: request.requestId, submissionId: receipt.submissionId })
        )
      ).pipe(asPrincipal(principal))
      return yield* mutate(
        "submit",
        sessionId,
        request.requestId,
        requestFingerprint,
        AgentProtocol.SubmitResponse,
        mutation
      )
    })

    const awaitSubmission = Effect.fn("AgentSessionHost.awaitSubmission")(function* (
      principal: Principal,
      request: AgentProtocol.AwaitSubmissionRequest
    ) {
      const sessionId = Option.some(request.sessionId)
      yield* authorize(principal, "awaitSubmission", sessionId)
      const hosted = yield* findSession(request.sessionId)
      return { result: yield* hosted.session.awaitSubmission(request.submissionId) }
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
      ).pipe(asPrincipal(principal))
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
      ).pipe(asPrincipal(principal))
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
      ).pipe(asPrincipal(principal))
      return yield* mutate(
        "respond",
        sessionId,
        request.requestId,
        requestFingerprint,
        AgentProtocol.RespondResponse,
        mutation
      )
    })

    const listSessions = Effect.fn("AgentSessionHost.sessions")(function* (
      principal: Principal
    ) {
      yield* authorize(principal, "listSessions", Option.none())
      const all = Array.from(yield* Ref.get(sessions))
      const summaries = yield* Effect.forEach(all, ([sessionId, hosted]) =>
        Effect.map(hosted.session.status, (status) => ({ sessionId, status }))
      )
      return { sessions: summaries }
    })

    const eventLog = Effect.fn("AgentSessionHost.eventLog")(function* (
      principal: Principal,
      request: AgentProtocol.EventLogRequest
    ) {
      const sessionId = Option.some(request.sessionId)
      yield* authorize(principal, "eventLog", sessionId)
      const hosted = yield* findSession(request.sessionId)
      const { entries, dropped } = hosted.tail
      const after = request.after ?? 0
      const oldest = entries[0]?.sequence
      // Two reasons the tail can start after the cursor, told apart on
      // purpose. Events emitted before the host held the session were never
      // this host's to keep, and the response says so (`oldest`); a reader
      // can see the boundary. Events the *bound* evicted were once readable
      // here, and a cursor behind them is refused rather than answered with a
      // hole -- `after` is never silently downgraded.
      if (dropped > 0 && oldest !== undefined && after < oldest - 1) {
        return yield* new AgentProtocol.AgentInvalidRequestError({
          operation: "eventLog",
          detail: `events after ${after} are no longer retained; the oldest held is ${oldest}` +
            ` (maxRetainedEvents is ${maxRetainedEvents})`
        })
      }
      const events = entries.filter((envelope) => envelope.sequence > after)
      const last = entries[entries.length - 1]
      return {
        events,
        ...(oldest === undefined ? {} : { oldest }),
        latest: last?.sequence ?? 0
      }
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

    /**
     * Subscribe to everything happening on this host.
     *
     * The subscribe and the inventory snapshot are taken **together, under
     * the registry gate**, and that is what makes "exactly once" exact rather
     * than merely likely. A session hosted before the subscribe had its
     * `SessionHosted` published before the subscription existed, so only the
     * snapshot names it; one hosted after the gate releases is not in the
     * snapshot and arrives live; and one hosted *between* the two is
     * impossible, because `host` publishes and updates the registry while
     * holding this same gate.
     *
     * Taking the gate here is not the starvation risk it would be on the
     * event bus: that permit is taken on every emit, this one only on
     * host, unhost and attach.
     */
    const hostEvents = Effect.fn("AgentSessionHost.hostEvents")(function* (
      principal: Principal
    ) {
      yield* authorize(principal, "hostEvents", Option.none())
      return Stream.unwrap(
        registryGate.withPermits(1)(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(hostBus)
            const attached: AgentProtocol.HostEvent = {
              _tag: "HostAttached",
              sessionIds: [
                ...(yield* Ref.get(sessions)).keys(),
                ...(yield* Ref.get(closing))
              ]
            }
            return Stream.concat(
              Stream.make(attached),
              Stream.fromSubscription(subscription)
            )
          })
        )
      )
    })

    return {
      createSession,
      closeSession,
      session: getSession,
      prompt,
      submit,
      awaitSubmission,
      steer,
      followUp,
      interrupt,
      respond,
      pending,
      history,
      status,
      events,
      sessions: listSessions,
      eventLog,
      hostEvents,
      size: Effect.map(Ref.get(sessions), (all) => all.size),
      pumps: FiberMap.size(pumpFibers),
      requestBuckets: Effect.map(Ref.get(requests), (all) => all.size),
      maxSessions,
      maxRequestsPerSession: maxRequests
    } satisfies Host<Principal>
  })
