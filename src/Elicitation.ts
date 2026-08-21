import { Deferred, Effect, Option, Ref, Schema } from "effect"

/**
 * Execution that needs an answer from outside before it can continue.
 *
 * Tool approval is one instance, not the concept. The same shape covers asking
 * a user a question, requesting a review or an edit, obtaining a credential,
 * and waiting on an external workflow signal — all of which are "the run has
 * stopped because it needs something a model cannot supply".
 *
 * Deliberately not called *interrupt*. In this codebase, and in Effect
 * generally, interruption means a fibre being torn down; `AgentSession.interrupt`
 * already means exactly that. A pause that resumes is a different thing, and
 * giving it the same word would make both harder to reason about. MCP calls
 * this elicitation, which is the closest existing term.
 *
 * The seam is what makes it work in both interpreters. Locally an elicitation
 * is a `Deferred`; under `/durable` it is a `DurableDeferred`, so a submission
 * waiting for a human survives the process it started in. Neither the harness
 * nor the agent knows which.
 */

/** What the run is asking for. */
export const Request = Schema.Struct({
  id: Schema.String,
  /**
   * What kind of answer is wanted — `"tool-approval"`, or whatever an
   * application defines. Consumers dispatch on this.
   */
  kind: Schema.String,
  /** Described by the `kind`. Opaque to the harness. */
  detail: Schema.Unknown
})
export type Request = typeof Request.Type

/** The answer. */
export const Response = Schema.Struct({
  id: Schema.String,
  /**
   * Whether the run may proceed.
   *
   * Refusal is an answer, not a failure: the caller decided, and the run needs
   * to know. What the run *does* about it is the run's business.
   */
  granted: Schema.Boolean,
  /** Anything the answer carries — edited input, a credential, a choice. */
  value: Schema.optional(Schema.Unknown)
})
export type Response = typeof Response.Type

/**
 * Where a paused run waits, and where an answer is delivered.
 *
 * `elicit` blocks until answered. That is the point: the run is paused, not
 * failed, and a caller that wants a bound puts a timeout around `prompt` the
 * way it would around anything else.
 */
export interface Elicitor {
  /**
   * Pause until answered.
   *
   * `announce` is run *after* the request is registered and before the wait
   * begins, and the ordering is the contract rather than an implementation
   * detail. Announcing first looks equivalent and is not: the only sensible
   * way to answer is to react to the announcement, and a consumer that does so
   * promptly would answer a request nothing was yet waiting for. The answer
   * would be reported as unmatched and the run would hang — with the event
   * stream showing a question that was asked and answered.
   */
  readonly elicit: (
    request: Request,
    announce: Effect.Effect<void>
  ) => Effect.Effect<Response>
  /**
   * Answer a pending request. `false` if nothing was waiting for it — a late
   * answer to a run that has already moved on, which is worth telling the
   * caller rather than swallowing.
   */
  readonly respond: (response: Response) => Effect.Effect<boolean>
  /** What is currently waiting, for a UI that has to render it. */
  readonly pending: Effect.Effect<ReadonlyArray<Request>>
}

/**
 * Builds the elicitor a session uses.
 *
 * `sessionId` is passed so an implementation that needs durable identity can
 * derive one, exactly as `InputChannel.Factory` does.
 */
export interface Factory {
  readonly make: (sessionId: string) => Effect.Effect<Elicitor>
}

/**
 * Backed by in-memory `Deferred`s.
 *
 * A paused run holds a fibre in the session's scope, so closing the scope
 * releases it: an unanswered elicitation cannot outlive its session.
 */
export const memory: Factory = {
  make: () =>
    Effect.gen(function* () {
      const waiting = yield* Ref.make(
        new Map<string, { request: Request; deferred: Deferred.Deferred<Response> }>()
      )

      return {
        elicit: (request, announce) =>
          Effect.gen(function* () {
            const deferred = yield* Deferred.make<Response>()
            yield* Ref.update(waiting, (all) =>
              new Map(all).set(request.id, { request, deferred })
            )
            // Registered, then announced, then awaited. See `elicit`.
            yield* announce
            // Removed however the wait ends, including interruption: a session
            // that is torn down mid-question must not keep reporting it as
            // pending.
            return yield* Deferred.await(deferred).pipe(
              Effect.ensuring(
                Ref.update(waiting, (all) => {
                  const next = new Map(all)
                  next.delete(request.id)
                  return next
                })
              )
            )
          }),
        respond: (response) =>
          Effect.gen(function* () {
            const found = Option.fromNullishOr(
              (yield* Ref.get(waiting)).get(response.id)
            )
            if (Option.isNone(found)) return false
            return yield* Deferred.succeed(found.value.deferred, response)
          }),
        pending: Effect.map(Ref.get(waiting), (all) =>
          Array.from(all.values(), (entry) => entry.request)
        )
      }
    })
}

/**
 * An elicitor that answers nothing, which is the default.
 *
 * Without one, a run reaching an approval-requiring tool would pause forever,
 * and every agent that has such a tool would appear to hang. Refusing is the
 * behaviour that existed before elicitation did, and it stays the default: a
 * caller opts *in* to being asked.
 */
export const denied: Factory = {
  make: () =>
    Effect.succeed({
      elicit: (request, announce) =>
        Effect.as(announce, { id: request.id, granted: false }),
      respond: () => Effect.succeed(false),
      pending: Effect.succeed([])
    })
}
