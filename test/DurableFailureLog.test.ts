import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Logger, References } from "effect"
import * as DurableAgent from "../src/durable/DurableAgent.js"

/**
 * A durable failure is journalled as a projection -- tag, message, whether it
 * was a defect -- and the projection is all that survives it. The cause, and a
 * defect's stack with it, has to be logged before that, or it is not kept
 * anywhere.
 */

interface Line {
  readonly level: string
  readonly message: string
  readonly annotations: Readonly<Record<string, unknown>>
}

const capture = () => {
  const lines: Array<Line> = []
  const logger = Logger.make((options) => {
    lines.push({
      level: options.logLevel,
      message: JSON.stringify(options.message),
      annotations: options.fiber.getRef(References.CurrentLogAnnotations)
    })
  })
  return { lines, layer: Logger.layer([logger]) }
}

const ids = { "agent.session.id": "session-1", "agent.submission.id": "submission-1" }

describe("durable failures are logged before they are projected", () => {
  it.effect("a defect is logged once, with its stack and the submission's ids", () =>
    Effect.gen(function* () {
      const { lines, layer } = capture()
      const failure = yield* DurableAgent.loggedFailure(
        Cause.die(new Error("the tool's wiring broke")),
        ids
      ).pipe(Effect.provide(layer))

      assert.isTrue(failure.isDefect)
      assert.strictEqual(lines.length, 1)
      const [line] = lines
      assert.strictEqual(line?.level, "Error")
      assert.include(line?.message, "the tool's wiring broke")
      // The stack is the part the projection loses.
      assert.match(line?.message ?? "", /at .*DurableFailureLog\.test/)
      assert.deepInclude(line?.annotations, { ...ids, "agent.failure.defect": true })
    })
  )

  it.effect("a typed failure is logged once with its tag", () =>
    Effect.gen(function* () {
      const { lines, layer } = capture()
      const failure = yield* DurableAgent.loggedFailure(
        Cause.fail({ _tag: "RefundRejected", message: "over the limit" }),
        ids
      ).pipe(Effect.provide(layer))

      assert.isFalse(failure.isDefect)
      assert.strictEqual(failure.tag, "RefundRejected")
      assert.strictEqual(lines.length, 1)
      assert.include(lines[0]?.message, "over the limit")
      assert.deepInclude(lines[0]?.annotations, { "agent.failure.tag": "RefundRejected" })
    })
  )

  it.effect("a failure that is already a projection passes through without a second line", () =>
    Effect.gen(function* () {
      const { lines, layer } = capture()
      const projected = new DurableAgent.DurableAgentFailure({ tag: "Boom", detail: "rendered", isDefect: false })
      const failure = yield* DurableAgent.loggedFailure(Cause.fail(projected), ids).pipe(Effect.provide(layer))

      assert.strictEqual(failure, projected)
      assert.strictEqual(lines.length, 0)
    })
  )
})
