import { Duration, Effect, Schedule } from "effect"
import { Prompt } from "effect/unstable/ai"
import type * as Elicitation from "../Elicitation.js"
import { AgentIdleError } from "../Errors.js"
import { AgentEntity } from "./AgentEntity.js"

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
  /** Start a submission. Resolves to its execution id. */
  readonly submit: (input: Prompt.RawInput) => Effect.Effect<string>
  /** Queue steering, applied at the next turn boundary. */
  readonly steer: (
    input: Prompt.RawInput
  ) => Effect.Effect<void, AgentIdleError>
  /** Queue a follow-up, extending the submission rather than the run. */
  readonly followUp: (
    input: Prompt.RawInput
  ) => Effect.Effect<void, AgentIdleError>
  /** Interrupt the session's submission, if it has one. */
  readonly interrupt: Effect.Effect<void>
  /**
   * Answer a run paused for approval or other external input.
   *
   * Returns nothing: `DurableDeferred` does not report whether anything was
   * waiting, and a caller learns the truth from whether the run resumes.
   */
  readonly respond: (
    response: Elicitation.Response
  ) => Effect.Effect<void>
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
    times: 600,
    schedule: Schedule.spaced(Duration.millis(100))
  })

/**
 * Nothing here is a domain failure, so anything that survives the retry is a
 * defect. Dying is the honest outcome: a caller has no recovery for a broken
 * transport that it would not also have for a broken process.
 */
const infrastructural = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, never, R> =>
  Effect.catch(retryTransient(effect), (error: E) => Effect.die(error))

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
): Effect.Effect<void, AgentIdleError, R> =>
  Effect.retry(effect, {
    while: (error) =>
      isTransient(error) && tagOf(error) !== "AlreadyProcessingMessage",
    times: 600,
    schedule: Schedule.spaced(Duration.millis(100))
  }).pipe(
    Effect.asVoid,
    Effect.catch((error: AgentIdleError | E) =>
      isIdle(error)
        ? Effect.fail(error)
        : tagOf(error) === "AlreadyProcessingMessage"
          ? Effect.void
          : Effect.die(error)
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
