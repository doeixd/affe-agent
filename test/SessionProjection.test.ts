import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import * as AgentEvent from "../src/AgentEvent.js"
import { SessionProjection } from "../src/sessions/index.js"

/**
 * The session read model (`docs/effect-plan-2.txt` §27).
 *
 * `reduce` is pure and total, so it can be driven with sequences a real run
 * would only produce under loss, reordering or a newer peer -- which is
 * exactly where a read model earns its keep, and exactly what cannot be
 * arranged reliably against a live stream. Each case states an invariant and
 * checks the reducer keeps it.
 *
 * The load-bearing ones are the sequence cases: a projection that silently
 * miscounts under a dropped frame is worse than no projection, because it
 * looks like an answer.
 */

const sessionId = AgentEvent.SessionId.make("s")
const other = AgentEvent.SessionId.make("other")
const submissionId = AgentEvent.SubmissionId.make("sub")

const envelope = (
  sequence: number,
  event: AgentEvent.AgentEvent | AgentEvent.UnknownEvent,
  session: AgentEvent.SessionId = sessionId
): AgentEvent.AgentEventEnvelope => ({
  sessionId: session,
  submissionId: Option.some(submissionId),
  runId: Option.none(),
  turn: Option.none(),
  sequence,
  event
})

/**
 * `totalTokens` is passed, not derived.
 *
 * Deriving it as `inputTokens + outputTokens` made the fixture satisfy an
 * invariant the real thing does not have -- providers report cached and
 * reasoning tokens that put `total` above the two -- so an accumulator that
 * recomputed the total from the other two fields agreed with every assertion.
 * The whole reason this field is carried separately is that it is not a sum of
 * the other two, and a fixture that makes it one cannot pin that.
 */
const usage = (
  inputTokens: number,
  outputTokens: number,
  totalTokens: number
) => ({ inputTokens, outputTokens, totalTokens })

const failure = (message: string): AgentEvent.Failure => ({
  tag: "X",
  message,
  isDefect: false
})

const turnCompleted = { _tag: "TurnCompleted" } as const

/** One complete submission: the shape a real run produces. */
const conversation: ReadonlyArray<AgentEvent.AgentEvent> = [
  { _tag: "SessionStarted" },
  { _tag: "SubmissionStarted" },
  { _tag: "RunStarted" },
  { _tag: "ModelCallCompleted", usage: usage(10, 5, 18), finishReason: "tool-calls" },
  { _tag: "ToolCallStarted", id: "c1", name: "read", params: {} },
  {
    _tag: "ToolCallSucceeded",
    id: "c1",
    name: "read",
    result: "ok",
    encodedResult: "ok"
  },
  turnCompleted,
  { _tag: "ModelCallCompleted", usage: usage(20, 7, 30), finishReason: "stop" },
  { _tag: "MessageCompleted", text: "done" },
  turnCompleted,
  { _tag: "RunCompleted", turns: 2 },
  { _tag: "SubmissionCompleted", runs: 1 }
]

/** Envelopes numbered from 1, as `EventBus` numbers them. */
const numbered = (
  events: ReadonlyArray<AgentEvent.AgentEvent | AgentEvent.UnknownEvent>
): ReadonlyArray<AgentEvent.AgentEventEnvelope> =>
  events.map((event, index) => envelope(index + 1, event))

describe("SessionProjection", () => {
  describe("folding a conversation", () => {
    it("accumulates counts and usage across a whole submission", () => {
      const state = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        numbered(conversation)
      )

      assert.strictEqual(state.applied, conversation.length)
      assert.isTrue(state.started)
      assert.isFalse(state.closed)

      assert.deepStrictEqual(state.submissions, {
        started: 1,
        completed: 1,
        failed: 0,
        interrupted: 0
      })
      assert.deepStrictEqual(state.runs, {
        started: 1,
        completed: 1,
        failed: 0,
        interrupted: 0
      })
      assert.strictEqual(state.turns, 2)

      assert.strictEqual(state.modelCalls, 2)
      // The reason usage is worth folding at all: it is additive across calls,
      // so a per-event consumer cannot answer "what did this session cost".
      assert.deepStrictEqual(state.usage, usage(30, 12, 48))
      assert.strictEqual(state.messages, 1)

      assert.strictEqual(state.tools.started, 1)
      assert.strictEqual(state.tools.succeeded, 1)
      assert.deepStrictEqual(state.activeToolCalls, [])

      assert.isTrue(SessionProjection.isComplete(state))
      assert.deepStrictEqual(state.lastSequence, Option.some(conversation.length))
      assert.deepStrictEqual(state.lastFailure, Option.none())
    })

    it("reports a submission as active only while it is running", () => {
      const upToRun = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        numbered(conversation).slice(0, 3)
      )
      assert.isTrue(SessionProjection.isActive(upToRun))
      assert.deepStrictEqual(upToRun.activeSubmission, Option.some(submissionId))

      const settled = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        numbered(conversation)
      )
      assert.isFalse(SessionProjection.isActive(settled))
      assert.deepStrictEqual(settled.activeSubmission, Option.none())
    })

    it("a closed session is never active, and holds nothing open", () => {
      // The abrupt-drop shape: work in flight and the stream ends with a close
      // rather than terminal events for any of it.
      //
      // Both halves are asserted because each alone is passed by breaking the
      // other: drop `settle` from the close and `isActive` is still false via
      // its `closed` guard; drop the `closed` guard and `activeSubmission` is
      // already `None` because `settle` ran. The open lists are what
      // discriminate.
      const state = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        numbered([
          { _tag: "SubmissionStarted" },
          { _tag: "ToolCallStarted", id: "a", name: "read", params: {} },
          {
            _tag: "ElicitationRequested",
            id: "e1",
            kind: "tool-approval",
            detail: {}
          },
          { _tag: "SessionClosed" }
        ])
      )

      assert.isTrue(state.closed)
      assert.isFalse(SessionProjection.isActive(state))
      assert.deepStrictEqual(state.activeToolCalls, [])
      assert.deepStrictEqual(state.pendingElicitations, [])
      assert.isFalse(SessionProjection.isBlocked(state))
    })

    it("counts the interrupted outcomes, which are their own events", () => {
      const state = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        numbered([
          { _tag: "RunStarted" },
          { _tag: "ToolCallStarted", id: "a", name: "read", params: {} },
          { _tag: "ToolCallInterrupted", id: "a", name: "read" },
          { _tag: "RunInterrupted" }
        ])
      )

      assert.strictEqual(state.runs.interrupted, 1)
      assert.strictEqual(state.tools.interrupted, 1)
      // Interruption settles the call as much as success does: a consumer must
      // not be left rendering it as still running.
      assert.deepStrictEqual(state.activeToolCalls, [])
      // And it is not a failure -- nothing went wrong, the run went away.
      assert.deepStrictEqual(state.lastFailure, Option.none())
    })

    it("a failed message is a failure, an interrupted one is not", () => {
      const failed = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        numbered([{ _tag: "MessageFailed", failure: failure("generation") }])
      )
      assert.deepStrictEqual(failed.lastFailure, Option.some(failure("generation")))

      const interrupted = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        numbered([{ _tag: "MessageInterrupted" }])
      )
      assert.deepStrictEqual(interrupted.lastFailure, Option.none())
      // Neither commits a message: only `MessageCompleted` does.
      assert.strictEqual(failed.messages, 0)
      assert.strictEqual(interrupted.messages, 0)
    })
  })

  describe("sequence discipline", () => {
    it("ignores a replayed sequence rather than double-counting it", () => {
      const first = envelope(1, turnCompleted)
      const state = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        [first, first, first]
      )

      assert.strictEqual(state.turns, 1)
      assert.strictEqual(state.applied, 1)
      assert.strictEqual(state.duplicates, 2)
      assert.isTrue(SessionProjection.isComplete(state))
    })

    it("ignores an older sequence arriving after a newer one", () => {
      const state = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        [
          envelope(1, turnCompleted),
          envelope(2, turnCompleted),
          envelope(1, turnCompleted)
        ]
      )
      assert.strictEqual(state.turns, 2)
      assert.strictEqual(state.duplicates, 1)
    })

    it("records a gap and still applies the event", () => {
      const state = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        [envelope(1, turnCompleted), envelope(4, turnCompleted)]
      )

      assert.deepStrictEqual(state.gap, Option.some({ after: 1, resumedAt: 4 }))
      assert.strictEqual(state.gaps, 1)
      assert.isFalse(SessionProjection.isComplete(state))
      // Applied anyway: a frozen projection would blank a live view for good.
      assert.strictEqual(state.turns, 2)
      assert.strictEqual(state.applied, 2)
    })

    it("keeps only the earliest gap, because repair from it subsumes the rest", () => {
      const state = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        [
          envelope(1, turnCompleted),
          envelope(4, turnCompleted),
          envelope(9, turnCompleted)
        ]
      )

      assert.strictEqual(state.gaps, 2)
      assert.deepStrictEqual(state.gap, Option.some({ after: 1, resumedAt: 4 }))
    })

    it("`empty` joins a live tail mid-conversation without calling it a gap", () => {
      const state = SessionProjection.reduce(
        SessionProjection.empty(sessionId),
        envelope(97, turnCompleted)
      )
      assert.isTrue(SessionProjection.isComplete(state))
      assert.deepStrictEqual(state.lastSequence, Option.some(97))
    })

    it("`since` does call that a gap, which is the whole difference", () => {
      const state = SessionProjection.reduce(
        SessionProjection.since(sessionId, 0),
        envelope(97, turnCompleted)
      )
      assert.isFalse(SessionProjection.isComplete(state))
      assert.deepStrictEqual(
        state.gap,
        Option.some({ after: 0, resumedAt: 97 })
      )
    })

    it("`since(id, 0)` accepts sequence 1, because EventBus numbers from 1", () => {
      const state = SessionProjection.reduce(
        SessionProjection.since(sessionId, 0),
        envelope(1, turnCompleted)
      )
      assert.isTrue(SessionProjection.isComplete(state))
    })

    it("repairing means re-folding the whole log, and reproduces it exactly", () => {
      const all = numbered(conversation)
      // Sequences 2 and 3 dropped: the stream lost the middle of the opening.
      const lossy = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        all.filter((each) => each.sequence === 1 || each.sequence >= 4)
      )
      assert.isFalse(SessionProjection.isComplete(lossy))
      // The cursor is diagnostic -- where loss began -- not a resume point.
      assert.deepStrictEqual(lossy.gap, Option.some({ after: 1, resumedAt: 4 }))

      const repaired = SessionProjection.reduceAll(
        SessionProjection.since(sessionId, 0),
        all
      )
      const pristine = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        all
      )

      assert.isTrue(SessionProjection.isComplete(repaired))
      // The whole projection, field for field. An earlier version of this
      // compared a hand-picked subset and passed while the repair was wrong:
      // resuming at `gap.after` instead of re-folding silently dropped
      // everything before the cursor, and `started` was false where the whole
      // fold had it true. Naming the fields is what let that through, so the
      // assertion names none of them.
      assert.deepStrictEqual(repaired, pristine)
    })

    it("resuming at the gap cursor is NOT repair, and loses the other side", () => {
      // Pinned because it is the tempting mistake and it looks like it works:
      // every counter after the gap is right, so a spot-check agrees. The
      // reason it cannot work is that gapped events were already applied, so
      // the polluted state cannot be corrected in place -- and a fresh state
      // begun at the cursor has never seen `SessionStarted`.
      const all = numbered(conversation)
      const lossy = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        all.filter((each) => each.sequence === 1 || each.sequence >= 4)
      )
      const cursor = Option.getOrThrow(lossy.gap).after

      const resumed = SessionProjection.reduceAll(
        SessionProjection.since(sessionId, cursor),
        all.filter((each) => each.sequence > cursor)
      )
      const pristine = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        all
      )

      assert.isTrue(SessionProjection.isComplete(resumed))
      assert.isFalse(resumed.started)
      assert.isTrue(pristine.started)
      assert.notDeepEqual(resumed, pristine)
    })

    it("refuses a sequence it cannot order, instead of disabling both guards", () => {
      // `sequence` is `Schema.Number`, so NaN survives a non-JSON decode. Both
      // comparisons are false against it, so before this guard a NaN between
      // sequence 1 and sequence 500 reported `isComplete: true, gaps: 0` while
      // 498 events were missing -- the projection claiming exactness it did
      // not have, which is the one failure it cannot be allowed.
      const state = SessionProjection.reduceAll(
        SessionProjection.since(sessionId, 0),
        [
          envelope(1, turnCompleted),
          envelope(Number.NaN, turnCompleted),
          envelope(500, turnCompleted)
        ]
      )

      assert.strictEqual(state.malformed, 1)
      assert.strictEqual(state.turns, 2)
      // The cursor never took the unorderable value, so the 1 -> 500 jump is
      // still seen for what it is.
      assert.strictEqual(state.gaps, 1)
      assert.deepStrictEqual(state.gap, Option.some({ after: 1, resumedAt: 500 }))
      assert.isFalse(SessionProjection.isComplete(state))
    })

    it("refuses Infinity and fractional sequences too", () => {
      const infinite = SessionProjection.reduce(
        SessionProjection.since(sessionId, 0),
        envelope(Number.POSITIVE_INFINITY, turnCompleted)
      )
      // Infinity as a cursor would make every later event a duplicate for
      // ever, freezing the fold while still reporting it complete.
      assert.strictEqual(infinite.malformed, 1)
      assert.deepStrictEqual(infinite.lastSequence, Option.some(0))

      const fractional = SessionProjection.reduce(
        SessionProjection.since(sessionId, 0),
        envelope(1.5, turnCompleted)
      )
      assert.strictEqual(fractional.malformed, 1)
      assert.strictEqual(fractional.turns, 0)
    })

    it("`since` given an unusable cursor degrades to no expectation, and says so", () => {
      // `Number(searchParams.get("after"))` on an absent parameter is the
      // ordinary way to get here, and it must not poison every comparison.
      const state = SessionProjection.reduceAll(
        SessionProjection.since(sessionId, Number.NaN),
        [envelope(1, turnCompleted), envelope(900, turnCompleted)]
      )

      assert.strictEqual(state.malformed, 1)
      // Not silent: the caller asked for a guarantee this cannot give.
      assert.isFalse(SessionProjection.isComplete(state))
      // But it still detects the discontinuity it *can* see, from the first
      // event it actually got.
      assert.deepStrictEqual(state.gap, Option.some({ after: 1, resumedAt: 900 }))
    })
  })

  describe("tolerance", () => {
    it("an unknown event advances the cursor instead of looking like a gap", () => {
      // The normal case across a relay, not an error: a newer peer emits a tag
      // this build predates. Treating it as a gap would report a
      // discontinuity every time.
      const state = SessionProjection.reduceAll(
        SessionProjection.since(sessionId, 0),
        numbered([
          turnCompleted,
          {
            _tag: "UnknownEvent",
            originalTag: "SomethingNewer",
            payload: { a: 1 }
          },
          turnCompleted
        ])
      )

      assert.isTrue(SessionProjection.isComplete(state))
      assert.strictEqual(state.unknown, 1)
      assert.strictEqual(state.turns, 2)
      assert.strictEqual(state.applied, 3)
    })

    it("an unknown event leaves the cursor on its own sequence", () => {
      // Separate from the case above, and it has to be: there, the trailing
      // known event re-baselines the cursor, so an implementation that
      // *cleared* it on an unknown tag still ends on the right number and
      // still reports complete. The reset is only observable while the
      // unknown event is the most recent one -- which is precisely the state
      // a subscriber sits in between frames, and the state a repair cursor
      // would be read from.
      const state = SessionProjection.reduceAll(
        SessionProjection.since(sessionId, 0),
        numbered([
          turnCompleted,
          {
            _tag: "UnknownEvent",
            originalTag: "SomethingNewer",
            payload: { a: 1 }
          }
        ])
      )

      assert.deepStrictEqual(state.lastSequence, Option.some(2))
      assert.isTrue(SessionProjection.isComplete(state))
    })

    it("counts an envelope for another session instead of folding it in", () => {
      // The §29 host-wide stream routed to the wrong projection. Silently
      // folding it would corrupt the answer with no way to notice.
      const state = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        [envelope(1, turnCompleted), envelope(2, turnCompleted, other)]
      )

      assert.strictEqual(state.foreign, 1)
      assert.strictEqual(state.turns, 1)
      assert.strictEqual(state.applied, 1)
      // A foreign envelope must not move the cursor either, or the next
      // genuine event at that sequence reads as a duplicate.
      assert.deepStrictEqual(state.lastSequence, Option.some(1))
    })
  })

  describe("what is still open", () => {
    it("tracks active tool calls and clears them as they settle", () => {
      const state = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        numbered([
          { _tag: "ToolCallStarted", id: "a", name: "read", params: {} },
          { _tag: "ToolCallStarted", id: "b", name: "write", params: {} },
          {
            _tag: "ToolCallSucceeded",
            id: "a",
            name: "read",
            result: 1,
            encodedResult: 1
          }
        ])
      )

      assert.deepStrictEqual(state.activeToolCalls, [{ id: "b", name: "write" }])
      assert.strictEqual(state.tools.started, 2)
      assert.strictEqual(state.tools.succeeded, 1)
    })

    it("a failed tool call settles, and only a fatal one is the last failure", () => {
      // Each failure has its `ToolCallStarted`, so the removal from
      // `activeToolCalls` is actually exercised. Without them the filter runs
      // on an empty array and a broken one looks identical.
      const state = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        numbered([
          { _tag: "ToolCallStarted", id: "a", name: "read", params: {} },
          { _tag: "ToolCallStarted", id: "b", name: "write", params: {} },
          {
            _tag: "ToolCallFailed",
            id: "a",
            name: "read",
            failure: failure("handed back"),
            returnedToModel: true
          },
          {
            _tag: "ToolCallFailed",
            id: "b",
            name: "write",
            failure: failure("fatal"),
            returnedToModel: false
          }
        ])
      )

      assert.strictEqual(state.tools.failed, 2)
      assert.strictEqual(state.tools.returnedToModel, 1)
      assert.deepStrictEqual(state.activeToolCalls, [])
      assert.deepStrictEqual(state.lastFailure, Option.some(failure("fatal")))
    })

    it("a failure handed back to the model is not why the session stopped", () => {
      // It is the case where the run *recovered*: the error went to the model
      // as a tool result and the submission completed. Recording it as
      // `lastFailure` would answer "why did this stop" with something that
      // stopped nothing.
      const state = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        numbered([
          { _tag: "ToolCallStarted", id: "a", name: "read", params: {} },
          {
            _tag: "ToolCallFailed",
            id: "a",
            name: "read",
            failure: failure("recovered"),
            returnedToModel: true
          },
          { _tag: "SubmissionCompleted", runs: 1 }
        ])
      )

      assert.strictEqual(state.tools.failed, 1)
      assert.strictEqual(state.submissions.completed, 1)
      assert.deepStrictEqual(state.lastFailure, Option.none())
    })

    it("does not open the same tool call or question twice", () => {
      // A replayed id at a *different* sequence passes the sequence duplicate
      // guard, so the dedup inside the case is the only thing between a
      // redelivered frame and a view reporting two tools running when one is.
      //
      // Asserted here, while both are still open. Asserting only the settled
      // end state does not pin it: the settling filter removes *every* entry
      // with the id, so a doubled list empties just the same and a broken
      // dedup is invisible.
      const open = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        numbered([
          { _tag: "ToolCallStarted", id: "a", name: "read", params: {} },
          { _tag: "ToolCallStarted", id: "a", name: "read", params: {} },
          {
            _tag: "ElicitationRequested",
            id: "e1",
            kind: "tool-approval",
            detail: {}
          },
          {
            _tag: "ElicitationRequested",
            id: "e1",
            kind: "tool-approval",
            detail: {}
          }
        ])
      )

      assert.deepStrictEqual(open.activeToolCalls, [{ id: "a", name: "read" }])
      assert.deepStrictEqual(open.pendingElicitations, [
        { id: "e1", kind: "tool-approval" }
      ])
      // The counters still record both arrivals: they are what happened.
      assert.strictEqual(open.tools.started, 2)

      const settled = SessionProjection.reduceAll(open, [
        envelope(5, {
          _tag: "ToolCallSucceeded",
          id: "a",
          name: "read",
          result: 1,
          encodedResult: 1
        }),
        envelope(6, {
          _tag: "ElicitationResolved",
          id: "e1",
          kind: "tool-approval",
          granted: true
        })
      ])

      assert.deepStrictEqual(settled.activeToolCalls, [])
      assert.deepStrictEqual(settled.pendingElicitations, [])
    })

    it("a stray event after a close does not reopen the session", () => {
      // What `isActive`/`isBlocked`'s `closed` guard is actually for. `settle`
      // empties everything at the close, so the guard is unreachable on a
      // well-formed stream -- this is the malformed one a relay or a buggy
      // producer can deliver, and the guard is the only thing holding it.
      const state = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        numbered([
          { _tag: "SessionClosed" },
          { _tag: "SubmissionStarted" },
          {
            _tag: "ElicitationRequested",
            id: "e1",
            kind: "tool-approval",
            detail: {}
          }
        ])
      )

      assert.isTrue(state.closed)
      assert.isFalse(SessionProjection.isActive(state))
      assert.isFalse(SessionProjection.isBlocked(state))
    })

    it("tracks pending elicitations, and reports the session as blocked", () => {
      const asked = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        numbered([
          {
            _tag: "ElicitationRequested",
            id: "e1",
            kind: "tool-approval",
            detail: {}
          }
        ])
      )
      assert.isTrue(SessionProjection.isBlocked(asked))
      assert.deepStrictEqual(asked.pendingElicitations, [
        { id: "e1", kind: "tool-approval" }
      ])

      const answered = SessionProjection.reduce(
        asked,
        envelope(2, {
          _tag: "ElicitationResolved",
          id: "e1",
          kind: "tool-approval",
          granted: true
        })
      )
      assert.isFalse(SessionProjection.isBlocked(answered))
      assert.deepStrictEqual(answered.pendingElicitations, [])
    })

    it("an interrupted submission does not leak its unanswered question", () => {
      // `ElicitationRequested` owes a resolution on the happy path only. An
      // interrupted run never sends one, so without the settle step this entry
      // would live as long as the projection.
      const state = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        numbered([
          { _tag: "SubmissionStarted" },
          { _tag: "ToolCallStarted", id: "a", name: "read", params: {} },
          {
            _tag: "ElicitationRequested",
            id: "e1",
            kind: "tool-approval",
            detail: {}
          },
          { _tag: "SubmissionInterrupted" }
        ])
      )

      assert.deepStrictEqual(state.pendingElicitations, [])
      assert.deepStrictEqual(state.activeToolCalls, [])
      assert.isFalse(SessionProjection.isBlocked(state))
      assert.strictEqual(state.submissions.interrupted, 1)
      // The counter still records that the call was started and never settled.
      assert.strictEqual(state.tools.started, 1)
      assert.strictEqual(state.tools.succeeded, 0)
    })

    it("keeps the most recent failure, from whichever level reported it", () => {
      const state = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        numbered([
          { _tag: "RunFailed", failure: failure("first") },
          { _tag: "SubmissionFailed", failure: failure("second") }
        ])
      )

      assert.deepStrictEqual(state.lastFailure, Option.some(failure("second")))
    })
  })
})
