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
 * That is not a bounded-memory compromise, it is sufficient: it is where loss
 * began, so it bounds what was missed, and every later gap is after it.
 * Keeping every range would let an unlucky stream grow the state without
 * bound and buy nothing.
 *
 * ## Repair is a re-fold, not a resume
 *
 * **Repairing a gapped projection means folding the log again from the start,
 * into a fresh state.** Not continuing the gapped one, and not starting a new
 * one at `gap.after`.
 *
 * This follows from applying gapped events rather than freezing. Once
 * post-gap events are in the accumulators there is no way to take them back
 * out, so the gapped state cannot be corrected in place; and a fresh state
 * begun at `gap.after` has never seen the events *before* the gap, so it is
 * missing the other end of the conversation. Measured on the first
 * implementation of this module, whose test compared a cursor-resumed
 * projection against a whole one on a selected subset of fields and passed:
 * `started` was `false` where the whole fold had `true`, because
 * `SessionStarted` was on the other side of the cursor.
 *
 * So `gap.after` is diagnostic -- it says where loss began, which is what a
 * log line or a metric wants -- and {@link since} is for *attaching* with a
 * cursor you already trust, not for repair. A `DeliveryLog` read is bounded
 * per session, so re-folding it is cheap enough that the sharper-looking
 * incremental repair is not worth being wrong about.
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
  /**
   * Envelopes ignored because their `sequence` was not a safe integer.
   *
   * `AgentEventEnvelope.sequence` is `Schema.Number`, which admits `NaN`,
   * `Infinity` and fractions -- so a decode that is not JSON, or a `since`
   * built from `Number(searchParams.get("after"))` on an absent parameter,
   * produces one without anything upstream complaining.
   *
   * Such an envelope cannot be *ordered*, so it is not applied: folding it
   * would put a non-comparable value in the cursor, and every subsequent
   * comparison against `NaN` is false -- which silently disables both the
   * duplicate guard and gap detection. Measured before this guard existed: a
   * `NaN` between sequence 1 and sequence 500 reported `isComplete: true` and
   * `gaps: 0` while 498 events were missing. A projection that says it is
   * exact when it is not is the one failure this module cannot have.
   */
  readonly malformed: number
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
  lastSequence: Option.Option<number>,
  malformed = 0
): Projection => ({
  sessionId,
  lastSequence,
  applied: 0,
  duplicates: 0,
  foreign: 0,
  unknown: 0,
  malformed,
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
 * A projection that expects the next event to be `sequence + 1`.
 *
 * For attaching where you already know the cursor and want continuity
 * checked from there -- a subscriber resuming an SSE tail from
 * `Last-Event-ID`, or a fold over `DeliveryLog.read({ after: n })` that should
 * complain if the log skips.
 *
 * Sequences are 1-based, so `since(id, 0)` means "from the very beginning"
 * and makes a first envelope at sequence 3 a genuine gap -- which `empty`,
 * by design, would not. That is also the constructor to re-fold a whole log
 * through when repairing (see the module docs: repair is a re-fold, and this
 * is *not* a way to resume a gapped projection at its cursor).
 */
export const since = (sessionId: SessionId, sequence: number): Projection =>
  Number.isSafeInteger(sequence)
    ? base(sessionId, Option.some(sequence))
    // "I have seen up to NaN" is not a claim, so it degrades to `empty`'s
    // no-expectation cursor rather than poisoning every later comparison.
    // Counted as malformed rather than done silently: the caller asked for a
    // guarantee this cannot give, and `isComplete` should say so instead of
    // reporting exactness it did not check. `Number(param)` on an absent
    // query parameter is the ordinary way to get here.
    : base(sessionId, Option.none(), 1)

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
  // Before the ordering comparisons, never after: an unorderable sequence
  // makes both of them false, which silently disables the duplicate guard and
  // gap detection together. See `Projection.malformed`.
  if (!Number.isSafeInteger(sequence)) {
    return { ...self, malformed: self.malformed + 1 }
  }

  let gaps = self.gaps
  let gap = self.gap

  if (Option.isSome(self.lastSequence)) {
    const last = self.lastSequence.value
    if (sequence <= last) return { ...self, duplicates: self.duplicates + 1 }
    if (sequence > last + 1) {
      gaps = gaps + 1
      // Earliest only: repairing from here subsumes every later gap.
      gap = Option.isSome(gap)
        ? gap
        : Option.some({ after: last, resumedAt: sequence })
    }
  }

  return apply(
    {
      ...self,
      lastSequence: Option.some(sequence),
      applied: self.applied + 1,
      gaps,
      gap
    },
    envelope
  )
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
        // Only when it actually stopped something. A failure handed back to
        // the model is one the run *recovered* from -- the turn continued and
        // the submission may well have completed -- so recording it as
        // `lastFailure` would answer "why did this stop" with an error that
        // stopped nothing.
        lastFailure: event.returnedToModel
          ? self.lastFailure
          : Option.some(event.failure)
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

    // Observational, with nothing to accumulate: generation progress, queue
    // notices, and the openings whose terminal events are counted above.
    // `applied` has already counted them.
    //
    // Listed rather than left to a `default`, so that adding an event to the
    // ADT is a compile error here instead of a silent no-op. `AgentEvent`'s
    // own `match` makes that argument for consumers; a projection is the
    // consumer it was written about, and this module would otherwise be
    // exactly the hand-written switch that stops covering the union as it
    // grows.
    case "TurnStarted":
    case "MessageStarted":
    case "MessageDelta":
    case "MessagePartCompleted":
    case "MessageStreamCompleted":
    case "MessageInterrupted":
    case "ToolCallProgress":
    case "SteeringQueued":
    case "SteeringApplied":
    case "FollowUpQueued":
    case "FollowUpApplied":
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
 * Whether every event between the start cursor and now was seen.
 *
 * False means the counters are lower bounds. `gap.after` is then the cursor to
 * repair from: `DeliveryLog.read(sessionId, { after })`, folded into
 * `since(sessionId, after)`.
 *
 * A malformed sequence counts against completeness too. Its envelope was not
 * applied -- it could not be ordered -- so the fold is genuinely missing an
 * event, and reporting exactness would be the same lie a missed gap tells.
 */
export const isComplete = (self: Projection): boolean =>
  Option.isNone(self.gap) && self.malformed === 0

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
