import { EventSchemas } from "@ag-ui/core"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Stream } from "effect"
import * as AgentEvent from "../src/AgentEvent.js"
import { AgentAgUi } from "../src/ag-ui/index.js"

/**
 * The projection is a pure state machine, so it can be driven with any
 * sequence -- including the ones a real run would produce only under
 * interruption, parallel turns or provider misbehaviour. Each case states an
 * invariant of the AG-UI lifecycle and checks the machine keeps it.
 */

const sessionId = AgentEvent.SessionId.make("s")
const envelope = (
  sequence: number,
  event: AgentEvent.AgentEvent,
  correlation: { readonly run?: string; readonly turn?: number } = {}
): AgentEvent.AgentEventEnvelope => ({
  sessionId,
  submissionId: Option.some(AgentEvent.SubmissionId.make("sub")),
  runId: Option.fromNullishOr(correlation.run).pipe(Option.map(AgentEvent.RunId.make)),
  turn: Option.fromNullishOr(correlation.turn),
  sequence,
  event
})

const options = { threadId: "t", runId: "r" }

const projectAll = (
  events: ReadonlyArray<readonly [AgentEvent.AgentEvent, { readonly run?: string; readonly turn?: number }?]>
) =>
  Stream.runCollect(
    AgentAgUi.project(
      options,
      Stream.fromIterable(events.map(([event, correlation], i) => envelope(i + 1, event, correlation)))
    )
  ).pipe(
    Effect.tap((projected) =>
      Effect.sync(() => {
        for (const event of projected) {
          assert.isTrue(EventSchemas.safeParse(event).success, JSON.stringify(event))
        }
      })
    )
  )

const types = (events: ReadonlyArray<{ readonly type: string }>) => events.map((e) => e.type)

describe("AG-UI projection invariants", () => {
  it.effect("every open frame is closed before a terminal frame, messages before steps", () =>
    Effect.gen(function* () {
      // Two turns open at once (parallel runs on one session) and a message
      // streaming in one of them; the submission then fails.
      const projected = yield* projectAll([
        [{ _tag: "SubmissionStarted" }],
        [{ _tag: "TurnStarted" }, { run: "a", turn: 1 }],
        [{ _tag: "TurnStarted" }, { run: "b", turn: 1 }],
        [{ _tag: "MessageStarted" }, { run: "a", turn: 1 }],
        [{ _tag: "MessageDelta", kind: "text", delta: "par" }, { run: "a", turn: 1 }],
        [{ _tag: "SubmissionFailed", failure: { tag: "X", message: "bad", isDefect: false } }]
      ])
      assert.deepStrictEqual(types(projected), [
        "RUN_STARTED",
        "STEP_STARTED",
        "STEP_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "STEP_FINISHED",
        "STEP_FINISHED",
        "RUN_ERROR"
      ])
      // Steps close in the order they opened.
      const steps = projected.flatMap((e) => (e.type === "STEP_FINISHED" ? [e.stepName] : []))
      assert.deepStrictEqual(steps, ["a:1:turn", "b:1:turn"])
    })
  )

  it.effect("an interrupted message that never opened produces no stray end", () =>
    Effect.gen(function* () {
      const projected = yield* projectAll([
        [{ _tag: "SubmissionStarted" }],
        [{ _tag: "TurnStarted" }, { run: "a", turn: 1 }],
        [{ _tag: "MessageInterrupted" }, { run: "a", turn: 1 }],
        [{ _tag: "SubmissionInterrupted" }]
      ])
      assert.notInclude(types(projected), "TEXT_MESSAGE_END")
      assert.strictEqual(types(projected).at(-1), "RUN_ERROR")
    })
  )

  it.effect("a streamed message is not repeated by its canonical completion, but a batch one is rendered", () =>
    Effect.gen(function* () {
      const projected = yield* projectAll([
        [{ _tag: "SubmissionStarted" }],
        // Turn 1 streams.
        [{ _tag: "TurnStarted" }, { run: "a", turn: 1 }],
        [{ _tag: "MessageStarted" }, { run: "a", turn: 1 }],
        [{ _tag: "MessageDelta", kind: "text", delta: "hi" }, { run: "a", turn: 1 }],
        [{ _tag: "MessageStreamCompleted" }, { run: "a", turn: 1 }],
        [{ _tag: "MessageCompleted", text: "hi" }, { run: "a", turn: 1 }],
        [{ _tag: "TurnCompleted" }, { run: "a", turn: 1 }],
        // Turn 2 does not stream: the canonical completion is all there is.
        [{ _tag: "TurnStarted" }, { run: "a", turn: 2 }],
        [{ _tag: "MessageCompleted", text: "batch" }, { run: "a", turn: 2 }],
        [{ _tag: "TurnCompleted" }, { run: "a", turn: 2 }],
        [{ _tag: "SubmissionCompleted", runs: 1 }]
      ])
      const contents = projected.flatMap((e) =>
        e.type === "TEXT_MESSAGE_CONTENT" ? [e.delta] : []
      )
      assert.deepStrictEqual(contents, ["hi", "batch"])
      assert.strictEqual(types(projected).filter((t) => t === "TEXT_MESSAGE_START").length, 2)
      assert.strictEqual(types(projected).filter((t) => t === "TEXT_MESSAGE_END").length, 2)
    })
  )

  it.effect("a completion arriving while a message is still open closes it with the full text", () =>
    Effect.gen(function* () {
      // Opened, some deltas, then the canonical completion without a stream
      // completion (a provider that ended its stream without saying so).
      const projected = yield* projectAll([
        [{ _tag: "SubmissionStarted" }],
        [{ _tag: "TurnStarted" }, { run: "a", turn: 1 }],
        [{ _tag: "MessageStarted" }, { run: "a", turn: 1 }],
        [{ _tag: "MessageDelta", kind: "text", delta: "he" }, { run: "a", turn: 1 }],
        [{ _tag: "MessageCompleted", text: "hello" }, { run: "a", turn: 1 }],
        [{ _tag: "SubmissionCompleted", runs: 1 }]
      ])
      assert.deepStrictEqual(
        types(projected).filter((t) => t.startsWith("TEXT_MESSAGE")),
        ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"]
      )
    })
  )

  it.effect("reasoning deltas become custom events, never text content", () =>
    Effect.gen(function* () {
      const projected = yield* projectAll([
        [{ _tag: "SubmissionStarted" }],
        [{ _tag: "MessageStarted" }, { run: "a", turn: 1 }],
        [{ _tag: "MessageDelta", kind: "reasoning", delta: "thinking" }, { run: "a", turn: 1 }],
        [{ _tag: "MessageDelta", kind: "text", delta: "answer" }, { run: "a", turn: 1 }],
        [{ _tag: "MessageStreamCompleted" }, { run: "a", turn: 1 }],
        [{ _tag: "SubmissionCompleted", runs: 1 }]
      ])
      const custom = projected.flatMap((e) => (e.type === "CUSTOM" ? [e.name] : []))
      assert.include(custom, "effect-harness/reasoning-delta")
      assert.deepStrictEqual(
        projected.flatMap((e) => (e.type === "TEXT_MESSAGE_CONTENT" ? [e.delta] : [])),
        ["answer"]
      )
    })
  )

  it.effect("nothing follows a terminal frame, whatever arrives", () =>
    Effect.gen(function* () {
      const projected = yield* projectAll([
        [{ _tag: "SubmissionStarted" }],
        [{ _tag: "SubmissionCompleted", runs: 1 }],
        [{ _tag: "SubmissionStarted" }],
        [{ _tag: "TurnStarted" }, { run: "b", turn: 1 }],
        [{ _tag: "MessageCompleted", text: "late" }, { run: "b", turn: 1 }],
        [{ _tag: "SubmissionFailed", failure: { tag: "X", message: "m", isDefect: false } }]
      ])
      assert.deepStrictEqual(types(projected), ["RUN_STARTED", "RUN_FINISHED"])
    })
  )

  it.effect("RUN_STARTED goes out once, and not at all when the server already sent it", () =>
    Effect.gen(function* () {
      const twice = yield* projectAll([
        [{ _tag: "SubmissionStarted" }],
        [{ _tag: "SubmissionStarted" }]
      ])
      assert.deepStrictEqual(types(twice), ["RUN_STARTED"])

      const preStarted = yield* Stream.runCollect(
        AgentAgUi.project(
          { ...options, started: true },
          Stream.fromIterable([envelope(1, { _tag: "SubmissionStarted" })])
        )
      )
      assert.deepStrictEqual(types(preStarted), [])
    })
  )

  it.effect("an elicitation is terminal for the run and carries structured detail as JSON", () =>
    Effect.gen(function* () {
      const projected = yield* projectAll([
        [{ _tag: "SubmissionStarted" }],
        [{ _tag: "TurnStarted" }, { run: "a", turn: 1 }],
        [{ _tag: "ToolCallStarted", id: "c1", name: "wipe", params: {} }, { run: "a", turn: 1 }],
        [
          { _tag: "ElicitationRequested", id: "e1", kind: "tool-approval", detail: { toolName: "wipe" } },
          { run: "a", turn: 1 }
        ],
        // Anything after the pause belongs to the resumed run's request.
        [{ _tag: "ElicitationResolved", id: "e1", kind: "tool-approval", granted: true }, { run: "a", turn: 1 }],
        [{ _tag: "SubmissionCompleted", runs: 1 }]
      ])
      const last = projected[projected.length - 1]!
      assert.strictEqual(last.type, "RUN_FINISHED")
      if (last.type === "RUN_FINISHED") {
        assert.strictEqual(last.outcome?.type, "interrupt")
        if (last.outcome?.type === "interrupt") {
          assert.strictEqual(last.outcome.interrupts[0]?.message, JSON.stringify({ toolName: "wipe" }))
        }
      }
      // The open step was closed before the pause, and nothing leaked after.
      assert.include(types(projected), "STEP_FINISHED")
      assert.strictEqual(types(projected).filter((t) => t === "RUN_FINISHED").length, 1)
    })
  )

  it.effect("an unencodable tool payload fails the projection with the codec error, typed", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        projectAll([
          [{ _tag: "SubmissionStarted" }],
          [{ _tag: "ToolCallStarted", id: "c1", name: "big", params: { n: 1n } }, { run: "a", turn: 1 }]
        ])
      )
      assert.strictEqual(failure._tag, "AgentProtocolCodecError")
    })
  )

  it.effect("tool failures and interruptions still produce a result frame for the call", () =>
    Effect.gen(function* () {
      const projected = yield* projectAll([
        [{ _tag: "SubmissionStarted" }],
        [{ _tag: "ToolCallStarted", id: "c1", name: "t", params: { a: 1 } }, { run: "a", turn: 1 }],
        [
          {
            _tag: "ToolCallFailed",
            id: "c1",
            name: "t",
            failure: { tag: "E", message: "no", isDefect: false },
            returnedToModel: true
          },
          { run: "a", turn: 1 }
        ],
        [{ _tag: "ToolCallStarted", id: "c2", name: "t", params: { a: 2 } }, { run: "a", turn: 1 }],
        [{ _tag: "ToolCallInterrupted", id: "c2", name: "t" }, { run: "a", turn: 1 }],
        [{ _tag: "SubmissionCompleted", runs: 1 }]
      ])
      const results = projected.flatMap((e) => (e.type === "TOOL_CALL_RESULT" ? [e.toolCallId] : []))
      assert.deepStrictEqual(results, ["c1", "c2"])
      const starts = projected.flatMap((e) => (e.type === "TOOL_CALL_START" ? [e.toolCallId] : []))
      assert.deepStrictEqual(starts, ["c1", "c2"])
    })
  )

  it("transition never mutates the state it was given", () => {
    const initial = AgentAgUi.initialState(options)
    const [afterTurn] = AgentAgUi.transition(
      options,
      initial,
      envelope(1, { _tag: "TurnStarted" }, { run: "a", turn: 1 }),
      Option.none()
    )
    const [afterMessage] = AgentAgUi.transition(
      options,
      afterTurn,
      envelope(2, { _tag: "MessageStarted" }, { run: "a", turn: 1 }),
      Option.none()
    )
    assert.strictEqual(initial.openSteps.size, 0)
    assert.strictEqual(afterTurn.openSteps.size, 1)
    assert.strictEqual(afterTurn.openMessages.size, 0)
    assert.strictEqual(afterMessage.openMessages.size, 1)
  })
})
