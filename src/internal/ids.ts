import { Effect, Ref, Schema } from "effect"

/**
 * Correlation identifiers.
 *
 * Defined as Schemas rather than hand-rolled branded aliases so they carry a
 * codec and a validator, not just a compile-time tag. Brands are namespaced so
 * they cannot collide with an id of the same name from another package. Anything that later
 * serialises a session — a store, an RPC boundary — decodes ids through these
 * instead of restating the shape.
 */
export const SessionId = Schema.String.pipe(Schema.brand("affe-agent/SessionId"))
export type SessionId = typeof SessionId.Type

export const SubmissionId = Schema.String.pipe(Schema.brand("affe-agent/SubmissionId"))
export type SubmissionId = typeof SubmissionId.Type

export const RunId = Schema.String.pipe(Schema.brand("affe-agent/RunId"))
export type RunId = typeof RunId.Type

export const sessionId = (value: string): SessionId => value as SessionId
export const submissionId = (value: string): SubmissionId =>
  value as SubmissionId
export const runId = (value: string): RunId => value as RunId

/**
 * Session-local counters.
 *
 * Ids are sequential rather than random: deterministic tests can assert on
 * them, and a session's event log stays readable.
 */
export interface IdSource {
  readonly nextRun: Effect.Effect<RunId>
  /**
   * The next elicitation id for a submission: `${submissionId}:elicit-${n}`.
   *
   * Namespaced by submission, not merely session-local. A session-local
   * counter restarted per execution under the durable client, so every
   * submission's first question was `elicit-1` -- and a caller holding the
   * id of submission 1's question could answer submission 2's with it. The
   * counter is per submission, so a replayed submission asks under the same
   * ids it asked under the first time, which is what lets an answer given
   * before a restart still match afterwards.
   */
  readonly nextElicitation: (submissionId: SubmissionId) => Effect.Effect<string>
}

/** The id of a submission's n-th question, for a caller that must answer without having watched it asked. */
export const elicitationId = (submissionId: string, n: number): string =>
  `${submissionId}:elicit-${n}`

export const makeIdSource = Effect.gen(function* () {
  const runs = yield* Ref.make(0)
  // Only the current submission's counter is ever needed: a session claims one
  // submission at a time, and a submission that has settled never asks another
  // question. Keeping one entry rather than a map keyed by every submission
  // bounds a long-lived session's memory to O(1); the counter resets when a
  // new submission starts. Durable replay reuses the same submission id in a
  // fresh source, so it starts at 1 each time exactly as the first run did.
  const elicitations = yield* Ref.make({ submissionId: "", n: 0 })

  return {
    nextRun: Ref.updateAndGet(runs, (n) => n + 1).pipe(
      Effect.map((n) => runId(`run-${n}`))
    ),
    nextElicitation: (submissionId) =>
      Ref.modify(elicitations, (state) => {
        const n = state.submissionId === submissionId ? state.n + 1 : 1
        return [elicitationId(submissionId, n), { submissionId, n }]
      })
  } satisfies IdSource
})

let sessionCounter = 0

export const nextSessionId = Effect.sync(() => {
  sessionCounter = sessionCounter + 1
  return sessionId(`session-${sessionCounter}`)
})
