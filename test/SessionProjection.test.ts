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

const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens
})

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
  { _tag: "ModelCallCompleted", usage: usage(10, 5), finishReason: "tool-calls" },
  { _tag: "ToolCallStarted", id: "c1", name: "read", params: {} },
  {
    _tag: "ToolCallSucceeded",
    id: "c1",
    name: "read",
    result: "ok",
    encodedResult: "ok"
  },
  turnCompleted,
  { _tag: "ModelCallCompleted", usage: usage(20, 7), finishReason: "stop" },
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
      assert.deepStrictEqual(state.usage, usage(30, 12))
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

    it("a closed session is never active", () => {
      // The abrupt-drop shape: a submission opened and the stream ended with a
      // close rather than a terminal submission event.
      const state = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        numbered([{ _tag: "SubmissionStarted" }, { _tag: "SessionClosed" }])
      )
      assert.isTrue(state.closed)
      assert.isFalse(SessionProjection.isActive(state))
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
        SessionProjection.gap(state),
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

    it("repairing from the gap cursor reproduces the ungapped fold", () => {
      // The claim §27 makes: `DeliveryLog.read({ after: gap.after })` folded
      // into `since(id, gap.after)` is a whole projection again. Same reducer,
      // no separate repair path -- which is why `reduce` is pure.
      const all = numbered(conversation)
      // Sequences 2 and 3 dropped: the stream lost the middle of the opening.
      const lossy = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        all.filter((each) => each.sequence === 1 || each.sequence >= 4)
      )
      assert.isFalse(SessionProjection.isComplete(lossy))

      const cursor = Option.getOrThrow(SessionProjection.gap(lossy)).after
      const repaired = SessionProjection.reduceAll(
        SessionProjection.since(sessionId, cursor),
        all.filter((each) => each.sequence > cursor)
      )
      const pristine = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        all
      )

      assert.isTrue(SessionProjection.isComplete(repaired))
      // Everything the fold accumulates, not a sampled field or two: a repair
      // that restored the counters but lost the usage would pass a narrower
      // assertion.
      assert.deepStrictEqual(repaired.submissions, pristine.submissions)
      assert.deepStrictEqual(repaired.runs, pristine.runs)
      assert.deepStrictEqual(repaired.usage, pristine.usage)
      assert.strictEqual(repaired.turns, pristine.turns)
      assert.strictEqual(repaired.modelCalls, pristine.modelCalls)
      assert.strictEqual(repaired.messages, pristine.messages)
      assert.deepStrictEqual(repaired.tools, pristine.tools)
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

    it("separates a tool failure returned to the model from one that is not", () => {
      const state = SessionProjection.reduceAll(
        SessionProjection.empty(sessionId),
        numbered([
          {
            _tag: "ToolCallFailed",
            id: "a",
            name: "read",
            failure: failure("boom"),
            returnedToModel: true
          },
          {
            _tag: "ToolCallFailed",
            id: "b",
            name: "write",
            failure: failure("boom"),
            returnedToModel: false
          }
        ])
      )

      assert.strictEqual(state.tools.failed, 2)
      assert.strictEqual(state.tools.returnedToModel, 1)
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
