import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Stream } from "effect"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import { contract, crossProcessLive, envelope } from "./DeliveryLogContract.js"

/**
 * The delivery log is what a client observes, and the two things it must get
 * right are the two numbers it keeps apart: the key (identity, for replay)
 * and the sequence (the session-wide offset, for reconnection). Both
 * implementations run the same contract.
 */

const tempDatabase = Effect.acquireRelease(
  Effect.sync(() =>
    NodePath.join(
      NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "agent-delivery-")),
      "log.db"
    )
  ),
  (file) =>
    Effect.sync(() => {
      NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
    })
)

const sqlLog = Effect.gen(function* () {
  const file = yield* tempDatabase
  const sql = yield* Layer.build(SqliteClient.layer({ filename: file }))
  return yield* DeliveryLog.sqlLogWithTable().pipe(Effect.provide(sql))
})

contract("memory", DeliveryLog.memoryLog)
contract("sqlite", sqlLog)

// Two SQL logs over one database file, as two processes would be. The poll
// interval is shortened so a cross-process append surfaces quickly.
crossProcessLive(
  "sqlite",
  Effect.gen(function* () {
    const file = yield* tempDatabase
    const one = yield* DeliveryLog.sqlLogWithTable({ pollInterval: Duration.millis(30) }).pipe(
      Effect.provide(yield* Layer.build(SqliteClient.layer({ filename: file })))
    )
    const two = yield* DeliveryLog.sqlLogWithTable({ pollInterval: Duration.millis(30) }).pipe(
      Effect.provide(yield* Layer.build(SqliteClient.layer({ filename: file })))
    )
    return [one, two] as const
  }),
  { settle: "150 millis" }
)

/**
 * R67 -- an interrupted append must not commit without publishing.
 *
 * The commit happens inside `Ref.modify` and the publication after it. An
 * interruption in that gap left `read` holding the event while every existing
 * `live` subscriber never saw it -- and retrying returns `Duplicate` without
 * republishing, so the gap was permanent for the memory log. The SQL log polls
 * and happens to heal it, which is luck rather than design.
 *
 * **This test does not reproduce the window, and passes without the fix.** The
 * gap is between a `Ref.modify` and a `PubSub.publish` with no suspension
 * point either side, so an interrupt issued from outside always lands before
 * the commit rather than inside it -- forty interleavings do not change that.
 * Driving it would need a hook between the two, which would mean adding a seam
 * to production code for a test to hold open.
 *
 * It is kept because the invariant it states is the right one and costs
 * nothing to check, and labelled because an assertion that cannot fail reads
 * as coverage. The fix itself is structural: the span is a `Ref` update and a
 * publish to an unbounded PubSub, so making it uninterruptible gives up no
 * cancellation a caller could observe.
 */
describe("DeliveryLog append atomicity", () => {
  it.live("a commit and its publication cannot be separated by an interrupt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const log = yield* DeliveryLog.memoryLog

        const seen: Array<number> = []
        yield* Effect.forkScoped(
          Stream.runForEach(log.live("s"), (envelope) =>
            Effect.sync(() => {
              seen.push(envelope.sequence)
            }))
        )
        // Let the subscription attach before anything is appended.
        yield* Effect.sleep("50 millis")

        /**
         * Interrupt the appending fibre as hard and as often as the scheduler
         * allows: fork it and interrupt immediately, repeatedly. Whatever the
         * interleaving, the invariant is the same -- the log and the
         * subscriber agree.
         */
        for (let attempt = 0; attempt < 40; attempt++) {
          const fiber = yield* Effect.forkChild(
            log.append("s", `k${attempt}`, envelope(attempt, { _tag: "TurnStarted" }))
          )
          yield* Fiber.interrupt(fiber)
        }
        yield* Effect.sleep("50 millis")

        const stored = (yield* log.read("s")).map((entry) => entry.sequence)
        // Everything the log admits, the subscriber saw. A committed event
        // missing from `seen` is the defect: `read` would show it forever and
        // no live consumer ever would.
        assert.deepStrictEqual(
          stored,
          seen.slice(0, stored.length),
          "an event was committed without reaching a live subscriber"
        )
      })
    ))
})
