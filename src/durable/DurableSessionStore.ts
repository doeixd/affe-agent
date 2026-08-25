import { Effect, Option, Ref, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { SqlClient } from "effect/unstable/sql"
import * as Elicitation from "../Elicitation.js"
import { isStorageError, StorageError } from "../Errors.js"
import { detailOf } from "../internal/detail.js"

/**
 * The durable logical session, as distinct from any one workflow execution.
 *
 * The existing durable API keys a submission by session, which is enough for
 * one live submission but not for the session contract `AgentClient` speaks:
 * a *logical* session outlives every execution that runs inside it. A client
 * handle can disappear, the process that started a prompt can die, and the
 * conversation must still be there — with its canonical history — when some
 * later process reacquires it by id.
 *
 * This store is the durable counterpart of the local session's runtime state.
 * It deliberately does not copy every local field: it persists only what an
 * external process must know to address the session correctly.
 *
 *   - status  — is there work a caller could steer or follow up on;
 *   - history — the canonical transcript between submissions;
 *   - the claimed request — what a running submission was asked, so a crash
 *     between "claimed" and "dispatched" can be reconciled instead of leaving
 *     the session permanently busy (see `Claim`).
 *
 * Workflow durability, canonical history and client event delivery remain
 * separate concerns; this store is only the projection the last two stand on.
 */

/** What a session record says about admission. */
export const SessionStatus = Schema.Literals(["idle", "running"])
export type SessionStatus = typeof SessionStatus.Type

/**
 * A claimed submission, persisted at claim time.
 *
 * The important crash boundary is:
 *
 *   claim session -> process dies -> dispatch workflow
 *
 * If the claim recorded only `status = "running"`, the session would be
 * permanently busy with no workflow behind it. So the claim stores the request
 * itself — prompt and streaming choice — plus an optional execution id once
 * dispatch has happened. Reacquiring the session can then reconcile a claim
 * whose dispatch never landed by deriving the same execution id and
 * dispatching again, idempotently.
 *
 * The general rule: **persist intent before relying on a process to carry it
 * forward.**
 */
export const Claim = Schema.Struct({
  submissionId: Schema.String,
  /** JSON-encoded `Prompt`, the same wire form the channels use. */
  prompt: Schema.String,
  /** Part of the payload, so replay makes the same choice the original did. */
  stream: Schema.Boolean,
  /** Present once the workflow has been dispatched. */
  executionId: Schema.optional(Schema.String),
  /**
   * The caller's own name for this request, if it gave one.
   *
   * Stored so a retry can be recognised as the *same* request rather than a
   * second one. See `claim` for why that matters and why the key has to come
   * from the caller rather than be derived here.
   */
  key: Schema.optional(Schema.String)
})
export type Claim = typeof Claim.Type

/** One durable logical session. */
export const SessionRecord = Schema.Struct({
  sessionId: Schema.String,
  status: SessionStatus,
  /** How many submissions this session has accepted, ever. */
  submissionCount: Schema.Number,
  /**
   * The active claim while `running`; absent otherwise.
   *
   * Stored inline rather than under a second key so the claim and the status
   * cannot disagree — they are one record, written in one step.
   */
  claim: Schema.OptionFromUndefinedOr(Claim),
  /** Canonical history as of the last finished submission. JSON-encoded. */
  history: Schema.String
})
export type SessionRecord = typeof SessionRecord.Type

/**
 * The outcome of asking an idle session for work.
 *
 * A tagged value rather than a typed error because the *caller* decides what
 * each means — the client adapter maps them onto protocol errors, a
 * reconciliation pass retries them differently, and neither should need the
 * store to know their vocabulary.
 */
export type ClaimOutcome =
  | {
      readonly _tag: "Claimed"
      readonly claim: Claim
      /** Canonical history as of the claim, JSON-encoded: what the submission starts from. */
      readonly history: string
    }
  | { readonly _tag: "Busy"; readonly claim: Claim }
  | { readonly _tag: "Missing" }

/**
 * The durable session registry.
 *
 * Every transition is atomic. `claim` is the load-bearing one: moving an idle
 * session to `running` and allocating its submission id must be one operation.
 * Reading the status and then writing it back would recreate exactly the
 * check-then-act race `AgentSession.claim` already fixed locally — two
 * concurrent prompts would both see `idle`, and one input would be silently
 * dropped or silently coalesced.
 */
export interface DurableSessionStore {
  /** Read one session, if it exists. */
  readonly get: (
    sessionId: string
  ) => Effect.Effect<Option.Option<SessionRecord>, StorageError>

  /**
   * Read one session, creating it if absent.
   *
   * Creation initialises canonical history the way a local session does: the
   * caller passes the system message derived from the agent's instructions, so
   * the first prompt's model call sees what a local first prompt would have.
   */
  readonly getOrCreate: (
    sessionId: string,
    initialHistory: Prompt.Prompt
  ) => Effect.Effect<SessionRecord, StorageError>

  /**
   * Ask an existing idle session to accept a submission.
   *
   * Atomically: records the request, allocates the submission id, clears
   * any elicitation projection a previous submission left behind, and moves
   * the session to `running` in one step. Returns `Busy` — carrying the
   * incumbent claim — if work is already active, and `Missing` if no such
   * session exists.
   */
  readonly claim: (
    sessionId: string,
    submission: {
      readonly prompt: Prompt.Prompt
      readonly stream: boolean
      /**
       * A caller's own name for this request, making a retry safe.
       *
       * **A `StorageError` from `claim` means "unknown", not "did not
       * happen".** The write can commit and the acknowledgement be lost -- a
       * connection dropped after the transaction, a process killed between the
       * commit and the reply -- and no store can tell the caller which
       * occurred. Without a key, a retry is a *second* request: it finds the
       * first claim in place and is refused as `Busy`, so the caller believes
       * nothing started while the session is claimed and, once reconciled,
       * runs work it was told had failed.
       *
       * With a key, a repeat is recognised: a claim already held under the
       * same key returns `Claimed` with that same claim, so retrying is
       * idempotent and the caller converges on the truth.
       *
       * The key has to come from the caller because nothing here can derive
       * one. The submission id is allocated by the store, so a retrying caller
       * cannot know it; the execution id is a pure function of the session,
       * not of the request; and hashing the prompt would coalesce a user who
       * legitimately asked the same thing twice. Anything stable that already
       * identifies the request works -- an HTTP request id, a queue message
       * id, a job id.
       */
      readonly key?: string | undefined
    }
  ) => Effect.Effect<ClaimOutcome, StorageError>

  /**
   * Record which workflow execution is carrying the claim.
   *
   * Written after dispatch so reconciliation can tell "the process died before
   * dispatching" from "the workflow is running somewhere".
   */
  readonly attachExecution: (
    sessionId: string,
    submissionId: string,
    executionId: string
  ) => Effect.Effect<void, StorageError>

  /**
   * Complete a submission however it ends — succeeded, failed, interrupted.
   *
   * The terminal transition is one atomic step: history is advanced to what
   * committed during the run, and the session returns to `idle`. There is no
   * separate failure form because a failed submission commits exactly like a
   * completed one — only fully finished turns are in the history either way.
   *
   * The elicitation projection is cleared in the same step. Request ids are
   * session-local ordinals that restart with every execution, so a request
   * or recorded answer left behind by one submission — a crash between
   * delivering an answer and taking it — would be mistaken for the next
   * submission's. Nothing of a finished submission's projection survives it.
   *
   * `false` when the session's active claim does not match, which means this
   * outcome landed after another one already did.
   */
  readonly finish: (
    sessionId: string,
    submissionId: string,
    history: Prompt.Prompt
  ) => Effect.Effect<boolean, StorageError>

  // -- Elicitation projection -------------------------------------------------
  //
  // A suspended workflow holds no memory, so `DurableElicitation.pending`
  // cannot enumerate anything: requests must be projected into shared state
  // *before* the workflow suspends on its deferred, and removed afterwards.

  /** Record a request the run is about to start waiting on. */
  readonly addPendingRequest: (
    sessionId: string,
    request: Elicitation.Request
  ) => Effect.Effect<void, StorageError>

  /** Everything the session is currently waiting to be told. */
  readonly pendingRequests: (
    sessionId: string
  ) => Effect.Effect<ReadonlyArray<Elicitation.Request>, StorageError>

  /**
   * Deliver an answer, atomically moving the request from waiting to answered.
   *
   * Persisting the answer *before* waking the workflow is what makes the crash
   * between the two recoverable: the answer exists even if the process that
   * wrote it dies before completing the deferred. `false` when nothing was
   * waiting for that id — the same contract `Elicitation.respond` keeps.
   */
  readonly answerRequest: (
    sessionId: string,
    response: Elicitation.Response
  ) => Effect.Effect<boolean, StorageError>

  /**
   * Take a recorded answer, removing it in the same step.
   *
   * Reconciliation delivers answers idempotently: if the original delivery
   * crashed after recording but before waking the workflow, a later attempt
   * finds the answer here and completes the deferred without asking anyone.
   */
  readonly takeAnswer: (
    sessionId: string,
    requestId: string
  ) => Effect.Effect<Option.Option<Elicitation.Response>, StorageError>

  /**
   * Answers recorded but not yet taken.
   *
   * What a reconciliation pass enumerates: each is an answer the API accepted
   * whose delivery to the workflow may never have happened.
   */
  readonly recordedAnswers: (
    sessionId: string
  ) => Effect.Effect<ReadonlyArray<Elicitation.Response>, StorageError>

  /** Forget a request whose answer the run has consumed. */
  readonly removeRequest: (
    sessionId: string,
    requestId: string
  ) => Effect.Effect<void, StorageError>
}

// -- Encoded prompts -------------------------------------------------------------

/**
 * Prompts cross storage as JSON; an unencodable prompt is a bug, not a case.
 *
 * Encoding stays a defect deliberately. The value was assembled by this
 * process a moment ago, so a schema that cannot encode it means the library
 * is wrong about its own types -- there is nothing a caller could do with
 * that information but crash, which is what a defect already does.
 */
export const encodeHistory = (
  prompt: Prompt.Prompt
): Effect.Effect<string> =>
  Schema.encodeEffect(Prompt.Prompt)(prompt).pipe(
    Effect.map((encoded) => JSON.stringify(encoded)),
    Effect.orDie
  )

/**
 * Decoding is the other direction, and it is not the same claim.
 *
 * This value came *back* from storage, so it can be a truncated write, a row
 * written by an older schema version, a half-committed transaction or a
 * corrupted blob. None of those are bugs in this library and all of them are
 * conditions a caller can act on -- retry elsewhere, quarantine the session,
 * report it -- so they belong in the error channel.
 *
 * This was `Effect.orDie`, which declared the operation infallible while
 * reading from a database. See `StorageError` for what that cost.
 */
export const decodeHistory = (
  encoded: string,
  sessionId?: string
): Effect.Effect<Prompt.Prompt, StorageError> =>
  Effect.try(() => JSON.parse(encoded) as unknown).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Prompt.Prompt)),
    Effect.mapError(
      (cause) =>
        new StorageError({
          operation: "decodeHistory",
          ...(sessionId === undefined ? {} : { sessionId }),
          detail: detailOf(cause)
        })
    )
  )

// -- Memory implementation ---------------------------------------------------------

interface MemoryState {
  readonly sessions: Map<string, SessionRecord>
  readonly pending: Map<string, Map<string, Elicitation.Request>>
  readonly answered: Map<string, Map<string, Elicitation.Response>>
}

const emptyState: MemoryState = {
  sessions: new Map(),
  pending: new Map(),
  answered: new Map()
}

const setSession = (
  all: MemoryState,
  updated: SessionRecord
): MemoryState => ({
  ...all,
  sessions: new Map(all.sessions).set(updated.sessionId, updated)
})

/**
 * An in-process store over `Ref.modify`.
 *
 * Atomicity comes free: every transition is one `Ref.modify`, so concurrent
 * claims serialise on the reference rather than on discipline. What is *not*
 * durable here is the usual single-process caveat — the map dies with the
 * process, which suits tests and single-node development and is silently wrong
 * under a cluster. A SQL implementation backs the same interface with
 * transactions instead.
 */
export const memoryStore: Effect.Effect<DurableSessionStore> =
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState)

    return {
      get: (sessionId) =>
        Effect.map(
          Ref.get(state),
          (all) => Option.fromNullishOr(all.sessions.get(sessionId))
        ),

      getOrCreate: (sessionId, initialHistory) =>
        // Encoding happens *before* the transition: `Ref.modify` must stay a
        // pure step, and encoding is deterministic, so doing it first changes
        // nothing about atomicity.
        Effect.flatMap(encodeHistory(initialHistory), (encoded) =>
          Ref.modify(state, (all): [SessionRecord, MemoryState] => {
            const found = all.sessions.get(sessionId)
            if (found !== undefined) return [found, all]
            const created: SessionRecord = {
              sessionId,
              status: "idle",
              submissionCount: 0,
              claim: Option.none(),
              history: encoded
            }
            return [created, setSession(all, created)]
          })
        ),

      claim: (sessionId, submission) =>
        Effect.flatMap(encodeHistory(submission.prompt), (encoded) =>
          Ref.modify(state, (all): [ClaimOutcome, MemoryState] => {
            const found = all.sessions.get(sessionId)
            if (found === undefined) return [{ _tag: "Missing" }, all]
            if (Option.isSome(found.claim)) {
              // The same request again, not a second one: a caller whose
              // acknowledgement was lost is told what it would have been told
              // the first time. See `claim`'s contract.
              return submission.key !== undefined &&
                  found.claim.value.key === submission.key
                ? [
                  { _tag: "Claimed", claim: found.claim.value, history: found.history },
                  all
                ]
                : [{ _tag: "Busy", claim: found.claim.value }, all]
            }
            // The id derives from the session-local ordinal, which makes it
            // stable across processes — a later reconciliation pass names the
            // same submission without having observed the original claim.
            const claim: Claim = {
              submissionId: `${sessionId}:submission-${found.submissionCount + 1}`,
              prompt: encoded,
              stream: submission.stream,
              ...(submission.key === undefined ? {} : { key: submission.key })
            }
            const updated: SessionRecord = {
              ...found,
              status: "running",
              submissionCount: found.submissionCount + 1,
              claim: Option.some(claim)
            }
            // An idle session has nothing outstanding; whatever the
            // projection still holds under this session is a previous
            // submission's leftovers, and its ids are about to be reused.
            const pending = new Map(all.pending)
            pending.delete(sessionId)
            const answered = new Map(all.answered)
            answered.delete(sessionId)
            return [
              { _tag: "Claimed", claim, history: found.history },
              { ...setSession(all, updated), pending, answered }
            ]
          })
        ),

      attachExecution: (sessionId, submissionId, executionId) =>
        Ref.update(state, (all) => {
          const found = all.sessions.get(sessionId)
          if (
            found === undefined ||
            Option.isNone(found.claim) ||
            found.claim.value.submissionId !== submissionId
          ) {
            return all
          }
          const updated: SessionRecord = {
            ...found,
            claim: Option.some({ ...found.claim.value, executionId })
          }
          return setSession(all, updated)
        }),

      finish: (sessionId, submissionId, history) =>
        Effect.flatMap(encodeHistory(history), (encoded) =>
          Ref.modify(state, (all): [boolean, MemoryState] => {
            const found = all.sessions.get(sessionId)
            if (
              found === undefined ||
              Option.isNone(found.claim) ||
              found.claim.value.submissionId !== submissionId
            ) {
              return [false, all]
            }
            const updated: SessionRecord = {
              ...found,
              status: "idle",
              claim: Option.none(),
              history: encoded
            }
            const pending = new Map(all.pending)
            pending.delete(sessionId)
            const answered = new Map(all.answered)
            answered.delete(sessionId)
            return [true, { ...setSession(all, updated), pending, answered }]
          })
        ),

      addPendingRequest: (sessionId, request) =>
        Ref.update(state, (all) => {
          // Idempotent: a replayed run asks under the same id, and one that
          // was already answered keeps its answer rather than waiting again.
          if (all.answered.get(sessionId)?.has(request.id)) return all
          return {
            ...all,
            pending: new Map(all.pending).set(
              sessionId,
              new Map(all.pending.get(sessionId)).set(request.id, request)
            )
          }
        }),

      pendingRequests: (sessionId) =>
        Effect.map(
          Ref.get(state),
          (all) => Array.from((all.pending.get(sessionId) ?? new Map()).values())
        ),

      answerRequest: (sessionId, response) =>
        Ref.modify(state, (all): [boolean, MemoryState] => {
          const waiting = all.pending.get(sessionId) ?? new Map()
          if (!waiting.has(response.id)) return [false, all]
          // Waiting -> answered in the same transition, so an answer is never
          // in neither place (the caller was told `true`) nor both (a retry
          // would deliver it twice to the run).
          const remaining = new Map(waiting)
          remaining.delete(response.id)
          const nextAnswered = new Map(all.answered).set(
            sessionId,
            new Map(all.answered.get(sessionId)).set(response.id, response)
          )
          return [
            true,
            {
              ...all,
              pending: new Map(all.pending).set(sessionId, remaining),
              answered: nextAnswered
            }
          ]
        }),

      takeAnswer: (sessionId, requestId) =>
        Ref.modify(state, (all): [Option.Option<Elicitation.Response>, MemoryState] => {
          const answered = all.answered.get(sessionId)
          const found = Option.fromNullishOr(answered?.get(requestId))
          if (Option.isNone(found) || answered === undefined) {
            return [Option.none(), all]
          }
          const remaining = new Map(answered)
          remaining.delete(requestId)
          return [
            found,
            { ...all, answered: new Map(all.answered).set(sessionId, remaining) }
          ]
        }),

      recordedAnswers: (sessionId) =>
        Effect.map(
          Ref.get(state),
          (all) => Array.from((all.answered.get(sessionId) ?? new Map()).values())
        ),

      removeRequest: (sessionId, requestId) =>
        Ref.update(state, (all) => {
          const waiting = all.pending.get(sessionId)
          if (waiting === undefined || !waiting.has(requestId)) return all
          const remaining = new Map(waiting)
          remaining.delete(requestId)
          return {
            ...all,
            pending: new Map(all.pending).set(sessionId, remaining)
          }
        })
    }
  })

// -- SQL implementation --------------------------------------------------------------

export const sqlSessionTable = "effect_agent_session"
export const sqlElicitationTable = "effect_agent_elicitation"

const escapeIdentifier = (name: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    // Table names reach `sql.literal`, which does not parameterise.
    throw new Error(`Invalid table name: ${name}`)
  }
  return name
}

interface SessionRow {
  readonly session_id: string
  readonly status: string
  readonly submission_count: number
  readonly claim: string | null
  readonly history: string
}

/** Encoding a value we just built: a defect, for the reason `encodeHistory` gives. */
const encodeJson =
  <S extends Schema.Codec<any, any, never, never>>(schema: S) =>
  (value: S["Type"]): Effect.Effect<string> =>
    Schema.encodeEffect(schema)(value).pipe(
      Effect.map((encoded) => JSON.stringify(encoded)),
      Effect.orDie
    )

/** Decoding a value from storage: a condition, for the reason `decodeHistory` gives. */
const decodeJson =
  <S extends Schema.Codec<any, any, never, never>>(schema: S, operation: string) =>
  (encoded: string): Effect.Effect<S["Type"], StorageError> =>
    Effect.try(() => JSON.parse(encoded) as unknown).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(
        (cause) => new StorageError({ operation, detail: detailOf(cause) })
      )
    )

const encodeClaim = encodeJson(Claim)
const decodeClaim = decodeJson(Claim, "decodeClaim")
const encodeRequest = encodeJson(Elicitation.Request)
const decodeRequest = decodeJson(Elicitation.Request, "decodeRequest")
const encodeResponse = encodeJson(Elicitation.Response)
const decodeResponse = decodeJson(Elicitation.Response, "decodeResponse")

const rowToRecord = (row: SessionRow): Effect.Effect<SessionRecord, StorageError> =>
  Effect.map(
    row.claim === null
      ? Effect.succeed(Option.none<Claim>())
      : Effect.map(decodeClaim(row.claim), Option.some),
    (claim): SessionRecord => ({
      sessionId: row.session_id,
      status: row.status === "running" ? "running" : "idle",
      submissionCount: Number(row.submission_count),
      claim,
      history: row.history
    })
  )

/**
 * A session store backed by SQL, for deployments with more than one node.
 *
 * Every transition that guards an invariant is one transaction — `claim`,
 * `finish`, `answerRequest`, `takeAnswer` — so two processes racing for the
 * same idle session serialise on the database rather than on discipline.
 * Sessions live in one table with the claim inline (one row, one write: the
 * status and the claim cannot disagree); elicitation requests and recorded
 * answers share a second table, distinguished by `state`.
 *
 * Any deployment already has a `SqlClient`, because `ClusterWorkflowEngine`
 * needs one for its journal. `sqlStoreWithTables` creates the tables; a
 * deployment managing its own schema uses `sqlStore` over existing ones.
 *
 * ## What "one transaction" does and does not guarantee (R66)
 *
 * A transaction gives atomicity and rollback. It does **not**, by itself, give
 * serialisability: under the read-committed isolation that most engines
 * default to, two transactions can each `SELECT`, each see the same absence,
 * and each `INSERT`. The transitions here are written as select-then-write, so
 * on such an engine:
 *
 * - `getOrCreate` can race into a uniqueness violation rather than one caller
 *   creating and the other reading;
 * - a claim decided from a prior read can be admitted twice, with the loser
 *   surfacing as a `StorageError` rather than the busy answer it should be.
 *
 * The suite runs against SQLite, which serialises writers at the file level
 * and therefore cannot exhibit either -- so passing tests are not evidence for
 * the portable claim, which is exactly why this paragraph exists rather than a
 * checkmark.
 *
 * A deployment on Postgres, MySQL or anything else with row-level concurrency
 * should either run these transitions at `SERIALIZABLE`, or replace them with
 * conditional statements that encode the precondition in the mutation --
 * `INSERT … ON CONFLICT DO NOTHING`, `UPDATE … WHERE status = 'idle'` --
 * rather than in a preceding read. Both are engine-specific, which is why this
 * portable module states the requirement instead of guessing at the dialect.
 */
export const sqlStore = (
  options?: {
    readonly sessionTable?: string | undefined
    readonly elicitationTable?: string | undefined
  }
): Effect.Effect<DurableSessionStore, never, SqlClient.SqlClient> =>
  Effect.map(SqlClient.SqlClient, (sql) => {
    const sessions = sql.literal(
      escapeIdentifier(options?.sessionTable ?? sqlSessionTable)
    )
    const requests = sql.literal(
      escapeIdentifier(options?.elicitationTable ?? sqlElicitationTable)
    )

    /**
     * Every store operation's failure, named.
     *
     * A `SqlError` from the driver, or a `StorageError` a decoder already
     * raised, becomes one `StorageError` carrying the operation and session.
     * An existing `StorageError` passes through unchanged rather than being
     * wrapped, so the innermost description -- "decodeHistory", not "get" --
     * is the one the caller sees.
     *
     * This replaced `Effect.orDie` on each operation. See `StorageError` for
     * what declaring a database infallible cost us.
     */
    const storage =
      (operation: string, sessionId?: string) =>
      <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, StorageError> =>
        Effect.mapError(effect, (cause): StorageError =>
          isStorageError(cause)
            ? cause
            : new StorageError({
                operation,
                ...(sessionId === undefined ? {} : { sessionId }),
                detail: detailOf(cause)
              })
        )

    const readRow = (sessionId: string) =>
      sql<SessionRow>`SELECT * FROM ${sessions} WHERE session_id = ${sessionId}`.pipe(
        Effect.map((rows) => Option.fromNullishOr(rows[0]))
      )

    const readRecord = (sessionId: string) =>
      readRow(sessionId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none<SessionRecord>()),
            onSome: (row) => Effect.map(rowToRecord(row), Option.some)
          })
        )
      )

    return {
      get: (sessionId) => readRecord(sessionId).pipe(storage("get", sessionId)),

      getOrCreate: (sessionId, initialHistory) =>
        Effect.flatMap(encodeHistory(initialHistory), (encoded) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                const found = yield* readRecord(sessionId)
                if (Option.isSome(found)) return found.value
                yield* sql`INSERT INTO ${sessions} ${sql.insert({
                  session_id: sessionId,
                  status: "idle",
                  submission_count: 0,
                  claim: null,
                  history: encoded
                })}`
                const created: SessionRecord = {
                  sessionId,
                  status: "idle",
                  submissionCount: 0,
                  claim: Option.none(),
                  history: encoded
                }
                return created
              })
            )
            .pipe(storage("getOrCreate", sessionId))
        ),

      claim: (sessionId, submission) =>
        Effect.flatMap(encodeHistory(submission.prompt), (encoded) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                const found = yield* readRecord(sessionId)
                if (Option.isNone(found)) {
                  return { _tag: "Missing" } as const
                }
                const record = found.value
                if (Option.isSome(record.claim)) {
                  // The same request again, not a second one. See `claim`'s
                  // contract: a lost acknowledgement is indistinguishable from
                  // a lost write, and the key is what tells them apart.
                  return submission.key !== undefined &&
                      record.claim.value.key === submission.key
                    ? ({
                      _tag: "Claimed",
                      claim: record.claim.value,
                      history: record.history
                    } as const)
                    : ({ _tag: "Busy", claim: record.claim.value } as const)
                }
                const claim: Claim = {
                  submissionId: `${sessionId}:submission-${record.submissionCount + 1}`,
                  prompt: encoded,
                  stream: submission.stream,
                  ...(submission.key === undefined ? {} : { key: submission.key })
                }
                const claimJson = yield* encodeClaim(claim)
                // The predicate restates the invariant in the statement, and
                // the row is read back to learn whether *this* claim landed.
                // SQLite serialises writers, but a database with row-level
                // concurrency (Postgres under READ COMMITTED) lets two
                // claimers read `claim IS NULL`, blocks the second on the
                // first's lock, and then matches zero rows for it. Returning
                // `Claimed` regardless would hand both the same submission.
                yield* sql`UPDATE ${sessions} SET status = 'running', submission_count = ${record.submissionCount + 1}, claim = ${claimJson} WHERE session_id = ${sessionId} AND claim IS NULL`
                const after = yield* readRecord(sessionId)
                const landed = Option.isSome(after) &&
                  Option.isSome(after.value.claim) &&
                  after.value.claim.value.submissionId === claim.submissionId
                if (!landed) {
                  return Option.isSome(after) && Option.isSome(after.value.claim)
                    ? ({ _tag: "Busy", claim: after.value.claim.value } as const)
                    : ({ _tag: "Missing" } as const)
                }
                // Nothing is outstanding on an idle session: see `finish`.
                yield* sql`DELETE FROM ${requests} WHERE session_id = ${sessionId}`
                return {
                  _tag: "Claimed",
                  claim,
                  history: record.history
                } as const
              })
            )
            .pipe(storage("claim", sessionId))
        ),

      attachExecution: (sessionId, submissionId, executionId) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const found = yield* readRecord(sessionId)
              if (
                Option.isNone(found) ||
                Option.isNone(found.value.claim) ||
                found.value.claim.value.submissionId !== submissionId
              ) {
                return
              }
              const claimJson = yield* encodeClaim({
                ...found.value.claim.value,
                executionId
              })
              yield* sql`UPDATE ${sessions} SET claim = ${claimJson} WHERE session_id = ${sessionId}`
            })
          )
          .pipe(storage("attachExecution", sessionId)),

      finish: (sessionId, submissionId, history) =>
        Effect.flatMap(encodeHistory(history), (encoded) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                const found = yield* readRecord(sessionId)
                if (
                  Option.isNone(found) ||
                  Option.isNone(found.value.claim) ||
                  found.value.claim.value.submissionId !== submissionId
                ) {
                  return false
                }
                yield* sql`UPDATE ${sessions} SET status = 'idle', claim = NULL, history = ${encoded} WHERE session_id = ${sessionId}`
                yield* sql`DELETE FROM ${requests} WHERE session_id = ${sessionId}`
                return true
              })
            )
            .pipe(storage("finish", sessionId))
        ),

      addPendingRequest: (sessionId, request) =>
        Effect.flatMap(encodeRequest(request), (encoded) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                // Idempotent: a replayed run asks under the same id, and an
                // already-answered one keeps its answer. Anything else under
                // this id is stale and is replaced.
                const existing = yield* sql<{
                  readonly state: string
                }>`SELECT state FROM ${requests} WHERE session_id = ${sessionId} AND request_id = ${request.id}`
                if (existing.length > 0) return
                yield* sql`INSERT INTO ${requests} ${sql.insert({
                  session_id: sessionId,
                  request_id: request.id,
                  state: "pending",
                  payload: encoded
                })}`
              })
            )
            .pipe(storage("addPendingRequest", sessionId))
        ),

      pendingRequests: (sessionId) =>
        sql<{
          readonly payload: string
        }>`SELECT payload FROM ${requests} WHERE session_id = ${sessionId} AND state = 'pending' ORDER BY id`.pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) => decodeRequest(row.payload))
          ),
          storage("pendingRequests", sessionId)
        ),

      answerRequest: (sessionId, response) =>
        Effect.flatMap(encodeResponse(response), (encoded) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                const waiting = yield* sql<{
                  readonly id: number
                }>`SELECT id FROM ${requests} WHERE session_id = ${sessionId} AND request_id = ${response.id} AND state = 'pending'`
                if (waiting.length === 0) return false
                yield* sql`UPDATE ${requests} SET state = 'answered', payload = ${encoded} WHERE id = ${waiting[0]!.id}`
                return true
              })
            )
            .pipe(storage("answerRequest", sessionId))
        ),

      takeAnswer: (sessionId, requestId) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const answered = yield* sql<{
                readonly id: number
                readonly payload: string
              }>`SELECT id, payload FROM ${requests} WHERE session_id = ${sessionId} AND request_id = ${requestId} AND state = 'answered'`
              if (answered.length === 0) {
                return Option.none<Elicitation.Response>()
              }
              yield* sql`DELETE FROM ${requests} WHERE id = ${answered[0]!.id}`
              return Option.some(yield* decodeResponse(answered[0]!.payload))
            })
          )
          .pipe(storage("takeAnswer", sessionId)),

      recordedAnswers: (sessionId) =>
        sql<{
          readonly payload: string
        }>`SELECT payload FROM ${requests} WHERE session_id = ${sessionId} AND state = 'answered' ORDER BY id`.pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) => decodeResponse(row.payload))
          ),
          storage("recordedAnswers", sessionId)
        ),

      removeRequest: (sessionId, requestId) =>
        sql`DELETE FROM ${requests} WHERE session_id = ${sessionId} AND request_id = ${requestId} AND state = 'pending'`.pipe(
          Effect.asVoid,
          storage("removeRequest", sessionId)
        )
    }
  })

/** As `sqlStore`, but creates the tables first if they are not there. */
export const sqlStoreWithTables = (
  options?: {
    readonly sessionTable?: string | undefined
    readonly elicitationTable?: string | undefined
  }
): Effect.Effect<DurableSessionStore, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const sessions = sql.literal(
      escapeIdentifier(options?.sessionTable ?? sqlSessionTable)
    )
    const requests = sql.literal(
      escapeIdentifier(options?.elicitationTable ?? sqlElicitationTable)
    )
    yield* sql`CREATE TABLE IF NOT EXISTS ${sessions} (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      submission_count INTEGER NOT NULL,
      claim TEXT,
      history TEXT NOT NULL
    )`.pipe(Effect.orDie)
    yield* sql`CREATE TABLE IF NOT EXISTS ${requests} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      state TEXT NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE (session_id, request_id)
    )`.pipe(Effect.orDie)
    return yield* sqlStore(options)
  })
