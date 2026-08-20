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
export const SessionId = Schema.String.pipe(Schema.brand("@effect-harness/SessionId"))
export type SessionId = typeof SessionId.Type

export const SubmissionId = Schema.String.pipe(Schema.brand("@effect-harness/SubmissionId"))
export type SubmissionId = typeof SubmissionId.Type

export const RunId = Schema.String.pipe(Schema.brand("@effect-harness/RunId"))
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
}

export const makeIdSource = Effect.gen(function* () {
  const runs = yield* Ref.make(0)

  return {
    nextRun: Ref.updateAndGet(runs, (n) => n + 1).pipe(
      Effect.map((n) => runId(`run-${n}`))
    )
  } satisfies IdSource
})

let sessionCounter = 0

export const nextSessionId = Effect.sync(() => {
  sessionCounter = sessionCounter + 1
  return sessionId(`session-${sessionCounter}`)
})
