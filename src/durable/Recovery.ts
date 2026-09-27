import { Effect, Option } from "effect"
import type * as Elicitation from "../Elicitation.js"
import type { StorageError } from "../Errors.js"
import * as DurableChannels from "./DurableChannels.js"
import type * as DurableSessionStore from "./DurableSessionStore.js"
import * as DurableToolkit from "./DurableToolkit.js"

/**
 * What a durable session's recovery owes, as one pure decision (item 135).
 *
 * `DurableAgentClient` reconciles a session each time a client acquires it:
 * a process lost at the wrong moment can leave a claim never dispatched, a
 * claim whose run has ended, or an answer accepted and never delivered.
 * Deciding which of those it is was written inline in the reconciliation. It
 * is here now, as `classify` over the evidence the stores hold, so that:
 * - the rule is tested as a table, with no engine;
 * - an operator can ask the same question the reconciliation asks, with
 *   `inspect`, and read the answer in words;
 * - the stores' own consistency can be checked while doing so (`findings`).
 *
 * The workflow engine's own resume, replaying a journal, is not in this
 * decision. It is the engine's, and a journal is not a store this library
 * reads.
 */

/** What the stores hold about one session, read once. */
export interface Evidence {
  readonly record: Option.Option<DurableSessionStore.SessionRecord>
  /**
   * Whether the claim's run has closed its admission marker: it ended,
   * however it ended. Only meaningful while a dispatched claim is held.
   */
  readonly ended: boolean
  /** Answers accepted and not yet delivered to the run. */
  readonly answers: ReadonlyArray<Elicitation.Response>
  /** Questions the run is waiting on. */
  readonly pending: ReadonlyArray<Elicitation.Request>
}

export type Decision =
  | { readonly _tag: "Missing" }
  /** No submission holds the session. Nothing is owed. */
  | { readonly _tag: "Idle" }
  /** Claimed, and the workflow was never dispatched: dispatch it. */
  | { readonly _tag: "Dispatch"; readonly submissionId: string }
  /** The run has ended and the claim is still held: finish the claim. */
  | { readonly _tag: "FinishEnded"; readonly submissionId: string; readonly executionId: string }
  /** The run is live, with answers it has not been given: deliver them. */
  | {
    readonly _tag: "DeliverAnswers"
    readonly submissionId: string
    readonly executionId: string
    readonly answers: ReadonlyArray<string>
  }
  /** The run is live and owed nothing. It may be waiting on a question. */
  | { readonly _tag: "Running"; readonly submissionId: string; readonly executionId: string }

export const classify = (evidence: Evidence): Decision => {
  if (Option.isNone(evidence.record)) return { _tag: "Missing" }
  const claim = evidence.record.value.claim
  if (Option.isNone(claim)) return { _tag: "Idle" }
  const { executionId, submissionId } = claim.value
  if (executionId === undefined) return { _tag: "Dispatch", submissionId }
  if (evidence.ended) return { _tag: "FinishEnded", submissionId, executionId }
  if (evidence.answers.length > 0) {
    return { _tag: "DeliverAnswers", submissionId, executionId, answers: evidence.answers.map((answer) => answer.id) }
  }
  return { _tag: "Running", submissionId, executionId }
}

/**
 * Where the stores disagree with themselves. Each is a state no transition
 * this library writes should leave, so each is worth an operator's look.
 * None changes what `classify` decides.
 */
export const findings = (evidence: Evidence): ReadonlyArray<string> => {
  if (Option.isNone(evidence.record)) {
    return evidence.answers.length > 0 || evidence.pending.length > 0
      ? ["questions or answers are recorded for a session that does not exist"]
      : []
  }
  const record = evidence.record.value
  const out: Array<string> = []
  if (record.status === "running" && Option.isNone(record.claim)) {
    out.push("the session is marked running, but no submission holds it")
  }
  if (record.status === "idle" && Option.isSome(record.claim)) {
    out.push("the session is marked idle, but a submission holds it")
  }
  if (Option.isNone(record.claim) && evidence.pending.length > 0) {
    out.push(`${evidence.pending.length} question(s) are pending on a session no submission holds`)
  }
  if (Option.isNone(record.claim) && evidence.answers.length > 0) {
    out.push(`${evidence.answers.length} answer(s) are recorded for a session no submission holds; nothing will deliver them`)
  }
  return out
}

/** The questions an operator can answer that stand between a run and its end: its unknown tool outcomes. */
export const parked = (evidence: Evidence): ReadonlyArray<Elicitation.Request> =>
  evidence.pending.filter((request) => request.kind === DurableToolkit.unknownOutcomeKind)

/** The decision in a sentence, for a log line or an admin command. */
export const explain = (decision: Decision, evidence: Evidence): string => {
  switch (decision._tag) {
    case "Missing":
      return "No such session."
    case "Idle":
      return "Idle: no submission holds the session, and nothing is owed."
    case "Dispatch":
      return `Submission ${decision.submissionId} was accepted and never started: recovery starts it.`
    case "FinishEnded":
      return `Submission ${decision.submissionId} has ended, but still holds the session: recovery releases it. ` +
        "The history its last turn would have committed was never durable, and stays where the submission began."
    case "DeliverAnswers":
      return `Submission ${decision.submissionId} is running, and ${decision.answers.length} accepted answer(s) ` +
        `were never delivered to it (${decision.answers.join(", ")}): recovery delivers them.`
    case "Running": {
      const waiting = parked(evidence)
      const questions = evidence.pending.length - waiting.length
      const parts = [
        waiting.length === 0
          ? ""
          : ` It is waiting on ${waiting.length} tool call(s) whose outcome is unknown, for an operator to say what happened (${
            waiting.map((request) => request.id).join(", ")
          }).`,
        questions === 0 ? "" : ` It is waiting on ${questions} other question(s).`
      ]
      return `Submission ${decision.submissionId} is running, and nothing is owed.${parts.join("")}`
    }
  }
}

/** The stores `gather` and `inspect` read. */
export interface Stores {
  readonly store: DurableChannels.Store
  readonly sessionStore: DurableSessionStore.DurableSessionStore
}

/** Read the evidence for one session. Reads only: nothing is changed. */
export const gather = (stores: Stores, sessionId: string): Effect.Effect<Evidence, StorageError> =>
  Effect.flatMap(stores.sessionStore.get(sessionId), (record) => evidenceFor(stores, sessionId, record))

/** The rest of the evidence, around a record the caller has already read. */
export const evidenceFor = (
  stores: Stores,
  sessionId: string,
  record: Option.Option<DurableSessionStore.SessionRecord>
): Effect.Effect<Evidence, StorageError> =>
  Effect.all({
    record: Effect.succeed(record),
    ended: Effect.map(stores.store.size(DurableChannels.openKey(sessionId)), (open) => open === 0),
    answers: stores.sessionStore.recordedAnswers(sessionId),
    pending: stores.sessionStore.pendingRequests(sessionId)
  })

/** What an operator reads: the evidence, the decision, why, and anything inconsistent. */
export interface Inspection {
  readonly evidence: Evidence
  readonly decision: Decision
  readonly explanation: string
  readonly parked: ReadonlyArray<Elicitation.Request>
  readonly findings: ReadonlyArray<string>
}

/**
 * The question a reconciliation asks, asked by an operator. Reads only:
 * acquiring the session through a client is what acts on the answer.
 */
export const inspect = (stores: Stores, sessionId: string): Effect.Effect<Inspection, StorageError> =>
  Effect.map(gather(stores, sessionId), (evidence) => {
    const decision = classify(evidence)
    return {
      evidence,
      decision,
      explanation: explain(decision, evidence),
      parked: parked(evidence),
      findings: findings(evidence)
    }
  })
