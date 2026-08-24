import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Option } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import { Observability } from "../src/observability/index.js"
import { Echo, EchoToolkit, withSession } from "./helpers.js"

/** The span chain from a point, innermost first, with each span's attributes. */
interface CapturedSpan {
  readonly name: string
  readonly attributes: Readonly<Record<string, unknown>>
}

const chainFrom = (span: unknown): ReadonlyArray<CapturedSpan> => {
  const spans: Array<CapturedSpan> = []
  let current: any = span
  while (current !== undefined) {
    spans.push({
      name: current.name,
      attributes: Object.fromEntries(current.attributes ?? new Map())
    })
    current =
      current.parent !== undefined && Option.isSome(current.parent)
        ? current.parent.value
        : undefined
  }
  return spans
}

const spanNamed = (
  spans: ReadonlyArray<CapturedSpan>,
  name: string
): CapturedSpan => {
  const found = spans.find((span) => span.name === name)
  assert.isDefined(found, `expected a span named ${name}`)
  return found!
}

describe("tracing", () => {
  it.effect("engine operations produce named, nested spans", () =>
    Effect.gen(function* () {
      const seen = yield* Deferred.make<ReadonlyArray<string>>()

      // Capture the span chain from inside a tool handler: that is the deepest
      // point of the engine, so its ancestry proves the whole nesting.
      const tracingToolkit = EchoToolkit.pipe(
        Effect.provide(
          EchoToolkit.toLayer({
            echo: ({ value }) =>
              Effect.gen(function* () {
                const span = yield* Effect.currentSpan
                const names: Array<string> = []
                let current: any = span
                while (current !== undefined) {
                  names.push(current.name)
                  current =
                    current.parent !== undefined && Option.isSome(current.parent)
                      ? current.parent.value
                      : undefined
                }
                yield* Deferred.succeed(seen, names)
                return value
              }).pipe(Effect.orDie)
          })
        )
      )

      yield* withSession(
        [
          { toolCalls: [{ id: "t1", name: "echo", params: { value: "x" } }] },
          { text: "done" }
        ],
        Agent.make({ toolkit: tracingToolkit }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      const names = yield* Deferred.await(seen)

      // `Effect.fn` names each engine operation, so a trace reads as the
      // execution structure rather than one opaque span.
      assert.include(names, "ToolExecution.tool")
      assert.include(names, "AgentTurn.execute")
      assert.include(names, "AgentRun.execute")
      assert.include(names, "AgentSubmission.execute")

      // Nesting order: tool inside turn inside run inside submission.
      assert.isBelow(
        names.indexOf("ToolExecution.tool"),
        names.indexOf("AgentTurn.execute")
      )
      assert.isBelow(
        names.indexOf("AgentTurn.execute"),
        names.indexOf("AgentRun.execute")
      )
      assert.isBelow(
        names.indexOf("AgentRun.execute"),
        names.indexOf("AgentSubmission.execute")
      )
    })
  )

  /**
   * The span tree and the event stream describe the same run, and an exporter
   * must be able to join them. That only works if both use one vocabulary --
   * they previously did not: spans said `runId` while `/observability` said
   * `agent.run.id`, so the correlation existed in the system and not in the
   * telemetry.
   *
   * Falsified by annotating any kernel span with a bare key again (or by
   * changing one of `Observability.attributeNames`): the join below fails.
   */
  it.effect("spans and events share one attribute vocabulary", () =>
    Effect.gen(function* () {
      const seen = yield* Deferred.make<ReadonlyArray<CapturedSpan>>()

      const tracingToolkit = EchoToolkit.pipe(
        Effect.provide(
          EchoToolkit.toLayer({
            echo: ({ value }) =>
              Effect.gen(function* () {
                const span = yield* Effect.currentSpan
                yield* Deferred.succeed(seen, chainFrom(span))
                return value
              }).pipe(Effect.orDie)
          })
        )
      )

      const outcome = yield* withSession(
        [
          { toolCalls: [{ id: "t1", name: "echo", params: { value: "x" } }] },
          { text: "done" }
        ],
        Agent.make({ toolkit: tracingToolkit }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      const spans = yield* Deferred.await(seen)
      const names = Observability.attributeNames

      // 1. Every kernel span carries the session, so a trace view can be
      //    filtered by session below the host boundary. Before this, only
      //    `AgentSessionHost.*` spans had it and the filter selected nothing
      //    beneath them.
      for (const name of [
        "ToolExecution.tool",
        "AgentTurn.execute",
        "AgentRun.execute",
        "AgentSubmission.execute",
        "AgentSession.prompt"
      ]) {
        assert.isString(
          spanNamed(spans, name).attributes[names.session],
          `${name} should carry ${names.session}`
        )
      }

      // 2. The ids are written under the standard keys, not ad-hoc ones.
      const turn = spanNamed(spans, "AgentTurn.execute")
      const run = spanNamed(spans, "AgentRun.execute")
      const tool = spanNamed(spans, "ToolExecution.tool")

      assert.isString(run.attributes[names.run])
      assert.isString(run.attributes[names.submission])
      assert.strictEqual(turn.attributes[names.run], run.attributes[names.run])
      assert.strictEqual(turn.attributes[names.turn], 1)
      assert.strictEqual(tool.attributes[names.toolName], "echo")
      assert.strictEqual(tool.attributes[names.toolCallId], "t1")

      // The old bare keys are gone -- leaving both would let a dashboard keep
      // working while the join stayed broken, which is the worst outcome.
      assert.isUndefined(run.attributes["runId"])
      assert.isUndefined(run.attributes["submissionId"])
      assert.isUndefined(turn.attributes["turn"])
      assert.isUndefined(tool.attributes["toolCallId"])

      // `tool` and `parameters` on this span are *not* ours: Effect AI's
      // `Toolkit.handle` annotates the current span (`Toolkit.ts:276`), and the
      // current span there is `ToolExecution.tool`. We cannot remove them, and
      // asserting their absence would fail for a reason we do not control --
      // so pin the fact instead, and it becomes a change detector if upstream
      // moves. Note `parameters` is unredacted; see the note in
      // `Observability.ts` on what that means for the content policy.
      assert.strictEqual(tool.attributes["tool"], "echo")

      // 3. The join itself: an event's record and the span for that same run
      //    agree, by key and by value, with no translation.
      const toolEvent = outcome.events.find(
        (envelope) => envelope.event._tag === "ToolCallStarted"
      )
      assert.isDefined(toolEvent)
      const record = Observability.describe(toolEvent!)

      assert.strictEqual(
        record.attributes[names.run],
        run.attributes[names.run]
      )
      assert.strictEqual(
        record.attributes[names.session],
        run.attributes[names.session]
      )
      assert.strictEqual(
        record.attributes[names.toolCallId],
        tool.attributes[names.toolCallId]
      )
    })
  )
})
