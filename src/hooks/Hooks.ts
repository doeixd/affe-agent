import { Cause, Effect, Stream } from "effect"
import * as AgentEvent from "../AgentEvent.js"
import type { AgentEventEnvelope } from "../AgentEvent.js"

/**
 * Lifecycle hooks (issue #4 §13): run a side effect at points in a run --
 * a tool starting, a run completing, an elicitation being requested -- without
 * touching the run itself.
 *
 * There is no new mechanism here, and deliberately no new PubSub. A session
 * already publishes its lifecycle as `AgentEvent`s over an internal PubSub, and
 * `AgentSession.events(session)` is a subscription to it -- each call a fresh
 * subscriber, so hooks fan out alongside observability, a UI and a delivery log
 * off the one bus. `Hooks.on` is a typed dispatcher over that stream, on top of
 * `AgentEvent.match`.
 *
 * What it adds over a raw `match` loop is the two things a convenience layer
 * should: handlers are **optional** (register only the events you care about),
 * and each handler's failure is **isolated** -- a hook that throws is caught
 * and logged (or sent to your `onError`), never tearing down the observer or,
 * since observation is out of band, the run. Hooks observe; the run's own
 * seams -- `Permission`, `ContextTransform`, `AgentLoop` -- are where behaviour
 * is changed.
 *
 * ```ts
 * // Fork it alongside the prompt; it runs until the stream ends.
 * yield* Effect.forkScoped(Hooks.on(AgentSession.events(session), {
 *   ToolCallStarted:  (e) => Metrics.toolStarted(e.name),
 *   ToolCallSucceeded: (e) => Metrics.toolSucceeded(e.name),
 *   RunCompleted:     (_e, env) => Audit.record(env.sessionId)
 * }))
 * ```
 */

/** A side effect per event tag; every entry is optional. */
export type Handlers<E, R> = {
  readonly [Tag in AgentEvent.AgentEvent["_tag"]]?: (
    event: Extract<AgentEvent.AgentEvent, { readonly _tag: Tag }>,
    envelope: AgentEventEnvelope
  ) => Effect.Effect<void, E, R>
}

export interface Options<E, EO, RO> {
  /**
   * What to do when a handler fails. Defaults to logging the cause and
   * continuing -- one bad hook never stops the others or ends the observer.
   */
  readonly onError?: (cause: Cause.Cause<E>, envelope: AgentEventEnvelope) => Effect.Effect<void, EO, RO>
}

/**
 * The error and service unions the given handlers contribute -- extracted from
 * the handler values, so `on` infers them (a single `Handlers<E, R>` parameter
 * would infer `E`/`R` as `unknown` from the optional mapped type).
 */
type ErrorsOf<H> = { [K in keyof H]-?: H[K] extends (...args: any) => Effect.Effect<any, infer E, any> ? E : never }[keyof H]
type ServicesOf<H> = { [K in keyof H]-?: H[K] extends (...args: any) => Effect.Effect<any, any, infer R> ? R : never }[keyof H]

/**
 * Run `handlers` against an event stream. Dispatches each envelope to its
 * handler (a no-op when none is registered), isolating failures. Returns an
 * Effect that runs until the stream ends, so fork it (`Effect.forkScoped`)
 * beside the run you are observing.
 *
 * `H extends Handlers` gives each handler its tag's exact event type while
 * still letting `E`/`R` be inferred from the ones you register.
 */
export const on = <H extends Handlers<any, any>, EO = never, RO = never>(
  events: Stream.Stream<AgentEventEnvelope>,
  handlers: H,
  options?: Options<ErrorsOf<H>, EO, RO>
): Effect.Effect<void, EO, ServicesOf<H> | RO> =>
  Stream.runForEach(events, (envelope) => {
    // The tag->handler lookup and call are the one structural erasure here, as
    // `AgentEvent.match` does internally: the compiler cannot relate a runtime
    // tag to the handler's narrowed event type. The `H extends Handlers`
    // constraint already type-checked each handler against its tag at the call.
    const table = handlers as Record<
      string,
      ((event: AgentEvent.AgentEvent, envelope: AgentEventEnvelope) => Effect.Effect<void, ErrorsOf<H>, ServicesOf<H>>) | undefined
    >
    const handler = table[envelope.event._tag]
    const ran = handler === undefined ? Effect.void : handler(envelope.event, envelope)
    return ran.pipe(
      Effect.catchCause((cause) =>
        options?.onError === undefined
          ? Effect.logError("Hooks: a handler failed", cause)
          : options.onError(cause, envelope))
    )
  })
