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
export const SessionId = Schema.String.pipe(Schema.brand("@doeixd/effect-agent/SessionId"))
export type SessionId = typeof SessionId.Type

export const SubmissionId = Schema.String.pipe(Schema.brand("@doeixd/effect-agent/SubmissionId"))
export type SubmissionId = typeof SubmissionId.Type

export const RunId = Schema.String.pipe(Schema.brand("@doeixd/effect-agent/RunId"))
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
  const elicitations = yield* Ref.make(new Map<string, number>())

  return {
    nextRun: Ref.updateAndGet(runs, (n) => n + 1).pipe(
      Effect.map((n) => runId(`run-${n}`))
    ),
    nextElicitation: (submissionId) =>
      Ref.modify(elicitations, (counts) => {
        const n = (counts.get(submissionId) ?? 0) + 1
        return [elicitationId(submissionId, n), new Map(counts).set(submissionId, n)]
      })
  } satisfies IdSource
})

let sessionCounter = 0

export const nextSessionId = Effect.sync(() => {
  sessionCounter = sessionCounter + 1
  return sessionId(`session-${sessionCounter}`)
})
