import { Effect, Option, Ref, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { SqlClient } from "effect/unstable/sql"
import * as Elicitation from "../Elicitation.js"
import * as PromptWire from "../PromptWire.js"
import { isStorageError, StorageError } from "../Errors.js"
import { detailOf } from "../internal/detail.js"
import { escapeIdentifier } from "../internal/sqlIdentifier.js"
import * as Namespace from "../internal/namespace.js"

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
  /**
   * A typed input's encoded value, for an agent that declares one
   * (`AgentInput`); `prompt` is then empty, because the rendering is the
   * workflow's to produce -- the renderer may need services this process
   * does not have. Optional and additive: claims written before this field
   * decode unchanged.
   */
  input: Schema.optional(Schema.Unknown),
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
  key: Schema.optional(Schema.String),
  /**
   * The submitter's subject, when one was on the claiming fibre.
   *
   * Recorded here because the engine's fibres inherit nothing from the
   * caller: whatever the run must see has to ride the persisted intent
   * (`docs/plan-principal-on-tool-fibre.md`). Optional and additive, so
   * claims written before this field decode unchanged.
   */
  principal: Schema.optional(Schema.String)
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
      /** A typed input's encoded value; see `Claim.input`. */
      readonly input?: unknown
      readonly stream: boolean
      /** The submitter's subject, persisted on the claim. */
      readonly principal?: string | undefined
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
       *
       * **The window is the claim's lifetime, not forever.** The key lives on
       * the claim, so `finish` takes it away with the claim it belonged to --
       * which is what stops a key reused much later from coalescing into a
       * submission that has long since ended. The cost is the other side of
       * the same coin: a retry arriving *after* the submission completed is a
       * new request and starts one. A caller whose retries can outlive a whole
       * submission needs a dedup table with its own retention policy, which is
       * a larger mechanism than a field on the claim.
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
 * Prompts cross storage through the JSON-safe `PromptWire` codec; an
 * unencodable prompt is a bug, not a case.
 *
 * Encoding stays a defect deliberately. The value was assembled by this
 * process a moment ago, so a schema that cannot encode it means the library
 * is wrong about its own types -- there is nothing a caller could do with
 * that information but crash, which is what a defect already does.
 */
export const encodeHistory = (
  prompt: Prompt.Prompt
): Effect.Effect<string> =>
  Schema.encodeEffect(PromptWire.Prompt)(prompt).pipe(
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
    Effect.flatMap(Schema.decodeUnknownEffect(PromptWire.Prompt)),
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
              ...(submission.input === undefined ? {} : { input: submission.input }),
              stream: submission.stream,
              ...(submission.key === undefined ? {} : { key: submission.key }),
              ...(submission.principal === undefined ? {} : { principal: submission.principal })
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
          // First write wins, as everywhere else in the store. An id that is
          // already pending keeps the request it was created with rather
          // than being overwritten by a replay carrying a different payload.
          // This used to `.set` unconditionally, which disagreed with the SQL
          // store's `INSERT ... WHERE NOT EXISTS`; two implementations of one
          // contract get one answer, and SQL's is the one that matches the rule.
          if (all.pending.get(sessionId)?.has(request.id)) return all
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

export const sqlSessionTable = Namespace.table("session")
export const sqlElicitationTable = Namespace.table("elicitation")

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
 * default to, another transaction may commit between this one's `SELECT` and
 * its `UPDATE`. Anything decided from the read is stale by the time the write
 * lands. These transitions were all written as select-then-write, so on such
 * an engine `getOrCreate` raced into a uniqueness violation, a second answer
 * to one elicitation silently replaced the first, and -- worst -- a `finish`
 * could clear a claim belonging to a submission that had started after its
 * read and was executing at that moment.
 *
 * **Every guarded transition now carries its precondition in the statement**,
 * not in a preceding read: `INSERT … SELECT … WHERE NOT EXISTS` for the two
 * creations, `UPDATE … WHERE claim = <the exact text I read>` for the claim
 * transitions, `AND state = 'pending'` for the elicitation ones. Where the
 * outcome is something the caller acts on, the row is read back afterwards so
 * the answer describes what actually happened rather than what was intended.
 * All of it is ordinary SQL, so no dialect is guessed at and no isolation
 * level has to be demanded of the deployment.
 *
 * The remaining gap is named where it lives, on `takeAnswer`: two concurrent
 * takers cannot be told apart without `RETURNING` or an affected-row count.
 *
 * The suite runs against SQLite, which serialises writers at the file level
 * and therefore cannot produce the interleaving at all -- so passing tests
 * there were never evidence for the portable claim. `DurableSessionStore
 * (interleaved writes)` supplies the evidence instead: a `SqlClient` that
 * commits an injected statement between a transition's read and its write,
 * which is precisely what read-committed permits. Both tests fail against the
 * unconditional writes they replaced.
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
                /**
                 * The precondition is in the statement, not in a read before
                 * it (R66).
                 *
                 * `SELECT`-then-`INSERT` is only safe if nothing can commit in
                 * between, which read-committed -- the default nearly
                 * everywhere but SQLite -- explicitly permits. Two callers
                 * both saw the absence and both inserted, and the loser got a
                 * primary-key violation surfaced as a `StorageError`: a
                 * spurious failure for an operation whose entire contract is
                 * "make sure this exists".
                 *
                 * `INSERT … SELECT … WHERE NOT EXISTS` re-checks the absence
                 * as part of the write, so the engine settles it under
                 * whatever locking it already has. Preferred over catching the
                 * violation and re-reading, which cannot work here: on
                 * PostgreSQL a failed statement poisons the surrounding
                 * transaction, so there is no "carry on and re-read" to do.
                 * Preferred over `ON CONFLICT DO NOTHING` because that is a
                 * dialect this portable module would have to guess at.
                 */
                yield* sql`INSERT INTO ${sessions} (session_id, status, submission_count, claim, history) SELECT ${sessionId}, 'idle', 0, NULL, ${encoded} WHERE NOT EXISTS (SELECT 1 FROM ${sessions} WHERE session_id = ${sessionId})`
                // Ours or theirs -- the contract does not distinguish, and
                // reading back is what makes that true rather than assumed.
                const found = yield* readRecord(sessionId)
                if (Option.isSome(found)) return found.value
                return yield* new StorageError({
                  operation: "getOrCreate",
                  sessionId,
                  detail: "the row was absent immediately after a conditional insert"
                })
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
                  ...(submission.input === undefined ? {} : { input: submission.input }),
                  stream: submission.stream,
                  ...(submission.key === undefined ? {} : { key: submission.key }),
                  ...(submission.principal === undefined ? {} : { principal: submission.principal })
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
              const row = yield* readRow(sessionId)
              if (Option.isNone(row) || row.value.claim === null) return
              const held = yield* decodeClaim(row.value.claim)
              if (held.submissionId !== submissionId) return
              const claimJson = yield* encodeClaim({ ...held, executionId })
              /**
               * Conditional for the reason `finish` gives (R66): writing this
               * unconditionally would stamp an execution id onto whatever
               * claim happened to be there, which after a concurrent
               * finish-and-reclaim is a *different* submission's.
               *
               * No read-back, because there is nothing to report. Attaching an
               * execution id to a claim that has already moved on is not a
               * failure, it is a no-op -- the submission it described is over.
               */
              yield* sql`UPDATE ${sessions} SET claim = ${claimJson} WHERE session_id = ${sessionId} AND claim = ${row.value.claim}`
            })
          )
          .pipe(storage("attachExecution", sessionId)),

      finish: (sessionId, submissionId, history) =>
        Effect.flatMap(encodeHistory(history), (encoded) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                /**
                 * Read the row, not the record: the claim's stored text is the
                 * precondition (R66).
                 *
                 * Deciding from the read and then writing unconditionally is
                 * the one transition here where losing the race *corrupts*
                 * rather than merely failing. Two finishers both read claim
                 * S1; the first commits and leaves the session idle; a fresh
                 * `claim` admits S2 and the session is running again; the
                 * second finisher's unconditional `UPDATE` then sets `claim =
                 * NULL` and wipes a claim belonging to a submission that is
                 * executing right now. The session goes idle underneath a
                 * running turn, and the next claimer is admitted alongside it.
                 *
                 * Comparing the claim's exact stored text turns that into a
                 * statement that matches nothing. It is the row's own version
                 * stamp: any transition through `claim` or `finish` rewrites
                 * the column, so "unchanged text" is precisely "no transition
                 * since I looked".
                 */
                const row = yield* readRow(sessionId)
                if (Option.isNone(row) || row.value.claim === null) return false
                const held = yield* decodeClaim(row.value.claim)
                if (held.submissionId !== submissionId) return false
                yield* sql`UPDATE ${sessions} SET status = 'idle', claim = NULL, history = ${encoded} WHERE session_id = ${sessionId} AND claim = ${row.value.claim}`
                /**
                 * Read back to learn whether *this* finish landed.
                 *
                 * A superseded claim reads as non-null and the answer is a
                 * truthful `false`. The one case this cannot separate is a
                 * concurrent finisher of the *same* submission: both see a
                 * null claim afterwards. That is why the history is compared
                 * too -- a duplicate finish of one submission writes the same
                 * history and is benign, while a different history means the
                 * write that survived was not ours.
                 */
                const after = yield* readRow(sessionId)
                const landed = Option.isSome(after) &&
                  after.value.claim === null &&
                  after.value.history === encoded
                if (!landed) return false
                yield* sql`DELETE FROM ${requests} WHERE session_id = ${sessionId}`
                return true
              })
            )
            .pipe(storage("finish", sessionId))
        ),

      addPendingRequest: (sessionId, request) =>
        Effect.flatMap(encodeRequest(request), (encoded) =>
          sql
            /**
             * Idempotent: a replayed run asks under the same id, and an
             * already-answered one keeps its answer.
             *
             * The absence is re-checked as part of the insert rather than in a
             * read before it, for the reason `getOrCreate` gives (R66) -- and
             * here the row carries `UNIQUE (session_id, request_id)`, so the
             * losing writer of a select-then-insert got a constraint violation
             * rather than the silent no-op this operation promises.
             *
             * One statement, so the transaction that used to wrap a read and a
             * write has nothing left to group.
             */
            .withTransaction(
              Effect.asVoid(
                sql`INSERT INTO ${requests} (session_id, request_id, state, payload) SELECT ${sessionId}, ${request.id}, 'pending', ${encoded} WHERE NOT EXISTS (SELECT 1 FROM ${requests} WHERE session_id = ${sessionId} AND request_id = ${request.id})`
              )
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
                const id = waiting[0]!.id
                /**
                 * `AND state = 'pending'` is the precondition restated in the
                 * write (R66). Without it, two answers to one request both
                 * matched and the second overwrote the first -- an answer
                 * accepted, reported as accepted, and then silently replaced.
                 */
                yield* sql`UPDATE ${requests} SET state = 'answered', payload = ${encoded} WHERE id = ${id} AND state = 'pending'`
                // Whose answer survived: reported honestly rather than assumed.
                const after = yield* sql<{
                  readonly payload: string
                }>`SELECT payload FROM ${requests} WHERE id = ${id} AND state = 'answered'`
                return after.length > 0 && after[0]!.payload === encoded
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
              /**
               * `AND state = 'answered'` for the reason the others give (R66):
               * without it this deletes whatever occupies the row, including a
               * request re-asked and still pending under the same id.
               *
               * **What this does not settle**: two concurrent takers both see
               * the row gone afterwards, so both return the answer. Telling
               * them apart needs the deleted row back from the statement --
               * `DELETE … RETURNING`, or a driver-reported affected-row count
               * -- and neither is available portably here. Recorded rather
               * than papered over; the operation is called once per submission
               * on the elicitation path, so the second taker needs a duplicate
               * runner for that same submission to exist at all.
               */
              yield* sql`DELETE FROM ${requests} WHERE id = ${answered[0]!.id} AND state = 'answered'`
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
