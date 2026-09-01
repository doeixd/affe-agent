import { Option } from "effect"
import type {
  AgentEventEnvelope,
  Failure,
  ModelUsage,
  SessionId,
  SubmissionId
} from "../AgentEvent.js"

/**
 * A session's event stream, folded into an answer.
 *
 * `docs/effect-plan-2.txt` §27. The stream says what *happened*; a directory,
 * a dashboard or an operator asking "what is this session doing and what has
 * it cost" wants what is *true now*, and deriving that by re-reading the log
 * at every query is the thing this exists to avoid.
 *
 * Three properties are the whole design:
 *
 * - **Pure.** `reduce` is `(state, envelope) => state` with no effect, no
 *   clock and no store. It runs over a live `Stream`, over
 *   `DeliveryLog.read({ after })`, or over an array in a test, and cannot tell
 *   the difference. That is what makes repair (below) a re-fold rather than a
 *   separate code path.
 * - **Sequence-aware.** `sequence` is per-session and monotonic, so a
 *   duplicate is ignorable and a gap is *detectable* -- and this records both
 *   rather than trusting delivery order.
 * - **Not a durable log.** `DeliveryLog` is that, and it already gives
 *   session-wide cursor replay. This folds it; it does not duplicate it. The
 *   plan is explicit on that point and so is `plan-durability-hardening.md`
 *   H4b.
 *
 * ## On gaps
 *
 * The live event stream is observational and may drop; the durable log does
 * not. So a gap means "this projection has been reading the lossy one, and is
 * now a lower bound rather than a count".
 *
 * A gapped event is **applied anyway**, and the gap recorded. Freezing the
 * projection at the discontinuity was the alternative, and it is worse where
 * this is actually used: one dropped frame on an SSE tail would blank a live
 * view permanently, which is a bigger lie than a counter that is low. A
 * caller that needs exactness checks {@link gap} and repairs; a caller
 * rendering a dashboard carries on.
 *
 * Only the *earliest* gap is retained, with a count of how many there were.
 * That is not a bounded-memory compromise, it is sufficient: repair reads
 * `DeliveryLog.read(sessionId, { after: gap.after })`, and everything after
 * the earliest discontinuity -- including every later one -- is in that read.
 * Keeping every range would let an unlucky stream grow the state without
 * bound and buy nothing.
 *
 * ## What this is not
 *
 * Not a `SessionDirectory` (§26): that is a management store with pagination,
 * rename and namespaces, and it is not built. This is the reducer such a
 * directory would keep per session to answer `stats`. Not `Hooks.on` either,
 * which dispatches on a live stream and holds nothing.
 *
 * Deliberately a plain interface rather than a `Schema`: a projection is
 * derived, and re-folding the log is cheaper and more honest than persisting
 * a snapshot that can disagree with it. If a directory later needs to store
 * one, that is the directory's wire decision to make, not this module's.
 */

/** Where continuity was lost, and where it resumed. */
export interface Gap {
  /** The last sequence seen before the discontinuity. Repair reads after it. */
  readonly after: number
  /** The first sequence seen after it. */
  readonly resumedAt: number
}

/** Started / finished counts for a nested unit of work. */
export interface Lifecycle {
  readonly started: number
  readonly completed: number
  readonly failed: number
  readonly interrupted: number
}

/**
 * Tool call outcomes.
 *
 * Named `succeeded` rather than `completed` because that is the event's own
 * word, and because a *failed* tool call may still have completed the turn --
 * `ToolCallFailed.returnedToModel` decides, and the two are not the same
 * question.
 */
export interface ToolCalls {
  readonly started: number
  readonly succeeded: number
  readonly failed: number
  readonly interrupted: number
  /** Of {@link ToolCalls.failed}, those handed back to the model rather than failing the run. */
  readonly returnedToModel: number
}

/** A tool call started and not yet settled. */
export interface ActiveToolCall {
  readonly id: string
  readonly name: string
}

/** A question asked of a human and not yet answered. */
export interface PendingElicitation {
  readonly id: string
  readonly kind: string
}

export interface Projection {
  readonly sessionId: SessionId

  /**
   * The highest sequence applied, or `None` before the first event.
   *
   * Also the repair cursor for an *ungapped* projection: read after it to
   * catch up.
   */
  readonly lastSequence: Option.Option<number>
  /** Envelopes folded in. Excludes duplicates and foreign sessions. */
  readonly applied: number
  /** Envelopes ignored because their sequence was already applied. */
  readonly duplicates: number
  /**
   * Envelopes ignored because they belong to another session.
   *
   * Zero for a caller feeding one session's stream, which is what
   * `AgentSession.events` and `DeliveryLog.read` both are. It is not zero when
   * a host-wide stream (§29) is routed to the wrong projection, which is the
   * mistake worth surfacing rather than silently folding in.
   */
  readonly foreign: number
  /**
   * Events whose tag this build does not know, carried as `UnknownEvent`.
   *
   * Skipped, but they still *occupy a sequence number* and so still advance
   * the cursor -- treating one as a gap would report a discontinuity every
   * time a newer peer emits an event this build predates, which is the normal
   * case across a relay, not an error.
   */
  readonly unknown: number
  /** The earliest discontinuity, if any. */
  readonly gap: Option.Option<Gap>
  /** How many discontinuities were seen. */
  readonly gaps: number

  readonly started: boolean
  readonly closed: boolean
  /** The submission currently running, if one is. */
  readonly activeSubmission: Option.Option<SubmissionId>

  readonly submissions: Lifecycle
  readonly runs: Lifecycle
  readonly turns: number

  readonly modelCalls: number
  /** Accumulated over every `ModelCallCompleted`. */
  readonly usage: ModelUsage
  /** Assistant messages committed. */
  readonly messages: number

  readonly tools: ToolCalls
  readonly activeToolCalls: ReadonlyArray<ActiveToolCall>
  readonly pendingElicitations: ReadonlyArray<PendingElicitation>

  /** The most recent failure from any level, for "why did this stop". */
  readonly lastFailure: Option.Option<Failure>
}

const noLifecycle: Lifecycle = {
  started: 0,
  completed: 0,
  failed: 0,
  interrupted: 0
}

const noTools: ToolCalls = {
  started: 0,
  succeeded: 0,
  failed: 0,
  interrupted: 0,
  returnedToModel: 0
}

const noUsage: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0
}

const base = (
  sessionId: SessionId,
  lastSequence: Option.Option<number>
): Projection => ({
  sessionId,
  lastSequence,
  applied: 0,
  duplicates: 0,
  foreign: 0,
  unknown: 0,
  gap: Option.none(),
  gaps: 0,
  started: false,
  closed: false,
  activeSubmission: Option.none(),
  submissions: noLifecycle,
  runs: noLifecycle,
  turns: 0,
  modelCalls: 0,
  usage: noUsage,
  messages: 0,
  tools: noTools,
  activeToolCalls: [],
  pendingElicitations: [],
  lastFailure: Option.none()
})

/**
 * A projection with no expectation about where the stream starts.
 *
 * The first envelope sets the cursor, whatever its sequence, so attaching to
 * a live tail mid-conversation is not a gap -- you joined late on purpose.
 * Use {@link since} when you *do* have an expectation.
 */
export const empty = (sessionId: SessionId): Projection =>
  base(sessionId, Option.none())

/**
 * A projection continuing from a known cursor.
 *
 * This is the repair constructor, and the reason `reduce` is pure: after
 * `DeliveryLog.read(sessionId, { after: n })` you fold the result into
 * `since(sessionId, n)` and get a projection with no gap, using the same code
 * path that produced the gapped one.
 *
 * Sequences are 1-based, so `since(id, 0)` means "from the very beginning"
 * and makes a first envelope at sequence 3 a genuine gap -- which `empty`,
 * by design, would not.
 */
export const since = (sessionId: SessionId, sequence: number): Projection =>
  base(sessionId, Option.some(sequence))

const addLifecycle = (
  self: Lifecycle,
  key: keyof Lifecycle
): Lifecycle => ({ ...self, [key]: self[key] + 1 })

const addTools = (self: ToolCalls, key: keyof ToolCalls): ToolCalls => ({
  ...self,
  [key]: self[key] + 1
})

/**
 * Fold one envelope in.
 *
 * Total: every input returns a projection. Duplicates, foreign sessions and
 * unknown tags are counted rather than thrown, because the whole point of a
 * read model over an observational stream is that it keeps working when the
 * stream misbehaves -- and a counter that says so is more useful downstream
 * than an exception that unwinds a subscriber.
 */
export const reduce = (
  self: Projection,
  envelope: AgentEventEnvelope
): Projection => {
  if (envelope.sessionId !== self.sessionId) {
    return { ...self, foreign: self.foreign + 1 }
  }

  const sequence = envelope.sequence
  let state = self

  if (Option.isSome(self.lastSequence)) {
    const last = self.lastSequence.value
    if (sequence <= last) return { ...self, duplicates: self.duplicates + 1 }
    if (sequence > last + 1) {
      state = {
        ...state,
        gaps: state.gaps + 1,
        // Earliest only: repairing from here subsumes every later gap.
        gap: Option.isSome(state.gap)
          ? state.gap
          : Option.some({ after: last, resumedAt: sequence })
      }
    }
  }

  state = {
    ...state,
    lastSequence: Option.some(sequence),
    applied: state.applied + 1
  }

  return apply(state, envelope)
}

/**
 * Everything a settled submission could still have been holding open.
 *
 * A tool call or an elicitation belongs to a run inside a submission, so once
 * the submission is over neither can still be live. Clearing them here is
 * what stops an interrupted run -- whose `ElicitationRequested` never gets its
 * `ElicitationResolved`, and which therefore breaks the "every request owes a
 * resolution" rule the event doc states for the *happy* path -- from leaking a
 * pending entry for the lifetime of the projection.
 */
const settle = (self: Projection): Projection => ({
  ...self,
  activeSubmission: Option.none(),
  activeToolCalls: [],
  pendingElicitations: []
})

const apply = (
  self: Projection,
  envelope: AgentEventEnvelope
): Projection => {
  const event = envelope.event
  switch (event._tag) {
    case "SessionStarted":
      return { ...self, started: true }
    case "SessionClosed":
      return { ...settle(self), closed: true }

    case "SubmissionStarted":
      return {
        ...self,
        submissions: addLifecycle(self.submissions, "started"),
        activeSubmission: envelope.submissionId
      }
    case "SubmissionCompleted":
      return {
        ...settle(self),
        submissions: addLifecycle(self.submissions, "completed")
      }
    case "SubmissionFailed":
      return {
        ...settle(self),
        submissions: addLifecycle(self.submissions, "failed"),
        lastFailure: Option.some(event.failure)
      }
    case "SubmissionInterrupted":
      return {
        ...settle(self),
        submissions: addLifecycle(self.submissions, "interrupted")
      }

    case "RunStarted":
      return { ...self, runs: addLifecycle(self.runs, "started") }
    case "RunCompleted":
      return { ...self, runs: addLifecycle(self.runs, "completed") }
    case "RunFailed":
      return {
        ...self,
        runs: addLifecycle(self.runs, "failed"),
        lastFailure: Option.some(event.failure)
      }
    case "RunInterrupted":
      return { ...self, runs: addLifecycle(self.runs, "interrupted") }

    case "TurnCompleted":
      return { ...self, turns: self.turns + 1 }

    case "ModelCallCompleted":
      return {
        ...self,
        modelCalls: self.modelCalls + 1,
        usage: {
          inputTokens: self.usage.inputTokens + event.usage.inputTokens,
          outputTokens: self.usage.outputTokens + event.usage.outputTokens,
          totalTokens: self.usage.totalTokens + event.usage.totalTokens
        }
      }

    case "MessageCompleted":
      return { ...self, messages: self.messages + 1 }
    case "MessageFailed":
      return { ...self, lastFailure: Option.some(event.failure) }

    case "ElicitationRequested":
      return {
        ...self,
        pendingElicitations: self.pendingElicitations.some(
          (pending) => pending.id === event.id
        )
          ? self.pendingElicitations
          : [...self.pendingElicitations, { id: event.id, kind: event.kind }]
      }
    case "ElicitationResolved":
      return {
        ...self,
        pendingElicitations: self.pendingElicitations.filter(
          (pending) => pending.id !== event.id
        )
      }

    case "ToolCallStarted":
      return {
        ...self,
        tools: addTools(self.tools, "started"),
        activeToolCalls: self.activeToolCalls.some(
          (call) => call.id === event.id
        )
          ? self.activeToolCalls
          : [...self.activeToolCalls, { id: event.id, name: event.name }]
      }
    case "ToolCallSucceeded":
      return {
        ...self,
        tools: addTools(self.tools, "succeeded"),
        activeToolCalls: self.activeToolCalls.filter(
          (call) => call.id !== event.id
        )
      }
    case "ToolCallFailed": {
      const tools = addTools(self.tools, "failed")
      return {
        ...self,
        tools: event.returnedToModel
          ? addTools(tools, "returnedToModel")
          : tools,
        activeToolCalls: self.activeToolCalls.filter(
          (call) => call.id !== event.id
        ),
        lastFailure: Option.some(event.failure)
      }
    }
    case "ToolCallInterrupted":
      return {
        ...self,
        tools: addTools(self.tools, "interrupted"),
        activeToolCalls: self.activeToolCalls.filter(
          (call) => call.id !== event.id
        )
      }

    case "UnknownEvent":
      // Counted, cursor already advanced. See `Projection.unknown`.
      return { ...self, unknown: self.unknown + 1 }

    default:
      // Observational events with nothing to accumulate: deltas, part
      // announcements, queue notices. `applied` already counted them.
      return self
  }
}

/** Fold many envelopes in, in the order given. */
export const reduceAll = (
  self: Projection,
  envelopes: Iterable<AgentEventEnvelope>
): Projection => {
  let state = self
  for (const envelope of envelopes) state = reduce(state, envelope)
  return state
}

/**
 * The earliest discontinuity, if the projection has one.
 *
 * `Some` means the counters are lower bounds. The value's `after` is the
 * cursor to repair from: `DeliveryLog.read(sessionId, { after })`, folded into
 * `since(sessionId, after)`.
 */
export const gap = (self: Projection): Option.Option<Gap> => self.gap

/** Whether every event between the start cursor and now was seen. */
export const isComplete = (self: Projection): boolean => Option.isNone(self.gap)

/**
 * Whether the session is running work right now.
 *
 * A closed session is never active, even if the stream ended without a
 * terminal submission event -- which is what an abruptly dropped connection
 * looks like.
 */
export const isActive = (self: Projection): boolean =>
  !self.closed && Option.isSome(self.activeSubmission)

/** Whether the session is waiting on a human. */
export const isBlocked = (self: Projection): boolean =>
  !self.closed && self.pendingElicitations.length > 0
