import { Duration, Effect } from "effect"
import { Prompt } from "effect/unstable/ai"
import type * as Elicitation from "../Elicitation.js"
import { AgentIdleError } from "../Errors.js"
import { AgentTransportError } from "../client/AgentClient.js"
import { AgentEntity } from "./AgentEntity.js"
import { detailOf } from "../internal/detail.js"
import * as Schedules from "../internal/schedules.js"

/**
 * The session operations, as a caller wants to call them.
 *
 * Named for what it is — a client for the session *entity* — rather than the
 * general `AgentClient` the roadmap reserves for a protocol-neutral transport
 * seam over in-process, RPC and HTTP. This one is specifically the cluster
 * adapter, and should not squat on the broader name.
 *
 * The generated entity client is a faithful rendering of the wire protocol,
 * which is not the same thing as a good API. It asks for a `Prompt` where every
 * other entry point in this library accepts `Prompt.RawInput`, and it carries
 * the cluster's own failure modes — `EntityNotAssignedToRunner`, `MailboxFull`,
 * `PersistenceError` — in the same error channel as the one domain failure a
 * caller can actually act on.
 *
 * There is also a trap worth naming, because it is invisible at compile time:
 * `Prompt.Prompt` as an RPC payload *accepts a bare string at the type level*
 * and then rejects it when encoding. A call site that passes `"hello"` compiles
 * and fails at runtime. Normalising through `Prompt.make` here closes that,
 * and is why this wrapper takes `RawInput` rather than merely re-exporting the
 * generated client.
 */
export interface EntityClient {
  /**
   * Start a submission. Resolves to its execution id.
   *
   * `AgentTransportError` is a cluster failure that outlived a bounded retry:
   * a shard outage, mailbox pressure, a persistence failure, a runner going
   * away. These used to be `Effect.die` on the reasoning that a caller has no
   * recovery for a broken transport -- which is not true of the callers this
   * surface has. Retrying later, routing elsewhere and returning a 503 are all
   * ordinary answers, and none of them is available to a caller handed a
   * defect.
   */
  readonly submit: (
    input: Prompt.RawInput
  ) => Effect.Effect<string, AgentTransportError>
  /** Queue steering, applied at the next turn boundary. */
  readonly steer: (
    input: Prompt.RawInput
  ) => Effect.Effect<void, AgentIdleError | AgentTransportError>
  /** Queue a follow-up, extending the submission rather than the run. */
  readonly followUp: (
    input: Prompt.RawInput
  ) => Effect.Effect<void, AgentIdleError | AgentTransportError>
  /** Interrupt the session's submission, if it has one. */
  readonly interrupt: Effect.Effect<void, AgentTransportError>
  /**
   * Answer a run paused for approval or other external input.
   *
   * Returns nothing: `DurableDeferred` does not report whether anything was
   * waiting, and a caller learns the truth from whether the run resumes.
   */
  readonly respond: (
    response: Elicitation.Response
  ) => Effect.Effect<void, AgentTransportError>
}

/**
 * What this wrapper needs from a generated client.
 *
 * Written structurally so the sharded client and `Entity.makeTestClient`'s
 * client both satisfy it, despite differing in their error channels. `E` is
 * whatever infrastructure failures the transport adds.
 */
export interface RawEntityClient<E> {
  readonly submit: (payload: {
    readonly input: Prompt.Prompt
  }) => Effect.Effect<string, E>
  readonly steer: (payload: {
    readonly input: Prompt.Prompt
  }) => Effect.Effect<void, AgentIdleError | E>
  readonly followUp: (payload: {
    readonly input: Prompt.Prompt
  }) => Effect.Effect<void, AgentIdleError | E>
  readonly interrupt: (payload: void) => Effect.Effect<void, E>
  readonly respond: (payload: {
    readonly response: Elicitation.Response
  }) => Effect.Effect<void, E>
}

/**
 * Survives shard reassignment, and momentary backpressure on a session's
 * mailbox.
 *
 * When a runner is lost its shards stay leased until `shardLockExpiration`
 * elapses and are then reassigned; a call routed through a shard in that window
 * is rejected. `MailboxFull` and `AlreadyProcessingMessage` are the same kind of
 * thing at a smaller scale — the session is busy this instant, not broken. The
 * schedule must outlast the lock expiration (35s by default) or a caller gives
 * up moments before the shard it wants becomes available.
 */
const TRANSIENT = new Set([
  "EntityNotAssignedToRunner",
  "RunnerNotRegistered",
  "RunnerUnavailable",
  "MailboxFull",
  "AlreadyProcessingMessage"
])

/**
 * Deliberately fixed together: 600 jittered 100ms retries are roughly one
 * minute, which must outlast the cluster's default 35s shard-lock expiration.
 * Making only the interval configurable could silently shorten the recovery
 * window below the lease it is meant to survive; deployments that change that
 * lease need a future single policy containing all three values.
 */
const TRANSIENT_RETRY_INTERVAL = Duration.millis(100)
const TRANSIENT_RETRY_TIMES = 600

const tagOf = (error: unknown): string | undefined =>
  typeof error === "object" &&
  error !== null &&
  typeof (error as { _tag?: unknown })._tag === "string"
    ? (error as { _tag: string })._tag
    : undefined

const isTransient = (error: unknown): boolean => {
  const tag = tagOf(error)
  return tag !== undefined && TRANSIENT.has(tag)
}

/**
 * Compared by tag rather than `instanceof`.
 *
 * The error crosses the wire and is rebuilt by its schema on the far side, so
 * identity is not something to rely on here.
 */
const isIdle = (error: unknown): error is AgentIdleError =>
  tagOf(error) === "AgentIdleError"

const retryTransient = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.retry(effect, {
    while: isTransient,
    times: TRANSIENT_RETRY_TIMES,
    schedule: Schedules.steady(TRANSIENT_RETRY_INTERVAL)
  })

/**
 * Retry a transient cluster failure, then say so rather than dying.
 *
 * This used to end in `Effect.die`, on the reasoning that a caller has no
 * recovery for a broken transport. That is not true of the callers this
 * surface has: a shard outage, mailbox pressure, a persistence failure or a
 * runner going away are all things an application answers by retrying later,
 * routing elsewhere, or returning a 503. Reporting them as programmer defects
 * after roughly a minute of retrying makes every one of those impossible, and
 * contradicts both the repository's rule that a public error channel names
 * what can go wrong and the protocol-neutral `AgentClient`, which has exposed
 * `AgentTransportError` all along.
 *
 * The bounded retry stays: most of these clear on their own, and a caller
 * should not have to reimplement that. What changes is what is left when it
 * does not.
 */
const infrastructural = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, AgentTransportError, R> =>
  Effect.catch(retryTransient(effect), (error: E) =>
    Effect.fail(transportError(error)))

/** The cluster's failure, in the vocabulary the rest of the library uses. */
const transportError = (error: unknown): AgentTransportError =>
  new AgentTransportError({
    sessionId: "",
    detail: `${tagOf(error) ?? "cluster"}: ${detailOf(error)}`
  })

/**
 * As above, but `AgentIdleError` is a real answer and passes through.
 *
 * `AlreadyProcessingMessage` is *not* retried here. It means the runner is
 * already handling this very envelope -- the input is being offered -- and a
 * retry sends a fresh envelope, so the same steer or follow-up would be
 * offered and applied twice. For an operation that is not idempotent the
 * honest answer is that it was accepted: the first delivery is in progress.
 */
const admitting = <A, E, R>(
  effect: Effect.Effect<A, AgentIdleError | E, R>
): Effect.Effect<void, AgentIdleError | AgentTransportError, R> =>
  Effect.retry(effect, {
    while: (error) =>
      isTransient(error) && tagOf(error) !== "AlreadyProcessingMessage",
    times: TRANSIENT_RETRY_TIMES,
    schedule: Schedules.steady(TRANSIENT_RETRY_INTERVAL)
  }).pipe(
    Effect.asVoid,
    Effect.catch((
      error: AgentIdleError | E
    ): Effect.Effect<void, AgentIdleError | AgentTransportError> =>
      isIdle(error)
        ? Effect.fail(error)
        : tagOf(error) === "AlreadyProcessingMessage"
          ? Effect.void
          : Effect.fail(transportError(error))
    )
  )

/**
 * Wrap a generated entity client in the ergonomic surface above.
 *
 * Exposed separately from `client` so a test client — which is built by a
 * different constructor — gets the same treatment as a sharded one.
 */
export const wrap = <E>(raw: RawEntityClient<E>): EntityClient => ({
  submit: (input) =>
    infrastructural(raw.submit({ input: Prompt.make(input) })),
  steer: (input) => admitting(raw.steer({ input: Prompt.make(input) })),
  followUp: (input) => admitting(raw.followUp({ input: Prompt.make(input) })),
  interrupt: infrastructural(raw.interrupt()),
  respond: (response) => infrastructural(raw.respond({ response }))
})

/**
 * A sharded client, keyed by session id.
 *
 * The session id is the entity id, so a `steer` sent from any node reaches the
 * node that owns the session.
 */
export const client = Effect.map(
  AgentEntity.client,
  (make) => (sessionId: string) => wrap(make(sessionId))
)
