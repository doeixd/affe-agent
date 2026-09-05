import { Effect, Ref, Schema } from "effect"
import * as Namespace from "./namespace.js"

/**
 * Correlation identifiers.
 *
 * Defined as Schemas rather than hand-rolled branded aliases so they carry a
 * codec and a validator, not just a compile-time tag. Brands are namespaced so
 * they cannot collide with an id of the same name from another package. Anything that later
 * serialises a session — a store, an RPC boundary — decodes ids through these
 * instead of restating the shape.
 */
export const SessionId = Schema.String.pipe(Schema.brand(Namespace.tag("SessionId")))
export type SessionId = typeof SessionId.Type

export const SubmissionId = Schema.String.pipe(Schema.brand(Namespace.tag("SubmissionId")))
export type SubmissionId = typeof SubmissionId.Type

export const RunId = Schema.String.pipe(Schema.brand(Namespace.tag("RunId")))
export type RunId = typeof RunId.Type

export const sessionId = (value: string): SessionId => value as SessionId
export const submissionId = (value: string): SubmissionId =>
  value as SubmissionId
export const runId = (value: string): RunId => value as RunId

/**
 * Session-local counters, qualified by the session.
 *
 * Ids are sequential rather than random: deterministic tests can assert on
 * them, and a session's event log stays readable. They carry the session
 * that minted them (`session-3:run-1`) because a counter alone is unique
 * only inside one session, and two things that share state across sessions
 * found that out in one day: a budget shared across sessions dropped the
 * second session's charges as replays of the first's, and a child's
 * forwarded approval had exactly the id of its parent's own. Each was fixed
 * with a local prefix; this is the prefix in the one place ids are made,
 * so the next shared structure is safe by construction. The durable store
 * already minted `${sessionId}:submission-N`; this makes the in-memory
 * session agree with it.
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
/**
 * The session a run id -- or anything that starts with one, such as a
 * `Budget.Occurrence` -- was minted by: the prefix before `:run-`. A string
 * with no such marker is its own session, so a key from outside this
 * module's format is bucketed alone rather than misfiled.
 */
export const sessionOfRun = (runId: string): string => {
  const at = runId.indexOf(":run-")
  return at === -1 ? runId : runId.slice(0, at)
}

export const elicitationId = (submissionId: string, n: number): string =>
  `${submissionId}:elicit-${n}`

export const makeIdSource = (sessionId: SessionId) => Effect.gen(function* () {
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
      Effect.map((n) => runId(`${sessionId}:run-${n}`))
    ),
    nextElicitation: (submissionId) =>
      Ref.modify(elicitations, (state) => {
        const n = state.submissionId === submissionId ? state.n + 1 : 1
        return [elicitationId(submissionId, n), { submissionId, n }]
      })
  } satisfies IdSource
})

/** The default name of a session's n-th submission: qualified by the session, as the durable store's are. */
export const submissionName = (sessionId: string, count: number): string =>
  `${sessionId}:submission-${count}`

let sessionCounter = 0

export const nextSessionId = Effect.sync(() => {
  sessionCounter = sessionCounter + 1
  return sessionId(`session-${sessionCounter}`)
})
